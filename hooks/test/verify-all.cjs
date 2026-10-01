#!/usr/bin/env node
// One command to check the whole discipline setup still works.
// Node port of the former verify-all.cjs: bash could not run on a colleague's
// Windows box without Git Bash, so this reimplements every check faithfully in
// a runtime that ships everywhere Claude Code does.
//
// The bash version invoked each suite by the ABSOLUTE path
// ~/.claude/hooks/test/test-*.cjs, and each suite's own `HOOKS` constant was
// built from os.homedir() the same way -- so the suite under test was always
// the live install, never the checkout this script happens to live in. A git
// worktree's tests silently graded ~/.claude instead of the worktree, which is
// why this whole run avoided worktrees. Resolving everything from __dirname
// instead fixes that: whatever checkout you run this from is the checkout it
// tests.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// hooks/test/verify-all.cjs -> hooks/test -> hooks -> ROOT (the checkout this
// script lives in, whether that is ~/.claude or a worktree of it).
const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'hooks');
const COMMANDS = path.join(ROOT, 'commands');
const AGENTS = path.join(ROOT, 'agents');
const SKILLS = path.join(ROOT, 'skills');

// settings.json's shell-form commands quote the hook path with $HOME rather
// than a hardcoded absolute path, so the same file works on any machine --
// the quoting still has to be portable across sh -c, Git Bash and
// PowerShell, which is why it is double- not single-quoted. Extract the
// quoted path regardless of quote style, then expand the variables a shell
// would, so this file's own checks see the path a live invocation resolves.
function hookCommandPath(command) {
  const m = /['"]([^'"]+)['"]/.exec(command) || /(\S+\.(?:cjs|sh))/.exec(command);
  if (!m) return null;
  return m[1]
    .replace(/\$\{?CLAUDE_CONFIG_DIR\}?/g, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
    .replace(/\$\{?HOME\}?/g, os.homedir());
}

// --- hook behaviour: the unit suites ----------------------------------------
// This list itself is the only place a suite count is written down -- pool
// sizing (POOL_CONCURRENCY) and the time budget (SUITE_BUDGET_MS) below are
// hardcoded constants set once from a real measurement, not derived from
// this list's length at runtime. The list has already gone stale once, when
// a same-day 0.7.3 release added test-update-plugin.cjs as a 13th suite
// while this plan was still being drafted -- so read it fresh here rather
// than trusting a suite count written down anywhere else (a comment, a plan,
// a prior brief's report).
const UNIT_SUITES = [
  'test-gates.cjs',
  'test-plan-gate.cjs',
  'test-verify-checkpoint.cjs',
  'test-run-state-registry.cjs',
  'test-agent-log.cjs',
  'test-repo-setup.cjs',
  'test-worktree-sweep.cjs',
  'test-test-delta.cjs',
  'test-serena-registry.cjs',
  'test-serena-relay.cjs',
  'test-ship-loop.cjs',
  'test-ship-loop-launch.cjs',
  'test-update-plugin.cjs',
  // Tests this file's own pool/budget/serial-exception logic, the same
  // pattern test-test-delta.cjs already uses to test test-delta.cjs.
  'test-verify-all.cjs',
];

// test-verify-checkpoint.cjs has two lock-timing races (search this repo for
// `swap.js` or `H3` if this comment's line reference has drifted): the
// review-file read-modify-write, and the lock-release token check, are both
// timing-dependent under contention. Running it inside the pool would
// recreate exactly the contention that trips them. Serializing it here --
// not fixing either race -- is this task's whole scope.
//
// test-run-state-registry.cjs joined this list after the fact, not by
// original design: the first parallel measurement below failed with it
// still in the pool (a wall-clock assertion at test-run-state-registry.cjs
// around "and it did not have to wait out a leaked lock" -- search that
// string if the line has drifted -- assumes a lock poll/acquire completes
// well under 2s, which does not hold once it is sharing the machine with
// three other suites' worth of real `git`/`node` spawns). A reviewer-led
// reproduction on this same code confirmed the pool itself as the cause:
// failed in 2 of 3 runs with the suite inside the pool, passed clean in all
// 3 standalone runs with it outside. Per the plan's "if something looks
// wrong" instruction, this is recorded as a newly-surfaced load-sensitive
// suite and serialized, not fixed -- the assertion itself is not touched.
const SERIAL_SUITES = ['test-verify-checkpoint.cjs', 'test-run-state-registry.cjs'];

// This machine has 10 logical cores (os.cpus().length). Firing every
// pool-eligible suite at once would recreate the same contention the
// findings doc measured (a full serial run finished 731s FASTER than the sum
// of its suites timed standalone -- i.e. contention inflates a scattered
// sequence of runs more than one contiguous run) and risks tripping the very
// race SERIAL_SUITES exists to dodge. 4 is a deliberately small fraction of
// the core count, leaving headroom for this machine's normal condition of
// other concurrent Claude Code sessions; it is also the concurrency the real
// measurement below was taken at.
const POOL_CONCURRENCY = 4;

// Set from the real parallel measurement recorded in
// docs/2026-09-28-test-speed-findings.md ("Measured, 2026-09-28": 530.18s
// clean, all 13 suites passing), at a ~50% margin above it -- generous
// enough that ordinary machine noise does not flap the budget, tight enough
// that a real regression still fails loudly.
const SUITE_BUDGET_MS = 795000; // 795s = 530.18s measured * 1.5

// A pipeline's exit status is the LAST command's. The bash version once ran
// these as `node test.cjs | tail -2`, which reported tail's status -- always
// 0 -- so a red unit test could not fail the script. It reported success over
// two failing assertions on 2026-09-22. Capture the child's status directly;
// never pipe it through something else's exit code.
//
// spawnSync blocks the event loop for the whole child process, so two
// spawnSync calls can never overlap no matter how they are scheduled.
// Parallel execution needs the event loop free between suites, so this
// spawns async and resolves once the child closes.
function unitScript(script, dir = path.join(HOOKS, 'test')) {
  return new Promise((resolve) => {
    const start = Date.now();
    let out = '';
    let child;
    try {
      child = spawn('node', [path.join(dir, script)]);
    } catch (e) {
      resolve({ script, status: 1, out: `${e.message}\n`, wallMs: Date.now() - start });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += `${e.message}\n`; });
    child.on('close', (status) => {
      resolve({ script, status: status === null ? 1 : status, out, wallMs: Date.now() - start });
    });
  });
}

// A minimal bounded pool: `concurrency` lanes each pull the next item off the
// shared queue until it is empty, so at most `concurrency` suites ever run at
// once regardless of how many are queued -- not a Promise.all over every item
// at once, which would just be "run everything" under a different name.
async function runPool(items, concurrency, worker) {
  let next = 0;
  const laneCount = Math.max(1, Math.min(concurrency, items.length));
  async function lane() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: laneCount }, lane));
}

// The exported, parameterizable suite-runner: this file's own script and
// hooks/test/test-verify-all.cjs both call it -- the former with the real
// suite list and no overrides, the latter with fake fast scripts and a `dir`
// override so its assertions run in milliseconds instead of ~15 minutes.
// `serial` suites run one at a time, strictly BEFORE the pool starts, so
// they structurally cannot overlap it (never "before or after" decided at
// random -- always before, so the ordering is deterministic and testable).
// Output always prints in `suites`' own order, regardless of completion
// order, so a diff against a prior run stays meaningful.
async function runUnitSuites(suites, opts = {}) {
  const {
    serial = [],
    concurrency = POOL_CONCURRENCY,
    budgetMs = SUITE_BUDGET_MS,
    dir = path.join(HOOKS, 'test'),
    runOne = unitScript,
  } = opts;
  const serialSet = new Set(serial);
  const serialList = suites.filter((s) => serialSet.has(s));
  const parallelList = suites.filter((s) => !serialSet.has(s));

  const results = new Map();
  const t0 = Date.now();
  for (const script of serialList) {
    results.set(script, await runOne(script, dir));
  }
  await runPool(parallelList, concurrency, async (script) => {
    results.set(script, await runOne(script, dir));
  });
  const totalMs = Date.now() - t0;

  let rc = 0;
  for (const script of suites) {
    const r = results.get(script);
    const lines = r.out.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    console.log(`  ${script} (${(r.wallMs / 1000).toFixed(2)}s)`);
    console.log(lines.slice(-2).join('\n'));
    if (r.status !== 0) {
      rc = 1;
      console.log(`  ^^ FAILED (exit ${r.status}): node ${script}`);
    }
  }
  const budgetLabel = Number.isFinite(budgetMs) ? `${(budgetMs / 1000).toFixed(2)}s` : 'none';
  console.log(`  total: ${(totalMs / 1000).toFixed(2)}s (budget ${budgetLabel}, concurrency ${concurrency})`);
  if (totalMs > budgetMs) {
    rc = 1;
    console.log(`  ^^ FAILED: total wall time ${(totalMs / 1000).toFixed(2)}s exceeded the ${(budgetMs / 1000).toFixed(2)}s budget`);
  }
  return { rc, totalMs, results };
}

