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
const { spawnSync, execFileSync } = require('child_process');
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

// Every fixture repo below is built by running `git` (gitMain, gitMono, gitX,
// the concurrency fixtures' `git init`) with no `env` override, so each of
// those calls inherits THIS process's own environment -- and so does the
// hooks-under-test' own git subprocess (repoIdentity's execFileSync, run via
// an in-process `require` at the bottom of this file rather than through
// `run()`/testEnv at all). A GIT_DIR/GIT_WORK_TREE/etc left set by whatever
// shell launched this suite would then make every one of those `git`
// invocations locate and operate on THAT repository instead of the fixture
// directory it was actually pointed at -- measured by running this suite with
// GIT_DIR aimed at a scratch bystander repo, which came out of the run with
// three new `init` commits, two new worktree registrations and a rewritten
// `user.name`/`user.email` it never had. Deleting every GIT_* key from this
// process's OWN environment, before any fixture is built, is what makes every
// child spawned below safe: each one builds its env by spreading
// `process.env` (`gitMain`/`gitMono`/`gitX`'s `execFileSync`, `rs`'s
// `spawnSync`, testEnv itself), or by not overriding it at all
// (`repoIdentity`'s in-process `execFileSync`), so a variable removed once
// here is absent from every one of them without each call site having to
// remember to strip it individually. `GIT_*` (the whole family) is deleted
// rather than naming just GIT_DIR/GIT_WORK_TREE, because several of git's
// other environment variables (GIT_INDEX_FILE, GIT_COMMON_DIR,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE,
// GIT_PREFIX, ...) can retarget which repository or which part of it a
// command reads or writes just as effectively, and naming each one leaves the
// next such variable unscrubbed until someone notices.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_')) delete process.env[k];
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// Never touch the real ~/.claude/state: every run gets its own config dir.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'gateconf-'));
const STATE = path.join(CONFIG, 'state');

// CLAUDE_PROJECT_DIR is blanked because hooks run inside the parent session's
// environment: inherited, it would make every hook here resolve the session's
// repository to whatever the parent session started in, not to the test's
// `cwd`. A test that means to set it passes it in `env`. Every GIT_* key is
// stripped for the same reason: inherited from whatever process launched this
// suite, it would make every `git rev-parse` a gate runs (repoIdentity,
// mainCheckoutRoot) answer for THAT repository instead of the fixture
// directory it was actually asked about. This process's own environment
// already had every GIT_* key removed at the top of this file, before any
// fixture was built, so `{...process.env, ...}` here never reintroduces one --
// the explicit delete loop below only guards against `extra` itself supplying
// one, which no test does today. Unlike CLAUDE_PROJECT_DIR, these cannot just
// be set to '': git treats an EMPTY-STRING GIT_DIR as a literal (invalid) path
// -- "fatal: not a git repository: ''" -- so the keys must be deleted from the
// child's env entirely, which is what this loop does.
function testEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SKIP_CODE_GATES: '', CLAUDE_PROJECT_DIR: '', ...extra };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_')) delete env[k];
  }
  return env;
}
function run(script, input, env = {}) {
  const r = spawnSync('node', [path.join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: testEnv(env),
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

// A path as a shell command should spell it: forward slashes, which Git Bash
// and PowerShell both read as a path. An unquoted `C:\Users\...` is escapes to
// bash, so on Windows the raw path would test the tokenizer, not the gate.
const shp = (p) => p.split(path.sep).join('/');
fs.writeFileSync(path.join(PLAIN, 'a.py'), '# x\n');

// A gated repo with a real .git, plus a worktree of it. The worktree has no
// .serena of its own -- only the main checkout does -- so a gate that keys
// gated-ness on the working directory's own ancestry, rather than on the
// repo the worktree shares with its main checkout, would miss it entirely.
const GATED_MAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gategit-'));
const gitMain = (...args) => execFileSync('git', args, { cwd: GATED_MAIN, encoding: 'utf8' });
gitMain('init', '-q', '.');
gitMain('config', 'user.email', 't@t');
gitMain('config', 'user.name', 't');
// `.serena/` is excluded through this repository's OWN `.git/info/exclude`
// rather than depending on the operator's global excludes file: `git add .`
// below must never actually commit `.serena/project.yml`, or a worktree of
// this checkout starts life with that directory already present, and the
// WORKTREE_OWN fixture's own `mkdirSync('.serena')` below fails with EEXIST
// the moment HOME points somewhere with no global excludes for it.
fs.appendFileSync(path.join(GATED_MAIN, '.git', 'info', 'exclude'), '.serena/\n');
fs.mkdirSync(path.join(GATED_MAIN, '.serena'));
fs.writeFileSync(path.join(GATED_MAIN, '.serena', 'project.yml'), 'project_name: "gated-main"\n');
fs.writeFileSync(path.join(GATED_MAIN, 'f.txt'), 'x\n');
gitMain('add', '.');
gitMain('commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(GATED_MAIN, 'main.py'), '# x\n');
const WORKTREE = path.join(os.tmpdir(), `gatewt-${process.pid}-${Date.now()}`);
gitMain('worktree', 'add', '-q', '-b', 'gatewt-branch', WORKTREE);
fs.writeFileSync(path.join(WORKTREE, 'w.py'), '# x\n');

// A second worktree of the SAME main checkout, but one that HAS picked up its
// own .serena/project.yml -- exactly what a real Serena writes on first use
// (plan probe, 2026-09-26). findGatedRoot walks up from this worktree's own
// directory and finds that config right there, so it returns the WORKTREE,
// not GATED_MAIN -- the reason repoIdentity exists at all: both must still
// resolve to one identity.
const WORKTREE_OWN = path.join(os.tmpdir(), `gatewtown-${process.pid}-${Date.now()}`);
gitMain('worktree', 'add', '-q', '-b', 'gatewtown-branch', WORKTREE_OWN);
fs.mkdirSync(path.join(WORKTREE_OWN, '.serena'));
fs.writeFileSync(path.join(WORKTREE_OWN, '.serena', 'project.yml'), 'project_name: "gated-main-wt"\n');
fs.writeFileSync(path.join(WORKTREE_OWN, 'wo.py'), '# x\n');

// Two Serena projects inside ONE git repository (mono/svc, mono/web), each
// with its own .serena/project.yml -- the case repoIdentity's
// --show-toplevel suffix exists to keep apart: both share one
// --git-common-dir, but their paths below the shared top-level differ.
const MONO = fs.mkdtempSync(path.join(os.tmpdir(), 'gatemono-'));
const gitMono = (...args) => execFileSync('git', args, { cwd: MONO, encoding: 'utf8' });
gitMono('init', '-q', '.');
gitMono('config', 'user.email', 't@t');
gitMono('config', 'user.name', 't');
fs.mkdirSync(path.join(MONO, 'svc', '.serena'), { recursive: true });
fs.writeFileSync(path.join(MONO, 'svc', '.serena', 'project.yml'), 'project_name: "mono-svc"\n');
fs.writeFileSync(path.join(MONO, 'svc', 's.py'), '# x\n');
fs.mkdirSync(path.join(MONO, 'web', '.serena'), { recursive: true });
fs.writeFileSync(path.join(MONO, 'web', '.serena', 'project.yml'), 'project_name: "mono-web"\n');
fs.writeFileSync(path.join(MONO, 'web', 'w.py'), '# x\n');
fs.writeFileSync(path.join(MONO, 'root.txt'), 'x\n');
gitMono('add', '.');
gitMono('commit', '-q', '-m', 'init');

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
{
  // The denial must tell the agent how to look up a file outside the
  // session's repository (a /ship worktree, or another repository): pass its
  // absolute path as relative_path, which serena-relay routes to that
  // repository's own shared Serena. The imperative is asserted together with
  // what precedes it, not as a bare substring: "pass its absolute path" also
  // occurs inside "never pass its absolute path" and "do not pass its
  // absolute path", so a substring match on the verb phrase alone would pass
  // on the inverted instruction too. The condition is asserted with it for
  // the same reason: "inside the repository" or "Unless the file is outside"
  // would invert when the instruction applies.
  const res = run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(REPO, 'src/thing.py') }));
  check('the denial tells the agent to pass an absolute path for a file outside this repository',
    res.out?.hookSpecificOutput?.permissionDecisionReason?.includes(
      'If the file is outside the repository this session started in — a /ship worktree or another ' +
      'repository — pass its absolute path as relative_path'), true);
}
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
// An apostrophe inside double quotes pairs with the next single quote when
// single-quoted spans are blanked first; the gate also reads the command with
// double-quoted spans blanked first, so the write between them stays visible.
check('a redirect after an apostrophe in double quotes is still seen',
  bash(`echo "it's"; echo x > ${REPO}/src/thing.py; echo 'done'`), 'deny');
check('sed -i after an apostrophe in double quotes is still seen',
  bash(`echo "it's" && sed -i '' 's/a/b/' ${REPO}/src/thing.py`), 'deny');
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

  // The do-it-now case: /blueprint's "do it now" triage creates no run state at
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
// `-C` now decides which repo is checked (Decision 9), so the target must
// itself be gated for this to prove what it always proved: that `-C`'s value
// doesn't get mistaken for the subcommand and let the parse miss `commit`.
// `-C <REPO>` from REPO is a no-op directory-wise, and still gated.
check('git -C dir commit is still a commit', commit(`git -C ${REPO} commit -m x`), 'deny');
check('a commit in an ungated repo is allowed',
  decision(run('gates/commit-gate.cjs', pre('Bash', { command: 'git commit -m x' }, SID, PLAIN))), 'allow');
// A quoted -C literal is followed like an unquoted one: run from an ungated
// directory, `git -C "<REPO>" commit` still checks REPO's unread diff.
check('a quoted -C naming a gated repo is still checked',
  decision(run('gates/commit-gate.cjs', pre('Bash', { command: `git -C "${REPO}" commit -m x` }, SID, PLAIN))), 'deny');
// ...including when the path holds a backslash, as every Windows path does. In
// double quotes a `\` not followed by $ ` " \ or a newline is literal text in
// bash and PowerShell alike, so `"C:\repo"` names C:\repo. Refusing it dropped
// the gated repo from the candidates and let the commit through unchecked. On
// POSIX a directory name may itself hold a backslash, which reproduces it here.
if (process.platform !== 'win32') {
  const bsRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate\\bs-'));
  fs.mkdirSync(path.join(bsRepo, '.serena'));
  fs.writeFileSync(path.join(bsRepo, '.serena', 'project.yml'), 'project_name: "gatebs"\n');
  check('a quoted -C whose path holds a literal backslash is still checked',
    decision(run('gates/commit-gate.cjs', pre('Bash', { command: `git -C "${bsRepo}" commit -m x` }, SID, PLAIN))), 'deny');
  fs.rmSync(bsRepo, { recursive: true, force: true });
}
// The words inside a message or a document are not an invocation.
check('the words "git commit" inside a quoted string are allowed',
  commit(`echo "remember to git commit -m x" >> ${REPO}/notes.md`), 'allow');
check('git status is not a commit', commit('git status --short'), 'allow');
check('a commit after an apostrophe in double quotes is still a commit',
  commit(`echo "it's"; git commit -m x; echo 'ok'`), 'deny');

mark(diffMarker);
check('after reading the diff, the commit is allowed', commit('git commit -m x'), 'allow');

console.log('\ncommit-gate.cjs — resolves the repo a `cd` in the command actually reaches');
// PLAIN is the session directory: ungated on its own. The command cd's into a
// WORKTREE of a gated repo before running git, so a gate that only looks at
// the session's own cwd would see PLAIN, find nothing gated, and let a
// worktree of a gated repo commit unreviewed.
rm(diffMarker);
check('cd into a worktree of a gated repo, diff unread: denied',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `cd ${WORKTREE} && git commit -m x` }, SID, PLAIN))), 'deny');
mark(diffMarker);
check('cd into a worktree of a gated repo, diff read: allowed',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `cd ${WORKTREE} && git commit -m x` }, SID, PLAIN))), 'allow');
rm(diffMarker);
{
  // Compared through realpath, not string equality: macOS resolves the
  // tmpdir's /var prefix to /private/var inside git's own output, which is a
  // platform quirk, not a claim this test is making.
  const { findGatedRoot } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
  const root = findGatedRoot(WORKTREE);
  check("a worktree's gated-ness is decided from its main checkout's --git-common-dir",
    root && fs.realpathSync(root), fs.realpathSync(GATED_MAIN));
}

