#!/usr/bin/env node
// SessionStart: removes a repository's local git worktrees whose work has
// already landed through a merged GitHub PR, and deletes their local
// branches. Local state only — never a push, never a remote branch.
//
// Why this exists. A repo worked in through /ship or /bug accumulates linked
// worktrees, one per feature branch, and nothing ever removes them once the
// PR merges: the branch is gone on GitHub, `git branch -a` still lists it
// locally, and the checkout keeps sitting on disk. Multiply that by every
// repo this account touches and `git worktree list` stops being useful for
// telling live work from debris. This hook clears the debris automatically,
// on the same terms a careful person would apply by hand: only when a PR
// actually merged that branch, only when nothing unpushed or uncommitted
// would be lost, and only when nothing is plausibly still using it.
//
// What "merged" means here. A worktree is removed only when its branch tip
// is equal to or an ancestor of a merged PR's `headRefOid` (covering squash
// merges, where the branch tip itself never appears in the base branch's
// history) AND `origin/<branch>` — if it still exists after a prune fetch —
// has not moved past that same head. The second half exists because this
// account has merged PRs whose head branch, e.g. `TST`, is also a
// long-lived deploy branch that keeps getting pushed to after the PR that
// named it merged; without it, a live branch would look "done" forever.
//
// What is never touched regardless of the above: the main worktree, the
// worktree the calling session is running in (picked by the LONGEST path
// match, so a worktree nested inside the main checkout is not shadowed by
// it), a locked worktree, a detached-HEAD worktree, anything with an
// untracked file or a change to a file other than the root-level CLAUDE.md /
// AGENTS.md / .gitignore, a worktree some process still has as its cwd (or
// where that cannot be verified at all), and a worktree with a Claude
// transcript touched in the last 24h. Never throw, never exit non-zero — a
// SessionStart hook that fails blocks the session from starting, and a hook
// that deletes work on a guess is worse than a hook that does nothing.
//
// A worktree whose removal actually fails (a read-only file, something still
// holding a lock) is reported, never silently retried and never treated as
// removed — its branch stays too. And the whole run carries a time budget,
// counted from process start: past it, no new removal starts, so one slow
// repo cannot eat the hook's own SessionStart timeout and get killed
// mid-delete.
//
// Set CLAUDE_NO_WORKTREE_SWEEP=1 to disable.
//
// Manual use. Both ignore the one-hour throttle, and both fetch origin
// first, because the merged/ahead verdict depends on an up-to-date view of
// it — --dry-run fetches too, it just never removes a worktree or deletes a
// branch:
//   node hooks/worktree-sweep.cjs --dry-run [--repo <path>]   # plan only, still fetches
//   node hooks/worktree-sweep.cjs --repo <path>                # sweeps for real
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const quit = () => process.exit(0);

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state', 'worktree-sweep');
const BACKUPS_DIR = path.join(STATE_DIR, 'backups');
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');

const GH_BIN = process.env.CLAUDE_WORKTREE_SWEEP_GH || 'gh';
const LSOF_BIN = process.env.CLAUDE_WORKTREE_SWEEP_LSOF || 'lsof';

