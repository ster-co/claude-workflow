#!/usr/bin/env node
// Behavioural tests for bin/ship-loop.cjs, the unattended /ship driver.
// Run: node hooks/test/test-ship-loop.cjs
//
// No test ever invokes the real `claude` CLI or spends a model call: a fake
// `claude` is placed first on PATH and replays canned stream-json, driven by a
// per-test step script this suite writes. Sleep is injected the same way --
// SHIP_LOOP_TEST_SLEEP_LOG makes the script log the millisecond duration it
// would have slept instead of actually waiting.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-ship-loop.cjs -> hooks/test -> hooks -> ROOT: resolve from
// this script's own location so the suite exercises the checkout it lives in,
// never the live ~/.claude install (see test-verify-checkpoint.cjs's header).
const ROOT = path.join(__dirname, '..', '..');
const SHIP_LOOP = path.join(ROOT, 'bin', 'ship-loop.cjs');
const RUN_STATE = path.join(ROOT, 'hooks', 'run-state.cjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}
function checkTrue(name, cond) { check(name, !!cond, true); }

// Every fixture in this file creates its scratch dirs (repo, fake-bin, state,
// config) through this wrapper instead of calling fs.mkdtempSync directly, so
// a single exit-hook sweep can remove all of them -- repeated runs of this
// suite would otherwise accumulate ~20 leftover temp dirs per run.
const ALL_TMP_DIRS = [];
function mkdtemp(prefix) {
  const dir = fs.mkdtempSync(prefix);
  ALL_TMP_DIRS.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const d of ALL_TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort: process is exiting either way */ }
  }
});

// Self-probe for the exit-hook sweep above: invoked as a child of this same
// file (see the "test temp dirs" case near the end), it skips the full suite,
// creates one scratch dir via mkdtemp(), prints its path, and exits -- the
// parent then checks that path is gone, proving the exit hook runs for real
// rather than only being exercised within a single test's own process.
if (process.env.SHIP_LOOP_TEST_CLEANUP_PROBE) {
  const dir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-cleanup-probe-'));
  console.log(dir);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture builders. Each test gets its own scratch git repo, its own scratch
// CLAUDE_CONFIG_DIR (so run-state.cjs never touches real state), and its own
// fake `claude` fed by a step script that this suite controls.
function mkRepo() {
  const repo = mkdtemp(path.join(os.tmpdir(), 'ship-loop-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.ship-loop'), { recursive: true });
  return repo;
}

const FAKE_CLAUDE_SRC = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const stateDir = process.env.FAKE_CLAUDE_STATE_DIR;
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STEPS_FILE, 'utf-8'));
const idxFile = path.join(stateDir, 'index');
let idx = 0;
try { idx = Number(fs.readFileSync(idxFile, 'utf-8')); } catch {}
const step = steps[Math.min(idx, steps.length - 1)] || {};
fs.writeFileSync(idxFile, String(idx + 1));
fs.appendFileSync(path.join(stateDir, 'calls.jsonl'), JSON.stringify({
  argv: process.argv.slice(2), sessionEnv: process.env.CLAUDE_CODE_SESSION_ID,
  shipLoopPass: process.env.SHIP_LOOP_PASS, mcpTimeout: process.env.MCP_TIMEOUT,
}) + '\\n');
const cwd = process.cwd();

// step.bigOutputMiB simulates a real --verbose stream-json pass: reasoning
// and tool-use events stream out THROUGHOUT the pass, well before its real
// state changes (commit / phase / marker) land near the end. Writes respect
// backpressure -- checking write()'s boolean return and waiting for 'drain'
// -- so that under a too-small maxBuffer the parent's kill genuinely lands
// before runSideEffects() below, the same as it would for a real killed
// child, rather than racing a synchronous script that outruns the signal.
function writePadding(done) {
  if (!step.bigOutputMiB) return done();
  const chunk = 'x'.repeat(64 * 1024);
  const chunks = Math.ceil((step.bigOutputMiB * 1024 * 1024) / chunk.length);
  let i = 0;
  (function writeMore() {
    while (i < chunks) {
      i++;
      const line = JSON.stringify({ type: 'assistant',
        message: { content: [{ type: 'text', text: chunk }] } }) + '\\n';
      const ok = process.stdout.write(line);
      if (!ok) { process.stdout.once('drain', writeMore); return; }
    }
    done();
  })();
}

function runSideEffects() {
  if (step.commit) {
    fs.writeFileSync(path.join(cwd, 'progress-' + idx + '.txt'), 'work\\n');
    spawnSync('git', ['add', '-A'], { cwd });
    spawnSync('git', ['commit', '-q', '-m', 'pass ' + idx], { cwd });
  }
  if (step.phase) {
    spawnSync('node', [process.env.FAKE_CLAUDE_RUN_STATE, 'phase', step.phase,
      '--feature', process.env.FAKE_CLAUDE_FEATURE], { cwd });
  }
  if (step.marker) {
    fs.writeFileSync(path.join(cwd, '.ship-loop', step.marker.name), step.marker.content || '');
  }
  let out = '';
  if (step.limitMessage) {
    out += JSON.stringify({ type: 'assistant',
      message: { content: [{ type: 'text', text: step.limitMessage }] } }) + '\\n';
  }
  out += JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: step.cost ?? 0.01 }) + '\\n';
  process.stdout.write(out);
  // A real \`claude -p\` exits with status 1 on a usage-limit hit, not 0 --
  // this fake must match that or it can't catch the exit-ordering bug where
  // the driver throws on a non-zero status before ever checking for the
  // limit message in the output.
  const defaultExit = step.limitMessage ? 1 : 0;
  process.exit(step.exitCode ?? defaultExit);
}

