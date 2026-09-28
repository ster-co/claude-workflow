#!/usr/bin/env node
// PreToolUse gate on Bash `git commit`: a plan document may not be committed
// until a plan-auditor has audited it and found it CLEAN.
//
// Why this gate exists. /blueprint says "Nothing downstream re-examines the plan, so
// this is the one gate that has to hold" — and then nothing held it. Every
// verification mechanism in this setup (reviewer, verify-gate, commit-gate) sits
// downstream of implementation, grading work against the plan. None of them can
// notice that the plan itself asserted something false.
//
// Measured on the session that prompted this: of the factual claims made while
// planning, every claim carrying a file:line or command output was correct, and
// every claim sourced from memory or from generalising a rule was wrong. Four
// wrong claims, all in plan documents, all caught by the user rather than by any
// mechanism here.
//
// The marker records a hash of the plan at audit time, so editing a plan after
// auditing invalidates the audit. That is deliberate: the edit is exactly where
// a fresh false claim enters.
//
// Three verdicts, three behaviours:
//
//   CLEAN    allowed.
//   MINOR    allowed, and the open defects are named. A citation off by a line
//            is not a reason to keep a plan out of the repository.
//   DEFECTS  denied, UNLESS every blocking defect id the audit named is written
//            down in the plan under "## Known defects — accepted".
//
// The third path exists because of a measured failure on 2026-09-22: three audit
// rounds on one plan returned 13, then 9, then 10 defects, the tenth round's haul
// being one real CI-breaking bug and nine citations off by a line. The only exits
// were a clean audit or SKIP_CODE_GATES=1, so a plan that was 90% right and knew
// exactly what was wrong with it could only be perfected or bypassed. A recorded
// open defect is worth more than a bypassed one: the bypass leaves no trace in
// the plan, and the next reader inherits the false claim with nothing marking it.
//
// Set SKIP_CODE_GATES=1 to disable.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  gatesDisabled, executableShell, deny, readStdin, planBodyHash, acceptedIds,
  tokenize, SEPARATOR, gitAt, gitSubcommandIs, gitRunDirs,
} = require('./gate-lib.cjs');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state', 'plan-audited');

// The one direction fs.realpathSync alone cannot recover: a path already
// physically resolved (macOS's /private/var, say) has nothing left in it to
// tell a reader it used to be typed as /var. `TMP_ALIASES` records that one
// specific substitution once, at load time, from the platform's own tmpdir —
// the same directory every test in this repo (and Claude Code's own sandbox
// dirs, in practice) stages its throwaway repos under — so a marker recorded
// under the SESSION's original, un-resolved path can still be found from a
// candidate this gate only ever computes in physically-resolved form.
const TMP_ALIASES = (() => {
  const typed = os.tmpdir();
  let real;
  try { real = fs.realpathSync(typed); } catch { return []; }
  return real !== typed ? [[real, typed]] : [];
})();

function dealiasTmp(abs) {
  for (const [real, typed] of TMP_ALIASES) {
    if (abs === real || abs.startsWith(real + path.sep)) return typed + abs.slice(real.length);
  }
  return null;
}

const keyFor = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);

function allow() { process.exit(0); }

// Allowed, but with something the user should see. A gate that lets work through
// silently teaches nothing; a gate that denies over a typo gets switched off.
function allowWith(note) {
  process.stdout.write(JSON.stringify({ systemMessage: note }));
  process.exit(0);
}

/**
 * Does the marker still describe the file on disk?
 *
 * Content, not timestamp. The mtime was only ever a proxy for "the text changed",
 * and it answered wrongly in both directions: a `touch` re-locked an unchanged
 * plan, and — the reason this matters now — writing down a defect the audit
 * itself reported re-locked the plan on the acceptance path, making that path
 * impossible to walk. planBodyHash excludes the acknowledgement section for
 * exactly that reason; every other byte still invalidates.
 */
