#!/usr/bin/env node
// Stop: refuses to let a turn end while a brief is in flight and unreviewed.
//
// Why this exists as a hook rather than a rule: /execute already says "dispatch a
// reviewer briefed to disprove", and the measured failure is that the step gets
// skipped under time pressure — "state persistence is not working, all agents
// claimed to have finished". A sentence in a command file cannot enforce itself.
//
// The gate is ARMED, not always-on: it does nothing until something arms it,
// so ordinary sessions never see it. It clears when a matching verdict lands
// in state/brief-review/<session>.json.
//
// Two ways a brief gets armed, both read here:
//   - state/brief-exec/<session>/<n>.json, one file per brief, written by the
//     PreToolUse hook gate-arm.cjs the moment an implementer is dispatched
//     with a prompt whose first line is "Implement BRIEF <n>". This is the
//     current mechanism -- arming happens from the dispatch itself, not from
//     a model Write that a sandbox outside ~/.claude can silently refuse.
//   - state/brief-exec/<session>.json, the legacy single-file marker (one
//     brief: `{"brief":"<n>"}`, or a whole group at once:
//     `{"briefs":["<n>",...]}`), still honoured so a marker written before
//     gate-arm.cjs existed keeps arming the gate exactly as it always did.
// Both can be armed at once (a per-brief file for one brief, the legacy file
// for another); the two sets are unioned. The turn ends only once EVERY
// armed brief has an APPROVED verdict on file; any brief still missing one
// blocks the turn and is named in the message.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

