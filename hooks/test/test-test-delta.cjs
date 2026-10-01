#!/usr/bin/env node
// Behavioural tests for the failing-test baseline and delta.
// Run: node ~/.claude/hooks/test/test-test-delta.cjs
//
//   test-delta.cjs   detects the suite, records which tests fail, reports what
//                    CHANGED — because "the suite is red" is not information in
//                    a repository whose suite was already red.
//
// The parsing and the comparison are tested against captured output rather than
// by running real suites: a test that needs a 10-second pytest run to assert a
// regex gets deleted the first time it is in the way.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

// hooks/test/test-test-delta.cjs -> hooks/test -> hooks: resolve from the
// script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');
const D = require(path.join(HOOKS, 'test-delta.cjs'));
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

const trash = [];
const dir = (files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  trash.push(d);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return d;
};

// =============================================================================
console.log('\ntest-delta.cjs — finding the suite');

check('pytest.ini means pytest', D.detectRunner(dir({ 'pytest.ini': '[pytest]\n' }))?.name, 'pytest');
check('a pyproject with a pytest section means pytest',
  D.detectRunner(dir({ 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["t"]\n' }))?.name, 'pytest');
check('a package.json with a test script means npm',
  D.detectRunner(dir({ 'package.json': '{"scripts":{"test":"vitest run"}}' }))?.name, 'npm');
check('a Makefile with a test target means make',
  D.detectRunner(dir({ 'Makefile': 'build:\n\tgo build\n\ntest:\n\tgo test ./...\n' }))?.name, 'make');

// MUST NOT guess. Most repositories have no suite, and inventing one for them is
// how this turns into noise that gets switched off.
check('a repo with no suite gets no runner', D.detectRunner(dir({ 'README.md': '# x\n' })), null);
check('a pyproject with no pytest section is not a pytest repo',
  D.detectRunner(dir({ 'pyproject.toml': '[project]\nname = "x"\n' })), null);
check('a package.json whose test script is the npm placeholder is not a suite',
  D.detectRunner(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
// Precedence matters only because a repo can carry both; pytest first is a
// choice about this estate, not a claim about the world.
check('pytest wins over npm when a repo has both',
  D.detectRunner(dir({ 'pytest.ini': '[pytest]\n', 'package.json': '{"scripts":{"test":"vitest"}}' }))?.name, 'pytest');

// =============================================================================
console.log('\ntest-delta.cjs — reading which tests failed');

const PYTEST_OUT = `
backend/tests/test_a.py .....F..                                         [ 30%]
backend/tests/test_b.py ..E                                              [100%]

=========================== short test summary info ============================
FAILED backend/tests/test_a.py::test_one - AssertionError: 1 != 2
FAILED backend/tests/test_a.py::test_two[case-3] - ValueError
ERROR backend/tests/test_b.py::test_three - fixture 'db' not found
=================== 2 failed, 118 passed, 1 error in 3.14s =====================
`;

check('pytest failures are read as node ids', D.failuresFrom('pytest', PYTEST_OUT), [
  'backend/tests/test_a.py::test_one',
  'backend/tests/test_a.py::test_two[case-3]',
  'backend/tests/test_b.py::test_three',
]);
// An error is a failure for this purpose: the test did not pass, and a
// collection error is exactly the regression a merge introduces.
check('a collection error counts', D.failuresFrom('pytest', PYTEST_OUT).includes('backend/tests/test_b.py::test_three'), true);
// MUST NOT read the progress line. `.....F..` names no test and matching it
// would make every run differ from every other.
check('the progress line contributes nothing',
  D.failuresFrom('pytest', 'backend/tests/test_a.py .....F..   [ 30%]\n'), []);
check('a green run has no failures',
  D.failuresFrom('pytest', '=============== 1280 passed, 8 skipped in 9.82s ================\n'), []);

// The summary lines only. A `-v` run prints one line per test WITH its node id,
// and matching a node id anywhere in the output records every passing test as a
// failure -- a delta that reports the whole suite as newly broken.
check('a verbose run\'s passing lines are not failures', D.failuresFrom('pytest', `
backend/tests/test_a.py::test_one PASSED                                 [ 50%]
backend/tests/test_a.py::test_two FAILED                                 [100%]

=========================== short test summary info ============================
FAILED backend/tests/test_a.py::test_two - AssertionError
`), ['backend/tests/test_a.py::test_two']);

// The generic reader is deliberately cruder: it keeps whole lines that announce
// a failure. It cannot tell a renamed test from a new one, which is why pytest
// gets its own reader.
check('the generic reader keeps failure lines', D.failuresFrom('npm', `
 ✓ src/a.test.ts (3)
 ✗ src/b.test.ts > adds numbers
 FAIL src/c.test.ts > subtracts
 Tests  2 failed | 1 passed
`), ['FAIL src/c.test.ts > subtracts', '✗ src/b.test.ts > adds numbers']);
check('and drops the passing ones', D.failuresFrom('npm', ' ✓ src/a.test.ts (3)\n'), []);

// =============================================================================
console.log('\ntest-delta.cjs — what changed');
{
  const base = ['a::x', 'b::y'];
  const now = ['b::y', 'c::z'];
  check('a test that newly fails is the finding', D.compare(base, now).newly, ['c::z']);
  check('one that stopped failing is reported too', D.compare(base, now).fixed, ['a::x']);
  check('and the pre-existing red is not', D.compare(base, now).stillFailing, ['b::y']);
  check('a run that changes nothing has nothing to say', D.compare(base, base).newly, []);
  // The whole point: a suite that was already 9-red stays quiet at 9 red.
  check('an unchanged red baseline is not a regression',
    D.compare(['a', 'b', 'c'], ['c', 'b', 'a']).newly, []);
}

// =============================================================================
console.log('\ntest-delta.cjs — the baseline is per repository AND per branch');
{
  const conf = dir();
  const p1 = D.baselinePath(conf, '/repos/thing', 'main');
  const p2 = D.baselinePath(conf, '/repos/thing', 'feature/x');
  const p3 = D.baselinePath(conf, '/repos/other', 'main');
  check('two branches of one repo do not share a baseline', p1 === p2, false);
  check('two repos on the same branch do not share one', p1 === p3, false);
  check('the same repo and branch resolve to the same file',
    p1 === D.baselinePath(conf, '/repos/thing', 'main'), true);
  check('a branch name with a slash does not become a directory',
    path.dirname(p2), path.dirname(p1));
  // Regression: a caller that predates --command must resolve to exactly the
  // hash it always did. Someone upgrading with a recorded red baseline finds
  // no baseline under a changed hash and silently re-baselines current red as
  // clean if this ever drifts.
  const expectedNoCommandHash = crypto.createHash('sha256').update('/repos/thing\nmain').digest('hex').slice(0, 32);
  check('the no-command hash is byte-for-byte what it was before --command existed',
    path.basename(p1, '.json'), expectedNoCommandHash);
}

// =============================================================================
// --command: a single suite run keyed by (root, branch, command), with a
// retry that tells a flake from a real regression per Decision 8.
console.log('\ntest-delta.cjs --command — the ^^ FAILED line verify-all.cjs prints');

// False pass this guards against: a parser that only keeps lines starting
// with FAIL/FAILED passes every pytest case above and still drops the line
// verify-all.cjs actually prints for a red unit suite, because that line
// starts with `^^`, not `FAILED`.
check('a verify-all-shaped failure line is read as a failure',
  D.failuresFrom('npm', '  ^^ FAILED (exit 1): node test-gates.cjs\n'),
  ['^^ FAILED (exit 1): node test-gates.cjs']);
check('a verify-all-shaped PASS-adjacent line stays out', D.failuresFrom('npm', 'ok\n'), []);

// Rule 5: `--command` mode strips a generic failure line's volatile timing
// tail (jest/vitest print one per test) before the line is stored or
// compared, so the exact SAME failure read on two different runs is not read
// as two different lines merely because the clock moved. Scoped to
// `commandFailuresFrom`, not the shared `failuresFrom` the no-`--command`
// path also uses -- that path's behaviour must stay exactly what it was.
console.log('\ntest-delta.cjs --command — a volatile timing tail is normalised away');
check('the no-command reader does NOT normalise (byte-for-byte unchanged)',
  D.failuresFrom('npm', 'FAIL src/a.test.js (1.234 s)\n'), ['FAIL src/a.test.js (1.234 s)']);
check('a seconds-style jest timing tail is stripped for --command',
  D.commandFailuresFrom('npm', 'FAIL src/a.test.js (1.234 s)\n'), ['FAIL src/a.test.js']);
check('a milliseconds-style timing tail is stripped too',
  D.commandFailuresFrom('npm', 'FAIL src/a.test.js (120ms)\n'), ['FAIL src/a.test.js']);
check('two runs of the same failing test with different elapsed times normalise identically',
  D.commandFailuresFrom('npm', 'FAIL src/a.test.js (0.9 s)\n'),
  D.commandFailuresFrom('npm', 'FAIL src/a.test.js (3.4 s)\n'));

console.log('\ntest-delta.cjs --command — the baseline is keyed by command too');
{
  const conf = dir();
  const a = D.baselinePath(conf, '/repos/thing', 'main', 'pytest -q');
  const b = D.baselinePath(conf, '/repos/thing', 'main', 'npm test');
  check('two commands on one branch do not share a baseline', a === b, false);
  check('the same repo, branch and command resolve to the same file',
    a === D.baselinePath(conf, '/repos/thing', 'main', 'pytest -q'), true);
}

console.log('\ntest-delta.cjs --command — end to end against a throwaway repo');
{
  // A scratch CLAUDE_CONFIG_DIR and repo, exactly as the house rules require:
  // never the real ~/.claude/state.
  const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cmd-config-'));
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cmd-repo-'));
  trash.push(CONFIG, REPO);
  const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# x\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);

  // A fixture "runner": pass/fail is driven by an on-disk call counter and a
  // list of call numbers that should fail, so ONE test-delta invocation can
  // make it fail on its first call and pass on a later one (or keep failing)
  // without the test editing the script between runs.
  const FAKE_RUNNER = [
    "const fs = require('fs');",
    'const [, , stateFile, failOnCsv] = process.argv;',
    "const failOn = new Set((failOnCsv || '').split(',').filter(Boolean).map(Number));",
    'let n = 0;',
    "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
    'n += 1;',
    'fs.writeFileSync(stateFile, String(n));',
    // The failure line names the case, not the call number: a real flaky test
    // fails with the same node id every time it fails, so the delta's line
    // comparison must see repeats of that failure as the SAME line, not a
    // new one each call.
    "if (failOn.has(n)) { console.log('FAILED fake::case'); process.exit(1); }",
    "console.log('ok call ' + n);",
    'process.exit(0);',
  ].join('\n');
  const fakeDir = dir({ 'fake.js': FAKE_RUNNER });
  const fakePath = path.join(fakeDir, 'fake.js');

  // Portable stand-ins for `cat` and `tail -50` (neither exists under cmd.exe):
  // both exit 0 whatever the upstream program did, which is the property these
  // scenarios rely on. Like the real `tail`, the tail stand-in treats any
  // non-flag argument as a FILE to read instead of stdin, so an id blindly
  // appended after it fails the same way it would with the real thing.
  fs.writeFileSync(path.join(fakeDir, 'pipe-cat.js'), "process.stdin.pipe(process.stdout);\n");
  fs.writeFileSync(path.join(fakeDir, 'pipe-tail.js'), [
    "const fs = require('fs');",
    "const file = process.argv.slice(2).find((a) => !a.startsWith('-'));",
    "let text = '';",
    "try { text = fs.readFileSync(file === undefined ? 0 : file, 'utf8'); } catch (e) { console.error('pipe-tail: ' + e.message); process.exit(0); }",
    "process.stdout.write(text.split('\\n').slice(-50).join('\\n'));",
  ].join('\n'));
  const pipeCat = `node ${JSON.stringify(path.join(fakeDir, 'pipe-cat.js'))}`;
  const pipeTail = `node ${JSON.stringify(path.join(fakeDir, 'pipe-tail.js'))} -50`;

  const BIN = path.join(HOOKS, 'test-delta.cjs');
  const runDelta = (command) => spawnSync('node', [BIN, '--command', command], {
    cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
  });

  // Persistent: call 1 (the baseline) passes; calls 2 and 3 (the run, then
  // its automatic re-run) both fail.
  const statePersist = path.join(fakeDir, 'calls-persist.txt');
  const cmdPersist = `node ${JSON.stringify(fakePath)} ${JSON.stringify(statePersist)} 2,3`;
  const p1 = runDelta(cmdPersist);
  check('a first --command run with no baseline records one and exits green', p1.status, 0);
  const p2 = runDelta(cmdPersist);
  check('a red exit after a green baseline reports NEWLY FAILING', /NEWLY FAILING/.test(p2.stdout), true);
  check('a failure that persists on the re-run exits non-zero (blocking)', p2.status === 0, false);

  // Flaky: call 1 (the baseline) passes; call 2 (the run) fails; call 3
  // (the automatic re-run) passes again.
  const stateFlaky = path.join(fakeDir, 'calls-flaky.txt');
  const cmdFlaky = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateFlaky)} 2`;
  const f1 = runDelta(cmdFlaky);
  check('the flaky scenario\'s baseline call exits green', f1.status, 0);
  const f2 = runDelta(cmdFlaky);
  check('a failure that disappears on the re-run is reported FLAKY', /FLAKY/.test(f2.stdout), true);
  check('a flaky failure exits green (non-blocking)', f2.status, 0);

  // A second fixture with no FAIL/FAILED line at all, so a case built on it
  // cannot pass merely because the shared fixture always prints one: it
  // isolates the 0-exit-code -> non-zero-exit-code rule from the failure-line
  // comparison that every other case above also exercises.
  const FAKE_RUNNER_SILENT = [
    "const fs = require('fs');",
    'const [, , stateFile, failOnCsv] = process.argv;',
    "const failOn = new Set((failOnCsv || '').split(',').filter(Boolean).map(Number));",
    'let n = 0;',
    "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
    'n += 1;',
    'fs.writeFileSync(stateFile, String(n));',
    "if (failOn.has(n)) { console.log('boom'); process.exit(1); }",
    "console.log('ok call ' + n);",
    'process.exit(0);',
  ].join('\n');
  fs.writeFileSync(path.join(fakeDir, 'fake-silent.js'), FAKE_RUNNER_SILENT);
  const silentPath = path.join(fakeDir, 'fake-silent.js');

  console.log('\ntest-delta.cjs --command — 0-to-non-zero exit alone triggers NEWLY FAILING');
  {
    // Call 1 (baseline) passes; calls 2 and 3 (run, then its re-run) both
    // fail, but neither prints anything failuresFrom can match. Only the
    // exit code moves.
    const stateSilent = path.join(fakeDir, 'calls-silent.txt');
    const cmdSilent = `node ${JSON.stringify(silentPath)} ${JSON.stringify(stateSilent)} 2,3`;
    const s1 = runDelta(cmdSilent);
    check('the silent scenario\'s baseline call exits green', s1.status, 0);
    const s2 = runDelta(cmdSilent);
    check('an exit-code-only regression (no matched failure line) is still NEWLY FAILING',
      /NEWLY FAILING/.test(s2.stdout), true);
    check('and still exits non-zero', s2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — a pipe that swallows the exit code is still caught by line reappearance');
  {
    // `node x.js | cat`: cat always exits 0, so the whole pipeline's exit
    // code never reflects x.js's own failure. A verdict that trusts the exit
    // code alone reads every run as green and calls a genuinely persistent
    // regression FLAKY forever. Call 1 (baseline) passes; calls 2 and 3 (the
    // run, then its automatic re-run) both fail and print the SAME failure
    // line -- but the pipe means first.code and second.code are both 0.
    const statePipe = path.join(fakeDir, 'calls-pipe.txt');
    const cmdPipe = `node ${JSON.stringify(fakePath)} ${JSON.stringify(statePipe)} 2,3 | ${pipeCat}`;
    const pp1 = runDelta(cmdPipe);
    check('the piped scenario\'s baseline call exits green', pp1.status, 0);
    const pp2 = runDelta(cmdPipe);
    check('a failure line that reappears behind a pipe is NEWLY FAILING, not FLAKY, even though the exit code stayed 0',
      /NEWLY FAILING/.test(pp2.stdout), true);
    check('and it exits non-zero (the pipe cannot swallow the verdict itself)', pp2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — the command is part of the baseline key, end to end');
  {
    // Two distinct commands, same repo and branch, each passing on every
    // call. If `command` were ever dropped from the baseline key, the second
    // command would find the first command's already-recorded baseline
    // instead of starting fresh.
    const stateKeyA = path.join(fakeDir, 'calls-keyA.txt');
    const stateKeyB = path.join(fakeDir, 'calls-keyB.txt');
    const cmdKeyA = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateKeyA)}`;
    const cmdKeyB = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateKeyB)}`;
    const ka1 = runDelta(cmdKeyA);
    check('command A\'s first run establishes its own baseline', /no baseline existed/.test(ka1.stdout), true);
    const kb1 = runDelta(cmdKeyB);
    check('a different command on the same repo/branch gets its OWN fresh baseline, not command A\'s',
      /no baseline existed/.test(kb1.stdout), true);
  }

  console.log('\ntest-delta.cjs --command — pytest re-run does not blindly append ids across shell operators');
  {
    // "pytest" makes readerFor pick the pytest reader; `| tail -50` is a real
    // shell operator (it matches HAS_SHELL_OPERATORS the same as `;` would).
    // Blindly appending a node id after it would make `tail` try to open a
    // file named after the node id instead of reading its piped stdin, so
    // the re-run's output would carry no failure line at all -- this is not
    // a cosmetic difference: a command ending in an ordinary argument (e.g.
    // `2>&1`) tolerates an appended id just fine, which is why that shape
    // does not actually exercise the guard. The pipe also swallows the exit
    // code (`tail` always exits 0), so this case proves both that the id is
    // not spliced in AND that the whole-command re-run still sees the
    // regression by line reappearance, not by exit code.
    const stateOp = path.join(fakeDir, 'calls-operator.txt');
    const cmdOp = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateOp)} 2,3 pytest | ${pipeTail}`;
    const o1 = runDelta(cmdOp);
    check('the operator scenario\'s baseline call exits green', o1.status, 0);
    const o2 = runDelta(cmdOp);
    check('a failure that persists behind a pipe is still reported NEWLY FAILING, not corrupted into FLAKY',
      /NEWLY FAILING/.test(o2.stdout), true);
    check('and it still exits non-zero', o2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — pytest subset re-run actually appends the new node id, and judges it independently');
  {
    // A runner that logs the extra CLI arguments it was called with, so the
    // test can see from outside whether the automatic re-run actually
    // appended the new node id (proving the subset path ran at all) rather
    // than re-running the whole command unchanged. It fails only on call 2
    // (the run); call 3 (the subset re-run, called WITH the id appended)
    // passes -- a node id that a "mark every subset id persisted" bug, or a
    // "the subset path never runs" bug (which would fall back to the whole
    // command, still just re-executing the same fixture), would both need to
    // be checked against independently for this case to actually catch them.
    const FAKE_RUNNER_PYTEST_LOG = [
      "const fs = require('fs');",
      'const [, , stateFile, logFile, failOnCsv, ...rest] = process.argv;',
      "fs.appendFileSync(logFile, JSON.stringify(rest) + '\\n');",
      "const failOn = new Set((failOnCsv || '').split(',').filter(Boolean).map(Number));",
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "if (failOn.has(n)) { console.log('FAILED fake::subsetcase'); process.exit(1); }",
      "console.log('ok call ' + n);",
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-pytest-log.js'), FAKE_RUNNER_PYTEST_LOG);
    const logRunnerPath = path.join(fakeDir, 'fake-pytest-log.js');
    const stateSubset = path.join(fakeDir, 'calls-subset.txt');
    const logSubset = path.join(fakeDir, 'log-subset.txt');
    const cmdSubset = `node ${JSON.stringify(logRunnerPath)} ${JSON.stringify(stateSubset)} ${JSON.stringify(logSubset)} 2 pytest`;
    const su1 = runDelta(cmdSubset);
    check('the subset scenario\'s baseline call exits green', su1.status, 0);
    const su2 = runDelta(cmdSubset);
    check('the subset re-run was actually called with the new node id appended, not the whole command unchanged',
      fs.readFileSync(logSubset, 'utf8').trim().split('\n').pop(), JSON.stringify(['pytest', 'fake::subsetcase']));
    check('a node id that passes on the subset re-run is FLAKY, not persisted', /FLAKY/.test(su2.stdout), true);
    check('and it exits green (non-blocking)', su2.status, 0);
  }

  console.log('\ntest-delta.cjs --command — the subset re-run quotes a node id safely for the shell ($ and ` are not shell-expanded)');
  {
    // JSON.stringify produces a DOUBLE-quoted string, and `sh -c` still expands
    // `$` and backtick inside double quotes: `$5` reads as a positional
    // parameter (empty) and `` `x` `` runs `x` as a command substitution. A
    // node id built from a parametrize id containing either is corrupted
    // before pytest ever sees it, and the corrupted argument logged below
    // proves it -- this must equal ['pytest', SPECIAL_ID] byte for byte.
    const SPECIAL_ID = 'fake::p[$5-`x`]';
    const FAKE_RUNNER_PYTEST_LOG_SPECIAL = [
      "const fs = require('fs');",
      'const [, , stateFile, logFile, failOnCsv, ...rest] = process.argv;',
      "fs.appendFileSync(logFile, JSON.stringify(rest) + '\\n');",
      "const failOn = new Set((failOnCsv || '').split(',').filter(Boolean).map(Number));",
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "if (failOn.has(n)) { console.log('FAILED fake::p[$5-`x`]'); process.exit(1); }",
      "console.log('ok call ' + n);",
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-pytest-log-special.js'), FAKE_RUNNER_PYTEST_LOG_SPECIAL);
    const logSpecialRunnerPath = path.join(fakeDir, 'fake-pytest-log-special.js');
    const stateSpecial = path.join(fakeDir, 'calls-special.txt');
    const logSpecial = path.join(fakeDir, 'log-special.txt');
    const cmdSpecial = `node ${JSON.stringify(logSpecialRunnerPath)} ${JSON.stringify(stateSpecial)} ${JSON.stringify(logSpecial)} 2 pytest`;
    const sp1 = runDelta(cmdSpecial);
    check('the special-id scenario\'s baseline call exits green', sp1.status, 0);
    const sp2 = runDelta(cmdSpecial);
    const lastLog = fs.readFileSync(logSpecial, 'utf8').trim().split('\n').pop();
    check('the subset re-run receives the $-and-backtick id literally, not shell-expanded',
      lastLog, JSON.stringify(['pytest', SPECIAL_ID]));
  }

  console.log('\ntest-delta.cjs --command — node ids are quoted for the shell of the platform they run on');
  {
    // Checked with an explicit platform so both branches run everywhere.
    check('posix: an id is single-quoted', D.quoteNodeId('a::b[1]', 'linux'), "'a::b[1]'");
    check('posix: an embedded single quote is closed-escaped-reopened',
      D.quoteNodeId("a'b", 'linux'), `'a'\\''b'`);
    // cmd.exe has no single quotes: they reach the program verbatim, so
    // pytest would look for a test literally named `'a::b'`.
    check('win32: an id is double-quoted', D.quoteNodeId('a::b[1]', 'win32'), '"a::b[1]"');
    check('win32: cmd metacharacters stay inside the double quotes',
      D.quoteNodeId('a::b[x&y|z^<>]', 'win32'), '"a::b[x&y|z^<>]"');
    check('win32: a trailing backslash is doubled so it cannot escape the closing quote',
      D.quoteNodeId('a\\b\\', 'win32'), '"a\\b\\\\"');
    // These cannot be made literal inside a cmd.exe double-quoted word, so the
    // caller must fall back to re-running the whole command.
    check('win32: an embedded double quote cannot be quoted', D.quoteNodeId('a"b', 'win32'), null);
    check('win32: a percent sign (cmd variable expansion) cannot be quoted', D.quoteNodeId('a[100%]', 'win32'), null);
    check('win32: a newline cannot be quoted', D.quoteNodeId('a\nb', 'win32'), null);
  }

  console.log('\ntest-delta.cjs --command — a subset re-run that exits neither 0 nor 1 is treated as persisting, not FLAKY');
  {
    // pytest exits 4 ("no tests ran") when a selected node id no longer
    // exists; no ids come back on such a re-run, so judging persistence
    // purely by "did the id reappear" reads every one of them as FLAKY and
    // exits 0 -- waving a real regression through. Call 1 (baseline) passes.
    // Call 2 (the run) fails with a genuine node id. Call 3 (the subset
    // re-run) exits 4 and prints no failure line at all, simulating pytest's
    // "no tests ran" rather than the test itself having passed.
    const FAKE_RUNNER_EXIT4 = [
      "const fs = require('fs');",
      'const [, , stateFile] = process.argv;',
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "if (n === 1) { console.log('ok call 1'); process.exit(0); }",
      "if (n === 2) { console.log('FAILED fake::case'); process.exit(1); }",
      'process.exit(4);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-exit4.js'), FAKE_RUNNER_EXIT4);
    const exit4Path = path.join(fakeDir, 'fake-exit4.js');
    const stateExit4 = path.join(fakeDir, 'calls-exit4.txt');
    const cmdExit4 = `node ${JSON.stringify(exit4Path)} ${JSON.stringify(stateExit4)} pytest`;
    const e1 = runDelta(cmdExit4);
    check('the exit-4 scenario\'s baseline call exits green', e1.status, 0);
    const e2 = runDelta(cmdExit4);
    check('a subset re-run exiting 4 with no failure lines is still reported NEWLY FAILING, not FLAKY',
      /NEWLY FAILING/.test(e2.stdout), true);
    check('and it exits non-zero (blocking)', e2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — a node id containing an embedded single quote cannot break out of shellQuote\'s single-quoting on the subset re-run');
  {
    // A "legal no-space parametrize id" (per the review finding) that closes
    // the single quote, injects `;`, and uses `${IFS}` in place of a literal
    // space (parametrize ids never contain spaces) to spell `touch PWNED...`
    // as a second shell command. If shellQuote's embedded-`'` escape
    // (`'\\''`) were ever removed, the naive `'${id}'` wrapping would let the
    // shell read this as `'...['` (closed) `; touch${IFS}PWNED...; '` `]'`
    // (reopened) -- three separate commands instead of one quoted argument --
    // and the middle one creates a real file in the repo root on the re-run.
    const DANGEROUS_ID = "test_q.py::test_case[';touch${IFS}PWNED_QUOTE_TEST;']";
    const PWNED_MARKER = path.join(REPO, 'PWNED_QUOTE_TEST');
    const FAKE_RUNNER_PYTEST_LOG_QUOTE = [
      "const fs = require('fs');",
      'const [, , stateFile, logFile, ...rest] = process.argv;',
      "fs.appendFileSync(logFile, JSON.stringify(rest) + '\\n');",
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      `if (n === 2) { console.log('FAILED ' + ${JSON.stringify(DANGEROUS_ID)}); process.exit(1); }`,
      "console.log('ok call ' + n);",
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-pytest-log-quote.js'), FAKE_RUNNER_PYTEST_LOG_QUOTE);
    const quoteRunnerPath = path.join(fakeDir, 'fake-pytest-log-quote.js');
    const stateQuote = path.join(fakeDir, 'calls-quote.txt');
    const logQuote = path.join(fakeDir, 'log-quote.txt');
    const cmdQuote = `node ${JSON.stringify(quoteRunnerPath)} ${JSON.stringify(stateQuote)} ${JSON.stringify(logQuote)} pytest`;
    const q1 = runDelta(cmdQuote);
    check('the quote-id scenario\'s baseline call exits green', q1.status, 0);
    if (fs.existsSync(PWNED_MARKER)) fs.unlinkSync(PWNED_MARKER);
    const q2 = runDelta(cmdQuote);
    const lastQuoteLog = fs.readFileSync(logQuote, 'utf8').trim().split('\n').pop();
    check('the subset re-run receives the embedded-quote id as ONE literal argument, not split by the shell',
      lastQuoteLog, JSON.stringify(['pytest', DANGEROUS_ID]));
    check('the shell did not run the touch smuggled inside the id (no marker file was created)',
      fs.existsSync(PWNED_MARKER), false);
    if (fs.existsSync(PWNED_MARKER)) fs.unlinkSync(PWNED_MARKER);
  }

  console.log('\ntest-delta.cjs --command — a subset re-run killed by a signal is reported NEWLY FAILING, not FLAKY');
  {
    // Regression: `r.status === null ? 1 : r.status` mapped a signal-killed
    // re-run (our own timeout, an OOM kill, SIGSEGV...) to plain exit 1,
    // indistinguishable from "some ids failed". Rule 4 then trusted that run
    // and judged it by node-id reappearance -- but a killed pytest prints no
    // summary, so no ids come back, none of d.newly reappears, and a real
    // regression was reported FLAKY with exit 0. Call 1 (baseline) passes;
    // call 2 (the run) fails with a genuine node id; call 3 (the subset
    // re-run, invoked WITH that id appended) kills itself with SIGKILL
    // instead of exiting normally.
    const FAKE_RUNNER_SIGKILL = [
      "const fs = require('fs');",
      'const [, , stateFile] = process.argv;',
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "if (n === 1) { console.log('ok call 1'); process.exit(0); }",
      "if (n === 2) { console.log('FAILED fake::case'); process.exit(1); }",
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-sigkill.js'), FAKE_RUNNER_SIGKILL);
    const sigkillPath = path.join(fakeDir, 'fake-sigkill.js');
    const stateSigkill = path.join(fakeDir, 'calls-sigkill.txt');
    const cmdSigkill = `node ${JSON.stringify(sigkillPath)} ${JSON.stringify(stateSigkill)} pytest`;
    if (process.platform === 'win32') {
      // Windows has no POSIX signals: process.kill(pid, 'SIGKILL') is a plain
      // TerminateProcess that surfaces to the parent as ordinary exit code 1,
      // never as a signal, so there is no signal-killed child to construct.
      console.log('  skip (Windows has no signal delivery; a self-killed child reads as exit 1)');
    } else {
    const k1 = runDelta(cmdSigkill);
    check('the sigkill scenario\'s baseline call exits green', k1.status, 0);
    const k2 = runDelta(cmdSigkill);
    check('a subset re-run killed by a signal is reported NEWLY FAILING, confirmed, not waved through as FLAKY',
      /NEWLY FAILING/.test(k2.stdout), true);
    check('it must NOT be reported FLAKY', /FLAKY/.test(k2.stdout), false);
    check('and it exits non-zero (blocking)', k2.status === 0, false);
    }
  }

  console.log('\ntest-delta.cjs --command — a missing value errors instead of running the next flag as the shell command');
  {
    const r = spawnSync('node', [BIN, '--command', '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('--command with no value exits 2, not running "--baseline" as the shell command', r.status, 2);
  }

  console.log('\ntest-delta.cjs --command — rule 3: a RED baseline persists by line reappearance, not exit code');
  {
    // No shell operator here, deliberately: this isolates rule 3's second
    // clause (red baseline -> judged by whether the new line reappears) from
    // the exit-code question the redirect test above already covers. Call 1
    // (the explicit red baseline) has only the pre-existing failure; call 2 on
    // adds a second, genuinely new failure line that must be seen to persist
    // on the automatic re-run (call 3).
    const FAKE_RUNNER_TWO = [
      "const fs = require('fs');",
      'const [, , stateFile] = process.argv;',
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "console.log('FAILED fake::baseline');",
      "if (n >= 2) console.log('FAILED fake::new');",
      'process.exit(1);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-two.js'), FAKE_RUNNER_TWO);
    const twoPath = path.join(fakeDir, 'fake-two.js');
    const stateTwo = path.join(fakeDir, 'calls-red-line.txt');
    const cmdTwo = `node ${JSON.stringify(twoPath)} ${JSON.stringify(stateTwo)}`;
    const baseTwo = spawnSync('node', [BIN, '--command', cmdTwo, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('the red baseline (only the pre-existing failure) is recorded explicitly', baseTwo.status, 0);
    const t2 = runDelta(cmdTwo);
    check('a genuinely new failure line against a red baseline still reads NEWLY FAILING',
      /NEWLY FAILING/.test(t2.stdout), true);
    check('and it exits non-zero, not green', t2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — rule 3: a red baseline\'s new line that vanishes on rerun is FLAKY, not persisted');
  {
    // The pre-existing failure keeps the command red on every call, so exit
    // code stays non-zero on the run AND its automatic re-run regardless of
    // whether the NEW line is a real regression or a flake -- exit code
    // alone cannot distinguish the two here. Call 1 (explicit red baseline)
    // has only the pre-existing failure. Call 2 (the run) adds a second,
    // genuinely new line. Call 3 (the automatic re-run) loses that new line
    // again -- a flake -- while the pre-existing failure, and so the
    // non-zero exit code, remains. Judging by exit code (or by "a red
    // baseline always persists") would wrongly call this NEWLY FAILING.
    const FAKE_RUNNER_THREE = [
      "const fs = require('fs');",
      'const [, , stateFile] = process.argv;',
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "console.log('FAILED fake::baseline');",
      "if (n === 2) console.log('FAILED fake::new');",
      'process.exit(1);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-three.js'), FAKE_RUNNER_THREE);
    const threePath = path.join(fakeDir, 'fake-three.js');
    const stateThree = path.join(fakeDir, 'calls-red-flaky.txt');
    const cmdThree = `node ${JSON.stringify(threePath)} ${JSON.stringify(stateThree)}`;
    const baseThree = spawnSync('node', [BIN, '--command', cmdThree, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('the red baseline (only the pre-existing failure) is recorded explicitly', baseThree.status, 0);
    const t3 = runDelta(cmdThree);
    check('a new line that does not reappear on the re-run is FLAKY, even though the exit code stayed non-zero',
      /FLAKY/.test(t3.stdout), true);
    check('and it is not reported NEWLY FAILING', /NEWLY FAILING/.test(t3.stdout), false);
    check('so it exits green (non-blocking)', t3.status, 0);
  }

  console.log('\ntest-delta.cjs --command — root cause A: a differing timing tail does not hide a persistent regression');
  {
    // Baseline is green. The failure line's timing suffix differs between the
    // run that first goes red and its automatic re-run -- exactly like two
    // jest runs of the same broken test. Raw line equality (the old bug) would
    // see two different lines and call this FLAKY; a green baseline must be
    // judged on exit code alone (rule 3's first clause).
    const FAKE_RUNNER_JEST = [
      "const fs = require('fs');",
      'const [, , stateFile, failOnCsv] = process.argv;',
      "const failOn = new Set((failOnCsv || '').split(',').filter(Boolean).map(Number));",
      'let n = 0;',
      "try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}",
      'n += 1;',
      'fs.writeFileSync(stateFile, String(n));',
      "if (failOn.has(n)) { console.log('FAIL src/a.test.js (' + n + '.5 s)'); process.exit(1); }",
      "console.log('ok call ' + n);",
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(path.join(fakeDir, 'fake-jest.js'), FAKE_RUNNER_JEST);
    const jestPath = path.join(fakeDir, 'fake-jest.js');
    const stateJest = path.join(fakeDir, 'calls-jest.txt');
    const cmdJest = `node ${JSON.stringify(jestPath)} ${JSON.stringify(stateJest)} 2,3`;
    const j1 = runDelta(cmdJest);
    check('the jest-timing scenario\'s baseline call exits green', j1.status, 0);
    const j2 = runDelta(cmdJest);
    check('a persistent failure with a differing timing tail still reads NEWLY FAILING',
      /NEWLY FAILING/.test(j2.stdout), true);
    check('and it exits non-zero, not green', j2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — rule 1: a red run with no baseline records nothing');
  {
    // No prior baseline at all: nothing has proven this failure pre-existing,
    // so it must exit with the suite's (non-zero) code, not 0, and it must
    // NOT auto-record a red run as the baseline (root cause B) -- otherwise an
    // identical second invocation would compare its failure against itself
    // and report "pre-existing", exit 0.
    const stateFirstRed = path.join(fakeDir, 'calls-first-red.txt');
    const cmdFirstRed = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateFirstRed)} 1,2`;
    const r1 = runDelta(cmdFirstRed);
    check('a red run with no baseline records nothing', /no baseline/.test(r1.stdout), true);
    check('and does not claim to have recorded the baseline', /this run is the baseline/.test(r1.stdout), false);
    check('a first-ever red run exits non-zero, not green', r1.status === 0, false);
    const r2 = runDelta(cmdFirstRed);
    check('an identical second red run still has no baseline to be "pre-existing" against',
      /nothing newly failing/.test(r2.stdout), false);
    check('so it also exits non-zero, not green', r2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — rule 2: --baseline records a red baseline explicitly');
  {
    // Fails on every call with the SAME line, so the explicit baseline and
    // the later plain run share one failure: proof that an explicitly
    // recorded red baseline is honoured as pre-existing, rather than
    // re-flagged every time.
    const stateRedBase = path.join(fakeDir, 'calls-red-baseline.txt');
    const cmdRedBase = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateRedBase)} 1,2,3,4`;
    const baseRb = spawnSync('node', [BIN, '--command', cmdRedBase, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('an explicit --baseline on a red command records it', /baseline recorded/.test(baseRb.stdout), true);
    check('and exits green regardless of the command\'s own exit code', baseRb.status, 0);
    const rb2 = runDelta(cmdRedBase);
    check('the same red command against its recorded red baseline reads pre-existing',
      /nothing newly failing/.test(rb2.stdout), true);
    check('and exits green', rb2.status, 0);
  }

  console.log('\ntest-delta.cjs --command — --show prints the recorded baseline without running the command');
  {
    const stateShow = path.join(fakeDir, 'calls-show.txt');
    const cmdShow = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateShow)}`;
    const sh0 = runDelta(cmdShow);
    check('the show scenario\'s baseline call exits green', sh0.status, 0);
    const callsBefore = fs.readFileSync(stateShow, 'utf8');
    const sh1 = spawnSync('node', [BIN, '--command', cmdShow, '--show'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('--show --command prints the recorded baseline', /baseline/.test(sh1.stdout), true);
    check('and exits green', sh1.status, 0);
    check('--show --command does not run the command (the call counter does not move)',
      fs.readFileSync(stateShow, 'utf8'), callsBefore);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(a): a green run against an existing baseline re-records it');
  {
    // Call 1 (explicit baseline) fails with `fake::old`. Call 2, run plainly,
    // passes outright (no failOn calls at all) -- a green run against a red
    // baseline. If the baseline is never refreshed, a THIRD call that fails
    // again with the SAME `fake::old` line would wrongly read as
    // "pre-existing" against the stale red baseline instead of NEWLY FAILING
    // against the now-green one.
    const stateRefresh = path.join(fakeDir, 'calls-refresh.txt');
    const cmdRefresh = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateRefresh)} 1,3,4`;
    const rf0 = spawnSync('node', [BIN, '--command', cmdRefresh, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('the explicit red baseline is recorded', rf0.status, 0);
    const rf1 = runDelta(cmdRefresh);
    check('a green run against a red baseline is not blocked (fixed, not newly failing)', rf1.status, 0);
    const rf2 = runDelta(cmdRefresh);
    check('a run that fails again with the SAME line the old red baseline had now reads NEWLY FAILING, proving the green run re-recorded the baseline as clean',
      /NEWLY FAILING/.test(rf2.stdout), true);
    check('and it exits non-zero', rf2.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(a): a red run does NOT overwrite the recorded baseline');
  {
    // Baseline (explicit) has only `fake::persist`. Call 2 (the run) ALSO
    // fails with `fake::persist` -- stillFailing, not newly failing, so this
    // takes the "nothing newly failing" exit-early path without ever reaching
    // the re-run logic. If a red run overwrote the baseline unconditionally,
    // that would be harmless here, so this case instead proves the baseline
    // file's `at` timestamp is untouched by a red run.
    const statePersistBase = path.join(fakeDir, 'calls-red-norewrite.txt');
    const cmdPersistBase = `node ${JSON.stringify(fakePath)} ${JSON.stringify(statePersistBase)} 1,2,3`;
    const pb0 = spawnSync('node', [BIN, '--command', cmdPersistBase, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('the explicit red baseline is recorded', pb0.status, 0);
    // gitInfo() (inside test-delta.cjs) keys the baseline by git's OWN
    // `--show-toplevel`, which resolves symlinks (macOS's /var -> /private/var
    // among them) -- so the key must be built from that same resolved root,
    // not the raw REPO string this file's mkdtempSync happened to return.
    const realRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim();
    const marker = D.baselinePath(CONFIG, realRoot, branch, cmdPersistBase);
    const recordedAt = JSON.parse(fs.readFileSync(marker, 'utf8')).at;
    const pb1 = runDelta(cmdPersistBase);
    check('a red run against a red baseline with the same failure reads nothing newly failing',
      /nothing newly failing/.test(pb1.stdout), true);
    const stillAt = JSON.parse(fs.readFileSync(marker, 'utf8')).at;
    check('a red run does not touch the recorded baseline\'s timestamp', stillAt, recordedAt);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(b): --command=<shell> (the = form) is accepted like --command <shell>');
  {
    const stateEq = path.join(fakeDir, 'calls-eq-form.txt');
    const cmdEq = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateEq)}`;
    const eq1 = spawnSync('node', [BIN, `--command=${cmdEq}`], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('--command=<shell> runs the command and records a baseline, not the silent no-command path',
      /no baseline existed/.test(eq1.stdout), true);
    check('and does NOT take the no-command "no test suite detected" path',
      /no test suite detected/.test(eq1.stdout), false);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(b): --command= with an empty value exits 2');
  {
    const eq2 = spawnSync('node', [BIN, '--command='], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    check('--command= with nothing after the = exits 2, not the silent no-command path', eq2.status, 2);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(c): a baseline write failure is reported, not silently swallowed');
  {
    // Point CLAUDE_CONFIG_DIR's state/test-baseline path at a location a write
    // cannot succeed against: a FILE where record() needs to mkdir a
    // directory. fs.mkdirSync on a path that collides with an existing file
    // throws, exactly the shape a permissions failure or a read-only mount
    // would also produce.
    const badConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-badcfg-'));
    trash.push(badConfig);
    fs.mkdirSync(path.join(badConfig, 'state'), { recursive: true });
    // Collide the directory record() needs with a plain file of the same name.
    fs.writeFileSync(path.join(badConfig, 'state', 'test-baseline'), 'not a directory');
    const stateBadWrite = path.join(fakeDir, 'calls-badwrite.txt');
    const cmdBadWrite = `node ${JSON.stringify(fakePath)} ${JSON.stringify(stateBadWrite)}`;
    const bw = spawnSync('node', [BIN, '--command', cmdBadWrite, '--baseline'], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: badConfig },
    });
    check('a baseline write failure is reported as NOT recorded', /not recorded/i.test(bw.stdout + bw.stderr), true);
    check('and --baseline exits non-zero when the write actually failed', bw.status === 0, false);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(d): a newline in the command is treated as a shell operator');
  {
    // A newline separates shell statements exactly like `;` does; appending a
    // node id after the LAST line would splice it onto whatever sits after
    // the newline, not onto pytest's own argv. HAS_SHELL_OPERATORS must treat
    // it the same way `;` already is.
    check('a newline is detected as a shell operator, same as a semicolon',
      D.HAS_SHELL_OPERATORS.test('pytest -q\necho done'), true);
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(d): pytest is matched as a command word, not inside another path');
  {
    check('a bare "pytest" is read as the pytest reader', D.readerFor('pytest -q'), 'pytest');
    check('"python -m pytest" is read as the pytest reader', D.readerFor('python -m pytest -q'), 'pytest');
    check('pytest after && is read as the pytest reader', D.readerFor('true && pytest -q'), 'pytest');
    check('pytest after ; is read as the pytest reader', D.readerFor('cd x; pytest -q'), 'pytest');
    // The regression this guards: `\bpytest\b` matches the substring "pytest"
    // inside "run-pytest.sh" too, because `-` is not a word character, so a
    // word boundary sits right before "pytest" there just as it does before a
    // real pytest invocation.
    check('a script merely named run-pytest.sh is NOT read as the pytest reader',
      D.readerFor('./run-pytest.sh -q'), 'command');
    check('a path containing "pytest" as a substring of a longer word is not matched either',
      D.readerFor('mypytestrunner -q'), 'command');
  }

  console.log('\ntest-delta.cjs --command — BRIEF 11(e): spawnSync r.error is surfaced and handled like a failed spawn');
  {
    // A command whose executable does not exist: spawnSync's `shell: true`
    // normally means the SHELL always starts even if the command inside it is
    // bogus (the shell itself reports "command not found" and exits 127) --
    // but a cwd that does not exist makes spawnSync itself fail to launch the
    // shell, which is the actual r.error path (ENOENT on the spawn, not on
    // the command).
    const ghostCwd = path.join(os.tmpdir(), 'delta-ghost-cwd-does-not-exist');
    const rErr = D.runCommandOnce('true', ghostCwd);
    check('runCommandOnce surfaces a spawn failure via a non-null-signal-mapped code, not a silent 0',
      typeof rErr.code, 'number');
    check('a spawn that never started is not read as a clean exit 0', rErr.code === 0, false);
  }
}

for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
