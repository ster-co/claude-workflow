#!/usr/bin/env node
// Which tests fail NOW that were not failing before.
//
// Why a delta rather than a pass/fail. "The suite must be green" is not a usable
// rule in a repository whose suite is already red — one monorepo here carries a
// standing set of failures, and a gate that blocks on any red there is either
// switched off within a day or silently ignored. What is actually worth knowing
// is whether THIS change broke something that used to work.
//
//   node test-delta.cjs                              run the suite and report what changed
//   node test-delta.cjs --baseline                   run it and (re)record the baseline, no report
//   node test-delta.cjs --show                       print the recorded baseline and exit
//   node test-delta.cjs --command "<shell>"          run that command once and judge it (see below)
//   node test-delta.cjs --command "<shell>" --baseline
//                                                     record that command's baseline explicitly,
//                                                     red or green, and exit 0 without judging
//   node test-delta.cjs --command "<shell>" --show   print that command's recorded baseline and
//                                                     exit, without running it
//
// Without `--command` it REPORTS. It does not block, and it is not wired to a
// hook: a blocking version needs an escape hatch, an escape hatch needs a
// policy for when to use it, and that is the complexity spiral that produced
// a 266-line plan for a 78-line file.
//
// `--command` is the exception: it is the single suite run `/land` and
// `/execute` judge by exit code (plan decision 8), keyed by (root, branch,
// command) rather than by a detected runner, because the caller names the
// exact house-rules command instead of this tool guessing one. On a NEWLY
// FAILING result it re-runs once before blaming the change: a failure only
// on the first run is a flake, reported and non-blocking; one that repeats
// is what actually exits non-zero.
//
// A first `--command` run with no baseline records one only when it is GREEN:
// a red run proves nothing pre-existing (there is nothing to compare it
// against), so it is reported and exits with its own code instead of being
// silently adopted as "normal". A repository that starts red gets its
// baseline the honest way, explicitly: `--command "<shell>" --baseline`.
// Every SUBSEQUENT green run refreshes that baseline too (a test that gets
// fixed and later breaks again must read as newly failing, not as the same
// old pre-existing failure forever); a red run never overwrites it. Passing
// `--baseline` explicitly always (re)records, red or green, on top of this.
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
const { execFileSync, spawnSync } = require('child_process');

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
      // `^^ FAILED (exit N): node <script>` is verify-all.cjs's own summary
      // line for a red unit suite; it starts with `^^`, not `FAILED`, so a
      // parser that only matched the FAIL/FAILED prefix dropped it entirely.
      if (/^(?:FAIL|FAILED)\b/.test(t) || /^[✗✕×]\s/.test(t) || /^\^\^\s*FAILED\b/.test(t)) out.add(t);
    }
  }
  return [...out].sort();
}

// jest/vitest append the test's elapsed time to a FAIL line (`FAIL a.test.js
// (1.2 s)`), which moves on every run whether or not the failure itself did.
// `--command` mode strips it before a generic line is stored or compared, so
// the same failure read twice on that path reads as the same line rather
// than as a fixed one and a new one. This normalisation is scoped to
// `--command` only, via `commandFailuresFrom` below -- NOT `failuresFrom`
// itself, which the no-`--command` path also calls directly. That path is
// not frozen byte-for-byte, though: `failuresFrom`'s `^^ FAILED` match
// (added above for verify-all.cjs's summary line) is shared by both paths
// deliberately, per the plan. Only the volatile-tail stripping is
// `--command`-exclusive.
const VOLATILE_TAIL = /\s*\(\d+(?:\.\d+)?\s?m?s\)\s*$/;
const normalizeVolatileTail = (line) => line.replace(VOLATILE_TAIL, '').trim();

function commandFailuresFrom(reader, output) {
  const raw = failuresFrom(reader, output);
  if (reader === 'pytest') return raw;   // node ids carry no such tail
  return [...new Set(raw.map(normalizeVolatileTail))].sort();
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
 * `command` keys `--command` mode's baseline as well, per (root, branch,
 * command): `/land` and `/execute` run one fixed command, but a repo can be
 * driven by more than one (a backend pytest run and a frontend npm run), and
 * those must not compare against each other's failures. It defaults to ''
 * so every caller that predates `--command` hashes exactly as before.
 *
 * Hashed, because branch names contain slashes and a repo path is not a filename.
 */