async function main() {
let rc = 0;

console.log('== hook behaviour ==');
{
  const { rc: unitRc } = await runUnitSuites(UNIT_SUITES, { serial: SERIAL_SUITES });
  if (unitRc) rc = 1;
}

// --- settings.json is valid and wired ---------------------------------------
console.log();
console.log('== settings.json is valid and wired ==');
(function settingsChecks() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  // Printed in Python's list-repr style (single quotes, ", " separators) so a
  // side-by-side diff against the bash runner's output is a diff, not noise.
  const pyList = (arr) => `[${arr.map((x) => `'${x}'`).join(', ')}]`;

  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8'));
  } catch (e) {
    fail(`could not read/parse settings.json: ${e.message}`);
    return;
  }

  for (const [ev, entries] of Object.entries(s.hooks)) {
    for (const e of entries) {
      const names = e.hooks.map((h) => path.basename(hookCommandPath(h.command) || h.command)).join(' ');
      console.log(`  ${ev.padEnd(16)} ${String(e.matcher ?? '(all)').padEnd(34)} ${names}`);
    }
  }

  // Every PreToolUse matcher that reaches a shell command has to name BOTH
  // tool names Claude Code uses for one: `Bash`, and `PowerShell` -- the tool
  // Windows routes shell commands through and treats as primary when Git Bash
  // is absent. A matcher that lost `PowerShell` back to plain `Bash` sends
  // every gate dark on that platform while this whole suite, which never
  // dispatches a PowerShell tool call, stays green. The loop above only
  // printed matchers; this is the assertion the print was standing in for.
  const shellMatchers = (s.hooks.PreToolUse || [])
    .map((e) => String(e.matcher ?? '').split('|'))
    .filter((parts) => parts.includes('Bash') || parts.includes('PowerShell'));
  const halfCovered = shellMatchers.filter((parts) => !(parts.includes('Bash') && parts.includes('PowerShell')));
  if (halfCovered.length) {
    fail(`PreToolUse matcher(s) cover a shell tool without naming both Bash and PowerShell: ${pyList(halfCovered.map((p) => p.join('|')))}`);
    return;
  }
  console.log(`  ok   every PreToolUse matcher covering a shell tool names both Bash and PowerShell (${shellMatchers.length} checked)`);

  // A hook that handles a source the matcher never selects is dead code that
  // still passes its own unit tests -- which is exactly how the `startup`
  // crash-recovery path sat broken while 38 tests reported green. Assert the
  // wiring, do not print it.
  const src = fs.readFileSync(path.join(HOOKS, 'checkpoint-restore.cjs'), 'utf8');
  let handled = new Set();
  for (const name of ['SESSION_SOURCES', 'DURABLE_SOURCES']) {
    const m = new RegExp(`${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]`).exec(src);
    if (m) for (const v of m[1].matchAll(/'([a-z]+)'/g)) handled.add(v[1]);
  }
  let matched = new Set();
  for (const e of s.hooks.SessionStart || []) {
    if (e.hooks.some((h) => h.command.includes('checkpoint-restore'))) {
      for (const part of (e.matcher || '').split('|')) matched.add(part);
    }
  }
  const missing = [...handled].filter((x) => !matched.has(x)).sort();
  console.log();
  if (missing.length) { fail(`checkpoint-restore handles ${pyList(missing)} but SessionStart never matches them`); return; }
  console.log(`  ok   checkpoint-restore: every handled source ${pyList([...handled].sort())} is matched`);

  const missingFiles = [];
  for (const [ev, entries] of Object.entries(s.hooks)) {
    for (const e of entries) {
      for (const hk of e.hooks) {
        // settings.json names the install location ($HOME/.claude/...), but the
        // question here is whether the checkout under test ships the script: a
        // worktree adding a new hook would otherwise fail until it is merged and
        // installed. Map the install root onto this checkout before looking.
        const installRoot = path.join(os.homedir(), '.claude') + path.sep;
        const raw = hookCommandPath(hk.command);
        const p = raw && raw.startsWith(installRoot) ? path.join(ROOT, raw.slice(installRoot.length)) : raw;
        if (p && !fs.existsSync(p)) missingFiles.push(`${ev}:${p}`);
      }
    }
  }
  if (missingFiles.length) { fail(`wired hook scripts that do not exist: ${pyList(missingFiles)}`); return; }
  console.log('  ok   every wired hook script exists on disk');

  // A recorder wired to one event when the report arrives on another is how
  // three live plan-auditor dispatches wrote zero markers: the PostToolUse
  // tool result was a SubagentHandback receipt and the verdict was only in
  // the subagent's transcript, which SubagentStop names. Assert both
  // wirings, not one.
  const need = [['PostToolUse', 'Agent'], ['SubagentStop', null]];
  function checkBothWirings(token, label) {
    const wired = {};
    for (const [ev, entries] of Object.entries(s.hooks)) {
      for (const e of entries) {
        for (const hk of e.hooks) {
          if (hk.command.includes(token)) {
            (wired[ev] ||= new Set()).add(e.matcher ?? '(all)');
          }
        }
      }
    }
    const gaps = [];
    for (const [ev, matcher] of need) {
      if (!wired[ev]) gaps.push(`${token}.cjs is not wired to ${ev}`);
      else if (matcher && ![...wired[ev]].some((m) => m.includes(matcher))) {
        gaps.push(`${token}.cjs on ${ev} no longer matches ${matcher}`);
      }
    }
    if (gaps.length) { fail(`${label}: ${pyList(gaps)}`); return false; }
    return true;
  }
  if (!checkBothWirings('plan-audit-record', 'verdict recording')) return;
  console.log('  ok   plan-audit-record is wired to both ways a report can arrive');
  if (!checkBothWirings('verify-record', 'review recording')) return;
  console.log('  ok   verify-record is wired to both ways a report can arrive');

  // A setup step nobody runs is the same as no setup step: claude-repo-setup.sh
  // sat on disk unrun for a day while verify-all printed the repos it had not
  // reached.
  const repoSetupWired = (s.hooks.SessionStart || []).some(
    (e) => e.hooks.some((hk) => hk.command.includes('repo-setup')));
  if (!repoSetupWired) { fail('repo-setup.cjs is not wired to SessionStart, so new repos stay unconfigured'); return; }
  console.log('  ok   repo-setup runs on SessionStart');

  // test-delta is called by commands rather than wired to an event, so the
  // way it dies is a command quietly dropping the line. claude-repo-setup.sh
  // sat unrun for a day on exactly that failure mode.
  const callers = [['land.md', 'test-delta.cjs --command'], ['execute.md', 'test-delta.cjs --command']];
  const missingCallers = callers.filter(([c, tok]) =>
    !fs.readFileSync(path.join(COMMANDS, c), 'utf8').includes(tok)).map(([c]) => c);
  if (missingCallers.length) { fail(`these commands no longer run the test delta: ${pyList(missingCallers)}`); return; }
  console.log(`  ok   the test delta is still called by ${callers.length} commands`);

  // /diagnose hands a fix that needs a decision to /ship by starting the run itself and
  // stopping at /ship's direction gate. It cannot invoke /ship -- both are outermost,
  // per the invocability split below -- so the run state IS the hand-off. A /diagnose that
  // stops writing it goes back to fixing inline with no gate, and nothing else notices;
  // a /ship that stops reading the diagnosis re-brainstorms from nothing on resume.
  // One token per step, each on its own line in the command, so deleting any one
  // step turns this red rather than leaving a sibling token to match.
  const handoff = [
    ['diagnose.md', 'start --feature <kebab-summary> --phase awaiting-direction'],
    ['diagnose.md', 'phase awaiting-direction --plan docs/plans/'],
    ['diagnose.md', 'branch --base'],
    ['ship.md', '### Arriving from `/diagnose`'],
  ];
  const lostSteps = handoff.filter(([c, tok]) =>
    !fs.readFileSync(path.join(COMMANDS, c), 'utf8').includes(tok)).map(([c, tok]) => `${c}: ${tok}`);
  if (lostSteps.length) { fail(`the /diagnose -> /ship hand-off lost a step: ${pyList(lostSteps)}`); return; }
  console.log(`  ok   /diagnose still hands a decision-sized fix to /ship (${handoff.length} checked)`);

  // An adversary that a command stops dispatching disappears silently: the
  // command still runs, the step is simply gone, and nothing reports a
  // missing audit.
  const wiring = [
    ['blueprint.md', 'plan-auditor'],
    ['diagnose.md', 'root-cause-auditor'],
    ['execute.md', 'reviewer'],
  ];
  // Skills are model-invoked rather than dispatched by a command, so there is
  // no command to check them against -- only that they are still on disk.
  const skills = ['refactor'];
  const missingWiring = [];
  for (const sk of skills) {
    if (!fs.existsSync(path.join(SKILLS, sk, 'SKILL.md'))) missingWiring.push(`skills/${sk}/SKILL.md absent`);
  }
  for (const [cmd, agent] of wiring) {
    if (!fs.existsSync(path.join(AGENTS, `${agent}.md`))) missingWiring.push(`${agent}.md absent from agents/`);
    else if (!fs.readFileSync(path.join(COMMANDS, cmd), 'utf8').includes(agent)) missingWiring.push(`${cmd} no longer dispatches ${agent}`);
  }
  if (missingWiring.length) { fail(`adversary wiring or missing skills: ${pyList(missingWiring)}`); return; }
  console.log(`  ok   every command still dispatches its adversary (${wiring.length} checked) and every skill is on disk (${skills.length} checked)`);

  // /blueprint and /ship brainstorm through /brainstorm, never the raw
  // superpowers:brainstorming skill. Left to itself that skill ends by writing
  // and committing a spec under docs/superpowers/specs/ and invoking
  // writing-plans -- a second design document and a second approval loop next
  // to the plan doc and gates these commands own. /brainstorm is the one place
  // that stops the skill before that step.
  const brainstormers = ['blueprint.md', 'ship.md'];
  const rawBrainstorm = brainstormers.filter((c) => {
    const text = fs.readFileSync(path.join(COMMANDS, c), 'utf8');
    return text.includes('superpowers:brainstorming') || !text.includes('`/brainstorm`');
  });
  if (rawBrainstorm.length) { fail(`these commands brainstorm through the raw skill instead of /brainstorm: ${pyList(rawBrainstorm)}`); return; }
  console.log(`  ok   ${brainstormers.length} commands brainstorm through /brainstorm`);

  // Under a plugin install no CLAUDE.md reaches the session, so a command that
  // changes code or history is the only thing that can pull the discipline in.
  // One that stops naming the skill runs without it, and nothing else notices.
  const disciplined = ['blueprint.md', 'ship.md', 'diagnose.md', 'brief.md', 'execute.md', 'land.md', 'quick.md'];
  const undisciplined = disciplined.filter((c) =>
    !fs.readFileSync(path.join(COMMANDS, c), 'utf8').includes('load the `workflow-discipline` skill'));
  if (undisciplined.length) { fail(`these commands no longer load workflow-discipline: ${pyList(undisciplined)}`); return; }
  console.log(`  ok   ${disciplined.length} commands load workflow-discipline on invocation`);

  // /ship forks its work branch from the recorded base. Without a fetch first
  // that is whatever this checkout last pulled, and the PR opens already behind.
  const shipText = fs.readFileSync(path.join(COMMANDS, 'ship.md'), 'utf8');
  const fetchAt = shipText.indexOf('git fetch origin');
  const forkAt = shipText.indexOf('git worktree add');
  if (fetchAt < 0 || fetchAt > forkAt || !/git worktree add .* origin\/<base>/.test(shipText)) {
    fail('ship.md no longer fetches before forking its worktree off origin/<base>'); return;
  }
  console.log('  ok   /ship fetches before forking its worktree off origin/<base>');

  // /brief ends by printing an opener for the user to paste. Inside a /ship run that
  // opener is not a stopping point -- /ship goes straight on to /execute in the same
  // turn. Without an explicit carve-out on both sides, the model obeys /brief's
  // "nothing else after it", prints `/execute ...`, and the run stalls after briefing.
  const continuation = [
    ['brief.md', 'Inside a `/ship` run, the opener is not a stop'],
    ['ship.md', 'is not a stopping point here'],
  ];
  const lostContinuation = continuation.filter(([c, tok]) =>
    !fs.readFileSync(path.join(COMMANDS, c), 'utf8').includes(tok)).map(([c, tok]) => `${c}: ${tok}`);
  if (lostContinuation.length) { fail(`/ship could stall after /brief prints its opener: ${pyList(lostContinuation)}`); return; }
  console.log(`  ok   /ship continues from /brief into /execute without stopping (${continuation.length} checked)`);

  // disable-model-invocation is right for what the USER types and wrong for
  // what a command calls. /ship's own text says "run /brief" and "/execute"
  // -- if those carry the flag, /ship reaches its approval gate and can go
  // no further, because the model executing /ship is the thing that has to
  // invoke them.
  // The axis is NOT "does the user type it" -- /blueprint is typed AND called by
  // /ship. It is "is it ever invoked by another command": if yes it
  // must be model-invokable, because the model executing the caller is what
  // invokes it.
  const OUTERMOST = ['ship', 'diagnose', 'attack', 'handoff', 'quick']; // nothing calls these
  // /blueprint and /ship run /brainstorm as their brainstorming step.
  const CALLED = ['blueprint', 'brief', 'execute', 'land', 'brainstorm']; // another command invokes these
  // OPEN: no side effects, nothing calls them, and they must stay
  // model-invokable on purpose so /blueprint, /diagnose and similar callers remain free
  // to reach for them later. Without this list, the frontmatter requirement
  // that explain.md omit disable-model-invocation is guarded by nothing:
  // adding the flag would leave OUTERMOST and CALLED both satisfied and the
  // suite green.
  const OPEN = ['explain'];
  const flagged = (n) => fs.readFileSync(path.join(COMMANDS, `${n}.md`), 'utf8')
    .split('---')[1].includes('disable-model-invocation: true');
  const bad = [];
  for (const n of OUTERMOST) if (!flagged(n)) bad.push(`${n}.md is never called by another command and must NOT be model-invokable`);
  for (const n of CALLED) if (flagged(n)) bad.push(`${n}.md is invoked by another command and MUST be model-invokable`);
  for (const n of OPEN) if (flagged(n)) bad.push(`${n}.md has no side effects and must stay model-invokable`);
  if (bad.length) { fail(`command invocability split: ${pyList(bad)}`); return; }
  console.log(`  ok   invocability split holds (${OUTERMOST.length} outermost, ${CALLED.length} called, ${OPEN.length} open)`);

  // A command file named after a Claude Code built-in can be taken over by it.
  // In the desktop app, typing /bug debugged the session and /plan switched on
  // plan mode -- neither ever ran commands/bug.md or commands/plan.md -- which is
  // why those commands are /diagnose and /blueprint. The CLI and VS Code run the
  // user's file instead, but a name has to work on every surface. Names read out
  // of the Claude Code 2.1.280 binary (built-in commands, their aliases, and
  // bundled skills); extend the list when a release adds one.
  const BUILTINS = [
    'add-dir', 'agents', 'batch', 'branch', 'bug', 'clear', 'compact', 'config', 'context',
    'copy', 'debug', 'design', 'diff', 'doctor', 'effort', 'exit', 'export', 'fast',
    'feedback', 'fork', 'goal', 'help', 'hooks', 'init', 'login', 'logout', 'loops', 'mcp',
    'memory', 'model', 'permissions', 'plan', 'plugin', 'recap', 'rename', 'resume', 'run',
    'session', 'settings', 'share', 'skills', 'status', 'stop', 'tasks', 'theme',
    'ultraplan', 'ultrareview', 'update', 'usage', 'version', 'workflows',
  ];
  // /brief is not in the list: its built-in (a brief-only-mode toggle) is off
  // unless a feature flag enables it, and typing /brief ran commands/brief.md in
  // the desktop app, the CLI and VS Code alike.
  const shadowed = fs.readdirSync(COMMANDS).filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((n) => BUILTINS.includes(n));
  if (shadowed.length) { fail(`these commands share a name with a Claude Code built-in, which the desktop app runs instead: ${pyList(shadowed)}`); return; }
  console.log(`  ok   no command shares a name with a Claude Code built-in (${BUILTINS.length} names checked)`);
})();

