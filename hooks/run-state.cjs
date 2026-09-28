#!/usr/bin/env node
// Durable run state for an orchestrated brief run — one file per run, keyed by repo.
//
// Runs live at ~/.claude/state/ship-runs/<repo-key>/<feature>.json, and the pointer
// saying which run THIS chat is driving lives at ~/.claude/state/ship-current/<session>.
// That split is the whole point: the run must survive compaction, /clear, a crash and a
// reboot, while "which run am I" must not outlive the chat that decided it.
//
// It used to be one <repo>/docs/.run-state.json per repository. That could hold exactly
// one feature, one phase and one set of counters, so two chats driving one checkout
// overwrote each other — and a bare `/ship`, which resumes without naming anything,
// picked up whichever run the file happened to hold. The in-repo location had no
// justification left either: the file is covered by a global gitignore and never
// committed, and a run executing in its own worktree wrote state into that worktree's
// docs/, invisible to the chat that started it.
//
// **A repo whose docs/.run-state.json still exists keeps using it.** A run in flight
// when this landed must not be migrated underneath itself, so the legacy file stays the
// source of truth for its own run until that run finishes. New runs go to the registry.
//
// Called as a script from /execute rather than hand-edited by the model mid-run: the
// counters are the loop's only bound, and a script cannot forget to bump one.
//
// Retry counters live here rather than in the conversation for a specific reason: an
// in-memory counter resets to zero every time a run is resumed, which silently unbounds
// the loop. On disk, a resumed run picks up the count it left at.
//
//   node run-state.cjs start --feature <name> [--brief-file docs/briefs.md]
//   node run-state.cjs phase <name> [--plan <path>]   # see PHASES below for the legal set
//   node run-state.cjs branch <name> [--base <branch>]  # records the run's work branch
//   node run-state.cjs begin-brief <n>            # resets counters only when n is new
//   node run-state.cjs review-round [<n>] | debug-round [<n>]   # n defaults to currentBrief
//   node run-state.cjs block <n> --reason <text>
//   node run-state.cjs finish-brief <n> [--commit <sha>]
//   node run-state.cjs finish                     # whole run done
//   node run-state.cjs get [--all] [--feature <name>]   # one run, or every run here
//   node run-state.cjs current [<feature>]        # read or set this chat's run
//   node run-state.cjs table                      # every run here, for /ship to show
//   node run-state.cjs unlock                     # list this repo's locks, read-only (see below)
//
// Every command takes an optional `--feature <name>` to address a run explicitly
// instead of through the pointer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REL = path.join('docs', '.run-state.json');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');
const RUNS_DIR = path.join(STATE_DIR, 'ship-runs');
const POINTER_DIR = path.join(STATE_DIR, 'ship-current');

// /ship is a single command run twice: it reads the phase and does whatever comes
// next. Only the values listed here are actionable, and an unknown one is rejected
// rather than written — a typo like "excuting" would leave /ship in a state no
// branch handles, which is the precise failure the phase exists to prevent.
// Ordered as a run passes through them. `awaiting-direction` is the earliest: a
// run waits there on which approach to take, before any plan document exists.
// It is also the second place /ship stops, so "first" and "second" both describe
// it truthfully -- hence "earliest", which only has one reading.
const PHASES = ['awaiting-direction', 'planning', 'awaiting-approval', 'executing', 'landing'];