writePadding(runSideEffects);
`;

function mkFakeClaude() {
  const dir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-fakebin-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, FAKE_CLAUDE_SRC);
  fs.chmodSync(bin, 0o755);
  return dir;
}

// The env that makes the driver's `claude` the fake in `fakeDir`: first on
// PATH. Windows runs only claude.exe/.com as `claude` without a shell, never
// this script-file fake, so there the driver is pointed at it through node.
function fakeClaudeEnv(fakeDir) {
  const env = { PATH: `${fakeDir}${path.delimiter}${process.env.PATH}` };
  if (process.platform === 'win32') {
    env.SHIP_LOOP_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fakeDir, 'claude')]);
  }
  return env;
}

// A curated PATH containing ONLY the directories `node` and `git` actually
// live in on this machine -- deliberately excluding both the fake-claude dir
// and the inherited PATH's real `claude` install. This is the ONLY safe way
// this suite simulates a genuine spawnSync failure (r.error, e.g. ENOENT):
// an earlier version made the fake `claude` file non-executable and relied on
// that producing EACCES, but confirmed on this machine that exec falls
// through a non-executable match and keeps searching PATH -- so with the real
// PATH still present, spawnSync('claude', ...) silently executed the REAL
// installed `claude` CLI instead of failing. Excluding `claude`'s directory
// entirely, with no fallback PATH, makes ENOENT the only possible outcome.
function minimalPathWithoutClaude() {
  const dirs = [path.dirname(process.execPath)];
  const which = spawnSync('which', ['git'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim()) dirs.push(path.dirname(which.stdout.trim()));
  return dirs.join(path.delimiter);
}

// Writes the two fixtures BRIEF 2's front door would normally generate.
// This suite owns them directly per the brief's "Stop at" instruction.
function writeFrontDoorFixtures(repo, feature) {
  fs.writeFileSync(path.join(repo, '.ship-loop', 'feature'), `${feature}\n`);
  fs.writeFileSync(path.join(repo, '.ship-loop', 'pass-prompt.md'), '# unattended pass\n');
}

let counter = 0;
// `configJson` always resolves to a fixture this suite controls -- when a
// test does not pass one, a harness-default fixture (no active limits) is
// used instead of leaving CLAUDE_CONFIG_JSON unset, which would let the
// driver fall through to the real ~/.claude.json (the house rule this file
// must never violate: "read it in tests only from a fixture you write,
// never the real file"). `home` is only for the regression test that proves
// that fallback is unreachable in practice; every other case leaves the
// child's real HOME alone since CLAUDE_CONFIG_JSON always wins first.
function runLoop(repo, steps, { extraArgs = [], configJson = null, pauseAt = null, home = null, claudeOnPath = true, extraEnv = {} } = {}) {
  const fakeDir = mkFakeClaude();
  const stateDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-fakestate-'));
  fs.writeFileSync(path.join(stateDir, 'index'), '0');
  const stepsFile = path.join(stateDir, 'steps.json');
  fs.writeFileSync(stepsFile, JSON.stringify(steps));
  const cfgDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-cfg-'));
  const sleepLog = path.join(stateDir, 'sleep.log');
  counter += 1;
  const feature = `feat-${counter}`;

  const args = [SHIP_LOOP, ...extraArgs];
  const env = {
    ...process.env,
    // `claudeOnPath: false` (the spawn-failure test) deliberately omits BOTH
    // the fake-claude dir and the inherited PATH -- see
    // minimalPathWithoutClaude()'s comment for why the inherited PATH can't
    // just be left in place here.
    PATH: claudeOnPath
      ? `${fakeDir}${path.delimiter}${process.env.PATH}`
      : minimalPathWithoutClaude(),
    FAKE_CLAUDE_STATE_DIR: stateDir,
    FAKE_CLAUDE_STEPS_FILE: stepsFile,
    ...extraEnv,
    FAKE_CLAUDE_RUN_STATE: RUN_STATE,
    FAKE_CLAUDE_FEATURE: feature,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_DIR: cfgDir,
    CLAUDE_CONFIG_JSON: configJson || mkConfigJson(cfgDir, []),
    SHIP_LOOP_TEST_SLEEP_LOG: sleepLog,
  };
  if (claudeOnPath) Object.assign(env, fakeClaudeEnv(fakeDir));
  if (home) env.HOME = home;
  if (pauseAt !== null) args.push('--pause-at', String(pauseAt));

  const r = spawnSync('node', args, { cwd: repo, encoding: 'utf-8', env });
  const calls = fs.existsSync(path.join(stateDir, 'calls.jsonl'))
    ? fs.readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const sleeps = fs.existsSync(sleepLog)
    ? fs.readFileSync(sleepLog, 'utf-8').trim().split('\n').filter(Boolean).map(Number)
    : [];
  return { r, calls, sleeps, feature, cfgDir, stateDir };
}

function mkConfigJson(dir, limits, fetchedAtMs = Date.now()) {
  const file = path.join(dir, 'claude.json');
  fs.writeFileSync(file, JSON.stringify({
    cachedUsageUtilization: { utilization: { fetchedAtMs, limits } },
  }));
  return file;
}

// =============================================================================
console.log('\nstop markers end the loop with the documented message');

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  fs.writeFileSync(path.join(repo, '.ship-loop', 'STOP'), '');
  const { r, calls } = runLoop(repo, [{}]);
  checkTrue('STOP: exits 0', r.status === 0);
  checkTrue('STOP: prints the documented message', /STOPPED \(user request\)/.test(r.stdout));
  check('STOP: claude is never invoked', calls.length, 0);
}

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  fs.writeFileSync(path.join(repo, '.ship-loop', 'DONE'), 'DONE: shipped it\n');
  const { r, calls } = runLoop(repo, [{}]);
  checkTrue('DONE: exits 0', r.status === 0);
  checkTrue('DONE: prints its one line', /DONE: shipped it/.test(r.stdout));
  check('DONE: claude is never invoked', calls.length, 0);
}

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  fs.writeFileSync(path.join(repo, '.ship-loop', 'HARD_STOP'), 'HARD_STOP: missing credential\n');
  const { r, calls } = runLoop(repo, [{}]);
  checkTrue('HARD_STOP: exits 0', r.status === 0);
  checkTrue('HARD_STOP: prints its one line', /HARD_STOP: missing credential/.test(r.stdout));
  check('HARD_STOP: claude is never invoked', calls.length, 0);
}

{
  // MUST NOT: a pass that hits none of the markers proceeds to the next pass.
  // Bounded by having the second pass write DONE, so the loop terminates.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{}, { marker: { name: 'DONE', content: 'DONE: two passes done\n' } }];
  const { r, calls } = runLoop(repo, steps);
  checkTrue('no marker hit: the loop proceeds past the first pass', calls.length === 2);
  checkTrue('and stops on the second pass’ DONE', /DONE: two passes done/.test(r.stdout));
}

// =============================================================================
console.log('\na pass whose output exceeds Node\'s 1 MiB default maxBuffer is captured in full, not falsely STALLED');

{
  // Reproduces the reviewer's probe: >1 MiB of stream-json output, with the
  // pass's real state change (the DONE marker) landing only after that
  // output, the same ordering a real --verbose pass has (reasoning and
  // tool-use events stream throughout; the state change is near the end).
  // Under the pre-fix 1 MiB default maxBuffer this kills the child before
  // the marker is ever written, so the "before"/"after" snapshots look
  // identical and the loop reports a false STALLED instead of DONE.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ bigOutputMiB: 2, marker: { name: 'DONE', content: 'DONE: big output captured\n' } }];
  const { r, calls } = runLoop(repo, steps);
  check('exactly one pass ran (no false stall driving a second attempt)', calls.length, 1);
  checkTrue('the loop reports DONE, not STALLED', /DONE: big output captured/.test(r.stdout));
  checkTrue('and does NOT report STALLED', !/STALLED/.test(r.stdout));
  const passFile = fs.readFileSync(path.join(repo, '.ship-loop', 'pass-001.jsonl'), 'utf-8');
  checkTrue('the full >1 MiB of output was captured, not truncated at ~1 MiB',
    Buffer.byteLength(passFile, 'utf-8') > 2 * 1024 * 1024);
}

{
  // MUST NOT: a child that genuinely fails (here: a non-zero exit, no
  // maxBuffer involved) must be reported as an error, never silently
  // absorbed into the stall count. Bounded to one pass: if this regressed
  // to "treat it as no progress", the run would still terminate (STALLED
  // after 2 stalls) rather than hang, but it would do so mis-reporting the
  // failure as a stall and only after wastefully retrying once.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ exitCode: 7 }];
  const { r, calls } = runLoop(repo, steps);
  checkTrue('a failed child exits the loop non-zero', r.status !== 0);
  checkTrue('reports the failure, not a stall', !/STALLED/.test(r.stdout));
  check('the pass ran exactly once (no blind retry)', calls.length, 1);
}

// =============================================================================
console.log('\na genuine spawnSync failure (r.error, e.g. ENOENT/EACCES) is reported, not silently caught by the exit-status check further down');

{
  // Covers the `r.error || r.signal` branch directly: `claudeOnPath: false`
  // runs the driver with a PATH that has no `claude` anywhere on it (not even
  // the fake one), so spawnSync fails to find anything to exec at all (r.error
  // ENOENT, r.status null) -- a real OS-level spawn failure, not a bad exit
  // code. (Earlier this used a non-executable fake `claude` file to provoke
  // EACCES instead, but confirmed on this machine that exec falls through a
  // non-executable match and keeps searching PATH -- with the real PATH still
  // present that silently ran the actually-installed `claude` CLI. Omitting
  // `claude` from PATH entirely is the only way to make failure certain.)
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const { r, calls } = runLoop(repo, [{}], { claudeOnPath: false });
  checkTrue('genuine spawn failure: the driver exits non-zero', r.status !== 0);
  checkTrue('genuine spawn failure: the error is surfaced, not swallowed as a generic non-zero-status failure',
    /claude pass failed \(spawnSync claude ENOENT\)/.test(r.stderr));
  checkTrue('genuine spawn failure: not misreported as STALLED', !/STALLED/.test(r.stdout));
  check('genuine spawn failure: the fake script itself never ran', calls.length, 0);
}

// =============================================================================
console.log('\nusage-limit message in a pass output sleeps until reset + 2 minutes, then retries');

// Renders a Date as the real CLI's bare time-of-day, in UTC, e.g. "11:30am".
// (Not an ISO timestamp -- the real message never contains one, see
// bin/ship-loop.cjs's USAGE_LIMIT_RE / parseResetTime comments.)
function timeOfDayUTC(date) {
  const h = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const meridiem = h >= 12 ? 'pm' : 'am';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${minute}${meridiem}`;
}

