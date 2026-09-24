#!/usr/bin/env node
// PreToolUse gate on Edit|Write|Bash: no source edit until something was looked up.
//
// CLAUDE.md requires understanding callers and dependencies before a non-trivial
// change. That rule is advisory and gets skipped under load — measured at 4.8%
// compliance across 4,874 edits — so this turns it into a gate: a change to a
// source file in a Serena-configured repo is denied until a reference lookup has
// been recorded for this turn (refs-record.cjs writes the marker;
// discipline-reminder.cjs clears it at each user prompt).
//
// Bash is covered as well as Edit/Write, because two thirds of tool calls in
// this setup are Bash and file edits migrate there (`sed -i`, heredocs) under
// auto mode. An Edit|Write-only gate sees none of them. PowerShell is covered
// the same way: it is what Claude Code runs instead of Bash on Windows, and a
// gate that only recognised the tool name `Bash` let every write and commit on
// that platform through unexamined.
//
// Silent no-op everywhere else — repos with no Serena project config, non-source
// files, reads, missing state. Set SKIP_CODE_GATES=1 to disable.
const path = require('path');
const fs = require('fs');
const {
  markerPath, gatesDisabled, findGatedRoot, isSourceFile, bashWriteTargets,
  deny, readStdin,
} = require('./gate-lib.cjs');

function allow() { process.exit(0); }

function reason(targets, root) {
  const names = [...new Set(targets.map((t) => path.basename(t)))].slice(0, 5).join(', ');
  return (
    `No reference lookup has been run this turn, and ${names} lives in ${path.basename(root)}. ` +
    `Find out what depends on the symbol you are about to change — ` +
    `mcp__serena__find_referencing_symbols({name_path: "<symbol>", relative_path: "<file>"}) — ` +
    `report what it returns, then retry. ` +
    `No tool resolves a string reference (getattr, a scheduler registry, monkeypatch.setattr), ` +
    `so where one is plausible confirm with a grep as well: "no callers found" is not proof.`
  );
}

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const session = input?.session_id;
  if (!session) return allow();
  if (fs.existsSync(markerPath('refs-checked', session))) return allow();

  const tool = input?.tool_name || '';
  const cwd = input?.cwd || process.cwd();
  let targets = [];

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const fp = input?.tool_input?.file_path;
    if (fp) targets = [fp];
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    // Windows falls back to PowerShell as the primary shell tool when Git Bash
    // is absent; the command text lives in the same tool_input.command field,
    // so the same write-target scan applies unchanged.
    targets = bashWriteTargets(input?.tool_input?.command || '', cwd);
  } else {
    return allow();
  }

  const gated = targets.filter((t) => isSourceFile(t) && findGatedRoot(path.dirname(t)));
  if (!gated.length) return allow();

  deny(reason(gated, findGatedRoot(path.dirname(gated[0]))));
});
