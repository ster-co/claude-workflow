#!/usr/bin/env node
// Behavioural tests for bin/ship-loop-launch.cjs, the `/ship --unattended` front
// door. Run: node hooks/test/test-ship-loop-launch.cjs
//
// No test ever invokes the real `claude` CLI, touches the real ~/.claude.json, or
// leaves a live background process running after the suite exits: the detached
// child the launcher spawns is replaced with a fake driver (SHIP_LOOP_DRIVER on
// PATH via env override) that records its argv to a file and exits immediately.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-ship-loop-launch.cjs -> hooks/test -> hooks -> ROOT: resolve
// from this script's own location so the suite exercises the checkout it lives
// in, never the live ~/.claude install (see test-verify-checkpoint.cjs's header).
const ROOT = path.join(__dirname, '..', '..');
const LAUNCH = path.join(ROOT, 'bin', 'ship-loop-launch.cjs');
const RUN_STATE = path.join(ROOT, 'hooks', 'run-state.cjs');
const launchMod = require(LAUNCH);

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}
function checkTrue(name, cond) { check(name, !!cond, true); }

// A blocking sleep with no subprocess and no unbounded wait -- used only to
// poll for the fake driver's calls file, which a detached, unref'd child
// writes asynchronously relative to the launcher script returning.
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) sleepSyncMs(20);
  return fs.existsSync(file);
}

// ---------------------------------------------------------------------------
// Fixture builders.
function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });
  return repo;
}

function mkConfigJson(dir, limits, fetchedAtMs = Date.now()) {
  const file = path.join(dir, 'claude.json');
  fs.writeFileSync(file, JSON.stringify({
    cachedUsageUtilization: { utilization: { fetchedAtMs, limits } },
  }));
  return file;
}

// Writes exactly `raw` (a string, for unparseable-JSON fixtures) or
// JSON.stringify(raw) (an object, for a well-formed file missing the
// cachedUsageUtilization/utilization shape entirely) to the usage config path.
function mkConfigJsonRaw(dir, raw) {
  const file = path.join(dir, 'claude.json');
  fs.writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
  return file;
}

