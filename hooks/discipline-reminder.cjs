#!/usr/bin/env node
// UserPromptSubmit: clears the per-turn impact marker (see impact-gate.cjs) and
// re-injects the working rules that decay as context fills. CLAUDE.md is read once
// at session start; these are the rules that get dropped by turn forty.
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const session = input?.session_id;
  if (session) {
    // Both discipline markers are per-turn: one reference lookup and one diff
    // read cover the work done under a single user prompt.
    for (const kind of ['refs-checked', 'diff-reviewed']) {
      try {
        fs.unlinkSync(path.join(configDir, 'state', kind, `${session}.json`));
      } catch { /* absent is the normal case */ }
    }
  }

  const cwd = input?.cwd || process.cwd();
  const gated = fs.existsSync(path.join(cwd, '.serena', 'project.yml'));

  const rules = [
    'Standing rules for this turn:',
    '- Concise output style is active: lead with the result, cut narration, no closing recap. Headers and tables only where they carry structure.',
    '- Findings from a long investigation belong in a file, with one line in chat pointing at it — not pasted into terminal scrollback.',
    '- TDD: write the failing test, watch it fail for the right reason, then implement. A test that never failed proves nothing.',
    '- Verify before claiming done. Paste the command output; never assert a pass you did not run.',
    '- Never add AI attribution to a commit message, PR body, or issue.',
  ];
  if (gated) {
    rules.push('- This repo is gated: look up what references a symbol before editing it, and read the diff before committing. No tool resolves a string reference, so confirm with a grep where one is plausible.');
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: rules.join('\n') },
    suppressOutput: true,
  }));
  process.exit(0);
});