// --- ${CLAUDE_PLUGIN_ROOT} convention is stated wherever ~/.claude/hooks/ is used ---
// Command, agent and skill markdown ships inside the plugin too, where
// CLAUDE_PLUGIN_ROOT is never an env var the model's Bash tool can read -- it is
// substituted inline into the file's own text before the model ever sees it.
// A file that tells the reader `~/.claude/hooks/<script>.cjs` without also
// stating the `${CLAUDE_PLUGIN_ROOT}/hooks` substitution leaves a plugin
// install with no documented way to find its own scripts, and silently falls
// back to running whatever (if anything) lives at the reader's own ~/.claude.
console.log();
console.log('== ${CLAUDE_PLUGIN_ROOT} convention accompanies every ~/.claude/hooks/ mention ==');
(function pluginRootConvention() {
  const dirs = [COMMANDS, AGENTS, SKILLS];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) files.push(p);
      }
    })(dir);
  }
  const missing = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('~/.claude/hooks/') && !text.includes('${CLAUDE_PLUGIN_ROOT}/hooks')) {
      missing.push(path.relative(ROOT, f));
    }
  }
  if (missing.length) {
    rc = 1;
    console.log(`  FAIL these files mention ~/.claude/hooks/ without stating the \${CLAUDE_PLUGIN_ROOT}/hooks convention: ${missing.join(', ')}`);
  } else {
    console.log(`  ok   every file mentioning ~/.claude/hooks/ also states the \${CLAUDE_PLUGIN_ROOT}/hooks convention (${files.length} files checked)`);
  }
})();

