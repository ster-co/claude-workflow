#!/usr/bin/env node
// PostToolUse AND PostToolUseFailure on Serena's reference tools: records that
// something was looked up this turn, which is what edit-gate.cjs checks before
// allowing a source edit. The marker is cleared at each user prompt, so the
// requirement is per-turn rather than once-per-session.
//
// Only tools that answer "what else touches this" count. find_symbol locates a
// definition and says nothing about its callers, so it is deliberately absent:
// accepting it would let a lookup that proves nothing open the gate.
//
// A lookup on a file with no symbols does not return empty — Serena raises,
// so the call arrives here as PostToolUseFailure rather than PostToolUse, and
// without this a colleague editing a symbol-free file could never satisfy the
// gate at all. "Nothing depends on this" is as real an answer as a populated
// result list, so a failure of that shape counts too — but not every failure:
// accepting a wrong path, a malformed call, or Serena being down would let
// something that never looked open the gate just as well as something that
// did. Checked live against a real Serena (2026-09-24): PostToolUseFailure's
// only error information is a free-text `error` string, e.g. "Error executing
// tool find_referencing_symbols: ValueError: No symbol matching 'X' found" for
// find_referencing_symbols/find_implementations, and "...ValueError: No match
// found for regex: X" for find_declaration — there is no separate error-code
// or error-type field to key on instead. NOTHING_FOUND_RE is a text match on
// that string for exactly that reason, and will need updating if Serena
// rewords either message.
const fs = require('fs');
const path = require('path');
const { markerPath, readStdin } = require('./gate-lib.cjs');

const SATISFYING_TOOLS = new Set([
  'find_referencing_symbols',
  'find_implementations',
  'find_declaration',
]);

const NOTHING_FOUND_RE = /\bValueError:\s*No\b[^\n]*\bfound\b/i;

// A user-level Serena is called as mcp__serena__<tool>. A plugin-provided one is
// renamed by Claude Code to mcp__plugin_<plugin-name>_<server-name>__<tool>,
// giving names like mcp__plugin_workflow-discipline_serena__find_referencing_symbols
// — the plugin name is not ours to assume, so this only checks that the server
// segment ends in "serena". Matching is done on the segment before the FINAL
// "__" (the tool name never contains "__" itself) rather than a fixed prefix
// list, so both naming forms are accepted without hardcoding any plugin's name.
function satisfies(toolName) {
  const i = toolName.lastIndexOf('__');
  if (i === -1) return false;
  const server = toolName.slice(0, i);
  const tool = toolName.slice(i + 2);
  if (!SATISFYING_TOOLS.has(tool)) return false;
  return server === 'mcp__serena' || (server.startsWith('mcp__plugin_') && server.endsWith('_serena'));
}

readStdin((input) => {
  const session = input?.session_id;
  if (!session) process.exit(0);
  if (!satisfies(input?.tool_name || '')) process.exit(0);

  const failed = input?.hook_event_name === 'PostToolUseFailure';
  // On failure, only a "looked and found nothing" answer counts. Anything
  // else (a bad call, a down server, a timeout) did not satisfy the
  // discipline the gate exists to enforce, so it must not open it.
  if (failed && !NOTHING_FOUND_RE.test(String(input?.error ?? ''))) process.exit(0);

  const m = markerPath('refs-checked', session);
  try {
    fs.mkdirSync(path.dirname(m), { recursive: true });
    fs.writeFileSync(m, JSON.stringify({
      at: new Date().toISOString(),
      tool: input.tool_name,
      target: input?.tool_input?.name_path ?? null,
      outcome: failed ? 'empty' : 'ok',
    }));
  } catch { /* a missing marker only means the gate asks again */ }
  process.exit(0);
});
