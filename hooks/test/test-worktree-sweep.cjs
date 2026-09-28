#!/usr/bin/env node
// Behavioural tests for the worktree sweep.
// Run: node ~/.claude/hooks/test/test-worktree-sweep.cjs
//
//   worktree-sweep.cjs   SessionStart — removes a repo's local worktrees (and
//                         branches) whose work already landed through a
//                         merged GitHub PR, and nothing else: never a push,
//                         never a remote branch.
//
// House style: every MUST-fire paired with a MUST-NOT. This one deletes local
// work unattended, so the MUST-NOTs are the important half — a false positive
// here is data loss, not a missed cleanup.
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// hooks/test/test-worktree-sweep.cjs -> hooks/test -> hooks: resolve from the
// script's own location so this suite exercises the checkout it lives in.
const HOOKS = path.join(__dirname, '..');
const BIN = path.join(HOOKS, 'worktree-sweep.cjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

const trash = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); trash.push(d); return d; };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'wts-test', GIT_AUTHOR_EMAIL: 'wts@test.local',
  GIT_COMMITTER_NAME: 'wts-test', GIT_COMMITTER_EMAIL: 'wts@test.local',
};
const gitc = (args, cwd) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

// A scratch CLAUDE_CONFIG_DIR per suite run — the throttle stamps, backups
// and fake transcripts all land here, never in the real ~/.claude/state.
const CONFIG = tmp('wts-config-');

// Fake `gh` and `lsof` binaries: the hook is handed their paths via
// CLAUDE_WORKTREE_SWEEP_GH / CLAUDE_WORKTREE_SWEEP_LSOF, so nothing here
// depends on a real `gh` login or the machine's actual open files.
const FARM = tmp('wts-farm-');
// Prints WTS_TEST_GH_JSON UNCONDITIONALLY, then exits according to
// WTS_TEST_GH_EXIT -- valid-looking merged-PR data on stdout alongside a
// non-zero exit is exactly the shape gh can take on a real transient
// failure, and mergedPRs() has to notice the exit code, not just try to
// parse whatever came out. A stub that only prints when it "succeeds" would
// let a dropped exit-status check hide behind an empty parse instead of
// getting caught.
const ghStub = path.join(FARM, 'gh-stub.sh');
fs.writeFileSync(ghStub, [
  '#!/bin/sh',
  'printf \'%s\' "$WTS_TEST_GH_JSON"',
  'if [ -n "$WTS_TEST_GH_EXIT" ] && [ "$WTS_TEST_GH_EXIT" != "0" ]; then exit "$WTS_TEST_GH_EXIT"; fi',
  'exit 0',
  '',
].join('\n'));
fs.chmodSync(ghStub, 0o755);

// Default: no process anywhere has the worktree as its cwd.
const lsofEmptyStub = path.join(FARM, 'lsof-empty.sh');
fs.writeFileSync(lsofEmptyStub, '#!/bin/sh\nexit 0\n');
fs.chmodSync(lsofEmptyStub, 0o755);

// Reports one open cwd, read from WTS_TEST_LSOF_PATH, in the -Fn shape lsof
// actually emits: a process-id line, then an 'n'-prefixed name line.
const lsofBusyStub = path.join(FARM, 'lsof-busy.sh');
fs.writeFileSync(lsofBusyStub, '#!/bin/sh\nprintf \'p99999\\nn%s\\n\' "$WTS_TEST_LSOF_PATH"\n');
fs.chmodSync(lsofBusyStub, 0o755);

const lsofMissing = path.join(FARM, 'no-such-lsof-binary');

// Exits non-zero with no output at all — some lsof builds do this on a
// permissions problem, not only when there is genuinely nothing to report.
const lsofExit1Stub = path.join(FARM, 'lsof-exit1.sh');
fs.writeFileSync(lsofExit1Stub, '#!/bin/sh\nexit 1\n');
fs.chmodSync(lsofExit1Stub, 0o755);

