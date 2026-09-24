#!/usr/bin/env node
// Which tests fail NOW that were not failing before.
//
// Why a delta rather than a pass/fail. "The suite must be green" is not a usable
// rule in a repository whose suite is already red — one monorepo here carries a
// standing set of failures, and a gate that blocks on any red there is either
// switched off within a day or silently ignored. What is actually worth knowing
// is whether THIS change broke something that used to work.
//
//   node test-delta.cjs            run the suite and report what changed
//   node test-delta.cjs --baseline run it and (re)record the baseline, no report
//   node test-delta.cjs --show     print the recorded baseline and exit
//
// It REPORTS. It does not block, and it is not wired to a hook: a blocking
// version needs an escape hatch, an escape hatch needs a policy for when to use
// it, and that is the complexity spiral that produced a 266-line plan for a
// 78-line file. `/land` and `/execute` call this and put the answer in front of
// a person.
//
// The first run in a repository/branch with no baseline records one instead of
// reporting against nothing. That is the honest reading of "no baseline": it is
// not evidence that everything passed.
//
// Scope of the parsing. pytest is read exactly, as node ids, because that is
// what this estate runs. Everything else falls back to keeping the lines that
// announce a failure and comparing those as strings — cruder (a reworded failure
// line reads as one fixed and one new) but it still answers the question that
// matters, and it beats having no answer for a JS repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// npm init writes this as the placeholder `test` script. A repo that still has
// it has no suite, and treating it as one means reporting its guaranteed
// non-zero exit as a regression on every run.
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * The suite this repository actually has, or null.
 *
 * pytest is checked first. That is a fact about this estate rather than a claim
 * about the world: a repo here that has both a pytest config and a package.json
 * is a Python service with a frontend, and its Python suite is the one CI runs.
 */
function detectRunner(root) {
  const has = (rel) => fs.existsSync(path.join(root, rel));
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };

  if (has('pytest.ini') || has('tox.ini')
      || /^\s*\[tool\.pytest/m.test(read('pyproject.toml'))
      || /^\s*\[tool:pytest\]/m.test(read('setup.cfg'))) {
    // -rf gives the short summary this parses; --tb=no keeps a red suite from
    // producing megabytes of traceback we then have to hold in memory.
    return { name: 'pytest', command: ['pytest', '-q', '--tb=no', '-rf'] };
  }

  if (has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read('package.json')).scripts || {}; } catch { scripts = {}; }
    if (scripts.test && !NPM_PLACEHOLDER.test(scripts.test)) {
      return { name: 'npm', command: ['npm', 'test', '--silent'] };
    }
  }

  if (/^test:/m.test(read('Makefile'))) return { name: 'make', command: ['make', 'test'] };

  return null;
}

/**
 * The set of failing tests in a run's output.
 *
 * Sorted, because a set compared as a list must have a stable order or every run
 * differs from every other.
 */
function failuresFrom(runner, output) {
  const out = new Set();
  if (runner === 'pytest') {
    // The short summary only. The progress line (`test_a.py .....F..`) names no
    // test, and a traceback quotes source that can contain anything.
    for (const m of (output || '').matchAll(/^(?:FAILED|ERROR)\s+(\S+::\S+?)(?:\s+-\s.*)?$/gm)) {
      out.add(m[1]);
    }
  } else {
    for (const line of (output || '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // The mark forms need \s rather than \b: ✗ is not a word character, so a
      // word boundary after it never matches and every vitest line was dropped.
      if (/^(?:FAIL|FAILED)\b/.test(t) || /^[✗✕×]\s/.test(t)) out.add(t);
    }
  }
  return [...out].sort();
}

function compare(baseline, current) {
  const was = new Set(baseline || []);
  const now = new Set(current || []);
  return {
    newly: [...now].filter((t) => !was.has(t)).sort(),
    fixed: [...was].filter((t) => !now.has(t)).sort(),
    stillFailing: [...now].filter((t) => was.has(t)).sort(),
  };
}

/**
 * Per repository AND per branch: a feature branch inherits main's red, and
 * comparing a branch against another branch's baseline reports every difference
 * between the two branches as a regression of this change.
 *
 * Hashed, because branch names contain slashes and a repo path is not a filename.
 */
function baselinePath(configDir, root, branch) {
  const key = crypto.createHash('sha256').update(`${root}\n${branch}`).digest('hex').slice(0, 32);
  return path.join(configDir, 'state', 'test-baseline', `${key}.json`);
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function gitInfo(cwd) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
  };
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return null;
  return { root, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD' };
}

function runSuite(runner, root) {
  const [cmd, ...args] = runner.command;
  try {
    return execFileSync(cmd, args, {
      cwd: root, encoding: 'utf8', timeout: 15 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A red suite exits non-zero. That is the normal case here, not an error:
    // the output is on the exception and is exactly what we came for.
    if (e && (typeof e.stdout === 'string' || typeof e.stderr === 'string')) {
      return `${e.stdout || ''}\n${e.stderr || ''}`;
    }
    return null;   // the runner itself could not be started
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const info = gitInfo(cwd);
  if (!info) { console.log('test-delta: not a git repository.'); process.exit(0); }

  const marker = baselinePath(CONFIG_DIR, info.root, info.branch);

  if (argv.includes('--show')) {
    const rec = readJson(marker);
    if (!rec) console.log(`test-delta: no baseline for ${path.basename(info.root)}@${info.branch}.`);
    else console.log(`test-delta: baseline for ${path.basename(info.root)}@${info.branch}, ${rec.failing.length} failing, recorded ${rec.at}\n${rec.failing.map((t) => `  ${t}`).join('\n')}`);
    process.exit(0);
  }

  const runner = detectRunner(info.root);
  if (!runner) {
    console.log('test-delta: no test suite detected (looked for pytest config, a package.json test script, a Makefile test target).');
    process.exit(0);
  }

  const output = runSuite(runner, info.root);
  if (output === null) {
    console.log(`test-delta: could not run \`${runner.command.join(' ')}\`.`);
    process.exit(0);
  }
  const failing = failuresFrom(runner.name, output);
  const previous = readJson(marker);
  const record = () => {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({
        repo: info.root, branch: info.branch, command: runner.command.join(' '),
        failing, at: new Date().toISOString(),
      }, null, 2));
    } catch { /* a missing baseline only means the next run records one */ }
  };

  if (argv.includes('--baseline') || !previous) {
    record();
    const why = previous ? 'baseline replaced' : 'no baseline existed, so this run is the baseline';
    console.log(`test-delta: ${why}. \`${runner.command.join(' ')}\` → ${failing.length} failing on ${path.basename(info.root)}@${info.branch}.`);
    process.exit(0);
  }

  const d = compare(previous.failing, failing);
  const lines = [
    `test-delta: \`${runner.command.join(' ')}\` on ${path.basename(info.root)}@${info.branch}`,
    `  baseline ${previous.failing.length} failing (recorded ${previous.at}), now ${failing.length}.`,
  ];
  if (d.newly.length) {
    lines.push(`  NEWLY FAILING (${d.newly.length}):`);
    for (const t of d.newly) lines.push(`    ${t}`);
  } else {
    lines.push('  Nothing newly failing.');
  }
  if (d.fixed.length) lines.push(`  No longer failing (${d.fixed.length}): ${d.fixed.join(', ')}`);
  if (d.stillFailing.length) lines.push(`  Failing before this change too (${d.stillFailing.length}), not attributable to it.`);
  console.log(lines.join('\n'));
  process.exit(0);
}

module.exports = { detectRunner, failuresFrom, compare, baselinePath };
if (require.main === module) main();
