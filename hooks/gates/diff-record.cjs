#!/usr/bin/env node
// PostToolUse on Bash: records that a `git diff` actually ran this turn, which
// is what commit-gate.cjs checks before allowing a commit.
//
// This replaces the file-change tracking an earlier, locally-built call-graph
// indexing tool used as evidence — it recorded which files had been edited
// since its index was last rebuilt. The question the gate asks is unchanged —
// "do you know what this commit contains?" — and a diff answers it from the
// working tree rather than from a graph that has to be rebuilt to stay true.
//
// Deliberately narrow:
//   git diff / git diff --cached / git --no-pager diff --stat   -> counts
//   git status                                                  -> does NOT
//   git log, git show                                           -> do NOT
// `git status` names files and shows no content, so it is not evidence that
// anyone looked at the change. `git show` describes a commit that already
// exists, not the one about to be made.
const fs = require('fs');
const path = require('path');
const { markerPath, executableShell, readStdin } = require('./gate-lib.cjs');

// Global flags sit between `git` and the subcommand and some take a value —
// the same parsing the commit gate needs, for the same reason.
const VALUE_FLAGS = /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

function ranDiff(shell) {
  const tokens = shell.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const eq = tokens[j].includes('=');
      j += (VALUE_FLAGS.test(tokens[j]) && !eq) ? 2 : 1;
    }
    if (tokens[j] === 'diff') return true;
  }
  return false;
}

readStdin((input) => {
  const session = input?.session_id;
  if (!session) process.exit(0);
  if ((input?.tool_name || '') !== 'Bash') process.exit(0);

  // Quoted strings are data, not commands: a reminder that merely says
  // "run git diff first" is not a diff.
  if (!ranDiff(executableShell(input?.tool_input?.command || ''))) process.exit(0);

  const m = markerPath('diff-reviewed', session);
  try {
    fs.mkdirSync(path.dirname(m), { recursive: true });
    fs.writeFileSync(m, JSON.stringify({ at: new Date().toISOString() }));
  } catch { /* a missing marker only means the gate asks again */ }
  process.exit(0);
});

module.exports = { ranDiff };