function auditIsFresh(abs, rec) {
  const hash = planBodyHash(abs);
  if (hash && rec.bodyHash) return hash === rec.bodyHash;
  // Markers written before bodyHash existed, and plans that can no longer be
  // read, fall back to the mtime rule they were written under.
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { return true; }
  if (rec.mtimeMs === null || rec.mtimeMs === undefined) return true;
  return Math.abs(mtimeMs - rec.mtimeMs) <= 1;
}

const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

// A plan document: markdown under any docs/plans/ directory. Deliberately narrow
// — this gate is not here to slow down ordinary documentation.
const isPlan = (p) => /(^|\/)docs\/plans\/.+\.md$/.test(p);

function stagedFiles(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd, encoding: 'utf8', timeout: 5000,
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// `git diff --cached --name-only` always prints paths relative to the repo's
// TOP LEVEL, regardless of which directory it was run from — resolving one of
// those against `cwd` itself, when `cwd` is a subdirectory a `cd` landed the
// commit in, joins a root-relative path onto the wrong base and looks up a
// path nothing ever audited. `willStage` below does not share this problem:
// its own paths are already built relative to `cwd`, not the repo root.
//
// BRIEF 12 (BRIEF 2 review, accepted open): this used to run `--show-toplevel`
// against `cwd` and then pop the same NUMBER of path segments off `cwd`'s own,
// un-dereferenced string — on the theory that the segment COUNT between `cwd`
// and the root it names is the same whichever of the two forms (typed or
// physically resolved) you count it in. That is only true when every
// component `cwd` and `top` disagree on is a plain directory: a single
// symlink component collapses an arbitrary number of REAL path components
// into one TYPED one, so a `cwd` reached through a symlink whose target sits
// two real levels below the repo root, but only one typed level below `cwd`
// itself, popped the wrong number of segments and landed on neither repo's
// actual root — occasionally on a directory in a completely different
// checkout, whose marker (or lack of one) then governed a plan it never
// described. Resolving `cwd` PHYSICALLY first, and running `--show-toplevel`
// from there, removes the segment-counting arithmetic (and the symlink it
// could go wrong on) entirely: both `top` and the directory it was run from
// are already in the same, dereferenced form, so the root IS that directory,
// literally, for however many segments the physical path actually has.
function repoRootFor(cwd) {
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch { realCwd = cwd; }
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: realCwd, encoding: 'utf8', timeout: 5000,
    }).trim();
    return top || realCwd;
  } catch { return realCwd; }
}

// Whether `dir` (one of gitRunDirs' candidates, always physically resolved)
// names the SAME directory as the session's own, never-realpath'd `cwd` —
// i.e. no `cd`/`-C` in the command moved the git invocation elsewhere. That
// is the one condition under which `cwd`'s own typed spelling is a valid
// lever for anything about `dir`: shared by typedRootFor below (recovering
// the repo root's typed form) and the `willStage` candidate (recovering
// `dir` itself's typed form) in the main handler.
function isSessionCwd(cwd, dir) {
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch { return false; }
  return realCwd === dir;
}

/**
 * The root in the SAME, un-dereferenced form the SESSION typed its cwd in —
 * used only to build an EXTRA marker-lookup candidate below, never to decide
 * which repo a staged file belongs to (that decision is `repoRootFor`'s
 * alone, precisely because this popping is unsound under an arbitrary
 * symlink — see repoRootFor's comment).
 *
 * `typedCwd` must be the SESSION's own, never-realpath'd cwd — gitRunDirs
 * (gate-lib.cjs) hands every candidate back physically resolved now, so `dir`
 * itself has no typed spelling left to recover anything from; only the
 * session's original string still has one. That is also why this only ever
 * produces a candidate when `dir` names the SAME directory as `typedCwd`
 * (no `cd`/`-C` moved the git invocation elsewhere): `typedCwd`'s ancestry is
 * a lever for `dir`'s root only when `dir` IS `typedCwd`, physically. A
 * `cd`/`-C` case has no typed lever to offer here at all, and none is
 * invented for it.
 *
 * Its one legitimate use is the shape that popping WAS always sound for: a
 * platform tmp dir that is itself a single symlink component (macOS's
 * /var -> /private/var, or /tmp -> /private/tmp) sitting ABOVE `typedCwd`
 * entirely, with nothing symlinked anywhere between `typedCwd` and the repo
 * root it names. There, `depth` (computed physically, so it is never wrong on
 * its own terms) and `typedCwd`'s own segment count agree exactly, and
 * popping `depth` segments off the typed `typedCwd` reaches the SAME
 * directory `physicalRoot` names, just spelled the way the session
 * originally typed it — which matters because an auditor dispatched against
 * that spelling wrote a `Plan:` footer in it, and plan-audit-record.cjs never
 * realpath's what it reads. When a symlink DOES sit between `typedCwd` and
 * the root (the shape repoRootFor's fix targets), this popping can land
 * anywhere, including nowhere that exists — harmless here, since it is only
 * ever tried as one candidate among several, never trusted on its own.
 */
