// Registry of shared Serena servers, one per repository root.
//
// Every Claude Code session used to start its own Serena, and every Serena
// started its own language servers -- 12 process trees, 6.3 GB RSS on the
// operator's Mac on one snapshot (docs/plans/2026-09-24-serena-shared-server.md).
// This registry is what lets several sessions in the same repository agree on
// one already-running server instead of each starting a fresh one: the record
// on disk names the server's pid and port, and the list of client pids
// (relays) currently depending on it. A server lives while at least one
// client pid is alive; the caller (bin/serena-relay.cjs, and the SessionStart
// reaper in repo-setup.cjs) decides when to spawn or kill based on that.
//
// This file only tracks processes and the record; it never spawns Serena
// itself, so it has no opinion on the server command and stays useful to
// anything that wants to share a long-lived process per repo, not only Serena.
'use strict';
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./gates/gate-lib.cjs');

const REGISTRY_DIR = path.join(STATE_DIR, 'serena');

function ensureDir() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

/**
 * The nearest ancestor of `dir` containing either `.serena/project.yml` or
 * `.git` is the repository root -- the same single-pass rule Serena itself
 * uses for `--project-from-cwd` (plan "Decisions", "One server per repository
 * root"). Checking both markers in the SAME loop iteration matters: a
 * directory can have `.git` two levels up and `.serena/project.yml` from
 * yet another ancestor's project config copied in by mistake, and this must
 * stop at whichever marker is found first walking up, not prefer one kind
 * globally over the other.
 *
 * With neither marker anywhere up the tree, the root is `dir` itself, so
 * ungated repositories still get one shared server (plan: "so /mcp shows
 * serena the same way everywhere").
 *
 * The walk itself runs on the path as given, but the winning root is resolved
 * through `fs.realpathSync` before hashing: macOS routes `/tmp` through
 * `/private/tmp`, so a caller that passes `/tmp/x` and another that passes
 * the realpath-equivalent `/private/tmp/x` for the SAME repository must land
 * on the same key, or two sessions in one repo end up with two servers. On
 * win32, paths are additionally case-insensitive at the filesystem level
 * while `sha1` hashing is not, so the resolved root is lower-cased there too
 * before hashing (case is not folded on POSIX, where the filesystem itself
 * is usually case-sensitive and folding it would collide distinct repos).
 */
function repoKey(dir) {
  let cur = path.resolve(dir);
  let found = cur;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.serena', 'project.yml')) || fs.existsSync(path.join(cur, '.git'))) {
      found = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) { found = path.resolve(dir); break; }
    cur = parent;
  }
  // realpathSync requires the path to exist, which every marker-bearing
  // directory and every `dir` this is called with does; fall back to the
  // unresolved path only if the directory has since disappeared under us.
  let root;
  try { root = fs.realpathSync(found); } catch { root = found; }
  const hashInput = process.platform === 'win32' ? root.toLowerCase() : root;
  const key = crypto.createHash('sha1').update(hashInput).digest('hex');
  return { root, key };
}

function recordPath(key) {
  return path.join(REGISTRY_DIR, `${key}.json`);
}

function locksDir(key) {
  return path.join(REGISTRY_DIR, `${key}.locks`);
}

