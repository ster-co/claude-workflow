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
const { spawnSync } = require('child_process');

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

let rc = 0;

// --- hook behaviour: the 7 unit suites -------------------------------------
// A pipeline's exit status is the LAST command's. The bash version once ran
// these as `node test.cjs | tail -2`, which reported tail's status -- always
// 0 -- so a red unit test could not fail the script. It reported success over
// two failing assertions on 2026-09-22. Capture the child's status directly;
// never pipe it through something else's exit code.
function unit(script) {
  const r = spawnSync('node', [path.join(HOOKS, 'test', script)], { encoding: 'utf-8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  console.log(lines.slice(-2).join('\n'));
  const status = r.status === null ? 1 : r.status;
  if (status !== 0) {
    rc = 1;
    console.log(`  ^^ FAILED (exit ${status}): node ${script}`);
  }
}

console.log('== hook behaviour ==');
unit('test-gates.cjs');
unit('test-plan-gate.cjs');
unit('test-verify-checkpoint.cjs');
unit('test-run-state-registry.cjs');
unit('test-agent-log.cjs');
unit('test-repo-setup.cjs');
unit('test-test-delta.cjs');

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
        const p = hookCommandPath(hk.command);
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
  const callers = [['land.md', 'test-delta'], ['execute.md', 'test-delta']];
  const missingCallers = callers.filter(([c, tok]) =>
    !fs.readFileSync(path.join(COMMANDS, c), 'utf8').includes(tok)).map(([c]) => c);
  if (missingCallers.length) { fail(`these commands no longer run the test delta: ${pyList(missingCallers)}`); return; }
  console.log(`  ok   the test delta is still called by ${callers.length} commands`);

  // An adversary that a command stops dispatching disappears silently: the
  // command still runs, the step is simply gone, and nothing reports a
  // missing audit.
  const wiring = [
    ['plan.md', 'plan-auditor'],
    ['bug.md', 'root-cause-auditor'],
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

  // disable-model-invocation is right for what the USER types and wrong for
  // what a command calls. /ship's own text says "run /brief" and "/execute"
  // -- if those carry the flag, /ship reaches its approval gate and can go
  // no further, because the model executing /ship is the thing that has to
  // invoke them.
  // The axis is NOT "does the user type it" -- /plan is typed AND called by
  // /ship and /bug. It is "is it ever invoked by another command": if yes it
  // must be model-invokable, because the model executing the caller is what
  // invokes it.
  const OUTERMOST = ['ship', 'bug', 'attack', 'handoff']; // nothing calls these
  const CALLED = ['plan', 'brief', 'execute', 'land']; // another command invokes these
  // OPEN: no side effects, nothing calls them, and they must stay
  // model-invokable on purpose so /plan, /bug and similar callers remain free
  // to reach for them later. Without this list, briefs 2 and 3's central
  // frontmatter requirement -- that explain.md and brainstorm.md omit
  // disable-model-invocation -- is guarded by nothing: adding the flag to
  // either would leave OUTERMOST and CALLED both satisfied and the suite
  // green.
  const OPEN = ['explain', 'brainstorm'];
  const flagged = (n) => fs.readFileSync(path.join(COMMANDS, `${n}.md`), 'utf8')
    .split('---')[1].includes('disable-model-invocation: true');
  const bad = [];
  for (const n of OUTERMOST) if (!flagged(n)) bad.push(`${n}.md is never called by another command and must NOT be model-invokable`);
  for (const n of CALLED) if (flagged(n)) bad.push(`${n}.md is invoked by another command and MUST be model-invokable`);
  for (const n of OPEN) if (flagged(n)) bad.push(`${n}.md has no side effects and must stay model-invokable`);
  if (bad.length) { fail(`command invocability split: ${pyList(bad)}`); return; }
  console.log(`  ok   invocability split holds (${OUTERMOST.length} outermost, ${CALLED.length} called, ${OPEN.length} open)`);
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

// --- the plan gate's contract with its own documentation --------------------
console.log();
console.log("== the plan gate's contract with its own documentation ==");
(function planGateDocs() {
  // The docs tell you to write a heading and a verdict footer; the hooks
  // parse them. Four of the frontend gates in the demo repo were caught
  // going green over broken behaviour because they matched text instead of
  // running it, so this block RUNS the real parsers against the exact
  // strings plan.md and plan-auditor.md publish.
  const lib = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
  const bad = [];

  // 1. The acknowledgement heading the docs publish must be the one the gate reads.
  for (const f of ['commands/plan.md', 'agents/plan-auditor.md']) {
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

process.exit(rc);