function today() { return new Date().toISOString().slice(0, 10); }
// Matches the hook's own repoBackupKey(): repo name plus a short hash of the
// shared .git path, so two checkouts that happen to share a basename never
// collide, and so this helper reads the SAME identity the hook computed
// rather than assuming basename is enough.
function commonDirFor(repoDir) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: repoDir, encoding: 'utf8' }).trim();
}
function backupsDirFor(repoDir) {
  const hash = crypto.createHash('sha256').update(commonDirFor(repoDir)).digest('hex').slice(0, 8);
  return path.join(CONFIG, 'state', 'worktree-sweep', 'backups', `${path.basename(repoDir)}-${hash}`, today());
}
// Matches the hook's own slugify(): every non-alphanumeric character becomes
// '-'. Used both for the ~/.claude/projects transcript directory name and
// for a worktree's own backup subdirectory name.
function slug(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

// One bare "origin" plus a clone that acts as the main checkout, with a
// tracked CLAUDE.md so the "only CLAUDE.md is dirty" case has something real
// to modify. origin/HEAD is set explicitly because an empty bare repo has no
// default branch for `clone` to pick one up from automatically.
function makeFixture() {
  const bare = tmp('wts-origin-');
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: ['ignore', 'ignore', 'ignore'] });
  const main = tmp('wts-main-');
  // stdio ignored on stderr: cloning a still-empty bare repo prints "warning:
  // You appear to have cloned an empty repository", which is expected here
  // and not worth the noise -- left inherited, it drowns the real "N passed,
  // M failed" summary line verify-all.cjs looks at.
  execFileSync('git', ['clone', '-q', bare, main], { env: GIT_ENV, stdio: ['ignore', 'ignore', 'ignore'] });
  gitc(['checkout', '-q', '-B', 'main'], main);
  fs.writeFileSync(path.join(main, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), 'shared instructions\n');
  // -f: this machine's global gitignore excludes a root-level CLAUDE.md (colleagues
  // run different assistants), which would otherwise silently drop it from `git add .`
  // and make every "CLAUDE.md is dirty" fixture below track nothing at all.
  gitc(['add', '-f', '.'], main);
  gitc(['commit', '-q', '-m', 'init'], main);
  gitc(['push', '-q', '-u', 'origin', 'main'], main);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  gitc(['remote', 'set-head', 'origin', 'main'], main);
  return { bare, main };
}

// Branches off main with `extraCommits` new commits, pushed to origin unless
// told not to. Returns the branch tip sha. Leaves `main` checked back out on
// `main` so its own working tree stays free for the next branch/worktree.
function makeBranch(main, name, { push = true, extraCommits = 1 } = {}) {
  gitc(['checkout', '-q', 'main'], main);
  gitc(['checkout', '-q', '-b', name], main);
  for (let i = 0; i < extraCommits; i++) {
    fs.writeFileSync(path.join(main, `${name.replace(/\//g, '-')}-${i}.txt`), `content ${i}\n`);
    gitc(['add', '.'], main);
    gitc(['commit', '-q', '-m', `${name} commit ${i}`], main);
  }
  const sha = gitc(['rev-parse', 'HEAD'], main).trim();
  if (push) gitc(['push', '-q', 'origin', name], main);
  gitc(['checkout', '-q', 'main'], main);
  return sha;
}

function addWorktree(main, branch) {
  const dir = tmp('wts-wt-');
  fs.rmdirSync(dir); // `git worktree add` wants a path that does not exist yet
  gitc(['worktree', 'add', '-q', dir, branch], main);
  return dir;
}

// Like addWorktree, but at an explicit directory name under a fresh parent —
// used to put a space (or any other character) into the worktree's own path.
function addWorktreeIn(main, branch, dirName) {
  const parent = tmp('wts-wt-parent-');
  const dir = path.join(parent, dirName);
  gitc(['worktree', 'add', '-q', dir, branch], main);
  return dir;
}

function withPRs(prs) { return { WTS_TEST_GH_JSON: JSON.stringify(prs) }; }

function run(args, { env = {}, input = '' } = {}) {
  const r = spawnSync('node', [BIN, ...args], {
    input,
    encoding: 'utf-8',
    timeout: 20000,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: CONFIG,
      CLAUDE_NO_WORKTREE_SWEEP: '',
      CLAUDE_WORKTREE_SWEEP_GH: ghStub,
      CLAUDE_WORKTREE_SWEEP_LSOF: lsofEmptyStub,
      CLAUDE_WORKTREE_SWEEP_KEEP: '',
      ...env,
    },
  });
  let out = null;
  try { out = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = null; }
  return { out, code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const context = (res) => res.out?.hookSpecificOutput?.additionalContext ?? '';

function hookRun(cwd, env = {}) {
  const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd });
  return run([], { env, input });
}
const cliDryRun = (repoPath, env = {}) => run(['--dry-run', '--repo', repoPath], { env });
const cliRun = (repoPath, env = {}) => run(['--repo', repoPath], { env });