// The repository, not the directory. `--git-common-dir` is the shared .git of every
// worktree, so a run started in the checkout is visible to the agent working in the
// worktree it spawned — and two unrelated repos never collide. Outside a repo we fall
// back to the directory itself, which at least keeps such runs from pooling together.
function repoKey(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf-8' });
  const dir = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : path.resolve(cwd);
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

const legacyPath = (cwd) => path.join(cwd, REL);
const runsDir = (cwd) => path.join(RUNS_DIR, repoKey(cwd));
// Per-brief arm files gate-arm.cjs writes: state/brief-exec/<session>/<n>.json.
// `finish-brief`/`block` remove the ONE for the brief they touch, never the
// whole directory -- a group has one file per member and disarming brief 4
// must not disarm brief 5's still-unreviewed one.
const briefExecArmFile = (session, n) => path.join(STATE_DIR, 'brief-exec', session, `${n}.json`);
const briefReviewFile = (session) => path.join(STATE_DIR, 'brief-review', `${session}.json`);
// A feature name reaches the filesystem, so anything that could climb out of the
// directory is flattened rather than trusted.
const safe = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
const runPath = (cwd, feature) => path.join(runsDir(cwd), `${safe(feature)}.json`);
const pointerPath = (session = null) => {
  // A hook is handed its session on stdin; the CLI reads it from the environment.
  const sid = session || process.env.CLAUDE_CODE_SESSION_ID;
  return sid ? path.join(POINTER_DIR, `${safe(sid)}.json`) : null;
};

// Kept as an export for callers that only want the path of the legacy file.
function statePath(cwd) {
  return legacyPath(cwd);
}

// A corrupt state file must never wedge a later session: report the corruption and
// carry on with an empty object rather than throwing out of a hook.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Floored to the millisecond, same as verify-gate.cjs's own armedAtOf: a
// verdict's `at` is an ISO string (ms resolution), while mtimeMs can carry a
// sub-ms fraction, so an unfloored fallback could read a same-millisecond
// verdict as microseconds earlier and wrongly discard it as stale.
function armedAtOf(armedAt, armFilePath) {
  if (armedAt) {
    const parsed = Date.parse(armedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  try { return Math.floor(fs.statSync(armFilePath).mtimeMs); } catch { return null; }
}

// Whether an APPROVED verdict for brief `n`, dated after `cutoff` (an armedAt
// in ms, or null), is on file in this session's review marker. Mirrors the
// same staleness rule verify-gate.cjs applies: a verdict recorded BEFORE this
// brief's own arming belongs to a previous one and must not count. `cutoff`
// null (no armedAt on the arm object AND no readable mtime for its file) is
// the one case with truly nothing to compare against, and is treated as no
// staleness check -- callers get there via armedAtOf, not by passing armedAt
// straight through, so an arm with no `armedAt` field still gets its file's
// own mtime as the cutoff rather than skipping the check entirely.
function hasFreshApproval(session, n, cutoff) {
  const review = readJson(briefReviewFile(session));
  if (!review) return false;
  // `n` arrives already normalised (finish-brief/block parse it with
  // `Number(rest[0])`), but verify-record.cjs's own brief-number capture does
  // not strip leading zeros -- a verdict recorded under "06" must still
  // satisfy an arm for "6". Mirrors verify-gate.cjs's own fallback lookup.
  const verdicts = review.verdicts && typeof review.verdicts === 'object' ? review.verdicts : null;
  const zeroPadded = Object.keys(verdicts || {}).find((k) => k !== n && String(Number(k)) === n);
  const entry = verdicts ? (verdicts[n] ?? (zeroPadded !== undefined ? verdicts[zeroPadded] : null)) : null;
  const rec = entry || (String(Number(review.brief)) === n ? { verdict: review.verdict, at: review.at } : null);
  if (!rec || rec.verdict !== 'APPROVED') return false;
  if (cutoff === null || cutoff === undefined) return true; // nothing to compare against
  const recAt = rec.at ? Date.parse(rec.at) : NaN;
  return !Number.isNaN(recAt) && recAt >= cutoff;
}

// Removes brief `n`'s per-brief arm file. `requireApproval` is what
// distinguishes `finish-brief` (must not disarm an unreviewed brief) from
// `block` (always disarms -- blocking IS the resolution, review or not).
// A missing arm file, or no session id to look one up under, is a silent
// no-op either way: not every run is being driven under the gate-arm.cjs
// mechanism (a legacy single-file marker, or no marker at all), and this
// must not invent an error for a brief that was never armed this way.
//
// Returns true if disarmed (or nothing needed disarming), false if an arm
// file exists but the approval requirement was not met -- the caller turns
// that into a non-zero exit rather than silently leaving the brief armed
// with no explanation.
function disarmBriefArm(n, { requireApproval }) {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) {
    // Nothing to key an arm file on. Not necessarily an error -- most callers
    // of finish-brief/block are driven by a hook or CLI that always sets
    // this -- but silence here would hide a real misconfiguration, so it is
    // said on stderr rather than swallowed.
    process.stderr.write(
      'run-state.cjs: CLAUDE_CODE_SESSION_ID is not set; cannot look up or clear a per-brief arm file.\n');
    return true;
  }
  const armFile = briefExecArmFile(session, n);
  const arm = readJson(armFile);
  if (!arm) return true; // never armed this way (or already disarmed): nothing to do
  const cutoff = armedAtOf(arm.armedAt, armFile);
  if (requireApproval && !hasFreshApproval(session, String(n), cutoff)) return false;
  try { fs.unlinkSync(armFile); } catch { /* already gone */ }
  return true;
}

// Temp file + rename rather than a direct write. A parallel review group (several
// reviewers finishing at once) means concurrent processes writing the SAME run
// file; a direct write can interleave with another process's write and leave the
// file holding a mix of both, which is worse than either write alone. The temp
// name is unique per process (pid + timestamp), and rename onto the target is
// atomic on the filesystems this runs on, so every reader sees one write or the
// other, never a splice of the two.
function writeJson(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // The temp file's own directory follows the same STATE_DIR-or-redirect
  // rule as lockPathFor: a registry run's .tmp sits harmlessly next to its
  // .json, but a legacy run's .tmp must not land in the repo's docs/ either.
  const tmpDir = path.dirname(sideFileBase(file));
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `.${path.basename(file)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    // A failed write or rename must not leave its temp file behind for the
    // "no temp files left" check above to keep tripping over later -- clean up
    // on the way out, then let the caller see the real failure.
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }
  return obj;
}

// writeJson's temp-file-and-rename stops a write from being torn, but does
// nothing about two commands racing to read-modify-write the SAME file: both
// read the old content, both compute a new object in memory from it, and
// whichever rename lands second wins -- silently discarding the first
// process's update. Two parallel `begin-brief` calls lost an inFlight entry
// in 14 of 20 measured runs this way. The fix is a lock held across the
// WHOLE read-modify-write span, not just the write: `withLock` below is what
// every command in `main()`'s switch wraps its resolve()..save() in.
//
// `wx` is O_CREAT|O_EXCL: the open itself fails with EEXIST if the lock file
// already exists, so acquisition is a single atomic syscall rather than a
// check-then-create race between this process and another one.
//
// verify-record.cjs spawns `review-round` with a 5000ms timeout on the child
// process and cannot be edited from here to change that. If this bound were
// allowed to reach 5s too, a lock held right up to it would let the SPAWN's
// timeout kill the child first, which fails silently (a killed child, not a
// stderr message this process ever gets to write) instead of this bound's
// own loud, loggable error. Kept clearly below 5s so this always loses that
// race and the loud path is the one that fires.
const LOCK_RETRY_BOUND_MS = 3_000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_MAX_MS = 80;
// How old an unparseable lock file must be before `unlock` will remove it
// with no pid to check liveness on. Comfortably longer than any real
// acquireLock/write span, so a lock file caught mid-write by `unlock` is
// never mistaken for one abandoned by a crash.
const UNLOCK_UNPARSEABLE_AGE_MS = 60_000;

// A registry run file already lives under STATE_DIR (inside CLAUDE_CONFIG_DIR),
// so co-locating its `.lock`/temp-write files right next to it is harmless.
// A LEGACY run's file is <repo>/docs/.run-state.json -- co-locating there put
// `.lock` and writeJson's own `.tmp` inside the repository's own docs/,
// where `git add -A` (or an unsuspecting `git status`) could see them. Side
// files for anything outside STATE_DIR are redirected here instead, keyed by
// a hash of the file's own absolute path so two different repos' legacy runs
// (both named docs/.run-state.json) never collide under the shared LOCKS_DIR.
const LOCKS_DIR = path.join(STATE_DIR, 'locks');
function sideFileBase(file) {
  const abs = path.resolve(file);
  if (abs.startsWith(`${STATE_DIR}${path.sep}`) || abs === STATE_DIR) return abs;
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
  return path.join(LOCKS_DIR, hash);
}

const lockPathFor = (file) => `${sideFileBase(file)}.lock`;

// A path handed back inside a `rm '<path>'` hint has to survive being pasted
// into a real shell, and CLAUDE_CONFIG_DIR (the base every registry/legacy
// lock path is built from) is not guaranteed apostrophe-free -- a machine
// account or CI workspace named e.g. o'brien-config puts a literal `'` inside
// the single-quoted path, breaking the quoting rather than merely looking
// odd. Standard POSIX single-quote escaping: close the quote, emit an
// escaped literal quote, reopen it.
const shellQuoteSingle = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Node has no synchronous sleep. A SharedArrayBuffer backed Int32Array gives
// Atomics.wait something to block on: it parks the thread for the given
// number of milliseconds without spinning the CPU or requiring a callback,
// which a retry loop inside a synchronous CLI command needs.
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// Whether `pid` is still alive. `process.kill(pid, 0)` sends no signal --
// it only asks the kernel whether the target exists and is ours to signal --
// so this is a liveness check, not an attempt to affect the other process.
// ESRCH means no such process; any other error (most commonly EPERM, a live
// pid owned by someone else) still means "alive", just not ours to touch.
function pidIsAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// Automatic stale-lock takeover used to rename `lockPath` away by PATH once
// its mtime looked old enough. That is unsafe: rename acts on whatever is
// CURRENTLY at the path, not on the specific file a process inspected, so a
// second racer's takeover can yank a live lock's path out from under its
// real holder, and the restore afterward still leaves a window where a
// THIRD process freshly `wx`-creates a lock there -- measured directly, by
// inode tracing, as the cause of a lost `begin-brief` entry under 8-way
// contention. No amount of re-checking with plain fs calls closes that
// window, because the path itself is the only thing anyone is racing on.
//
// So a lock is never taken over automatically. Instead every lock records
// who holds it (`pid`) and a random `token` unique to that acquisition.
// `acquireLock` only ever refuses loudly when the retry bound expires,
// naming the holder if it is still alive, or naming `unlock` if it is not.
// `releaseLock` only ever removes a lock whose token it itself wrote, so a
// lock recreated by someone else since this process's own acquire survives
// this process's release. Clearing a dead holder's lock is a deliberate,
// separate act (`unlock`, below) -- never something a write does for you.
function acquireLock(file) {
  const lockPath = lockPathFor(file);
  // The lock's own directory, not `file`'s -- a legacy run's lock is
  // redirected under LOCKS_DIR (see lockPathFor/sideFileBase) and that
  // directory may not exist yet, independent of whether the repo's docs/
  // already does.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + LOCK_RETRY_BOUND_MS;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        const holder = readJson(lockPath);
        const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
        if (holderPid !== null && pidIsAlive(holderPid)) {
          throw new Error(
            `run state is locked by pid ${holderPid} (a command still running); retry`);
        }
        // `unlock` is now read-only (round 3): it never deletes, so the
        // message names the exact path and both of the human's two options
        // directly, rather than a command that would act on this holder's
        // behalf. `unlock` on its own still lists every lock for this repo
        // (registry and legacy) with holder/age/rm-line, for a human to
        // confirm this one really is abandoned before running the `rm`.
        throw new Error(
          `stale run-state lock left by crashed pid ${holderPid ?? '?'} at ${lockPath} -- ` +
          `run \`node ${__filename} unlock\` to inspect it, or \`rm ${shellQuoteSingle(lockPath)}\` if that pid is dead`);
      }
      const backoff = LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS));
      sleepSync(backoff);
      continue;
    }
    // The `wx` open succeeded, so this process now owns lockPath -- but it is
    // not yet a valid lock until its content (the token a later release()
    // checks against) is actually on disk. A write or close failing here
    // (disk full, EBADF) would otherwise leave an empty or partial file at
    // lockPath that this process never returns a token for: acquireLock
    // throws, so the caller never releases it, and every later acquirer sees
    // EEXIST forever with no pid inside to diagnose as dead. Removing it here
    // is what stops a failed acquire from behaving like a permanent stale lock.
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch (err) {
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      throw err;
    }
    return { lockPath, token };
  }
}

