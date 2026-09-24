#!/usr/bin/env node
// Durable run state for an orchestrated brief run — one file per run, keyed by repo.
//
// Runs live at ~/.claude/state/ship-runs/<repo-key>/<feature>.json, and the pointer
// saying which run THIS chat is driving lives at ~/.claude/state/ship-current/<session>.
// That split is the whole point: the run must survive compaction, /clear, a crash and a
// reboot, while "which run am I" must not outlive the chat that decided it.
//
// It used to be one <repo>/docs/.run-state.json per repository. That could hold exactly
// one feature, one phase and one set of counters, so two chats driving one checkout
// overwrote each other — and a bare `/ship`, which resumes without naming anything,
// picked up whichever run the file happened to hold. The in-repo location had no
// justification left either: the file is covered by a global gitignore and never
// committed, and a run executing in its own worktree wrote state into that worktree's
// docs/, invisible to the chat that started it.
//
// **A repo whose docs/.run-state.json still exists keeps using it.** A run in flight
// when this landed must not be migrated underneath itself, so the legacy file stays the
// source of truth for its own run until that run finishes. New runs go to the registry.
//
// Called as a script from /execute rather than hand-edited by the model mid-run: the
// counters are the loop's only bound, and a script cannot forget to bump one.
//
// Retry counters live here rather than in the conversation for a specific reason: an
// in-memory counter resets to zero every time a run is resumed, which silently unbounds
// the loop. On disk, a resumed run picks up the count it left at.
//
//   node run-state.cjs start --feature <name> [--brief-file docs/briefs.md]
//   node run-state.cjs phase <name> [--plan <path>]   # see PHASES below for the legal set
//   node run-state.cjs branch <name> [--base <branch>]  # records the run's work branch
//   node run-state.cjs begin-brief <n>            # resets counters only when n changes
//   node run-state.cjs review-round | debug-round
//   node run-state.cjs block <n> --reason <text>
//   node run-state.cjs finish-brief <n> [--commit <sha>]
//   node run-state.cjs finish                     # whole run done
//   node run-state.cjs get [--all] [--feature <name>]   # one run, or every run here
//   node run-state.cjs current [<feature>]        # read or set this chat's run
//   node run-state.cjs table                      # every run here, for /ship to show
//
// Every command takes an optional `--feature <name>` to address a run explicitly
// instead of through the pointer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REL = path.join('docs', '.run-state.json');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');
const RUNS_DIR = path.join(STATE_DIR, 'ship-runs');
const POINTER_DIR = path.join(STATE_DIR, 'ship-current');

// /ship is a single command run twice: it reads the phase and does whatever comes
// next. Only the values listed here are actionable, and an unknown one is rejected
// rather than written — a typo like "excuting" would leave /ship in a state no
// branch handles, which is the precise failure the phase exists to prevent.
// Ordered as a run passes through them. `awaiting-direction` is the earliest: a
// run waits there on which approach to take, before any plan document exists.
// It is also the second place /ship stops, so "first" and "second" both describe
// it truthfully -- hence "earliest", which only has one reading.
const PHASES = ['awaiting-direction', 'planning', 'awaiting-approval', 'executing', 'landing'];

// The repository, not the directory. `--git-common-dir` is the shared .git of every
// worktree, so a run started in the checkout is visible to the agent working in the
// worktree it spawned — and two unrelated repos never collide. Outside a repo we fall
// back to the directory itself, which at least keeps such runs from pooling together.
function repoKey(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf-8' });
  const dir = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : path.resolve(cwd);
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

const legacyPath = (cwd) => path.join(cwd, REL);
const runsDir = (cwd) => path.join(RUNS_DIR, repoKey(cwd));
// A feature name reaches the filesystem, so anything that could climb out of the
// directory is flattened rather than trusted.
const safe = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
const runPath = (cwd, feature) => path.join(runsDir(cwd), `${safe(feature)}.json`);
const pointerPath = (session = null) => {
  // A hook is handed its session on stdin; the CLI reads it from the environment.
  const sid = session || process.env.CLAUDE_CODE_SESSION_ID;
  return sid ? path.join(POINTER_DIR, `${safe(sid)}.json`) : null;
};

// Kept as an export for callers that only want the path of the legacy file.
function statePath(cwd) {
  return legacyPath(cwd);
}

// A corrupt state file must never wedge a later session: report the corruption and
// carry on with an empty object rather than throwing out of a hook.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return obj;
}