/**
 * Runs `fn` with an exclusive lock on `key` held, so two sessions racing to
 * start a server for the same repository serialise instead of both spawning
 * one.
 *
 * The lock is a directory of never-reused generation files: 0, 1, 2, ... A
 * caller that dies holding generation N (killed, crashed, laptop asleep)
 * leaves it abandoned, so an abandoned generation must be stealable -- but a
 * single `<key>.lock` file cannot support that safely. Stealing it is
 * necessarily "read the pid it names, decide it's dead, then unlink the
 * path" -- three steps with no filesystem primitive to do them atomically,
 * and no way to unlink only if the path still refers to the SAME inode it
 * was when read. Between the read and the unlink, the true holder can finish
 * and a different racer can win the path and create its own fresh lock
 * there; the original stealer's unlink then deletes that racer's fresh lock
 * out from under it, and both the stealer and that racer end up inside `fn`
 * at once. No amount of extra checking on the same path closes that window,
 * because it is a name being reused, not a value being misread.
 *
 * A generation file's name is never reused, so a decision about generation N
 * can never later be applied to a different file: once N exists, "N" always
 * refers to the same acquisition. Taking the lock is `fs.linkSync` of a
 * fully-written temp file to the name N+1 -- exclusive (EEXIST if another
 * racer's link already landed there) and atomic (a hard link either exists
 * fully or not at all; a generation file is never observed empty or
 * half-written the way a plain `wx` write can be caught mid-flight by a
 * concurrent reader). Generation N is free exactly when `N.done` exists (its
 * holder released it) or the pid it names is no longer alive -- both
 * conditions are monotone: once true, they stay true, so two racers can
 * agree "N is free" without racing each other over that answer. Only the
 * NEXT generation (N+1) is ever contested, and `linkSync` decides that
 * contest atomically. There is deliberately no age-based steal fallback:
 * with every generation file created via `linkSync` from a fully-written
 * temp file, there is no empty or half-written lock file for an age check to
 * exist for.
 *
 * Generation files are never reused, so left alone the `<key>.locks/`
 * directory grows by two files (`N` and `N.done`) on every acquisition,
 * forever. The holder of `mine` therefore prunes on release: every
 * generation below `mine - 1` is deleted, leaving `mine - 1` and `mine`.
 * The maximum generation -- the frontier every racer reads -- is never
 * deleted, by pruning or by anything else, so the frontier never moves back.
 *
 * Pruning does hand names below the frontier back to `linkSync`, and a racer
 * can be descheduled for any length of time between reading
 * `n = maxGeneration(dir)` and its `linkSync(tmp, n + 1)` (OS scheduling, a
 * slow disk, a laptop asleep). Say it reads -1 and stalls; others take 0, 1
 * and 2, 2's release prunes 0, and 3 is now held. The stalled racer's link of
 * `0` succeeds -- on a retired name, while 3's holder is inside fn. So after
 * every successful link, withLock re-reads the directory before calling fn.
 * If any generation above `next` exists, the acquisition is stale: it
 * unlinks its own `next`, writes no `next.done` (a `.done` for a name that a
 * concurrent prune may be deleting is exactly how an orphan `.done` appears),
 * and starts over from the fresh frontier.
 *
 * A legitimate acquisition of `next` never sees a higher generation there.
 * Any generation above `next` requires `next + 1` to have been linked first
 * (every link lands one above a generation that existed when it was read),
 * and linking `next + 1` requires having found `next` free: `next.done`
 * present or `next`'s pid dead. Only `next`'s holder writes `next.done`, and
 * it has not yet; its pid is alive, since it is the one checking. The name
 * `next` cannot have been read earlier under a different holder either: a
 * legitimate `next` is one above the frontier, and the frontier never moves
 * back, so that name has never existed before. Conversely, a stale
 * acquisition always does see one: a name below the frontier becomes
 * linkable again only by being pruned (or unlinked by an earlier stale
 * acquirer of it), and both happen only while a higher generation exists.
 * That generation never goes away.
 *
 * A generation file that vanishes between `readdir` and the read of its pid
 * is not free. It was pruned (so the frontier is elsewhere), or it was a
 * stale acquisition removing itself. generationFree answers "not free" so
 * the caller re-reads, and never links `n + 1` on the strength of a file it
 * could not read.
 *
 * Deletion order inside a pruned pair matters: `N.done` is removed BEFORE
 * `N`. If this process is killed between the two, the surviving state is
 * `N` present without `N.done` -- indistinguishable from an abandoned,
 * never-released generation, which `generationFree` already treats
 * correctly by falling back to the liveness of the pid it names (which will be
 * long gone). The reverse order would risk the opposite crash window: `N`
 * gone but `N.done` still present, which makes a DIFFERENT, later holder of
 * generation N (impossible by construction, since N is never reused) look
 * falsely released -- but more importantly, an orphaned `.done` with no
 * matching numbered file is the shape `generationFree` cannot safely
 * interpret at all, so that shape must never be produced.
 */
const POLL_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

function maxGeneration(dir) {
  let n = -1;
  for (const name of fs.readdirSync(dir)) {
    if (/^\d+$/.test(name)) n = Math.max(n, Number(name));
  }
  return n;
}