// --- reviewer/orchestrator verification contract (solo-brief dedup) --------
// Task 2 of docs/plans/2026-09-28-test-runs.md: a solo brief's reviewer already
// runs the authoritative test-delta.cjs pass against the reviewed tree, and
// /execute's own step 3 rerun of the same command against the same tree is a
// second full run that tells the orchestrator nothing new. The skip only fires
// when both halves of the contract hold, so this checks both sides: the
// reviewer has to name the exact invocation in its report (not "rerun the
// suite" left ambiguous), the reviewer's TESTS line has to carry test-delta's
// own "on <repo>@<branch>" label (hooks/test-delta.cjs:300) so the report says
// which tree was tested, and /execute's solo-brief step has to state both the
// reuse condition and that the recorded label must match this brief's own
// worktree and branch before it trusts that recorded result instead of
// re-running.
//
// Checking for the bare "test-delta.cjs --command" substring anywhere in
// reviewer.md is not enough: the file's own "## TESTS" output-contract
// EXAMPLE always contains that string (it is the example of what to paste),
// so a check that only greps the whole file stays green even if the actual
// mandate bullet above the example is reverted to "rerun the suite" left
// ambiguous. Scope the mandate check to the text BEFORE "## TESTS" instead.
// Likewise, checking only for the reuse token in execute.md misses that the
// token names the skip ACTION but not its CONDITIONS -- deleting "For a solo
// (non-group) brief only" or the label-match clause would leave a bare
// reuse-token check green, so each required condition is checked as its own
// substring.
//
// A command/label match alone still does not prove the recorded run PASSED:
// a reviewer could approve a brief that broke a test, write a TESTS line with
// the exact right command and label, and the orchestrator would skip its own
// rerun and cite that line -- committing a regression its own rerun would
// have caught. The fix keys on test-delta.cjs's OWN process exit code and its
// own final "test-delta:" verdict line, never on the "`cmd` exit N on
// <label>" line test-delta.cjs prints mid-run for the raw command's first
// run (hooks/test-delta.cjs:300) -- that line's exit code is a different
// number from test-delta.cjs's own exit and can disagree with it in either
// direction (a red baseline or non-repeating flake prints exit 1 there while
// test-delta.cjs itself exits 0; a piped test command can print exit 0 there
// while test-delta.cjs itself blocks with exit 1). So this also checks that
// the mandate tells the reviewer to record test-delta.cjs's own exit code and
// verdict line, that the TESTS template has fields for them, and that
// execute.md's skip condition requires exit 0 plus a passing verdict line.
//
// A command/label/exit-code match still is not enough: round 3 closed the
// gap above by keying the skip on `git status --short` staying unchanged
// since the reviewer's round, but that is a status-LETTER comparison (e.g.
// "M reviewer.md") -- it cannot distinguish two different CONTENTS of a file
// that was already modified before and after. Concrete failure: the reviewer
// runs test-delta (green), then during its own review process touches,
// sabotages or imperfectly restores an owned file -- `git status --short`
// prints "M f" both before and after, identically, so the tripwire stays
// silent and the skip fires over a tree that was never actually verified in
// its final form. Round 4 replaced that comparison with a content-addressed
// hash, using the same mechanism execute.md's own per-round snapshot step
// already uses: `git add -A && git stash create`. But round 4 keyed the
// comparison on the resulting COMMIT sha itself, and `git stash create`
// bakes an author/committer timestamp into that commit object, so invoking
// it twice against a byte-identical tree returns two different commit shas
// -- the orchestrator's freshly-computed sha would then never equal the
// reviewer's recorded one, even when nothing changed, so the skip could
// never fire (safe, but it silently defeats the whole point of this
// mechanism). The fix (round 5) is to resolve and compare the commit's
// `^{tree}` object instead -- deterministic for identical content
// regardless of invocation time -- falling back to `git rev-parse
// HEAD^{tree}` on an already-clean tree (where `git stash create` prints
// nothing). So this checks three more things: the reviewer's mandate tells
// it to resolve that `^{tree}` hash and report it (not the raw stash/HEAD
// commit sha, and not called a "content fingerprint"), the `## TESTS`
// template has a field for the tree hash, and execute.md's skip requires
// the orchestrator's own freshly-computed `^{tree}` hash to EXACTLY MATCH
// the one the reviewer recorded -- not merely that `git status --short`
// looks the same, and not a bare commit-sha comparison either.
console.log();
console.log('== reviewer/orchestrator verification contract (solo-brief dedup) ==');
(function reviewerOrchestratorContract() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  const reviewerText = fs.readFileSync(path.join(AGENTS, 'reviewer.md'), 'utf8');
  // Anchor on the literal heading LINE, not a bare substring: the mandate
  // prose above it references "your `## TESTS` line" in running text, and a
  // plain indexOf would match that prose mention first, truncating
  // mandateSection long before the real mandate bullet ends and leaking most
  // of the mandate into testsSection instead. Match the heading with a
  // multiline regex rather than indexOf('\n## TESTS\n'): this suite is meant
  // to run on a Windows checkout with no .gitattributes forcing LF (see the
  // file header), where Git for Windows checks files out with CRLF line
  // endings -- an LF-only indexOf would find -1 there and FAIL on a correct,
  // unmodified install for no reason but the platform's line endings.
  const testsHeadingMatch = /^## TESTS\r?$/m.exec(reviewerText);
  if (!testsHeadingMatch) {
    fail('agents/reviewer.md has no ## TESTS heading to check the mandate bullet against');
    return;
  }
  const testsMarkerIdx = testsHeadingMatch.index;
  const mandateSection = reviewerText.slice(0, testsMarkerIdx);
  const testsSection = reviewerText.slice(testsMarkerIdx);

  const mandatePhrase = norm(
    'Rerun the tests yourself, by running exactly this — never "rerun the suite" left ambiguous'
  );
  if (!norm(mandateSection).includes(mandatePhrase) || !mandateSection.includes('test-delta.cjs --command')) {
    fail(
      "agents/reviewer.md no longer mandates the exact test-delta.cjs --command invocation " +
      "outside the ## TESTS example (the example alone does not count)"
    );
    return;
  }
  console.log('  ok   agents/reviewer.md mandates the exact test-delta.cjs --command invocation outside the ## TESTS example');

  if (!testsSection.includes('test-delta.cjs --command') || !testsSection.includes('on <repo>@<branch>')) {
    fail("agents/reviewer.md's ## TESTS example no longer requires the test-delta.cjs on <repo>@<branch> label");
    return;
  }
  console.log('  ok   agents/reviewer.md\'s ## TESTS example requires the on <repo>@<branch> label');

  // The command/label check above is not enough on its own: a reviewer could
  // record the right command and label yet never check whether the run it
  // produced actually PASSED, and the orchestrator's skip below would then
  // cite a recorded run that covered a regression. Two more things have to be
  // on record: the mandate must tell the reviewer to capture test-delta.cjs's
  // OWN process exit code (never the test command's echoed exit code, which
  // is a different number and can disagree with test-delta's verdict in
  // either direction), and the ## TESTS template must carry a place to write
  // that exit code and test-delta's own final verdict line down, distinct
  // from the pre-existing "<exact counts> on <repo>@<branch>" text.
  const mandateExitPhrases = [
    "test-delta.cjs's own process exit code",
    'never the exit code of the test command echoed',
    'verdict line verbatim',
  ];
  const missingMandateExit = mandateExitPhrases.filter((p) => !norm(mandateSection).includes(norm(p)));
  if (missingMandateExit.length) {
    fail(
      "agents/reviewer.md's mandate no longer tells the reviewer to record test-delta.cjs's " +
      `own exit code (distinct from the echoed test-command exit) and its verdict line: missing ${missingMandateExit.join(' | ')}`
    );
    return;
  }
  console.log("  ok   agents/reviewer.md mandates recording test-delta.cjs's own exit code and verdict line, distinct from the echoed test-command exit");

  if (!testsSection.includes('test-delta.cjs own exit code') || !testsSection.includes('Verdict:')) {
    fail("agents/reviewer.md's ## TESTS template has no separate field for test-delta.cjs's own exit code and verdict line");
    return;
  }
  console.log("  ok   agents/reviewer.md's ## TESTS template has separate fields for test-delta.cjs's own exit code and verdict line");

  // Round 4's fix: an exit-code/verdict match still does not prove the tree
  // the orchestrator would trust is the tree the reviewer actually tested,
  // because the round-3 tripwire (`git status --short` unchanged) is a
  // status-LETTER comparison that cannot tell two different contents of an
  // already-modified file apart. The mandate now has to tell the reviewer to
  // resolve a `^{tree}` hash of the tree the moment its test-delta run
  // finishes -- the same `git stash create` mechanism execute.md's own
  // snapshot step uses, but resolved to the tree object rather than the
  // commit sha, and the `## TESTS` template needs a field to write that
  // tree hash down. (Round 5: the commit sha itself is unusable here --
  // `git stash create` bakes an author/committer timestamp into the commit
  // it writes, so the same command run twice against a byte-identical tree
  // returns two different commit shas. Only the `^{tree}` hash is
  // deterministic for identical content, so this checks for the tree-hash
  // wording specifically and rejects the file still calling the raw
  // stash/HEAD sha a "content fingerprint".)
  const mandateTreeHashPhrases = [
    'tree hash',
    'git add -A && git stash create',
    '^{tree}',
    'git rev-parse HEAD^{tree}',
  ];
  const missingMandateTreeHash = mandateTreeHashPhrases.filter((p) => !norm(mandateSection).includes(norm(p)));
  if (missingMandateTreeHash.length) {
    fail(
      "agents/reviewer.md's mandate no longer tells the reviewer to resolve the ^{tree} hash " +
      `of the tree at the moment its test-delta run finishes: missing ${missingMandateTreeHash.join(' | ')}`
    );
    return;
  }
  console.log('  ok   agents/reviewer.md mandates resolving a git-stash-create ^{tree} hash of the tree when its test-delta run finishes');

  if (mandateSection.includes('content fingerprint')) {
    fail(
      'agents/reviewer.md\'s mandate still calls the raw stash/HEAD commit sha a "content ' +
      'fingerprint" -- git stash create bakes a timestamp into that commit object, so it ' +
      'must resolve and report the deterministic ^{tree} hash instead'
    );
    return;
  }
  console.log('  ok   agents/reviewer.md no longer calls the raw stash/HEAD commit sha a "content fingerprint"');

  if (!testsSection.includes('Tree hash')) {
    fail("agents/reviewer.md's ## TESTS template has no field for the tree hash");
    return;
  }
  console.log("  ok   agents/reviewer.md's ## TESTS template has a field for the tree hash");

  const executeText = fs.readFileSync(path.join(COMMANDS, 'execute.md'), 'utf8');
  const stepStart = executeText.indexOf('Run one suite pass');
  const stepEnd = stepStart === -1 ? -1 : executeText.indexOf('**Commit**', stepStart);
  if (stepStart === -1 || stepEnd === -1) {
    fail('commands/execute.md no longer has a "Run one suite pass" step to check');
    return;
  }
  const stepText = norm(executeText.slice(stepStart, stepEnd));
  const requiredPieces = [
    'For a solo (non-group) brief only',
    "skip the orchestrator's own rerun and cite the reviewer's recorded result",
    'on <repo>@<branch>',
    "matches this brief's own worktree directory name and current branch",
    // The fourth required condition: the recorded run has to have actually
    // PASSED, judged by test-delta.cjs's own exit code and verdict line --
    // not by the unrelated "`cmd` exit N on <label>" line test-delta prints
    // for the raw test command's first run, which this repo has reproduced
    // disagreeing with test-delta's own verdict in both directions.
    'the recorded test-delta.cjs exit code is 0 and its verdict line is one of the passing forms',
    'nothing newly failing',
    'not blocking',
    'no baseline existed, so this run is the baseline',
    "never the test command's echoed",
    'never to the group pass',
    // Round 4's fix: the fifth required condition replaces the round-3
    // git-status-letter tripwire with a content-addressed one -- the skip
    // must require the orchestrator's own freshly computed hash to exactly
    // match the one the reviewer recorded, computed with the same
    // git-stash-create mechanism execute.md's own snapshot step uses. Round
    // 5: that hash has to be the commit's `^{tree}` object, not the commit
    // sha itself, since `git stash create` returns a different commit sha
    // on every invocation (timestamped) even against an unchanged tree.
    'EXACTLY MATCHES the tree hash the',
    'git add -A && git stash create',
    '^{tree}',
    'git rev-parse HEAD^{tree}',
  ];
  const missing = requiredPieces.filter((piece) => !stepText.includes(norm(piece)));
  if (missing.length) {
    fail(`commands/execute.md's solo-brief step is missing: ${missing.join(' | ')}`);
    return;
  }
  console.log('  ok   commands/execute.md states the solo-brief reuse condition, including the worktree/branch-label, test-delta-passed, and tree-hash-match checks');

  if (stepText.includes(norm('`git status --short` shows the tree unchanged since that round'))) {
    fail(
      "commands/execute.md's solo-brief step still keys the skip on the old " +
      "`git status --short` tripwire, which cannot tell two different contents of an " +
      'already-modified file apart -- it must require an exact tree-hash match instead'
    );
    return;
  }
  console.log('  ok   commands/execute.md no longer keys the skip on the git-status-letter tripwire');

  if (norm(executeText.slice(stepStart, stepEnd)).includes('fingerprint')) {
    fail('commands/execute.md\'s solo-brief step still calls the mechanism a "fingerprint" instead of a tree hash');
    return;
  }
  console.log('  ok   commands/execute.md no longer calls the mechanism a "fingerprint"');
})();