function blank() {
  return {
    feature: null,
    phase: null,
    planFile: null,
    // The branch the run's commits go on, and what it forked from. /ship always
    // creates one, so which branch you were standing on never matters and no
    // list of "protected" branch names is needed — such a list is a local
    // accident that fits exactly one repo.
    branch: null,
    baseBranch: null,
    briefFile: 'docs/briefs.md',
    currentBrief: null,
    attempt: 0,
    reviewRounds: 0,
    debugRounds: 0,
    blocked: [],
    startedAt: null,
    lastCommit: null,
    finishedAt: null,
  };
}

// Every field is defaulted on read. A half-written file from a killed process should
// degrade to sane values, not to undefined arithmetic.
function normalise(raw) {
  const s = blank();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of Object.keys(s)) {
    if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
  }
  if (!Array.isArray(s.blocked)) s.blocked = [];
  for (const k of ['attempt', 'reviewRounds', 'debugRounds']) {
    if (typeof s[k] !== 'number' || Number.isNaN(s[k])) s[k] = 0;
  }
  return s;
}

/**
 * Which run this invocation is about, and which file holds it.
 *
 * The order matters and is the part that stops a chat inheriting someone else's
 * work. An explicit `--feature` always wins. Otherwise the pointer decides, and
 * only if it names a run in THIS repository — a pointer left behind by a chat that
 * was working elsewhere resolves to nothing rather than to the wrong run. The
 * legacy file is consulted last, so a repo mid-migration keeps working.
 *
 * `kind: 'none'` is a real answer and callers must handle it: it is what a chat
 * with no pointer sees, and the reason /ship prints its table instead of guessing.
 */
function resolve(cwd, feature = null, session = null) {
  if (feature) {
    const file = runPath(cwd, feature);
    return { kind: 'registry', file, state: normalise(readJson(file)), feature };
  }

  const ptr = pointerPath(session) ? readJson(pointerPath(session)) : null;
  if (ptr && ptr.feature && ptr.repoKey === repoKey(cwd)) {
    const file = runPath(cwd, ptr.feature);
    if (fs.existsSync(file)) {
      return { kind: 'registry', file, state: normalise(readJson(file)), feature: ptr.feature };
    }
  }

  const legacy = legacyPath(cwd);
  if (fs.existsSync(legacy)) {
    const state = normalise(readJson(legacy));
    return { kind: 'legacy', file: legacy, state, feature: state.feature };
  }

  return { kind: 'none', file: null, state: blank(), feature: null };
}

// Writing back to wherever the run already lives. A legacy run keeps its file; a
// registry run keeps its own. Nothing is silently relocated mid-run.
function save(cwd, res, state) {
  const file = res.file || runPath(cwd, state.feature || 'unnamed');
  return writeJson(file, state);
}

function setPointer(cwd, feature, session = null) {
  const p = pointerPath(session);
  if (!p) return;                      // no session id: nothing to remember it by
  writeJson(p, { repoKey: repoKey(cwd), feature, at: new Date().toISOString() });
}

// Every run this repository knows about, registry and legacy alike, so /ship's table
// can show a run that predates the registry beside the ones that do not.
function listRuns(cwd) {
  const dir = runsDir(cwd);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { names = []; }
  const withFile = (file) => {
    const r = normalise(readJson(file));
    // When the run was last touched. Taken from the file rather than stored in it:
    // a field would need every writer to remember to update it, and the filesystem
    // already knows.
    try { r.updatedAt = fs.statSync(file).mtime.toISOString(); } catch { r.updatedAt = null; }
    return r;
  };
  for (const n of names) out.push(withFile(path.join(dir, n)));
  const legacy = legacyPath(cwd);
  if (fs.existsSync(legacy)) out.push(withFile(legacy));
  return out;
}

/**
 * What /ship prints when a chat has no pointer, and the only place a run's state is
 * shown rather than acted on.
 *
 * Everything git or GitHub can answer is derived HERE, per call, and never stored:
 * whether the branch still exists, whether there is a PR, how far behind its base a
 * run has drifted. Storing any of it would mean a second thing to keep true, and it
 * would be wrong the moment anyone used git outside /ship.
 *
 * Which also means every column is a subprocess that can fail — no network, no gh,
 * not logged in, a deleted branch. Each lookup degrades to a placeholder on its own;
 * none of them may take the table down, because this is what someone sees when they
 * are already lost.
 */
