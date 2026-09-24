#!/usr/bin/env node
// Behavioural tests for the Serena-backed discipline gates.
// Run: node ~/.claude/hooks/test/test-gates.cjs
//
// The discipline they enforce — look before you edit, read the diff before you
// commit — is unchanged from the gates of an earlier locally-built call-graph
// indexing tool, which these replaced; only
// the evidence differs:
//   edit-gate    satisfied by mcp__serena__find_referencing_symbols
//   commit-gate  satisfied by an actual `git diff` in the same turn
//
// Every assertion is paired with one where the gate MUST NOT fire. A gate that
// blocks everything gets switched off within a day, which is the same as not
// having one.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-gates.cjs -> hooks/test -> hooks: resolve from the
// script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// Never touch the real ~/.claude/state: every run gets its own config dir.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'gateconf-'));
const STATE = path.join(CONFIG, 'state');

function run(script, input, env = {}) {
  const r = spawnSync('node', [path.join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SKIP_CODE_GATES: '', ...env },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
  return { out, code: r.status };
}
const decision = (res) => res.out?.hookSpecificOutput?.permissionDecision ?? 'allow';

// A repo Serena is set up for — that is what makes it gated, mirroring how the
// predecessor's gates keyed on its own project marker directory. Coverage
// follows claude-repo-setup.sh.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gaterepo-'));
fs.mkdirSync(path.join(REPO, '.serena'));
fs.writeFileSync(path.join(REPO, '.serena', 'project.yml'), 'project_name: "gaterepo"\n');
fs.mkdirSync(path.join(REPO, 'src'));
fs.writeFileSync(path.join(REPO, 'src', 'thing.py'), '# x\n');
fs.writeFileSync(path.join(REPO, 'notes.md'), 'x\n');

// A repo with no Serena config at all: the gates must be invisible there.
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gateplain-'));
fs.writeFileSync(path.join(PLAIN, 'a.py'), '# x\n');

const SID = 'test-gates-0001';
const refsMarker = path.join(STATE, 'refs-checked', `${SID}.json`);
const diffMarker = path.join(STATE, 'diff-reviewed', `${SID}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch {} };
const mark = (f) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString() }));
};

const pre = (tool, tool_input, sid = SID, cwd = REPO) => ({
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input, session_id: sid, cwd,
});

// =============================================================================
console.log('\nedit-gate.cjs — look before you edit');
rm(refsMarker);

check('a source edit with no reference lookup is denied',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }))), 'deny');
check('a markdown edit is not policed',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'notes.md') }))), 'allow');
check('a repo without .serena/project.yml is not policed',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(PLAIN, 'a.py') }, SID, PLAIN))), 'allow');

mark(refsMarker);
check('with a reference lookup on file, the same edit is allowed',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }))), 'allow');

// Two thirds of tool calls are Bash, and edits migrate there under auto mode.
// An Edit/Write-only gate sees none of them.
rm(refsMarker);
// Parameterised over tool_name so the same payloads can be replayed under
// `PowerShell` below: on Windows that is the tool Claude Code actually runs,
// and a dispatch that only recognised the literal name `Bash` let every write
// on that platform through unexamined — settings.json routing PowerShell at
// these gates is cosmetic unless the gate code itself treats it the same way.
const toolRunner = (tool) => (cmd) => decision(run('gates/edit-gate.cjs', pre(tool, { command: cmd })));
const bash = toolRunner('Bash');
check('sed -i on a source file is denied', bash(`sed -i '' 's/a/b/' ${REPO}/src/thing.py`), 'deny');
check('a redirect into a source file is denied', bash(`echo x > ${REPO}/src/thing.py`), 'deny');
check('reading a source file is allowed', bash(`cat ${REPO}/src/thing.py`), 'allow');
check('grepping is allowed', bash(`grep -rn thing ${REPO}/src`), 'allow');
check('running the tests is allowed', bash('pytest -q'), 'allow');
// Prose that merely names a command is not that command — the old gates fired
// on exactly this before the quoted-string stripper existed.
check('a heredoc that only mentions a .py path is allowed',
  bash(`cat <<'EOF' > ${REPO}/notes.md\nrun sed -i '' s/a/b/ src/thing.py\nEOF`), 'allow');

// Windows falls back to PowerShell when Git Bash is absent, so writes arrive as
// Set-Content / Out-File / Add-Content rather than a `>` redirect. The gate must
// deny those the same way, not just parse a path out of the string.
check('Set-Content -Path on a source file is denied',
  bash(`Set-Content -Path ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Set-Content with a positional path is denied',
  bash(`Set-Content ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Out-File -FilePath on a source file is denied',
  bash(`Out-File -FilePath ${REPO}/src/thing.py`), 'deny');
check('a pipe into Out-File with a positional path is denied',
  bash(`Get-Content y.py | Out-File ${REPO}/src/thing.py`), 'deny');
check('Add-Content -Path on a source file is denied',
  bash(`Add-Content -Path ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('a quoted -Path value on a source file is denied',
  bash(`Set-Content -Path "${REPO}/src/thing.py" -Value "x"`), 'deny');
check('reading with Get-Content is allowed',
  bash(`Get-Content ${REPO}/src/thing.py`), 'allow');

// A switch ahead of the positional path (idiomatic PowerShell: -Append is *the*
// way to append) must not defeat the scan. -Append/-Force/-NoNewline take no
// value; -Encoding does, and its value must be skipped too, not mistaken for
// the path.
check('Out-File -Append with a positional path is denied',
  bash(`Get-Content a | Out-File -Append ${REPO}/src/thing.py`), 'deny');
check('Out-File -Append with no pipe prefix is denied',
  bash(`Out-File -Append ${REPO}/src/thing.py`), 'deny');
check('Set-Content -Force with a positional path is denied',
  bash(`Set-Content -Force ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Set-Content -Encoding utf8 with a positional path is denied',
  bash(`Set-Content -Encoding utf8 ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Add-Content -NoNewline with a positional path is denied',
  bash(`Add-Content -NoNewline ${REPO}/src/thing.py -Value 'x'`), 'deny');

// A `-Value` argument is not required to be single-line, and writing a
// multi-line file is the single most likely reason a model reaches for
// Set-Content at all. The argument-list scope used to be cut at the first
// `;`, `|` or newline regardless of whether it sat inside the quoted value,
// so a `-Path` that came after an embedded newline was silently dropped from
// the scan.
check('Set-Content with a multi-line -Value and -Path is denied',
  bash(`Set-Content -Value "line one\nline two" -Path ${REPO}/src/thing.py`), 'deny');
check('Set-Content with a multi-line -Value and a positional path is denied',
  bash(`Set-Content -Value "line one\nline two" ${REPO}/src/thing.py`), 'deny');
// A backtick is PowerShell's line-continuation character: a backtick at the
// end of a line means the statement continues on the next, so the newline it
// escapes must not be treated as ending the argument list either.
check('Set-Content -Value "x" with a backtick line continuation before -Path is denied',
  bash(`Set-Content -Value "x" \`\n-Path ${REPO}/src/thing.py`), 'deny');
// A here-string (`@"..."@`) is PowerShell's multi-line string literal — an
// even more direct route to writing a multi-line file than an embedded `\n`.
check('Set-Content with a here-string -Value spanning lines is denied',
  bash(`Set-Content -Value @"\nline one\nline two\n"@ -Path ${REPO}/src/thing.py`), 'deny');

// A cmdlet name that only appears inside quoted prose, a heredoc body, or a
// comment is not an invocation, the same reasoning executableShell's stripper
// already applies to `git commit`, `sed -i`, etc.
check('a commit message mentioning Set-Content is allowed',
  bash(`git commit -m "switch to Set-Content ${REPO}/src/thing.py for writes"`), 'allow');
check('a heredoc body mentioning Set-Content is allowed',
  bash(`cat <<'EOF' > ${REPO}/notes.md\nrun Set-Content ${REPO}/src/thing.py -Value x\nEOF`), 'allow');
check('a PowerShell comment mentioning Set-Content is allowed',
  bash(`# Set-Content ${REPO}/src/thing.py -Value x`), 'allow');

// -Path/-FilePath/-LiteralPath extraction must respect the same quoted spans
// as the cmdlet-name check: a flag mentioned inside a quoted -Value is prose,
// not this invocation's target, whether that means a real target elsewhere in
// the same command was about to be missed, or a target named only in prose
// was about to be flagged in its place.
console.log('\nedit-gate.cjs — -Path extraction inside a quoted -Value is not mistaken for the real one');
rm(refsMarker);
check('a -Path named only inside a quoted -Value does not hide the real target',
  bash(`Set-Content -Value 'see -Path readme.md' -Path ${REPO}/src/thing.py`), 'deny');
check('a -Path named only inside quoted prose does not falsely flag the source file it names',
  bash(`Set-Content -Value "docs mention -Path app.py" -Path ${REPO}/notes.md`), 'allow');

// A `@"..."@` here-string body may contain an unpaired quote (`he said "hi`
// with no closing `"` is ordinary text on a line inside one). Toggling quote
// state one character at a time treats that stray quote as closing the
// string, which then re-opens on the here-string's own closing delimiter and
// never closes again — marking a real write after it as quoted prose.
check('an unpaired quote inside a here-string body does not blind the scanner to a write after it',
  bash(`$t = @"\nhe said "hi\n"@\nSet-Content -Path ${REPO}/src/thing.py -Value $t`), 'deny');

// A separate comment-stripping pass used to run on the raw command text
// before the quote-aware scan, so a `#` inside a quoted -Value erased
// everything after it — including the -Path argument — and the write went
// unseen. An inline comment in written source is the ordinary case for a
// tool whose whole purpose is writing code files.
console.log('\nedit-gate.cjs — a `#` inside a quoted PowerShell string is not a comment');
rm(refsMarker);
check('a `#` inside a double-quoted -Value does not blind the scan to -Path',
  bash(`Set-Content -Value "import os  # noqa" -Path ${REPO}/src/thing.py`), 'deny');
check('a `#` inside a single-quoted -Value does not blind the scan to -Path',
  bash(`Set-Content -Value 'y = 1 # ok' -Path ${REPO}/src/thing.py`), 'deny');
check('a `#` inside a quoted pipeline source does not blind the scan to Out-File',
  bash(`"import os  # noqa" | Out-File ${REPO}/src/thing.py`), 'deny');
check('a `#` inside a quoted -InputObject does not blind the scan to -FilePath',
  bash(`Out-File -InputObject "a # b" -FilePath ${REPO}/src/thing.py`), 'deny');
// Pin the POSIX side's existing behaviour so the two are not accidentally
// re-diverged by a future change to either detector.
check('the identical payload on the POSIX side still denies',
  bash(`echo "import os  # noqa" > ${REPO}/src/thing.py`), 'deny');

// A `#` only starts a comment at a token boundary — start of the command, or
// preceded by whitespace/`;`/`|`/`&`/`(`/`)` — never mid-token. An unquoted
// `#` sitting inside an earlier switch's own value (a hash landing in
// unquoted text the way it would in a channel name or a ticket reference) is
// not that boundary, and must not swallow the rest of the line into a
// "comment" that erases the -Path argument coming after it. The write target
// itself also carries a `#`, in its filename, to double as regression
// coverage for that character surviving detection when it is NOT a comment
// either.
check('an unquoted `#` mid-token in an earlier value does not blind the scan to a later -Path, including one naming a `#` in its own filename',
  bash(`Set-Content -Value done#1 -Path ${REPO}/src/notes#1.py`), 'deny');

console.log('\nedit-gate.cjs — the same payloads, dispatched as tool_name: PowerShell');
rm(refsMarker);
const ps = toolRunner('PowerShell');
check('sed -i on a source file is denied (PowerShell tool)',
  ps(`sed -i '' 's/a/b/' ${REPO}/src/thing.py`), 'deny');
check('reading a source file is allowed (PowerShell tool)',
  ps(`cat ${REPO}/src/thing.py`), 'allow');
check('Set-Content -Path on a source file is denied (PowerShell tool)',
  ps(`Set-Content -Path ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Set-Content with a positional path is denied (PowerShell tool)',
  ps(`Set-Content ${REPO}/src/thing.py -Value 'x'`), 'deny');
check('Get-Content is allowed (PowerShell tool)',
  ps(`Get-Content ${REPO}/src/thing.py`), 'allow');
check('a commit message mentioning Set-Content is allowed (PowerShell tool)',
  ps(`git commit -m "switch to Set-Content ${REPO}/src/thing.py for writes"`), 'allow');

console.log('\nedit-gate.cjs — the home directory is not a gated repo');
// Serena writes a GLOBAL ~/.serena/ holding logs and language servers but no
// project.yml. Treating that as a project config would gate every file on the
// machine — the same trap the predecessor's global registry set.
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gatehome-'));
  fs.mkdirSync(path.join(fakeHome, '.serena', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.serena', 'serena_config.yml'), 'x: 1\n');
  const nested = path.join(fakeHome, 'proj');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'b.py'), '# x\n');
  const { findGatedRoot } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
  check('a .serena without project.yml is not a gated root', findGatedRoot(nested), null);
  fs.writeFileSync(path.join(fakeHome, '.serena', 'project.yml'), 'project_name: "h"\n');
  check('a .serena WITH project.yml is a gated root', findGatedRoot(nested), fakeHome);
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}

// =============================================================================
console.log("\nedit-gate.cjs — a /ship run's phase gates a source edit");
// Bound to sessions of their own (SID_SHIP, SID_NORUN, SID_OTHER) rather than
// SID, so a run created here can never leak into the reference-lookup
// assertions above and below that assume SID has none bound to it.
{
  // run-state.cjs's CLI derives repoKey from process.cwd() AFTER spawnSync's
  // own chdir, which macOS resolves through the /var -> /private/var symlink;
  // edit-gate.cjs derives it from the literal `cwd` string in the hook's JSON
  // payload, never chdir'd at all. The two must be fed the same string or
  // they hash to different repoKeys for the same directory — a symlink
  // artifact of $TMPDIR on this platform, not something either side of the
  // real gate gets to choose. Realpath once here so both sides agree.
  const REPO_RP = fs.realpathSync(REPO);
  const RUN_STATE_BIN = path.join(HOOKS, 'run-state.cjs');
  const rs = (args, { cwd = REPO_RP, session } = {}) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG };
    if (session) env.CLAUDE_CODE_SESSION_ID = session; else delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync('node', [RUN_STATE_BIN, ...args], { cwd, encoding: 'utf-8', env });
    if (r.status !== 0) throw new Error(`run-state.cjs ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  const markerFor = (session) => path.join(STATE, 'refs-checked', `${session}.json`);
  const edit = (session, file, cwd = REPO_RP) =>
    decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: file }, session, cwd)));

  // The refs-checked marker is kept present for every session in this section
  // on purpose: the phase check must fire regardless of it, so proving the
  // blocked phases deny WITH the marker present is what proves the ordering,
  // not an accident of a marker that happens to be missing.
  const SID_SHIP = 'test-gates-ship-0001';
  mark(markerFor(SID_SHIP));

  for (const phase of ['awaiting-direction', 'planning', 'awaiting-approval']) {
    rs(['start', '--feature', 'f-phase', '--phase', phase], { session: SID_SHIP });
    check(`phase '${phase}' denies a source edit`,
      edit(SID_SHIP, path.join(REPO_RP, 'src/thing.py')), 'deny');
  }
  // Restated explicitly: the run is still at 'planning' from the loop above,
  // and the refs-checked marker has been present the whole time.
  check("a blocked phase still denies a source edit with the refs-checked marker present (ordering)",
    edit(SID_SHIP, path.join(REPO_RP, 'src/thing.py')), 'deny');

  for (const phase of ['executing', 'landing']) {
    rs(['start', '--feature', 'f-phase', '--phase', phase], { session: SID_SHIP });
    check(`phase '${phase}' allows a source edit`,
      edit(SID_SHIP, path.join(REPO_RP, 'src/thing.py')), 'allow');
  }

  rs(['start', '--feature', 'f-phase', '--phase', 'executing'], { session: SID_SHIP });
  rs(['finish'], { session: SID_SHIP });
  check('a finished run (finishedAt set) allows a source edit',
    edit(SID_SHIP, path.join(REPO_RP, 'src/thing.py')), 'allow');

  // The do-it-now case: /plan's "do it now" triage creates no run state at
  // all, so a session with no pointer bound must be unaffected. Getting this
  // wrong fires the gate on every ordinary edit.
  const SID_NORUN = 'test-gates-norun-0001';
  mark(markerFor(SID_NORUN));
  check('no run bound to the session allows a source edit (the do-it-now case)',
    edit(SID_NORUN, path.join(REPO_RP, 'src/thing.py')), 'allow');

  // A run bound to a different repository must not block this one — proves
  // the pointer's repoKey check (run-state.cjs's resolve) is honoured.
  const OTHER_REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateother-')));
  const SID_OTHER = 'test-gates-other-0001';
  mark(markerFor(SID_OTHER));
  rs(['start', '--feature', 'f-other', '--phase', 'awaiting-direction'], { cwd: OTHER_REPO, session: SID_OTHER });
  check('a run bound to a different repo does not block this one',
    edit(SID_OTHER, path.join(REPO_RP, 'src/thing.py')), 'allow');
  try { fs.rmSync(OTHER_REPO, { recursive: true, force: true }); } catch {}

  // Writing the plan document (or the brief file) during 'planning' is
  // exactly the right thing to do, so only source files may be guarded.
  rs(['start', '--feature', 'f-phase', '--phase', 'planning'], { session: SID_SHIP });
  fs.mkdirSync(path.join(REPO_RP, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(REPO_RP, 'docs', 'plans', 'brief.md'), '# plan\n');
  check('a plan document under docs/plans is allowed during planning',
    edit(SID_SHIP, path.join(REPO_RP, 'docs', 'plans', 'brief.md')), 'allow');

  rm(markerFor(SID_SHIP));
  rm(markerFor(SID_NORUN));
  rm(markerFor(SID_OTHER));
}

// =============================================================================
console.log('\ncommit-gate.cjs — read the diff before you commit');
rm(diffMarker);
const commit = (cmd, env = {}) => decision(run('gates/commit-gate.cjs', pre('Bash', { command: cmd }), env));

check('a commit with no diff read is denied', commit('git commit -m x'), 'deny');
// Git's global flags sit between `git` and the subcommand and some take a value.
// Consuming the flag but not its value let `git -c user.name=x commit` through.
check('global flags with values do not smuggle a commit past', commit('git -c user.name=x commit -m x'), 'deny');
check('git -C dir commit is still a commit', commit('git -C /tmp commit -m x'), 'deny');
check('a commit in an ungated repo is allowed',
  decision(run('gates/commit-gate.cjs', pre('Bash', { command: 'git commit -m x' }, SID, PLAIN))), 'allow');
// The words inside a message or a document are not an invocation.
check('the words "git commit" inside a quoted string are allowed',
  commit(`echo "remember to git commit -m x" >> ${REPO}/notes.md`), 'allow');
check('git status is not a commit', commit('git status --short'), 'allow');

mark(diffMarker);
check('after reading the diff, the commit is allowed', commit('git commit -m x'), 'allow');

console.log('\ncommit-gate.cjs — the same payloads, dispatched as tool_name: PowerShell');
rm(diffMarker);
const commitPs = (cmd, env = {}) => decision(run('gates/commit-gate.cjs', pre('PowerShell', { command: cmd }), env));
check('a commit with no diff read is denied (PowerShell tool)', commitPs('git commit -m x'), 'deny');
mark(diffMarker);
check('after reading the diff, the commit is allowed (PowerShell tool)', commitPs('git commit -m x'), 'allow');
rm(diffMarker);

console.log('\ngates — the escape hatch');
rm(refsMarker); rm(diffMarker);
check('SKIP_CODE_GATES=1 allows the edit',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }), { SKIP_CODE_GATES: '1' })), 'allow');
check('SKIP_CODE_GATES=1 allows the commit', commit('git commit -m x', { SKIP_CODE_GATES: '1' }), 'allow');
// SKIP_CODE_GATES is the only escape hatch; only the exact value '1' opens it,
// so a truthy-looking typo does not silently disable the gate.
check("SKIP_CODE_GATES='true' does NOT bypass the gate",
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }), { SKIP_CODE_GATES: 'true' })), 'deny');

