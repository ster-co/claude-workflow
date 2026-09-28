#!/usr/bin/env node
// PreToolUse gate on Bash `git commit`, symmetrical to edit-gate.cjs.
//
// CLAUDE.md requires reviewing the final diff before committing. Measured: 553
// commits against 98 checks corpus-wide, and one session made 51 commits with
// none. diff-record.cjs writes the marker when a `git diff` actually runs;
// discipline-reminder.cjs clears it at each user prompt, so the requirement is
// per-turn — one diff read covers a burst of commits in the same turn.
//
// `git status` deliberately does NOT satisfy this. It lists filenames and no
// content, so it is not evidence that anyone looked at what changed, which is
// the only thing the gate is for.
//
// Set SKIP_CODE_GATES=1 to disable.
const path = require('path');
const fs = require('fs');
const {
  markerPath, gatesDisabled, findGatedRoot, executableShell, deny, readStdin,
  gitSubcommandIs, gitRunDirs,
} = require('./gate-lib.cjs');

function allow() { process.exit(0); }

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const tool = input?.tool_name || '';
  // PowerShell is what Claude Code runs instead of Bash on Windows; the
  // command text lives in the same tool_input.command field either way.
  if (tool !== 'Bash' && tool !== 'PowerShell') return allow();

  const command = input?.tool_input?.command || '';
  const shell = executableShell(command);
  if (!gitSubcommandIs(shell, 'commit')) return allow();

  const session = input?.session_id;
  if (!session) return allow();
  if (fs.existsSync(markerPath('diff-reviewed', session))) return allow();

  // The repo that matters is the one the `git commit` actually runs in, not
  // the session's own directory — a `cd`/`-C` in the same command changes it.
  // When that can't be pinned down to one directory, every candidate is
  // checked and the commit is denied if any of them is gated (Decision 9).
  // gitRunDirs gets the RAW command, not `shell` (executableShell's
  // quote-blanked text) — it needs to see whether a `cd`/`-C` argument was
  // quoted in the original, which the blanking pass has already erased.
  const dirs = gitRunDirs(command, input?.cwd || process.cwd());
  let root = null;
  for (const dir of dirs) {
    root = findGatedRoot(dir);
    if (root) break;
  }
  if (!root) return allow();

  deny(
    `The diff has not been read this turn and ${path.basename(root)} is a gated repository. ` +
    `Run \`git diff\` (or \`git diff --cached\` for what is staged) and confirm the change ` +
    `touches only what you intended, report anything unexpected, then retry the commit. ` +
    `\`git status\` does not count: it names files and shows no content.`
  );
});

module.exports = { gitSubcommandIs };