console.log("\ngate-lib.cjs — mainCheckoutRoot resolves --git-common-dir against where git actually ran, not the (possibly symlinked) path it was asked about");
// git prints --git-common-dir relative to the directory it ACTUALLY runs in,
// which for a symlinked cwd is the symlink's resolved target, not the symlink
// path itself. Resolving that relative output against the symlink path
// landed nowhere near the real repo, so a symlink into a subdirectory of a
// gated main checkout read as ungated.
const DEEPSUB = path.join(GATED_MAIN, 'deepsub');
fs.mkdirSync(DEEPSUB);
const SYMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesymhost-'));
const SYMLINK = path.join(SYMDIR, 'link');
fs.symlinkSync(DEEPSUB, SYMLINK, 'dir');
{
  const { findGatedRoot } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
  const root = findGatedRoot(SYMLINK);
  check('a symlink into a subdirectory of a gated main checkout is still resolved to it',
    root && fs.realpathSync(root), fs.realpathSync(GATED_MAIN));
}
rm(diffMarker);
check('cd <symlink into a gated repo> && git commit: denied',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `cd ${SYMLINK} && git commit -m x` }, SID, PLAIN))), 'deny');
rm(diffMarker);
check('git -C <symlink into a gated repo> commit: denied',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `git -C ${SYMLINK} commit -m x` }, SID, PLAIN))), 'deny');
try { fs.rmSync(SYMDIR, { recursive: true, force: true }); } catch {}

console.log('\ncommit-gate.cjs — gitRunDirs refuses a -C literal containing a backtick');
{
  // A backtick makes the command non-simple (RAW_RISKY_CHARS), so gitRunDirs
  // takes universalFallback, which adds a `-C` literal as a candidate only
  // when isCleanLit accepts it. isCleanLit refuses the backtick, so the only
  // candidate is the ungated session cwd and the commit is allowed. The
  // directory is real and gated, so an isCleanLit that accepted the backtick
  // would add it as a second candidate (isRealDir passes) and the commit
  // would be denied.
  const BACKTICK_HOST = fs.mkdtempSync(path.join(os.tmpdir(), 'gatebacktick-'));
  const BACKTICK_REPO = path.join(BACKTICK_HOST, '`Y');
  fs.mkdirSync(path.join(BACKTICK_REPO, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(BACKTICK_REPO, '.serena', 'project.yml'), 'project_name: "gitrundirs-backtick"\n');
  rm(diffMarker);
  check('git -C <a real, gated directory named with a backtick> commit, from an ungated session cwd: allowed',
    decision(run('gates/commit-gate.cjs',
      pre('Bash', { command: `git -C ${BACKTICK_REPO} commit -m x` }, SID, PLAIN))), 'allow');
  try { fs.rmSync(BACKTICK_HOST, { recursive: true, force: true }); } catch {}
}

console.log("\ngate-lib.cjs — mainCheckoutRoot pipes git's stderr away, the same way repoIdentity already does");
{
  // findGatedRoot falls back to mainCheckoutRoot once its own filesystem walk
  // finds nothing, and refs-record.cjs's hook process runs that walk on every
  // lookup with no matching .serena/project.yml anywhere above it. Outside any
  // git working tree, mainCheckoutRoot's own `git rev-parse` exits non-zero
  // with "fatal: not a git repository ...", and its stdio option discards
  // that message rather than letting execFileSync's default inherit it onto
  // this process's own stderr -- a lookup started in an ordinary non-git
  // directory stays silent on refs-record.cjs's own stderr.
  const NOGIT = fs.mkdtempSync(path.join(os.tmpdir(), 'gatenogit-'));
  const r = spawnSync('node', [path.join(HOOKS, 'gates', 'refs-record.cjs')], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
      tool_input: { name_path: 'f' }, session_id: 'test-gates-quiet-0001', cwd: NOGIT,
    }),
    encoding: 'utf-8',
    env: testEnv(),
  });
  check('a lookup outside any git repository prints nothing to refs-record.cjs\'s own stderr', r.stderr, '');
  try { fs.rmSync(NOGIT, { recursive: true, force: true }); } catch {}
}

console.log('\nrefs-record.cjs — repoIdentity realpaths a gated root reached through a symlink, so a lookup through the link and an edit through its target agree');
{
  // A directory whose OWN path is a symlink, not merely one that sits below
  // one: an absolute relative_path pointing straight at a file inside it
  // reaches repoIdentity with the symlinked form still attached (lookupIdentity
  // never realpaths an absolute path itself, and findGatedRoot's walk returns
  // whatever string it was handed once `.serena/project.yml` is found through
  // it). Without repoIdentity's own realpathOr, that unresolved form is what
  // gets recorded, while an edit through SYM_REAL resolves to SYM_REAL's own path --
  // the two identities then disagree and a later edit through the real path is
  // wrongly denied. Neither
  // directory needs to be a git repository: repoIdentity's no-git fallback
  // (`catch { return real; }`) returns `real` verbatim, so this pins the
  // realpath step on its own, with no git subprocess output to lean on.
  const SYM_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesymid-'));
  fs.mkdirSync(path.join(SYM_REAL, '.serena'));
  fs.writeFileSync(path.join(SYM_REAL, '.serena', 'project.yml'), 'project_name: "symid"\n');
  fs.writeFileSync(path.join(SYM_REAL, 'f.py'), '# x\n');
  const SYM_HOST = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesymidhost-'));
  const SYM_LINK = path.join(SYM_HOST, 'link');
  fs.symlinkSync(SYM_REAL, SYM_LINK, 'dir');

  const sid = 'test-gates-symid-lookup-0001';
  run('gates/refs-record.cjs', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
    tool_input: { name_path: 'f', relative_path: path.join(SYM_LINK, 'f.py') },
    session_id: sid, cwd: PLAIN,
  });
  check('a lookup through the symlinked path, then an edit through the real path, is allowed',
    decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(SYM_REAL, 'f.py') }, sid, SYM_REAL))),
    'allow');
  try { fs.rmSync(SYM_HOST, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SYM_REAL, { recursive: true, force: true }); } catch {}
}

console.log('\ngate-lib.cjs — BRIEF 12: gitRunDirs returns real paths so a symlink to a NESTED repo inside a gated tree is itself seen as gated');
// gitRunDirs verified each cd/-C candidate's existence via a physical
// (realpath) resolution but then pushed the TYPED path into its result, so
// findGatedRoot -- which walks up from whatever it is handed -- walked the
// symlink's own, ungated ancestry instead of the real directory tree that
// symlink stands in for. A nested git repo living INSIDE a gated checkout
// (e.g. vendored under vendor/) reached only through such a symlink was
// therefore invisible to the gate, for both `git -C S commit` and
// `cd S && git commit`.
{
  const NEST_HOST = fs.mkdtempSync(path.join(os.tmpdir(), 'gatenest-'));
  const NEST_X = path.join(GATED_MAIN, 'vendor', 'X');
  fs.mkdirSync(NEST_X, { recursive: true });
  const gitX = (...args) => execFileSync('git', args, { cwd: NEST_X, encoding: 'utf8' });
  gitX('init', '-q', '.');
  gitX('config', 'user.email', 't@t');
  gitX('config', 'user.name', 't');
  gitX('commit', '-q', '-m', 'init', '--allow-empty');
  const NEST_S = path.join(NEST_HOST, 'S');
  fs.symlinkSync(NEST_X, NEST_S, 'dir');

  rm(diffMarker);
  check('git -C S commit, S a symlink to a nested repo inside a gated tree: denied',
    decision(run('gates/commit-gate.cjs',
      pre('Bash', { command: `git -C ${NEST_S} commit -m x` }, SID, PLAIN))), 'deny');
  rm(diffMarker);
  check('cd S && git commit, the same nested-repo symlink: denied',
    decision(run('gates/commit-gate.cjs',
      pre('Bash', { command: `cd ${NEST_S} && git commit -m x` }, SID, PLAIN))), 'deny');
  mark(diffMarker);
  check('with the diff read, the same commit is allowed',
    decision(run('gates/commit-gate.cjs',
      pre('Bash', { command: `git -C ${NEST_S} commit -m x` }, SID, PLAIN))), 'allow');
  rm(diffMarker);

  try { fs.rmSync(NEST_HOST, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(GATED_MAIN, 'vendor'), { recursive: true, force: true }); } catch {}
}