function baselinePath(configDir, root, branch, command = '') {
  // Only append the command when one was given: a bare `${root}\n${branch}\n`
  // is a DIFFERENT hash from `${root}\n${branch}`, so appending the empty
  // string unconditionally would still change every no-command caller's key
  // and silently orphan every baseline recorded before --command existed.
  const text = command ? `${root}\n${branch}\n${command}` : `${root}\n${branch}`;
  const key = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
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

/**
 * `--command "<shell>"`: the orchestrator and `/land` do not know or care
 * what a repo's test runner is, only what house-rules command to run — this
 * is `runSuite` for an arbitrary shell string instead of a detected runner,
 * via a shell so pipelines and flags in the caller's string work.
 */
function runCommandOnce(command, cwd) {
  const r = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8', timeout: 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    // spawnSync itself failed to run the shell (e.g. ENOENT) rather than the
    // command it ran exiting non-zero -- there is no child exit to report,
    // so surface the reason and fall through to the same non-0/1 handling as
    // a signal kill below, instead of leaving it silently unexplained.
    process.stderr.write(`test-delta: ${r.error.message}\n`);
  }
  // spawnSync leaves `status` null when the process never exited normally --
  // killed by a signal (our own 15-minute timeout, an OOM kill, SIGSEGV) or
  // never started at all (r.error, above). Mapping that to plain exit 1 made
  // it indistinguishable from an ordinary "some tests failed" run: rule 4's
  // pytest-subset branch treats exit 0 or 1 as a trustworthy re-run and
  // judges it by which node ids reappeared, but a killed pytest prints no
  // summary and returns no ids at all -- so a genuine regression's id never
  // "reappears" and gets reported FLAKY with exit 0. 128+signal is the usual
  // shell convention for "killed by signal N"; it is never 0 or 1, so it
  // always lands in the "re-run is not trustworthy, treat as persisting"
  // branch instead, same as an unparseable exit-4-style pytest error.
  const code = r.status !== null ? r.status : 128 + (os.constants.signals[r.signal] || 0);
  return { output: `${r.stdout || ''}\n${r.stderr || ''}`, code };
}

// Only pytest gets its node-id reader; an arbitrary `--command` string gets
// the generic line reader, same as any other runner whose output this tool
// was never taught to parse exactly. Matched only as a whole shell WORD --
// nothing but whitespace, a shell operator, or the start of the string on
// its left, with an optional `python`/`python3 -m ` in front -- rather than
// `\bpytest\b` anywhere: `-` is not a word character, so that bare
// word-boundary match also fired on a script merely NAMED "run-pytest.sh" or
// a word like "mypytestrunner", neither of which is pytest at all. It still
// matches a trailing bare `pytest` token wherever it sits in the string
// (e.g. a test fixture's own extra CLI argument), as long as nothing
// word-adjacent sits immediately before it.
const PYTEST_COMMAND_RE = /(?:^|[\s;&|])(?:python\d?\s+-m\s+)?pytest\b/;
const readerFor = (command) => (PYTEST_COMMAND_RE.test(command) ? 'pytest' : 'command');

