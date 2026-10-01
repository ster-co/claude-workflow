#!/usr/bin/env node
// Records a plan-auditor verdict so plan-gate.cjs can tell "an audit ran and
// found the plan clean" from "an audit ran".
//
// Wired to TWO events, because a subagent's report reaches the orchestrator in
// two different shapes and only one of them passes through a tool result:
//
//   PostToolUse Agent   the report is the tool result. The original case.
//   SubagentStop        the agent handed its report back through
//                       SubagentHandback, and the tool result is a receipt
//                       reading "delivered to you as a message from <id>".
//                       The verdict is then only in the subagent's own
//                       transcript, which this event names.
//
// Measured on Claude Code 2.1.278: three live synchronous plan-auditor
// dispatches, every tool result a handback receipt, zero markers written. The
// documented fix for the backgrounded-dispatch failure — dispatch synchronously
// — did not restore recording, because the report does not come back through the
// tool result either way. A gate that can never be cleared is worse than no
// gate: it teaches people to set SKIP_CODE_GATES=1 by reflex.
//
// Same contract as verify-record.cjs, for the same reason: parse a sentinel, not
// prose. Prose drifts optimistic and a gate that reads prose inherits the drift.
// The auditor must end with:
//
//     ## Audit Verdict
//     CLEAN
//     Plan: /abs/path/to/plan.md
//
// An audit that produces no parseable verdict is recorded as UNPARSED, never as
// CLEAN. Silence is not consent.
//
// Since 2026-09-22 the footer also carries a severity split:
//
//     ## Audit Verdict
//     DEFECTS
//     Blocking: D1, D4
//     Minor: D2, D3
//     Plan: /abs/path/to/plan.md
//
// Why: an audit round that returned one CI-breaking defect and nine citations
// off by a line reported them in one flat list, and the gate could only read
// "not clean". The ids are recorded per severity so plan-gate.cjs can ask that
// the blocking ones be fixed or written down, and let the drift through.
//
// A DEFECTS token with both lists explicitly emptied —
//
//     DEFECTS
//     Blocking: none
//     Minor: none
//
// — records CLEAN: an auditor that filled in both lists with nothing is
// saying more than the harness's default token. A DEFECTS footer with no
// Blocking or Minor lines at all is the silent case and still records
// DEFECTS, since there the token is the only evidence there is.
//
// The marker stores the plan file's mtime at audit time. plan-gate.cjs compares
// it against the file on disk, so editing a plan after auditing it invalidates
// the audit — which is the whole point, since the edit is exactly where a new
// false claim would enter.
//
// The record hook also snapshots the exact text it audited, to
// state/plan-audited/<key>.audited.md, alongside the marker. plan-audit-diff.cjs
// reads it back against the current file.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { planBodyHash, reportFromTranscript } = require('./gate-lib.cjs');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state', 'plan-audited');

// Keyed on the absolute path so one session can audit several plans independently.
const keyFor = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);