console.log('\ncommit-gate.cjs — a `..` after a symlink hop is resolved physically, not cancelled textually');
// DOTF hosts a symlink DOTL pointing INTO the gated repo (GATED_MAIN/deepsub).
// Textually, "DOTL/.." looks like it lands back in DOTF (ungated) -- path.resolve
// only manipulates the string and cancels "L" against the trailing ".." without
// ever knowing L is a symlink. Physically (the way chdir, and git's own -C,
// actually behaves) it lands in GATED_MAIN, the symlink's REAL parent. The
// session directory in every case below IS GATED_MAIN, so before this fix the
// strict cd/-C grammar wrongly "recognised" each shape, trusted the textual
// (ungated) DOTF, and DROPPED the gated session directory from the candidate
// set entirely -- turning a deny into an allow, and landing the commit in the
// gated repo unreviewed.
const DOTF = fs.mkdtempSync(path.join(os.tmpdir(), 'gatedotf-'));
const DOTL = path.join(DOTF, 'L');
fs.symlinkSync(DEEPSUB, DOTL, 'dir');

rm(diffMarker);
check('git -C <symlink>/.. commit: the symlink hop is not cancelled by a textual ".."',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `git -C ${DOTL}/.. commit -m x` }, SID, GATED_MAIN))), 'deny');
rm(diffMarker);
check('cd <symlink> && git -C .. commit: same physical hop, reached via a cd chain instead of one -C literal',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `cd ${DOTL} && git -C .. commit -m x` }, SID, GATED_MAIN))), 'deny');
rm(diffMarker);
check('git -C <symlink> -C .. commit: two -C flags, same physical hop',
  decision(run('gates/commit-gate.cjs',
    pre('Bash', { command: `git -C ${DOTL} -C .. commit -m x` }, SID, GATED_MAIN))), 'deny');
try { fs.rmSync(DOTF, { recursive: true, force: true }); } catch {}

console.log('\ncommit-gate.cjs — a cd chain only drops the session dir when every cd is a certain, existing literal joined by && alone');
// A plain, existing, ungated directory a `cd` can land in without making the
// commit gated on its own -- these cases must deny purely because REPO (the
// session dir) stays a candidate, not because B itself is gated.
const BDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateb-'));

// Regression for the parser bug: a newline is a command separator too, and a
// bare `cd` (no target) must not swallow the separator after it. Before the
// fix, both made gitRunDirs return [] -- the `git` token was never even
// reached -- so a commit in this same gated repo sailed through unreviewed.
rm(diffMarker);
check('a `cd` folded across a newline still reaches the git token, in the still-gated repo',
  commit('cd src\ngit commit -m x'), 'deny');
rm(diffMarker);
check('a bare `cd` (no target) does not swallow the separator after it, hiding the git token',
  commit('cd; git commit -m x'), 'deny');

// zsh's two-argument `cd old new` form does not `cd` into a literal directory
// named "old new" -- it substitutes `old` for `new` in the CURRENT working
// directory's own path and cd's there, an entirely different target than
// either word alone names. A `cd` segment with more than one argument must
// therefore never be trusted as a plain `cd LIT`: it must fall back, keeping
// the (gated) session dir a candidate, rather than being read as "cd" to its
// first word only and silently dropping the session dir for a directory a
// real zsh would never have landed in.
rm(diffMarker);
check('a `cd` with two arguments (zsh\'s substitution form) is not trusted as `cd` to its first word',
  commit(`cd ${BDIR} && cd ${BDIR} ${REPO} && git commit -m x`), 'deny');

// A `cd` to a target that does not exist would fail in a real shell, so it
// must not be trusted to replace the session dir as the only candidate.
rm(diffMarker);
check('cd to a nonexistent directory, `;`-joined, still checks the session dir',
  commit('cd /no/such/dir/at/all; git commit -m x'), 'deny');
rm(diffMarker);
check('cd to a nonexistent directory, `||`-joined, still checks the session dir',
  commit('cd /no/such/dir/at/all || git commit -m x'), 'deny');
rm(diffMarker);
check('cd - (the previous-directory form, not a literal path) leaves the session dir a candidate',
  commit(`cd ${BDIR} && cd - && git commit -m x`), 'deny');

// Only `&&` guarantees the git commit ran because the cd before it
// succeeded; every other operator lets it run whether or not the cd did.
rm(diffMarker);
check('cd joined to the commit by a single `&` still checks the session dir',
  commit(`cd ${BDIR} & git commit -m x`), 'deny');
rm(diffMarker);
check('cd piped, then `;`-joined to the commit, still checks the session dir',
  commit(`cd ${BDIR} | true; git commit -m x`), 'deny');

// resolveCdArg must reject an unresolvable `$VAR` target whether or not it
// is quoted.
rm(diffMarker);
check('an unresolvable, UNQUOTED cd target still checks the session dir',
  commit('cd $UNSET_GATE_VAR && git commit -m x'), 'deny');

console.log('\ncommit-gate.cjs — an allowlist, not a blocklist: anything outside the exact grammar keeps the session dir a candidate');
// Round 2 of review rejected a blocklist version of this walk twice: each
// round patched the one shape the previous round's reviewer had found, and
// the next round found another. These are that round's five must-fix items,
// each as its own denied case — REPO (the session dir) is gated, so every
// one of these must deny purely because REPO stays a candidate, the same
// way HEAD (which never tried to resolve a `cd`/`-C` at all, and always
// checked the session dir) denied all of them.
const GS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gategs2-'));

// 1. `cd` must be the first WORD of its segment, not merely present in it.
rm(diffMarker);
check('`echo cd U` is not a `cd` — the word cd sits inside an echo, not at the head of a segment',
  commit(`echo cd ${BDIR} && git commit -m x`), 'deny');
rm(diffMarker);
check('`true cd U` is not a `cd` either, for the same reason',
  commit(`true cd ${BDIR} && git commit -m x`), 'deny');

// 2. A subshell does not change the parent shell's directory, whatever the
// naive token stream inside the parens looks like.
rm(diffMarker);
check('`( cd U )` runs in a subshell — it never changes the directory `git` runs in',
  commit(`( cd ${BDIR} ) && git commit -m x`), 'deny');

// 3. A quoted -C target must not be treated as a literal once the shared
// quote-blanking pass has erased its quotes and left `''`/`""` behind.
rm(diffMarker);
check('a quoted -C target naming an unset variable is not a literal',
  commit(`cd ${BDIR} && git -C "$OLDPWD" commit -m x`), 'deny');
rm(diffMarker);
check('a quoted -C target that LOOKS like a real path is still quoted, not trusted',
  commit(`cd ${BDIR} && git -C "${GS2}" commit -m x`), 'deny');
rm(diffMarker);
check('git -C ~ needs $HOME to expand — not a literal this parser can trust',
  commit('git -C ~ commit -m x'), 'deny');

// 5. Any means of reaching `git` other than a plain `cd LIT &&` chain or a
// plain `-C LIT` — a directory-stack push, an env-var launcher, a global
// flag this grammar does not allow between `git` and its subcommand, or an
// eval'd `cd` that only LOOKS like a real one once quoting is stripped away.
rm(diffMarker);
check('pushd changes the directory stack, not something this grammar follows',
  commit(`cd ${BDIR} && pushd ${GS2} && git commit -m x`), 'deny');
rm(diffMarker);
check('env -C runs git in another directory without a `cd` or `-C` token this grammar recognises',
  commit(`cd ${BDIR} && env -C ${GS2} git commit -m x`), 'deny');
rm(diffMarker);
check('--git-dir between git and the subcommand is not the `[-C LIT]...` this grammar allows',
  commit(`cd ${BDIR} && git --git-dir=${GS2}/.git commit -m x`), 'deny');
rm(diffMarker);
check('a GIT_DIR= env-assignment prefix means git is not the first word of its segment',
  commit(`cd ${BDIR} && GIT_DIR=${GS2}/.git git commit -m x`), 'deny');
rm(diffMarker);
check("eval'ing a `cd` is not a `cd` this grammar can trust, even joined by && to a plain git commit",
  commit(`eval "cd ${BDIR}" && git commit -m x`), 'deny');

// Reviewer must-fix: gitDirTokens/gitRunDirs must never return a candidate
// set that drops the session dir just because a `#` comment, `$'...'`
// ANSI-C quoting, or an unstripped heredoc body happens to contain an
// unmatched quote character — that desyncs the quote-aware tokenizer's
// state for the rest of the command, and a `git` invocation reached after
// the corruption can go missing from the candidate set entirely. REPO (the
// session dir) is gated, and nothing else in these commands is, so a deny
// here can only come from the session dir staying a candidate.
console.log('\ncommit-gate.cjs — an unmatched quote inside a comment/heredoc/ANSI-C string does not drop the session dir');
rm(diffMarker);
check("a `#` comment containing an apostrophe does not swallow the git token after it",
  commit("# don't forget\ngit commit -m x"), 'deny');
rm(diffMarker);
check("a trailing `#` comment containing an apostrophe does not swallow the git token after it",
  commit("echo hi # it's done\ngit commit -m x"), 'deny');
rm(diffMarker);
check("ANSI-C $'...' quoting with an escaped quote does not swallow the git token after it",
  commit("echo $'it\\'s' && git commit -m x"), 'deny');
rm(diffMarker);
check('a heredoc body containing an apostrophe does not swallow the git token after it',
  commit('cat > m <<END-MSG\ndon\'t\nEND-MSG\ngit commit -F m'), 'deny');
rm(diffMarker);
check('a second `git commit` reached after a comment-corrupted first command still checks the dir it runs in',
  commit(`cd ${BDIR} && git commit -m x # it's\ncd ${REPO} && git commit`), 'deny');

// MUST NOT regress: a real, unbroken `cd LIT &&` chain to an existing
// directory still drops the session dir, so an ungated target still allows.
mark(diffMarker);
check('a genuine `cd LIT && git commit` chain to an ungated dir is still allowed',
  commit(`cd ${GS2} && git commit -m x`), 'allow');

