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
} = require('./gate-lib.cjs');

function allow() { process.exit(0); }

// `git commit` as a command actually being run — not the words inside a commit
// message, a heredoc being written to a document, or an echoed reminder.
//
// Git's global flags sit between `git` and the subcommand, and several take a separate
// value token (`-c user.name=x`, `-C dir`, `--git-dir path`). Consuming the flag but not
// its value left `git -c user.name=x commit` unmatched, which bypassed the gate outright.
const VALUE_FLAGS = /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

function gitSubcommandIs(shell, name) {
  const tokens = shell.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const eq = tokens[j].includes('=');
      j += (VALUE_FLAGS.test(tokens[j]) && !eq) ? 2 : 1;
    }
    if (tokens[j] === name) return true;
  }
  return false;
}

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const tool = input?.tool_name || '';
  // PowerShell is what Claude Code runs instead of Bash on Windows; the
  // command text lives in the same tool_input.command field either way.
  if (tool !== 'Bash' && tool !== 'PowerShell') return allow();

  const command = input?.tool_input?.command || '';
  if (!gitSubcommandIs(executableShell(command), 'commit')) return allow();

  const session = input?.session_id;
  if (!session) return allow();
  if (fs.existsSync(markerPath('diff-reviewed', session))) return allow();

  const root = findGatedRoot(input?.cwd || process.cwd());
  if (!root) return allow();

  deny(
    `The diff has not been read this turn and ${path.basename(root)} is a gated repository. ` +
    `Run \`git diff\` (or \`git diff --cached\` for what is staged) and confirm the change ` +
    `touches only what you intended, report anything unexpected, then retry the commit. ` +
    `\`git status\` does not count: it names files and shows no content.`
  );
});

module.exports = { gitSubcommandIs };