const DEFAULT_KEEP = ['main', 'master', 'develop', 'TST', 'ACC'];
const EXTRA_KEEP = (process.env.CLAUDE_WORKTREE_SWEEP_KEEP || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Root-level files each worktree gets its own copy of on purpose (per-person
// agent instructions), so a modification to only these does not count as
// "dirty" for keep/remove purposes — everything else does.
const ALLOWED_DIRTY_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.gitignore']);

// Root-level files worth rescuing from a worktree about to be deleted even
// though they are (correctly) gitignored: local secrets and local databases
// nobody wants to regenerate from scratch. Root only, not recursive — a
// nested .env inside some vendored dependency is not this account's file to
// go copying around.
const VALUABLE_FILE_PATTERNS = [/^\.env(\..+)?$/, /\.(?:db|sqlite|sqlite3)$/i];

const THROTTLE_MS = 60 * 60 * 1000;
const TRANSCRIPT_RECENT_MS = 24 * 60 * 60 * 1000;
// Keeps the whole run comfortably inside the hook's own 30s SessionStart
// timeout: up to ~10s to fetch, up to ~10s to ask gh, up to ~5s to ask lsof --
// 25s of setup that can happen before a single removal is even attempted.
// That is why TIME_BUDGET_MS below is measured from PROCESS_START, not from
// the moment applyPlan begins: measuring it from "when removals start" would
// let fetch+gh+lsof alone burn past 20s and then still open a FRESH 20s
// window on top, well past the 30s the harness allows before it kills the
// process outright — skipping whatever git call was mid-flight, including a
// branch delete for a worktree already gone.
const FETCH_TIMEOUT_MS = 10000;
const GH_TIMEOUT_MS = 10000;
// How long the whole run — from process start, not from the first removal —
// may spend before no new removal is allowed to begin. A non-finite or
// negative override is ignored rather than trusted: a hook is not the place
// to let a malformed env var either wedge the budget open forever (NaN,
// Infinity) or slam it shut before evaluation even finishes (a negative
// number). Overridable down to 0 so tests can force it to expire
// immediately rather than waiting out 20 real seconds.
function parseTimeBudgetMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const TIME_BUDGET_MS = parseTimeBudgetMs(process.env.CLAUDE_WORKTREE_SWEEP_TIME_BUDGET_MS, 20000);
// Measured once, at load — everything TIME_BUDGET_MS gates is relative to
// this, not to whenever applyPlan happens to actually begin.
const PROCESS_START = Date.now();

function git(args, cwd, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, ...opts });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function firstStderrLine(stderr) {
  return ((stderr || '').split('\n').find((l) => l.trim()) || 'unknown error').trim();
}

// --- repo identification ----------------------------------------------------

function isGitRepo(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

// The shared .git of every worktree of this repo — identical whether asked
// from the main checkout or any linked worktree. Used both as the throttle
// key and to find the main checkout's own path.
function gitCommonDir(cwd) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return r.ok ? r.stdout.trim() : null;
}

function repoRootFromCommonDir(commonDir) {
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
}

function hasOrigin(cwd) {
  const r = git(['remote', 'get-url', 'origin'], cwd);
  return r.ok && r.stdout.trim().length > 0;
}

// The repo name alone collides across two different checkouts that happen to
// share a basename (two different clones both named the same thing in
// different places); the shared .git path does not, so backups for this
// repo — and only this repo — land under one key.
function repoBackupKey(repoName, commonDir) {
  const hash = crypto.createHash('sha256').update(commonDir).digest('hex').slice(0, 8);
  return `${repoName}-${hash}`;
}

// --- throttle ----------------------------------------------------------------

function stampFile(commonDir) {
  const key = crypto.createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, `${key}.json`);
}

function throttled(commonDir) {
  try {
    return (Date.now() - fs.statSync(stampFile(commonDir)).mtimeMs) < THROTTLE_MS;
  } catch {
    return false;
  }
}

function writeStamp(commonDir) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stampFile(commonDir), JSON.stringify({ at: new Date().toISOString() }));
}

// --- GitHub ------------------------------------------------------------------

// Null means "could not ask" (gh missing, not logged in, network down) —
// callers must treat that as "do nothing", not as "no PRs".
function mergedPRs(cwd) {
  const r = spawnSync(GH_BIN, ['pr', 'list', '--state', 'merged', '--limit', '300',
    '--json', 'number,headRefName,headRefOid'], { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout || '[]'); } catch { return null; }
}

// --- worktree porcelain -------------------------------------------------------

function parseWorktrees(porcelain) {
  return porcelain.split(/\n\n+/).map((s) => s.trim()).filter(Boolean).map((block) => {
    const wt = { path: null, head: null, branch: null, detached: false, locked: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) wt.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        wt.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line === 'detached') wt.detached = true;
      else if (line.startsWith('locked')) wt.locked = true;
    }
    return wt;
  });
}

// --- eligibility checks (a, b, c) --------------------------------------------

function objectExistsLocally(repoRoot, sha) {
  return git(['cat-file', '-e', `${sha}^{commit}`], repoRoot).ok;
}

// True when `a` is `b`, or an ancestor of it — `--is-ancestor` is reflexive,
// so one call covers both.
function isAncestorOrEqual(repoRoot, a, b) {
  return git(['merge-base', '--is-ancestor', a, b], repoRoot).ok;
}