// Claude Code overrides a Stop hook after 8 consecutive blocks. Stand down before
// that: a gate the platform has to override is a gate the operator is fighting.
const MAX_BLOCKS = 5;

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }

  const allow = () => process.exit(0);

  if (process.env.SKIP_CODE_GATES === '1') allow();

  const session = input?.session_id;
  if (!session) allow();

  // The platform re-runs Stop hooks on the continuation turn; re-blocking there
  // loops the session against itself.
  if (input?.stop_hook_active) allow();

  // Floored to the millisecond: a verdict's `at` is an ISO string (ms
  // resolution), while mtimeMs can carry a sub-ms fraction from the
  // filesystem's own clock. Without the floor, a verdict recorded in the
  // SAME millisecond as the arming -- legitimately after it -- could read as
  // microseconds earlier and be discarded as stale.
  const armedAtOf = (obj, filePathForMtime) => {
    if (obj?.armedAt) {
      const parsed = Date.parse(obj.armedAt);
      if (!Number.isNaN(parsed)) return parsed;
    }
    try { return Math.floor(fs.statSync(filePathForMtime).mtimeMs); } catch { return null; }
  };

  // Two sources, unioned into one map of brief -> armedAt (ms). A brief armed
  // by both (unlikely, but not forbidden) keeps whichever armedAt its own
  // per-brief file carries -- that file is the current mechanism and the more
  // specific one.
  const armedAt = {};

  const perBriefDir = path.join(STATE_DIR, 'brief-exec', session);
  let perBriefFiles = [];
  try { perBriefFiles = fs.readdirSync(perBriefDir).filter((f) => f.endsWith('.json')); } catch { perBriefFiles = []; }
  for (const f of perBriefFiles) {
    const n = f.slice(0, -'.json'.length);
    const filePath = path.join(perBriefDir, f);
    const rec = readJson(filePath);
    if (!rec) continue;
    armedAt[n] = armedAtOf(rec, filePath);
  }

  // The legacy single-file marker: one brief (`{"brief":"<n>"}`) or a whole
  // group (`{"briefs":["<n>",...]}`), still honoured so a marker written
  // before gate-arm.cjs existed keeps arming the gate exactly as it always did.
  const armPath = path.join(STATE_DIR, 'brief-exec', `${session}.json`);
  const legacyArm = readJson(armPath);
  if (legacyArm) {
    const legacyBriefs = Array.isArray(legacyArm.briefs) && legacyArm.briefs.length
      ? legacyArm.briefs.map(String)
      : (legacyArm.brief !== undefined && legacyArm.brief !== null ? [String(legacyArm.brief)] : []);
    const legacyAt = armedAtOf(legacyArm, armPath);
    for (const n of legacyBriefs) {
      if (!(n in armedAt)) armedAt[n] = legacyAt;
    }
  }

  const armed = Object.keys(armedAt);
  if (!armed.length) allow();

  const blockPath = path.join(STATE_DIR, 'brief-blocks', `${session}.json`);
  const blocks = readJson(blockPath)?.count ?? 0;
  if (blocks >= MAX_BLOCKS) {
    process.stdout.write(JSON.stringify({
      systemMessage:
        `Verification gate stood down after ${blocks} blocks: brief(s) ${armed.join(', ')} still ` +
        `have no reviewer verdict. Ending the turn anyway — record why in the brief file.`,
    }));
    process.exit(0);
  }

  const review = readJson(path.join(STATE_DIR, 'brief-review', `${session}.json`));
  // Per-brief verdicts live under `verdicts`; a review file written before that
  // existed (or written directly, as the legacy single-verdict shape) holds
  // one bare `{brief, verdict}` pair instead, so that is the fallback.
  const verdictFor = (n) => {
    if (!review) return null;
    // `n` here is already normalised (gate-arm.cjs strips leading zeros when
    // it names the arm file), but verify-record.cjs's own brief-number
    // capture does not -- a verdict recorded under "04" must still satisfy an
    // arm for "4", so a zero-padded key is tried too when the bare one misses.
    const verdicts = review.verdicts && typeof review.verdicts === 'object' ? review.verdicts : null;
    const zeroPadded = Object.keys(verdicts || {}).find((k) => k !== n && String(Number(k)) === n);
    const entry = verdicts ? (verdicts[n] ?? (zeroPadded !== undefined ? verdicts[zeroPadded] : null)) : null;
    const rec = entry || (String(Number(review.brief)) === n ? { verdict: review.verdict, at: review.at } : null);
    if (!rec) return null;
    // Stale: recorded before THIS brief's own arming, so it belongs to a
    // PREVIOUS one -- a sibling's re-arm must never invalidate or resurrect
    // a verdict that belongs to a different brief's own timeline. Mirrors
    // run-state.cjs's hasFreshApproval: once an armedAt cutoff exists, a
    // verdict with a missing or unparseable `at` cannot be shown to be fresh,
    // so it does NOT count as approved either -- the two must agree on what
    // "approved" means, or the Stop gate and finish-brief can disagree about
    // the same brief. verify-record.cjs always writes `at`; only a
    // hand-written or foreign review file lacks it.
    const at = armedAt[n];
    if (at !== null && at !== undefined) {
      const recAt = rec.at ? Date.parse(rec.at) : NaN;
      if (Number.isNaN(recAt) || recAt < at) return null;
    }
    return rec.verdict ?? null;
  };

  const missing = armed.filter((n) => verdictFor(n) !== 'APPROVED');
  if (!missing.length) allow();

  const why = (n) => {
    const v = verdictFor(n);
    if (v === null) return `brief ${n}: no reviewer has reported on it`;
    return `brief ${n}: the reviewer returned ${v}`;
  };

  try {
    fs.mkdirSync(path.dirname(blockPath), { recursive: true });
    fs.writeFileSync(blockPath, JSON.stringify({ count: blocks + 1, at: new Date().toISOString() }));
  } catch { /* a lost counter only costs an extra block */ }

  // gate-arm.cjs arms from ANY implementer dispatch, /ship run or not -- a
  // brief worked on outside a run in progress (no `run-state.cjs start` for
  // this repo/session) has nothing for `run-state.cjs block <n>` to disarm
  // against. `block`'s own save() falls back to runPath('unnamed') when no
  // run resolves, so telling the model to run it here would CREATE a run
  // that never existed, and that phantom `unnamed.json` then shows up as a
  // real run in /ship's table. Read-only: `resolve`/`runFor` never write.
  let runBound = true;
  try {
    const { resolve: resolveRun } = require('./run-state.cjs');
    let cwd = input?.cwd || process.cwd();
    try { cwd = fs.realpathSync(cwd); } catch { /* fall back to the raw cwd */ }
    runBound = !!resolveRun(cwd, null, session).file;
  } catch { /* if resolution itself fails, default to the safer run-state.cjs advice */ }

  const disarmAdvice = runBound
    ? `disarm with \`run-state.cjs block <n> --reason <why>\` for each brief listed above and say ` +
      `so. \`block\` only clears a PER-BRIEF arm file -- if this session is armed via the legacy ` +
      `single-file marker instead (state/brief-exec/${session}.json), delete that file too, since ` +
      `\`run-state.cjs block\` never touches it.`
    : `disarm by deleting the arm file(s) directly (no /ship run is bound for this session, so ` +
      `\`run-state.cjs block <n>\` would create a phantom one just to clear this) -- remove ` +
      `state/brief-exec/${session}/<n>.json for each brief listed above, or ` +
      `state/brief-exec/${session}.json if armed via the legacy single-file marker, and say so.`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `Brief(s) ${missing.join(', ')} still need an APPROVED verdict before this turn can end ` +
      `(${missing.map(why).join('; ')}). Dispatch a reviewer subagent briefed to disprove the ` +
      `change: it reads the diff and reruns the tests itself, never the implementer's report. ` +
      `It must end with a line "## Review Verdict" followed by APPROVED or REJECTED. If you are ` +
      `deliberately stopping without review, ${disarmAdvice}`,
  }));
  process.exit(0);
});