// Removes the lock only if the token on disk still matches the one this
// process itself wrote at acquire time -- never by path alone. A lock this
// process opened can, in principle, have been legitimately cleared and
// recreated by someone else in between (an `unlock` racing the tail of this
// process's own critical section); comparing the token, not just checking
// existence, is what stops this release from deleting THEIR lock instead of
// the one this process created.
function releaseLock({ lockPath, token }) {
  const current = readJson(lockPath);
  if (current && current.token === token) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

// process.exit() terminates immediately and does NOT run pending `finally`
// blocks -- a command that validated its arguments and called
// process.exit(2) from INSIDE a locked callback would leave the lock file
// behind forever, wedging every later command on that run. Every early-exit
// inside a withRunLock callback throws this instead, so withLock's `finally`
// releases the lock before main() turns it into the same process.exit(code).
class ExitSignal extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}
const exitWith = (code) => { throw new ExitSignal(code); };

// Runs `fn` with the file's lock held for its entire duration -- the read
// inside `fn` and the write it eventually performs must be atomic together,
// or a second process can read the pre-modification state in the gap between
// them. Always releases in `finally`, so a thrown error (including a failed
// acquireLock, or an ExitSignal from inside `fn`) never leaves the lock file
// behind for the next command to find inert. On failure to acquire at all,
// this propagates rather than running `fn` unlocked -- a command that cannot
// get the lock must exit non-zero, never write without it or silently skip
// the write.
function withLock(file, fn) {
  const held = acquireLock(file);
  try {
    return fn();
  } finally {
    releaseLock(held);
  }
}

function blank() {
  return {
    feature: null,
    phase: null,
    planFile: null,
    // The branch the run's commits go on, and what it forked from. /ship always
    // creates one, so which branch you were standing on never matters and no
    // list of "protected" branch names is needed — such a list is a local
    // accident that fits exactly one repo.
    branch: null,
    baseBranch: null,
    briefFile: 'docs/briefs.md',
    currentBrief: null,
    attempt: 0,
    reviewRounds: 0,
    debugRounds: 0,
    // Every brief that has been begun and not yet finished or blocked, keyed by
    // its number as a string (JSON object keys are always strings). A parallel
    // review group begins more than one brief in the same run before any of them
    // finishes, so one shared set of counters can no longer tell them apart.
    // `currentBrief`/`attempt`/`reviewRounds`/`debugRounds` above stay accurate
    // for whichever brief was begun or touched most recently — that is what a
    // run with exactly one brief in flight has always looked like, and every
    // caller that only reads the top level (checkpoint-write.cjs, agent-log.cjs,
    // checkpoint-restore.cjs) keeps reading it that way without change.
    // verify-record.cjs's direct write is different: it bumps ONLY the top-level
    // reviewRounds and never touches inFlight, so on its own that write would be
    // clobbered by the very next command's syncTop, which copies inFlight[n]
    // back over the top level. normalise()'s reconcile step below is what keeps
    // that write from being lost.
    inFlight: {},
    blocked: [],
    startedAt: null,
    lastCommit: null,
    finishedAt: null,
  };
}