// A shell operator anywhere in the caller's command means appending text is
// not "add an argument to pytest" but "add an argument to whatever sits
// after the last `|`, `;`, `&&`, `||` or `#`, or into a redirect target".
// `pytest -q 2>&1 | tail -50` plus an appended node id becomes
// `... | tail -50 "id"`: tail then reads that (nonexistent) file instead of
// its piped stdin and the re-run silently reports no failures at all. A
// newline is the same kind of statement separator when the command is run
// through a shell (`sh -c` already splits on it exactly like `;`), so it is
// matched here too rather than only the single-line operator characters.
const HAS_SHELL_OPERATORS = /[|;&#<>]|\n/;

/**
 * `--command`'s baseline, retry and verdict, per Decision 8: one run, judged
 * by exit code and a baseline kept per (root, branch, command); a NEWLY
 * FAILING result is re-run once before it is blamed on this change, because
 * a failure that does not repeat is a flake, not a regression.
 *
 * A baseline is recorded automatically only from a GREEN first run (rule 1):
 * a red run proves nothing pre-existing, so recording it would make the next,
 * identical red run compare equal to itself and read as pre-existing. A red
 * baseline can still be wanted (a repo that starts red) -- that is what
 * `--command X --baseline` (rule 2) is for: it records explicitly, red or
 * green, and never reports, because the caller asked for a baseline, not a
 * verdict.
 */
function runCommandFlow(command, cwd, { explicitBaseline = false } = {}) {
  const info = gitInfo(cwd);
  if (!info) { console.log('test-delta: not a git repository.'); process.exit(0); }

  const marker = baselinePath(CONFIG_DIR, info.root, info.branch, command);
  const reader = readerFor(command);
  const label = `${path.basename(info.root)}@${info.branch}`;

  // Returns whether the write actually landed: a caller that asked for a
  // baseline explicitly (`--baseline`) needs to know when it did NOT, rather
  // than trusting a swallowed exception and reporting success anyway.
  const record = (code, failing) => {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({
        repo: info.root, branch: info.branch, command, code, failing, at: new Date().toISOString(),
      }, null, 2));
      return true;
    } catch { return false; }
  };

  const first = runCommandOnce(command, info.root);
  console.log(first.output.split('\n').slice(-20).join('\n').trim());
  console.log(`test-delta: \`${command}\` exit ${first.code} on ${label}`);
  const failing = commandFailuresFrom(reader, first.output);

  if (explicitBaseline) {
    if (record(first.code, failing)) {
      console.log(`test-delta: baseline recorded (exit ${first.code}, ${failing.length} failing) for \`${command}\` on ${label}.`);
      process.exit(0);
    }
    // The write failed (a read-only mount, a permissions problem, a path
    // collision) -- the caller asked specifically for a baseline to exist
    // and it does not, so this must not report success or exit 0: that
    // would make the NEXT run treat "no baseline" as its own fresh baseline
    // (rule 1) and silently adopt whatever it saw as clean.
    console.log(`test-delta: baseline NOT recorded (write failed) for \`${command}\` on ${label}.`);
    process.exit(1);
  }

  const previous = readJson(marker);
  if (!previous) {
    if (first.code === 0) {
      record(first.code, failing);
      console.log(`test-delta: no baseline existed, so this run is the baseline (${failing.length} failing).`);
      process.exit(0);
    }
    // A red first-ever run proves nothing: there is no prior run to call it
    // pre-existing against, so it is neither recorded nor reported green.
    // Use `--command X --baseline` to record a red baseline explicitly.
    console.log('test-delta: no baseline existed, and this run is red, so nothing was recorded (use --baseline to record one explicitly).');
    process.exit(first.code);
  }

  // A GREEN run re-records the baseline for this key even when it is not the
  // first run ever: the alternative is a baseline that is only ever set once
  // and never refreshed, so a test that gets fixed and then breaks AGAIN
  // later reads as "pre-existing" against the original failure forever. A
  // RED run must not do this -- there being nothing trustworthy to compare a
  // red run against itself, overwriting here would let a newly red run erase
  // the record of what used to pass.
  if (first.code === 0) record(first.code, failing);

  const d = compare(previous.failing, failing);
  const wentRed = previous.code === 0 && first.code !== 0;
  if (!wentRed && d.newly.length === 0) {
    console.log(d.stillFailing.length
      ? `test-delta: nothing newly failing (${d.stillFailing.length} pre-existing, not attributable to this change).`
      : 'test-delta: nothing newly failing.');
    process.exit(0);
  }

  // A newly-red result with no matched failure lines (a runner whose output
  // this reader cannot parse) still needs something to re-run and to blame;
  // fall back to a single marker naming the whole command.
  const newlyItems = d.newly.length ? d.newly : ['<no failure lines parsed; command exited non-zero>'];

  // Pytest re-runs only the new node ids; anything else re-runs the whole
  // command, because there is nothing narrower to select. A command with
  // shell operators also re-runs whole: there is no safe place to splice an
  // extra argument into a pipeline or redirection without changing what it
  // does (see HAS_SHELL_OPERATORS above).
  const pytestSubset = reader === 'pytest' && d.newly.length > 0 && !HAS_SHELL_OPERATORS.test(command);
  // A node id is quoted for the SHELL this re-run goes through (`sh -c`), not
  // for JS: `JSON.stringify` makes a double-quoted string, and a shell still
  // expands `$` and backtick inside double quotes -- `test_p[$5]` reads a
  // positional parameter, `` test_p[`x`] `` runs `x` as a command. Single
  // quotes suppress all of that; the only thing that still needs escaping is
  // an embedded single quote, closed-escaped-reopened per the usual sh idiom.
  const shellQuote = (id) => `'${String(id).replace(/'/g, `'\\''`)}'`;
  const rerunCommand = pytestSubset
    ? `${command} ${d.newly.map(shellQuote).join(' ')}`
    : command;
  const second = runCommandOnce(rerunCommand, info.root);
  const failing2 = commandFailuresFrom(reader, second.output);

  // Persistence, per rule: pytest's subset re-run judges by node id, exactly
  // as before. A whole-command re-run persists on EITHER signal: the exit
  // code went non-zero against a GREEN baseline and stayed non-zero on the
  // re-run (root cause A -- a reworded or re-timed line must not read as
  // "fixed" while the command still exits non-zero), OR a newly seen line
  // reappears verbatim on the re-run. The second clause has to stand on its
  // own: a command piped through something like `| tail -50` always exits 0
  // no matter what the piped program did, so the exit code can never confirm
  // a regression there -- only the line reappearing can, and that also
  // covers a RED baseline, which has no green-to-red exit-code signal to
  // lean on in the first place. Either way the line list is kept for
  // display.
  let persisted;
  if (pytestSubset) {
    // pytest exits 4 ("no tests ran", "usage error", etc.) rather than 0 or 1
    // when something about the re-run itself went wrong -- most commonly a
    // selected node id that pytest could not collect. On that exit no id
    // EVER comes back, whether or not the failure is real, so trusting id
    // reappearance alone would call every one of them FLAKY and exit 0. Only
    // an ordinary 0 (all selected ids passed) or 1 (some failed) run is
    // judged by which ids reappeared; anything else means the re-run itself
    // is not trustworthy, so the new failures are treated as persisting.
    persisted = (second.code === 0 || second.code === 1)
      ? d.newly.filter((id) => failing2.includes(id))
      : d.newly;
  } else {
    const redOnBothRuns = previous.code === 0 && first.code !== 0 && second.code !== 0;
    const reappeared = newlyItems.filter((t) => failing2.includes(t));
    persisted = redOnBothRuns ? newlyItems : reappeared;
  }
  const flaky = newlyItems.filter((t) => !persisted.includes(t));

  if (persisted.length) {
    console.log(`test-delta: NEWLY FAILING (${persisted.length}), confirmed on re-run:`);
    for (const t of persisted) console.log(`  ${t}`);
    if (flaky.length) console.log(`  FLAKY, did not repeat (${flaky.length}): ${flaky.join(', ')}`);
    process.exit(second.code || 1);
  }

  console.log(`test-delta: FLAKY (${flaky.length}), did not repeat on re-run, not blocking:`);
  for (const t of flaky) console.log(`  ${t}`);
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  // `--command=<shell>` is the other conventional CLI spelling for the same
  // flag; without this, that form fell through as an unrecognised argument
  // and silently took the no-`--command` path (exit 0), rather than running
  // and judging the command the caller actually named.
  const eqArg = argv.find((a) => a.startsWith('--command='));
  const commandIdx = argv.indexOf('--command');
  if (commandIdx !== -1 || eqArg !== undefined) {
    let command;
    if (eqArg !== undefined) {
      command = eqArg.slice('--command='.length);
      if (!command) { console.log('test-delta: --command needs a value.'); process.exit(2); }
    } else {
      const next = argv[commandIdx + 1];
      // A caller that forgets the value (`--command --baseline`) must not have
      // `--baseline` silently treated as the shell command to run: the flag
      // that would otherwise follow is the tell that the value is missing.
      command = (next === undefined || next === '--baseline' || next === '--show') ? undefined : next;
      if (!command) { console.log('test-delta: --command needs a value.'); process.exit(2); }
    }

    // `--show --command X` must show that command's recorded baseline, not
    // run it: `--show` alone (below) is read-only, and `--command` without
    // `--show` runs the command once and judges it -- this combination is
    // read-only too, so it must not fall through into runCommandFlow, which
    // always runs the command.
    if (argv.includes('--show')) {
      const info = gitInfo(cwd);
      if (!info) { console.log('test-delta: not a git repository.'); process.exit(0); }
      const marker = baselinePath(CONFIG_DIR, info.root, info.branch, command);
      const rec = readJson(marker);
      const label = `${path.basename(info.root)}@${info.branch}`;
      if (!rec) console.log(`test-delta: no baseline for \`${command}\` on ${label}.`);
      else console.log(`test-delta: baseline for \`${command}\` on ${label}, exit ${rec.code}, ${rec.failing.length} failing, recorded ${rec.at}\n${rec.failing.map((t) => `  ${t}`).join('\n')}`);
      process.exit(0);
    }

    runCommandFlow(command, cwd, { explicitBaseline: argv.includes('--baseline') });
    return;
  }

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

module.exports = {
  detectRunner, failuresFrom, commandFailuresFrom, compare, baselinePath,
  readerFor, runCommandOnce, HAS_SHELL_OPERATORS,
};
if (require.main === module) main();