// Brief 2 follow-up: isSimpleCommand used to reject ANY `'` or `"` at all, so
// an ordinary `cd U && git commit -m "msg"` never took the trusted-chain fast
// path above -- it fell straight to universalFallback, which always keeps
// the (gated) session dir a candidate, so a commit that in fact only ever
// touched the ungated dir still demanded a diff read. A quoted span that
// provably cannot execute or expand anything (a `'...'` of any content, or a
// `"..."` whose content has none of `$`, backtick, `\`) must not force that
// fallback -- these deny purely because diff-reviewed is unmarked below.
console.log('\ncommit-gate.cjs — a quoted commit message does not block the strict cd/-C grammar');
rm(diffMarker);
check('cd U && git commit -m "quoted message" reaches only the ungated dir: no diff needed',
  commit(`cd ${shp(GS2)} && git commit -m "fix: quoted message"`), 'allow');
rm(diffMarker);
check("git -C U commit -m 'quoted message' reaches only the ungated dir: no diff needed",
  commit(`git -C ${shp(GS2)} commit -m 'x y'`), 'allow');
rm(diffMarker);
check('two git words -- one quoted-inert, one real -- still checks the session dir',
  commit(`cd ${GS2} && git commit -m "a" ; cd ${GS2} && git commit`), 'deny');
rm(diffMarker);
check('a `$(...)` inside the quoted message is not provably inert: session dir stays a candidate',
  commit(`cd ${GS2} && git commit -m "it's $(x)"`), 'deny');

console.log('\ncommit-gate.cjs — a quoted "git" is still git to the shell: it must not hide a second invocation from the fast path');
// Quoting a word does not stop the shell from running it as a command --
// `'git' commit -m y` runs exactly like `git commit -m y`. isSimpleCommand
// used to count "git" words in the command AFTER stripSafeQuotes had already
// replaced each provably-inert quoted span with a single placeholder, so
// `'git'`, `"git"` and `g''it` (an empty-quote split that is still literally
// "git" once the shell joins it) all vanished from that count. A real,
// structurally eligible `git -C U commit` earlier in the command made the
// whole thing look "simple" under that undercount, and the second, hidden
// commit's actual directory (nothing cd's for it, so it runs in the session
// dir) was silently missing from the candidate set. Fixed structurally
// instead of by counting: the session dir may be dropped for a given `git`
// only when that `git`'s segment is the LAST segment of the whole command --
// nothing may follow it, spelled any way at all, quoted or not.
rm(diffMarker);
check("a quoted 'git' after a real git invocation still checks the session dir",
  commit(`git -C ${GS2} commit -m x; 'git' commit -m y`), 'deny');
rm(diffMarker);
check('a quoted "git" after a real git invocation still checks the session dir',
  commit(`git -C ${GS2} commit -m x; "git" commit -m y`), 'deny');
rm(diffMarker);
check("g''it (empty-quote split, still literally \"git\" to the shell) after a real git invocation still checks the session dir",
  commit(`git -C ${GS2} commit -m x; g''it commit -m y`), 'deny');
rm(diffMarker);
check("sh -c 'git commit' after a real git invocation still checks the session dir",
  commit(`git -C ${GS2} commit -m x; sh -c 'git commit -m y'`), 'deny');
rm(diffMarker);
check('bash -c "git commit" after a real git invocation still checks the session dir',
  commit(`git -C ${GS2} commit -m x && bash -c "git commit -am y"`), 'deny');

// A real newline, not a `;`, separating the two statements. gitDirTokens folds
// a newline into the same `;` separator token every other SEPARATOR-testing
// consumer expects -- without that fold this whole thing tokenizes as ONE
// unbroken segment, the first (recognised) `git -C GS2 commit` then LOOKS
// like the entire command's only, and therefore LAST, segment, and the
// strict grammar trusts it and drops the (gated) session dir entirely,
// missing the second, real `git commit` the `sh -c` hides on the next line.
rm(diffMarker);
check("a newline (not a `;`) between a trusted -C commit and a hidden sh -c 'git commit' still checks the session dir",
  commit(`git -C ${GS2} commit -m x\nsh -c 'git commit -m y'`), 'deny');

console.log('\ncommit-gate.cjs — a bracket in a cd/-C literal is a glob metacharacter, not a safe literal');
// isCleanLit decides whether a token is safe to trust as a literal path AT
// ALL, before ever checking whether it resolves to a real directory. `[` and
// `{` open a glob character class / brace expansion, the same way `*`/`?`
// already do -- `cd n[o]pe` may not land where the token's own text says it
// does, so trusting it (even when a directory of that exact bracketed name
// happens to exist) is exactly the mistake `~`/`*`/`?` are already refused
// for.
const BRACKETDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gatebrk-'));
const BRACKETSUB = path.join(BRACKETDIR, 'n[o]pe');
fs.mkdirSync(BRACKETSUB);
rm(diffMarker);
check('cd n[o]pe (relative, glob-shaped) still checks the session dir',
  commit('cd n[o]pe && git commit -m x'), 'deny');
rm(diffMarker);
check('cd <absolute path ending in a bracketed segment that DOES exist> still checks the session dir',
  commit(`cd ${BRACKETSUB} && git commit -m x`), 'deny');
try { fs.rmSync(BRACKETDIR, { recursive: true, force: true }); } catch {}

try { fs.rmSync(GS2, { recursive: true, force: true }); } catch {}
try { fs.rmSync(BDIR, { recursive: true, force: true }); } catch {}

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