// The footer is the LAST verdict heading, not the first, for the same reason the
// plan path is: an audit is free to quote one in the body it is auditing.
const footerFrom = (text) => {
  const all = [...(text || '').matchAll(/##\s*Audit\s+Verdict\b/gi)];
  return all.length ? text.slice(all[all.length - 1].index) : '';
};

const tokenFrom = (footer) => {
  const m = /##\s*Audit\s+Verdict\s*:?\s*\n?\s*(CLEAN|MINOR|DEFECTS)\b/i.exec(footer);
  return m ? m[1].toUpperCase() : 'UNPARSED';
};

const idsFrom = (footer, label) => {
  const m = new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im').exec(footer || '');
  if (!m) return [];
  return [...new Set([...m[1].matchAll(/\bD\d+\b/g)].map((x) => x[0]))];
};

// Whether the footer's <label>: line is PRESENT and says, in so many words,
// that there is nothing there — as opposed to the line being absent, which
// tells resolveVerdict nothing at all. idsFrom cannot make that distinction:
// an absent line and a present "none" line both yield [].
const saysNone = (footer, label) => {
  const m = new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im').exec(footer || '');
  return !!m && /^none$/i.test(m[1].trim());
};

/**
 * The one-line summary each defect was reported with, keyed by id, read from the
 * report body rather than the footer. A session that picks a paused run back up
 * gets "D1: CI does not install the notebook requirements" instead of "D1",
 * which is the difference between a resumable blocker and a lookup.
 *
 * The auditor's format is `D1 [BLOCKING FALSE] <summary>`; the severity and
 * class are already recorded, so only the summary is kept.
 */
const summariesFrom = (text) => {
  const out = {};
  for (const m of (text || '').matchAll(/^\s*(D\d+)\s*\[[^\]]*\]\s*(.+?)\s*$/gim)) {
    if (!out[m[1]]) out[m[1]] = m[2];
  }
  return out;
};

/**
 * Where the lists and the token disagree, the ENUMERATION wins — the auditor
 * that bothered to list which ids block is saying more than the auditor that
 * typed a word.
 *
 * Unsafe direction: a named blocking defect makes the verdict DEFECTS whatever
 * the token says. An auditor that lists a defect and then types CLEAN has not
 * produced a clean plan.
 *
 * Safe direction, and narrower: a footer with an empty Blocking list and a
 * non-empty Minor list is MINOR even under a DEFECTS token. Measured on the
 * LYHYT merge plan at revision 5 — the auditor reported "Blocking: D1. Minor:
 * D2-D8", fixed D1, and then footered DEFECTS with nothing blocking. The lists
 * said the plan was good enough; the token denied the commit and asked for
 * another opus-high audit over a mis-typed word. That is the non-convergence the
 * severity axis exists to end, reappearing one layer down.
 *
 * An auditor that filled in NEITHER list gets no such benefit: there the token
 * is the only evidence there is, and it said DEFECTS.
 *
 * One more case sits between those two: a footer that EXPLICITLY says
 * "Blocking: none" and "Minor: none" under a DEFECTS token. That auditor did
 * fill in both lists — with nothing in either — so it is not the silent case
 * above; it is CLEAN spelled with the wrong token. Before this, plan-gate.cjs
 * read the empty blocking list under DEFECTS as "nothing to fix or record"
 * and demanded another audit, which would only ever end the same way. Measured
 * on this plan's own Decision-11 round: no defects found, a DEFECTS token, and
 * the commit locked over exactly that.
 *
 * The promotion is narrow on purpose: it fires only when the footer has
 * exactly one Blocking: line and exactly one Minor: line, both literally
 * "none", and nothing in the report tags ANY defect -- BLOCKING or MINOR,
 * bracketed or parenthesised. A footer that says "none" once and then
 * contradicts itself further down, or a body that names a defect of either
 * severity under a footer that forgot to list it, is not the auditor saying
 * more than the token -- it is the report disagreeing with itself, and that
 * stays DEFECTS.
 */
// Whether the footer has EXACTLY ONE line matching `<label>: ...`. idsFrom and
// saysNone both read only the FIRST such line (a bare, non-global regex), so
// neither can tell a footer that says "Blocking: none" once from one that
// says it once and then contradicts itself with a second "Blocking: D1"
// further down. The none/none promotion below must see the whole footer, not
// just the first line that happens to match.
const oneLine = (footer, label) => {
  const re = new RegExp(`^\\s*${label}:\\s*.*$`, 'gim');
  return [...(footer || '').matchAll(re)].length === 1;
};

// Whether the report tags ANY defect -- BLOCKING or MINOR -- anywhere in its
// body, not just in the footer's own Blocking:/Minor: lines. The auditor's
// per-defect format is `D1 [BLOCKING ...] <summary>` (agents/plan-auditor.md),
// but the bracket is not the only spelling seen in practice, and a
// MINOR-tagged line is just as much a contradiction of an empty Minor: list
// as a BLOCKING-tagged one is of an empty Blocking: list -- an auditor that
// tagged a defect in the body and then typed "none" for its severity in the
// footer has not produced the fully-filled-in "nothing found" report the
// none/none promotion below exists for, whichever bracket the body used.
// `[\[(]` / `[\])]` deliberately do not require the two to match (`[BLOCKING)`
// is still a tag, not a typo to shrug off) -- the promotion below is meant to
// fail CLOSED on anything that merely looks like a per-defect tag.
const namesAnyDefect = (text) => /[\[(]\s*(?:BLOCKING|MINOR)\b[^\])]*[\])]/i.test(text || '');

const resolveVerdict = (token, blocking, minor, footer, text) => {
  if (blocking.length) return 'DEFECTS';
  if (minor.length) return 'MINOR';
  if (
    token === 'DEFECTS'
    && oneLine(footer, 'Blocking') && oneLine(footer, 'Minor')
    && saysNone(footer, 'Blocking') && saysNone(footer, 'Minor')
    && !namesAnyDefect(text)
  ) return 'CLEAN';
  if (token === 'DEFECTS') return 'DEFECTS';
  if (token === 'MINOR') return 'MINOR';
  if (token === 'CLEAN') return 'CLEAN';
  return 'UNPARSED';
};