function typedRootFor(typedCwd, dir, physicalRoot) {
  if (!isSessionCwd(typedCwd, dir)) return null;
  const depth = path.relative(physicalRoot, dir).split(path.sep).filter((s) => s && s !== '.').length;
  let root = typedCwd;
  for (let i = 0; i < depth; i++) root = path.dirname(root);
  // The popping above is sound ONLY when it lands back on the same physical
  // directory `repoRootFor` already found — true for a symlink sitting ABOVE
  // `typedCwd` entirely (a tmp dir's own /var -> /private/var), false for a
  // symlink collapsing several REAL levels into fewer TYPED ones anywhere
  // along the way (the exploit repoRootFor's own fix targets). Checking that
  // equivalence here, rather than trusting the arithmetic, is what stops this
  // function from quietly reintroducing the same vulnerable guess as a
  // second candidate.
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  return realRoot === physicalRoot ? root : null;
}

/**
 * A CLEAN or MINOR marker recorded for this exact plan text under ANY path.
 *
 * Markers are keyed by absolute path, and every lane works in its own
 * worktree: a plan audited and committed from one checkout arrives in another
 * through a merge, at a path no audit ever named. The hash is the same one
 * auditIsFresh compares, so "this text cleared an audit" is decided exactly as
 * strictly as before — only the path is no longer required to match. DEFECTS
 * is deliberately not honoured here: its acceptance path reads the plan's own
 * "Known defects — accepted" section against the marker's `at`, which is a
 * per-audit binding, not a property of the text.
 */
function contentMarker(abs) {
  const hash = planBodyHash(abs);
  if (!hash) return null;
  let names;
  try { names = fs.readdirSync(STATE_DIR); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch { continue; }
    if (rec && rec.bodyHash === hash && (rec.verdict === 'CLEAN' || rec.verdict === 'MINOR')) return rec;
  }
  return null;
}

const gitOut = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

/**
 * The blob id of the plan's working file, but only when that is unambiguously
 * what the commit will carry: the index already holds the same blob. Otherwise
 * null. A `git add <plan>` in the same command is deliberately NOT trusted to
 * close a gap between the two: `git add -n`, or an add skipped by `&&`/`||`,
 * would leave the index's unaudited text to be committed. Stage first, then
 * commit, and the two agree.
 *
 * Both fallbacks below judge ONE text, and a commit can carry either the index
 * or the working file: `git commit -a`, `git add -A`, `git add .` and a
 * directory pathspec all stage the working file in forms willStage cannot see,
 * while a plain `git commit` carries the index. Requiring the two to agree
 * means whichever form runs, the text judged is the text committed.
 */
function committedBlob(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const work = gitOut(root, ['hash-object', '--', rel]);
  if (!work) return null;
  return gitOut(root, ['rev-parse', '-q', '--verify', `:0:${rel}`]) === work ? work : null;
}

/**
 * Whether a merge is in progress in `root` and the plan at `abs` is going into
 * the commit byte-for-byte as it stands on one of the branches being merged in.
 *
 * Such a plan is already on that branch, where the landing that put it there
 * passed this gate (or skipped it deliberately with SKIP_CODE_GATES=1 — the
 * merged branch's own history is the record of that); re-auditing it on every
 * landing merge re-grades text nobody on this side wrote, and a lane
 * hard-stopped on exactly that. Any edit made while resolving the merge, staged
 * or not, changes a blob and falls back to the audit rule.
 */