// The fake driver bin/ship-loop.cjs is replaced with: it just records the argv
// it was started with and exits. No real pass ever runs from this suite.
const FAKE_DRIVER_SRC = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
fs.writeFileSync(process.env.LAUNCH_TEST_CALLS_FILE, JSON.stringify(process.argv.slice(2)));
`;

function mkFakeDriver(stateDir) {
  const p = path.join(stateDir, 'fake-driver.cjs');
  fs.writeFileSync(p, FAKE_DRIVER_SRC);
  return p;
}

let counter = 0;
// Sets up a run at `phase`, on `branch` (created and checked out), with the
// run's own recorded branch matching. Returns { repo, feature, cfgDir }.
function mkReadyRun(phase, { branch = 'feature/x', checkoutBranch = branch, claudeMd = null } = {}) {
  counter += 1;
  const feature = `feat-${counter}`;
  const repo = mkRepo();
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-cfg-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
  spawnSync('git', ['checkout', '-q', '-b', checkoutBranch], { cwd: repo });
  spawnSync('node', [RUN_STATE, 'start', '--feature', feature, '--phase', phase], { cwd: repo, env });
  // `--feature` names the run outright. Without it run-state resolves the run
  // through the calling session's pointer, which exists only when this suite
  // itself runs inside a Claude session (CLAUDE_CODE_SESSION_ID); from a plain
  // shell the branch landed on a run called `unnamed`.
  spawnSync('node', [RUN_STATE, 'branch', branch, '--feature', feature], { cwd: repo, env });
  // Committed, as a project's CLAUDE.md is: left untracked it dirties the tree
  // and the clean-tree check refuses first, unless the machine's own global
  // gitignore happens to hide it.
  if (claudeMd !== null) {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), claudeMd);
    spawnSync('git', ['add', '-f', 'CLAUDE.md'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '-m', 'CLAUDE.md'], { cwd: repo });
  }
  return { repo, feature, cfgDir };
}

// Runs the launcher against a scratch run. By default every readiness check
// passes: phase `executing` (not gated), clean tree, correct branch checked
// out, usage below pauseAt (empty limits fixture).
function runLaunch({ phase = 'executing', branch = 'feature/x', checkoutBranch = branch,
  claudeMd = null, dirty = false, configLimits = [], configFetchedAtMs = Date.now(),
  configRaw = undefined, extraArgs = [], driver = true, markers = null, cwd = null,
  pathPrepend = null, extraFiles = null } = {}) {
  const { repo, feature, cfgDir } = mkReadyRun(phase, { branch, checkoutBranch, claudeMd });
  if (dirty) fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n');
  if (markers) {
    const shipDir = path.join(repo, '.ship-loop');
    fs.mkdirSync(shipDir, { recursive: true });
    for (const [name, content] of Object.entries(markers)) {
      fs.writeFileSync(path.join(shipDir, name), content);
    }
  }
  if (extraFiles) extraFiles(repo);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-state-'));
  const callsFile = path.join(stateDir, 'calls.json');
  const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-usage-'));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfgDir,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_JSON: configRaw !== undefined
      ? mkConfigJsonRaw(usageDir, configRaw)
      : mkConfigJson(usageDir, configLimits, configFetchedAtMs),
    LAUNCH_TEST_CALLS_FILE: callsFile,
  };
  if (driver) env.SHIP_LOOP_DRIVER = mkFakeDriver(stateDir);
  if (pathPrepend) env.PATH = `${pathPrepend}${path.delimiter}${process.env.PATH}`;
  // `cwd` may be a function of `repo` (resolved after extraFiles has run, e.g.
  // to point at a subdirectory extraFiles just created) rather than a plain
  // path known before `repo` exists.
  const resolvedCwd = typeof cwd === 'function' ? cwd(repo) : (cwd || repo);
  const args = [LAUNCH, '--feature', feature, ...extraArgs];
  const r = spawnSync('node', args, { cwd: resolvedCwd, encoding: 'utf-8', env });
  return { r, repo, feature, cfgDir, stateDir, callsFile };
}

// =============================================================================
console.log('\neach readiness check fails closed on its own; a run passing every check does not refuse');

{
  const { r, callsFile } = runLaunch({ dirty: true });
  checkTrue('dirty tree: refuses (non-zero exit)', r.status !== 0);
  checkTrue('dirty tree: names the check', /not clean|dirty|git status/i.test(r.stdout + r.stderr));
  checkTrue('dirty tree: never spawns the driver', !fs.existsSync(callsFile));
}

{
  const { r, callsFile } = runLaunch({ branch: 'feature/x', checkoutBranch: 'master' });
  checkTrue('wrong branch: refuses (non-zero exit)', r.status !== 0);
  checkTrue('wrong branch: names the check', /branch/i.test(r.stdout + r.stderr));
  checkTrue('wrong branch: never spawns the driver', !fs.existsSync(callsFile));
}

{
  const { r, callsFile } = runLaunch({ phase: 'awaiting-approval', claudeMd: '# Project\nNo standing approval here.\n' });
  checkTrue('awaiting-approval, no standing approval: refuses (non-zero exit)', r.status !== 0);
  checkTrue('awaiting-approval, no standing approval: names the check',
    /awaiting-approval|approval|phase/i.test(r.stdout + r.stderr));
  checkTrue('awaiting-approval, no standing approval: never spawns the driver', !fs.existsSync(callsFile));
}

{
  const { r, callsFile } = runLaunch({
    configLimits: [{ kind: 'session', group: 'default', percent: 97, severity: 'critical',
      resets_at: new Date(Date.now() + 3600000).toISOString(), scope: 'org', is_active: true }],
  });
  checkTrue('usage at/above pauseAt: refuses (non-zero exit)', r.status !== 0);
  checkTrue('usage at/above pauseAt: names the check', /usage|pause/i.test(r.stdout + r.stderr));
  checkTrue('usage at/above pauseAt: never spawns the driver', !fs.existsSync(callsFile));
}

{
  // MUST NOT: a run passing every check is not refused.
  const { r, stateDir, callsFile } = runLaunch({});
  checkTrue('every check passes: exits 0', r.status === 0);
  checkTrue('every check passes: the driver was spawned', waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\nusage staleness: an unknown reading proceeds (with a warning) rather than refusing, matching BRIEF 1\'s driver');

{
  // A hot reading whose own resets_at has already passed is stale in the sense
  // that matters -- the limit should have reset since -- regardless of how
  // fresh fetchedAtMs itself is. Refusing here would be a false refusal.
  const { r, stateDir, callsFile } = runLaunch({
    configLimits: [{ kind: 'session', group: 'default', percent: 97, severity: 'critical',
      resets_at: new Date(Date.now() - 3600000).toISOString(), scope: 'org', is_active: true }],
  });
  checkTrue('hot reading past its own resets_at: exits 0 (not treated as still hot)', r.status === 0);
  checkTrue('hot reading past its own resets_at: the driver was spawned', waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // fetchedAtMs older than 30 minutes -- the same USAGE_STALE_MS threshold
  // bin/ship-loop.cjs's checkUsagePause uses -- is unknown, not zero: proceed
  // rather than refuse. The launcher gets no second chance to un-refuse itself,
  // but the driver runs its own usage check again before the first pass.
  const { r, stateDir, callsFile } = runLaunch({
    configLimits: [{ kind: 'session', group: 'default', percent: 99, severity: 'critical',
      resets_at: new Date(Date.now() + 3600000).toISOString(), scope: 'org', is_active: true }],
    configFetchedAtMs: Date.now() - 31 * 60 * 1000,
  });
  checkTrue('stale fetchedAtMs (> 30 min): exits 0 (proceeds instead of refusing on stale data)', r.status === 0);
  checkTrue('stale fetchedAtMs (> 30 min): the driver was spawned', waitForFile(callsFile, 3000));
  checkTrue('stale fetchedAtMs (> 30 min): warns rather than staying silent',
    /usage|stale/i.test(r.stdout + r.stderr));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // A usage file that parses but has no cachedUsageUtilization/utilization
  // shape at all (e.g. a fresh ~/.claude.json before the first usage fetch)
  // must not be silently indistinguishable from "usage confirmed low".
  const { r, stateDir, callsFile } = runLaunch({ configRaw: { some: 'other-shape' } });
  checkTrue('missing usage shape: exits 0 (proceeds)', r.status === 0);
  checkTrue('missing usage shape: the driver was spawned', waitForFile(callsFile, 3000));
  checkTrue('missing usage shape: warns rather than staying silent', /usage/i.test(r.stdout + r.stderr));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // Unparseable JSON must be handled the same way as a missing file, not
  // crash the launcher.
  const { r, stateDir, callsFile } = runLaunch({ configRaw: '{ not valid json' });
  checkTrue('unparseable usage file: exits 0 (proceeds)', r.status === 0);
  checkTrue('unparseable usage file: the driver was spawned', waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log("\na CLAUDE.md declaring standing approval allows launch even at awaiting-approval");

{
  const { r, stateDir, callsFile } = runLaunch({
    phase: 'awaiting-approval',
    claudeMd: '# Project\n\n## Unattended run\n\nThis project has standing approval to run /ship unattended.\n',
  });
  checkTrue('standing approval overrides the awaiting-approval gate: exits 0', r.status === 0);
  checkTrue('standing approval overrides the awaiting-approval gate: the driver was spawned',
    waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\non success, .ship-loop/feature, pass-prompt.md and the exclude line are written with exact content');

{
  const { r, repo, feature, stateDir } = runLaunch({});
  checkTrue('exits 0', r.status === 0);
  check('.ship-loop/feature has exact content', fs.readFileSync(path.join(repo, '.ship-loop', 'feature'), 'utf-8'),
    `${feature}\n`);
  const passPrompt = fs.readFileSync(path.join(repo, '.ship-loop', 'pass-prompt.md'), 'utf-8');
  check('.ship-loop/pass-prompt.md has exact content (matches the exported template)',
    passPrompt, launchMod.PASS_PROMPT_TEMPLATE);
  checkTrue('the template covers "do exactly one unit"', /exactly one unit/.test(passPrompt));
  checkTrue('the template names a parallel group as a unit', /parallel group/i.test(passPrompt));
  checkTrue('the template covers matching the commit before exiting',
    /run state and (?:the )?progress file must match the commit/.test(passPrompt));
  checkTrue('the template covers never asking the user', /[Nn]ever ask the user/.test(passPrompt));
  checkTrue('the template covers HARD_STOP', /HARD_STOP/.test(passPrompt));
  checkTrue('the template covers DONE', /\bDONE\b/.test(passPrompt));

  const excludeRel = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'],
    { cwd: repo, encoding: 'utf-8' }).stdout.trim();
  const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.join(repo, excludeRel);
  const excludeLines = fs.readFileSync(excludePath, 'utf-8').split('\n').filter(Boolean);
  // `git init` seeds info/exclude with its own commented-out boilerplate, so
  // the assertion is that .ship-loop/ is exactly one of the lines (added,
  // not clobbering what was already there), not that it is the whole file.
  check('the exclude file gained exactly one .ship-loop/ line',
    excludeLines.filter((l) => l === '.ship-loop/').length, 1);
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // MUST NOT: a second launch does not duplicate the exclude line.
  const { repo, feature, cfgDir } = mkReadyRun('executing', {});
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-state-'));
  const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-usage-'));
  const env = {
    ...process.env, CLAUDE_CONFIG_DIR: cfgDir, CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_JSON: mkConfigJson(usageDir, []),
    LAUNCH_TEST_CALLS_FILE: path.join(stateDir, 'calls.json'),
    SHIP_LOOP_DRIVER: mkFakeDriver(stateDir),
  };
  spawnSync('node', [LAUNCH, '--feature', feature], { cwd: repo, encoding: 'utf-8', env });
  spawnSync('node', [LAUNCH, '--feature', feature], { cwd: repo, encoding: 'utf-8', env });
  const excludeRel = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'],
    { cwd: repo, encoding: 'utf-8' }).stdout.trim();
  const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.join(repo, excludeRel);
  const excludeLines = fs.readFileSync(excludePath, 'utf-8').split('\n').filter(Boolean);
  check('running the launcher twice does not duplicate the exclude line',
    excludeLines.filter((l) => l === '.ship-loop/').length, 1);
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\nthe detached spawn passes through --model/--plan-model, and leaves no live process behind');

{
  const { r, stateDir, callsFile } = runLaunch({ extraArgs: ['--model', 'fable', '--plan-model', 'haiku'] });
  checkTrue('exits 0', r.status === 0);
  checkTrue('the driver argv was recorded', waitForFile(callsFile, 3000));
  const argv = JSON.parse(fs.readFileSync(callsFile, 'utf-8'));
  const modelIdx = argv.indexOf('--model');
  const planModelIdx = argv.indexOf('--plan-model');
  checkTrue('--model was passed through to the driver', modelIdx >= 0 && argv[modelIdx + 1] === 'fable');
  checkTrue('--plan-model was passed through to the driver', planModelIdx >= 0 && argv[planModelIdx + 1] === 'haiku');
  checkTrue('the launcher printed the child PID', /pid\s+\d+/i.test(r.stdout));
  checkTrue('the launcher printed the log path', /log\.md/.test(r.stdout));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // MUST NOT: with neither flag given, the driver is started with no
  // --model/--plan-model argv at all (nothing to default here -- that is
  // bin/ship-loop.cjs's job).
  const { r, stateDir, callsFile } = runLaunch({});
  checkTrue('exits 0', r.status === 0);
  checkTrue('the driver argv was recorded', waitForFile(callsFile, 3000));
  const argv = JSON.parse(fs.readFileSync(callsFile, 'utf-8'));
  checkTrue('no --model flag when none was given', !argv.includes('--model'));
  checkTrue('no --plan-model flag when none was given', !argv.includes('--plan-model'));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // --pause-at is read by the launcher's own readiness check, but the driver
  // (bin/ship-loop.cjs) needs it too, for every later pass this launch starts
  // -- it must be forwarded the same way --model/--plan-model are.
  const { r, stateDir, callsFile } = runLaunch({ extraArgs: ['--pause-at', '80'] });
  checkTrue('exits 0', r.status === 0);
  checkTrue('the driver argv was recorded', waitForFile(callsFile, 3000));
  const argv = JSON.parse(fs.readFileSync(callsFile, 'utf-8'));
  const pauseAtIdx = argv.indexOf('--pause-at');
  checkTrue('--pause-at was passed through to the driver', pauseAtIdx >= 0 && argv[pauseAtIdx + 1] === '80');
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\nleftover STOP/DONE/HARD_STOP markers are checked before launch');

{
  // DONE means a previous run already finished -- relaunching would silently
  // do nothing, since the driver's first action is to see DONE and exit. The
  // launcher must refuse instead, and must not delete the marker: it is the
  // only record of why the earlier run stopped.
  const { r, repo, callsFile } = runLaunch({ markers: { DONE: 'DONE: all briefs shipped\n' } });
  checkTrue('DONE marker: refuses (non-zero exit)', r.status !== 0);
  checkTrue('DONE marker: prints the marker content', /DONE: all briefs shipped/.test(r.stdout + r.stderr));
  checkTrue('DONE marker: never spawns the driver', !fs.existsSync(callsFile));
  checkTrue('DONE marker: is left in place, not auto-deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'DONE')));
}

{
  const { r, repo, callsFile } = runLaunch({ markers: { HARD_STOP: 'HARD_STOP: missing credential\n' } });
  checkTrue('HARD_STOP marker: refuses (non-zero exit)', r.status !== 0);
  checkTrue('HARD_STOP marker: prints the marker content', /missing credential/.test(r.stdout + r.stderr));
  checkTrue('HARD_STOP marker: never spawns the driver', !fs.existsSync(callsFile));
  checkTrue('HARD_STOP marker: is left in place, not auto-deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'HARD_STOP')));
}

{
  // STOP means an earlier run was asked to stop after its pass -- but a fresh
  // `--unattended` invocation is an explicit request to run now, which
  // supersedes that. The launcher removes it (and says so) rather than
  // refusing on it forever.
  const { r, repo, stateDir, callsFile } = runLaunch({ markers: { STOP: '' } });
  checkTrue('STOP marker: exits 0 (a fresh launch supersedes an earlier stop)', r.status === 0);
  checkTrue('STOP marker: the driver was spawned', waitForFile(callsFile, 3000));
  checkTrue('STOP marker: is removed before launch',
    !fs.existsSync(path.join(repo, '.ship-loop', 'STOP')));
  checkTrue('STOP marker: says it removed the stop file', /STOP/.test(r.stdout));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // A leftover STOP alongside a dirty tree must still refuse for the
  // dirty-tree reason -- and, since the launch never proceeds, STOP must be
  // left in place rather than silently disappearing on a refused launch.
  const { r, repo, callsFile } = runLaunch({ markers: { STOP: '' }, dirty: true });
  checkTrue('STOP marker + dirty tree: refuses (non-zero exit)', r.status !== 0);
  checkTrue('STOP marker + dirty tree: never spawns the driver', !fs.existsSync(callsFile));
  checkTrue('STOP marker + dirty tree: STOP is left in place, not deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'STOP')));
}

{
  // Same as above, but refused on the wrong-branch check instead of a dirty
  // tree -- round 3's reviewer confirmed this manually; this is that check
  // made automatic.
  const { r, repo, callsFile } = runLaunch({
    markers: { STOP: '' }, branch: 'feature/x', checkoutBranch: 'master',
  });
  checkTrue('STOP marker + wrong branch: refuses (non-zero exit)', r.status !== 0);
  checkTrue('STOP marker + wrong branch: never spawns the driver', !fs.existsSync(callsFile));
  checkTrue('STOP marker + wrong branch: STOP is left in place, not deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'STOP')));
}

{
  const { r, repo, callsFile } = runLaunch({
    markers: { STOP: '' },
    configLimits: [{ kind: 'session', group: 'default', percent: 97, severity: 'critical',
      resets_at: new Date(Date.now() + 3600000).toISOString(), scope: 'org', is_active: true }],
  });
  checkTrue('STOP marker + usage over pauseAt: refuses (non-zero exit)', r.status !== 0);
  checkTrue('STOP marker + usage over pauseAt: never spawns the driver', !fs.existsSync(callsFile));
  checkTrue('STOP marker + usage over pauseAt: STOP is left in place, not deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'STOP')));
}

{
  const { r, repo, callsFile } = runLaunch({
    markers: { STOP: '' },
    phase: 'awaiting-approval', claudeMd: '# Project\nNo standing approval here.\n',
  });
  checkTrue('STOP marker + awaiting-approval with no standing approval: refuses (non-zero exit)', r.status !== 0);
  checkTrue('STOP marker + awaiting-approval with no standing approval: never spawns the driver',
    !fs.existsSync(callsFile));
  checkTrue('STOP marker + awaiting-approval with no standing approval: STOP is left in place, not deleted',
    fs.existsSync(path.join(repo, '.ship-loop', 'STOP')));
}

// =============================================================================
console.log('\ncheckCleanTree only exempts the launcher\'s own managed state files under .ship-loop/, not arbitrary tracked content there');

{
  // Confirmed by round 3's reviewer: excluding the whole .ship-loop/ directory
  // also hid a modified *tracked* file living there, not just the launcher's
  // own untracked runtime markers. A project that (unusually) commits
  // something under .ship-loop/ must still get a normal dirty-tree check on it.
  const { r, stateDir, callsFile } = runLaunch({
    extraFiles: (repo) => {
      const shipDir = path.join(repo, '.ship-loop');
      fs.mkdirSync(shipDir, { recursive: true });
      fs.writeFileSync(path.join(shipDir, 'tracked.txt'), 'seed\n');
      spawnSync('git', ['add', '.ship-loop/tracked.txt'], { cwd: repo });
      spawnSync('git', ['commit', '-q', '-m', 'add tracked file under .ship-loop'], { cwd: repo });
      fs.writeFileSync(path.join(shipDir, 'tracked.txt'), 'modified\n');
    },
  });
  checkTrue('modified tracked file under .ship-loop/: refuses (non-zero exit)', r.status !== 0);
  checkTrue('modified tracked file under .ship-loop/: names the check',
    /not clean|dirty|git status/i.test(r.stdout + r.stderr));
  checkTrue('modified tracked file under .ship-loop/: never spawns the driver', !fs.existsSync(callsFile));
  if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  // MUST NOT: the launcher's own untracked runtime files -- including the
  // glob-matched pass-*.jsonl -- still don't count as dirty.
  const { r, stateDir, callsFile } = runLaunch({
    extraFiles: (repo) => {
      const shipDir = path.join(repo, '.ship-loop');
      fs.mkdirSync(shipDir, { recursive: true });
      fs.writeFileSync(path.join(shipDir, 'pass-001.jsonl'), '{}\n');
      fs.writeFileSync(path.join(shipDir, 'log.md'), '# log\n');
    },
  });
  checkTrue('untracked pass-*.jsonl and log.md under .ship-loop/: exits 0 (still exempt)', r.status === 0);
  checkTrue('untracked pass-*.jsonl and log.md under .ship-loop/: the driver was spawned',
    waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\nthe launcher resolves the repo root via `git rev-parse --show-toplevel`, not process.cwd()');

{
  // Launched from a project subdirectory, .ship-loop/ must land at the repo
  // root -- not scattered into the subdirectory -- and the driver (spawned
  // with the same cwd) must inherit the root too.
  let subdir = null;
  const { r, repo, stateDir, callsFile } = runLaunch({
    extraFiles: (repoRoot) => {
      subdir = path.join(repoRoot, 'sub', 'dir');
      fs.mkdirSync(subdir, { recursive: true });
    },
    cwd: () => subdir,
  });
  checkTrue('launched from a subdirectory: exits 0', r.status === 0);
  checkTrue('launched from a subdirectory: .ship-loop/feature is written at the repo root',
    fs.existsSync(path.join(repo, '.ship-loop', 'feature')));
  checkTrue('launched from a subdirectory: .ship-loop/ is not scattered into the subdirectory',
    !fs.existsSync(path.join(subdir, '.ship-loop')));
  checkTrue('launched from a subdirectory: the driver was spawned', waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// =============================================================================
console.log('\nrunStateGet spawns the run-state.cjs subprocess via process.execPath, not a bare \'node\' lookup on PATH');

{
  // A directory prepended to PATH containing a `node` that is not the real
  // interpreter (as a differently-versioned or unrelated `node` earlier on
  // PATH would be) must not derail runStateGet's own spawnSync call the way
  // it would if that call still searched PATH for 'node' instead of using
  // process.execPath, the way the rest of the file's spawn calls already do.
  // The outer invocation of the launcher itself is started via process.execPath
  // directly (bypassing runLaunch's bare 'node') so this fixture only exercises
  // PATH resolution *inside* the launcher's own subprocess call.
  const fakeNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-fakenode-'));
  const fakeNode = path.join(fakeNodeDir, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(fakeNode, 0o755);

  const { repo, feature, cfgDir } = mkReadyRun('executing', {});
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-state-'));
  const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-launch-usage-'));
  const callsFile = path.join(stateDir, 'calls.json');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfgDir,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_CONFIG_JSON: mkConfigJson(usageDir, []),
    LAUNCH_TEST_CALLS_FILE: callsFile,
    SHIP_LOOP_DRIVER: mkFakeDriver(stateDir),
    PATH: `${fakeNodeDir}${path.delimiter}${process.env.PATH}`,
  };
  const r = spawnSync(process.execPath, [LAUNCH, '--feature', feature], { cwd: repo, encoding: 'utf-8', env });
  checkTrue('a broken node earlier on PATH: exits 0 (runStateGet is unaffected by PATH)', r.status === 0);
  checkTrue('a broken node earlier on PATH: the driver was spawned', waitForFile(callsFile, 3000));
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(fakeNodeDir, { recursive: true, force: true });
}

// =============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