function generationFree(dir, n) {
  if (n < 0) return true;
  if (fs.existsSync(path.join(dir, `${n}.done`))) return true;
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, String(n)), 'utf8');
  } catch (e) {
    // Gone between readdir and this read: pruned or a stale acquisition
    // removing itself, so `n` is no longer the frontier. "Not free" makes the
    // caller re-read rather than link `n + 1` (see "A generation file that
    // vanishes" above).
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const pid = parseInt(raw, 10);
  // Every waiter runs this on every poll, so it must not spawn anything:
  // isAlive's zombie check runs `ps`. See isAlivePlain for why kill(pid, 0)
  // alone is the right test for a lock holder.
  return !isAlivePlain(pid);
}

// Removes every generation pair strictly below `mine - 1`. Only ever called
// by the current holder of `mine`, so the safety argument above applies.
//
// Also removes `tmp.<pid>.<hex>` files whose pid is dead: an acquirer killed
// between writing its temp file and its `finally` leaves one behind, and
// nothing else would ever delete it. A live pid's temp file is kept, because
// that acquirer is about to link it, and deleting it would fail its
// `linkSync` with ENOENT. A dead pid reused by a live process only delays
// the removal; the file is inert.
function pruneOldGenerations(dir, mine) {
  const keep = mine - 1;
  for (const name of fs.readdirSync(dir)) {
    const tmp = /^tmp\.(\d+)\.[0-9a-f]+$/.exec(name);
    if (tmp) {
      if (!isAlivePlain(Number(tmp[1]))) {
        try { fs.rmSync(path.join(dir, name)); } catch { /* already gone */ }
      }
      continue;
    }
    const m = /^(\d+)$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= keep) continue;
    try { fs.rmSync(path.join(dir, `${n}.done`)); } catch { /* already gone, or never released */ }
    try { fs.rmSync(path.join(dir, name)); } catch { /* already gone */ }
  }
}

/**
 * Releases generation `mine` by creating `mine.done`, then prunes. Returns
 * whether the generation is released. Never throws: withLock calls this
 * after fn's outcome is captured, and a release failure must not replace
 * fn's result or fn's own error.
 *
 * If writing `mine.done` fails, the same name is created as a hard link to
 * the numbered file instead. `linkSync` opens no file descriptor and
 * allocates no inode, so it still works under EMFILE or inode exhaustion,
 * the failures a create-and-write can hit while the directory itself is
 * fine. generationFree only asks whether `mine.done` exists, so the link
 * releases exactly as the written file would, and pruning deletes it like
 * any other `.done`. EEXIST means the failed write had already created it.
 *
 * Release never deletes the numbered file `mine` to make it look free. `mine`
 * is the frontier: deleting it moves the frontier back and lets the next
 * racer link the name `mine` again, breaking the never-reused-name invariant
 * the lock's exclusivity rests on (see the lock design comment above POLL_MS).
 *
 * If both fail, the directory is refusing new entries (EACCES, EROFS, ENOSPC
 * on the directory itself), and no mechanism can mark the generation free
 * until it accepts them again; other processes cannot acquire meanwhile
 * either, since acquiring needs a new entry too. The failure is logged and
 * withLock remembers the generation, settling it first on this process's
 * next withLock for the key (settleGeneration, which only ever links). If
 * the process exits instead, its pid dies and generationFree treats the
 * generation as free.
 */
function releaseGeneration(dir, mine) {
  const numbered = path.join(dir, String(mine));
  const donePath = path.join(dir, `${mine}.done`);
  try {
    fs.writeFileSync(donePath, '');
  } catch (writeErr) {
    try {
      fs.linkSync(numbered, donePath);
    } catch (linkErr) {
      if (linkErr.code !== 'EEXIST') {
        // Logged, not thrown: this runs in withLock's `finally`, protecting
        // fn's own outcome, and must not replace it.
        console.error(`withLock: could not release generation ${mine} in ${dir}: `
          + `writing .done failed (${writeErr.message}), linking it failed (${linkErr.message}); `
          + 'this process will retry on its next withLock for this key');
        return false;
      }
    }
  }
  try { pruneOldGenerations(dir, mine); } catch { /* best-effort; the next holder's prune covers it */ }
  return true;
}