// =============================================================================
console.log('\nrefs-record.cjs — records that references were looked up');
rm(refsMarker);
const post = (tool, extra = {}) => ({
  hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, session_id: SID, cwd: REPO, ...extra,
});
run('gates/refs-record.cjs', post('mcp__serena__find_referencing_symbols'));
check('a Serena reference lookup writes the marker', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', post('Read'));
check('an unrelated tool writes nothing', fs.existsSync(refsMarker), false);

// A plugin-provided MCP server is namespaced: Claude Code renames its tools to
// mcp__plugin_<plugin-name>_<server-name>__<tool>, not mcp__<server-name>__<tool>.
// A colleague who installs Serena as a plugin therefore calls
// mcp__plugin_<their-plugin-name>_serena__find_referencing_symbols, never the bare
// form, and the marker must still be written — otherwise the edit gate is
// unsatisfiable under a plugin install.
rm(refsMarker);
run('gates/refs-record.cjs', post('mcp__plugin_workflow-discipline_serena__find_referencing_symbols'));
check('a plugin-namespaced reference lookup writes the marker', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', post('mcp__plugin_workflow-discipline_serena__find_implementations'));
check('a plugin-namespaced find_implementations writes the marker', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', post('mcp__plugin_workflow-discipline_serena__find_declaration'));
check('a plugin-namespaced find_declaration writes the marker', fs.existsSync(refsMarker), true);
rm(refsMarker);
// find_symbol locates a definition and says nothing about callers, so it must
// stay excluded from the gate in both naming forms.
run('gates/refs-record.cjs', post('mcp__serena__find_symbol'));
check('the bare form of find_symbol does NOT satisfy the gate', fs.existsSync(refsMarker), false);
rm(refsMarker);
run('gates/refs-record.cjs', post('mcp__plugin_workflow-discipline_serena__find_symbol'));
check('the plugin-namespaced form of find_symbol does NOT satisfy the gate', fs.existsSync(refsMarker), false);
rm(refsMarker);

// End to end: a plugin-namespaced lookup must also satisfy edit-gate.cjs, not
// just write a marker refs-record.cjs happens to check for itself.
run('gates/refs-record.cjs', post('mcp__plugin_workflow-discipline_serena__find_referencing_symbols'));
check('after a plugin-namespaced lookup, edit-gate then allows the edit',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }))), 'allow');
rm(refsMarker);