{
  // The real CLI's message is a bare time-of-day with a parenthesised zone
  // -- "You've hit your session limit · resets 11:30am (Europe/Amsterdam)"
  // -- not an ISO timestamp. Date.parse() returns NaN for that, which is
  // exactly the bug this test guards: it must resolve to a real future
  // instant, not silently fall back to "wait 2 minutes only".
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min ahead, safely clear of a rollover
  const steps = [
    { limitMessage: `You've hit your 5-hour limit · resets ${timeOfDayUTC(resetAt)} (UTC)` },
    { marker: { name: 'DONE', content: 'DONE: after retry\n' } },
  ];
  const { r, calls, sleeps } = runLoop(repo, steps);
  checkTrue('retries the same pass after sleeping', calls.length === 2);
  checkTrue('eventually reports DONE', /DONE: after retry/.test(r.stdout));
  check('exactly one sleep was recorded', sleeps.length, 1);
  const expectedMs = resetAt.getTime() - Date.now() + 2 * 60 * 1000;
  // A generous tolerance: the message only encodes minute precision (no
  // seconds), and the assertion only needs to catch a wrong formula (e.g.
  // missing the +2 minutes, or resolving the wrong day/zone), not shave
  // milliseconds off it.
  checkTrue('sleep duration is ~ resets_at + 2 minutes',
    sleeps.length === 1 && Math.abs(sleeps[0] - expectedMs) < 90000);
  // The exit-ordering bug: a real `claude -p` exits 1 on a usage-limit hit
  // (the fake claude above now matches that). If the driver throws on a
  // non-zero status BEFORE checking for the limit message, this run never
  // reaches DONE and exits non-zero here instead.
  checkTrue('the driver does not throw on the limit-hit pass\'s exit 1 -- it reaches DONE', r.status === 0);
}