/**
 * Settles generation `g`, which this process linked but left without a
 * `.done`: either its release failed (releaseGeneration), or the post-link
 * frontier check failed, so withLock never learned whether `g` was the
 * frontier. Returns whether `g` is settled; false means retry on this
 * process's next withLock for the key. Never throws.
 *
 * The frontier check comes first. If a generation above `g` exists, `g` was
 * a stale link below the frontier (a legitimately held `g` whose holder is
 * alive and has not released it can never be passed), so it is removed with
 * no `.done`, exactly as withLock's own stale path does.
 *
 * Otherwise `g.done` is created by `linkSync` from `g` only, never written.
 * A link needs `g` to exist, so if `g` is gone -- the lock dir wiped under
 * this process -- nothing is created (ENOENT), and `g` needs no release. A
 * written `g.done` in that case would be an orphan, and once the frontier
 * came back up to `g`, that `g`'s live holder would look free to every
 * waiter, letting a second holder in.
 *
 * Before either action, `g` is read, and nothing is done unless it names
 * this process. A wiped lock dir can grow back to exactly `g` under a
 * different, live holder; linking `g.done` would then release that holder's
 * generation and let this process into fn beside it, and removing `g` would
 * move the frontier back under it. The pid alone identifies this process's
 * own link, because this process always settles `g` before it acquires the
 * key again (withLock does so first thing), so no other file of this process
 * can be at `g` while it is unsettled. A `g` naming anyone else is not this
 * process's to settle, and counts as settled: this process's own `g` is gone.
 */
function settleGeneration(dir, g) {
  const numbered = path.join(dir, String(g));
  try {
    if (fs.readFileSync(numbered, 'utf8') !== String(process.pid)) return true;
    if (maxGeneration(dir) > g) {
      try { fs.rmSync(numbered); } catch { /* already pruned */ }
      return true;
    }
    fs.linkSync(numbered, path.join(dir, `${g}.done`));
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code !== 'EEXIST') {
      console.error(`withLock: could not settle generation ${g} in ${dir} (${e.message}); `
        + 'this process will retry on its next withLock for this key');
      return false;
    }
  }
  try { pruneOldGenerations(dir, g); } catch { /* best-effort; the next holder's prune covers it */ }
  return true;
}

// withLock's fn contract, shared by the acquiring and the reentrant path.
// Releasing and returning a promise would let the caller believe the lock
// covers fn's real work, when in fact the lock is released the instant the
// synchronous frame returns -- fn's actual (async) work then runs UNLOCKED,
// defeating the whole point of taking it. Fail loudly instead of silently
// under-protecting a caller that assumed synchronous semantics.
function assertSynchronous(result) {
  if (result && typeof result.then === 'function') {
    throw new TypeError("withLock's fn must be synchronous; it returned a thenable");
  }
  return result;
}

// Locks held by THIS process, by key, so a nested withLock call for a key
// this same process already holds does not deadlock against itself.
// addClient/removeClient each take the lock internally, so any future caller
// that wraps one of them in its own withLock(key, ...) for the same key must
// not block forever waiting on a generation it is itself sitting inside.
// Reentrant for the SAME process only: a different process (or a genuinely
// different pid, e.g. a forked child) is never treated as already holding
// it, so cross-process exclusivity is unaffected.
const heldByThisProcess = new Map();

// Generations this process linked but left without a `.done` -- a release
// that failed (releaseGeneration), or a post-link frontier check that failed
// -- by key. withLock settles it (settleGeneration) before its next
// acquisition on that key, so the key recovers once the directory accepts
// entries again instead of staying held for the rest of the process's life.
const unreleased = new Map();

/**
 * Runs `fn` with an exclusive lock on `key` held. `fn` must be synchronous:
 * if it returns a thenable, withLock throws (after releasing the lock),
 * because the lock is released when fn returns, and a promise's real work
 * would then run unlocked.
 * Callers that need to do async work while "holding" the lock (BRIEF 2:
 * spawning and recording a server) must do that work as a synchronous
 * sequence of steps inside fn, spawning detached and returning before
 * anything truly asynchronous starts.
 *
 * Reentrant for the same key within the SAME process: a nested
 * `withLock(key, ...)` call for a key this process already holds runs `fn`
 * directly without re-acquiring, so addClient/removeClient (which each take
 * the lock themselves) can safely be called from inside another withLock on
 * the same key. It is NOT reentrant across different pids -- a lock held by
 * another process is waited on exactly as before.
 *
 * Waiting is bounded: if the lock is not acquired within `timeoutMs`
 * (default 30s), withLock throws rather than spinning forever. A hung live
 * holder, or a dead holder's pid reused by an unrelated live process, would
 * otherwise make every waiter -- and the process using them -- hang
 * indefinitely. The bound covers the immediate retries too (a lost link
 * race, a stale link), not only the polls on a live holder.
 *
 * If the directory cannot be read right after linking, withLock throws that
 * error without running fn, and settles the linked generation (see
 * settleGeneration) so it does not stay held.
 *
 * fn's outcome is never replaced by a release failure: its result is
 * returned, or its own error rethrown (see releaseGeneration).
 */
