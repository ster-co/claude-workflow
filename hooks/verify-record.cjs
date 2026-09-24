#!/usr/bin/env node
// Records a reviewer subagent's verdict so verify-gate.cjs can tell "a reviewer
// ran and approved" from "a reviewer ran".
//
// Wired to TWO events, because a subagent's report reaches the orchestrator in
// two shapes and only one passes through a tool result:
//
//   PostToolUse Agent   the report is the tool result. The original case.
//   SubagentStop        the agent handed its report back through
//                       SubagentHandback; the tool result is a receipt and the
//                       report is in the subagent's transcript, which this event
//                       names in `agent_transcript_path`.
//
// Measured on Claude Code 2.1.278 by dumping the live payload. The receipt is
// prose written by the harness, so parsing it produced a verdict about the
// delivery note rather than the review.
//
// The contract is borrowed from cc-sdd's kiro-impl, which is the best-specified
// version of this loop found in the wild: the reviewer must end with a line
// "## Review Verdict" followed by APPROVED or REJECTED. Parsing a sentinel beats
// reading prose, because prose drifts optimistic and a gate that reads prose
// inherits the drift.
//
// A review that produces no parseable verdict is recorded as UNPARSED, never as
// approval. Silence is not consent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { reportFromTranscript, promptFromTranscript } = require('./gates/gate-lib.cjs');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

// "review brief 3", "reviewing brief 12", "brief 7 review"
const briefFrom = (text) => {
  const m = /brief\s*#?\s*(\d+)/i.exec(text || '');
  return m ? m[1] : null;
};

const isReview = (desc) => /\breview/i.test(desc || '');

const verdictFrom = (text) => {
  if (!text) return 'UNPARSED';
  // The sentinel, allowing for the verdict on the same line or the next.
  const m = /##\s*Review\s+Verdict\s*:?\s*\n?\s*(APPROVED|REJECTED)\b/i.exec(text);
  if (m) return m[1].toUpperCase();
  // A bare sentinel word on its own line is accepted as a fallback.
  const bare = /^\s*(APPROVED|REJECTED)\s*$/im.exec(text);
  return bare ? bare[1].toUpperCase() : 'UNPARSED';
};

const asText = (r) => {
  if (typeof r === 'string') return r;
  if (!r) return '';
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  }
  return JSON.stringify(r);
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const session = input?.session_id;
  if (!session) process.exit(0);

  let desc, prompt, body;
  if ((input?.hook_event_name || '') === 'SubagentStop') {
    // The ROLE decides, not the prompt. An implementer handed a review-shaped
    // brief must not clear the review gate -- the same hole a scout dispatched
    // with "plan audit" in its description once opened in the plan gate.
    // /execute dispatches `reviewer`, and verify-all.cjs asserts that it still
    // does. Only when the harness reports no role at all does the prompt decide,
    // so a payload change degrades to the old behaviour rather than to silence.
    const transcript = input?.agent_transcript_path || '';
    desc = input?.agent_type || '';
    prompt = promptFromTranscript(transcript);
    if (desc ? desc !== 'reviewer' : !isReview(prompt.slice(0, 200))) process.exit(0);
    body = reportFromTranscript(transcript);
  } else {
    // A handed-back report is not in the tool result, and SubagentStop has
    // already recorded it by the time this fires. Parsing the receipt here
    // replaced a real APPROVED with an UNPARSED read out of the delivery note.
    if (input?.tool_response?.handback) process.exit(0);
    desc = input?.tool_input?.description ?? '';
    prompt = input?.tool_input?.prompt ?? '';
    if (!isReview(desc) && !isReview(prompt.slice(0, 200))) process.exit(0);
    body = asText(input?.tool_response);
  }

  const brief = briefFrom(desc) ?? briefFrom(prompt) ?? briefFrom(body);

  const verdict = verdictFrom(body);

  const dir = path.join(STATE_DIR, 'brief-review');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({
      brief,
      verdict,
      at: new Date().toISOString(),
    }));
  } catch { /* a missing marker only means the gate asks again */ }

  // The escalation counter is bumped HERE, from the verdict, rather than by
  // /execute when it dispatches the reviewer. execute.md escalates to the debugger
  // at `reviewRounds >= 2` and calls that "after two REJECTED verdicts"; counting
  // dispatches made the threshold trip after one rejection. Measured on a live run:
  // the counter reached 2 thirty-two seconds before the second reviewer started,
  // and that reviewer returned APPROVED.
  //
  // In code rather than in prose for run-state.cjs's own stated reason -- a script
  // cannot forget to bump a counter, and an instruction can.
  if (verdict === 'REJECTED') {
    try {
      const { resolve: resolveRun } = require('./run-state.cjs');
      const res = resolveRun(input?.cwd || process.cwd(), null, session);
      if (res.file) {
        fs.writeFileSync(res.file,
          `${JSON.stringify({ ...res.state, reviewRounds: res.state.reviewRounds + 1 }, null, 2)}\n`);
      }
    } catch { /* counting is best-effort; the gate still holds the turn */ }
  }
  process.exit(0);
});
