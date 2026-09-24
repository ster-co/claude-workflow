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
const { execFileSync } = require('child_process');

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
}

for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