function withLock(key, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, _stallBeforeLinkForTest } = {}) {
  if (heldByThisProcess.has(key)) {
    // The outer call holds the generation and releases it, so there is
    // nothing to release here -- but async work in fn would still run after
    // the outer call has released, so the contract is the same.
    return assertSynchronous(fn());
  }
  ensureDir();
  const dir = locksDir(key);
  fs.mkdirSync(dir, { recursive: true });
  if (unreleased.has(key) && settleGeneration(dir, unreleased.get(key))) unreleased.delete(key);
  let mine = -1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = maxGeneration(dir);
    const free = generationFree(dir, n);
    if (free) {
      const next = n + 1;
      const tmp = path.join(dir, `tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
      let acquired = false;
      // The write is inside the `finally` too: a write that fails partway
      // (ENOSPC) can leave the file behind, and pruning keeps a live pid's
      // tmp file, so nothing else would remove it while this process lives.
      try {
        fs.writeFileSync(tmp, String(process.pid));
        // Test-only: lets a test reproduce a racer descheduled between
        // reading the frontier and linking `next`, by running other
        // acquisitions at exactly this point. Never set outside a test.
        if (typeof _stallBeforeLinkForTest === 'function') _stallBeforeLinkForTest(next);
        try {
          fs.linkSync(tmp, path.join(dir, String(next)));
          acquired = true;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          // Another racer's link landed on `next` first; retry from the top --
          // it may now be the live holder we must wait on, or (if it died
          // instantly) already free again.
        }
      } finally {
        try { fs.rmSync(tmp); } catch { /* never created, or already gone */ }
      }
      if (acquired) {
        // A generation above `next` means this link landed on a retired
        // name, not the frontier: never enter fn on it. Remove the link and
        // write no `.done` for it (see "Pruning does hand names below the
        // frontier back" above POLL_MS for why a legitimate `next` never
        // gets here). A concurrent prune may already have removed it.
        let stale;
        try {
          stale = maxGeneration(dir) > next;
        } catch (checkErr) {
          // The directory could not be read (EMFILE, say), so it is unknown
          // whether `next` is the frontier. fn must not run, and `next`
          // must not stay linked with nothing left to release it: if it IS
          // the frontier, every waiter would wait on this live pid until
          // the process exits. settleGeneration re-runs this check and
          // releases or removes `next` accordingly; if it cannot read the
          // directory either, the next withLock for this key retries.
          if (!settleGeneration(dir, next)) unreleased.set(key, next);
          throw checkErr;
        }
        if (!stale) {
          mine = next;
          break;
        }
        try { fs.rmSync(path.join(dir, String(next))); } catch { /* already pruned */ }
      }
      // Lost the link race, or linked a stale name: retry at once, without
      // waiting, but still inside the deadline -- a directory that keeps
      // producing either outcome must end in a timeout, not a spin.
    }
    if (Date.now() >= deadline) {
      throw new Error(`withLock('${key}') timed out after ${timeoutMs}ms without acquiring the lock`);
    }
    if (!free) waitMs(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  heldByThisProcess.set(key, mine);
  let result, threw, thrown;
  try {
    result = assertSynchronous(fn());
    threw = false;
  } catch (e) {
    threw = true;
    thrown = e;
  } finally {
    heldByThisProcess.delete(key);
    // fn's outcome (its return value, or the error it threw, captured above)
    // is final: releaseGeneration never throws, so nothing here replaces it.
    if (!releaseGeneration(dir, mine)) unreleased.set(key, mine);
  }
  if (threw) throw thrown;
  return result;
}

// Blocks the thread for `ms` without spinning the CPU or starting a process.
// Node permits Atomics.wait on the main thread; nothing ever notifies this
// buffer, so each call just sleeps until its timeout. withLock's polling is
// cheap only as long as nothing spawns per poll either -- which is why
// generationFree checks a holder with kill(pid, 0) and not isAlive's `ps`.
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function waitMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(waitBuffer, 0, 0, ms);
}

function read(key) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(key), 'utf8'));
  } catch {
    return null;
  }
}

function write(key, rec) {
  ensureDir();
  // A reader (read(), or another process's read()) can observe this file at
  // any instant, including mid-write. Writing straight to recordPath would
  // let a reader see a truncated, half-flushed JSON.parse failure during the
  // window between truncation and the last byte landing. Writing to a
  // same-directory temp file first and then renaming it over the real path
  // avoids that window: POSIX and Windows (Node >= 10, via MoveFileEx) both
  // make `rename` atomic when source and destination are on the same
  // filesystem, so a reader always sees either the old file complete or the
  // new file complete, never a mix.
  const tmp = path.join(REGISTRY_DIR, `.tmp.${key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, recordPath(key));
  } catch (e) {
    // The name is unique to this call, so nothing else will ever remove it.
    try { fs.rmSync(tmp); } catch { /* never created, or already gone */ }
    throw e;
  }
}

function addClient(key, pid) {
  withLock(key, () => {
    const rec = read(key);
    if (!rec) return;
    if (!rec.clients.includes(pid)) rec.clients.push(pid);
    write(key, rec);
  });
}

/**
 * Removes `pid` from the record's client list and returns how many clients
 * are still alive afterward -- the caller (the relay, on stdin end/SIGINT/
 * SIGTERM) uses that count to decide whether it was the last one and must
 * kill the server's tree.
 */
function removeClient(key, pid) {
  return withLock(key, () => {
    const rec = read(key);
    if (!rec) return 0;
    rec.clients = rec.clients.filter((p) => p !== pid);
    write(key, rec);
    return liveClients(rec).length;
  });
}

function liveClients(rec) {
  if (!rec) return [];
  return rec.clients.filter(isAlive);
}

/**
 * `kill(pid, 0)` sends no signal; it only asks the OS whether the pid could
 * be signalled at all, which is true exactly when the process exists (and is
 * ours or we have permission), and throws ESRCH otherwise. This works
 * identically on POSIX and Windows in Node's implementation.
 *
 * It also answers true for a ZOMBIE -- a POSIX child that has already exited
 * but that nobody has `waitpid`ed yet, which keeps its pid slot allocated.
 * killTree's own grace-period wait creates exactly this case: it blocks the
 * event loop synchronously, so libuv never runs the SIGCHLD handler that
 * would reap a child killed moments earlier, and `kill(pid, 0)` on that
 * zombie's pid would otherwise report it alive for the rest of the grace
 * period. A zombie holds no memory and runs nothing -- it is not the process
 * sprawl this registry exists to track -- so it is treated as dead here by
 * checking `ps`'s state column, which reads the kernel table directly rather
 * than through this process's own child-reaping state. Windows has no zombie
 * process concept, so this check is POSIX-only.
 */
function isZombie(pid) {
  if (process.platform === 'win32') return false;
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && /^Z/.test((r.stdout || '').trim());
}

function isAlive(pid) {
  return isAlivePlain(pid) && !isZombie(pid);
}

/**
 * `kill(pid, 0)` alone, with no zombie check and no subprocess. Used for lock
 * holders (generationFree), which are polled far too often to afford a `ps`
 * each time. A holder is a session's own process, not ours: its parent
 * reaps it when it exits, so it does not linger as a zombie the way
 * killTree's just-killed children of THIS process do. Were one to linger,
 * waiters would wait out their timeout -- a stall, never two holders.
 */
function isAlivePlain(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

/**
 * Every pid whose ppid is `pid`, direct children only. Collecting the whole
 * tree is a repeated pass over this rather than the OS doing it, because
 * `ps`'s output format differs enough across platforms that parsing it once
 * per call and recursing here is the more portable primitive.
 */
function childPids(ppid, table) {
  return table.filter((row) => row.ppid === ppid).map((row) => row.pid);
}

// POSIX only: on win32, killTree hands the whole tree walk to `taskkill /T`
// (see killTree) and never calls this, so there is no wmic (or any other
// Windows process-table) branch to maintain here.
function processTable() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const out = r.stdout || '';
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10) });
  }
  return rows;
}