// =============================================================================
console.log('\nrefs-record.cjs + edit-gate.cjs — a lookup opens only the repository it was made in');
// The granularity is the repository, not the file: a lookup on one function
// followed by edits to its callers elsewhere in the same repository is the
// intended workflow. A lookup in a different repository must not open this
// one. Every repository here has its own .serena/project.yml, or none of them
// is gated and every edit is allowed whatever the marker says. `repoa-wt` is
// named the way /ship names its worktrees (`../<repo>-<name>`), so a
// string-prefix comparison would wrongly count it as inside A -- but it is a
// PLAIN directory, not a git worktree, standing in for the separate-sibling-
// repository case; the git-worktree-of-A case (identity, not gated root)
// is exercised below with GATED_MAIN/WORKTREE/WORKTREE_OWN instead.
{
  const PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'gatemulti-'));
  const mkRepo = (name, files) => {
    const dir = path.join(PARENT, name);
    fs.mkdirSync(path.join(dir, '.serena'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serena', 'project.yml'), `project_name: "${name}"\n`);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '# x\n');
    }
    return dir;
  };
  const A = mkRepo('repoa', ['src/a.py', 'src/other.py', 'sub/s.py']);
  const WT = mkRepo('repoa-wt', ['src/w.py']);
  const B = mkRepo('repob', ['src/b.py']);
  // A nested repository marker below A's gated root: repoKey would stop at
  // sub/, findGatedRoot does not. Both sides must agree on A.
  fs.mkdirSync(path.join(A, 'sub', '.git'));
  // A directory literally named `$X`, gated on its own, so a
  // `$`-bearing `cd` argument that WOULD name a real (and real-GATED)
  // directory if expanded literally has somewhere to go wrong. Without
  // a real directory of that exact name, dropping isCleanLit's `$` refusal
  // changes nothing -- isRealDir still filters the literal string "$X" out --
  // so the check could never go red for the mutant it guards against.
  const DOLLAR_DIR = path.join(A, '$X');
  fs.mkdirSync(path.join(DOLLAR_DIR, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(DOLLAR_DIR, '.serena', 'project.yml'), 'project_name: "dollarx"\n');
  fs.writeFileSync(path.join(DOLLAR_DIR, 'y.py'), '# x\n');
  // Same pin, for a DOUBLE-QUOTED `cd` argument this time: quotedLitValue
  // refuses a quoted literal containing `$`/backtick/`\` before isCleanLit is
  // ever consulted, so these two need their own real, gated, unopened
  // directories -- DOLLAR_DIR above is reached only through the unquoted
  // path (isCleanLit's own `$` refusal), and could not tell a removed quoted
  // refusal from a working one.
  const BACKTICK_DIR = path.join(A, '`Y');
  fs.mkdirSync(path.join(BACKTICK_DIR, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(BACKTICK_DIR, '.serena', 'project.yml'), 'project_name: "backticky"\n');
  fs.writeFileSync(path.join(BACKTICK_DIR, 'y.py'), '# x\n');
  // Windows reserves `"` in a file name and reads `\` as a separator, so the
  // two fixtures below exist only on POSIX; their checks are skipped on win32.
  // The Windows form of the backslash case is every quoted `C:\...` temp path
  // the checks above already use.
  const POSIX_NAMES = process.platform !== 'win32';
  const BACKSLASH_DIR = path.join(A, '\\Z');
  if (POSIX_NAMES) {
    fs.mkdirSync(path.join(BACKSLASH_DIR, '.serena'), { recursive: true });
    fs.writeFileSync(path.join(BACKSLASH_DIR, '.serena', 'project.yml'), 'project_name: "backslashz"\n');
    fs.writeFileSync(path.join(BACKSLASH_DIR, 'y.py'), '# x\n');
  }
  // A directory literally named `a'b'c`/`a"b"c`: what quotedLitValue's inner
  // text would be, unquoted, for the raw token `'a'b'c'`/`"a"b"c"` -- three
  // quoted fragments the shell concatenates into `abc`, not one literal span
  // containing a quote character. Matching only the outer quote characters
  // (raw[0] and raw[-1]) cannot tell that apart from a genuine single span,
  // so without the inner-quote refusal these directories would wrongly
  // become candidates. Without a real, gated directory of exactly that name,
  // dropping the refusal would change nothing -- isRealDir would filter the
  // (wrong) literal string out regardless.
  const EMBEDQUOTE_SINGLE_DIR = path.join(A, "a'b'c");
  fs.mkdirSync(path.join(EMBEDQUOTE_SINGLE_DIR, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(EMBEDQUOTE_SINGLE_DIR, '.serena', 'project.yml'), 'project_name: "embedquotesingle"\n');
  fs.writeFileSync(path.join(EMBEDQUOTE_SINGLE_DIR, 'y.py'), '# x\n');
  const EMBEDQUOTE_DOUBLE_DIR = path.join(A, 'a"b"c');
  if (POSIX_NAMES) {
    fs.mkdirSync(path.join(EMBEDQUOTE_DOUBLE_DIR, '.serena'), { recursive: true });
    fs.writeFileSync(path.join(EMBEDQUOTE_DOUBLE_DIR, '.serena', 'project.yml'), 'project_name: "embedquotedouble"\n');
    fs.writeFileSync(path.join(EMBEDQUOTE_DOUBLE_DIR, 'y.py'), '# x\n');
  }
  // A directory literally named `it's`: a DOUBLE-quoted `cd` argument whose
  // inner text holds a single quote is still one whole span -- quotedLitValue
  // only refuses an inner quote matching its OWN delimiter (`"`), never the
  // other kind, since POSIX double quotes give `'` no special meaning at all.
  // With no directory of this name, isRealDir drops the unquoted path, so a
  // quotedLitValue that refused every quote character would give the same
  // result and the check below could not catch it.
  const APOSTROPHE_DIR = path.join(A, "it's");
  fs.mkdirSync(path.join(APOSTROPHE_DIR, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(APOSTROPHE_DIR, '.serena', 'project.yml'), 'project_name: "apostrophe"\n');
  fs.writeFileSync(path.join(APOSTROPHE_DIR, 'y.py'), '# x\n');
  const real = (p) => fs.realpathSync(p);

  let n = 0;
  const freshSid = () => `test-gates-multi-${++n}`;
  const lookup = (sid, relative_path, { cwd = A, env = {} } = {}) => run('gates/refs-record.cjs', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
    tool_input: relative_path === undefined ? { name_path: 'f' } : { name_path: 'f', relative_path },
    session_id: sid, cwd,
  }, env);
  const editRes = (sid, file, { cwd = A, env = {} } = {}) =>
    run('gates/edit-gate.cjs', pre('Edit', { file_path: file }, sid, cwd), env);
  const edit = (sid, file, opts) => decision(editRes(sid, file, opts));
  // The identities recorded this turn, read back out of the per-session
  // identity directory for the test's own assertions. Production code
  // (identityRecorded) never does this -- it only tests one hashed filename
  // for existence -- but the file's content is the identity string in full,
  // written purely so a human (or a test) can read it back; sorted because
  // the filesystem does not promise readdir order.
  const roots = (sid) => {
    const dir = path.join(STATE, 'refs-checked', sid);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return undefined; }
    if (!entries.length) return undefined;
    return entries
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).identity; } catch { return null; } })
      .filter((x) => typeof x === 'string')
      .sort();
  };

  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    const res = editRes(sid, path.join(B, 'src/b.py'));
    check('a lookup in A, then an edit in B: denied', decision(res), 'deny');
    const why = res.out?.hookSpecificOutput?.permissionDecisionReason || '';
    check('the denial names B', why.includes(path.basename(B)), true);
    check("the denial tells the agent to pass the file's absolute path",
      why.includes('pass its absolute path as relative_path'), true);
  }
  {
    const sid = freshSid();
    lookup(sid, path.join(B, 'src/b.py'));
    check('a lookup with an absolute path in B records B', roots(sid), [real(B)]);
    check('a lookup with an absolute path in B, then an edit in B: allowed',
      edit(sid, path.join(B, 'src/b.py')), 'allow');
  }
  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a lookup in A records A', roots(sid), [real(A)]);
    check('a lookup in A, then an edit in another file of A: allowed',
      edit(sid, path.join(A, 'src/other.py')), 'allow');
  }
  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    lookup(sid, path.join(B, 'src/b.py'));
    check('lookups in A and B in the same turn record both', roots(sid), [real(A), real(B)]);
    check('lookups in A and B in the same turn: an edit in A is allowed', edit(sid, path.join(A, 'src/a.py')), 'allow');
    check('lookups in A and B in the same turn: an edit in B is allowed', edit(sid, path.join(B, 'src/b.py')), 'allow');
  }
  {
    const sid = freshSid();
    lookup(sid, `../${path.basename(WT)}/src/w.py`);
    check("a relative path escaping the session's root records the sibling repository", roots(sid), [real(WT)]);
    check("a relative path escaping the session's root: an edit in the sibling repository is allowed",
      edit(sid, path.join(WT, 'src/w.py')), 'allow');
    check("a relative path escaping the session's root: an edit in the session's repository is still denied",
      edit(sid, path.join(A, 'src/a.py')), 'deny');
  }
  {
    // A marker written before roots were recorded carries none: it vouches
    // for the session's own repository and nothing else.
    const sid = freshSid();
    mark(path.join(STATE, 'refs-checked', `${sid}.json`));
    check("an old-format marker opens the session's repository", edit(sid, path.join(A, 'src/a.py')), 'allow');
    check('an old-format marker does not open another repository', edit(sid, path.join(B, 'src/b.py')), 'deny');
  }
  {
    const sid = freshSid();
    lookup(sid, 'sub/s.py');
    check('a lookup below a nested .git records the gated root above it', roots(sid), [real(A)]);
    check('a lookup below a nested .git opens the rest of the gated repository',
      edit(sid, path.join(A, 'src/a.py')), 'allow');
  }
  {
    // A lookup with no relative_path is about the session's own repository.
    const sid = freshSid();
    lookup(sid, undefined);
    check("a lookup with no relative_path records the session's repository", roots(sid), [real(A)]);
    check('a lookup with no relative_path does not open another repository',
      edit(sid, path.join(B, 'src/b.py')), 'deny');
  }
  {
    // The session's root is CLAUDE_PROJECT_DIR when set, not the hook's cwd.
    const sid = freshSid();
    lookup(sid, 'src/b.py', { env: { CLAUDE_PROJECT_DIR: B } });
    check('a relative path resolves against CLAUDE_PROJECT_DIR, not cwd', roots(sid), [real(B)]);
  }
  {
    // One Bash command writing into A and B needs a lookup in both.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a Bash write into A and B after a lookup only in A: denied',
      decision(run('gates/edit-gate.cjs', pre('Bash', {
        command: `echo x > ${path.join(A, 'src/a.py')}; echo x > ${path.join(B, 'src/b.py')}`,
      }, sid, A))), 'deny');
  }
  {
    // With neither repository looked up, both targets are unopened, in the
    // order bashWriteTargets found them in the command: A's first. The
    // denial names the repository of unopened[0], so it names A and not B.
    const sid = freshSid();
    const res = run('gates/edit-gate.cjs', pre('Bash', {
      command: `echo x > ${path.join(A, 'src/a.py')}; echo x > ${path.join(B, 'src/b.py')}`,
    }, sid, A));
    check('a Bash write into two unopened repositories, with no lookup at all: denied', decision(res), 'deny');
    const why = res.out?.hookSpecificOutput?.permissionDecisionReason || '';
    check('the denial names the first unopened repository (A), not B',
      why.includes(path.basename(A)) && !why.includes(path.basename(B)), true);
  }

  // bashWriteTargets resolves a relative write target against every `cd`/
  // `-C` literal the command names, not only the session's cwd (Decisions:
  // "`cd` widens the candidate set; it never narrows it"): a command that
  // `cd`s into a different repository before writing a relative path is
  // judged against that repository too, so `cd B && sed -i ... b.py` from A
  // denies unless B has been looked up as well.
  const bash = (command, sid, cwd) =>
    decision(run('gates/edit-gate.cjs', pre('Bash', { command }, sid, cwd)));
  const bashRes = (command, sid, cwd) =>
    run('gates/edit-gate.cjs', pre('Bash', { command }, sid, cwd));

  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('lookup only in A, then `cd B && sed -i` on b.py: denied',
      bash(`cd ${B} && sed -i 's/x/y/' b.py`, sid, A), 'deny');
  }
  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    const res = bashRes(`cd ${B} && sed -i 's/x/y/' b.py`, sid, A);
    const why = res.out?.hookSpecificOutput?.permissionDecisionReason || '';
    check('that denial names B', why.includes(path.basename(B)), true);
  }
  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('lookup only in A, then `cd B && echo x > b.py`: denied',
      bash(`cd ${B} && echo x > b.py`, sid, A), 'deny');
  }
  {
    // The accepted cost (Decisions): the session's cwd is never DROPPED as a
    // candidate just because a `cd` is present, so a gated, unopened session
    // cwd still denies even though the `cd` target was the one actually
    // looked up.
    const sid = freshSid();
    lookup(sid, path.join(B, 'src/b.py'));
    check('lookup in B, then `cd B && sed -i` on b.py, session cwd B: allowed',
      bash(`cd ${B} && sed -i 's/x/y/' b.py`, sid, B), 'allow');
    const sid2 = freshSid();
    lookup(sid2, path.join(B, 'src/b.py'));
    check('lookup in B, then `cd B && sed -i` on b.py, session cwd A (gated, unopened): denied',
      bash(`cd ${B} && sed -i 's/x/y/' b.py`, sid2, A), 'deny');
  }
  {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('lookup in A, then `cd A/src && sed -i` on a.py: allowed',
      bash(`cd ${path.join(A, 'src')} && sed -i 's/x/y/' a.py`, sid, A), 'allow');
  }
  {
    // A `$`-bearing `cd` argument adds no candidate: isCleanLit refuses it
    // regardless of what bashWriteTargets otherwise trusts ("$X" stays
    // excluded even though a real, gated directory of that exact name
    // exists at DOLLAR_DIR; pinned below).
    const sid2 = freshSid();
    lookup(sid2, 'src/a.py');
    check('a `$`-bearing `cd` argument adds no candidate',
      bash(`cd $UNSET_GATE_CD_VAR && sed -i 's/x/y/' a.py`, sid2, A), 'allow');
  }
  {
    // Unlike $UNSET_GATE_CD_VAR above, "$X" WOULD name a real, gated
    // directory if the shell expanded it literally (DOLLAR_DIR, created
    // above). Removing isCleanLit's `$` refusal from the candidate path is
    // the only way this check can go red: isRealDir alone cannot save it
    // once a real "$X" exists.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a `$`-bearing `cd` argument naming a REAL gated directory still adds no candidate',
      bash(`cd $X && sed -i 's/x/y/' y.py`, sid, A), 'allow');
  }
  {
    // gitDirTokens' quote- and heredoc-awareness means a `cd` that only
    // APPEARS inside quoted text or a heredoc body is never tokenised as a
    // real `cd` at the head of a segment.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a `cd` inside a quoted string adds no candidate',
      bash(`echo "cd ${B} && x" > /dev/null; sed -i 's/x/y/' a.py`, sid, A), 'allow');
    const sid2 = freshSid();
    lookup(sid2, 'src/a.py');
    check('a `cd` inside a heredoc body adds no candidate',
      bash(`cat <<EOF\ncd ${B}\nEOF\nsed -i 's/x/y/' a.py`, sid2, A), 'allow');
  }
  {
    // Here `cd` is not the quoted span's first word -- `;` sits before it --
    // so a quote-BLIND tokenizer (one that treats an operator character as a
    // real separator wherever it sits in the raw text, quoted or not) would
    // split this into its own segment starting with a clean `cd B`, adding B
    // as a candidate and flipping the decision to deny. The quoted-string
    // check above (`echo "cd B && x"`) cannot catch that: there, `cd` sits
    // immediately after the OPENING quote, so even a quote-blind split leaves
    // a stray quote character glued to the word `cd` itself, and `"cd" !==
    // 'cd'` fails regardless of which tokenizer ran. Trailing " y" here keeps
    // the CLOSING quote off B's own token too, for the same reason.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a `cd` preceded by other quoted text before a `;` adds no candidate',
      bash(`echo "x; cd ${B} y" && sed -i 's/x/y/' a.py`, sid, A), 'allow');
  }
  {
    // B is a real, clean `cd` literal, so it DOES become a candidate base --
    // but the write target's own directory (sub/) exists under A (created
    // above) and not under B, so the parent-must-exist filter in
    // bashWriteTargets' own `push` drops B's resolution before it is ever
    // compared against the identity roots. Dropping that filter would add a
    // fictitious B/sub/x.py candidate whose gated root (B itself) is
    // unopened, flipping this to deny.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check("cd B, then sed -i on sub/x.py (B has no sub/, A does): allowed",
      bash(`cd ${B} && sed -i 's/x/y/' sub/x.py`, sid, A), 'allow');
  }

  // A `cd` argument that is a QUOTED literal ('...' or "..." containing none
  // of `$`, a backtick or `\`) is a candidate base too, and so is one led by
  // `cd --`, `cd -P` or `cd -L`. Each case below: the session looked up and
  // opened only A, then the command `cd`s into B (one of the five spellings)
  // before writing a relative target -- denied, because B is a candidate
  // base and it is gated and unopened
  // (Decisions: "`cd` widens the candidate set; it never narrows it" -- an
  // extra candidate can only add denials, never allow more).
  for (const [label, cd] of [
    ['double-quoted', `cd "${B}"`],
    ['single-quoted', `cd '${B}'`],
    ['-- flag', `cd -- ${B}`],
    ['-P flag', `cd -P ${B}`],
    ['-L flag', `cd -L ${B}`],
  ]) {
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check(`lookup only in A, then \`${cd}\` && sed -i on b.py (${label}): denied`,
      bash(`${cd} && sed -i 's/x/y/' b.py`, sid, A), 'deny');
  }
  {
    // Opening B is enough to let the same quoted `cd` through.
    const sid = freshSid();
    lookup(sid, path.join(B, 'src/b.py'));
    check('lookup in B, then `cd "B"` (double-quoted) && sed -i on b.py: allowed',
      bash(`cd "${B}" && sed -i 's/x/y/' b.py`, sid, B), 'allow');
  }
  {
    // A double-quoted literal that contains `$` or a backtick is refused by
    // quotedLitValue itself, so it adds no candidate, the same as the unquoted
    // `$X` that isCleanLit refuses. A `\` before an ordinary character is
    // different: inside double quotes it is literal text, so `cd "\Z"` really
    // does enter the directory named `\Z`, and that directory IS a candidate
    // (the same rule that makes `"C:\repo"` name C:\repo). Each case points at
    // a real, gated, unopened directory (DOLLAR_DIR/BACKTICK_DIR/BACKSLASH_DIR,
    // created above) whose name is exactly the quoted argument's inner text
    // once unquoted -- without a real directory of that exact name, the
    // outcome would not depend on quotedLitValue at all, since isRealDir would
    // filter the literal string out regardless.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a double-quoted `cd` argument containing `$` still adds no candidate',
      bash(`cd "$X" && sed -i 's/x/y/' y.py`, sid, A), 'allow');
    const sid2 = freshSid();
    lookup(sid2, 'src/a.py');
    check('a double-quoted `cd` argument containing a backtick still adds no candidate',
      bash(`cd "\`Y" && sed -i 's/x/y/' y.py`, sid2, A), 'allow');
    if (POSIX_NAMES) {
      const sid3 = freshSid();
      lookup(sid3, 'src/a.py');
      check('a double-quoted `cd` argument with a literal `\\` names that directory, so it is a candidate',
        bash(`cd "\\Z" && sed -i 's/x/y/' y.py`, sid3, A), 'deny');
    }
  }
  {
    // A raw token whose first and last characters are the SAME quote
    // character is not necessarily one whole quoted span: `'a'b'c'` is three
    // quoted fragments the shell runs together into `abc`, and `"a"b"c"` the
    // same for `a"b"c` -- neither means the directory literally named
    // `a'b'c`/`a"b"c` (created above). quotedLitValue must refuse both
    // rather than trust the inner text between the outer quotes.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check("a `cd` argument shaped like one single-quoted span but holding an embedded quote adds no candidate",
      bash(`cd 'a'b'c' && sed -i 's/x/y/' y.py`, sid, A), 'allow');
    if (POSIX_NAMES) {
      const sid2 = freshSid();
      lookup(sid2, 'src/a.py');
      check('a `cd` argument shaped like one double-quoted span but holding an embedded quote adds no candidate',
        bash(`cd "a"b"c" && sed -i 's/x/y/' y.py`, sid2, A), 'allow');
    }
  }
  {
    // `"it's"` is one whole double-quoted span: its delimiter `"` never recurs
    // inside it, so quotedLitValue trusts it, unlike `'a'b'c'`/`"a"b"c"`
    // above. The directory it names is real, gated and unopened, so it becomes
    // a candidate base and the write is denied. The write is a redirect, not
    // `sed -i 's/x/y/'`: executableShell's quote blanking pairs the lone `'`
    // in `it's` with the sed script's opening quote, which blanks the `sed`
    // word itself, and bashWriteTargets then finds no write target at all.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('a double-quoted `cd` argument holding a single quote is one span and a candidate base',
      bash(`cd "${APOSTROPHE_DIR}" && echo x > y.py`, sid, A), 'deny');
  }
  {
    // A quoted `-C` argument is a candidate base too, the same as a quoted
    // `cd` argument: both go through universalFallback's single `add`
    // closure, so this proves `add` is reached from the `-C` loop as well as
    // from `cd`, not only from `cd`'s own branch.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('lookup only in A, then `env -C "B" sed -i` on b.py (quoted -C): denied',
      bash(`env -C "${B}" sed -i 's/x/y/' b.py`, sid, A), 'deny');
  }
  {
    // A command with no `cd` and no `-C` resolves a relative target against
    // the session's own directory only. universalFallback always seeds its
    // output with a realpath'd copy of `start`, so the candidates are the
    // cwd as given and its realpath: the same path unless the cwd is a
    // symlink, and a second candidate can only add denials.
    const sid = freshSid();
    lookup(sid, 'src/a.py');
    check('no cd/-C: a relative target resolves only within the session cwd (typed and realpath\'d)',
      bash(`sed -i 's/x/y/' a.py`, sid, A), 'allow');
  }

  try { fs.rmSync(PARENT, { recursive: true, force: true }); } catch {}
}