// --- /brief's House rules template states a fast/full test-command split ---
// Task 3 of docs/plans/2026-09-28-test-runs.md: /brief's House rules block used
// to hand every role a single `Tests:` command, so the implementer's per-file
// changed-test run (agents/implementer.md's "run only the tests related to
// the change" bullet) and the reviewer/orchestrator/`/land` full-suite run
// shared one line -- correct for the full run, but leaving the implementer to
// invent a fast command from scratch each session instead of the repo writing
// one down once. The template now needs BOTH `Tests (full):` (the renamed
// original line, still what the reviewer, orchestrator and `/land` run) and
// `Tests (fast):` (the per-repo changed-file command, filled in by /brief only
// when a real command is confirmed against the repo -- `TBD` otherwise, per
// the plan's "do not invent commands" rule, never a guess). Scoped to the
// "House rules block" section specifically, not the whole file, so a stray
// "Tests (fast):" or "Tests (full):" mention anywhere else in the file could
// not paper over the actual template still missing one.
console.log();
console.log("== /brief's House rules template states a fast/full test-command split ==");
(function briefFastFullTests() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const briefText = fs.readFileSync(path.join(COMMANDS, 'brief.md'), 'utf8');
  const blockStart = briefText.indexOf('## House rules block');
  const blockEnd = blockStart === -1 ? -1 : briefText.indexOf('## Brief template', blockStart);
  if (blockStart === -1 || blockEnd === -1) {
    fail('commands/brief.md has no "House rules block" section to check');
    return;
  }
  const block = briefText.slice(blockStart, blockEnd);
  const missing = ['Tests (full):', 'Tests (fast):'].filter((tok) => !block.includes(tok));
  if (missing.length) {
    fail(`commands/brief.md's House rules block template is missing: ${missing.join(', ')}`);
    return;
  }
  console.log("  ok   commands/brief.md's House rules block template states both Tests (full): and Tests (fast):");
})();