/**
 * Kills `rootPid` and its whole descendant tree, including a grandchild
 * started in its own session (`detached: true`) the way Serena starts each
 * language server (plan "Context": PDEATHSIG is Linux-only, so on macOS an
 * LSP outlives its Python parent unless killed explicitly). A process-GROUP
 * kill (`process.kill(-pid)`) does not reach such a grandchild, because
 * `detached: true` gives it its own session and group; only walking ppid,
 * collected BEFORE anything is signalled, finds it. Collecting first matters
 * because a killed process's children get re-parented (to pid 1 on POSIX)
 * before a later `ps` snapshot would show them, which would otherwise orphan
 * exactly the processes this function exists to reach.
 *
 * Sends SIGTERM to the root first and waits a grace period, so Serena's own
 * Python process gets a chance to shut its LSPs down cleanly; whatever is
 * still alive after the grace period is force-killed directly, tree member
 * by tree member, not via another group signal.
 */
const GRACE_MS = 3000;

function collectTree(rootPid) {
  const table = processTable();
  const all = [rootPid];
  let frontier = [rootPid];
  while (frontier.length) {
    const next = frontier.flatMap((p) => childPids(p, table));
    for (const p of next) if (!all.includes(p)) all.push(p);
    frontier = next;
  }
  return all;
}