// =============================================================================
console.log('\nrefs-record.cjs + edit-gate.cjs — a git worktree is its main checkout (identity, not gated root)');
// GATED_MAIN and WORKTREE/WORKTREE_OWN are REAL git fixtures (git init, a
// commit, then a real `git worktree add`) -- not the plain-directory stand-in
// `repoa-wt` uses above. A plain-directory fixture cannot exercise
// repoIdentity's own `git rev-parse` walk; these can.
{
  let n = 0;
  const freshSid = () => `test-gates-wt-${++n}`;
  const lookup = (sid, relative_path, cwd) => run('gates/refs-record.cjs', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
    tool_input: { name_path: 'f', relative_path }, session_id: sid, cwd,
  });
  const edit = (sid, file, cwd) => decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: file }, sid, cwd)));

  // Whether or not the worktree has picked up its own .serena/project.yml,
  // it and its main checkout must share one identity.
  for (const [label, wt, wtFile] of [['no own config', WORKTREE, 'w.py'], ['own config', WORKTREE_OWN, 'wo.py']]) {
    {
      const sid = freshSid();
      lookup(sid, 'main.py', GATED_MAIN);
      check(`a lookup in the checkout opens an edit in its worktree (${label})`,
        edit(sid, path.join(wt, wtFile), wt), 'allow');
    }
    {
      const sid = freshSid();
      lookup(sid, path.join(wt, wtFile), wt);
      check(`a lookup in the worktree (absolute path) opens an edit in the checkout (${label})`,
        edit(sid, path.join(GATED_MAIN, 'main.py'), GATED_MAIN), 'allow');
    }
    {
      const sid = freshSid();
      lookup(sid, path.join(wt, wtFile), wt);
      check(`a lookup in the worktree (${label}) does not open an unrelated repository`,
        edit(sid, path.join(REPO, 'src/thing.py'), REPO), 'deny');
    }
    {
      // A control proving the worktree is actually GATED: every check above
      // only asserts "allow" after a lookup that matches, so a worktree
      // wrongly read as ungated (findGatedRoot failing silently, say) would
      // pass every one of them
      // for a reason unrelated to what they claim to test. A fresh session
      // with no lookup this turn must still be denied.
      const sid = freshSid();
      check(`with no lookup at all this turn, an edit in the worktree is denied (${label})`,
        edit(sid, path.join(wt, wtFile), wt), 'deny');
    }
  }

  // WORKTREE_OWN's OWN directory already carries a `.serena/project.yml`
  // (Serena writes one on first use), so findGatedRoot walking up from a
  // session started there finds it immediately and never needs
  // mainCheckoutRoot's `--git-common-dir` fallback at all: `gated` is
  // WORKTREE_OWN itself, not GATED_MAIN. Both cases below go through
  // sessionIdentity(cwd), which then must call repoIdentity(WORKTREE_OWN) to
  // translate that into GATED_MAIN's identity (--show-toplevel from a cwd
  // inside a worktree names the worktree itself, and repoIdentity rewrites
  // that suffix onto the shared main checkout). Swapping that call for a bare
  // realpath of the gated root would yield WORKTREE_OWN's own path instead,
  // unrelated to GATED_MAIN's identity. WORKTREE (no own config) cannot catch
  // this: findGatedRoot returns GATED_MAIN for it, and repoIdentity and a
  // bare realpath give the same answer for GATED_MAIN.
  {
    const sid = freshSid();
    lookup(sid, undefined, WORKTREE_OWN);
    check('a lookup with no relative_path, from a session started in a worktree with its own config, opens the main checkout',
      edit(sid, path.join(GATED_MAIN, 'main.py'), GATED_MAIN), 'allow');
  }
  {
    // The edit's own `cwd` here is what identityRecorded falls back to
    // sessionIdentity(cwd) FOR (the old-format branch has no recorded
    // identity to compare a hash against at all) -- it must be WORKTREE_OWN
    // itself, standing in for "the session started here", not GATED_MAIN,
    // or the mutant this pins never runs at the worktree path that exposes it.
    const sid = freshSid();
    mark(path.join(STATE, 'refs-checked', `${sid}.json`));
    check('an old-format marker, from a session started in a worktree with its own config, opens the main checkout',
      edit(sid, path.join(GATED_MAIN, 'main.py'), WORKTREE_OWN), 'allow');
  }
}