// --- the -lite agents mirror their base agents ------------------------------
// /subagent-mode fast swaps these four roles for a `-lite` twin: the same
// prompt, model and tools at effort medium. A twin whose body drifts from its
// base is a different reviewer wearing the same name, and nothing else would
// notice -- so the body must stay byte-identical and the frontmatter may differ
// only in name, description suffix and effort.
console.log();
console.log('== the -lite agents mirror their base agents ==');
(function liteAgentsMirrorBase() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const split = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return null;
    const fm = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { fm, body: m[2] };
  };
  const problems = [];
  const bases = ['reviewer', 'debugger', 'plan-auditor', 'root-cause-auditor'];
  for (const base of bases) {
    const litePath = path.join(AGENTS, `${base}-lite.md`);
    if (!fs.existsSync(litePath)) { problems.push(`agents/${base}-lite.md is missing`); continue; }
    const b = split(path.join(AGENTS, `${base}.md`));
    const l = split(litePath);
    if (!b || !l) { problems.push(`${base}: frontmatter does not parse`); continue; }
    // Same key set as the base: a key only the twin carries (a permissionMode,
    // say) would change what the "same agent at lower effort" can do.
    const keys = (fm) => Object.keys(fm).sort().join(',');
    if (keys(l.fm) !== keys(b.fm)) problems.push(`${base}-lite: frontmatter keys [${keys(l.fm)}] differ from base [${keys(b.fm)}]`);
    if (l.fm.name !== `${base}-lite`) problems.push(`${base}-lite: name is "${l.fm.name}"`);
    if (l.fm.model !== b.fm.model) problems.push(`${base}-lite: model "${l.fm.model}" differs from base "${b.fm.model}"`);
    if (l.fm.tools !== b.fm.tools) problems.push(`${base}-lite: tools differ from base`);
    if (l.fm.effort !== 'medium') problems.push(`${base}-lite: effort is "${l.fm.effort}", want "medium"`);
    if (!(l.fm.description || '').startsWith(b.fm.description || '\0')) problems.push(`${base}-lite: description does not start with the base description`);
    if (l.body !== b.body) problems.push(`${base}-lite: body has drifted from agents/${base}.md`);
  }
  if (problems.length) { fail(`-lite agents: ${problems.join('; ')}`); return; }
  console.log(`  ok   ${bases.length} -lite agents match their base in body, model and tools, at effort medium`);
})();

// --- /subagent-mode exists and is documented ---------------------------------
// discipline-reminder.cjs reads <config>/subagent-mode; the command is the only
// sanctioned writer, and CLAUDE.md's routing section is where a reader learns
// the toggle exists.
console.log();
console.log('== /subagent-mode exists and is documented ==');
(function subagentModeCommand() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const cmdPath = path.join(COMMANDS, 'subagent-mode.md');
  if (!fs.existsSync(cmdPath)) { fail('commands/subagent-mode.md is missing'); return; }
  const cmd = fs.readFileSync(cmdPath, 'utf8');
  const missing = ['disable-model-invocation: true', '/subagent-mode', 'SHIP_LOOP_PASS']
    .filter((tok) => !cmd.includes(tok));
  if (missing.length) { fail(`commands/subagent-mode.md is missing: ${missing.join(', ')}`); return; }
  if (!fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').includes('/subagent-mode')) {
    fail('CLAUDE.md does not mention /subagent-mode'); return;
  }
  console.log('  ok   commands/subagent-mode.md exists, is user-only, and CLAUDE.md names it');
})();

// --- inside the /ship pipeline, sabotage leaves the implementer's loop --------
// The implementer proves a new test by seeing it red before its change
// (red -> green on the fast command) and runs no separate sabotage pass. The
// reviewer names one sabotage per new or changed test; the orchestrator
// performs them serially after the review. The reviewer cannot do it itself:
// it has no Edit tool, the edit gate refuses a Bash edit without a lookup it
// has no tool for, and reviewers in a parallel group share one worktree. The
// global rule in CLAUDE.md and its plugin mirror stays in force outside the
// pipeline. Each file is checked for the sentence that carries its part.
console.log();
console.log('== inside the /ship pipeline, sabotage leaves the implementer\'s loop ==');
(function sabotageOwnedByReviewer() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  // Whitespace is collapsed before matching: these files are hard-wrapped
  // prose, and a sentence split across two lines must still match (or still
  // be caught when it should be gone).
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\s+/g, ' ');
  const problems = [];
  if (!read('agents', 'implementer.md').includes('No separate sabotage pass')) {
    problems.push('agents/implementer.md does not say it runs no separate sabotage pass');
  }
  const rev = read('agents', 'reviewer.md');
  const fullStart = rev.indexOf('## Mandatory checks (full review)');
  const fullEnd = rev.indexOf('## Light review', fullStart);
  if (fullStart === -1 || fullEnd === -1) { fail('agents/reviewer.md has no full-review section to check'); return; }
  const full = rev.slice(fullStart, fullEnd);
  if (!full.includes('Name one sabotage for each new or changed test')) {
    problems.push("agents/reviewer.md's full review does not name a sabotage per test");
  }
  // The full-review bullet itself mentions `## SABOTAGE`, so the section is
  // looked for in the output contract only.
  const contractStart = rev.indexOf('## Output contract');
  if (contractStart === -1 || !rev.slice(contractStart).includes('## SABOTAGE')) {
    problems.push("agents/reviewer.md's output contract has no ## SABOTAGE section");
  }
  // Scoped to the step itself. A green sabotage or a missing section must also
  // count as a review round, or a reviewer whose sabotage never reaches the
  // assertion loops implementer -> reviewer forever without the debugger firing.
  const exec = read('commands', 'execute.md');
  const stepStart = exec.indexOf("Perform the reviewer's named sabotages");
  const stepEnd = exec.indexOf('Run one suite pass', stepStart);
  if (stepStart === -1 || stepEnd === -1) {
    problems.push("commands/execute.md has no \"Perform the reviewer's named sabotages\" step before the suite pass");
  } else {
    const step = exec.slice(stepStart, stepEnd);
    for (const tok of ['mktemp', 'never with `git checkout -- <file>`', 'run-state.cjs review-round']) {
      if (!step.includes(tok)) problems.push(`commands/execute.md's sabotage step is missing: ${tok}`);
    }
  }
  const brief = read('commands', 'brief.md');
  const houseStart = brief.indexOf('## House rules block');
  const houseEnd = brief.indexOf('## Brief template', houseStart);
  if (houseStart === -1 || houseEnd === -1) { fail('commands/brief.md has no "House rules block" section to check'); return; }
  const house = brief.slice(houseStart, houseEnd);
  if (house.includes('A test counts only if you sabotage what it guards')) {
    problems.push("commands/brief.md's House rules still hand the sabotage step to the implementer");
  }
  if (!house.includes('the reviewer names one sabotage per test and the orchestrator performs it')) {
    problems.push("commands/brief.md's House rules do not say who names and who performs the sabotage");
  }
  for (const f of [['CLAUDE.md'], ['skills', 'workflow-discipline', 'SKILL.md']]) {
    if (!read(...f).includes("Inside the `/ship` pipeline this step leaves the implementer's loop")) {
      problems.push(`${f.join('/')} does not scope the sabotage rule inside /ship`);
    }
  }
  if (problems.length) { fail(problems.join('; ')); return; }
  console.log('  ok   implementer, reviewer, /execute, /brief, CLAUDE.md and workflow-discipline agree: the reviewer names each sabotage, the orchestrator performs it');
})();

