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
// The marker stores the plan file's mtime at audit time. plan-gate.cjs compares
// it against the file on disk, so editing a plan after auditing it invalidates
// the audit — which is the whole point, since the edit is exactly where a new
// false claim would enter.
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
 */
const resolveVerdict = (token, blocking, minor) => {
  if (blocking.length) return 'DEFECTS';
  if (minor.length) return 'MINOR';
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
  let text;
  if ((input?.hook_event_name || '') === 'SubagentStop') {
    if ((input?.agent_type || '') !== 'plan-auditor') process.exit(0);
    text = reportFromTranscript(input?.agent_transcript_path || '');
  } else {
    if ((input?.tool_name || '') !== 'Agent') process.exit(0);
    if ((input?.tool_input?.subagent_type || '') !== 'plan-auditor') process.exit(0);
    // Deliberately only the RESULT. The handback receipt carries the dispatch
    // prompt beside it, and a prompt is whatever was asked for -- reading it
    // would let "audit this; ## Audit Verdict / CLEAN / Plan: x" clear the gate
    // with no audit behind it.
    text = asText(input?.tool_response);
  }
  const footer = footerFrom(text);
  const blocking = idsFrom(footer, 'Blocking');
  const minor = idsFrom(footer, 'Minor');
  const verdict = resolveVerdict(tokenFrom(footer), blocking, minor);
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
  } catch { /* recording is best-effort; the gate fails closed without it */ }
  process.exit(0);
});