function killTree(rootPid) {
  // Reject process-group selectors and init before inspecting any processes.
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
    throw new RangeError('killTree requires an integer PID greater than 1');
  }

  if (process.platform === 'win32') {
    // taskkill's own /T already walks the tree by ppid the same way; no
    // separate grace period, per-pid pass, or POSIX-style ppid collection
    // (processTable/collectTree) is needed or wired up here.
    spawnSync('taskkill', ['/PID', String(rootPid), '/T', '/F']);
    return;
  }

  const tree = collectTree(rootPid);
  if (isAlive(rootPid)) {
    try { process.kill(rootPid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && tree.some(isAlive)) {
    waitMs(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  for (const pid of tree) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited between the check and the signal */ }
    }
  }
}

/**
 * A string identifying WHICH process is running at `pid` right now, beyond
 * the pid number alone. Pids get reused -- after a reboot, or just from
 * normal OS churn over a long-running Mac -- so a registry record's `pid`
 * field can end up naming a completely unrelated process by the time
 * anything acts on it again. `killRecordServer` calls this at kill-time and
 * refuses unless it matches what was captured when the record was written
 * (bin/serena-relay.cjs, BRIEF 2, is expected to call this at spawn and
 * store the result on the record as `identity`).
 *
 * Combines the process's start time (`lstart`, an absolute timestamp -- NOT
 * elapsed time, which would drift between the two calls) with its full
 * command line: either alone can coincide by chance (two different `python`
 * invocations started in the same second; a long-lived pid whose command
 * line was reused by a restarted service), but the pair naming the same
 * pid at two different times is as close to "the same OS-level process" as
 * this registry can check without a kernel-level process token. Returns ''
 * for a pid that is not currently running (there is nothing to identify).
 *
 * `ps` prints lstart in the local timezone and in the locale's date format,
 * and the capture (the relay, at spawn) and the comparison (the reaper, at
 * kill time) run in different processes that may inherit different TZ and
 * LC_ALL. Both are pinned so the two agree; otherwise the reaper refuses
 * every record and the server it was meant to reap leaks.
 *
 * `pid` is validated here (a safe integer > 1, else RangeError) and not only
 * by killRecordServer, because this function is exported: on win32 the pid
 * is interpolated into a PowerShell `-Filter`, where a string pid is a query
 * injection.
 */
function captureIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new RangeError('captureIdentity requires an integer PID greater than 1');
  }
  if (process.platform === 'win32') {
    // CreationDate + CommandLine is wmic's equivalent pairing, but wmic is
    // deprecated and this machine cannot exercise the win32 branch at all
    // (house rules); PowerShell's Get-CimInstance is the documented
    // replacement and avoids adding wmic back in for a single call site.
    // CreationDate is a DateTime, which default formatting renders in the
    // session's culture and local time -- the same disagreement between relay
    // and reaper that pinning LC_ALL/TZ prevents for `ps` below. The
    // round-trip format 'o' of its UTC value is culture-invariant.
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; `
      + "if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + ' ' + $p.CommandLine }"],
    { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  }
  const r = spawnSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * killTree's identity-checked counterpart for a registry record: refuses to
 * kill `rec.pid`'s tree unless the process currently AT that pid still
 * matches `rec.identity` (captured via captureIdentity when the record was
 * written). Without this check, the SessionStart reaper (BRIEF 3) sweeping
 * a record with zero live clients would, after a reboot recycled that pid
 * onto some unrelated process, kill whatever now happens to hold that pid
 * number -- silently, since pid reuse gives no error to catch.
 *
 * A record with no `identity` captured (records written before this field
 * existed, or a caller that never captured one) is refused rather than
 * treated as a free pass: the whole point of this function is to require
 * positive confirmation before killing, and "no identity on file" is not
 * that.
 *
 * `rec.pid` comes from a file on disk, so it is validated before anything
 * looks it up: on win32 captureIdentity interpolates it into a PowerShell
 * `-Filter`, where a string pid is a query injection, and a pid ≤ 1 names
 * init or a process group rather than one server.
 *
 * A refusal carries a `code` saying what it proves, because a caller that
 * cleans up records (the SessionStart reaper) must not treat them alike:
 * - `IDENTITY_NOT_RECORDED`: the record has none. Nothing is known about the
 *   process at the pid; it may well be the recorded server.
 * - `IDENTITY_UNREADABLE`: the live identity came back empty. `ps` failed to
 *   start or failed, or the process exited in between. Nothing is proved.
 * - `IDENTITY_MISMATCH`: a process is running at the pid, but its identity
 *   (captured at spawn time) no longer matches the record. This is likely
 *   pid reuse, but not certain proof of it: an identity captured at spawn
 *   can predate an exec, so a process that execs into something else after
 *   being recorded would also mismatch without the pid having been reused.
 * An invalid pid is a RangeError, as above.
 */
function killRecordServer(rec) {
  if (!rec || typeof rec.identity !== 'string' || !rec.identity) {
    throw refusal('IDENTITY_NOT_RECORDED', 'killRecordServer requires a record with a captured identity');
  }
  if (!Number.isSafeInteger(rec.pid) || rec.pid <= 1) {
    throw new RangeError('killRecordServer requires a record whose pid is an integer greater than 1');
  }
  const live = captureIdentity(rec.pid);
  if (!live) {
    throw refusal('IDENTITY_UNREADABLE', `killRecordServer refused: pid ${rec.pid}'s live identity could not be read (the lookup failed, or the process exited)`);
  }
  if (live !== rec.identity) {
    throw refusal('IDENTITY_MISMATCH', `killRecordServer refused: pid ${rec.pid}'s live identity does not match the record (likely pid reuse)`);
  }
  killTree(rec.pid);
}

/**
 * Deletes `key`'s record, `<key>.json`, and nothing else. A missing record is
 * not an error.
 *
 * The caller must hold `key`'s lock (be inside `withLock(key, ...)`), and
 * this throws otherwise. Deleting is always a decision about the record's
 * contents -- no live clients, a server that is gone -- and that decision is
 * only sound on a record read under the same lock: a relay's addClient
 * between an unlocked read and the delete would be lost with the record, and
 * its server left running with nothing tracking it. Taking the lock here
 * instead would not help, because the read that justifies the delete would
 * still be outside it.
 *
 * `<key>.locks/` is never touched. It is what makes the lock exclusive, and
 * wiping it could let two holders in at once (see withLock).
 */
function deleteRecord(key) {
  if (!heldByThisProcess.has(key)) {
    throw new Error(`deleteRecord('${key}') must be called inside withLock('${key}', ...), on a record read there`);
  }
  fs.rmSync(recordPath(key), { force: true });
}

function listRecords() {
  ensureDir();
  const out = {};
  for (const name of fs.readdirSync(REGISTRY_DIR)) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    const rec = read(key);
    if (rec) out[key] = rec;
  }
  return out;
}

module.exports = {
  repoKey, withLock, read, write, deleteRecord, addClient, removeClient, liveClients, isAlive,
  killTree, captureIdentity, killRecordServer, listRecords,
};