function originBranchSha(repoRoot, branch) {
  const r = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoRoot);
  return r.ok ? r.stdout.trim() : null;
}

// Checks (a) a merged PR whose head the branch tip has reached, (b) that
// origin/<branch> — if it still exists — has not moved past that same PR
// head, and (c) the branch is neither the repo's default branch nor in the
// protected list. Returns { ok, reason, pr } — `pr` is the qualifying PR
// when ok, used later for reporting and for the origin check.
function eligibility(branch, tipSha, { repoRoot, prsByBranch, keepNames }) {
  if (!branch) return { ok: false, reason: 'detached HEAD' };
  if (keepNames.has(branch)) return { ok: false, reason: `${branch} is a protected branch` };
  const candidates = prsByBranch.get(branch) || [];
  if (!candidates.length) return { ok: false, reason: 'no merged PR found for this branch' };
  let pr = null;
  for (const candidate of candidates) {
    if (!objectExistsLocally(repoRoot, candidate.headRefOid)) continue;
    if (isAncestorOrEqual(repoRoot, tipSha, candidate.headRefOid)) { pr = candidate; break; }
  }
  if (!pr) {
    return {
      ok: false,
      reason: 'a merged PR exists for this branch, but its head is not an ancestor of '
        + 'the local branch tip (or the PR head is not present locally)',
    };
  }
  const originSha = originBranchSha(repoRoot, branch);
  if (originSha && !isAncestorOrEqual(repoRoot, originSha, pr.headRefOid)) {
    return {
      ok: false,
      reason: `origin/${branch} has moved past the merged PR #${pr.number} head — `
        + 'a live branch that keeps being pushed to, not leftover work',
    };
  }
  return { ok: true, pr };
}

// --- checks d, e, f -----------------------------------------------------------

// `git status --porcelain` short codes are two characters (index, worktree).
// Only an unstaged modification (' M' or 'M ') to one of the three allowed
// root-level files may be present; anything else — untracked, staged,
// renamed, or a modification to any other file — means keep.
//
// `--untracked-files=all` and `--ignore-submodules=none` pin the two flags
// that a repo-level `status.showUntrackedFiles=no` (or a submodule ignore
// setting) would otherwise change out from under this check: an operator's
// own git config must never be able to hide a file this hook needs to see.
function statusAllowed(worktreePath) {
  const r = git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], worktreePath);
  if (!r.ok) return { allowed: false, dirty: false, reason: 'git status failed in the worktree' };
  const lines = r.stdout.split('\n').filter(Boolean);
  if (!lines.length) return { allowed: true, dirty: false };
  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    const isAllowedEdit = (code === ' M' || code === 'M ') && ALLOWED_DIRTY_FILES.has(file);
    if (!isAllowedEdit) {
      return { allowed: false, dirty: false, reason: `working tree not clean (${code.trim() || code} ${file})` };
    }
  }
  return { allowed: true, dirty: true };
}