// --- the do-it-now threshold is stated the same way everywhere ---------------
// /quick escalates past it, and /ship's and /blueprint's triage route under it
// to /quick. If the three procedures disagree, triage sends work to /quick
// that /quick then refuses (or the reverse). The threshold counts only
// behaviour-bearing code -- a test, a doc line or a generated file carries no
// behaviour risk -- and a change to a gate escalates at any size, because a
// one-character slip there silently disables a check. The docs must not keep
// quoting the old size-only numbers.
console.log();
console.log('== the do-it-now threshold is stated the same way everywhere ==');
(function doItNowThreshold() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\s+/g, ' ');
  const SIZE = 'at most 5 files and about 80 changed lines of behaviour-bearing code';
  const GATE = 'no change to a gate, permission or auth check';
  const OLD = [/\b3 files\b/, /≤3 files/, /\b30 (changed )?lines/];
  const problems = [];
  const procedures = [['commands', 'quick.md'], ['commands', 'ship.md'], ['commands', 'blueprint.md']];
  const docs = [['README.md'], ['docs', 'CHEATSHEET.md'], ['docs', 'COMMANDS.md']];
  for (const f of procedures) {
    const text = read(...f);
    for (const tok of [SIZE, GATE]) if (!text.includes(tok)) problems.push(`${f.join('/')} is missing "${tok}"`);
  }
  for (const f of [...procedures, ...docs]) {
    const text = read(...f);
    if (OLD.some((re) => re.test(text))) problems.push(`${f.join('/')} still states the old 3-file / 30-line threshold`);
  }
  // The docs paraphrase the threshold, so they are held to its defining phrase
  // rather than the procedures' exact sentence.
  for (const f of docs) {
    if (!read(...f).includes('lines of behaviour-bearing code')) problems.push(`${f.join('/')} does not state the threshold in behaviour-bearing lines`);
  }
  if (!read('commands', 'quick.md').includes('Tests (fast):')) {
    problems.push("commands/quick.md's change path does not point at the repo's Tests (fast): command");
  }
  if (problems.length) { fail(problems.join('; ')); return; }
  console.log(`  ok   ${procedures.length} procedures state one threshold, and no procedure or doc keeps the old numbers`);
})();

// --- hooks.json does not drift from settings.json ----------------------------
// hooks/hooks.json is what the plugin ships; settings.json is what this repo
// runs. A colleague who installs the plugin never sees settings.json at all,
// so a hook added to one and not the other is invisible here and silently
// missing there. The two files are never byte-identical by design --
// settings.json uses absolute shell-quoted paths, hooks.json uses
// ${CLAUDE_PLUGIN_ROOT} in exec form -- so this compares what each event
// actually wires: the same set of (matcher, script basename) pairs.
console.log();
console.log('== hooks.json (the plugin) matches settings.json (this repo) ==');
(function hooksJsonDrift() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; return false; };
  const pyList = (arr) => `[${arr.map((x) => `'${x}'`).join(', ')}]`;

  let settingsHooks, pluginHooks;
  try {
    settingsHooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8')).hooks;
  } catch (e) {
    fail(`could not read/parse settings.json: ${e.message}`);
    return;
  }
  try {
    pluginHooks = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  } catch (e) {
    fail(`could not read/parse hooks/hooks.json: ${e.message}`);
    return;
  }

  // Reduce either shape to { event: Set<"matcher::scriptBasename"> }.
  // scriptOf hides the one difference that is supposed to exist (shell-quoted
  // absolute path vs. exec-form args array) so the comparison below is over
  // meaning, not syntax.
  function shape(hooksBlock, scriptOf) {
    const out = {};
    for (const [event, entries] of Object.entries(hooksBlock || {})) {
      const set = out[event] = new Set();
      for (const entry of entries) {
        const matcher = entry.matcher ?? '(all)';
        for (const hk of entry.hooks) set.add(`${matcher}::${scriptOf(hk)}`);
      }
    }
    return out;
  }
  const settingsShape = shape(settingsHooks, (hk) => {
    const p = hookCommandPath(hk.command);
    return path.basename(p || hk.command);
  });
  const pluginShape = shape(pluginHooks, (hk) => {
    const args = hk.args || [];
    return path.basename(args[args.length - 1] || hk.command);
  });

  const events = [...new Set([...Object.keys(settingsShape), ...Object.keys(pluginShape)])].sort();
  const problems = [];
  for (const ev of events) {
    const a = settingsShape[ev] || new Set();
    const b = pluginShape[ev] || new Set();
    const onlyInSettings = [...a].filter((x) => !b.has(x)).sort();
    const onlyInPlugin = [...b].filter((x) => !a.has(x)).sort();
    if (onlyInSettings.length) problems.push(`${ev}: in settings.json but not hooks.json: ${pyList(onlyInSettings)}`);
    if (onlyInPlugin.length) problems.push(`${ev}: in hooks.json but not settings.json: ${pyList(onlyInPlugin)}`);
  }
  if (problems.length) { fail(`hooks.json has drifted from settings.json -- ${problems.join('; ')}`); return; }
  console.log(`  ok   hooks.json mirrors settings.json across ${events.length} events (same matcher+script pairs)`);
})();

// --- serena: the plugin starts the relay, project scope stays out of it -------
// Probed on Claude Code 2.1.280 with `claude mcp list`:
// - Plugin scope loads the root .mcp.json, then each file plugin.json names
//   under mcpServers; a later serena replaces an earlier one. It substitutes
//   the plain `${CLAUDE_PLUGIN_ROOT}` with the plugin root, but the
//   `${CLAUDE_PLUGIN_ROOT:-d}` form gives d, and a relative path resolves
//   against the session's cwd, which for the plugin is some other repository.
// - Project scope (the root .mcp.json, for sessions in this repo) must not
//   declare serena at all. It has only environment expansion, in Claude Code's
//   own environment, and the server's CLAUDE_PROJECT_DIR and cwd are both the
//   directory the session started in. So no path written there reaches the
//   relay from a subdirectory. Project scope also outranks user scope, so a
//   serena there would shadow the user-scope entry, whose shell-expanded
//   absolute path works from anywhere.
// The plugin's effective entry is resolved the way the plugin loader would and
// checked on the filesystem: a regex over the string would pass a path to a
// relay that does not exist, and a `:-.` path that only works in this repo.
// A serena entry that fails to start takes the edit gate's required reference
// lookups with it.
console.log();
console.log('== serena: the plugin starts the relay, project scope does not declare it ==');
(function serenaRelayEntry() {
  const fail = (msg) => { console.log(`  FAIL ${msg}`); rc = 1; };
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  // An MCP config file loads either as {"mcpServers": {...}} or as the bare map.
  const serversIn = (json) => (json && typeof json.mcpServers === 'object' ? json.mcpServers : json) || {};

  let rootEntry, pluginEntry;
  try {
    // The root .mcp.json is optional; the plugin loader skips a missing one.
    rootEntry = fs.existsSync(path.join(ROOT, '.mcp.json')) ? serversIn(readJson('.mcp.json')).serena : undefined;
    pluginEntry = rootEntry;
    const manifest = readJson(path.join('.claude-plugin', 'plugin.json'));
    for (const shape of [].concat(manifest.mcpServers || [])) {
      const servers = typeof shape === 'string' ? serversIn(readJson(shape)) : shape;
      if (servers.serena) pluginEntry = servers.serena;
    }
  } catch (e) {
    fail(`could not read the serena MCP configs: ${e.message}`);
    return;
  }

  if (rootEntry) {
    fail(`project scope: the root .mcp.json declares serena (${JSON.stringify([rootEntry.command, ...(rootEntry.args || [])])}); ` +
      'it breaks sessions started in a subdirectory and shadows the user-scope entry');
  } else {
    console.log('  ok   project scope: the root .mcp.json does not declare serena');
  }

  // A directory that does not exist stands in for the other repository the
  // plugin runs in, so no relative path can resolve there by accident.
  const otherRepo = path.join(os.tmpdir(), 'serena-relay-check-other-repo');
  if (!pluginEntry) { fail('plugin scope: no serena entry'); return; }
  const script = (pluginEntry.args || [])[0];
  if (pluginEntry.command !== 'node' || typeof script !== 'string') {
    fail(`plugin scope: serena runs ${JSON.stringify([pluginEntry.command, ...(pluginEntry.args || [])])}, not \`node <relay>\``);
    return;
  }
  const expanded = script.replace(/\$\{CLAUDE_PLUGIN_ROOT(?::-([^}]*))?\}/g,
    (m, dflt) => (dflt !== undefined ? dflt : ROOT));
  if (expanded.includes('${')) { fail(`plugin scope: serena's relay path ${script} keeps an unexpanded variable`); return; }
  const resolved = path.resolve(otherRepo, expanded);
  if (path.basename(resolved) !== 'serena-relay.cjs') { fail(`plugin scope: serena starts ${resolved}, not serena-relay.cjs`); return; }
  if (!fs.existsSync(resolved)) { fail(`plugin scope: serena's relay path ${script} resolves to ${resolved}, which does not exist`); return; }
  console.log(`  ok   plugin scope: serena starts ${script} -> ${path.relative(ROOT, resolved)}, which exists`);
})();

