#!/usr/bin/env node
// Stop: refuses to let a turn end while a brief is in flight and unreviewed.
//
// Why this exists as a hook rather than a rule: /execute already says "dispatch a
// reviewer briefed to disprove", and the measured failure is that the step gets
// skipped under time pressure — "state persistence is not working, all agents
// claimed to have finished". A sentence in a command file cannot enforce itself.
//
// The gate is ARMED, not always-on: it does nothing until something writes
// state/brief-exec/<session>.json, so ordinary sessions never see it. It clears
// when a matching verdict lands in state/brief-review/<session>.json.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

// Claude Code overrides a Stop hook after 8 consecutive blocks. Stand down before
// that: a gate the platform has to override is a gate the operator is fighting.
const MAX_BLOCKS = 5;

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }

  const allow = () => process.exit(0);

  if (process.env.SKIP_CODE_GATES === '1') allow();

  const session = input?.session_id;
  if (!session) allow();

  // The platform re-runs Stop hooks on the continuation turn; re-blocking there
  // loops the session against itself.
  if (input?.stop_hook_active) allow();

  const arm = readJson(path.join(STATE_DIR, 'brief-exec', `${session}.json`));
  if (!arm || !arm.brief) allow();

  const blockPath = path.join(STATE_DIR, 'brief-blocks', `${session}.json`);
  const blocks = readJson(blockPath)?.count ?? 0;
  if (blocks >= MAX_BLOCKS) {
    process.stdout.write(JSON.stringify({
      systemMessage:
        `Verification gate stood down after ${blocks} blocks: brief ${arm.brief} still has no ` +
        `reviewer verdict. Ending the turn anyway — record why in the brief file.`,
    }));
    process.exit(0);
  }

  const review = readJson(path.join(STATE_DIR, 'brief-review', `${session}.json`));
  const approved = review && String(review.brief) === String(arm.brief)
    && review.verdict === 'APPROVED';
  if (approved) allow();

  let why;
  if (!review) why = 'no reviewer has reported on it';
  else if (String(review.brief) !== String(arm.brief)) why = `the only verdict on file is for brief ${review.brief}`;
  else why = `the reviewer returned ${review.verdict}`;

  try {
    fs.mkdirSync(path.dirname(blockPath), { recursive: true });
    fs.writeFileSync(blockPath, JSON.stringify({ count: blocks + 1, at: new Date().toISOString() }));
  } catch { /* a lost counter only costs an extra block */ }

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `Brief ${arm.brief} is still in flight and ${why}. Dispatch a reviewer subagent briefed to ` +
      `disprove the change: it reads the diff and reruns the tests itself, never the implementer's ` +
      `report. It must end with a line "## Review Verdict" followed by APPROVED or REJECTED. ` +
      `If you are deliberately stopping without review, clear the marker at ` +
      `state/brief-exec/${session}.json and say so.`,
  }));
  process.exit(0);
});