// A lookup on a file with no symbols does not return empty — it throws, so
// Claude Code fires PostToolUseFailure instead of PostToolUse and the marker
// was never written at all. Measured live against a real Serena: the `error`
// field on that event is a free-text string, e.g.
// "Error executing tool find_referencing_symbols: ValueError: No symbol
// matching 'X' found" for find_referencing_symbols/find_implementations, and
// "...ValueError: No match found for regex: X" for find_declaration — no
// separate error-code or error-type field exists to key on instead. "Nothing
// depends on this" is as real an answer as a populated result list, so these
// must satisfy the gate the same way a successful call does; a failure that
// looks like anything else (a bad call, Serena being down) must not.
const failPost = (tool, error, extra = {}) => ({
  hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input: {}, session_id: SID, cwd: REPO, error, ...extra,
});
const NOTHING_FOUND = "Error executing tool find_referencing_symbols: ValueError: No symbol matching 'X' found";
const NOTHING_FOUND_DECL = "Error executing tool find_declaration: ValueError: No match found for regex: X";
const CONNECTION_ERROR = 'MCP error -32000: Connection closed';

rm(refsMarker);
run('gates/refs-record.cjs', failPost('mcp__serena__find_referencing_symbols', NOTHING_FOUND));
check('a failed lookup that found nothing writes the marker (bare tool name)', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', failPost('mcp__plugin_workflow-discipline_serena__find_referencing_symbols', NOTHING_FOUND));
check('a failed lookup that found nothing writes the marker (plugin-namespaced)', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', failPost('mcp__serena__find_declaration', NOTHING_FOUND_DECL));
check('a failed find_declaration with no regex match writes the marker', fs.existsSync(refsMarker), true);
rm(refsMarker);
run('gates/refs-record.cjs', failPost('mcp__serena__find_referencing_symbols', CONNECTION_ERROR));
check('a failure that is NOT a "nothing found" answer does NOT write the marker', fs.existsSync(refsMarker), false);
rm(refsMarker);

run('gates/refs-record.cjs', failPost('mcp__plugin_workflow-discipline_serena__find_referencing_symbols', NOTHING_FOUND));
check('after a failed "nothing found" lookup, edit-gate then allows the edit',
  decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }))), 'allow');
