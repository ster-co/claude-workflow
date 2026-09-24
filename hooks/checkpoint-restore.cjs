#!/usr/bin/env node
// SessionStart: restores the thread of work, from three different sources.
//
// SessionStart fires with one of five sources — startup, resume, clear, compact,
// fork — and each needs a different answer:
//
//   compact | resume | clear  →  the session checkpoint written by checkpoint-write.cjs.
//                        The session survives all three, so the checkpoint is still on
//                        disk under this id and carries session-specific detail.
//   startup | clear | fork  →  <repo>/docs/.run-state.json, and ONLY when that file shows
//                        a brief still in flight. This is the crash / reboot / fork path:
//                        the session id is new, so there is no checkpoint to read, which
//                        is exactly the gap that makes durable state live in the repo.
//
// `clear` appears in both lists on purpose. It keeps the session, so the checkpoint is
// normally the better source — but a machine restart between the write and the clear
// leaves none, and falling through to the repo state recovers more than giving up does.
// `startup` deliberately does NOT read the session checkpoint: a genuinely new session
// has no business inheriting one, and the run state already carries the durable facts.
//
// A third source is independent of both and fires on every start: unresolved
// plan-audit blockers for plans in THIS repository. A blocking defect that
// nobody fixed before the session ended is otherwise only discoverable by trying
// to commit the plan and being denied. The audit markers already record which
// ids block and what each one was, so this reads them rather than storing more.
//
// A fresh startup in a repo with no unfinished run gets nothing. Re-injecting stale
// state into an unrelated session is how a helper turns into noise.
//
// Two constraints from the SessionStart contract, both load-bearing:
//   - additionalContext over 10,000 characters is written to a file and Claude is handed
//     the path, which it is not asked to read. Stay well under it.
//   - text framed as an out-of-band instruction can trigger prompt-injection defenses and
//     get surfaced to the operator instead of used. Write factual statements.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { acceptedIds, planBodyHash } = require('./gates/gate-lib.cjs');

const { listRuns } = require('./run-state.cjs');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');
const MAX_CONTEXT_CHARS = 8000; // under the 10k cap, with room for the longest brief path

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