{
  // Same exit-ordering bug, isolated: a single pass whose output contains the
  // limit message and exits 1 (the real CLI's behaviour) must sleep and
  // retry, never throw. Bounded to one retry via the DONE marker on the
  // second step.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 5 * 60 * 1000);
  const steps = [
    { limitMessage: `You've hit your session limit · resets ${timeOfDayUTC(resetAt)} (UTC)` },
    { marker: { name: 'DONE', content: 'DONE: exit-1 limit handled\n' } },
  ];
  const { r, calls, sleeps } = runLoop(repo, steps);
  check('exit 1 + limit message: exactly one sleep (no throw)', sleeps.length, 1);
  checkTrue('exit 1 + limit message: retries and reaches DONE', /DONE: exit-1 limit handled/.test(r.stdout));
  checkTrue('exit 1 + limit message: driver process exits 0, not a crash', r.status === 0);
  check('exit 1 + limit message: the pass ran twice (retry, not advance)', calls.length, 2);
}

{
  // The retried attempt must not overwrite the original limit-hit pass's own
  // saved output: pass-001.jsonl should keep recording the limit-hit attempt,
  // and the retry should land in its own file.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 5 * 60 * 1000);
  const steps = [
    { limitMessage: `You've hit your session limit · resets ${timeOfDayUTC(resetAt)} (UTC)` },
    { marker: { name: 'DONE', content: 'DONE: retry file preserved\n' } },
  ];
  const { r } = runLoop(repo, steps);
  checkTrue('retry-file naming: the run reaches DONE', /DONE: retry file preserved/.test(r.stdout));
  const original = fs.readFileSync(path.join(repo, '.ship-loop', 'pass-001.jsonl'), 'utf-8');
  checkTrue('retry-file naming: the original limit-hit attempt\'s own output is preserved, not overwritten',
    /session limit/.test(original));
  const retryFile = path.join(repo, '.ship-loop', 'pass-001-retry1.jsonl');
  checkTrue('retry-file naming: the retried attempt is saved to its own numbered file', fs.existsSync(retryFile));
  const retryContent = fs.existsSync(retryFile) ? fs.readFileSync(retryFile, 'utf-8') : '';
  checkTrue('retry-file naming: the retry file holds the retried attempt\'s own output, not a copy of the original',
    /"type":"result"/.test(retryContent) && !/session limit/.test(retryContent));
}

