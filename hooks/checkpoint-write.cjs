#!/usr/bin/env node
// PreCompact: saves the thread of work so it survives compaction.
//
// Compaction keeps a summary, not the operating state: which brief was in flight,
// which directory the work is in, whether a reviewer had reported. /handoff does
// this deliberately at the end of a session; this does it automatically at the
// moment the context is about to be rewritten, which is where the loss actually
// happens.
//
// Kept deliberately small. The checkpoint is a pointer back to committed
// artefacts, not a second copy of the conversation.
const { runFor } = require('./run-state.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const session = input?.session_id;
  if (!session) process.exit(0);

  const arm = readJson(path.join(STATE_DIR, 'brief-exec', `${session}.json`));
  const review = readJson(path.join(STATE_DIR, 'brief-review', `${session}.json`));
  // The durable, feature-scoped state is the fallback a *different* session reads after
  // a crash; prefer it for the brief number when the session marker is absent.
  // Through the pointer, not off the disk: with several runs in one directory the
  // repo file said nothing about which one THIS session was driving.
  const durable = runFor(input?.cwd || process.cwd(), session);

  const dir = path.join(STATE_DIR, 'checkpoint');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({
      at: new Date().toISOString(),
      trigger: input?.trigger ?? null,
      cwd: input?.cwd ?? null,
      brief: arm?.brief ?? durable?.currentBrief ?? null,
      briefFile: arm?.file ?? durable?.briefFile ?? null,
      feature: durable?.feature ?? null,
      lastVerdict: review ? `brief ${review.brief}: ${review.verdict}` : null,
      transcript: input?.transcript_path ?? null,
    }));
  } catch { /* losing a checkpoint costs a re-read, not correctness */ }
  process.exit(0);
});