console.log('\nrefs-record.cjs + edit-gate.cjs — two Serena projects in one git repository stay apart');
{
  const sid = 'test-gates-mono-1';
  run('gates/refs-record.cjs', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
    tool_input: { name_path: 'f', relative_path: 's.py' }, session_id: sid, cwd: path.join(MONO, 'svc'),
  });
  check('a lookup in mono/svc opens an edit in mono/svc',
    decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(MONO, 'svc', 's.py') }, sid, path.join(MONO, 'svc')))),
    'allow');
  check('a lookup in mono/svc does NOT open an edit in mono/web',
    decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: path.join(MONO, 'web', 'w.py') }, sid, path.join(MONO, 'web')))),
    'deny');
  // A control: a mono/svc or mono/web wrongly read as ungated would pass the
  // two allow/deny checks above for the wrong reason -- neither one proves the target is actually policed at all. A
  // fresh session with no lookup this turn, in either sub-project, must
  // still be denied.
  check('with no lookup at all this turn, an edit in mono/svc is denied',
    decision(run('gates/edit-gate.cjs',
      pre('Edit', { file_path: path.join(MONO, 'svc', 's.py') }, 'test-gates-mono-nolookup-svc', path.join(MONO, 'svc')))),
    'deny');
  check('with no lookup at all this turn, an edit in mono/web is denied',
    decision(run('gates/edit-gate.cjs',
      pre('Edit', { file_path: path.join(MONO, 'web', 'w.py') }, 'test-gates-mono-nolookup-web', path.join(MONO, 'web')))),
    'deny');
}

