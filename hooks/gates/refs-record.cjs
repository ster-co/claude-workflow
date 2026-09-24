#!/usr/bin/env node
// PostToolUse on Serena's reference tools: records that something was looked up
// this turn, which is what edit-gate.cjs checks before allowing a source edit.
// The marker is cleared at each user prompt, so the requirement is per-turn
// rather than once-per-session.
//
// Only tools that answer "what else touches this" count. find_symbol locates a
// definition and says nothing about its callers, so it is deliberately absent:
// accepting it would let a lookup that proves nothing open the gate.
const fs = require('fs');
const path = require('path');
const { markerPath, readStdin } = require('./gate-lib.cjs');

const SATISFYING = new Set([
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__find_implementations',
  'mcp__serena__find_declaration',
]);

readStdin((input) => {
  const session = input?.session_id;
  if (!session) process.exit(0);
  if (!SATISFYING.has(input?.tool_name || '')) process.exit(0);

  const m = markerPath('refs-checked', session);
  try {
    fs.mkdirSync(path.dirname(m), { recursive: true });
    fs.writeFileSync(m, JSON.stringify({
      at: new Date().toISOString(),
      tool: input.tool_name,
      target: input?.tool_input?.name_path ?? null,
    }));
  } catch { /* a missing marker only means the gate asks again */ }
  process.exit(0);
});