const failMarkerBody = JSON.parse(fs.readFileSync(refsMarker, 'utf8'));
check('the marker on a failed-but-empty lookup records that outcome', failMarkerBody.outcome, 'empty');
rm(refsMarker);

run('gates/refs-record.cjs', post('mcp__serena__find_referencing_symbols'));
const okMarkerBody = JSON.parse(fs.readFileSync(refsMarker, 'utf8'));
check('the marker on a successful lookup records that outcome', okMarkerBody.outcome, 'ok');
rm(refsMarker);

console.log('\ndiff-record.cjs — records that the diff was actually read');
rm(diffMarker);
const ranDiff = (cmd) => {
  rm(diffMarker);
  run('gates/diff-record.cjs', post('Bash', { tool_input: { command: cmd } }));
  return fs.existsSync(diffMarker);
};
check('git diff records the marker', ranDiff('git diff'), true);
check('git diff --cached records the marker', ranDiff('git diff --cached'), true);
check('git diff --stat records the marker', ranDiff('git --no-pager diff --stat'), true);
// git status lists filenames and no content, so it is not evidence that anyone
// looked at what actually changed. That distinction is the whole gate.
check('git status alone does NOT record the marker', ranDiff('git status --short'), false);
check('git log does NOT record the marker', ranDiff('git log --oneline -3'), false);
check('"git diff" inside a quoted string does NOT record the marker',
  ranDiff('echo "run git diff first" >> notes.md'), false);

// =============================================================================
console.log('\ndiscipline-reminder.cjs — clears BOTH markers each user prompt');
mark(refsMarker); mark(diffMarker);
run('discipline-reminder.cjs', { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: REPO });
check('the reference marker is cleared', fs.existsSync(refsMarker), false);
check('the diff marker is cleared', fs.existsSync(diffMarker), false);

for (const d of [CONFIG, REPO, PLAIN]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