function probe(args, cwd) {
  try {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf-8', timeout: 5000 });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

const DASH = '—';

function ago(iso) {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return DASH;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const when = (iso) => {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function tableRows(cwd) {
  return listRuns(cwd).map((r, i) => {
    const branchLive = r.branch ? probe(['git', 'rev-parse', '--verify', '--quiet', r.branch], cwd) !== null : null;
    let pr = DASH;
    if (r.branch && branchLive) {
      const out = probe(['gh', 'pr', 'list', '--head', r.branch, '--state', 'all',
        '--json', 'number,state', '--limit', '1'], cwd);
      try {
        const [first] = out ? JSON.parse(out) : [];
        if (first) pr = `#${first.number} ${String(first.state).toLowerCase()}`;
      } catch { pr = DASH; }
    }
    let behind = DASH;
    if (r.branch && r.baseBranch && branchLive) {
      const n = probe(['git', 'rev-list', '--count', `${r.branch}..${r.baseBranch}`], cwd);
      if (n !== null) behind = n === '0' ? '-' : `${n} commits`;
    }
    return {
      '#': String(i + 1),
      feature: r.feature || DASH,
      phase: r.phase || DASH,
      brief: r.currentBrief === null || r.currentBrief === undefined ? DASH : String(r.currentBrief),
      branch: r.branch ? (branchLive ? r.branch : `${r.branch} (gone)`) : DASH,
      base: r.baseBranch || DASH,
      PR: pr,
      started: when(r.startedAt),
      'last activity': ago(r.updatedAt),
      behind,
    };
  });
}

function renderTable(rows) {
  if (!rows.length) return 'No ship runs in this repository yet. `/ship <idea>` starts one.\n';
  const cols = Object.keys(rows[0]);
  const w = {};
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (cells) => cols.map((c, i) => String(cells[i]).padEnd(w[c])).join('  ').trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n') + '\n';
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const cwd = process.cwd();
  const now = new Date().toISOString();
  const res = resolve(cwd, flag(rest, '--feature'));
  const s = res.state;

  switch (cmd) {
    case 'start': {
      // Deliberately does NOT refuse when other runs exist. That refusal was a
      // consequence of the single-file layout, not a rule worth keeping: starting a
      // second feature while a first is in flight is the case this exists to serve.
      const feature = flag(rest, '--feature', s.feature);
      // Validated here as well as in `phase`, and BEFORE anything is written.
      // /ship Start is the entry point that actually passes --phase, so a
      // whitelist enforced only in `phase` was bypassable one subcommand over:
      // a typo landed in the run file with a clean exit, leaving /ship in a
      // phase its table has no branch for. Rejecting after the write would
      // report the typo and persist it anyway, so the check precedes writeJson.
      const startPhase = flag(rest, '--phase', 'planning');
      if (!PHASES.includes(startPhase)) {
        process.stderr.write(`unknown phase '${startPhase}'; expected one of ${PHASES.join('|')}\n`);
        process.exit(2);
      }
      const state = {
        ...blank(),
        feature,
        // A run always begins by working out what to do. /ship relies on this so
        // that a bare `start` is enough to enter the machine.
        phase: startPhase,
        briefFile: flag(rest, '--brief-file', s.briefFile || 'docs/briefs.md'),
        startedAt: now,
      };
      writeJson(runPath(cwd, feature), state);
      setPointer(cwd, feature);
      break;
    }

    case 'current': {
      // Reading or re-pointing this chat at a run, which is what /ship does once the
      // user picks one out of the table.
      if (rest[0] && !rest[0].startsWith('--')) {
        setPointer(cwd, rest[0]);
        process.stdout.write(`${JSON.stringify(resolve(cwd, rest[0]).state, null, 2)}\n`);
      } else {
        const ptr = pointerPath() ? readJson(pointerPath()) : null;
        process.stdout.write(`${JSON.stringify(ptr, null, 2)}\n`);
      }
      break;
    }

    case 'begin-brief': {
      const n = Number(rest[0]);
      // Re-entering the same brief after a resume must NOT reset its counters —
      // that is precisely how a bounded loop becomes unbounded.
      const same = s.currentBrief === n;
      save(cwd, res, {
        ...s,
        currentBrief: n,
        attempt: same ? s.attempt + 1 : 1,
        reviewRounds: same ? s.reviewRounds : 0,
        debugRounds: same ? s.debugRounds : 0,
        finishedAt: null,
      });
      break;
    }

    case 'phase': {
      const next = rest[0];
      if (!PHASES.includes(next)) {
        process.stderr.write(`unknown phase '${next}'; expected one of ${PHASES.join('|')}\n`);
        process.exit(2);
      }
      save(cwd, res, { ...s, phase: next, planFile: flag(rest, '--plan', s.planFile) });
      break;
    }

    case 'branch': {
      // A leading `--` means no branch name was given. ship.md's Start step records
      // the base before the work branch exists, with `branch --base <branch>`, and
      // reading rest[0] literally wrote the string '--base' into `branch`. The real
      // `branch feature/x` call was then refused as a switch away from it, which is
      // how this surfaced: it blocked a live run rather than corrupting one quietly.
      const next = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
      if (!next) {
        if (!rest.includes('--base')) {
          process.stderr.write('usage: run-state.cjs branch <name> [--base <branch>]\n');
          process.exit(2);
        }
        save(cwd, res, { ...s, baseBranch: flag(rest, '--base', s.baseBranch) });
        break;
      }
      // A resume re-records the same branch and must succeed. A DIFFERENT branch
      // on an unfinished run is refused: it would split the feature in two, with
      // half the briefs committed on each and the PR carrying only one half.
      // Scoped to one run now — it never meant "one branch per repository".
      if (s.branch && s.branch !== next && !s.finishedAt) {
        process.stderr.write(
          `run is already on '${s.branch}'; refusing to switch to '${next}'. ` +
          `Finish or abandon the current run first.\n`);
        process.exit(2);
      }
      save(cwd, res, { ...s, branch: next, baseBranch: flag(rest, '--base', s.baseBranch) });
      break;
    }

    case 'review-round':
      save(cwd, res, { ...s, reviewRounds: s.reviewRounds + 1 });
      break;

    case 'debug-round':
      save(cwd, res, { ...s, debugRounds: s.debugRounds + 1 });
      break;

    case 'block': {
      const n = Number(rest[0]);
      const blocked = s.blocked.filter((b) => b.brief !== n);
      blocked.push({ brief: n, reason: flag(rest, '--reason', 'unspecified'), at: now });
      save(cwd, res, { ...s, blocked, currentBrief: null });
      break;
    }

    case 'finish-brief': {
      const commit = flag(rest, '--commit', s.lastCommit);
      save(cwd, res, { ...s, currentBrief: null, lastCommit: commit, reviewRounds: 0, debugRounds: 0 });
      break;
    }

    case 'finish':
      // Clearing the phase is what stops checkpoint-restore re-injecting a
      // finished run, and what tells /ship there is nothing left to resume.
      save(cwd, res, { ...s, currentBrief: null, phase: null, finishedAt: now });
      break;

    // A stray positional argument is refused rather than ignored. `get alpha` reads
    // like it addresses a run; it did not, so the command silently returned whichever
    // run the POINTER resolved — a different one — with exit 0. Silently answering
    // about the wrong run is the failure this whole file exists to prevent, so the
    // interface must not reproduce it.
    case 'table':
      process.stdout.write(renderTable(tableRows(cwd)));
      break;

    case 'get': {
      const stray = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1] === '--feature'));
      if (stray.length) {
        process.stderr.write(
          `run-state.cjs get takes no positional argument (got '${stray[0]}'). ` +
          `Use --feature ${stray[0]} to address one run, --all to list them, ` +
          'or no argument for this chat\'s run.\n');
        process.exit(2);
      }
      if (rest.includes('--all')) {
        process.stdout.write(`${JSON.stringify(listRuns(cwd), null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
      }
      break;
    }

    default:
      process.stderr.write(
        'usage: run-state.cjs start|current|phase|branch|begin-brief|review-round|debug-round|block|finish-brief|finish|get|table\n',
      );
      process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) main();
// `load` is kept on the old signature — it answers "what run does this directory
// resolve to", which is what the callers that import it have always wanted.
const load = (cwd) => resolve(cwd).state;
/**
 * The run a given chat is driving in a given directory — what a hook needs.
 *
 * Hooks used to read <cwd>/docs/.run-state.json straight off the disk, which was
 * fine while a repository had exactly one run and wrong the moment it had two: every
 * chat's checkpoint and every subagent log line got stamped with whichever run the
 * file held. Going through the pointer is what makes those records belong to the
 * chat that produced them.
 */
const runFor = (cwd, session) => resolve(cwd, null, session).state;

module.exports = { load, statePath, resolve, runFor, listRuns, repoKey, tableRows, renderTable, REL };