function blankEntry() {
  return { attempt: 0, reviewRounds: 0, debugRounds: 0 };
}

// A per-brief entry is defaulted the same way the top-level counters are: a
// half-written or pre-registry entry degrades to zero, not to undefined
// arithmetic.
function normaliseEntry(raw) {
  const e = blankEntry();
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(e)) {
      if (typeof raw[k] === 'number' && !Number.isNaN(raw[k])) e[k] = raw[k];
    }
  }
  return e;
}

// Every field is defaulted on read. A half-written file from a killed process should
// degrade to sane values, not to undefined arithmetic.
function normalise(raw) {
  const s = blank();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of Object.keys(s)) {
    // Normalised separately below, entry by entry, rather than copied wholesale.
    if (k === 'inFlight') continue;
    if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
  }
  if (!Array.isArray(s.blocked)) s.blocked = [];
  for (const k of ['attempt', 'reviewRounds', 'debugRounds']) {
    if (typeof s[k] !== 'number' || Number.isNaN(s[k])) s[k] = 0;
  }
  if (raw.inFlight && typeof raw.inFlight === 'object') {
    for (const [n, entry] of Object.entries(raw.inFlight)) s.inFlight[n] = normaliseEntry(entry);
  }
  // Reconcile the top-level mirror against the current brief's own entry rather
  // than trusting either alone. Two things land here, both real:
  //   - A file written before inFlight existed -- the legacy single-file
  //     format, or any registry file from before this change -- has no entry
  //     for its OWN current brief at all, so `entry` below is a blank (zeroed)
  //     one and the max just backfills it from the top level, exactly as
  //     before.
  //   - verify-record.cjs writes the top-level counter directly and never
  //     touches inFlight, so the top level can be AHEAD of a stale entry left
  //     by an earlier read. Copying inFlight over the top level here (as a
  //     plain backfill-when-missing would) would silently roll that write
  //     back; taking the max per field survives it instead.
  // Either way, taking the max can only ever move a counter up to what one of
  // its two recordings already claims -- never invent a bump neither made.
  if (s.currentBrief !== null && s.currentBrief !== undefined) {
    const key = String(s.currentBrief);
    const entry = normaliseEntry(s.inFlight[key]);
    const reconciled = {
      attempt: Math.max(s.attempt, entry.attempt),
      reviewRounds: Math.max(s.reviewRounds, entry.reviewRounds),
      debugRounds: Math.max(s.debugRounds, entry.debugRounds),
    };
    s.inFlight[key] = reconciled;
    s.attempt = reconciled.attempt;
    s.reviewRounds = reconciled.reviewRounds;
    s.debugRounds = reconciled.debugRounds;
  }
  return s;
}

// The top-level attempt/reviewRounds/debugRounds mirror inFlight[n] for whichever
// brief n was most recently begun or touched. Every single-brief caller reads
// only the top level, so this is what keeps their meaning unchanged when exactly
// one brief is in flight -- they are, by construction, reading brief n's own
// entry under another name.
function syncTop(s, n) {
  const entry = normaliseEntry(s.inFlight[String(n)]);
  return { ...s, currentBrief: n, attempt: entry.attempt, reviewRounds: entry.reviewRounds, debugRounds: entry.debugRounds };
}

// Shared body of `review-round` and `debug-round`: bump one field of one
// brief's entry, defaulting the brief to whichever one is current when no
// number is given (today's single-brief call shape, unchanged). Only mirrors
// the bump into the top-level counters when it lands on the CURRENT brief --
// a round recorded against some other brief in flight must not move the
// counters a single-brief caller is reading.
function withBriefRound(s, nArg, field) {
  const parsed = nArg !== undefined && nArg !== null && String(nArg).trim() !== '' && !Number.isNaN(Number(nArg))
    ? Number(nArg) : null;
  const n = parsed !== null ? parsed : s.currentBrief;
  if (n === null || n === undefined || Number.isNaN(n)) {
    // No brief identified at all -- nothing to key an entry on. Matches the
    // pre-registry behaviour of bumping the bare counter with no brief in play.
    return { ...s, [field]: s[field] + 1 };
  }
  const key = String(n);
  const entry = normaliseEntry(s.inFlight[key]);
  entry[field] += 1;
  const next = { ...s, inFlight: { ...s.inFlight, [key]: entry } };
  return n === s.currentBrief ? syncTop(next, n) : next;
}

/**
 * Which run this invocation is about, and which file holds it.
 *
 * The order matters and is the part that stops a chat inheriting someone else's
 * work. An explicit `--feature` always wins. Otherwise the pointer decides, and
 * only if it names a run in THIS repository — a pointer left behind by a chat that
 * was working elsewhere resolves to nothing rather than to the wrong run. The
 * legacy file is consulted last, so a repo mid-migration keeps working.
 *
 * `kind: 'none'` is a real answer and callers must handle it: it is what a chat
 * with no pointer sees, and the reason /ship prints its table instead of guessing.
 */
function resolve(cwd, feature = null, session = null) {
  if (feature) {
    const file = runPath(cwd, feature);
    return { kind: 'registry', file, state: normalise(readJson(file)), feature };
  }

  const ptr = pointerPath(session) ? readJson(pointerPath(session)) : null;
  if (ptr && ptr.feature && ptr.repoKey === repoKey(cwd)) {
    const file = runPath(cwd, ptr.feature);
    if (fs.existsSync(file)) {
      return { kind: 'registry', file, state: normalise(readJson(file)), feature: ptr.feature };
    }
  }

  const legacy = legacyPath(cwd);
  if (fs.existsSync(legacy)) {
    const state = normalise(readJson(legacy));
    return { kind: 'legacy', file: legacy, state, feature: state.feature };
  }

  return { kind: 'none', file: null, state: blank(), feature: null };
}