const isUnder = (dir, abs) => {
  const rel = path.relative(dir, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Open blocking defects on plans in this repository, newest audit last.
 *
 * "Open" means the last audit called them blocking AND the plan does not record
 * them under its acknowledgement section. An acknowledged defect is a decision,
 * not an open item.
 *
 * A marker whose plan has changed since the audit is still reported, marked as
 * no longer current. That is the case this exists for: the plan was edited to
 * fix the defect and the session ended before the re-audit, and staying silent
 * there loses the blocker exactly when it is being picked back up.
 */
const openBlockers = (cwd) => {
  const dir = path.join(STATE_DIR, 'plan-audited');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const f of files) {
    const rec = readJson(path.join(dir, f));
    if (!rec || rec.verdict !== 'DEFECTS') continue;
    const blocking = Array.isArray(rec.blocking) ? rec.blocking : [];
    if (!blocking.length || !rec.plan || !isUnder(cwd, rec.plan)) continue;
    let text;
    try { text = fs.readFileSync(rec.plan, 'utf8'); } catch { continue; }  // plan is gone
    // Stamped, like the gate: an acknowledgement written for an earlier audit must
    // not suppress the reminder that THIS audit's defect is still open.
    const accepted = acceptedIds(text, rec.at);
    const open = blocking.filter((id) => !accepted.includes(id));
    if (!open.length) continue;
    const hash = planBodyHash(rec.plan);
    rows.push({
      plan: path.relative(cwd, rec.plan),
      open,
      summaries: rec.summaries || {},
      stale: !!(hash && rec.bodyHash && hash !== rec.bodyHash),
    });
  }
  if (!rows.length) return [];
  const lines = ['Plan-audit blockers in this repository that were never resolved:'];
  for (const r of rows) {
    for (const id of r.open) {
      const what = r.summaries[id] ? `: ${r.summaries[id]}` : '';
      lines.push(`- ${r.plan} — ${id}${what}.${r.stale
        ? ' The plan has been edited since that audit, so it may already be fixed; re-auditing is what settles it.'
        : ''}`);
    }
  }
  lines.push('- A plan carrying an unresolved blocking defect cannot be committed until it is fixed, or recorded in the plan under "## Known defects — accepted".');
  return lines;
};

const emit = (lines) => {
  let text = lines.join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS - 3)}...`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    suppressOutput: true,
  }));
  process.exit(0);
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const source = input?.source;
  const session = input?.session_id;
  const cwd = input?.cwd || process.cwd();

  // Independent of the source: a blocker outlives the session that found it.
  const blockers = openBlockers(cwd);
  const done = () => (blockers.length ? emit(blockers) : process.exit(0));

  // Sources that keep the session, so the checkpoint file is still addressable.
  const SESSION_SOURCES = new Set(['compact', 'resume', 'clear']);
  // Sources reached with no usable checkpoint, where the repo state is what is left.
  const DURABLE_SOURCES = new Set(['startup', 'clear', 'fork']);
  const VERB = { resume: 'resumed', compact: 'compacted', clear: 'cleared' };

  // --- same-session recovery: compaction, resume or clear --------------------
  if (SESSION_SOURCES.has(source) && session) {
    const ck = readJson(path.join(STATE_DIR, 'checkpoint', `${session}.json`));
    if (ck) {
      const lines = [`Checkpoint from before this context was ${VERB[source]} (${ck.at}):`];
      if (ck.brief) lines.push(`- Brief ${ck.brief} was in flight${ck.briefFile ? ` (${ck.briefFile})` : ''}. Its current text is on disk; working from memory of it is unreliable after a compaction.`);
      if (ck.lastVerdict) lines.push(`- Last reviewer verdict on file: ${ck.lastVerdict}.`);
      if (ck.cwd) lines.push(`- Working directory: ${ck.cwd}.`);
      lines.push('- The working tree state at this point is unverified; git status reports it.');
      emit(blockers.length ? [...lines, '', ...blockers] : lines);
    }
    // No checkpoint. compact and resume have nowhere else to look; clear does.
    if (!DURABLE_SOURCES.has(source)) done();
  }

  // --- cross-session recovery: a new session over an unfinished run ----------
  // Deliberately LISTS rather than selects. All three durable sources are sessions
  // whose id is new (see the header), so the per-chat pointer /ship resolves a run
  // with cannot exist yet -- and a hook that picked one would be guessing in the
  // one case where several runs are live at once. Selection stays with /ship.
  if (DURABLE_SOURCES.has(source)) {
    const unfinished = listRuns(cwd).filter(
      (r) => !r.finishedAt && r.currentBrief !== null && r.currentBrief !== undefined);
    if (!unfinished.length) done();

    const detail = (rs) => {
      const out = [];
      if (rs.feature) out.push(`- Feature: ${rs.feature}.`);
      // The phase is what /ship reads to decide what to do next, so a recovered
      // session needs it as much as it needs the brief number.
      if (rs.phase) out.push(`- /ship phase: ${rs.phase}${rs.planFile ? ` (plan: ${rs.planFile})` : ''}.`);
      out.push(`- Brief ${rs.currentBrief} was in flight in ${rs.briefFile || 'docs/briefs.md'}.`);
      if (rs.branch) out.push(`- Work branch: ${rs.branch}${rs.baseBranch ? ` (based on ${rs.baseBranch})` : ''}.`);
      if (rs.attempt) out.push(`- Attempts on that brief so far: ${rs.attempt}.`);
      if (rs.reviewRounds) out.push(`- Review rounds so far: ${rs.reviewRounds}.`);
      if (rs.debugRounds) out.push(`- Debug rounds so far: ${rs.debugRounds}.`);
      if (Array.isArray(rs.blocked) && rs.blocked.length) {
        out.push(`- Blocked briefs: ${rs.blocked.map((b) => `${b.brief} (${b.reason})`).join(', ')}.`);
      }
      if (rs.lastCommit) out.push(`- Last commit recorded by the run: ${rs.lastCommit}.`);
      return out;
    };

    const lines = unfinished.length === 1
      ? ['An orchestrated brief run in this repository is unfinished:', ...detail(unfinished[0])]
      : [`${unfinished.length} orchestrated brief runs in this repository are unfinished.`,
         'Which one this chat drives is not recorded yet -- type /ship and pick one; do not assume.',
         ...unfinished.flatMap((rs) => ['', ...detail(rs)])];
    // Blank line first: with several runs listed this trailer otherwise reads as
    // another bullet belonging to the last one.
    if (unfinished.length > 1) lines.push('');
    lines.push('- The brief file is the authoritative queue; the state file records counters only. Where the two disagree, the brief file is correct.');
    emit(blockers.length ? [...lines, '', ...blockers] : lines);
  }

  done();
});