// Renders a Date as "Mon D" in UTC, e.g. "Oct 3" -- the real CLI's
// date-prefixed reset format used when the reset is >24h out.
function dateOnlyUTC(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

{
  // >24h-out reset carries a date prefix: "Oct 3, 2026, 9am (UTC)", not a bare
  // time-of-day. RESET_TIME_RE anchored to the time-only form fails this
  // entirely (no match -> HARD_STOP instead of a real sleep). The year is
  // spelled out explicitly here (matching the real CLI, which "adds `, YYYY`
  // itself whenever the year differs" -- see the year-boundary test below):
  // without it, running this suite near Dec 29-31 UTC would compute a resetAt
  // that has rolled into next year while the no-year code path still assumes
  // the current one, flaking the sleep-duration assertion below.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days ahead
  const resetText = `${dateOnlyUTC(resetAt)}, ${resetAt.getUTCFullYear()}, ${timeOfDayUTC(resetAt)} (UTC)`;
  const steps = [
    { limitMessage: `You've hit your weekly limit · resets ${resetText}` },
    { marker: { name: 'DONE', content: 'DONE: date-prefixed reset handled\n' } },
  ];
  const { r, sleeps } = runLoop(repo, steps);
  check('date-prefixed (>24h) reset: exactly one sleep, not a HARD_STOP', sleeps.length, 1);
  checkTrue('date-prefixed reset: reaches DONE', /DONE: date-prefixed reset handled/.test(r.stdout));
  const expectedMs = resetAt.getTime() - Date.now() + 2 * 60 * 1000;
  checkTrue('date-prefixed reset: sleep duration is ~ resets_at + 2 minutes',
    sleeps.length === 1 && Math.abs(sleeps[0] - expectedMs) < 90000);
}

{
  // Deterministic year-boundary coverage via dependency injection, so this
  // never depends on when the suite happens to run (unlike the flake the
  // block above used to have): parseResetTime is called directly with `now`
  // pinned to Dec 30, proving an explicit-year date-prefixed reset resolves
  // to the stated year regardless of the real wall clock.
  const { parseResetTime } = require(SHIP_LOOP);
  const now = new Date(Date.UTC(2026, 11, 30, 12, 0, 0)); // pinned: Dec 30, 2026, 12:00 UTC
  const resolved = parseResetTime('Jan 4, 2027, 4pm (UTC)', now);
  checkTrue('parseResetTime DI: an explicit-year reset resolves to that year even when `now` is Dec 30',
    resolved instanceof Date && resolved.getTime() === Date.UTC(2027, 0, 4, 16, 0, 0));
}

{
  // Year boundary: the reset date names an explicit year because it is far
  // enough out to cross into next year (the debugger's confirmed example:
  // "Jan 4, 2027, 4pm (...)"). Must resolve to that exact year, not silently
  // default to the current one.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const resetAt = new Date(Date.UTC(nextYear, 0, 4, 16, 0, 0)); // Jan 4, next year, 4pm UTC
  const resetText = `Jan 4, ${nextYear}, 4pm (UTC)`;
  const steps = [
    { limitMessage: `You've hit your weekly limit · resets ${resetText}` },
    { marker: { name: 'DONE', content: 'DONE: year-boundary reset handled\n' } },
  ];
  const { r, sleeps } = runLoop(repo, steps);
  check('year-boundary reset: exactly one sleep, not a HARD_STOP', sleeps.length, 1);
  checkTrue('year-boundary reset: reaches DONE', /DONE: year-boundary reset handled/.test(r.stdout));
  const expectedMs = resetAt.getTime() - Date.now() + 2 * 60 * 1000;
  checkTrue('year-boundary reset: sleep duration resolves the explicit year, not the current one',
    sleeps.length === 1 && Math.abs(sleeps[0] - expectedMs) < 90000);
}

{
  // A trailing " · progress saved" segment (feature-flag gated) must be cut
  // off, not folded into the captured reset text -- and a bare "limit" with
  // no adjective before it (no "5-hour", no "session") must still match.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 15 * 60 * 1000);
  const steps = [
    { limitMessage: `You've hit your limit · resets ${timeOfDayUTC(resetAt)} (UTC) · progress saved` },
    { marker: { name: 'DONE', content: 'DONE: progress-saved suffix handled\n' } },
  ];
  const { r, sleeps } = runLoop(repo, steps);
  check('"· progress saved" suffix + bare "limit": exactly one sleep, not a HARD_STOP', sleeps.length, 1);
  checkTrue('"· progress saved" suffix + bare "limit": reaches DONE',
    /DONE: progress-saved suffix handled/.test(r.stdout));
  const expectedMs = resetAt.getTime() - Date.now() + 2 * 60 * 1000;
  checkTrue('"· progress saved" suffix is not folded into the parsed time',
    sleeps.length === 1 && Math.abs(sleeps[0] - expectedMs) < 90000);
}

{
  // MUST NOT: a pass without the usage-limit message never sleeps.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: no limit hit\n' } }];
  const { calls, sleeps } = runLoop(repo, steps);
  check('no usage-limit message: no sleep', sleeps.length, 0);
  check('and only one pass ran', calls.length, 1);
}

{
  // A format this driver cannot parse into a real wait time (no time-of-day
  // pattern at all) must become a visible HARD_STOP, not the old behaviour
  // of silently waiting 2 minutes and retrying forever -- which in
  // production means hammering `claude -p` for the rest of the limit
  // window.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ limitMessage: "You've hit your 5-hour limit · resets in a few hours" }];
  const { r, calls, sleeps } = runLoop(repo, steps);
  checkTrue('unparseable reset time: the loop reports HARD_STOP with the reason',
    /HARD_STOP: could not parse usage-limit reset time/.test(r.stdout));
  check('unparseable reset time: never sleeps', sleeps.length, 0);
  check('unparseable reset time: the pass ran exactly once, no blind retry loop', calls.length, 1);
}

{
  // A SUCCESSFUL pass (exit 0) whose assistant prose happens to quote
  // limit-shaped text (plausible when the loop runs against this very repo)
  // must never be mistaken for a real limit hit. The limit check only runs on
  // a non-zero exit status; a second, limit-free step is queued behind it so
  // that if this regressed, the (buggy) retry would consume that step and
  // terminate rather than looping forever replaying the same limit message.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const resetAt = new Date(Date.now() + 10 * 60 * 1000);
  const steps = [
    { limitMessage: `You've hit your session limit · resets ${timeOfDayUTC(resetAt)} (UTC)`, exitCode: 0 },
    { marker: { name: 'DONE', content: 'DONE: limit-shaped text on success ignored\n' } },
  ];
  const { r, sleeps } = runLoop(repo, steps);
  check('successful pass quoting limit-shaped text: never treated as a limit hit (no sleep)', sleeps.length, 0);
  checkTrue('successful pass quoting limit-shaped text: the run still reaches DONE via the next real pass',
    /DONE: limit-shaped text on success ignored/.test(r.stdout));
}

{
  // A parsed reset time that already lies in the past (a "should not happen"
  // parsing edge case -- here forced via a date-prefixed message naming
  // yesterday's date, which parseResetTime resolves literally with no
  // roll-forward) must not be treated as normal: it should clamp to the
  // 2-minute grace minimum and log that the parsed time looked stale, rather
  // than silently sleeping as if this were an ordinary near-future reset.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
  const staleText = `${dateOnlyUTC(staleAt)}, ${staleAt.getUTCFullYear()}, ${timeOfDayUTC(staleAt)} (UTC)`;
  const steps = [
    { limitMessage: `You've hit your weekly limit · resets ${staleText}` },
    { marker: { name: 'DONE', content: 'DONE: stale reset time clamped\n' } },
  ];
  const { r, sleeps } = runLoop(repo, steps);
  checkTrue('stale (past) reset time: reaches DONE via the clamped retry, not a busy-loop',
    /DONE: stale reset time clamped/.test(r.stdout));
  check('stale (past) reset time: exactly one sleep', sleeps.length, 1);
  checkTrue('stale (past) reset time: clamps to the 2-minute grace minimum, not a near-zero wait',
    sleeps.length === 1 && Math.abs(sleeps[0] - 2 * 60 * 1000) < 15000);
  checkTrue('stale (past) reset time: logs that the parsed time looked stale',
    /stale/i.test(r.stderr));
}

// =============================================================================
console.log('\nusage pause: stale fetchedAtMs is unknown, a fresh reading acts on pauseAt');

{
  // A stale reading (> 30 min old) at or above pauseAt must be treated as
  // unknown and NOT sleep before the pass.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const cfgHolder = mkdtemp(path.join(os.tmpdir(), 'ship-loop-usagecfg-'));
  const stale = mkConfigJson(cfgHolder, [
    { kind: 'session', group: 'default', percent: 99, severity: 'critical',
      resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), scope: 'org', is_active: true },
  ], Date.now() - 31 * 60 * 1000);
  const steps = [{ marker: { name: 'DONE', content: 'DONE: stale usage ignored\n' } }];
  const { sleeps, calls } = runLoop(repo, steps, { configJson: stale });
  check('stale fetchedAtMs: no sleep', sleeps.length, 0);
  check('and the pass still ran', calls.length, 1);
  fs.rmSync(cfgHolder, { recursive: true, force: true });
}