// =============================================================================
console.log('\nworktree-sweep.cjs — a clean, merged worktree is removed');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/foo');
  const wt = addWorktree(main, 'fix/foo');
  const prs = [{ number: 1, headRefName: 'fix/foo', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree directory is gone', fs.existsSync(wt), false);
  check('local branch is deleted', gitc(['branch', '--list', 'fix/foo'], main).trim(), '');
  const tips = path.join(backupsDirFor(main), 'branch-tips.txt');
  check('a backup tips file was written', fs.existsSync(tips), true);
  check('and it names the removed branch',
    fs.existsSync(tips) && fs.readFileSync(tips, 'utf8').includes('fix/foo'), true);
}

console.log('\nworktree-sweep.cjs — a worktree with only CLAUDE.md modified is force-removed');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/claude');
  const wt = addWorktree(main, 'fix/claude');
  const wtSlug = slug(fs.realpathSync(wt)); // captured before removal -- the path stops existing afterward
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'worktree-local notes\n');
  const prs = [{ number: 2, headRefName: 'fix/claude', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree directory is gone despite the local edit', fs.existsSync(wt), false);
  // Named by the full worktree path slugified, not its basename -- two
  // worktrees with the same basename must not overwrite each other's patch.
  const patch = path.join(backupsDirFor(main), wtSlug, 'diff.patch');
  check('the CLAUDE.md diff was backed up before removal',
    fs.existsSync(patch) && fs.readFileSync(patch, 'utf8').includes('CLAUDE.md'), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: an untracked file is present');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/untracked');
  const wt = addWorktree(main, 'fix/untracked');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'oops\n');
  const prs = [{ number: 3, headRefName: 'fix/untracked', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept', fs.existsSync(wt), true);
  check('branch is kept', gitc(['branch', '--list', 'fix/untracked'], main).trim() !== '', true);
  check('the report shows KEEP with the untracked file named',
    /KEEP[^\n]*scratch\.txt/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: a non-allowlisted file is modified');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/readme');
  const wt = addWorktree(main, 'fix/readme');
  fs.writeFileSync(path.join(wt, 'README.md'), 'changed locally\n');
  const prs = [{ number: 4, headRefName: 'fix/readme', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept', fs.existsSync(wt), true);
  check('the report shows KEEP with README.md named',
    /KEEP[^\n]*README\.md/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: a commit exists after the merged PR head');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/ahead');
  const wt = addWorktree(main, 'fix/ahead');
  fs.writeFileSync(path.join(wt, 'more.txt'), 'more work\n');
  gitc(['add', '.'], wt);
  gitc(['commit', '-q', '-m', 'unmerged follow-up'], wt);
  const prs = [{ number: 5, headRefName: 'fix/ahead', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept', fs.existsSync(wt), true);
  check('the report shows KEEP with the ancestor reason',
    /KEEP[^\n]*not an ancestor/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: no PR exists for the branch');
{
  const { main } = makeFixture();
  makeBranch(main, 'fix/no-pr');
  const wt = addWorktree(main, 'fix/no-pr');
  const res = cliRun(main, withPRs([]));
  check('exits 0', res.code, 0);
  check('worktree is kept', fs.existsSync(wt), true);
  check('the report shows KEEP with no-PR as the reason',
    /KEEP[^\n]*no merged PR found/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: the merged PR head is a different, unrelated commit');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/related');
  const unrelatedSha = makeBranch(main, 'fix/sibling'); // diverges from the same parent, not an ancestor either way
  const wt = addWorktree(main, 'fix/related');
  const prs = [{ number: 6, headRefName: 'fix/related', headRefOid: unrelatedSha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: tip is not an ancestor of the PR head', fs.existsSync(wt), true);
  check('the report shows KEEP with the ancestor reason',
    /KEEP[^\n]*not an ancestor/.test(res.stdout), true);
  void sha;
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: origin/<branch> has moved past the merged PR head');
{
  const { bare, main } = makeFixture();
  const sha = makeBranch(main, 'fix/moved');
  const wt = addWorktree(main, 'fix/moved');
  // Fabricate a follow-on commit and push it straight to origin's ref,
  // without ever touching the local branch (which stays checked out in wt).
  const tree = gitc(['rev-parse', `${sha}^{tree}`], main).trim();
  const sha2 = execFileSync('git', ['commit-tree', tree, '-p', sha, '-m', 'remote moved on'],
    { cwd: main, env: GIT_ENV, encoding: 'utf8' }).trim();
  gitc(['push', '-q', 'origin', `${sha2}:refs/heads/fix/moved`], main);
  const prs = [{ number: 8, headRefName: 'fix/moved', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: origin has moved past the merged head', fs.existsSync(wt), true);
  check('the report shows KEEP with the "moved past" reason',
    /KEEP[^\n]*has moved past the merged PR/.test(res.stdout), true);
  void bare;
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: a protected branch name (TST), even with a matching merged PR');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'TST');
  const wt = addWorktree(main, 'TST');
  const prs = [{ number: 9, headRefName: 'TST', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: TST is protected', fs.existsSync(wt), true);
  check('the report shows KEEP with the protected-branch reason',
    /KEEP[^\n]*TST is a protected branch/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: the session\'s own worktree');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/own');
  const wt = addWorktree(main, 'fix/own');
  const prs = [{ number: 10, headRefName: 'fix/own', headRefOid: sha }];
  const res = hookRun(wt, withPRs(prs));
  check('exits 0', res.code, 0);
  check('the worktree the session is running in is never removed', fs.existsSync(wt), true);
  const dry = cliDryRun(wt, withPRs(prs));
  check('dry-run exits 0', dry.code, 0);
  check('the report shows KEEP as the session\'s own worktree',
    /KEEP[^\n]*own worktree/.test(dry.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: the session\'s own worktree, nested inside the main checkout');
{
  // `git worktree list` always lists the main worktree first, and main's own
  // path is ALSO a prefix of a worktree nested inside it -- own-worktree
  // detection has to pick the LONGEST matching path, not the first one, or a
  // layout like <repo>/.claude/worktrees/feat gets shadowed by <repo> itself.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/nested-own');
  const nestedDir = path.join(main, '.claude', 'worktrees', 'feat');
  fs.mkdirSync(path.dirname(nestedDir), { recursive: true });
  gitc(['worktree', 'add', '-q', nestedDir, 'fix/nested-own'], main);
  const prs = [{ number: 23, headRefName: 'fix/nested-own', headRefOid: sha }];
  const dry = cliDryRun(nestedDir, withPRs(prs));
  check('dry-run names it as the session\'s own worktree', /own worktree/.test(dry.stdout), true);
  const res = cliRun(nestedDir, withPRs(prs));
  check('exits 0', res.code, 0);
  check('the nested worktree survives: it is the session\'s own', fs.existsSync(nestedDir), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: a locked worktree');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/locked');
  const wt = addWorktree(main, 'fix/locked');
  gitc(['worktree', 'lock', wt], main);
  const prs = [{ number: 11, headRefName: 'fix/locked', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: locked', fs.existsSync(wt), true);
  check('the report shows KEEP as locked', /KEEP[^\n]*locked/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: a Claude transcript was touched in the last 24h');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/transcript');
  const wt = addWorktree(main, 'fix/transcript');
  // `git worktree add` canonicalises the path it is given (e.g. macOS's
  // /var -> /private/var), so the transcript slug must be built from the
  // same resolved path the hook will see reported by `git worktree list`.
  const projDir = path.join(CONFIG, 'projects', slug(fs.realpathSync(wt)));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'x.jsonl'), '{}\n');
  const prs = [{ number: 12, headRefName: 'fix/transcript', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept', fs.existsSync(wt), true);
  check('the report shows KEEP with the transcript reason', /KEEP[^\n]*transcript/i.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — the transcript slug: a worktree path containing a space is removed normally');
{
  // Every non-alphanumeric character (not just '/' and '.') has to become
  // '-', or a space in the path produces a slug that never matches the
  // directory name Claude Code actually creates -- proven here by the
  // absence of a match: no transcript exists, so removal must proceed.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/spacepath');
  const wt = addWorktreeIn(main, 'fix/spacepath', 'wt with space');
  const prs = [{ number: 24, headRefName: 'fix/spacepath', headRefOid: sha }];
  cliRun(main, withPRs(prs));
  check('a worktree whose path contains a space is removed', fs.existsSync(wt), false);
}

console.log('\nworktree-sweep.cjs — the transcript slug: a session opened in a subdirectory of the worktree still keeps it');
{
  // Claude Code names a project directory after the exact folder a session
  // opened in, so a session opened in <worktree>/backend gets its own
  // transcript dir named "<slug(worktree)>-backend", never
  // "<slug(worktree)>" exactly -- the lookup has to match on that prefix.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/subdirtranscript');
  const wt = addWorktree(main, 'fix/subdirtranscript');
  const subSlug = `${slug(fs.realpathSync(wt))}-backend`;
  const projDir = path.join(CONFIG, 'projects', subSlug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'x.jsonl'), '{}\n');
  const prs = [{ number: 25, headRefName: 'fix/subdirtranscript', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: a subdirectory session transcript is recent', fs.existsSync(wt), true);
  check('the report shows KEEP with the transcript reason', /KEEP[^\n]*transcript/i.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — the lsof check: a process with its cwd there means keep');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/busy');
  const wt = addWorktree(main, 'fix/busy');
  const prs = [{ number: 13, headRefName: 'fix/busy', headRefOid: sha }];
  const res = cliRun(main, { ...withPRs(prs), CLAUDE_WORKTREE_SWEEP_LSOF: lsofBusyStub, WTS_TEST_LSOF_PATH: fs.realpathSync(wt) });
  check('exits 0', res.code, 0);
  check('worktree is kept: a process has its cwd there', fs.existsSync(wt), true);
  check('the report shows KEEP with a process-cwd reason',
    /KEEP[^\n]*process has its cwd/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — the lsof check: lsof unavailable means keep (fail safe)');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/nolsof');
  const wt = addWorktree(main, 'fix/nolsof');
  const prs = [{ number: 14, headRefName: 'fix/nolsof', headRefOid: sha }];
  const res = cliRun(main, { ...withPRs(prs), CLAUDE_WORKTREE_SWEEP_LSOF: lsofMissing });
  check('exits 0', res.code, 0);
  check('worktree is kept: lsof could not be run', fs.existsSync(wt), true);
  check('the report shows KEEP with lsof unavailable as the reason',
    /KEEP[^\n]*lsof could not be run/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — the lsof check: a non-zero exit (even with empty output) also means keep');
{
  // Some lsof builds exit non-zero on a permissions problem or an
  // unsupported filter, not only when there is genuinely nothing to report --
  // "could not ask" must never be read as "asked, and the answer is no".
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/lsofexit1');
  const wt = addWorktree(main, 'fix/lsofexit1');
  const prs = [{ number: 26, headRefName: 'fix/lsofexit1', headRefOid: sha }];
  const res = cliRun(main, { ...withPRs(prs), CLAUDE_WORKTREE_SWEEP_LSOF: lsofExit1Stub });
  check('exits 0', res.code, 0);
  check('worktree is kept: lsof exited non-zero', fs.existsSync(wt), true);
  check('the report shows KEEP with lsof unavailable as the reason',
    /KEEP[^\n]*lsof could not be run/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT act: the gh stub fails');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/ghfail');
  const wt = addWorktree(main, 'fix/ghfail');
  const prs = [{ number: 15, headRefName: 'fix/ghfail', headRefOid: sha }];
  const res = hookRun(main, { ...withPRs(prs), WTS_TEST_GH_EXIT: '1' });
  check('exits 0', res.code, 0);
  check('nothing is removed', fs.existsSync(wt), true);
  check('nothing is reported', context(res), '');
}

console.log('\nworktree-sweep.cjs — the opt-out stops it entirely');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/optout');
  const wt = addWorktree(main, 'fix/optout');
  const prs = [{ number: 16, headRefName: 'fix/optout', headRefOid: sha }];
  const res = hookRun(main, { ...withPRs(prs), CLAUDE_NO_WORKTREE_SWEEP: '1' });
  check('exits 0', res.code, 0);
  check('nothing is removed', fs.existsSync(wt), true);
}

console.log('\nworktree-sweep.cjs — throttle: a second hook run within the hour does not re-sweep; --dry-run ignores it');
{
  const { main } = makeFixture();
  const sha1 = makeBranch(main, 'fix/first');
  const wt1 = addWorktree(main, 'fix/first');
  const res1 = hookRun(main, withPRs([{ number: 17, headRefName: 'fix/first', headRefOid: sha1 }]));
  check('first run exits 0', res1.code, 0);
  check('first run removes it', fs.existsSync(wt1), false);

  const sha2 = makeBranch(main, 'fix/second');
  const wt2 = addWorktree(main, 'fix/second');
  hookRun(main, withPRs([{ number: 18, headRefName: 'fix/second', headRefOid: sha2 }]));
  check('second run is throttled: nothing new is removed', fs.existsSync(wt2), true);

  const dry = cliDryRun(main, withPRs([{ number: 18, headRefName: 'fix/second', headRefOid: sha2 }]));
  check('dry-run exits 0 even while throttled', dry.code, 0);
  check('dry-run does not remove anything', fs.existsSync(wt2), true);
  check('dry-run still reports what it would do', /fix\/second/.test(dry.stdout), true);
}

console.log('\nworktree-sweep.cjs — dry-run is honest that it still fetches origin');
{
  // The verdicts above depend on an up-to-date origin, so --dry-run fetches
  // it too -- the one side effect a "plan only" run has. Silence about that
  // would read as "nothing happened", which is not quite true.
  const { main } = makeFixture();
  const dry = cliDryRun(main, withPRs([]));
  check('dry-run states plainly what it did and did not change',
    /dry run: fetched origin; no worktrees or branches changed/.test(dry.stdout), true);
}

console.log('\nworktree-sweep.cjs — branch-only deletion: a merged branch with no worktree is deleted');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/orphan', { push: true });
  // No worktree was ever created for fix/orphan — only main is checked out.
  const prs = [{ number: 19, headRefName: 'fix/orphan', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('the orphan branch is deleted', gitc(['branch', '--list', 'fix/orphan'], main).trim(), '');
  check('the current branch (main) survives', gitc(['branch', '--list', 'main'], main).trim() !== '', true);
  const tips = path.join(backupsDirFor(main), 'branch-tips.txt');
  check('its tip is recorded in the same backup file',
    fs.existsSync(tips) && fs.readFileSync(tips, 'utf8').includes('fix/orphan'), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: CLAUDE.md modified plus another tracked file modified');
{
  // The dirty check must fire on the OTHER file even though CLAUDE.md alone
  // would be allowed -- one allowed edit does not waive the check for
  // everything else in the working tree.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/dirty-tracked');
  const wt = addWorktree(main, 'fix/dirty-tracked');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local notes\n');
  fs.writeFileSync(path.join(wt, 'README.md'), 'also changed locally\n');
  const prs = [{ number: 27, headRefName: 'fix/dirty-tracked', headRefOid: sha }];
  const dry = cliDryRun(main, withPRs(prs));
  check('dry-run verdict is KEEP with a dirty reason', /working tree not clean/.test(dry.stdout), true);
  check('and it names the offending file', /README\.md/.test(dry.stdout), true);
  cliRun(main, withPRs(prs));
  check('the worktree survives', fs.existsSync(wt), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: CLAUDE.md modified plus an untracked file present');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/dirty-untracked');
  const wt = addWorktree(main, 'fix/dirty-untracked');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local notes\n');
  fs.writeFileSync(path.join(wt, 'scratch.md'), 'untracked scratch\n');
  const prs = [{ number: 28, headRefName: 'fix/dirty-untracked', headRefOid: sha }];
  const dry = cliDryRun(main, withPRs(prs));
  check('dry-run verdict is KEEP with a dirty reason', /working tree not clean/.test(dry.stdout), true);
  cliRun(main, withPRs(prs));
  check('the worktree survives', fs.existsSync(wt), true);
}

console.log('\nworktree-sweep.cjs — MUST NOT remove: an untracked file hidden by status.showUntrackedFiles=no');
{
  // A repo-level git config must never be able to hide a file this hook
  // needs to see -- --untracked-files=all pins that regardless of what the
  // operator (or a colleague) set locally.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/hidden-untracked');
  const wt = addWorktree(main, 'fix/hidden-untracked');
  gitc(['config', 'status.showUntrackedFiles', 'no'], main);
  fs.writeFileSync(path.join(wt, 'notes.md'), 'secret notes\n');
  const prs = [{ number: 29, headRefName: 'fix/hidden-untracked', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept despite status.showUntrackedFiles=no', fs.existsSync(wt), true);
  check('the report shows KEEP with notes.md named',
    /KEEP[^\n]*notes\.md/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — a failed worktree removal is reported, and its branch survives');
{
  // A read-only subdirectory blocks `git worktree remove`'s own cleanup --
  // the removal must fail loudly, never delete the branch of a worktree
  // that is still sitting on disk, and never be silently retried.
  const { main } = makeFixture();
  gitc(['checkout', '-q', '-b', 'fix/readonly'], main);
  fs.mkdirSync(path.join(main, 'locked'));
  fs.writeFileSync(path.join(main, 'locked', 'x.txt'), 'x\n');
  gitc(['add', '.'], main);
  gitc(['commit', '-q', '-m', 'add locked dir'], main);
  const sha = gitc(['rev-parse', 'HEAD'], main).trim();
  gitc(['push', '-q', 'origin', 'fix/readonly'], main);
  gitc(['checkout', '-q', 'main'], main);
  const wt = addWorktree(main, 'fix/readonly');
  const lockedSubdir = path.join(wt, 'locked');
  fs.chmodSync(lockedSubdir, 0o555); // no write: nothing inside can be deleted
  const prs = [{ number: 30, headRefName: 'fix/readonly', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  fs.chmodSync(lockedSubdir, 0o755); // restore before the trash-array cleanup runs
  check('exits 0', res.code, 0);
  check('the worktree directory survives the failed removal', fs.existsSync(wt), true);
  check('the branch survives too', gitc(['branch', '--list', 'fix/readonly'], main).trim() !== '', true);
  check('the failure is reported', /failed to remove/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — a gitignored .env at the worktree root is backed up before removal');
{
  const { main } = makeFixture();
  fs.writeFileSync(path.join(main, '.gitignore'), '.env\n');
  gitc(['add', '-f', '.gitignore'], main);
  gitc(['commit', '-q', '-m', 'add gitignore'], main);
  gitc(['push', '-q', 'origin', 'main'], main);
  const sha = makeBranch(main, 'fix/envbackup');
  const wt = addWorktree(main, 'fix/envbackup');
  const wtSlug = slug(fs.realpathSync(wt));
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  const prs = [{ number: 31, headRefName: 'fix/envbackup', headRefOid: sha }];
  cliRun(main, withPRs(prs));
  check('the ignored .env does not block removal', fs.existsSync(wt), false);
  const envBackup = path.join(backupsDirFor(main), wtSlug, '.env');
  check('.env was copied into the backup before removal',
    fs.existsSync(envBackup) && fs.readFileSync(envBackup, 'utf8').includes('SECRET=1'), true);
}

console.log('\nworktree-sweep.cjs — the time budget stops new removals early and reports it');
{
  const { main } = makeFixture();
  const sha1 = makeBranch(main, 'fix/budget1');
  const wt1 = addWorktree(main, 'fix/budget1');
  const sha2 = makeBranch(main, 'fix/budget2');
  const wt2 = addWorktree(main, 'fix/budget2');
  const prs = [
    { number: 32, headRefName: 'fix/budget1', headRefOid: sha1 },
    { number: 33, headRefName: 'fix/budget2', headRefOid: sha2 },
  ];
  const res = cliRun(main, { ...withPRs(prs), CLAUDE_WORKTREE_SWEEP_TIME_BUDGET_MS: '0' });
  check('exits 0', res.code, 0);
  check('nothing is removed once the budget is already spent', fs.existsSync(wt1) && fs.existsSync(wt2), true);
  check('the early stop is reported', /stopped early \(time budget\)/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — an invalid time budget override falls back to the default');
{
  // NaN would compare falsy against every "time is up" check and never
  // time out at all; a negative number would slam the budget shut before
  // evaluation even finishes. Both are ignored in favour of the real 20s
  // default, generous enough that these tiny fixtures still complete well
  // inside it.
  const { main } = makeFixture();
  const sha1 = makeBranch(main, 'fix/badbudget1');
  const wt1 = addWorktree(main, 'fix/badbudget1');
  const res1 = cliRun(main, {
    ...withPRs([{ number: 34, headRefName: 'fix/badbudget1', headRefOid: sha1 }]),
    CLAUDE_WORKTREE_SWEEP_TIME_BUDGET_MS: 'not-a-number',
  });
  check('exits 0 with a non-finite override', res1.code, 0);
  check('a non-finite override falls back to the default budget', fs.existsSync(wt1), false);

  const sha2 = makeBranch(main, 'fix/badbudget2');
  const wt2 = addWorktree(main, 'fix/badbudget2');
  const res2 = cliRun(main, {
    ...withPRs([{ number: 35, headRefName: 'fix/badbudget2', headRefOid: sha2 }]),
    CLAUDE_WORKTREE_SWEEP_TIME_BUDGET_MS: '-5',
  });
  check('exits 0 with a negative override', res2.code, 0);
  check('a negative override falls back to the default budget', fs.existsSync(wt2), false);
}

console.log('\nworktree-sweep.cjs — a failed backup means the worktree is kept, not removed');
{
  // A pre-existing FILE where the per-worktree backup directory should go
  // blocks fs.mkdirSync -- the removal must never proceed on a backup that
  // did not actually happen.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/backupfail');
  const wt = addWorktree(main, 'fix/backupfail');
  const wtSlug = slug(fs.realpathSync(wt));
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local notes\n'); // dirty, so a backup is attempted
  const conflictParent = backupsDirFor(main);
  fs.mkdirSync(conflictParent, { recursive: true });
  fs.writeFileSync(path.join(conflictParent, wtSlug), 'a file, not a directory\n');
  const prs = [{ number: 36, headRefName: 'fix/backupfail', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('the worktree survives: the backup could not be written', fs.existsSync(wt), true);
  check('the branch survives too', gitc(['branch', '--list', 'fix/backupfail'], main).trim() !== '', true);
  check('the CLI reports it kept, with the backup-failed reason',
    /KEPT[^\n]*backup failed/.test(res.stdout), true);
}

console.log('\nworktree-sweep.cjs — an earlier backup from today is never overwritten');
{
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/dedupe');
  const wt = addWorktree(main, 'fix/dedupe');
  const wtSlug = slug(fs.realpathSync(wt));
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local notes\n');
  const earlierDir = path.join(backupsDirFor(main), wtSlug);
  fs.mkdirSync(earlierDir, { recursive: true });
  fs.writeFileSync(path.join(earlierDir, 'diff.patch'), 'EARLIER BACKUP -- do not overwrite\n');
  const prs = [{ number: 37, headRefName: 'fix/dedupe', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('the worktree is removed', fs.existsSync(wt), false);
  check('the earlier backup is untouched',
    fs.readFileSync(path.join(earlierDir, 'diff.patch'), 'utf8').includes('EARLIER BACKUP'), true);
  const dedupedPatch = path.join(backupsDirFor(main), `${wtSlug}-2`, 'diff.patch');
  check('the new backup went to a deduped subdirectory instead',
    fs.existsSync(dedupedPatch) && fs.readFileSync(dedupedPatch, 'utf8').includes('CLAUDE.md'), true);
}

console.log('\nworktree-sweep.cjs — the transcript slug: truncated at 200 chars, matching what Claude Code actually names');
{
  // Claude Code truncates its own project-directory name to 200 characters
  // plus a hash once the slug passes that length -- we cannot reproduce the
  // hash, so the match has to fall back to the 200-character prefix the two
  // names share.
  const { main } = makeFixture();
  const sha = makeBranch(main, 'fix/longpath');
  const longSegment = 'x'.repeat(210);
  const wt = addWorktreeIn(main, 'fix/longpath', longSegment);
  const fullSlug = slug(fs.realpathSync(wt));
  check('the fixture actually produces a slug over 200 characters', fullSlug.length > 200, true);
  const truncatedName = `${fullSlug.slice(0, 200)}-deadbeef01`;
  const projDir = path.join(CONFIG, 'projects', truncatedName);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'x.jsonl'), '{}\n');
  const prs = [{ number: 39, headRefName: 'fix/longpath', headRefOid: sha }];
  const res = cliRun(main, withPRs(prs));
  check('exits 0', res.code, 0);
  check('worktree is kept: the truncated transcript dir name still matches', fs.existsSync(wt), true);
}

console.log('\nworktree-sweep.cjs — a failures-only report is still prefixed "Worktree sweep:"');
{
  const { main } = makeFixture();
  gitc(['checkout', '-q', '-b', 'fix/failonly'], main);
  fs.mkdirSync(path.join(main, 'locked2'));
  fs.writeFileSync(path.join(main, 'locked2', 'x.txt'), 'x\n');
  gitc(['add', '.'], main);
  gitc(['commit', '-q', '-m', 'add locked2 dir'], main);
  const sha = gitc(['rev-parse', 'HEAD'], main).trim();
  gitc(['push', '-q', 'origin', 'fix/failonly'], main);
  gitc(['checkout', '-q', 'main'], main);
  const wt = addWorktree(main, 'fix/failonly');
  const lockedSubdir = path.join(wt, 'locked2');
  fs.chmodSync(lockedSubdir, 0o555);
  const prs = [{ number: 38, headRefName: 'fix/failonly', headRefOid: sha }];
  const res = hookRun(main, withPRs(prs));
  fs.chmodSync(lockedSubdir, 0o755); // restore before the trash-array cleanup runs
  check('exits 0', res.code, 0);
  check('a failures-only report is still prefixed "Worktree sweep:"',
    context(res).startsWith('Worktree sweep:'), true);
  check('and it names the failure', /failed to remove/.test(context(res)), true);
}

console.log('\nworktree-sweep.cjs — it always exits 0, including on malformed stdin');
{
  const r = spawnSync('node', [BIN], {
    input: 'not json {{{',
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_NO_WORKTREE_SWEEP: '', CLAUDE_WORKTREE_SWEEP_GH: ghStub },
  });
  check('malformed stdin still exits 0', r.status, 0);
}
{
  const r = spawnSync('node', [BIN], {
    input: '',
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_NO_WORKTREE_SWEEP: '', CLAUDE_WORKTREE_SWEEP_GH: ghStub },
  });
  check('empty stdin still exits 0', r.status, 0);
}
{
  const r = spawnSync('node', [BIN], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/definitely/not/a/repo/path' }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_NO_WORKTREE_SWEEP: '', CLAUDE_WORKTREE_SWEEP_GH: ghStub },
  });
  check('a cwd outside any git repo exits 0', r.status, 0);
}

for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort cleanup */ } }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