// =============================================================================
console.log('\nedit-gate.cjs — repository lookups are memoised within one hook run');
// A `git` shim placed first on PATH for the hook's own child process, logging
// each invocation's arguments before execing the real git -- so this counts
// SPAWNS, not just correctness. Two shapes each isolate one of the two memos:
//   - a gated repo (found by a plain filesystem walk, no spawn of its own)
//     makes findGatedRoot's own calls free, so every `--show-toplevel` spawn
//     seen is repoIdentity's, called once per gated target by an unmemoised
//     implementation;
//   - an ungated but real git repo never survives the `gated` filter (nothing
//     in it has a Serena config), so repoIdentity is never reached at all, and
//     every `--git-common-dir` spawn seen is findGatedRoot falling through to
//     mainCheckoutRoot, called once per target by an unmemoised implementation.
// N (>= 20) source files, all in ONE directory, so an UNMEMOISED
// implementation still spawns once per target (there is no caching to be
// defeated by them sharing a directory) while a memoised one collapses to a
// small constant regardless of N.
// The git shim is a shell script, so this runs where `sh` does.
if (process.platform === 'win32') {
  console.log('  skip (memoisation check: the git shim is a shell script)');
} else {
  const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const SHIMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateshim-'));
  const LOG = path.join(SHIMDIR, 'git.log');
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(path.join(SHIMDIR, 'git'),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(LOG)}\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`);
  fs.chmodSync(path.join(SHIMDIR, 'git'), 0o755);
  const shimEnv = { PATH: `${SHIMDIR}${path.delimiter}${process.env.PATH}` };
  const resetLog = () => fs.writeFileSync(LOG, '');
  const countLines = (re) => fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => re.test(l)).length;

  const N = 25;
  const BOUND = 3; // a small constant: not asserted to be exactly 1, just far below N.

  // Variant 1: one gated repository -- isolates repoIdentity's spawn.
  const SPAWN_GATED = fs.mkdtempSync(path.join(os.tmpdir(), 'gatespawn-'));
  fs.mkdirSync(path.join(SPAWN_GATED, '.serena'));
  fs.writeFileSync(path.join(SPAWN_GATED, '.serena', 'project.yml'), 'project_name: "spawngated"\n');
  fs.mkdirSync(path.join(SPAWN_GATED, 'src'));
  const gatedFiles = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(SPAWN_GATED, 'src', `f${i}.py`);
    fs.writeFileSync(f, '# x\n');
    gatedFiles.push(f);
  }
  const gatedCmd = `sed -i '' 's/a/b/' ${gatedFiles.join(' ')}`;

  resetLog();
  const gatedStart = Date.now();
  const gatedRes = run('gates/edit-gate.cjs',
    pre('Bash', { command: gatedCmd }, 'test-gates-spawn-gated', SPAWN_GATED), shimEnv);
  const gatedMs = Date.now() - gatedStart;
  const toplevelSpawns = countLines(/--show-toplevel/);
  check(`a ${N}-target Bash write in a gated repo with no lookup is still denied`, decision(gatedRes), 'deny');
  // Exit code and a lower bound together rule out the reading that would
  // make the upper bound alone worthless: a hook that crashed before ever
  // asking repoIdentity anything, or a shim silently bypassed by some other
  // `git` on PATH, both log zero spawns and would satisfy `<= BOUND` too.
  check(`edit-gate.cjs exits 0 for the ${N}-target gated write`, gatedRes.code, 0);
  check(`repoIdentity spawns are bounded by a small constant for ${N} targets in one repo (took ${gatedMs}ms, saw ${toplevelSpawns})`,
    toplevelSpawns >= 1 && toplevelSpawns <= BOUND, true);

  // Variant 2: one ungated but real git repository -- isolates findGatedRoot's
  // mainCheckoutRoot fallback spawn. Nothing here is gated, so `gated` filters
  // to empty and repoIdentity is never called at all.
  const SPAWN_UNGATED = fs.mkdtempSync(path.join(os.tmpdir(), 'gatespawnu-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: SPAWN_UNGATED });
  fs.mkdirSync(path.join(SPAWN_UNGATED, 'src'));
  const ungatedFiles = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(SPAWN_UNGATED, 'src', `g${i}.py`);
    fs.writeFileSync(f, '# x\n');
    ungatedFiles.push(f);
  }
  const ungatedCmd = `sed -i '' 's/a/b/' ${ungatedFiles.join(' ')}`;

  resetLog();
  const ungatedStart = Date.now();
  const ungatedRes = run('gates/edit-gate.cjs',
    pre('Bash', { command: ungatedCmd }, 'test-gates-spawn-ungated', SPAWN_UNGATED), shimEnv);
  const ungatedMs = Date.now() - ungatedStart;
  // findGatedRoot's own walk finds nothing (no .serena anywhere up the tree),
  // so every `--git-common-dir` spawn here is mainCheckoutRoot's, never
  // repoIdentity's (which also prints `--show-toplevel` on the same line).
  const commonDirSpawns = countLines(/--git-common-dir/) - countLines(/--show-toplevel/);
  check(`a ${N}-target Bash write in an ungated git repo is allowed (nothing gated)`, decision(ungatedRes), 'allow');
  // Same pair as variant 1: the exit code and a lower bound together rule
  // out a crashed hook or a bypassed shim passing this check by logging
  // nothing at all.
  check(`edit-gate.cjs exits 0 for the ${N}-target ungated write`, ungatedRes.code, 0);
  check(`findGatedRoot spawns are bounded by a small constant for ${N} targets in one ungated repo (took ${ungatedMs}ms, saw ${commonDirSpawns})`,
    commonDirSpawns >= 1 && commonDirSpawns <= BOUND, true);

  for (const d of [SHIMDIR, SPAWN_GATED, SPAWN_UNGATED]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

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
{
  // A real identity recorded THIS turn must not survive a user prompt: the
  // per-session identity directory is removed alongside the marker, not just
  // the marker file. A same-repository before/after check cannot tell a
  // mutant that only unlinks the marker file (leaving the per-session
  // identity directory itself in place) from correct code --
  // the SECOND turn's own lookup rewrites that repository's identity file
  // into the very directory the first turn left behind, so the edit is
  // allowed on turn 2 for a reason that has nothing to do with clearing.
  // This uses TWO turns in TWO DIFFERENT repositories instead: turn 1 looks
  // up in GATED_MAIN only, a prompt follows, turn 2 looks up in REPO only.
  // Under that mutant, GATED_MAIN's stale identity file from turn 1 is still
  // sitting in the (unremoved) directory, so an edit in GATED_MAIN is wrongly
  // allowed on turn 2 even though nothing was looked up there this turn.
  const sid = 'test-gates-clear-identity';
  const lookIn = (cwd, relative_path) => run('gates/refs-record.cjs', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
    tool_input: { name_path: 'f', relative_path }, session_id: sid, cwd,
  });
  const editIn = (file, cwd) => decision(run('gates/edit-gate.cjs', pre('Edit', { file_path: file }, sid, cwd)));

  lookIn(GATED_MAIN, 'main.py');
  check('before a user prompt, the recorded lookup opens the edit',
    editIn(path.join(GATED_MAIN, 'main.py'), GATED_MAIN), 'allow');

  run('discipline-reminder.cjs', { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: GATED_MAIN });

  lookIn(REPO, 'src/thing.py');
  check("after a user prompt, no identity from the previous turn opens anything",
    editIn(path.join(GATED_MAIN, 'main.py'), GATED_MAIN), 'deny');
  check("this turn's own lookup still opens its own (different) repository",
    editIn(path.join(REPO, 'src/thing.py'), REPO), 'allow');
}

// =============================================================================
console.log('\ndiscipline-reminder.cjs — the subagent profile is enforced by hooks/agent-profile.cjs, not by a prompt rule');
{
  // The dispatch rewrite lives in the PreToolUse hook, so the per-turn reminder must carry
  // no subagent-mode rule whatever the machine default or the per-session file says.
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-mode-'));
  const ctx = (env = {}) => run('discipline-reminder.cjs',
    { hook_event_name: 'UserPromptSubmit', session_id: 'mode-test', cwd: REPO },
    { CLAUDE_CONFIG_DIR: cfg, SHIP_LOOP_PASS: '', ...env }).out?.hookSpecificOutput?.additionalContext || '';
  const carriesRule = (text) => /-lite|subagent mode/i.test(text);

  check('with no mode file, no subagent rule', carriesRule(ctx()), false);
  for (const mode of ['quality', 'balanced', 'fast', 'turbo']) {
    fs.writeFileSync(path.join(cfg, 'subagent-mode'), `${mode}\n`);
    check(`machine default "${mode}" adds no subagent rule`, carriesRule(ctx()), false);
  }
  fs.mkdirSync(path.join(cfg, 'state', 'agent-profile'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'state', 'agent-profile', 'mode-test'), 'fast\n');
  check('a per-session "fast" adds no subagent rule', carriesRule(ctx()), false);
  check('the reminder still lists its standing rules',
    ctx().startsWith('Standing rules for this turn:'), true);
  fs.rmSync(cfg, { recursive: true, force: true });
}

// =============================================================================
console.log('\ndiscipline-reminder.cjs — an unvalidated session_id must not delete outside its own marker directory');
{
  // session_id flows straight from hook JSON into
  // `path.join(configDir, 'state', kind, `${session}.json`)` and
  // `path.join(configDir, 'state', 'refs-checked', session)` with nothing in
  // between to sanitise it. A fully separate, isolated CLAUDE_CONFIG_DIR is
  // used here rather than the shared CONFIG the rest of this suite depends
  // on: this deliberately sends session ids designed to walk OUT of
  // state/refs-checked/ via rmSync({recursive, force}) and unlinkSync, and a
  // suite-wide CONFIG damaged by that would fail every later check for an
  // unrelated reason.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesession-'));
  const home = path.join(tmp, 'home');
  const cfg = path.join(home, 'cfg');
  fs.mkdirSync(path.join(cfg, 'state', 'refs-checked'), { recursive: true });

  // Sentinels: real content this hook must never touch under any of the
  // session ids below, one per directory level a payload targets.
  const settingsFile = path.join(cfg, 'settings.json');
  fs.writeFileSync(settingsFile, '{"real":"settings"}');
  const otherMarker = path.join(cfg, 'state', 'refs-checked', 'other-session.json');
  fs.writeFileSync(otherMarker, '{"other":"session"}');
  const stateFile = path.join(cfg, 'state', 'sentinel-in-state.json');
  fs.writeFileSync(stateFile, '{"in":"state"}');
  const homeFile = path.join(home, 'sentinel-in-home.json');
  fs.writeFileSync(homeFile, '{"in":"home"}');
  const sentinels = [settingsFile, otherMarker, stateFile, homeFile];

  // Each of these resolves INSIDE cfg, never outside <tmp> -- confirmed by
  // hand before running this for real, per the house rule that a red run may
  // never touch anything but a scratch directory it made itself: `.` cancels
  // only `refs-checked` (targets state/refs-checked itself); `..` and
  // `x/../..` cancel `refs-checked` AND `state` (targets state/ itself);
  // `../..` cancels back out to `cfg` itself (targets the whole config dir);
  // `../../settings`, with `.json` appended by the unlink loop's
  // `${session}.json`, lands on exactly `cfg/settings.json`. None climbs as
  // far as `home`, but its sentinel is checked anyway as the plan's stated
  // margin against a validation gap letting a future payload climb further.
  for (const bad of ['.', '..', '../..', 'x/../..', '../../settings']) {
    run('discipline-reminder.cjs',
      { hook_event_name: 'UserPromptSubmit', session_id: bad, cwd: cfg },
      { CLAUDE_CONFIG_DIR: cfg });
  }

  for (const f of sentinels) {
    check(`an invalid session_id does not remove ${path.relative(tmp, f)}`, fs.existsSync(f), true);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// =============================================================================
console.log('\nrefs-record.cjs — an unvalidated session_id must not write outside its own marker directory');
{
  // The same unvalidated-session_id path exists on the WRITE side too:
  // refs-record.cjs's CLI builds `markerPath('refs-checked', session)` and
  // then `fs.writeFileSync` straight to it. `session_id = '../../settings'`
  // makes that path `<configDir>/settings.json` -- overwriting real settings
  // content with a lookup marker's JSON, not merely deleting something.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesession2-'));
  const cfg2 = path.join(tmp2, 'cfg');
  fs.mkdirSync(path.join(cfg2, 'state', 'refs-checked'), { recursive: true });
  const settingsFile2 = path.join(cfg2, 'settings.json');
  const originalSettings = '{"real":"settings"}';
  fs.writeFileSync(settingsFile2, originalSettings);

  // A repo for the lookup to be about; its content is irrelevant, only that
  // the call succeeds and would, unvalidated, go on to reach the write above.
  const R2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gatesession2-repo-'));
  fs.mkdirSync(path.join(R2, '.serena'), { recursive: true });
  fs.writeFileSync(path.join(R2, '.serena', 'project.yml'), 'project_name: "r"\n');
  fs.writeFileSync(path.join(R2, 'x.py'), '# x\n');

  for (const bad of ['../../settings', '..', '.']) {
    run('gates/refs-record.cjs', {
      hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
      tool_input: { name_path: 'f', relative_path: 'x.py' }, session_id: bad, cwd: R2,
    }, { CLAUDE_CONFIG_DIR: cfg2 });
  }

  check('an invalid session_id does not overwrite settings.json',
    fs.readFileSync(settingsFile2, 'utf8'), originalSettings);

  try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(R2, { recursive: true, force: true }); } catch {}
}

// =============================================================================
// Recording is one file write per identity, never a read-modify-write of a
// shared `roots` list: two lookups racing to record two DIFFERENT identities
// each touch only their own file, so neither write can be lost. This launches
// N refs-record.cjs processes for N DISTINCT repositories at once (spawn, not
// spawnSync, so they genuinely overlap) and asserts all N are recorded --
// checked by testing for the recorded FILE ITSELF (identityFileName's hash of
// each repository's expected identity) in the per-session directory, not via
// identityRecorded(marker, cwd, identity) with `cwd` set to the repository:
// that call falls into identityRecorded's OLD-FORMAT branch whenever
// recording wrote nothing at all (an empty or missing identity directory),
// and that branch's fallback answer -- "does `identity` match this session's
// OWN identity, computed the same way from `cwd`?" -- is trivially true when
// `cwd` IS the repository whose identity was just computed and handed back in
// as `identity`. A no-op `recordIdentity` therefore passed all N checks the
// old way; reading the identity directory's own entries by name cannot be
// fooled by that, because there is no code path in which "nothing was
// written" reads as "the file exists". The burst is repeated (REPS) rather
// than run once, because a genuine read-modify-write race is probabilistic --
// a read-modify-write mutant can pass a single burst most of the time -- so
// one clean run does not mean the recording is race-free; each repeat gets its own fresh session id so a race in one cannot be masked by
// files a previous, unrelated burst already left behind.
async function concurrencyTest() {
  console.log('\nrefs-record.cjs — concurrent lookups on distinct repositories all get recorded');
  const { spawn } = require('child_process');
  const { identityFileName, repoIdentity } = require(path.join(HOOKS, 'gates', 'refs-record.cjs'));
  const N = 20;
  const REPS = 3;
  const PARENT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gateconc-'));
  const repos = [];
  for (let i = 0; i < N; i++) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(PARENT2, `r${i}-`)));
    fs.mkdirSync(path.join(dir, '.serena'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serena', 'project.yml'), `project_name: "r${i}"\n`);
    fs.writeFileSync(path.join(dir, 'x.py'), '# x\n');
    // A real (if commit-less) git repo, so repoIdentity's own `git rev-parse`
    // succeeds instead of falling back on failure: `--show-toplevel` needs
    // only a `.git` directory, not a commit. This also keeps this suite's own
    // stderr free of the "not a git repository" noise a non-git fixture would
    // print once per repo -- verify-all's summariser keeps only a suite's
    // LAST TWO output lines, and stdout is concatenated before stderr, so
    // trailing stderr noise here would have pushed the real pass/fail count
    // out of that summary.
    execFileSync('git', ['init', '-q', '.'], { cwd: dir });
    repos.push(dir);
  }

  const lookupAsync = (sid, dir) => new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(HOOKS, 'gates/refs-record.cjs')], {
      env: testEnv(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.write(JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'mcp__serena__find_referencing_symbols',
      tool_input: { name_path: 'f', relative_path: 'x.py' }, session_id: sid, cwd: dir,
    }));
    child.stdin.end();
    child.on('exit', resolve);
    child.on('error', reject);
  });

  for (let rep = 0; rep < REPS; rep++) {
    const sid = `test-gates-concurrency-${rep}`;
    const identityDirPath = path.join(STATE, 'refs-checked', sid);
    rm(path.join(STATE, 'refs-checked', `${sid}.json`));
    try { fs.rmSync(identityDirPath, { recursive: true, force: true }); } catch {}

    await Promise.all(repos.map((dir) => lookupAsync(sid, dir)));

    const recordedCount = repos.filter((dir) =>
      fs.existsSync(path.join(identityDirPath, identityFileName(repoIdentity(dir))))).length;
    check(`all ${N} concurrent lookups on distinct repositories are recorded (burst ${rep + 1}/${REPS})`,
      recordedCount, N);
  }

  try { fs.rmSync(PARENT2, { recursive: true, force: true }); } catch {}
}

(async () => {
  await concurrencyTest();

  for (const d of [CONFIG, REPO, PLAIN, WORKTREE, WORKTREE_OWN, GATED_MAIN, MONO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})();