{
  // A fresh reading at/above pauseAt sleeps until resets_at before the pass.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const cfgHolder = mkdtemp(path.join(os.tmpdir(), 'ship-loop-usagecfg-'));
  const resetAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const fresh = mkConfigJson(cfgHolder, [
    { kind: 'session', group: 'default', percent: 97, severity: 'critical',
      resets_at: resetAt, scope: 'org', is_active: true },
  ]);
  const steps = [{ marker: { name: 'DONE', content: 'DONE: fresh over pauseAt\n' } }];
  const { sleeps, calls } = runLoop(repo, steps, { configJson: fresh });
  check('fresh reading >= pauseAt: exactly one sleep', sleeps.length, 1);
  const expectedMs = Date.parse(resetAt) - Date.now();
  checkTrue('sleep duration is ~ until resets_at',
    sleeps.length === 1 && Math.abs(sleeps[0] - expectedMs) < 15000);
  check('and the pass still ran after waking', calls.length, 1);
  fs.rmSync(cfgHolder, { recursive: true, force: true });
}

{
  // MUST NOT: a fresh reading below pauseAt never sleeps.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const cfgHolder = mkdtemp(path.join(os.tmpdir(), 'ship-loop-usagecfg-'));
  const below = mkConfigJson(cfgHolder, [
    { kind: 'session', group: 'default', percent: 40, severity: 'info',
      resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), scope: 'org', is_active: true },
  ]);
  const steps = [{ marker: { name: 'DONE', content: 'DONE: below pauseAt\n' } }];
  const { sleeps } = runLoop(repo, steps, { configJson: below });
  check('fresh reading below pauseAt: no sleep', sleeps.length, 0);
  fs.rmSync(cfgHolder, { recursive: true, force: true });
}

