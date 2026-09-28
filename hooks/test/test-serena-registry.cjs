#!/usr/bin/env node
// Behavioural tests for the shared-Serena process registry.
// Run: node hooks/test/test-serena-registry.cjs
//
//   serena-registry.cjs — tracks one Serena server per repository root, keyed
//   by a hash of that root, so concurrent sessions in the same repo share a
//   server instead of each starting their own (the process sprawl this whole
//   effort exists to fix).
//
// House style: every MUST-fire paired with a MUST-NOT.
//
// CLAUDE_CONFIG_DIR is set to a fresh temp dir for every run in this file, so
// STATE_DIR (gate-lib.cjs) never points at the operator's real ~/.claude/state
// and this suite can never touch a live registry entry for one of the
// operator's actual Serena trees.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

const trash = [];
function freshConfigDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-registry-'));
  trash.push(d);
  return d;
}

// Each test that needs the registry module loads it under its own
// CLAUDE_CONFIG_DIR by setting the env var before require and deleting the
// module from the cache after -- gate-lib.cjs reads CLAUDE_CONFIG_DIR at
// import time into a top-level STATE_DIR constant, so a stale require would
// silently keep pointing every later test at the first temp dir.
function loadRegistry(configDir) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  delete require.cache[require.resolve(path.join(HOOKS, 'serena-registry.cjs'))];
  delete require.cache[require.resolve(path.join(HOOKS, 'gates', 'gate-lib.cjs'))];
  const mod = require(path.join(HOOKS, 'serena-registry.cjs'));
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
  return mod;
}

function tmpRepo(init = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-repo-'));
  trash.push(d);
  if (init) execFileSync('git', ['init', '-q', d]);
  return d;
}

// A real, exited child: its pid is guaranteed dead but was, briefly, a real
// process -- distinct from a made-up large integer, which could collide with
// something alive on a heavily loaded box.
function exitedPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
}

// A long-lived helper process this suite owns and always kills itself at the
// end -- never anything discovered on the system.
function spawnHelper(opts = {}) {
  const child = require('child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', ...opts },
  );
  return child;
}