// Writing back to wherever the run already lives. A legacy run keeps its file; a
// registry run keeps its own. Nothing is silently relocated mid-run.
function save(cwd, res, state) {
  // Test-only hook (RUN_STATE_TEST_RMW_DELAY_MS): widens the
  // read-modify-write window between resolving state and writing it back, so
  // a test racing two concurrent commands can force them to overlap
  // deterministically instead of depending on scheduling luck to
  // occasionally catch a missing lock. Placed here rather than in
  // `withRunLock` so it still fires if a command's OWN lock is what is
  // missing -- withRunLock disappears along with the bug it is testing for,
  // but every write, locked or not, still passes through `save`. Production
  // never sets it.
  const rmwDelay = Number(process.env.RUN_STATE_TEST_RMW_DELAY_MS);
  if (Number.isFinite(rmwDelay) && rmwDelay > 0) sleepSync(rmwDelay);
  const file = res.file || runPath(cwd, state.feature || 'unnamed');
  return writeJson(file, state);
}

function setPointer(cwd, feature, session = null) {
  const p = pointerPath(session);
  if (!p) return;                      // no session id: nothing to remember it by
  writeJson(p, { repoKey: repoKey(cwd), feature, at: new Date().toISOString() });
}

// Every run this repository knows about, registry and legacy alike, so /ship's table
// can show a run that predates the registry beside the ones that do not.
function listRuns(cwd) {
  const dir = runsDir(cwd);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { names = []; }
  const withFile = (file) => {
    const r = normalise(readJson(file));
    // When the run was last touched. Taken from the file rather than stored in it:
    // a field would need every writer to remember to update it, and the filesystem
    // already knows.
    try { r.updatedAt = fs.statSync(file).mtime.toISOString(); } catch { r.updatedAt = null; }
    return r;
  };
  for (const n of names) out.push(withFile(path.join(dir, n)));
  const legacy = legacyPath(cwd);
  if (fs.existsSync(legacy)) out.push(withFile(legacy));
  return out;
}

// Every feature name this repo's registry has a LOCK for -- enumerated from
// the `*.json.lock` files themselves, not from the `*.json` run files that
// happen to still exist. A run file can be gone (removed, or never written
// because acquireLock failed before writeJson ran) while its lock survives:
// `start --feature y` then fails naming that lock's exact path (acquireLock
// only ever needs the lock, never the run file, to detect it), and `unlock`
// walking `.json` names instead of `.json.lock` names missed that same lock
// entirely and reported none present -- the one tool built to inspect a
// stuck lock unable to find the lock actually blocking the run.
function listRegistryLockNames(cwd) {
  let names = [];
  try { names = fs.readdirSync(runsDir(cwd)).filter((f) => f.endsWith('.json.lock')); } catch { names = []; }
  return names.map((f) => f.slice(0, -'.json.lock'.length));
}

// One row of `unlock`'s read-only report for the lock at `lockPath`. Never
// touches the lock itself beyond a read -- this is the one place a decision
// about a lock's fate is rendered as information for a human, not acted on.
function describeLock(lockPath, feature) {
  const held = readJson(lockPath);
  let stat;
  try { stat = fs.statSync(lockPath); } catch { return { exists: false }; }
  const pid = held && Number.isFinite(held.pid) ? held.pid : null;
  const alive = pid !== null && pidIsAlive(pid);
  const heldAt = held && held.at ? Date.parse(held.at) : NaN;
  const ageMs = !Number.isNaN(heldAt) ? Date.now() - heldAt : Date.now() - stat.mtimeMs;
  // Clearable, i.e. worth printing an `rm` line for: a recorded pid that is
  // confirmed dead, or no parseable pid at all (a write torn mid-acquire)
  // once it is older than a live acquirer could still plausibly be
  // mid-write for -- UNLOCK_UNPARSEABLE_AGE_MS bounds that the same way the
  // deleting `unlock` used to, just as a hint here rather than an action.
  const clearable = pid !== null ? !alive : ageMs > UNLOCK_UNPARSEABLE_AGE_MS;
  return { exists: true, path: lockPath, feature, pid, alive, ageMs, clearable };
}

/**
 * What /ship prints when a chat has no pointer, and the only place a run's state is
 * shown rather than acted on.
 *
 * Everything git or GitHub can answer is derived HERE, per call, and never stored:
 * whether the branch still exists, whether there is a PR, how far behind its base a
 * run has drifted. Storing any of it would mean a second thing to keep true, and it
 * would be wrong the moment anyone used git outside /ship.
 *
 * Which also means every column is a subprocess that can fail — no network, no gh,
 * not logged in, a deleted branch. Each lookup degrades to a placeholder on its own;
 * none of them may take the table down, because this is what someone sees when they
 * are already lost.
 */