function unchangedFromMergeHead(root, abs) {
  const mergeHeadPath = gitOut(root, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  if (!mergeHeadPath) return false;
  let heads;
  try {
    heads = fs.readFileSync(path.resolve(root, mergeHeadPath), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return false; }
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const blob = committedBlob(root, abs);
  if (!blob) return false;
  return heads.some((h) => gitOut(root, ['rev-parse', '-q', '--verify', `${h}:${rel}`]) === blob);
}

// Paths a `git add` / `git stage` in this same command would stage. Deliberately
// literal: a glob or a pathspec this cannot expand is left to the index check
// above, which sees it on the next attempt. Over-blocking a commit nobody asked
// about is worse than catching it one try later.
function willStage(shell, cwd) {
  const out = [];
  const tokens = tokenize(shell);
  for (let i = 0; i < tokens.length; i++) {
    const g = gitAt(tokens, i);
    if (!g || (g.sub !== 'add' && g.sub !== 'stage')) continue;
    // `git -C <dir> add foo` stages dir/foo, not cwd/foo.
    const base = g.dir ? path.resolve(cwd, g.dir) : cwd;
    for (let k = g.at + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (SEPARATOR.test(tok)) break;
      if (tok.startsWith('-')) continue;
      const abs = path.resolve(base, tok.replace(/^['"]|['"]$/g, ''));
      out.push(path.relative(cwd, abs));
    }
    i = g.at;
  }
  return out;
}

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const tool = input?.tool_name || '';
  // PowerShell is what Claude Code runs instead of Bash on Windows; the
  // command text lives in the same tool_input.command field either way.
  if (tool !== 'Bash' && tool !== 'PowerShell') return allow();

  const command = input?.tool_input?.command || '';
  const shell = executableShell(command);
  if (!gitSubcommandIs(shell, 'commit')) return allow();

  const cwd = input?.cwd || process.cwd();
  // The repo that matters is the one the `git commit` actually runs in, not
  // the session directory — a `cd`/`-C` in the same command changes it. When
  // that can't be pinned to one directory, every candidate is checked and a
  // plan staged in ANY of them counts (Decision 9). Found live 2026-09-22:
  // a run spent ~20 min auditing another run's plans to unblock a commit
  // that actually targeted a different repo, because this used to always
  // read the session's own directory. gitRunDirs gets the RAW command, not
  // `shell` — it needs to see whether a `cd`/`-C` argument was quoted in the
  // original, which executableShell's blanking pass has already erased.
  const dirs = gitRunDirs(command, cwd);

  // What the index holds NOW, plus what this command is about to put in it,
  // in each candidate repo. PreToolUse runs before the command, so `git add
  // plan.md && git commit` found an empty index and sailed through — the gate
  // only ever worked when staging happened in an earlier call, and the
  // compound form is the habitual one. Found live 2026-09-22 after the unit
  // tests had been green for hours.
  // Keyed on the PHYSICALLY resolved path (repoRootFor's root joined with the
  // root-relative `rel`) — the one form guaranteed to name the same file
  // `dir` actually sits in, however many symlink hops it took to get there.
  // Each entry also collects every OTHER path form worth trying a marker
  // lookup under, so one staged plan is one entry (one deny/allow decision),
  // not one per candidate spelling of its path.
  // `root` is the physical repo root the plan belongs to.
  const plans = new Map(); // absolute path -> { rel, extra: Set<absolute path>, root }
  const addPlan = (abs, rel, extra, root) => {
    if (!plans.has(abs)) plans.set(abs, { rel, extra: new Set(), root });
    if (extra && extra !== abs) plans.get(abs).extra.add(extra);
  };
  for (const dir of dirs) {
    // Two different bases for two different kinds of relative path: what git
    // itself reports as staged is root-relative; what willStage worked out
    // from the command's own `git add` arguments is already relative to
    // `dir`, because that is the base it resolved each argument against. A
    // candidate must always be an alternate SPELLING of the same absolute
    // file `rel` names against ITS OWN base — never `rel` re-joined onto a
    // different directory, which would simply name a different file
    // whenever that other directory isn't `rel`'s own base to begin with.
    const root = repoRootFor(dir);
    // `root`'s typed spelling, recovered via the session's own typed cwd —
    // only meaningful, and only offered, when `dir` IS that cwd (no
    // `cd`/`-C` moved the git invocation elsewhere).
    const typedRoot = typedRootFor(cwd, dir, root);
    // `dir`'s own typed spelling: the same lever, but naming `dir` itself
    // rather than the repo root — this is what willStage's own base (`dir`)
    // needs an alternate spelling FOR, since `rel` below is relative to
    // `dir`, not to `root`.
    const typedDir = isSessionCwd(cwd, dir) ? cwd : null;
    for (const rel of stagedFiles(dir)) {
      if (!isPlan(rel)) continue;
      addPlan(path.resolve(root, rel), rel, typedRoot ? path.resolve(typedRoot, rel) : null, root);
    }
    for (const rel of willStage(shell, dir)) {
      if (!isPlan(rel)) continue;
      addPlan(path.resolve(dir, rel), rel, typedDir ? path.resolve(typedDir, rel) : null, root);
    }
  }
  if (!plans.size) return allow();

  const problems = [];
  const carried = [];
  for (const [abs, { rel, extra, root }] of plans) {
    // A marker recorded under the auditor's own typed `Plan:` path (which
    // plan-audit-record.cjs only path.resolve's, never realpath's) can be
    // keyed under any of: this entry's canonical `abs`, the alternate
    // (naive-join / physical-root-join) form collected above, or either
    // form's own realpath — a platform tmp dir that is itself a symlink
    // (macOS's /var -> /private/var) means an auditor's plain, un-resolved
    // path and this gate's own computed path can disagree in EITHER
    // direction depending which one happened to run through the symlink.
    // Trying every form and trusting whichever is FRESH (not just present)
    // is what "look it up under both the resolved and the realpath form"
    // means when there can be more than two candidates in play.
    const candidates = new Set([abs, ...extra]);
    for (const c of [...candidates]) {
      try { candidates.add(fs.realpathSync(c)); } catch { /* plan may not exist yet (willStage) */ }
      const aliased = dealiasTmp(c);
      if (aliased) candidates.add(aliased);
    }
    let rec = null;
    let matched = null; // the exact candidate spelling `rec` was found and confirmed fresh under
    let staleRec = null; // a marker found but not fresh, for the "edited since" message
    for (const cand of candidates) {
      const marker = path.join(STATE_DIR, `${keyFor(cand)}.json`);
      let found = null;
      try { found = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { continue; }
      if (auditIsFresh(cand, found)) { rec = found; matched = cand; break; }
      staleRec = found;
    }

    // No fresh marker at this path. The two fallbacks only ever ALLOW, and
    // only here: a fresh marker at the plan's own path, whatever its verdict,
    // is still the one that decides.
    if (!rec) {
      // contentMarker hashes the working file, so it only speaks for the
      // commit when committedBlob says the working file is what gets committed.
      const byContent = committedBlob(root, abs) ? contentMarker(abs) : null;
      if (byContent) {
        if (byContent.verdict === 'MINOR') {
          const ids = (byContent.minor || []).join(', ') || 'unnamed';
          carried.push(`${rel} — same text audited MINOR at ${byContent.plan}; still open: ${ids}`);
        }
        continue;
      }
      if (unchangedFromMergeHead(root, abs)) {
        carried.push(`${rel} — unchanged from the branch being merged in`);
        continue;
      }
    }

    if (!rec) {
      // A stale marker under ANY form still means an audit ran and this is
      // the plan that edit invalidated, not a plan nobody ever looked at —
      // the same distinction auditIsFresh's own comment draws, just now
      // checked across every path form instead of one.
      //
      // The message lists every path form the lookup tried, each marked as
      // existing on disk or not, so an operator can compare them with the
      // `Plan:` path the audit recorded. When the command's shape leaves more
      // than one candidate directory, willStage resolves a relative `git add`
      // argument against each of them, so a path in a directory the command
      // never staged in can appear here. The message names no staging
      // command: the gate cannot tell which candidate directory the shell
      // uses, willStage cannot see a quoted `git add` argument, and gitRunDirs
      // does not follow a quoted `-C`.
      const checked = [...candidates]
        .map((c) => `${c} (${fs.existsSync(c) ? 'exists' : 'no such file'})`)
        .join(', ');
      problems.push(`${rel} — ${staleRec ? 'edited since its audit' : 'never audited'}; `
        + `checked: ${checked}`);
      continue;
    }

    if (rec.verdict === 'CLEAN') continue;

    if (rec.verdict === 'MINOR') {
      const ids = (rec.minor || []).join(', ') || 'unnamed';
      carried.push(`${rel} — audit found no blocking defect; still open: ${ids}`);
      continue;
    }

    if (rec.verdict === 'DEFECTS') {
      const blocking = rec.blocking || [];
      if (!blocking.length) {
        // Nothing to write down, so the acceptance path cannot be walked and
        // the only honest move is another audit.
        problems.push(`${rel} — last audit returned DEFECTS but named no blocking `
          + 'defect id, so there is nothing to fix or record. Re-run the audit.');
        continue;
      }
      // Read for `matched`, the exact spelling the fresh marker was found
      // under — not `abs`, this entry's canonical form, which can name a
      // file that reads differently (or not at all) from the one the audit
      // and its accepted-defects section actually describe.
      const accepted = acceptedIds(readText(matched), rec.at);
      const missing = blocking.filter((id) => !accepted.includes(id));
      if (missing.length) {
        problems.push(`${rel} — blocking defect${missing.length > 1 ? 's' : ''} `
          + `${missing.join(', ')} neither fixed nor recorded. To record one, write `
          + `"- ${missing[0]} (audit ${rec.at}): <why>" under "## Known defects — accepted"`);
      } else {
        carried.push(`${rel} — committed with ${blocking.length} accepted blocking `
          + `defect${blocking.length > 1 ? 's' : ''}: ${blocking.join(', ')}`);
      }
      continue;
    }

    problems.push(`${rel} — last audit returned ${rec.verdict}`);
  }
  if (!problems.length) {
    return carried.length ? allowWith(`Plan gate: ${carried.join('; ')}`) : allow();
  }

  deny(
    `Plan documents are staged that no audit clears:\n  ${problems.join('\n  ')}\n\n` +
    'A plan is the one artifact nothing downstream re-examines — briefs amplify it and ' +
    'implementers execute it, so a false claim in it gets built rather than caught. ' +
    'Run the plan-auditor over each file listed above:\n\n' +
    '  Agent(subagent_type: "plan-auditor", prompt: "Audit <abs path>. Current premises: ' +
    '<the architecture and decisions that hold today>.", run_in_background: false)\n\n' +
    'It must end with "## Audit Verdict / <CLEAN|MINOR|DEFECTS> / Blocking: … / Minor: … / ' +
    'Plan: <abs path>". MINOR passes on its own — citation drift does not hold a plan out ' +
    'of the repository.\n\n' +
    'For a BLOCKING defect you have decided not to fix here, record it in the plan and the ' +
    'gate will let it through:\n\n' +
    '  ## Known defects — accepted\n' +
    '  - D1 (audit <at>): <what is wrong, and why we are committing anyway>\n\n' +
    'Every blocking id the audit named must appear there, each stamped with the `at` of ' +
    'the audit that found it — the exact value is in the marker under ' +
    'state/plan-audited/, and is printed beside each plan above. That stamp is what ' +
    'stops an entry written for one round quietly accepting the next round\'s defect of ' +
    'the same number, since ids restart at D1 every audit. Editing anything else in the ' +
    'plan invalidates the audit by design — that edit is where a fresh false claim enters ' +
    '— but writing this section does not.\n\n' +
    'Set SKIP_CODE_GATES=1 only if you have decided this plan does not need auditing at all.',
  );
});