// Every wait on a spawned helper in this file goes through this: an unbounded
// `new Promise((res) => p.on('exit', res))` hangs the whole suite instead of
// failing it if the child never exits (killed in a way that drops the event,
// a bug in the code under test that makes it spin forever holding the lock).
// A bounded wait turns that failure mode into a red run with a message,
// which is the whole point of a test suite -- a suite that can hang instead
// of failing is worse than no suite, because CI or a human just waits.
// Generous: this file runs several sections concurrently (lock-race,
// hold-race, dead-holder trials), and a dead-holder racer can queue behind
// fifteen others each holding the lock for 250 ms, so CPU contention and
// queueing can stretch one racer's wall-clock well past its own work. The bound
// exists to catch an actual hang (withLock never returning), not to assert
// a performance budget -- that is the runtime the suite as a whole reports.
const WAIT_TIMEOUT_MS = 60_000;
function waitExit(p, timeoutMs = WAIT_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error(`process pid=${p.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    p.on('exit', () => { clearTimeout(timer); res(); });
  });
}

// Polls for a file to appear, bounded -- used to wait for a helper process's
// own signal that it has reached a particular point (e.g. "inside withLock").
// If the helper dies (crashes, is killed) before writing the signal, an
// unbounded poll spins forever with no assertion ever failing; this rejects
// instead, so that failure mode shows up as a red run with a clear message.
function waitForFile(filePath, timeoutMs = WAIT_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(filePath)) return res();
      if (Date.now() > deadline) {
        return rej(new Error(`${filePath} did not appear within ${timeoutMs}ms`));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

// =============================================================================
console.log('serena-registry.cjs — repoKey');
{
  const configDir = freshConfigDir();
  const { repoKey } = loadRegistry(configDir);

  const repo = tmpRepo(true);
  const nested = path.join(repo, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const { root, key } = repoKey(nested);
  // repoKey resolves the winning root through fs.realpathSync (macOS routes
  // the system temp dir through /private), so the expectation here must be
  // the realpath too, not the as-given tmpRepo() path.
  check('a nested dir under .git resolves to the repo root', root, fs.realpathSync(repo));
  ok('the key is a stable non-empty string', typeof key === 'string' && key.length > 0);
  const again = repoKey(nested);
  check('the same dir always yields the same key', again.key, key);
}
{
  const configDir = freshConfigDir();
  const { repoKey } = loadRegistry(configDir);

  // Both markers at the same directory: this only proves .serena/project.yml
  // is recognised as a qualifying marker at all (alongside .git), not that
  // the NEAREST ancestor wins when the two markers sit at different depths.
  const repo = tmpRepo(true);
  fs.mkdirSync(path.join(repo, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.serena', 'project.yml'), 'language_servers: []\n');
  const nested = path.join(repo, 'src');
  fs.mkdirSync(nested, { recursive: true });
  const { root } = repoKey(nested);
  check('.serena/project.yml is recognised as a root marker', root, fs.realpathSync(repo));
}
{
  const configDir = freshConfigDir();
  const { repoKey } = loadRegistry(configDir);

  // Worktree shape: an outer checkout has .serena/project.yml, and a git
  // worktree nested inside it has its OWN .git (a worktree's .git is a file,
  // not a directory, but fs.existsSync is agnostic to that). The nearest
  // ancestor to `outer/wt/src` that has EITHER marker is `outer/wt` itself
  // (its .git), not `outer` (its .serena/project.yml) -- .git is nearer.
  // A two-pass implementation that searches all the way up for
  // .serena/project.yml first would wrongly return `outer` here, and a
  // worktree would then share the wrong repository's server.
  const outer = tmpRepo(false);
  fs.mkdirSync(path.join(outer, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(outer, '.serena', 'project.yml'), 'language_servers: []\n');
  const wt = path.join(outer, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  execFileSync('git', ['init', '-q', wt]);
  const nested = path.join(wt, 'src');
  fs.mkdirSync(nested, { recursive: true });
  const { root } = repoKey(nested);
  check('the nearer .git wins over a farther .serena/project.yml', root, fs.realpathSync(wt));
}
{
  const configDir = freshConfigDir();
  const { repoKey } = loadRegistry(configDir);

  // Mirror image: an outer .git, and a nested directory with its own
  // .serena/project.yml (a project config copied in, or a sub-project) but no
  // .git of its own. The nearest ancestor with either marker is the nested
  // directory, via its .serena/project.yml -- nearer than the outer .git.
  // A two-pass implementation that searches for .git first, all the way up,
  // would wrongly return the outer repo here.
  const outer = tmpRepo(true);
  const nested = path.join(outer, 'sub');
  fs.mkdirSync(path.join(nested, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.serena', 'project.yml'), 'language_servers: []\n');
  const deeper = path.join(nested, 'src');
  fs.mkdirSync(deeper, { recursive: true });
  const { root } = repoKey(deeper);
  check('the nearer .serena/project.yml wins over a farther .git', root, fs.realpathSync(nested));
}
{
  const configDir = freshConfigDir();
  const { repoKey } = loadRegistry(configDir);

  // No .git and no .serena/project.yml anywhere up the tree: the key is the
  // directory itself, not some accidental ancestor.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-bare-'));
  trash.push(bare);
  const nested = path.join(bare, 'x', 'y');
  fs.mkdirSync(nested, { recursive: true });
  const { root } = repoKey(nested);
  check('with neither marker present the dir itself is the root', root, fs.realpathSync(nested));
}

// =============================================================================
console.log('\nserena-registry.cjs — read/write/addClient/removeClient/liveClients');
{
  const configDir = freshConfigDir();
  const { read, write, addClient, removeClient, liveClients } = loadRegistry(configDir);

  const key = 'testkey1';
  check('reading a record that was never written is null', read(key), null);

  write(key, { root: '/tmp/repo', pid: 12345, port: 39121, startedAt: Date.now(), clients: [] });
  const rec = read(key);
  check('write then read round-trips the record', rec.pid, 12345);

  // 111 is a placeholder pid used only to assert the raw client LIST -- the
  // record legitimately holds pids that are not literally running right now.
  // The live-COUNT assertion below needs a pid that is actually alive
  // (process.pid, this very test runner), since removeClient's count is
  // defined in terms of liveClients/isAlive, not the raw list length.
  addClient(key, 111);
  addClient(key, process.pid);
  const afterAdd = read(key);
  check('addClient appends the pid', afterAdd.clients.includes(111) && afterAdd.clients.includes(process.pid), true);

  addClient(key, 111);
  const afterDup = read(key);
  check('addClient does not duplicate an already-registered pid', afterDup.clients.filter((p) => p === 111).length, 1);

  const remaining = removeClient(key, 111);
  const afterRemove = read(key);
  check('removeClient drops exactly that pid', afterRemove.clients.includes(111), false);
  check('removeClient leaves the other pid', afterRemove.clients.includes(process.pid), true);
  check('removeClient returns the live count after removal', remaining, 1);

  // liveClients filters against isAlive, not against the raw list -- a dead
  // pid left in the record by a SIGKILLed relay must not count as live.
  const dead = exitedPid();
  write(key, { root: '/tmp/repo', pid: 12345, port: 39121, startedAt: Date.now(), clients: [dead, process.pid] });
  const live = liveClients(read(key));
  check('liveClients drops a dead pid', live.includes(dead), false);
  check('liveClients keeps a live pid', live.includes(process.pid), true);
}

// =============================================================================
console.log('\nserena-registry.cjs — isAlive');
{
  const configDir = freshConfigDir();
  const { isAlive } = loadRegistry(configDir);
  check('the current process is alive', isAlive(process.pid), true);
  check('a pid from an already-exited child is not alive', isAlive(exitedPid()), false);
}

// A helper process is killed even when a later assertion in this file
// throws -- registered here so every async section below can push onto it
// and a single top-level catch guarantees cleanup runs regardless of which
// check failed. Never leaves a `node -e setInterval`-style orphan behind.
const liveHelpers = [];
// ChildProcess#kill signals only while Node still holds the child's handle,
// i.e. before its exit has been reaped. A bare process.kill(p.pid) after the
// child was reaped could reach an unrelated process that reused the pid.
function killHelper(p) {
  try { p.kill('SIGKILL'); } catch { /* already gone */ }
}
function killHelpers() {
  for (const p of liveHelpers) killHelper(p);
  liveHelpers.length = 0;
}
process.on('exit', killHelpers);

// Records a rejected wait (a bounded waitExit/waitForFile that timed out) as
// a failure and lets the suite carry on to its summary, instead of dying on
// an unhandled rejection with no count printed.
function recordFailure(label) {
  return (e) => { fail++; failures.push(`${label}: ${e.message}`); console.log(`  FAIL ${label}: ${e.message}`); };
}

// =============================================================================
console.log('\nserena-registry.cjs — withLock serialises two concurrent callers');
{
  const configDir = freshConfigDir();
  const { withLock } = loadRegistry(configDir);

  // Two callers race for the same lock key. If withLock only serialises
  // in-process, this proves nothing about the exclusive-create generation
  // file the plan calls for -- so both callers run as separate child
  // processes racing on the real filesystem, each appending its start and
  // end time to a shared log file. Serialisation means every interval in the
  // log is non-overlapping.
  const logFile = path.join(configDir, 'lock-log.json');
  fs.writeFileSync(logFile, '[]');
  const racer = path.join(configDir, 'racer.cjs');
  fs.writeFileSync(racer, `
    const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    const fs = require('fs');
    withLock('race-key', () => {
      const start = Date.now();
      // Busy-hold the lock briefly so a second racer started at nearly the
      // same instant has something to actually wait on.
      const until = start + 150;
      while (Date.now() < until) {}
      const end = Date.now();
      const log = JSON.parse(fs.readFileSync(${JSON.stringify(logFile)}, 'utf8'));
      log.push([start, end]);
      fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log));
    });
  `);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  const { spawn } = require('child_process');
  const p1 = spawn(process.execPath, [racer], { env });
  const p2 = spawn(process.execPath, [racer], { env });
  liveHelpers.push(p1, p2);
  const wait = waitExit;
  const lockRaceDone = Promise.all([wait(p1), wait(p2)]).then(() => {
    const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    check('both racers completed', log.length, 2);
    const [a, b] = log.sort((x, y) => x[0] - y[0]);
    ok('the two lock holds do not overlap', a && b && a[1] <= b[0]);
  });

  // =============================================================================
  console.log('\nserena-registry.cjs — withLock: a waiter does not enter while a live holder is inside');
  // A holder that legitimately keeps the lock for a while (BRIEF 2 spawns
  // Serena under this lock, and a cold `uvx` install can run past several
  // seconds) must not let a concurrent waiter in while it is still alive and
  // still working. The holder writes a signal file the instant it is inside
  // withLock, and the waiter is only started after that signal appears --
  // otherwise, if the holder were slow to start, the waiter could simply win
  // the race to acquire first and the test would prove nothing about waiting
  // at all. Both processes log their [start, end] interval; correctness
  // means the intervals never overlap.
  const holdLogFile = path.join(configDir, 'hold-log.json');
  fs.writeFileSync(holdLogFile, '[]');
  const signalFile = path.join(configDir, 'holder-inside.signal');
  const HOLD_MS = 400;
  const holder = path.join(configDir, 'holder.cjs');
  fs.writeFileSync(holder, `
    const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    const fs = require('fs');
    withLock('hold-key', () => {
      const start = Date.now();
      fs.writeFileSync(${JSON.stringify(signalFile)}, String(start));
      const until = start + ${HOLD_MS};
      while (Date.now() < until) {}
      const end = Date.now();
      const log = JSON.parse(fs.readFileSync(${JSON.stringify(holdLogFile)}, 'utf8'));
      log.push([start, end]);
      fs.writeFileSync(${JSON.stringify(holdLogFile)}, JSON.stringify(log));
    });
  `);
  const waiter = path.join(configDir, 'waiter.cjs');
  fs.writeFileSync(waiter, `
    const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    const fs = require('fs');
    withLock('hold-key', () => {
      const start = Date.now();
      const end = Date.now();
      const log = JSON.parse(fs.readFileSync(${JSON.stringify(holdLogFile)}, 'utf8'));
      log.push([start, end]);
      fs.writeFileSync(${JSON.stringify(holdLogFile)}, JSON.stringify(log));
    });
  `);
  const holdEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  const holderProc = spawn(process.execPath, [holder], { env: holdEnv });
  liveHelpers.push(holderProc);
  // Wait for the holder's own signal that it is inside withLock, rather than
  // a fixed delay guessing how long that takes -- bounded, so a holder that
  // dies (or a withLock that never enters fn) fails this test instead of
  // hanging the suite forever.
  const holdRaceDone = waitForFile(signalFile).then(() => {
    const waiterProc = spawn(process.execPath, [waiter], { env: holdEnv });
    liveHelpers.push(waiterProc);
    return Promise.all([wait(holderProc), wait(waiterProc)]);
  }).then(() => {
    const log = JSON.parse(fs.readFileSync(holdLogFile, 'utf8'));
    check('both the live holder and the waiter completed', log.length, 2);
    const [a, b] = log.sort((x, y) => x[0] - y[0]);
    ok('the waiter did not enter while the live holder was still inside', a && b && a[1] <= b[0]);
  });

  // =============================================================================
  console.log('\nserena-registry.cjs — withLock: dead-holder generation, many concurrent racers, zero overlap');
  // Reproduces the BRIEF 1 review finding directly: plant a generation file
  // (`0`) naming a pid that is already dead, backdated the way an abandoned
  // lock would be found in the wild, then start many real racer processes
  // at once. A check-then-unlink steal on the old single `<key>.lock` file
  // let two racers both land inside `fn` in exactly this shape (measured
  // directly against that code, planting `<key>.lock`: reliably several
  // overlaps per run at this file's parameters). The generation-directory
  // design must show zero overlaps across every trial, and every racer must
  // still complete (this also proves dead-holder recovery: with nothing
  // planted, nobody would ever pass generation 0 at all). A non-atomic
  // acquisition regresses the same way: linkSync swapped for copyFileSync
  // (see report) reliably produces overlaps at these parameters too. Every
  // racer's release also prunes, so the lock dir each trial leaves behind is
  // checked too: 16 racers through one key must leave only the last two
  // generations, never an orphan `.done`.
  const RACERS = 16;
  const TRIALS = 5;
  const HOLD_INSIDE_MS = 250;
  const raceKey = 'dead-holder-race';
  const racerScript = path.join(configDir, 'gen-racer.cjs');
  fs.writeFileSync(racerScript, `
    const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    const fs = require('fs');
    const logFile = process.argv[2];
    const go = Number(process.argv[3]);
    // Wait for a common start instant so every racer actually contends the
    // same planted generation together, rather than trickling in one at a
    // time and never overlapping by construction.
    while (Date.now() < go) {}
    withLock(${JSON.stringify(raceKey)}, () => {
      const start = Date.now();
      const until = start + ${HOLD_INSIDE_MS};
      while (Date.now() < until) {}
      const end = Date.now();
      fs.appendFileSync(logFile, JSON.stringify([process.pid, start, end]) + '\\n');
    });
  `);

  async function runDeadHolderTrial(trialIndex) {
    const trialDir = fs.mkdtempSync(path.join(configDir, `trial-${trialIndex}-`));
    trash.push(trialDir);
    const trialEnv = { ...process.env, CLAUDE_CONFIG_DIR: trialDir };
    const REGISTRY_DIR = path.join(trialDir, 'state', 'serena');
    const locksDir = path.join(REGISTRY_DIR, `${raceKey}.locks`);
    fs.mkdirSync(locksDir, { recursive: true });
    // Plant a dead-holder generation 0: a real, already-exited pid, aged the
    // way an abandoned lock is found in the wild.
    const dead = exitedPid();
    fs.writeFileSync(path.join(locksDir, '0'), String(dead));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(locksDir, '0'), old, old);

    const logFile = path.join(trialDir, 'race-log.json');
    fs.writeFileSync(logFile, '');
    // Spawning 16 Node processes itself takes real time; the barrier must be
    // far enough out that every racer has actually reached its `while
    // (Date.now() < go)` spin before the earliest one crosses it, or they
    // trickle in one at a time and never truly contend the planted lock
    // together.
    const go = Date.now() + 400;
    const procs = [];
    for (let i = 0; i < RACERS; i++) {
      const p = spawn(process.execPath, [racerScript, logFile, String(go)], { env: trialEnv, stdio: 'ignore' });
      procs.push(p);
      liveHelpers.push(p);
    }
    await Promise.all(procs.map((p) => wait(p)));
    for (const p of procs) liveHelpers.splice(liveHelpers.indexOf(p), 1);

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const intervals = lines.map((l) => JSON.parse(l)).sort((a, b) => a[1] - b[1]);
    let overlaps = 0;
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i][1] < intervals[i - 1][2]) overlaps++;
    }
    // Planted 0 plus one generation per racer: the last holder is RACERS,
    // and its release prunes everything below RACERS - 1. Anything else left
    // over -- an older generation, a `.done` without its numbered file, a tmp
    // file from acquisition -- is growth or an orphan pruning let through.
    const entries = fs.readdirSync(locksDir).sort();
    const expected = [`${RACERS - 1}`, `${RACERS - 1}.done`, `${RACERS}`, `${RACERS}.done`].sort();
    return { completed: intervals.length, overlaps, entries, entriesOk: JSON.stringify(entries) === JSON.stringify(expected) };
  }

  const deadHolderRaceDone = (async () => {
    let totalOverlaps = 0;
    let allCompleted = true;
    const badDirs = [];
    for (let t = 0; t < TRIALS; t++) {
      const { completed, overlaps, entries, entriesOk } = await runDeadHolderTrial(t);
      totalOverlaps += overlaps;
      if (completed !== RACERS) allCompleted = false;
      if (!entriesOk) badDirs.push(entries);
    }
    check(`every racer completed across ${TRIALS} trials of ${RACERS}`, allCompleted, true);
    check(`zero lock-hold overlaps across ${TRIALS} trials of ${RACERS} racers`, totalOverlaps, 0);
    check(`each trial's lock dir ends as only generations ${RACERS - 1} and ${RACERS}, no orphan .done or tmp`, badDirs, []);
  })();

  Promise.all([
    lockRaceDone.catch(recordFailure('withLock two-racer section')),
    holdRaceDone.catch(recordFailure('withLock live-holder section')),
    deadHolderRaceDone.catch(recordFailure('withLock dead-holder race section')),
  ]).then(() => {
    killHelpers();
    finishAsyncSection();
  });
}