function probe(args, cwd) {
  try {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf-8', timeout: 5000 });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

const DASH = '—';

function ago(iso) {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return DASH;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const when = (iso) => {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function tableRows(cwd) {
  return listRuns(cwd).map((r, i) => {
    const branchLive = r.branch ? probe(['git', 'rev-parse', '--verify', '--quiet', r.branch], cwd) !== null : null;
    let pr = DASH;
    if (r.branch && branchLive) {
      const out = probe(['gh', 'pr', 'list', '--head', r.branch, '--state', 'all',
        '--json', 'number,state', '--limit', '1'], cwd);
      try {
        const [first] = out ? JSON.parse(out) : [];
        if (first) pr = `#${first.number} ${String(first.state).toLowerCase()}`;
      } catch { pr = DASH; }
    }
    let behind = DASH;
    if (r.branch && r.baseBranch && branchLive) {
      const n = probe(['git', 'rev-list', '--count', `${r.branch}..${r.baseBranch}`], cwd);
      if (n !== null) behind = n === '0' ? '-' : `${n} commits`;
    }
    return {
      '#': String(i + 1),
      feature: r.feature || DASH,
      phase: r.phase || DASH,
      brief: r.currentBrief === null || r.currentBrief === undefined ? DASH : String(r.currentBrief),
      branch: r.branch ? (branchLive ? r.branch : `${r.branch} (gone)`) : DASH,
      base: r.baseBranch || DASH,
      PR: pr,
      started: when(r.startedAt),
      'last activity': ago(r.updatedAt),
      behind,
    };
  });
}

function renderTable(rows) {
  if (!rows.length) return 'No ship runs in this repository yet. `/ship <idea>` starts one.\n';
  const cols = Object.keys(rows[0]);
  const w = {};
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (cells) => cols.map((c, i) => String(cells[i]).padEnd(w[c])).join('  ').trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n') + '\n';
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

// Read-only commands don't need a lock: `get`, `table` and a bare `current`
// only read, and reading the file mid-write is already handled by
// writeJson's rename (a reader either sees the old inode or the new one,
// never a splice). Every other command reads, modifies and writes the SAME
// run file (or, for `current`/`start`, the session pointer file too), and
// that whole span is what needs to be atomic across processes.
//
// `fn` is called with the resolved `res` (file + state) rather than
// resolving it itself, and that resolve happens ONLY after the lock is
// held. An earlier version picked the file to lock from an unlocked
// `resolve()` and then had `fn` call `resolve()` again for its own read --
// two separate, unlocked pointer reads. Between them the pointer could be
// repointed at a different run entirely (`current <other-feature>` from a
// second chat), so the lock ended up held on the file the FIRST read named
// while `fn` quietly read and wrote whatever the SECOND read found: real
// exclusion on the wrong file is no exclusion on the right one. Resolving
// once, under the lock, and handing that single result to `fn` closes the
// gap: whichever file gets locked is the exact file `fn` reads and writes,
// with no unlocked resolve in between for the pointer to move during.
// Bounds the re-resolve retry below. The pointer can only move a bounded
// number of times between this process reading it provisionally and holding
// the lock it picked from that read -- each retry itself re-acquires a lock,
// which already backs off and has its own multi-second bound, so this just
// stops a pathological back-and-forth (two other processes trading the
// pointer back and forth) from looping forever instead of eventually erroring.
const RESOLVE_RETRY_LIMIT = 10;

function withRunLock(cwd, feature, fn) {
  // The lock is keyed on the file the write will land in. `feature` is
  // whatever the caller already knows before reading (an explicit
  // `--feature`, or null to mean "resolve through the pointer as normal").
  // For `--feature`, that is exactly `runPath` -- no read needed to know it,
  // so it is safe to compute before any lock is held and can never move: it
  // names the same file on every retry below. For the pointer path, the
  // pointer itself has to be read to find the run file at all; that first
  // read is provisional and only used to pick a LOCK target.
  //
  // Holding that lock does not stop the POINTER itself from moving in the
  // meantime -- a lock on alpha.json excludes another writer of alpha.json,
  // not a `current beta` call, which only touches the separate pointer file.
  // So once the lock is held, resolve() is run again; if it now names a
  // DIFFERENT file than the one just locked, the pointer moved while this
  // process was waiting and the lock it is holding excludes nothing useful
  // -- it must release that lock, re-resolve to find the new target, and
  // lock THAT instead, repeating until the file it holds and the file
  // resolve() names agree. Only then is `fn` called, with that same
  // agreeing resolve so it never re-reads and risks a third answer.
  for (let attempt = 0; attempt < RESOLVE_RETRY_LIMIT; attempt++) {
    const provisional = feature ? runPath(cwd, feature) : (resolve(cwd, null).file || runPath(cwd, 'unnamed'));
    const held = acquireLock(provisional);
    try {
      const res = resolve(cwd, feature);
      const actual = res.file || runPath(cwd, 'unnamed');
      if (actual === provisional) return fn(res);
      // Pointer moved between the provisional resolve and the lock being
      // granted: this lock excludes nothing relevant, so drop it and retry
      // against wherever resolve() now points.
    } finally {
      releaseLock(held);
    }
  }
  throw new Error('run-state: the pointer kept moving while retrying to acquire its lock; give up');
}

// `pointerPath`/`runPath` already flatten a session id or feature name
// through `safe()` before it reaches a path, but `briefExecArmFile` joins
// the session id straight in (see its own comment) -- a session id of
// '../../../../tmp/x' resolved that arm-file directory entirely outside
// STATE_DIR. Rather than patch every future caller to remember `safe()`,
// the id is refused outright, as early as main() can check it, the moment
// it contains anything that could act as a path separator or a directory
// climb. `session_id` is handed to this script only by the harness (a hook
// on stdin, or CLAUDE_CODE_SESSION_ID in the environment), never typed by a
// user, so a legitimate one is never expected to look like this.
function rejectUnsafeSessionId() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) return; // nothing to check; callers with no session id at all are handled elsewhere
  if (/[\\/]|\.\./.test(sid)) {
    process.stderr.write(
      `run-state.cjs: CLAUDE_CODE_SESSION_ID ('${sid}') contains a path separator or '..', ` +
      'which is never legitimate for a real session id; refusing.\n');
    process.exit(2);
  }
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const cwd = process.cwd();
  const now = new Date().toISOString();
  const featureFlag = flag(rest, '--feature');
  rejectUnsafeSessionId();

  // A command that fails to acquire its lock, or that hits a validation
  // error from inside a locked callback (an ExitSignal thrown by exitWith),
  // must still exit non-zero -- but only AFTER withLock's `finally` has
  // already released the lock, which is why those paths throw instead of
  // calling process.exit() directly. Catching here, once, after the switch
  // has fully unwound, is what makes that ordering hold for every command.
  try {
    runCommand(cmd, rest, cwd, now, featureFlag);
  } catch (err) {
    if (err instanceof ExitSignal) process.exit(err.code);
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  process.exit(0);
}

function runCommand(cmd, rest, cwd, now, featureFlag) {
  switch (cmd) {
    case 'start': {
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        // Deliberately does NOT refuse when other runs exist. That refusal was a
        // consequence of the single-file layout, not a rule worth keeping: starting a
        // second feature while a first is in flight is the case this exists to serve.
        const feature = flag(rest, '--feature', s.feature);
        // Validated here as well as in `phase`, and BEFORE anything is written.
        // /ship Start is the entry point that actually passes --phase, so a
        // whitelist enforced only in `phase` was bypassable one subcommand over:
        // a typo landed in the run file with a clean exit, leaving /ship in a
        // phase its table has no branch for. Rejecting after the write would
        // report the typo and persist it anyway, so the check precedes writeJson.
        const startPhase = flag(rest, '--phase', 'planning');
        if (!PHASES.includes(startPhase)) {
          process.stderr.write(`unknown phase '${startPhase}'; expected one of ${PHASES.join('|')}\n`);
          exitWith(2);
        }
        const state = {
          ...blank(),
          feature,
          // A run always begins by working out what to do. /ship relies on this so
          // that a bare `start` is enough to enter the machine.
          phase: startPhase,
          briefFile: flag(rest, '--brief-file', s.briefFile || 'docs/briefs.md'),
          startedAt: now,
        };
        writeJson(runPath(cwd, feature), state);
        setPointer(cwd, feature);
      });
      break;
    }

    case 'current': {
      // Reading or re-pointing this chat at a run, which is what /ship does once the
      // user picks one out of the table.
      if (rest[0] && !rest[0].startsWith('--')) {
        withRunLock(cwd, rest[0], (res) => {
          setPointer(cwd, rest[0]);
          process.stdout.write(`${JSON.stringify(res.state, null, 2)}\n`);
        });
      } else {
        const ptr = pointerPath() ? readJson(pointerPath()) : null;
        process.stdout.write(`${JSON.stringify(ptr, null, 2)}\n`);
      }
      break;
    }

    case 'begin-brief': {
      const n = Number(rest[0]);
      // Number(undefined) is NaN, and String(NaN) is the literal text "NaN" --
      // without this guard a bare `begin-brief` silently created a real
      // inFlight entry keyed by that string instead of failing.
      if (rest[0] === undefined || Number.isNaN(n)) {
        process.stderr.write('usage: run-state.cjs begin-brief <n>\n');
        process.exit(2);
      }
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        const key = String(n);
        // Re-entering a brief already in flight (a resume, or a second attempt on
        // it) must NOT reset ITS counters — that is precisely how a bounded loop
        // becomes unbounded. A brief never begun before this call starts fresh,
        // regardless of what any OTHER brief in flight is holding.
        const existing = s.inFlight[key];
        const entry = existing ? { ...normaliseEntry(existing), attempt: existing.attempt + 1 } : { ...blankEntry(), attempt: 1 };
        const inFlight = { ...s.inFlight, [key]: entry };
        save(cwd, res, { ...syncTop({ ...s, inFlight }, n), finishedAt: null });
      });
      break;
    }

    case 'phase': {
      const next = rest[0];
      if (!PHASES.includes(next)) {
        process.stderr.write(`unknown phase '${next}'; expected one of ${PHASES.join('|')}\n`);
        process.exit(2);
      }
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        save(cwd, res, { ...s, phase: next, planFile: flag(rest, '--plan', s.planFile) });
      });
      break;
    }

    case 'branch': {
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        // A leading `--` means no branch name was given. ship.md's Start step records
        // the base before the work branch exists, with `branch --base <branch>`, and
        // reading rest[0] literally wrote the string '--base' into `branch`. The real
        // `branch feature/x` call was then refused as a switch away from it, which is
        // how this surfaced: it blocked a live run rather than corrupting one quietly.
        const next = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
        if (!next) {
          if (!rest.includes('--base')) {
            process.stderr.write('usage: run-state.cjs branch <name> [--base <branch>]\n');
            exitWith(2);
          }
          save(cwd, res, { ...s, baseBranch: flag(rest, '--base', s.baseBranch) });
          return;
        }
        // A resume re-records the same branch and must succeed. A DIFFERENT branch
        // on an unfinished run is refused: it would split the feature in two, with
        // half the briefs committed on each and the PR carrying only one half.
        // Scoped to one run now — it never meant "one branch per repository".
        if (s.branch && s.branch !== next && !s.finishedAt) {
          process.stderr.write(
            `run is already on '${s.branch}'; refusing to switch to '${next}'. ` +
            `Finish or abandon the current run first.\n`);
          exitWith(2);
        }
        save(cwd, res, { ...s, branch: next, baseBranch: flag(rest, '--base', s.baseBranch) });
      });
      break;
    }

    case 'review-round':
      withRunLock(cwd, featureFlag, (res) => {
        // An explicit brief number is optional: a positional flag (e.g. `--reason`
        // on a different command) never reaches here, but a leading `--` on rest[0]
        // is still guarded against for the same reason `branch` guards its name.
        save(cwd, res, withBriefRound(res.state, rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined, 'reviewRounds'));
      });
      break;

    case 'debug-round':
      withRunLock(cwd, featureFlag, (res) => {
        save(cwd, res, withBriefRound(res.state, rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined, 'debugRounds'));
      });
      break;

    case 'block': {
      const n = Number(rest[0]);
      // Same guard as begin-brief/finish-brief: Number(undefined) is NaN, and
      // String(NaN) is the literal text "NaN" -- a bare `block` used to write
      // a real blocked entry keyed by that string instead of failing.
      if (rest[0] === undefined || Number.isNaN(n)) {
        process.stderr.write('usage: run-state.cjs block <n> --reason <text>\n');
        process.exit(2);
      }
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        const blocked = s.blocked.filter((b) => b.brief !== n);
        blocked.push({ brief: n, reason: flag(rest, '--reason', 'unspecified'), at: now });
        // No longer in flight once blocked. Only the top-level mirror is cleared
        // when the blocked brief IS the current one -- blocking some other brief
        // in flight must not disturb the counters a single-brief caller reads.
        const inFlight = { ...s.inFlight };
        delete inFlight[String(n)];
        let next = { ...s, blocked, inFlight };
        if (n === s.currentBrief) next = { ...next, currentBrief: null };
        save(cwd, res, next);
        // Blocking a brief IS its resolution, reviewed or not -- unlike
        // finish-brief, this removes the per-brief arm file unconditionally.
        disarmBriefArm(n, { requireApproval: false });
      });
      break;
    }

    case 'finish-brief': {
      const n = Number(rest[0]);
      // Same guard as begin-brief: no number means nothing to key an inFlight
      // deletion on, and "NaN" is not a brief this run ever had.
      if (rest[0] === undefined || Number.isNaN(n)) {
        process.stderr.write('usage: run-state.cjs finish-brief <n> [--commit <sha>]\n');
        process.exit(2);
      }
      withRunLock(cwd, featureFlag, (res) => {
        // Checked BEFORE the write: a brief armed via gate-arm.cjs (a
        // per-brief file is on disk) may only be finished once an APPROVED
        // verdict dated after ITS OWN armedAt is on file. Refusing here, not
        // after updating inFlight, is what stops a brief from being marked
        // finished in the run state while its gate stays armed and
        // unexplained -- the two must move together or not at all.
        if (!disarmBriefArm(n, { requireApproval: true })) {
          process.stderr.write(
            `run-state.cjs: brief ${n} is armed (state/brief-exec/${process.env.CLAUDE_CODE_SESSION_ID}/${n}.json) ` +
            'and has no APPROVED verdict recorded after that arming; refusing to finish it. ' +
            'Dispatch a reviewer, or use `block <n> --reason <why>` to disarm without one.\n');
          exitWith(1);
        }
        const s = res.state;
        const commit = flag(rest, '--commit', s.lastCommit);
        const inFlight = { ...s.inFlight };
        delete inFlight[String(n)];
        let next = { ...s, inFlight, lastCommit: commit };
        // Same rule as `block`: the top-level mirror only resets when the
        // finished brief is the one it was mirroring. A finish on some OTHER
        // brief in flight leaves it exactly as it was.
        if (n === s.currentBrief) next = { ...next, currentBrief: null, reviewRounds: 0, debugRounds: 0 };
        save(cwd, res, next);
      });
      break;
    }

    case 'finish':
      withRunLock(cwd, featureFlag, (res) => {
        const s = res.state;
        // Clearing the phase is what stops checkpoint-restore re-injecting a
        // finished run, and what tells /ship there is nothing left to resume.
        // inFlight is cleared too: a parallel review group can finish the
        // whole run before every one of its OWN briefs called finish-brief
        // individually, and a stale entry left behind would report bogus
        // in-progress counters for a brief this run no longer has any
        // business tracking.
        save(cwd, res, { ...s, currentBrief: null, phase: null, finishedAt: now, inFlight: {} });
      });
      break;

    // A stray positional argument is refused rather than ignored. `get alpha` reads
    // like it addresses a run; it did not, so the command silently returned whichever
    // run the POINTER resolved — a different one — with exit 0. Silently answering
    // about the wrong run is the failure this whole file exists to prevent, so the
    // interface must not reproduce it.
    case 'table':
      process.stdout.write(renderTable(tableRows(cwd)));
      break;

    // Round 3 ruling (orchestrator, after two rejected deleting designs):
    // `unlock` is READ-ONLY. Earlier rounds had it read a lock, decide the
    // holder was gone, and delete it -- and every shape of "decide" turned
    // out to have a hole: an empty/garbage `.unlocking` meta-lock could wedge
    // it, a legacy run (or one whose feature name collides with a registry
    // run) resolved `--feature` to the WRONG file and reported "no lock
    // present" while the real lock survived, and two concurrent unlocks
    // could still delete a lock a live acquirer had just recreated in the
    // gap between one unlock's read and its delete. Every one of those is a
    // consequence of `unlock` taking an action at all. Removing the action
    // removes the hole: this lists every lock this repo could have -- one
    // per registry feature under this repo's key, plus the legacy lock, if
    // either exists -- with its holder pid, whether that pid is alive, its
    // age, and (only for a lock whose holder is confirmed gone) the exact
    // `rm` line a human can run by hand. It never deletes anything, never
    // takes a lock of its own, and always exits 0 for a lock it found,
    // however stale -- reporting on a stuck lock is success, not a failure.
    case 'unlock': {
      const rows = [];
      let sawAny = false;
      for (const n of listRegistryLockNames(cwd)) {
        rows.push(describeLock(lockPathFor(runPath(cwd, n)), n));
      }
      // Same reasoning as the registry loop above: checked by the LOCK's own
      // existence, not the legacy run file's -- a legacy run file removed out
      // from under its lock must not hide that lock from `unlock` either.
      const legacy = legacyPath(cwd);
      const legacyLockPath = lockPathFor(legacy);
      if (fs.existsSync(legacyLockPath)) {
        rows.push(describeLock(legacyLockPath, normalise(readJson(legacy)).feature || 'legacy'));
      }
      for (const row of rows) {
        if (!row.exists) continue;
        sawAny = true;
        process.stdout.write(`${row.path}\n`);
        process.stdout.write(`  feature: ${row.feature}\n`);
        process.stdout.write(`  holder pid: ${row.pid ?? '?'} (${row.alive ? 'alive' : 'dead or unparseable'})\n`);
        process.stdout.write(`  age: ${row.ageMs === null ? 'unknown' : `${Math.round(row.ageMs / 1000)}s`}\n`);
        if (row.clearable) process.stdout.write(`  run: rm ${shellQuoteSingle(row.path)}\n`);
      }
      if (!sawAny) process.stdout.write('no run-state locks present for this repo\n');
      break;
    }

    case 'get': {
      const stray = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1] === '--feature'));
      if (stray.length) {
        process.stderr.write(
          `run-state.cjs get takes no positional argument (got '${stray[0]}'). ` +
          `Use --feature ${stray[0]} to address one run, --all to list them, ` +
          'or no argument for this chat\'s run.\n');
        process.exit(2);
      }
      if (rest.includes('--all')) {
        process.stdout.write(`${JSON.stringify(listRuns(cwd), null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(resolve(cwd, featureFlag).state, null, 2)}\n`);
      }
      break;
    }

    default:
      process.stderr.write(
        'usage: run-state.cjs start|current|phase|branch|begin-brief|review-round|debug-round|block|finish-brief|finish|get|table|unlock\n',
      );
      process.exit(2);
  }
}

if (require.main === module) main();
// `load` is kept on the old signature — it answers "what run does this directory
// resolve to", which is what the callers that import it have always wanted.
const load = (cwd) => resolve(cwd).state;
/**
 * The run a given chat is driving in a given directory — what a hook needs.
 *
 * Hooks used to read <cwd>/docs/.run-state.json straight off the disk, which was
 * fine while a repository had exactly one run and wrong the moment it had two: every
 * chat's checkpoint and every subagent log line got stamped with whichever run the
 * file held. Going through the pointer is what makes those records belong to the
 * chat that produced them.
 */
const runFor = (cwd, session) => resolve(cwd, null, session).state;

module.exports = { load, statePath, resolve, runFor, listRuns, repoKey, tableRows, renderTable, REL };