// Runs `lsof -a -d cwd -Fn` once per sweep (its output is system-wide, not
// per-worktree) and returns the list of cwd paths reported, or null when
// lsof could not answer at all — either a spawn failure (missing binary) or
// a non-zero exit. A non-zero exit is not treated as "ran fine, no matches":
// some lsof builds exit non-zero on a permissions problem or an unsupported
// filter, not only when there is genuinely nothing to report, so "could not
// ask" must never read as "asked, and the answer is no".
function processCwds() {
  const r = spawnSync(LSOF_BIN, ['-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  const names = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('n')) names.push(line.slice(1));
  }
  return names;
}

// lsof unavailable is treated as "yes, something is there" — fail safe, per
// the same reasoning as everything else in this file: a false negative here
// deletes a worktree someone is actively working in.
function hasProcessInside(worktreePath, cwds) {
  if (cwds === null) return true;
  const norm = path.resolve(worktreePath);
  return cwds.some((p) => {
    const rp = path.resolve(p);
    return rp === norm || rp.startsWith(norm + path.sep);
  });
}

// Every non-alphanumeric character becomes '-'. This matches exactly how
// Claude Code names a project's transcript directory under
// ~/.claude/projects — e.g. a path ending in `Clients/De Bruin` becomes
// `...-Clients-De-Bruin` — and doubles below as a safe, collision-
// resistant name for a worktree's own backup subdirectory.
function slugify(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Claude Code truncates a project directory name once its slug passes 200
// characters, writing `slug.slice(0, 200) + '-' + <hash>` instead of the
// full slug — we cannot reproduce that hash, so for a long slug the only
// thing left to match on is the 200-character prefix it shares with the
// real, truncated directory. Over-matching here is the same acceptable
// trade as everywhere else in this file: it only prevents a deletion.
//
// win32 filesystems are case-insensitive, so a name and a slug that differ
// only in case are the same directory there and must compare equal;
// elsewhere they are two different names.
const CLAUDE_SLUG_TRUNCATE_AT = 200;
function matchesProjectDirName(name, slug) {
  const ci = process.platform === 'win32';
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsWith = (a, prefix) => (ci ? a.toLowerCase().startsWith(prefix.toLowerCase()) : a.startsWith(prefix));
  if (eq(name, slug) || startsWith(name, `${slug}-`)) return true;
  if (slug.length > CLAUDE_SLUG_TRUNCATE_AT) {
    return startsWith(name, `${slug.slice(0, CLAUDE_SLUG_TRUNCATE_AT)}-`);
  }
  return false;
}

// A session opened in a SUBDIRECTORY of the worktree gets its own transcript
// directory, named by slugifying that deeper path — e.g. a session opened in
// <repo>/backend gets .../projects/<slug(repo)>-backend, not
// .../projects/<slug(repo)>. So this keeps on any project directory whose
// name either equals the worktree's own slug or starts with "<slug>-", not
// only an exact match. Over-keeping — a directory that merely shares the
// prefix by coincidence — is acceptable: it only prevents a deletion, it
// never causes one.
function recentTranscript(worktreePath) {
  const slug = slugify(path.resolve(worktreePath));
  let names;
  try { names = fs.readdirSync(PROJECTS_DIR); } catch { return false; }
  const cutoff = Date.now() - TRANSCRIPT_RECENT_MS;
  for (const name of names) {
    if (!matchesProjectDirName(name, slug)) continue;
    let files;
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      try {
        if (fs.statSync(path.join(PROJECTS_DIR, name, f)).mtimeMs >= cutoff) return true;
      } catch { /* file vanished mid-scan */ }
    }
  }
  return false;
}

// --- the sweep itself ----------------------------------------------------------

// Evaluates a repository without changing anything on disk. Returns either
// { skip: <reason> } or a full plan: which worktrees to remove, which to
// keep (and why), and which branchless local branches to delete.
function evaluateRepo(cwd) {
  if (!isGitRepo(cwd)) return { skip: 'not inside a git repository' };
  const commonDir = gitCommonDir(cwd);
  if (!commonDir) return { skip: 'could not resolve the shared .git directory' };
  if (!hasOrigin(cwd)) return { skip: 'no origin remote configured' };

  const repoRoot = repoRootFromCommonDir(commonDir);
  const repoName = path.basename(repoRoot);

  // Best effort: a stale prune list is safer than blocking the sweep on a
  // slow or unreachable network.
  spawnSync('git', ['fetch', '--prune', 'origin'], { cwd: repoRoot, encoding: 'utf8', timeout: FETCH_TIMEOUT_MS });

  const prs = mergedPRs(repoRoot);
  if (prs === null) return { skip: 'gh is missing, not authenticated, or failed' };

  const wtListing = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!wtListing.ok) return { skip: 'git worktree list failed' };
  const worktrees = parseWorktrees(wtListing.stdout);
  if (!worktrees.length) return { skip: 'no worktrees found' };
  const main = worktrees[0]; // `git worktree list` always lists the main worktree first.

  // `git worktree list` reports each path already resolved through symlinks
  // (e.g. macOS's /var -> /private/var), so the session's cwd has to be
  // resolved the same way before comparing — otherwise the session's own
  // worktree fails to match itself and becomes eligible for removal. Falls
  // back to a plain resolve when the path cannot be stat'd (a cwd that no
  // longer exists), since realpath throws in that case.
  //
  // The match is by the LONGEST matching path prefix, not the first one
  // found: `git worktree list` always lists the main worktree first, so for
  // a worktree nested inside the main checkout's own directory tree (e.g.
  // <repo>/.claude/worktrees/feat) the main worktree's path is ALSO a prefix
  // of cwd — a first-match would credit ownership to main and leave the
  // actual, nested worktree eligible for removal out from under the session
  // running in it.
  let cwdAbs;
  try { cwdAbs = fs.realpathSync(cwd); } catch { cwdAbs = path.resolve(cwd); }
  let own = main;
  let ownMatchLen = -1;
  for (const w of worktrees) {
    const wp = path.resolve(w.path);
    const matches = cwdAbs === wp || cwdAbs.startsWith(wp + path.sep);
    if (matches && wp.length > ownMatchLen) { own = w; ownMatchLen = wp.length; }
  }

  const defBranchRef = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
  const defaultBranch = defBranchRef.ok
    ? defBranchRef.stdout.trim().replace(/^origin\//, '') : null;
  const keepNames = new Set([...DEFAULT_KEEP, ...EXTRA_KEEP]);
  if (defaultBranch) keepNames.add(defaultBranch);

  const currentBranchHere = (() => {
    const r = git(['symbolic-ref', '--short', 'HEAD'], cwd);
    return r.ok ? r.stdout.trim() : null;
  })();

  const prsByBranch = new Map();
  for (const pr of prs) {
    if (!prsByBranch.has(pr.headRefName)) prsByBranch.set(pr.headRefName, []);
    prsByBranch.get(pr.headRefName).push(pr);
  }
  const ctx = { repoRoot, prsByBranch, keepNames };

  const entries = [];
  let cwds; // lazily fetched: no point spawning lsof if nothing else qualifies

  for (const wt of worktrees) {
    if (wt === main) { entries.push({ wt, verdict: 'skip', notable: false, reason: 'main worktree' }); continue; }
    if (wt === own) { entries.push({ wt, verdict: 'skip', notable: false, reason: "the session's own worktree" }); continue; }
    if (wt.locked) { entries.push({ wt, verdict: 'skip', notable: false, reason: 'locked' }); continue; }
    if (wt.detached) { entries.push({ wt, verdict: 'skip', notable: false, reason: 'detached HEAD' }); continue; }

    const e = eligibility(wt.branch, wt.head, ctx);
    if (!e.ok) { entries.push({ wt, verdict: 'keep', notable: false, reason: e.reason }); continue; }

    const st = statusAllowed(wt.path);
    if (!st.allowed) { entries.push({ wt, verdict: 'keep', notable: true, reason: st.reason, pr: e.pr }); continue; }

    if (cwds === undefined) cwds = processCwds();
    if (hasProcessInside(wt.path, cwds)) {
      const reason = cwds === null
        ? 'lsof could not be run, so a process cwd there cannot be ruled out'
        : 'a process has its cwd inside this worktree';
      entries.push({ wt, verdict: 'keep', notable: true, reason, pr: e.pr });
      continue;
    }

    if (recentTranscript(wt.path)) {
      entries.push({ wt, verdict: 'keep', notable: true, reason: 'a Claude transcript for this worktree was modified in the last 24h', pr: e.pr });
      continue;
    }

    entries.push({ wt, verdict: 'remove', notable: true, reason: `PR #${e.pr.number} merged`, pr: e.pr, dirty: st.dirty });
  }

  // Branch-only deletion: local branches attached to no worktree.
  const worktreeBranches = new Set(worktrees.filter((w) => w.branch).map((w) => w.branch));
  const branchList = git(['for-each-ref', 'refs/heads/', '--format=%(refname:short) %(objectname)'], repoRoot);
  const orphanBranches = [];
  if (branchList.ok) {
    for (const line of branchList.stdout.split('\n').filter(Boolean)) {
      const sp = line.indexOf(' ');
      const branch = line.slice(0, sp);
      const sha = line.slice(sp + 1);
      if (worktreeBranches.has(branch) || branch === currentBranchHere) continue;
      const e = eligibility(branch, sha, ctx);
      if (e.ok) orphanBranches.push({ branch, sha, pr: e.pr });
    }
  }

  return { skip: null, repoRoot, repoName, commonDir, entries, orphanBranches };
}

// Copies root-level, gitignored-but-valuable files (`.env*`, `*.db`,
// `*.sqlite`, `*.sqlite3`) out of a worktree before it is deleted. Root only,
// not recursive — a nested .env inside some vendored dependency is not this
// account's file to go copying around. Creates `destDir` lazily, only if
// there is actually something to copy, so a worktree with none leaves no
// empty directory behind.
//
// Throws on any failure (a blocked destination, a copy that fails partway)
// rather than swallowing it: a backup that silently did not happen must
// never be followed by the removal it was meant to protect against. The
// caller is responsible for catching this and keeping the worktree instead.
function backupValuableFiles(worktreePath, destDir) {
  let names;
  try { names = fs.readdirSync(worktreePath); } catch { return []; }
  const toCopy = names.filter((name) => {
    if (!VALUABLE_FILE_PATTERNS.some((re) => re.test(name))) return false;
    try { return fs.statSync(path.join(worktreePath, name)).isFile(); } catch { return false; }
  });
  if (!toCopy.length) return [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of toCopy) {
    fs.copyFileSync(path.join(worktreePath, name), path.join(destDir, name));
  }
  return toCopy;
}

// Where a worktree's own patch/valuable-file backup goes for this sweep.
// Never overwrites an existing backup directory from an earlier sweep run
// the same day: if `<slug>` is already a directory, `<slug>-2`, `<slug>-3`,
// ... is used instead. A path that exists but is NOT a directory (something
// unexpectedly blocking the way) is returned as-is rather than stepped
// around — that is backupValuableFiles'/the diff write's failure to raise,
// which is what turns this removal into a kept-instead-of-removed one.
function uniqueBackupSubdir(backupDir, slug) {
  let candidate = path.join(backupDir, slug);
  let n = 2;
  for (;;) {
    let stat;
    try { stat = fs.statSync(candidate); } catch { return candidate; }
    if (!stat.isDirectory()) return candidate;
    candidate = path.join(backupDir, `${slug}-${n}`);
    n += 1;
  }
}

// Performs the removals `evaluateRepo` planned. Never called for --dry-run.
//
// Writes the throttle stamp as its very first action, before touching
// anything else: the hook's own SessionStart timeout can kill this process
// mid-removal, and a stamp written only at the end would leave a killed
// sweep free to restart the same slow work again next session instead of
// waiting out the hour.
//
// Returns { backupDir, removedOk, failures, backupFailures, timedOut }.
// `removedOk` holds the plan entries (worktrees) and orphan-branch records
// that were actually removed — never inferred from the plan, since a
// removal can fail or the time budget can cut the run short partway
// through. `backupFailures` holds entries kept because the backup meant to
// protect their removal could not be written — distinct from `failures`
// (an attempted `git worktree remove` that itself failed), since here
// removal was never even attempted.
function applyPlan(plan) {
  writeStamp(plan.commonDir);

  const toRemove = plan.entries.filter((e) => e.verdict === 'remove');
  const result = { backupDir: null, removedOk: [], failures: [], backupFailures: [], timedOut: false };
  if (!toRemove.length && !plan.orphanBranches.length) return result;

  const repoKey = repoBackupKey(plan.repoName, plan.commonDir);
  const backupDir = path.join(BACKUPS_DIR, repoKey, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(backupDir, { recursive: true });
  result.backupDir = backupDir;
  const tipsFile = path.join(backupDir, 'branch-tips.txt');

  const timeUp = () => (Date.now() - PROCESS_START) >= TIME_BUDGET_MS;

  for (const e of toRemove) {
    if (timeUp()) { result.timedOut = true; break; }

    // Named by the full worktree path, not its basename: two worktrees in
    // different repos (or even the same repo, after a rename) can share a
    // basename, and a flat `<basename>.patch` would silently overwrite one
    // backup with another's. Deduped against an earlier sweep's backup from
    // today rather than overwriting it.
    const wtBackupDir = uniqueBackupSubdir(backupDir, slugify(e.wt.path));
    try {
      if (e.dirty) {
        fs.mkdirSync(wtBackupDir, { recursive: true });
        const diff = git(['diff', 'HEAD'], e.wt.path);
        fs.writeFileSync(path.join(wtBackupDir, 'diff.patch'), diff.stdout);
      }
      backupValuableFiles(e.wt.path, wtBackupDir);
    } catch {
      // The backup that was meant to protect this removal did not happen --
      // never proceed to delete the worktree anyway. A worktree kept for
      // this reason is not retried automatically; whatever is blocking the
      // backup destination (see uniqueBackupSubdir) needs a human look.
      result.backupFailures.push({ wt: e.wt });
      continue;
    }

    const rmArgs = ['worktree', 'remove', ...(e.dirty ? ['--force'] : []), e.wt.path];
    const rmResult = git(rmArgs, plan.repoRoot);
    if (!rmResult.ok) {
      // The worktree removal failed — never delete its branch, and never
      // record it as removed. A failed removal is reported, not retried and
      // not treated as done; retrying blind next session is exactly the
      // throttle this file exists to avoid, and the branch is the only
      // remaining pointer to that work if the worktree itself is later
      // fixed up by hand.
      result.failures.push({ wt: e.wt, reason: firstStderrLine(rmResult.stderr) });
      continue;
    }
    fs.appendFileSync(tipsFile, `${e.wt.path} ${e.wt.branch} ${e.wt.head}\n`);
    git(['branch', '-D', e.wt.branch], plan.repoRoot);
    result.removedOk.push(e);
  }

  if (!result.timedOut) {
    for (const b of plan.orphanBranches) {
      if (timeUp()) { result.timedOut = true; break; }
      fs.appendFileSync(tipsFile, `(no worktree) ${b.branch} ${b.sha}\n`);
      const brResult = git(['branch', '-D', b.branch], plan.repoRoot);
      if (!brResult.ok) {
        result.failures.push({ wt: { path: null, branch: b.branch }, reason: firstStderrLine(brResult.stderr) });
        continue;
      }
      result.removedOk.push({ orphanBranch: b });
    }
  }

  if (result.removedOk.some((r) => !r.orphanBranch)) git(['worktree', 'prune'], plan.repoRoot);
  return result;
}

// --- reporting -----------------------------------------------------------------

function worktreeLabel(wt) { return wt.path ? path.basename(wt.path) : wt.branch; }

// Factual, third-person description of what happened — SessionStart context
// framed as an instruction trips prompt-injection defences, the same reason
// repo-setup.cjs avoids it.
//
// Always prefixed "Worktree sweep:", even when the only thing to report is a
// failure and nothing was actually removed — a bare "failed to remove ..."
// with no lead-in reads like an unrelated error, not a report from this
// hook.
function hookMessage(plan, applied) {
  const removedWts = applied.removedOk.filter((r) => !r.orphanBranch);
  const removedBranches = applied.removedOk.filter((r) => r.orphanBranch).map((r) => r.orphanBranch);
  const notableKeeps = plan.entries.filter((e) => e.verdict === 'keep' && e.notable);
  const nothingHappened = !removedWts.length && !removedBranches.length && !notableKeeps.length
    && !applied.backupFailures.length && !applied.failures.length && !applied.timedOut;
  if (nothingHappened) return null;

  const segments = [];
  if (removedWts.length) {
    segments.push(`removed ${removedWts.map((e) => `${worktreeLabel(e.wt)} (${e.wt.branch}, PR #${e.pr.number} merged)`).join(', ')}`);
  }
  if (removedBranches.length) {
    segments.push(`deleted branch ${removedBranches.map((b) => `${b.branch} (PR #${b.pr.number} merged)`).join(', ')}`);
  }
  if (notableKeeps.length) {
    segments.push(`Kept ${notableKeeps.map((e) => `${worktreeLabel(e.wt)}: PR merged but ${e.reason}`).join('; ')}`);
  }
  if (applied.backupFailures.length) {
    segments.push(applied.backupFailures.map((f) => `kept ${worktreeLabel(f.wt)}: backup failed`).join('; '));
  }
  if (applied.failures.length) {
    segments.push(applied.failures.map((f) => `failed to remove ${worktreeLabel(f.wt)}: ${f.reason}`).join('; '));
  }
  if (applied.timedOut) segments.push('stopped early (time budget)');

  let msg = `Worktree sweep: ${segments.join('; ')}.`;
  if (applied.backupDir) msg += ` Backups: ${applied.backupDir}`;
  return msg;
}

function emitHookOutput(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    suppressOutput: true,
  }));
}

// Plain-text plan for the CLI, listing every worktree and branch considered
// (not just the notable ones — a human reading a repo full of stale
// worktrees wants the full picture, not the terse hook summary).
function renderPlan(plan, { dryRun }) {
  const verb = dryRun ? 'WOULD REMOVE' : 'REMOVED';
  const dverb = dryRun ? 'WOULD DELETE' : 'DELETED';
  const lines = [];
  lines.push(`Worktree sweep${dryRun ? ' (dry run)' : ''} for ${plan.repoName} (${plan.repoRoot}):`);
  for (const e of plan.entries) {
    if (e.verdict === 'remove') {
      lines.push(`  ${verb.padEnd(12)} ${worktreeLabel(e.wt)} (${e.wt.branch}) -- ${e.reason}`);
    } else {
      lines.push(`  KEEP         ${worktreeLabel(e.wt)}${e.wt.branch ? ` (${e.wt.branch})` : ''} -- ${e.reason}`);
    }
  }
  if (plan.orphanBranches.length) {
    lines.push('Branches with no worktree:');
    for (const b of plan.orphanBranches) {
      lines.push(`  ${dverb.padEnd(12)} ${b.branch} -- PR #${b.pr.number} merged`);
    }
  }
  return lines.join('\n') + '\n';
}

// --- entry points ----------------------------------------------------------------

function runCli({ repoPath, dryRun }) {
  const cwd = repoPath || process.cwd();
  const plan = evaluateRepo(cwd);
  if (plan.skip) {
    process.stdout.write(`Worktree sweep: skipped (${plan.skip}).\n`);
    quit();
  }
  process.stdout.write(renderPlan(plan, { dryRun }));
  if (dryRun) {
    // Honest about the one side effect a "plan only" run still has: the
    // verdicts above depend on an up-to-date origin, so this fetched it —
    // it did not, and will not, remove a worktree or delete a branch.
    process.stdout.write('dry run: fetched origin; no worktrees or branches changed.\n');
    quit();
  }
  const applied = applyPlan(plan);
  for (const f of applied.backupFailures) {
    process.stdout.write(`  KEPT         ${worktreeLabel(f.wt)}${f.wt.branch ? ` (${f.wt.branch})` : ''} -- backup failed\n`);
  }
  for (const f of applied.failures) {
    process.stdout.write(`  FAILED       ${worktreeLabel(f.wt)}${f.wt.branch ? ` (${f.wt.branch})` : ''} -- failed to remove: ${f.reason}\n`);
  }
  if (applied.timedOut) process.stdout.write('stopped early (time budget)\n');
  if (applied.backupDir) process.stdout.write(`Backups: ${applied.backupDir}\n`);
  quit();
}

function runHook(cwd) {
  if (process.env.CLAUDE_NO_WORKTREE_SWEEP === '1') quit();
  if (!isGitRepo(cwd)) quit();
  const commonDir = gitCommonDir(cwd);
  if (!commonDir) quit();
  if (throttled(commonDir)) quit();

  const plan = evaluateRepo(cwd);
  if (plan.skip) quit(); // includes "no origin" and "gh failed" -- silent per spec

  const applied = applyPlan(plan);
  const message = hookMessage(plan, applied);
  if (message) emitHookOutput(message);
  quit();
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const repoIdx = argv.indexOf('--repo');
const repoArg = repoIdx >= 0 ? argv[repoIdx + 1] : null;

if (dryRun || repoArg !== null) {
  try {
    runCli({ repoPath: repoArg, dryRun });
  } catch {
    quit();
  }
} else {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      let input;
      try { input = JSON.parse(raw || '{}'); } catch { quit(); }
      const cwd = input?.cwd || process.cwd();
      runHook(cwd);
    } catch {
      quit();
    }
  });
}