// The lock tests above are async (real child processes); everything after
// them in this file must wait for both, or the summary at the bottom would
// print before their checks ran and this file would report success while red.
let asyncDone;
const asyncSectionDone = new Promise((res) => { asyncDone = res; });
function finishAsyncSection() { asyncDone(); }

asyncSectionDone.then(() => {
  // ===========================================================================
  console.log('\nserena-registry.cjs — listRecords');
  {
    const configDir = freshConfigDir();
    const { write, listRecords } = loadRegistry(configDir);
    write('k1', { root: '/tmp/repoA', pid: 1, port: 1, startedAt: Date.now(), clients: [] });
    write('k2', { root: '/tmp/repoB', pid: 2, port: 2, startedAt: Date.now(), clients: [] });
    const records = listRecords();
    check('listRecords returns every written key', Object.keys(records).sort(), ['k1', 'k2']);
    check('each entry keeps its own root', records.k1.root, '/tmp/repoA');
  }

  // ===========================================================================
  console.log('\nserena-registry.cjs — killTree');
  {
    const configDir = freshConfigDir();
    const { killTree, isAlive } = loadRegistry(configDir);

    // A child, and a GRANDCHILD started `detached: true` -- exactly how Serena
    // starts its language servers, in their own session so they do not share
    // the child's process group. A process-group kill (`process.kill(-pid)`)
    // never reaches a detached grandchild, because it has its own group; only
    // walking ppid finds it. This is the assertion the brief calls out by
    // name as the one that must be seen failing against a group-kill first.
    const helperScript = path.join(configDir, 'tree-helper.cjs');
    fs.writeFileSync(helperScript, `
      const { spawn } = require('child_process');
      const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      gc.unref();
      process.stdout.write(String(gc.pid) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const child = require('child_process').spawn(process.execPath, [helperScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    liveHelpers.push(child);
    let grandchildPid = null;
    // Bounded: if the helper script never prints a grandchild pid (a broken
    // spawn, stdout never flushed), this suite must go red with a clear
    // timeout message rather than hang forever with no signal at all.
    const gotGrandchild = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('grandchild pid never arrived on stdout within 5000ms')), 5000);
      child.stdout.on('data', (buf) => {
        if (grandchildPid === null) {
          grandchildPid = parseInt(String(buf).trim(), 10);
          clearTimeout(timer);
          res();
        }
      });
    });

    const killTreeDone = gotGrandchild.then(() => new Promise((res) => {
      // Give the OS a moment to register both processes before we collect the
      // tree -- collection itself is synchronous and instantaneous once here.
      setTimeout(() => {
        // The spawned child (and, once discovered, the grandchild) must be
        // killed even if an assertion below throws -- this suite's own
        // liveHelpers/killHelpers cleanup only reaches `child` (the direct
        // spawn); the grandchild is a SEPARATE pid the parent never tracked,
        // so it needs its own guaranteed cleanup here.
        try {
          ok('the child is alive before killTree', isAlive(child.pid));
          ok('the detached grandchild is alive before killTree', isAlive(grandchildPid));

          killTree(child.pid);

          // killTree includes its own grace-period wait, so by the time it
          // returns both pids must already be gone.
          ok('the child is dead after killTree', !isAlive(child.pid));
          ok('the detached grandchild is dead after killTree', !isAlive(grandchildPid));
        } finally {
          liveHelpers.splice(liveHelpers.indexOf(child), 1);
          try { if (isAlive(child.pid)) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
          try { if (grandchildPid && isAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
        }
        res();
      }, 200);
    })).catch((e) => {
      fail++; failures.push(`killTree grandchild setup: ${e.message}`);
      liveHelpers.splice(liveHelpers.indexOf(child), 1);
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { if (grandchildPid) process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone or none */ }
    });

    killTreeDone.then(runHardeningTests);
  }
});

// ===========================================================================
// BRIEF 5 hardening -- run after killTree's own async section so this file
// keeps one linear pipeline instead of two independent completion paths.
function runHardeningTests() {
  console.log('\nserena-registry.cjs — killTree refuses pid <= 1');
  {
    // Never pass invalid PIDs to a module with real OS access, even for a
    // red test: a missing guard would kill unrelated applications.
    require('./test-serena-pid-safety.cjs').runPidSafetyTests(
      fs.readFileSync(path.join(HOOKS, 'serena-registry.cjs'), 'utf8'), check,
    );
  }

  console.log('\nserena-registry.cjs — killRecordServer refuses on identity mismatch');
  {
    const configDir = freshConfigDir();
    const { killRecordServer, captureIdentity, isAlive } = loadRegistry(configDir);

    const helper = spawnHelper();
    liveHelpers.push(helper);
    const waitForPid = (pid, timeoutMs) => new Promise((res, rej) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        try {
          const r = spawnSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf8' });
          if (r.status === 0 && r.stdout.trim()) return res();
        } catch { /* retry */ }
        if (Date.now() > deadline) return rej(new Error(`pid ${pid} never appeared in ps`));
        setTimeout(poll, 20);
      };
      poll();
    });

    waitForPid(helper.pid, 5000).then(() => {
      // A record whose captured identity does NOT match the live process at
      // that pid -- the shape a reused pid takes after a reboot. killTree
      // must refuse rather than kill whatever now holds that pid number.
      const mismatched = { root: '/tmp/x', pid: helper.pid, port: 1, startedAt: 0, clients: [], identity: 'definitely-not-the-real-command-line' };
      // Checked by message, not just "something threw" -- a bare try/catch
      // cannot tell a correct refusal apart from killRecordServer simply not
      // existing (or crashing for an unrelated reason), which would let a
      // missing implementation pass this exact assertion.
      let refused = false, refusalMessage = '';
      try {
        killRecordServer(mismatched);
      } catch (e) {
        refused = true;
        refusalMessage = e.message;
      }
      ok('killRecordServer refuses when the live process does not match the recorded identity', refused);
      ok('the refusal names identity/mismatch, not an unrelated crash', /identity|mismatch/i.test(refusalMessage));
      ok('the mismatched-identity process is left alive', isAlive(helper.pid));

      // The positive case: identity captured from the SAME live process at
      // spawn time matches, and killRecordServer is allowed to proceed.
      const identity = captureIdentity(helper.pid);
      ok('captureIdentity returns a non-empty identity for a live pid', typeof identity === 'string' && identity.length > 0);
      const matched = { root: '/tmp/x', pid: helper.pid, port: 1, startedAt: 0, clients: [], identity };
      killRecordServer(matched);
      ok('killRecordServer kills when the live process matches the recorded identity', !isAlive(helper.pid));

      runRepoKeyRealpathTests();
    }).catch((e) => {
      fail++; failures.push(`killRecordServer identity setup: ${e.message}`);
      runRepoKeyRealpathTests();
    });
  }
}

function runRepoKeyRealpathTests() {
  console.log('\nserena-registry.cjs — repoKey resolves symlinks to one key');
  {
    const configDir = freshConfigDir();
    const { repoKey } = loadRegistry(configDir);

    const real = tmpRepo(true);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-link-'));
    trash.push(linkParent);
    const link = path.join(linkParent, 'link-to-repo');
    fs.symlinkSync(real, link, 'dir');

    const viaReal = repoKey(real);
    const viaLink = repoKey(link);
    check('a symlinked path to the same repo yields the same key as the real path', viaLink.key, viaReal.key);
    check('the resolved root is the realpath, not the symlink path', viaLink.root, fs.realpathSync(real));
  }

  console.log('\nserena-registry.cjs — write is atomic (temp file + rename)');
  {
    const configDir = freshConfigDir();
    const { write, read } = loadRegistry(configDir);
    const key = 'atomic-write-key';

    // Many concurrent writers racing on the same key: a non-atomic write
    // (truncate then write bytes) lets a reader observe a half-written file
    // mid-race. Every write must either be fully the old content or fully
    // the new content, never a torn mix that fails to parse.
    const writerScript = path.join(configDir, 'write-racer.cjs');
    fs.writeFileSync(writerScript, `
      const { write } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
      const key = process.argv[2];
      const payload = process.argv[3];
      // Write repeatedly for a short window so a slow reader has many chances
      // to observe a write in progress if it is not atomic.
      const until = Date.now() + 300;
      while (Date.now() < until) {
        write(key, { root: '/tmp/repo', pid: 1, port: 1, startedAt: Date.now(), clients: [], pad: payload });
      }
    `);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    const { spawn } = require('child_process');
    const writers = [
      spawn(process.execPath, [writerScript, key, 'a'.repeat(500)], { env }),
      spawn(process.execPath, [writerScript, key, 'b'.repeat(900)], { env }),
    ];
    for (const w of writers) liveHelpers.push(w);
    const waitProc = waitExit;

    let readerAlive = true;
    let observedTorn = false;
    let reads = 0;
    const recordFile = path.join(configDir, 'state', 'serena', `${key}.json`);
    const readerTimer = setInterval(() => {
      if (!readerAlive) return;
      reads++;
      // Before either writer's first write() call has completed, the file
      // legitimately does not exist yet -- ENOENT here is the reader losing
      // the race to see ANY write, not evidence of a torn one, and must not
      // be conflated with the failure this test actually watches for: a
      // read that lands mid-write and gets bytes that fail to parse.
      let raw;
      try {
        raw = fs.readFileSync(recordFile, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return;
        observedTorn = true;
        return;
      }
      try {
        if (raw.length) JSON.parse(raw); // throws on a torn/partial write
      } catch {
        observedTorn = true;
      }
    }, 2);

    Promise.all(writers.map((p) => waitProc(p))).then(() => {
      readerAlive = false;
      clearInterval(readerTimer);
      for (const w of writers) liveHelpers.splice(liveHelpers.indexOf(w), 1);
      ok('at least one read was attempted during the concurrent writes', reads > 0);
      ok('no reader ever observed a torn/partial write', !observedTorn);
      ok('the record left behind still parses', !!read(key));
    }).catch(recordFailure('atomic write section')).then(() => {
      readerAlive = false;
      clearInterval(readerTimer);
      runBrief5FollowupTests();
    });
  }
}

function runBrief5FollowupTests() {
  // Lock directory of `key` under a config dir this suite created, so the
  // tests below can inspect exactly which generation files withLock leaves.
  const lockDirOf = (configDir, key) => path.join(configDir, 'state', 'serena', `${key}.locks`);
  const lockEntries = (dir) => fs.readdirSync(dir).sort();

  // Makes one fs call throw for paths ending in `.done`, for the duration of
  // `body` only. The registry reads `fs.writeFileSync`/`fs.linkSync` off the
  // shared `fs` module object at call time, so patching the property here is
  // seen by withLock without any hook in the code under test -- and nothing
  // outside the `.done` path is affected.
  function withDoneFailing(fnNames, body) {
    const saved = {};
    for (const name of fnNames) {
      saved[name] = fs[name];
      const real = fs[name];
      fs[name] = (...args) => {
        const target = String(name === 'linkSync' ? args[1] : args[0]);
        if (target.endsWith('.done')) {
          throw Object.assign(new Error(`EACCES: sabotaged ${name} ${target}`), { code: 'EACCES' });
        }
        return real(...args);
      };
    }
    try { return body(); } finally { Object.assign(fs, saved); }
  }

  console.log('\nserena-registry.cjs — withLock is reentrant for the same process');
  {
    // addClient/removeClient each take the lock themselves; a caller wrapping
    // one in its own withLock(key, ...) for the SAME key must not wait on the
    // generation it is itself sitting inside. The nested calls carry a short
    // timeout so a non-reentrant withLock fails this in ~2 s instead of
    // waiting out the 30 s default.
    const configDir = freshConfigDir();
    const { withLock, write, addClient, read } = loadRegistry(configDir);
    const key = 'reentrant-key';
    write(key, { root: '/tmp/reentrant', pid: 1, port: 1, startedAt: Date.now(), clients: [] });

    let inner = false, err = null;
    try {
      withLock(key, () => {
        withLock(key, () => { inner = true; }, { timeoutMs: 2000 });
        addClient(key, 999); // takes withLock(key, ...) again, internally
      }, { timeoutMs: 2000 });
    } catch (e) { err = e; }
    check('a nested withLock on a key this process holds does not throw', err && err.message, null);
    ok('the nested withLock body ran', inner);
    ok('the nested addClient call took effect', (read(key) || { clients: [] }).clients.includes(999));
    // The nested (reentrant) call must not release the outer generation: only
    // the outermost call writes `.done`, exactly once.
    check('only the outer acquisition left a generation behind', lockEntries(lockDirOf(configDir, key)), ['0', '0.done']);
  }

  console.log('\nserena-registry.cjs — withLock times out on a hung live holder');
  {
    // A generation naming a pid that is alive and never releases must make
    // withLock throw after timeoutMs. Run in a child process under a hard
    // spawnSync timeout: a withLock with no working timeout spins forever
    // synchronously, and inside this process that would hang the suite
    // rather than fail it. The planted holder is the child's own pid -- alive
    // for as long as it waits, and never a withLock holder of this key.
    const configDir = freshConfigDir();
    const script = path.join(configDir, 'hung-holder.cjs');
    fs.writeFileSync(script, `
      const fs = require('fs');
      const path = require('path');
      const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'state', 'serena', 'hung-holder-key.locks');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '0'), String(process.pid));
      const start = Date.now();
      let message = null, entered = false;
      try { withLock('hung-holder-key', () => { entered = true; }, { timeoutMs: 300 }); } catch (e) { message = e.message; }
      process.stdout.write(JSON.stringify({ message, entered, elapsed: Date.now() - start }));
    `);
    const r = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8', timeout: 10_000,
    });
    const hung = !!r.error || r.signal !== null;
    ok(`the child finished inside 10 s (error=${r.error && r.error.code}, signal=${r.signal})`, !hung);
    let out = {};
    try { out = JSON.parse(r.stdout); } catch { /* reported by the checks below */ }
    ok('withLock threw a timeout on a live holder that never releases', /timed out/i.test(out.message || ''));
    check('fn never ran without the lock', out.entered, false);
    ok('it gave up close to timeoutMs, not much later', typeof out.elapsed === 'number' && out.elapsed >= 300 && out.elapsed < 3000);
  }

  console.log('\nserena-registry.cjs — withLock rejects an async fn loudly, and releases the generation anyway');
  {
    // fn must be synchronous: returning a promise would release the lock the
    // moment the promise is handed back, and the real async work would run
    // unlocked.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'async-fn-key';

    let threw = null;
    try {
      withLock(key, async () => { /* never awaited by withLock */ });
    } catch (e) {
      threw = e;
    }
    ok('withLock throws when fn returns a thenable', threw instanceof TypeError);
    ok('the error names the synchronous-only contract', /synchronous/i.test(threw ? threw.message : ''));

    let ranAfter = false;
    try { withLock(key, () => { ranAfter = true; }, { timeoutMs: 2000 }); } catch { /* reported below */ }
    ok('a later synchronous withLock on the same key still acquires it', ranAfter);
  }

  console.log('\nserena-registry.cjs — a failed .done write never masks fn\'s outcome, and never leaves the generation held');
  {
    // Only the `.done` write is sabotaged (acquisition's own tmp write and
    // link are untouched), so this isolates the release path.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'done-write-fails-key';
    const dir = lockDirOf(configDir, key);

    let result, err = null;
    try {
      result = withDoneFailing(['writeFileSync'], () => withLock(key, () => 'fn-succeeded', { timeoutMs: 2000 }));
    } catch (e) { err = e; }
    check('withLock does not throw the release error', err && err.message, null);
    check('fn\'s successful result is returned', result, 'fn-succeeded');
    ok('the generation is released (0.done exists) despite the failed write', fs.existsSync(path.join(dir, '0.done')));

    let ranAfter = false;
    try { withLock(key, () => { ranAfter = true; }, { timeoutMs: 2000 }); } catch { /* reported below */ }
    ok('a later withLock on the same key acquires it (not wedged)', ranAfter);

    // fn's own error wins over a release failure, too.
    let thrown = null;
    try {
      withDoneFailing(['writeFileSync'], () => withLock(key, () => { throw new Error('fn-own-error'); }, { timeoutMs: 2000 }));
    } catch (e) { thrown = e; }
    check('when fn throws, its own error is what the caller sees', thrown && thrown.message, 'fn-own-error');
  }
  {
    // Every way to create `mine.done` refused (the directory accepts no new
    // entries). Nothing can release the generation while that lasts, but fn's
    // result must still come back, the failure must be visible, and the same
    // process must release it on its next withLock for the key once the
    // directory accepts writes again -- not stay wedged for its lifetime.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'done-write-unrecoverable-key';
    const dir = lockDirOf(configDir, key);

    const originalError = console.error;
    let logged = '';
    console.error = (...a) => { logged += a.join(' '); };
    let result, err = null;
    try {
      result = withDoneFailing(['writeFileSync', 'linkSync'], () => withLock(key, () => 'fn-still-succeeded', { timeoutMs: 2000 }));
    } catch (e) { err = e; } finally { console.error = originalError; }
    check('withLock does not throw when release is impossible', err && err.message, null);
    check('fn\'s result is returned when release is impossible', result, 'fn-still-succeeded');
    ok('the release failure is logged, not silently dropped', /generation 0/.test(logged));
    check('the generation is still held while the directory refuses writes', lockEntries(dir), ['0']);

    let ranAfter = false, afterErr = null;
    try { withLock(key, () => { ranAfter = true; }, { timeoutMs: 2000 }); } catch (e) { afterErr = e; }
    check('the next withLock in this process releases it and acquires', afterErr && afterErr.message, null);
    ok('the next withLock body ran', ranAfter);
    check('both generations end released', lockEntries(dir), ['0', '0.done', '1', '1.done']);
  }

  console.log('\nserena-registry.cjs — pruning keeps the lock dir bounded and leaves no orphan .done');
  {
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'prune-bounds-key';
    const dir = lockDirOf(configDir, key);
    const seenInside = [];
    for (let i = 0; i < 10; i++) {
      withLock(key, () => { seenInside.push(lockEntries(dir)); }, { timeoutMs: 2000 });
    }
    // Inside generation g, g-1's release has already pruned everything below
    // g-2, so the directory holds g-2 and g-1 (each with its .done) and g:
    // at most five entries, and no tmp file left over from acquisition.
    ok('no acquisition ever saw more than g-2..g on disk', seenInside.every((e) => e.length <= 5));
    check('after 10 acquisitions only the last two generations remain', lockEntries(dir), ['8', '8.done', '9', '9.done']);
  }

  console.log('\nserena-registry.cjs — a stalled racer cannot re-create a pruned generation and enter fn');
  {
    // The review's interleaving, driven deterministically. The caller reads
    // maxGeneration = -1 (empty dir) and computes next = 0, then stalls just
    // before its linkSync. While it is stalled:
    //   - three real in-process acquisitions take generations 0, 1 and 2;
    //     generation 2's release prunes below 1, so `0` and `0.done` are gone
    //     and the name `0` is linkable again;
    //   - generation 3 is held by a live process this test spawned (no
    //     `3.done`), which releases it ~1 s later.
    // The stalled caller's link of `0` then succeeds. It must not run fn
    // while generation 3 is held, must leave no `0`/`0.done` behind, and must
    // then take the real frontier (4) once 3 is released.
    //
    // The in-process acquisitions inside the hook are real, not reentrant:
    // the outer call has not acquired anything yet when the hook runs.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'stale-racer-key';
    const dir = lockDirOf(configDir, key);
    fs.mkdirSync(dir, { recursive: true });

    const holderScript = path.join(configDir, 'gen3-holder.cjs');
    fs.writeFileSync(holderScript, `
      const fs = require('fs');
      const dir = process.argv[2];
      // Wait until the test has planted generation 3 naming this pid, hold it
      // for a second, then release it the way withLock does: write 3.done.
      const until = Date.now() + 10000;
      const poll = () => {
        if (fs.existsSync(dir + '/3')) return setTimeout(() => { fs.writeFileSync(dir + '/3.done', ''); process.exit(0); }, 1000);
        if (Date.now() > until) process.exit(3);
        setTimeout(poll, 5);
      };
      poll();
    `);
    const holderProc = require('child_process').spawn(process.execPath, [holderScript, dir], { stdio: 'ignore' });
    liveHelpers.push(holderProc);

    let hookRan = false;
    const stallHook = (next) => {
      if (hookRan || next !== 0) return;
      hookRan = true;
      for (let g = 0; g < 3; g++) withLock(key, () => {}, { timeoutMs: 2000 });
      fs.writeFileSync(path.join(dir, '3'), String(holderProc.pid));
    };

    let entries = null, gen3Released = null, err = null;
    try {
      withLock(key, () => {
        entries = lockEntries(dir);
        gen3Released = fs.existsSync(path.join(dir, '3.done'));
      }, { timeoutMs: 10_000, _stallBeforeLinkForTest: stallHook });
    } catch (e) { err = e; }

    ok('the stall hook actually fired on next = 0', hookRan);
    check('withLock completed', err && err.message, null);
    check('fn ran only after generation 3 was released', gen3Released, true);
    ok('the stale link of the pruned name 0 was removed before fn ran', entries && !entries.includes('0'));
    ok('no 0.done was created for the stale acquisition', entries && !entries.includes('0.done'));
    check('the caller acquired the real frontier and pruning kept only 3..4', lockEntries(dir), ['3', '3.done', '4', '4.done']);

    liveHelpers.splice(liveHelpers.indexOf(holderProc), 1);
    killHelper(holderProc);
  }

  runBrief6Tests();
  runBrief7Tests()
    .catch(recordFailure('BRIEF 7 section'))
    .then(runBrief9Tests)
    .catch(recordFailure('BRIEF 9 section'))
    .then(finishHardeningSection);
}

// Evaluates the registry source in a `vm` context whose process and
// subprocess capabilities only record the call and throw -- the same pattern
// as test-serena-pid-safety.cjs. Any test that exercises killRecordServer or
// killTree with an input that must be refused runs here, so a missing
// refusal shows up as a recorded call, never as a signal to a real process.
//
// `identityLookup`, when given, answers the identity lookup alone (`ps -o
// lstart=,command=`, or PowerShell on win32) with the spawnSync result it
// returns. Every other spawnSync -- the process table killTree walks,
// taskkill -- stays forbidden, and so does process.kill.
function loadRegistryInVm(platform, { identityLookup } = {}) {
  const source = fs.readFileSync(path.join(HOOKS, 'serena-registry.cjs'), 'utf8');
  const vm = require('vm');
  const calls = [];
  const forbidden = (name) => (...args) => {
    calls.push([name, ...args]);
    throw new Error(`Unexpected OS operation: ${name}`);
  };
  const isIdentityLookup = (cmd, args) => cmd === 'powershell'
    || (cmd === 'ps' && Array.isArray(args) && args.includes('lstart=,command='));
  const spawnSync = identityLookup
    ? (cmd, args, ...rest) => {
      if (!isIdentityLookup(cmd, args)) return forbidden('spawnSync')(cmd, args, ...rest);
      calls.push(['identity lookup', cmd]);
      return identityLookup();
    }
    : forbidden('spawnSync');
  const module = { exports: {} };
  const dependencies = {
    child_process: { spawnSync },
    crypto: {}, fs: {}, os: {}, path,
    './gates/gate-lib.cjs': { STATE_DIR: '/mock-state' },
  };
  const context = vm.createContext({
    module,
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import: ${name}`);
      return dependencies[name];
    },
    process: { platform, pid: 500, env: {}, kill: forbidden('kill') },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  const call = (fnName, arg) => {
    calls.length = 0;
    context.callArg = arg;
    let error = null;
    try {
      vm.runInContext(`module.exports.${fnName}(callArg)`, context, { timeout: 1000 });
    } catch (e) { error = e; }
    return { error, calls: calls.slice() };
  };
  return { call };
}

// Replaces `fs[name]` with `impl(real, ...args)` for the duration of `body`.
// The registry reads fs functions off the shared module object at call time,
// so this reaches the code under test without any hook in it.
function withFsPatched(patches, body) {
  const saved = {};
  for (const [name, impl] of Object.entries(patches)) {
    saved[name] = fs[name];
    const real = fs[name];
    fs[name] = (...args) => impl(real, ...args);
  }
  try { return body(); } finally { Object.assign(fs, saved); }
}

function runBrief6Tests() {
  const lockDirOf = (configDir, key) => path.join(configDir, 'state', 'serena', `${key}.locks`);
  const lockEntries = (dir) => fs.readdirSync(dir).sort();

  console.log('\nserena-registry.cjs — captureIdentity does not depend on the caller\'s locale or timezone');
  {
    // The relay captures identity at spawn and the reaper compares at kill
    // time, from different processes that may run under different LC_ALL/TZ.
    // `ps`'s lstart is printed in local time and in the locale's date format,
    // so without a pinned environment the two never agree and the reaper
    // refuses forever. Only `ps` runs here, on this test's own pid.
    const configDir = freshConfigDir();
    const { captureIdentity } = loadRegistry(configDir);
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    const under = (env) => {
      Object.assign(process.env, env);
      try { return captureIdentity(process.pid); } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    };
    const a = under({ TZ: 'Pacific/Kiritimati', LC_ALL: 'nl_NL.UTF-8' });
    const b = under({ TZ: 'America/Los_Angeles', LC_ALL: 'C' });
    ok('identity is captured at all', a.length > 0 && b.length > 0);
    check('the same process has the same identity under a different TZ and LC_ALL', a, b);
  }

  console.log('\nserena-registry.cjs — killRecordServer validates rec.pid before looking anything up (vm stub, no OS access)');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { call } = loadRegistryInVm(platform);
    // On win32 the pid is interpolated into a PowerShell -Filter, so a
    // string pid is an injection, not just a wrong number.
    for (const pid of [0, 1, -1, 1.5, NaN, Infinity, undefined, null, '2', '1" or ProcessId>0 or "', Number.MAX_SAFE_INTEGER + 1]) {
      const { error, calls } = call('killRecordServer', { pid, identity: 'recorded-identity' });
      const label = `${platform}: killRecordServer with pid ${typeof pid === 'string' ? JSON.stringify(pid) : String(pid)}`;
      check(`${label} is refused by validation`, error && error.name, 'RangeError');
      check(`${label} performs no OS operation`, calls.map((c) => c[0]), []);
    }
    // A valid pid must reach the identity lookup, so a blanket refusal
    // cannot pass the checks above.
    const { calls } = call('killRecordServer', { pid: 12345, identity: 'recorded-identity' });
    check(`${platform}: a valid pid reaches the (stubbed) identity lookup`, calls[0] && calls[0][0], 'spawnSync');
  }

  console.log('\nserena-registry.cjs — killRecordServer refuses a record without an identity (vm stub, no OS access)');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { call } = loadRegistryInVm(platform);
    // identity '' is the dangerous one: captureIdentity returns '' for a pid
    // that is not running, so comparing '' to '' would "match" a dead pid
    // and go on to kill whatever reuses it.
    const cases = [
      ['no identity field', { pid: 12345 }],
      ['identity ""', { pid: 12345, identity: '' }],
      ['identity null', { pid: 12345, identity: null }],
      ['a non-string identity', { pid: 12345, identity: 42 }],
      ['no record at all', null],
    ];
    for (const [what, rec] of cases) {
      const { error, calls } = call('killRecordServer', rec);
      check(`${platform}: ${what} is refused before any OS operation`, calls.map((c) => c[0]), []);
      ok(`${platform}: ${what} is refused for the missing identity`, error && /identity/i.test(error.message));
    }
  }

  console.log('\nserena-registry.cjs — a reentrant withLock rejects an async fn too');
  {
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'reentrant-async-key';
    let innerErr = null, outerErr = null;
    try {
      withLock(key, () => {
        try { withLock(key, async () => {}, { timeoutMs: 2000 }); } catch (e) { innerErr = e; }
      }, { timeoutMs: 2000 });
    } catch (e) { outerErr = e; }
    ok('the nested withLock throws when fn returns a thenable', innerErr instanceof TypeError);
    ok('the error names the synchronous-only contract', /synchronous/i.test(innerErr ? innerErr.message : ''));
    check('the outer withLock itself completed', outerErr && outerErr.message, null);
    check('the outer generation was released exactly once', lockEntries(lockDirOf(configDir, key)), ['0', '0.done']);
  }

  console.log('\nserena-registry.cjs — write removes its temp file when the rename fails');
  {
    const configDir = freshConfigDir();
    const { write } = loadRegistry(configDir);
    const registryDir = path.join(configDir, 'state', 'serena');
    let err = null;
    withFsPatched({
      renameSync: () => { throw Object.assign(new Error('EACCES: sabotaged renameSync'), { code: 'EACCES' }); },
    }, () => {
      try { write('rename-fails-key', { root: '/tmp/x', pid: 1, port: 1, startedAt: 0, clients: [] }); } catch (e) { err = e; }
    });
    ok('write still reports the rename failure', err && /sabotaged renameSync/.test(err.message));
    check('no temp file is left behind in the registry dir', fs.readdirSync(registryDir), []);
  }

  console.log('\nserena-registry.cjs — a failed post-link frontier check backs out instead of wedging the key');
  {
    // readdir fails (EMFILE) right after this process linked generation 0,
    // so withLock cannot tell whether it holds the frontier. It must not run
    // fn, and must not leave generation 0 held with no `.done` and nothing
    // remembering it: the next withLock in this process has to get through.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'postlink-check-fails-key';
    const dir = lockDirOf(configDir, key);
    let linked = false, entered = false, err = null;
    const originalError = console.error;
    console.error = () => {};
    try {
      withFsPatched({
        linkSync: (real, ...args) => {
          const r = real(...args);
          if (/[/\\]\d+$/.test(String(args[1]))) linked = true;
          return r;
        },
        readdirSync: (real, ...args) => {
          if (linked && String(args[0]) === dir) {
            throw Object.assign(new Error('EMFILE: sabotaged readdirSync'), { code: 'EMFILE' });
          }
          return real(...args);
        },
      }, () => {
        try { withLock(key, () => { entered = true; }, { timeoutMs: 2000 }); } catch (e) { err = e; }
      });
    } finally { console.error = originalError; }
    ok('the frontier check really failed after a link', linked);
    ok('withLock surfaces the check failure', err && /EMFILE/.test(err.message));
    check('fn was not entered without knowing it holds the lock', entered, false);

    let ranAfter = false, afterErr = null;
    try { withLock(key, () => { ranAfter = true; }, { timeoutMs: 2000 }); } catch (e) { afterErr = e; }
    check('the next withLock in this process acquires (the key is not wedged)', afterErr && afterErr.message, null);
    ok('the next withLock body ran', ranAfter);
    check('both generations end released', lockEntries(dir), ['0', '0.done', '1', '1.done']);
  }

  console.log('\nserena-registry.cjs — the unreleased retry never creates a .done for a generation that is gone');
  {
    // Generation 0 is left unreleased (every way to create 0.done refused),
    // then the lock dir is wiped. Re-creating `0.done` on the retry would make
    // the next live holder of the reused name `0` look free to every waiter.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'unreleased-wiped-key';
    const dir = lockDirOf(configDir, key);
    const refuseDone = (target) => {
      if (String(target).endsWith('.done')) throw Object.assign(new Error(`EACCES: sabotaged ${target}`), { code: 'EACCES' });
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      withFsPatched({
        writeFileSync: (real, ...args) => { refuseDone(args[0]); return real(...args); },
        linkSync: (real, ...args) => { refuseDone(args[1]); return real(...args); },
      }, () => withLock(key, () => {}, { timeoutMs: 2000 }));
    } finally { console.error = originalError; }
    check('generation 0 was left unreleased', lockEntries(dir), ['0']);

    fs.rmSync(dir, { recursive: true, force: true });
    let insideEntries = null, err = null;
    try { withLock(key, () => { insideEntries = lockEntries(dir); }, { timeoutMs: 2000 }); } catch (e) { err = e; }
    check('the next withLock completed', err && err.message, null);
    check('while this process holds generation 0 there is no 0.done making it look free', insideEntries, ['0']);
  }

  console.log('\nserena-registry.cjs — pruning removes tmp files of dead acquirers, never a live one\'s');
  {
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'tmp-prune-key';
    const dir = lockDirOf(configDir, key);
    fs.mkdirSync(dir, { recursive: true });
    const dead = exitedPid();
    const deadTmp = `tmp.${dead}.deadbeef`;
    // A live acquirer's tmp is about to be linked; deleting it would make
    // that acquirer's linkSync fail with ENOENT.
    const liveTmp = `tmp.${process.pid}.cafebabe`;
    fs.writeFileSync(path.join(dir, deadTmp), String(dead));
    fs.writeFileSync(path.join(dir, liveTmp), String(process.pid));
    withLock(key, () => {}, { timeoutMs: 2000 });
    const entries = lockEntries(dir);
    check('a crashed acquirer\'s tmp file is pruned', entries.includes(deadTmp), false);
    check('a live acquirer\'s tmp file is kept', entries.includes(liveTmp), true);
  }

  console.log('\nserena-registry.cjs — the lock\'s poll path spawns no process');
  {
    // Every waiter polls every POLL_MS; a `ps` per poll is one process spawn
    // per waiter per 20 ms. The stub records and returns a failed result
    // without running anything. The registry destructures spawnSync at load,
    // so the stub is in place only while it loads.
    const cp = require('child_process');
    const spawned = [];
    const realSpawnSync = cp.spawnSync;
    const configDir = freshConfigDir();
    cp.spawnSync = (cmd, args) => { spawned.push([cmd, ...(args || [])].join(' ')); return { status: 1, stdout: '', stderr: '' }; };
    let withLock;
    try { ({ withLock } = loadRegistry(configDir)); } finally { cp.spawnSync = realSpawnSync; }
    // Generation 0 names this (live) process and is never released, so
    // withLock polls until its timeout.
    const key = 'poll-no-spawn-key';
    const dir = lockDirOf(configDir, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0'), String(process.pid));
    let err = null;
    try { withLock(key, () => {}, { timeoutMs: 200 }); } catch (e) { err = e; }
    ok('withLock polled until its timeout', err && /^withLock\(.*timed out after/.test(err.message));
    check('no process was spawned while polling', spawned, []);
  }

  console.log('\nserena-registry.cjs — the timeout also bounds the retry-without-waiting paths');
  {
    // Both `continue` paths retry immediately: losing the link race (EEXIST)
    // and linking a name below the frontier. The test hook makes every
    // attempt hit one of them. A loop that checks the deadline only while
    // waiting on a live holder never times out here; the hook gives up after
    // 3 s so a missing check fails this test instead of hanging the suite.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    for (const [label, plant] of [
      ['losing the link race', (dir, next) => {
        fs.writeFileSync(path.join(dir, String(next)), String(process.pid));
        fs.writeFileSync(path.join(dir, `${next}.done`), '');
      }],
      ['linking a stale name', (dir, next) => {
        fs.writeFileSync(path.join(dir, String(next + 1)), String(process.pid));
        fs.writeFileSync(path.join(dir, `${next + 1}.done`), '');
      }],
    ]) {
      const key = `continue-timeout-${label.replace(/\W+/g, '-')}`;
      const dir = lockDirOf(configDir, key);
      const start = Date.now();
      let hookCalls = 0, entered = false, err = null;
      const hook = (next) => {
        hookCalls++;
        if (Date.now() - start > 3000) throw new Error('hook gave up: withLock never timed out');
        plant(dir, next);
      };
      try {
        withLock(key, () => { entered = true; }, { timeoutMs: 300, _stallBeforeLinkForTest: hook });
      } catch (e) { err = e; }
      ok(`${label}: withLock threw its own timeout (got: ${err && err.message})`, err && /^withLock\(.*timed out after/.test(err.message));
      check(`${label}: fn never ran`, entered, false);
      ok(`${label}: the path was actually retried (${hookCalls} attempts)`, hookCalls > 1);
    }
  }
}

async function runBrief7Tests() {
  const lockDirOf = (configDir, key) => path.join(configDir, 'state', 'serena', `${key}.locks`);
  const lockEntries = (dir) => fs.readdirSync(dir).sort();

  console.log('\nserena-registry.cjs — an acquirer\'s tmp file is removed when writing it fails');
  {
    // The write creates the file and then fails (ENOSPC partway through).
    // The tmp name is unique to this attempt and names this live pid, so
    // pruning keeps it; only withLock's own cleanup can remove it.
    const configDir = freshConfigDir();
    const { withLock } = loadRegistry(configDir);
    const key = 'tmp-write-fails-key';
    const dir = lockDirOf(configDir, key);
    let sabotaged = false, entered = false, err = null;
    withFsPatched({
      writeFileSync: (real, ...args) => {
        if (/[/\\]tmp\.\d+\.[0-9a-f]+$/.test(String(args[0]))) {
          sabotaged = true;
          real(args[0], '');
          throw Object.assign(new Error('ENOSPC: sabotaged tmp write'), { code: 'ENOSPC' });
        }
        return real(...args);
      },
    }, () => {
      try { withLock(key, () => { entered = true; }, { timeoutMs: 2000 }); } catch (e) { err = e; }
    });
    ok('the tmp write really failed after creating the file', sabotaged);
    ok('withLock surfaces the write failure', err && /ENOSPC/.test(err.message));
    check('fn never ran', entered, false);
    check('no tmp file is left behind in the lock dir', lockEntries(dir), []);

    let ranAfter = false;
    try { withLock(key, () => { ranAfter = true; }, { timeoutMs: 2000 }); } catch { /* reported below */ }
    ok('a later withLock on the same key still acquires it', ranAfter);
    check('and leaves only its own released generation', lockEntries(dir), ['0', '0.done']);
  }

  console.log('\nserena-registry.cjs — captureIdentity validates its own pid (vm stub, no OS access)');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { call } = loadRegistryInVm(platform);
    for (const pid of [0, 1, -1, 1.5, NaN, Infinity, undefined, null, '2', '1" or ProcessId>0 or "', Number.MAX_SAFE_INTEGER + 1]) {
      const { error, calls } = call('captureIdentity', pid);
      const label = `${platform}: captureIdentity(${typeof pid === 'string' ? JSON.stringify(pid) : String(pid)})`;
      check(`${label} is refused by validation`, error && error.name, 'RangeError');
      check(`${label} performs no OS operation`, calls.map((c) => c[0]), []);
    }
    const { calls } = call('captureIdentity', 12345);
    check(`${platform}: a valid pid reaches the (stubbed) lookup`, calls[0] && calls[0][0], 'spawnSync');
  }

  console.log('\nserena-registry.cjs — win32 captureIdentity formats CreationDate independently of culture (vm stub; the command is never run here)');
  {
    // Format-List prints a DateTime in the session culture's format and local
    // time, so a relay and a reaper under different cultures would never
    // agree. This only inspects the command the stub recorded: this machine
    // cannot run PowerShell, so the win32 branch stays unexercised.
    const { call } = loadRegistryInVm('win32');
    const { calls } = call('captureIdentity', 12345);
    const command = calls[0] ? [calls[0][1], ...calls[0][2]].join(' ') : '';
    ok(`the command formats CreationDate as round-trip UTC (got: ${command})`, /CreationDate\.ToUniversalTime\(\)\.ToString\('o'\)/.test(command));
    ok('the command does not render the DateTime through Format-List', !/Format-List/.test(command));
  }

  console.log('\nserena-registry.cjs — the unreleased retry never releases another process\'s generation');
  {
    // The reviewer's probe. This process's generation 0 is left unreleased
    // (every `.done` refused), the lock dir is wiped, and a live process plants
    // a fresh `0` naming itself. That `0` is not this process's generation:
    // releasing it would let this process into fn while its holder is still
    // alive. The holder is spawned HERE, not by the runner, so this process's
    // event loop reaps it when it exits; the runner blocks in withLock and
    // could not. The holder exits on its own after writing `finished`; no
    // signal is sent to it.
    const configDir = freshConfigDir();
    const key = 'settle-owner-key';
    const finished = path.join(configDir, 'holder-finished');
    const HOLDER_MS = 2000;
    const holderScript = path.join(configDir, 'owner-holder.cjs');
    fs.writeFileSync(holderScript, `
      setTimeout(() => { require('fs').writeFileSync(process.argv[2], ''); }, Number(process.argv[3]));
    `);
    const runnerScript = path.join(configDir, 'owner-runner.cjs');
    fs.writeFileSync(runnerScript, `
      const fs = require('fs');
      const path = require('path');
      const { withLock } = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
      const [holderPid, finished] = process.argv.slice(2);
      const key = ${JSON.stringify(key)};
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'state', 'serena', key + '.locks');
      const refuse = (t) => {
        if (String(t).endsWith('.done')) throw Object.assign(new Error('EACCES: sabotaged ' + t), { code: 'EACCES' });
      };
      const real = { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync };
      fs.writeFileSync = (...a) => { refuse(a[0]); return real.writeFileSync(...a); };
      fs.linkSync = (...a) => { refuse(a[1]); return real.linkSync(...a); };
      console.error = () => {};
      try { withLock(key, () => {}, { timeoutMs: 2000 }); } finally { Object.assign(fs, real); }
      const leftUnreleased = fs.readdirSync(dir).sort();

      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '0'), holderPid);
      const holderFinishedAtPlant = fs.existsSync(finished);

      let inside = null, err = null;
      try {
        withLock(key, () => {
          inside = { holderFinished: fs.existsSync(finished), entries: fs.readdirSync(dir).sort() };
        }, { timeoutMs: 15000 });
      } catch (e) { err = e.message; }
      process.stdout.write(JSON.stringify({ leftUnreleased, holderFinishedAtPlant, inside, err }));
    `);
    const { spawn } = require('child_process');
    const holder = spawn(process.execPath, [holderScript, finished, String(HOLDER_MS)], { stdio: 'ignore' });
    liveHelpers.push(holder);
    const runner = spawn(process.execPath, [runnerScript, String(holder.pid), finished], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    liveHelpers.push(runner);
    let stdout = '';
    runner.stdout.on('data', (b) => { stdout += b; });
    await Promise.all([waitExit(runner), waitExit(holder)]);
    liveHelpers.splice(liveHelpers.indexOf(runner), 1);
    liveHelpers.splice(liveHelpers.indexOf(holder), 1);

    let out = {};
    try { out = JSON.parse(stdout); } catch { /* reported by the checks below */ }
    check('the probe left this process\'s generation 0 unreleased', out.leftUnreleased, ['0']);
    check('the new 0 was planted while its holder was still running', out.holderFinishedAtPlant, false);
    check('withLock completed', out.err, null);
    check('fn ran only after the planted holder had finished', out.inside && out.inside.holderFinished, true);
    check('the planted holder\'s generation was not released by this process', out.inside && out.inside.entries, ['0', '1']);
  }
}

function runBrief9Tests() {
  console.log('\nserena-registry.cjs — killRecordServer says why it refused (vm stub, no OS access)');
  // The reaper deletes a record only when the refusal proves another process
  // holds the pid. An identity that could not be read, or was never
  // recorded, proves nothing about the process, so it must be told apart.
  for (const platform of ['darwin', 'linux', 'win32']) {
    const rec = { pid: 12345, identity: 'recorded-identity' };
    const cases = [
      ['the identity lookup could not start (ps missing)',
        () => ({ status: null, stdout: '', error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }) }),
        rec, 'IDENTITY_UNREADABLE'],
      ['the identity lookup found no process', () => ({ status: 1, stdout: '' }), rec, 'IDENTITY_UNREADABLE'],
      ['a different live process holds the pid', () => ({ status: 0, stdout: 'another-process\n' }), rec, 'IDENTITY_MISMATCH'],
      ['the record has no identity', () => ({ status: 0, stdout: 'recorded-identity\n' }), { pid: 12345, identity: '' }, 'IDENTITY_NOT_RECORDED'],
    ];
    for (const [what, lookup, record, code] of cases) {
      const { call } = loadRegistryInVm(platform, { identityLookup: lookup });
      const { error, calls } = call('killRecordServer', record);
      check(`${platform}: ${what}: refused with code ${code}`, error && error.code, code);
      check(`${platform}: ${what}: nothing beyond the identity lookup ran`,
        calls.map((c) => c[0]).filter((n) => n !== 'identity lookup'), []);
    }
    // A matching identity must get past every refusal to the (forbidden)
    // kill path, so a killRecordServer that refuses everything cannot pass.
    const { call } = loadRegistryInVm(platform, { identityLookup: () => ({ status: 0, stdout: 'recorded-identity\n' }) });
    const { calls } = call('killRecordServer', rec);
    ok(`${platform}: a matching identity reaches the (stubbed) kill path`,
      calls.some((c) => c[0] !== 'identity lookup'));
  }

  console.log('\nserena-registry.cjs — deleteRecord removes only the record, and only under the lock');
  {
    const configDir = freshConfigDir();
    const reg = loadRegistry(configDir);
    const key = 'delete-record-key';
    const recFile = path.join(configDir, 'state', 'serena', `${key}.json`);
    const locks = path.join(configDir, 'state', 'serena', `${key}.locks`);
    reg.write(key, { root: '/x', pid: 0, port: 1, clients: [] });
    reg.withLock(key, () => {});
    const locksBefore = fs.readdirSync(locks).sort();

    // A delete decides on the record's contents, so the decision and the
    // delete need the lock: a relay's addClient in between would otherwise be
    // lost with the record, and its server left running untracked.
    let outside = null;
    try { reg.deleteRecord(key); } catch (e) { outside = e; }
    ok('outside withLock it refuses, naming the lock', outside && /withLock/.test(outside.message));
    ok('and the record is left in place', fs.existsSync(recFile));
    let otherKey = null;
    try { reg.withLock('some-other-key', () => reg.deleteRecord(key)); } catch (e) { otherKey = e; }
    ok('holding a different key\'s lock does not count', otherKey && /withLock/.test(otherKey.message));
    ok('and the record is still in place', fs.existsSync(recFile));

    let inside = null;
    try { reg.withLock(key, () => reg.deleteRecord(key)); } catch (e) { inside = e; }
    check('inside withLock on the key it succeeds', inside && inside.message, null);
    check('the record is gone', fs.existsSync(recFile), false);
    check('and read() reports no record', reg.read(key), null);
    // The lock directory is what makes the lock exclusive; the delete took
    // one more generation, and pruning keeps the newest two.
    ok('the lock directory is left, with its generations', fs.existsSync(locks)
      && fs.readdirSync(locks).filter((n) => /^\d+$/.test(n)).length > 0);
    ok('and the frontier only moved forward', Math.max(...fs.readdirSync(locks).filter((n) => /^\d+$/.test(n)).map(Number))
      > Math.max(...locksBefore.filter((n) => /^\d+$/.test(n)).map(Number)));

    let again = null;
    try { reg.withLock(key, () => reg.deleteRecord(key)); } catch (e) { again = e; }
    check('deleting a record that is already gone is not an error', again && again.message, null);
  }
}

function finishHardeningSection() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(fail ? 1 : 0);
}