// =============================================================================
console.log('\nregression: a test case that does not pass its own configJson still never reads the real ~/.claude.json fallback');

{
  // Point HOME at a directory whose .claude.json fixture WOULD trigger a
  // sleep (percent 99 >= the default pauseAt of 95) if the driver ever fell
  // through to reading it. Call runLoop the ordinary way every other case
  // above uses -- no `configJson` option -- and confirm zero sleeps: the
  // harness's own default CLAUDE_CONFIG_JSON fixture (set unconditionally
  // in runLoop) must always be what the driver reads, never this fallback.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const fakeHome = mkdtemp(path.join(os.tmpdir(), 'ship-loop-fakehome-'));
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: { utilization: { fetchedAtMs: Date.now(), limits: [
      { kind: 'session', group: 'default', percent: 99, severity: 'critical',
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), scope: 'org', is_active: true },
    ] } },
  }));
  const steps = [{ marker: { name: 'DONE', content: 'DONE: never read the HOME fallback\n' } }];
  const { sleeps, calls } = runLoop(repo, steps, { home: fakeHome });
  check('no configJson option passed: still zero sleeps (HOME fallback never read)', sleeps.length, 0);
  check('and the pass still ran', calls.length, 1);
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

// =============================================================================
console.log('\nstall detection: two no-change passes STALL, a commit between them resets the count');

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{}, {}];
  const { r, calls } = runLoop(repo, steps);
  check('two consecutive no-change passes: exactly two passes ran', calls.length, 2);
  checkTrue('and the loop reports STALLED', /STALLED/.test(r.stdout));
}

{
  // A commit pass between two no-change passes resets the stall counter, so
  // STALLED is only reached after FOUR passes, not two -- the pair below
  // distinguishes "reset" from "counts but never resets".
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{}, { commit: true }, {}, {}];
  const { r, calls } = runLoop(repo, steps);
  check('no-change, commit, no-change, no-change: all four passes ran', calls.length, 4);
  checkTrue('STALLED only after the count restarts post-commit', /STALLED/.test(r.stdout));
}

{
  // Same shape as the commit-reset pair above, but the thing that changes
  // between two otherwise-identical passes is the run's phase, not HEAD --
  // covering the half of sameSnapshot() the HEAD-only tests above never
  // exercise (phase/currentBrief are null on every snapshot in those tests,
  // since none of them ever start a real run). Seeded in `planning`; the
  // second pass advances it to `executing` via the fake claude's own
  // `step.phase` support.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x3');
  const cfgDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-phasestall-cfg-'));
  spawnSync('node', [RUN_STATE, 'start', '--feature', 'x3', '--phase', 'planning'],
    { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });

  const fakeDir = mkFakeClaude();
  const stateDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-fakestate-'));
  fs.writeFileSync(path.join(stateDir, 'index'), '0');
  const stepsFile = path.join(stateDir, 'steps.json');
  fs.writeFileSync(stepsFile, JSON.stringify([
    {},                     // pass1: no change at all -> stall count 1
    { phase: 'executing' }, // pass2: phase-only change -> resets stall count to 0
    {},                     // pass3: no change -> stall count 1
    {},                     // pass4: no change -> stall count 2 -> STALLED
  ]));
  const env = {
    ...process.env,
    ...fakeClaudeEnv(fakeDir),
    FAKE_CLAUDE_STATE_DIR: stateDir,
    FAKE_CLAUDE_STEPS_FILE: stepsFile,
    FAKE_CLAUDE_RUN_STATE: RUN_STATE,
    FAKE_CLAUDE_FEATURE: 'x3',
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_DIR: cfgDir,
    CLAUDE_CONFIG_JSON: mkConfigJson(cfgDir, []),
    SHIP_LOOP_TEST_SLEEP_LOG: path.join(stateDir, 'sleep.log'),
  };
  const r = spawnSync('node', [SHIP_LOOP], { cwd: repo, encoding: 'utf-8', env });
  const calls = fs.readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  check('no-change, phase-change, no-change, no-change: all four passes ran', calls.length, 4);
  checkTrue('STALLED only after the count restarts post-phase-change', /STALLED/.test(r.stdout));
}

// =============================================================================
console.log('\nmodels: opus by default, --model overrides every pass, --plan-model only the planning pass');

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: model default\n' } }];
  const { calls } = runLoop(repo, steps);
  const argv = calls[0].argv;
  const i = argv.indexOf('--model');
  checkTrue('with no model flags, the pass uses --model opus', i >= 0 && argv[i + 1] === 'opus');
  // hooks/agent-profile.cjs keys off this to leave an unattended pass's
  // dispatches unrewritten, so it always runs the full-effort agents whatever
  // profile is in force.
  check('the pass runs with SHIP_LOOP_PASS=1 in its environment', calls[0].shipLoopPass, '1');
}