// --- the plan gate's contract with its own documentation --------------------
console.log();
console.log("== the plan gate's contract with its own documentation ==");
(function planGateDocs() {
  // The docs tell you to write a heading and a verdict footer; the hooks
  // parse them. Four of the frontend gates in the demo repo were caught
  // going green over broken behaviour because they matched text instead of
  // running it, so this block RUNS the real parsers against the exact
  // strings blueprint.md and plan-auditor.md publish.
  const lib = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
  const bad = [];

  // 1. The acknowledgement heading the docs publish must be the one the gate reads.
  for (const f of ['commands/blueprint.md', 'agents/plan-auditor.md']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const headings = [...text.matchAll(/##[^\n`]*Known defects[^\n`]*/g)].map((m) => m[0].trim());
    if (!headings.length) { bad.push(`${f} no longer publishes a "## Known defects" heading`); continue; }
    for (const h of headings) {
      if (!lib.acceptedIds(`${h}\n- D1: accepted\n`).includes('D1')) {
        bad.push(`${f} publishes "${h}", which gate-lib does not recognise as the acknowledgement section`);
      }
    }
  }

  // 2. The verdict footer plan-auditor.md publishes must record as
  //    plan-auditor.md says it does -- run it through the real PostToolUse
  //    hook and read the marker.
  const auditor = fs.readFileSync(path.join(ROOT, 'agents', 'plan-auditor.md'), 'utf8');
  const m = /```\n(## Audit Verdict\n[\s\S]*?)```/.exec(auditor);
  if (!m) {
    bad.push('plan-auditor.md no longer shows a "## Audit Verdict" footer example');
  } else {
    const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'planconf-doc-'));
    const plan = path.join(conf, 'plan.md');
    fs.writeFileSync(plan, '# plan\n');
    const footer = m[1].replace(/^Plan:.*$/m, `Plan: ${plan}`);
    spawnSync('node', [path.join(HOOKS, 'gates', 'plan-audit-record.cjs')], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 'doc',
        tool_input: { subagent_type: 'plan-auditor' }, tool_response: footer,
      }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: conf },
    });
    const key = crypto.createHash('sha256').update(plan).digest('hex').slice(0, 32);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(conf, 'state', 'plan-audited', `${key}.json`), 'utf8')); } catch { /* checked below */ }
    if (!rec) {
      bad.push('the footer plan-auditor.md publishes records no verdict at all');
    } else {
      const want = { verdict: 'DEFECTS', blocking: ['D1', 'D4'] };
      if (rec.verdict !== want.verdict) bad.push(`the published footer records ${rec.verdict}, not ${want.verdict}`);
      if (JSON.stringify(rec.blocking) !== JSON.stringify(want.blocking)) {
        bad.push(`the published footer records blocking ${JSON.stringify(rec.blocking)}, not ${JSON.stringify(want.blocking)}`);
      }
    }
    fs.rmSync(conf, { recursive: true, force: true });
  }

  if (bad.length) {
    bad.forEach((b) => console.log(`  FAIL ${b}`));
    rc = 1;
  } else {
    console.log('  ok   the acknowledgement heading and the verdict footer both parse as documented');
  }
})();

// --- slash commands ----------------------------------------------------------
console.log();
console.log('== slash commands ==');
// Claude Code parses command and agent frontmatter as YAML. A value it cannot
// parse is logged as "Failed to parse YAML frontmatter" and the file loads
// without it. Two unquoted forms have done that here: a value opening with `[`
// that is more than one bracketed group (`[target: …] [axes, optional]` is a
// flow sequence followed by stray text), and a plain value containing `: `
// (`(effort medium): dispatch …` reads as a second mapping). Quote the value
// whenever it needs either. No YAML parser is available dependency-free, so this
// checks exactly those two forms rather than YAML in general.
(function frontmatterParses() {
  const bad = [];
  for (const dir of [COMMANDS, AGENTS]) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) continue;
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!kv) continue;
        const value = kv[2].trim();
        if (/^["']/.test(value)) continue;
        const rel = `${path.basename(dir)}/${f} ${kv[1]}`;
        if (value.startsWith('[') && !/^\[[^[\]]*\]$/.test(value)) bad.push(`${rel} (more than one bracketed group)`);
        else if (!value.startsWith('[') && /: /.test(value)) bad.push(`${rel} (unquoted ": ")`);
      }
    }
  }
  if (bad.length) {
    console.log(`  FAIL frontmatter values YAML cannot parse -- quote them: ${bad.join('; ')}`);
    rc = 1;
    return;
  }
  console.log('  ok   every command and agent frontmatter value is YAML-parseable (no stray bracket groups, no unquoted ": ")');
})();
for (const f of fs.readdirSync(COMMANDS).filter((n) => n.endsWith('.md')).sort()) {
  const text = fs.readFileSync(path.join(COMMANDS, f), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('description:')) || '';
  const desc = line.slice(13, 90); // matches bash's `cut -c14-90` (1-based, inclusive)
  console.log(`  /${path.basename(f, '.md').padEnd(12)} ${desc}`);
}

// --- gated repos --------------------------------------------------------------
console.log();
console.log('== gated repos (a .serena/project.yml is what turns the gates on) ==');
(function gatedRepos() {
  // Scanned once into a list, not twice: the assertion below and the listing
  // have to be reading the same set, or the assertion stops meaning anything.
  //
  // ROOT is scanned by itself (a plain existence check, no traversal) while
  // the Documents roots go five levels deep. ROOT is the repository these
  // gates live in and is read by absolute path elsewhere in this script, so
  // it belongs in its own listing -- but a depth-5 scan of it would also pull
  // in plugins/cache, plugins/marketplaces and backups/, which are vendored
  // or machine-written and are not ours to report on.
  const PRUNE = new Set(['node_modules', '.venv', 'venv', 'dist', 'build', '.next']);

  function findGitDirs(root, maxDepth) {
    // `find -name .git` (no -type) matches a plain repo's .git DIRECTORY as
    // well as the .git FILE a git worktree leaves behind (a gitdir pointer).
    // Checking isDirectory() before recognising the marker would silently
    // drop every worktree checkout from the report -- eleven of them here.
    const found = [];
    function walk(dir, depth) {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === '.git') { found.push(dir); continue; }
        if (!e.isDirectory()) continue;
        if (PRUNE.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      }
    }
    walk(root, 0);
    return found;
  }

  // Which directories to scan (besides ROOT itself, always included) is
  // per-machine and potentially names clients, so it is not hardcoded here --
  // it comes from CLAUDE_REPO_SCAN_ROOTS (path.delimiter-separated, ':' on
  // macOS/Linux, ';' on Windows). Unset, the report covers only this repo.
  const gatedRepoList = [];
  if (fs.existsSync(path.join(ROOT, '.git'))) gatedRepoList.push(ROOT);
  const scanRoots = (process.env.CLAUDE_REPO_SCAN_ROOTS || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const scanRoot of scanRoots) {
    if (fs.existsSync(scanRoot)) gatedRepoList.push(...findGitDirs(scanRoot, 5));
  }
  gatedRepoList.sort();

  if (!gatedRepoList.includes(ROOT)) {
    console.log('  FAIL the gated-repos scan does not cover the repo these gates live in');
    rc = 1;
  }

  for (const d of gatedRepoList) {
    if (!fs.existsSync(path.join(d, '.git'))) continue;
    const name = path.basename(d).padEnd(26);
    const ymlPath = path.join(d, '.serena', 'project.yml');
    if (fs.existsSync(ymlPath)) {
      let servers = '';
      try {
        const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
        const i = lines.findIndex((l) => l.startsWith('language_servers:'));
        if (i >= 0) {
          const out = [];
          for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j++) out.push(lines[j].slice(2).trim());
          servers = out.join(' ');
        }
      } catch { /* unreadable config prints as gated with no servers listed */ }
      console.log(`  ${name} ${servers} `);
    } else {
      console.log(`  ${name} NOT gated — run claude-repo-setup.sh --write`);
    }
  }
})();

  return rc;
}

module.exports = { runUnitSuites, unitScript, runPool, UNIT_SUITES, SERIAL_SUITES, POOL_CONCURRENCY, SUITE_BUDGET_MS };
if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error(e); process.exit(1); });
}