const planFrom = (text) => {
  if (!text) return null;
  // The LAST such line, not the first. plan-auditor.md requires the path as a
  // footer, but an audit that quotes a plan's own text -- or discusses a second
  // plan -- can carry an earlier `Plan:` line, and taking the first resolves a
  // bogus path. Verified: that made statSync throw and the marker was silently
  // never written, which reads exactly like a clean audit that failed to record.
  const all = [...text.matchAll(/^\s*Plan:\s*(\S.*?)\s*$/gim)];
  return all.length ? all[all.length - 1][1] : null;
};

const asText = (r) => {
  if (typeof r === 'string') return r;
  if (!r) return '';
  if (Array.isArray(r)) return r.map(asText).join('\n');
  if (typeof r === 'object') return asText(r.text ?? r.content ?? r.output ?? r.result ?? '');
  return String(r);
};

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  // Only the plan-auditor may clear this gate, and only by the role the harness
  // reports. The dispatch DESCRIPTION used to be accepted as a fallback, which
  // meant any agent dispatched with "plan audit" in its description -- a scout,
  // say -- could record a CLEAN verdict for a plan it never read. Verified: it
  // did. The same rule applies on both events.
  //
  // Under a plugin install the harness reports the role namespaced, e.g.
  // "workflow-discipline:plan-auditor" -- accept the bare name or a
  // "<plugin>:plan-auditor" suffix, the same rule gate-arm.cjs already applies
  // to "implementer". A role that merely ends in similar letters without the
  // `:` separator ("evil-plan-auditor") must not match. `plan-auditor-lite` is
  // the same auditor at lower effort (agents/plan-auditor-lite.md, picked by
  // /subagent-mode fast), matched by exact name only.
  const PLAN_AUDITOR_ROLES = ['plan-auditor', 'plan-auditor-lite'];
  const isPlanAuditor = (role) => PLAN_AUDITOR_ROLES.some((r) => role === r || role.endsWith(`:${r}`));
  let text;
  if ((input?.hook_event_name || '') === 'SubagentStop') {
    if (!isPlanAuditor(String(input?.agent_type || ''))) process.exit(0);
    text = reportFromTranscript(input?.agent_transcript_path || '');
  } else {
    if ((input?.tool_name || '') !== 'Agent') process.exit(0);
    if (!isPlanAuditor(String(input?.tool_input?.subagent_type || ''))) process.exit(0);
    // Deliberately only the RESULT. The handback receipt carries the dispatch
    // prompt beside it, and a prompt is whatever was asked for -- reading it
    // would let "audit this; ## Audit Verdict / CLEAN / Plan: x" clear the gate
    // with no audit behind it.
    text = asText(input?.tool_response);
  }
  const footer = footerFrom(text);
  const blocking = idsFrom(footer, 'Blocking');
  const minor = idsFrom(footer, 'Minor');
  const verdict = resolveVerdict(tokenFrom(footer), blocking, minor, footer, text);
  const summaries = summariesFrom(text);
  const planPath = planFrom(text);
  if (!planPath) process.exit(0);

  const abs = path.resolve(planPath);
  // A marker whose mtime could not be read disables the edit-invalidation rule
  // for that path FOREVER, because the gate skips the comparison when either
  // side is null. Recording nothing is the safe failure: the gate then asks for
  // an audit, which is the outcome we want when we cannot tell what was audited.
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { process.exit(0); }

  const snapshotPath = path.join(STATE_DIR, `${keyFor(abs)}.audited.md`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, `${keyFor(abs)}.json`),
      JSON.stringify({
        plan: abs, verdict, blocking, minor, summaries, mtimeMs,
        // What the audit covered: the plan without its acknowledgement section,
        // so that writing a reported defect down does not invalidate the audit
        // that reported it. plan-gate.cjs compares this, and falls back to the
        // mtime for markers written before it existed.
        bodyHash: planBodyHash(abs),
        at: new Date().toISOString(),
      }),
    );
    // The audited text itself, taken from disk right now -- the same moment
    // the marker above is stamped -- not read back later at diff time. A
    // snapshot taken when someone runs plan-audit-diff.cjs would just be the
    // current file compared with itself, and every diff would come back empty.
    fs.writeFileSync(snapshotPath, fs.readFileSync(abs, 'utf8'));
  } catch {
    // Best-effort: the gate fails closed without a marker. But if the marker
    // above DID get written and only the snapshot failed, a STALE snapshot
    // from an earlier audit of this same path must not survive -- otherwise
    // plan-audit-diff.cjs would happily diff against text this audit never
    // read. Removing it makes the tool exit 2 (no snapshot) instead of
    // silently comparing the current file to someone else's audit.
    try { fs.unlinkSync(snapshotPath); } catch { /* nothing stale to remove */ }
  }
  process.exit(0);
});