{
  // A pass starts every configured MCP server; under heavy host load Serena's
  // relay misses Claude Code's default startup timeout, reports "failed", and
  // the edit gate then refuses every source edit for the whole pass. The
  // driver gives each pass a long startup timeout unless the caller set one.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: mcp timeout default\n' } }];
  const { calls } = runLoop(repo, steps, { extraEnv: { MCP_TIMEOUT: '' } });
  check('with MCP_TIMEOUT unset, the pass runs with MCP_TIMEOUT=300000', calls[0].mcpTimeout, '300000');
}

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: mcp timeout explicit\n' } }];
  const { calls } = runLoop(repo, steps, { extraEnv: { MCP_TIMEOUT: '45000' } });
  check('an MCP_TIMEOUT the caller set is passed through unchanged', calls[0].mcpTimeout, '45000');
}

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: model override\n' } }];
  const { calls } = runLoop(repo, steps, { extraArgs: ['--model', 'fable'] });
  const argv = calls[0].argv;
  const i = argv.indexOf('--model');
  checkTrue('--model changes every pass', i >= 0 && argv[i + 1] === 'fable');
}

console.log('\nusage cap: no --max-budget-usd unless --pass-budget-usd is passed');

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: no budget flag\n' } }];
  const { calls } = runLoop(repo, steps);
  checkTrue('with no --pass-budget-usd, the pass has no --max-budget-usd', !calls[0].argv.includes('--max-budget-usd'));
}

{
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x');
  const steps = [{ marker: { name: 'DONE', content: 'DONE: budget flag\n' } }];
  const { calls } = runLoop(repo, steps, { extraArgs: ['--pass-budget-usd', '7'] });
  const argv = calls[0].argv;
  const i = argv.indexOf('--max-budget-usd');
  checkTrue('--pass-budget-usd 7 passes --max-budget-usd 7', i >= 0 && argv[i + 1] === '7');
}

{
  // Start the run in `planning` so the first pass sees phase: planning, then
  // have that same pass advance the phase to `executing` so the SECOND pass
  // must fall back to the base model.
  const repo = mkRepo();
  writeFrontDoorFixtures(repo, 'x2');
  const cfgDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-planmodel-cfg-'));
  spawnSync('node', [RUN_STATE, 'start', '--feature', 'x2', '--phase', 'planning'],
    { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });
  fs.writeFileSync(path.join(repo, '.ship-loop', 'feature'), 'x2\n');

  const fakeDir = mkFakeClaude();
  const stateDir = mkdtemp(path.join(os.tmpdir(), 'ship-loop-fakestate-'));
  fs.writeFileSync(path.join(stateDir, 'index'), '0');
  const stepsFile = path.join(stateDir, 'steps.json');
  fs.writeFileSync(stepsFile, JSON.stringify([
    { phase: 'executing' },
    { marker: { name: 'DONE', content: 'DONE: plan-model test\n' } },
  ]));
  const env = {
    ...process.env,
    ...fakeClaudeEnv(fakeDir),
    FAKE_CLAUDE_STATE_DIR: stateDir,
    FAKE_CLAUDE_STEPS_FILE: stepsFile,
    FAKE_CLAUDE_RUN_STATE: RUN_STATE,
    FAKE_CLAUDE_FEATURE: 'x2',
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_DIR: cfgDir,
    CLAUDE_CONFIG_JSON: mkConfigJson(cfgDir, []),
    SHIP_LOOP_TEST_SLEEP_LOG: path.join(stateDir, 'sleep.log'),
  };
  spawnSync('node', [SHIP_LOOP, '--plan-model', 'haiku'], { cwd: repo, encoding: 'utf-8', env });
  const calls = fs.readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  check('two passes ran', calls.length, 2);
  const modelArg = (argv) => argv[argv.indexOf('--model') + 1];
  check('the planning-phase pass uses --plan-model', modelArg(calls[0].argv), 'haiku');
  check('the following executing-phase pass falls back to the base model', modelArg(calls[1].argv), 'opus');
}

// =============================================================================
console.log('\ntest temp dirs: the exit-hook sweep removes scratch dirs created via mkdtemp()');

{
  // Spawns this same file as a child with the self-probe env var set (see the
  // top of this file): the child creates exactly one scratch dir through
  // mkdtemp(), prints its path, and exits. If the exit-hook sweep works, that
  // path is gone by the time this check runs -- proving the sweep fires for
  // real process exits, not just within a single test's own in-process scope.
  const r = spawnSync('node', [__filename], {
    encoding: 'utf-8',
    env: { ...process.env, SHIP_LOOP_TEST_CLEANUP_PROBE: '1' },
  });
  const dir = r.stdout.trim();
  checkTrue('cleanup probe: the child created and printed a scratch dir', dir.length > 0 && fs.existsSync(path.dirname(dir)));
  checkTrue('cleanup probe: the scratch dir no longer exists after the child process exited',
    dir.length > 0 && !fs.existsSync(dir));
}

// =============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
