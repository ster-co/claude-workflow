#!/usr/bin/env node
// PreToolUse: arms the verification gate from the dispatch itself, rather
// than having the model Write a marker file by hand.
//
// /execute used to arm verify-gate.cjs by having the model Write
// `state/brief-exec/<session>.json` as a documented step. Outside `~/.claude`
// that Write prompts or is denied by the platform's own file-write
// permissions, and a real nested `/execute` run (a plugin install, or one
// dispatched from another command) carried on with the gate never armed --
// no error, just a review requirement that silently never engaged. Doing the
// arming from a hook removes the step that could be skipped or blocked: the
// dispatch itself is what arms it, and there is no separate write for a
// sandbox to refuse.
//
// One file per brief -- state/brief-exec/<session>/<n>.json -- not one file
// per session. A parallel review group dispatches several implementers
// before any of them finishes, and each one's `armedAt` has to be its own:
// verify-gate.cjs measures "was this brief's verdict recorded after ITS
// OWN arming", and a single shared timestamp would let brief 6's fresh arm
// silently validate a verdict recorded for brief 5's much earlier one (or
// the reverse -- invalidate a genuinely fresh approval because a sibling was
// re-armed after it).
//
// Re-arming an already-armed brief resets armedAt to THIS dispatch's own
// time. Keeping the original armedAt (the earlier behaviour) let an
// APPROVED verdict recorded for the first dispatch go on covering a fix
// round or a re-dispatch of the same brief number later in the same
// session -- the new code never got its own review, since verify-gate.cjs
// only checks that a verdict postdates the brief's armedAt, and the old one
// was still on file. This does not lose a review already in flight: a
// verdict's `at` is stamped by verify-record.cjs only when the verdict is
// actually recorded, which is always after whatever dispatch prompted it --
// so resetting armedAt on a re-arm can only invalidate a STALE verdict from
// before this dispatch, never one still being written for it.
//
// This hook only ever arms. It NEVER blocks or denies the Agent dispatch --
// an implementer must always be free to start, and a hook that could refuse
// the dispatch would be a second gate nobody asked for.
//
// The second half of this file is unrelated to arming, but lives on the same
// PreToolUse hook for a reason: both halves exist to keep a SUBAGENT from
// controlling the orchestrator's own run state. `agent_id` is present in the
// hook payload only when the call originates inside a subagent (see the
// hooks guide: "Use this to distinguish subagent hook calls from main-thread
// calls") -- CLAUDE_CODE_CHILD_SESSION was tried first and rejected: it reads
// `1` in every shell Claude Code spawns, the main session's included
// (measured), so it cannot tell a subagent's Bash call apart from the
// orchestrator's own. A subagent's unconfigured `run-state.cjs start`
// re-pointed the orchestrator's live run on a real run; denying
// start|current|finish-brief|block from inside a subagent is the fix.
// `review-round`/`debug-round`/`begin-brief` are deliberately NOT denied here
// -- verify-record.cjs's own bump of review-round already runs with an
// explicit session id from the hook payload, not inherited from the
// subagent's shell, so it is not the same hazard this list exists for.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// "start --feature x", "current somefeature", "finish-brief 4", "block 4
// --reason x" -- anchored on the SUBCOMMAND POSITION: `run-state.cjs`,
// whitespace, then exactly one of start|current|finish-brief|block as the
// very NEXT WORD. A real invocation is always `node .../run-state.cjs
// <subcommand> ...`, so the subcommand is never anything but the first word
// after the script name -- matching anywhere after it (an earlier version)
// also caught the denied words as a SUBSTRING of an unrelated argument,
// denying `get --feature quick-start` or `get --feature block-parser`. `\b`
// on the trailing side keeps "block-parser" (a hyphen, not a word boundary
// before "parser") from matching the subcommand "block" followed by more of
// the same word, but "block" immediately followed by a space or end of
// string still matches.
//
// Matched against a NORMALISED copy of the command with every `'`, `"` and
// `\` stripped out first, not the raw text -- shell quoting or escaping
// around the subcommand itself (`run-state.cjs 'block' 4`,
// `run-state.cjs "finish-brief" 4`, `run-state.cjs \block 4`) is still
// exactly the subcommand as the next word once the shell's own quote/escape
// handling removes those characters, and stripping them here before matching
// is what a shell would do to them before `run-state.cjs` ever saw its
// argv. Stripping is safe for the allowed side too: quotes/backslashes
// removed from "quick-start" or "block-parser" leave no whitespace before
// the trailing letters, so the anchored `\s+(...)` still never matches them.
// Known, deliberately unchased evasions: a command built from string
// concatenation or a variable holding just the subcommand name bypasses
// this like any regex-based deny would.
const DENIED_SUBCOMMANDS = /\brun-state\.cjs\s+(start|current|finish-brief|block)\b/;
const stripQuoting = (s) => s.replace(/['"\\]/g, '');

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }

  if (process.env.SKIP_CODE_GATES === '1') allow();

  const tool = input?.tool_name || '';
  const hasAgentId = input?.agent_id !== undefined && input?.agent_id !== null && input.agent_id !== '';

  // A Bash/PowerShell call made from INSIDE a subagent, invoking a
  // run-state.cjs subcommand that would move the orchestrator's own run.
  if ((tool === 'Bash' || tool === 'PowerShell') && hasAgentId) {
    const command = input?.tool_input?.command || '';
    if (DENIED_SUBCOMMANDS.test(stripQuoting(command))) {
      return deny(
        'run-state.cjs start|current|finish-brief|block cannot be called from inside a subagent ' +
        '(this hook call carries agent_id): a subagent driving these would re-point or disarm the ' +
        "orchestrator's own run. Report back to the orchestrator instead of running this yourself."
      );
    }
    return allow();
  }

  // Everything else that is not an Agent dispatch from the main thread is
  // none of this hook's business.
  if (tool !== 'Agent' || hasAgentId) return allow();

  const subagentType = String(input?.tool_input?.subagent_type || '');
  const isImplementer = subagentType === 'implementer' || subagentType.endsWith(':implementer');
  if (!isImplementer) return allow();

  const prompt = input?.tool_input?.prompt || '';
  const firstLine = prompt.split('\n', 1)[0];
  // Case-insensitive, matching verify-record.cjs's own "Review BRIEF" check --
  // an implementer dispatched as "implement brief 4" is exactly as real a
  // dispatch as "Implement BRIEF 4", and the two hooks must agree on what
  // counts as a brief dispatch or arming and recording drift apart.
  const m = /^\s*Implement BRIEF (\d+)\b/i.exec(firstLine);
  if (!m) return allow();

  const session = input?.session_id;
  if (!session) return allow();
  // Joined straight into a directory path below (armDir), so a session id
  // shaped like a path traversal must never reach fs.mkdirSync/writeFileSync
  // at all -- the same rule run-state.cjs's own rejectUnsafeSessionId
  // applies to CLAUDE_CODE_SESSION_ID. A legitimate session id, handed to
  // this hook only by the harness, never looks like this.
  if (/[\\/]|\.\./.test(session)) return allow();

  // Stripped of leading zeros ("04" -> "4") so the arm key lines up with
  // run-state.cjs's own `String(Number(rest[0]))` normalisation and with
  // verify-gate.cjs's lookup -- otherwise "Implement BRIEF 04" would arm a
  // brief that nothing else in the pipeline ever calls "04".
  const n = String(Number(m[1]));
  const armDir = path.join(STATE_DIR, 'brief-exec', session);
  const armFile = path.join(armDir, `${n}.json`);
  // Always this dispatch's own time, even if the brief was already armed --
  // see the H2 comment above main(): an approval must postdate the LATEST
  // implementer dispatch for this brief, so a fix round or a same-numbered
  // brief later in the same session gets its own review instead of coasting
  // on a verdict recorded for the earlier dispatch.
  const armedAt = new Date().toISOString();
  try {
    fs.mkdirSync(armDir, { recursive: true });
    fs.writeFileSync(armFile, JSON.stringify({ armedAt }));
  } catch { /* a failed arm only means the gate never engages for this brief */ }

  allow();
});
