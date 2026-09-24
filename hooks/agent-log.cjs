#!/usr/bin/env node
// SubagentStart / SubagentStop: an append-only record of what was dispatched,
// which role it was, how long it took, and which brief it was working on.
//
// Why this exists: 851 Agent calls are on record with no breakdown at all — no
// cost per role, no idea how often the reviewer actually rejects, no way to
// check that /execute dispatched the roles it claims. The orchestrator's whole
// premise is that cheap work goes to cheap models; without a log that is an
// assertion rather than a measurement.
//
// Two rules this script must never break:
//   1. It must never throw and never exit non-zero. It runs on every subagent
//      dispatch; a logger that fails takes a real dispatch down with it.
//   2. It must print nothing on stdout. Anything printed lands in the transcript
//      on every dispatch, which is the opposite of cheap observability.
//
// The SubagentStart/SubagentStop payloads are NOT fully documented — the docs
// specify `agent_id` and `agent_type` and leave the rest open. So known fields
// are read by name and everything unrecognised is kept verbatim under `extra`:
// the first real orchestrator run then tells us the true schema instead of us
// guessing it in advance. Tighten this once there is a run to read.
const { runFor } = require('./run-state.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = process.env.CLAUDE_AGENT_LOG_DIR
  || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'state');
const LOG = path.join(LOG_DIR, 'agent-log.jsonl');
const PENDING = path.join(LOG_DIR, 'agent-pending.json');

// Fields we understand. Everything else on the payload goes to `extra`.
const KNOWN = new Set([
  'hook_event_name', 'session_id', 'agent_id', 'agent_type', 'cwd',
  'transcript_path', 'permission_mode', 'prompt_id', 'scratchpad_dir',
  'model', 'last_assistant_message',
]);

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
};

const append = (record) => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, `${JSON.stringify(record)}\n`);
  } catch { /* logging must never be the thing that fails */ }
};

// The brief in flight is what makes a duration mean something. It lives in the
// repo run state, which is also what survives a crash, so read it fresh each
// time rather than caching it on the start record alone.
// Resolved per session rather than per directory: two chats in one checkout drive
// different runs, and a log line stamped with the wrong feature is worse than one
// stamped with none -- it reads as evidence.
const runState = (cwd, session) => runFor(cwd || '.', session);

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  if (!input || typeof input !== 'object') process.exit(0);

  const event = input.hook_event_name;
  if (event !== 'SubagentStart' && event !== 'SubagentStop') process.exit(0);

  // Pair by agent_id where the platform gives one. It is the only field that
  // distinguishes two agents of the SAME role running concurrently, which is
  // the case a session-plus-role key silently collapses into one.
  const key = input.agent_id || `${input.session_id || '?'}:${input.agent_type || '?'}`;
  const now = Date.now();

  const extra = {};
  for (const [k, v] of Object.entries(input)) if (!KNOWN.has(k)) extra[k] = v;

  const record = {
    at: new Date(now).toISOString(),
    event: event === 'SubagentStart' ? 'start' : 'stop',
    agent: input.agent_type ?? null,
    id: input.agent_id ?? null,
    session: input.session_id ?? null,
  };
  if (input.model) record.model = input.model;
  if (Object.keys(extra).length) record.extra = extra;

  const rs = runState(input.cwd, input.session_id);
  if (rs && rs.currentBrief !== null && rs.currentBrief !== undefined) record.brief = rs.currentBrief;
  if (rs && rs.feature) record.feature = rs.feature;

  const pending = readJson(PENDING, {}) || {};

  if (event === 'SubagentStart') {
    pending[key] = now;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(PENDING, JSON.stringify(pending));
    } catch { /* an unpaired stop is still a useful line; see below */ }
  } else {
    // A stop with no recorded start is logged anyway — it happened, and losing
    // it would hide exactly the dispatches that crashed mid-flight. It is marked
    // unpaired rather than given a fabricated 0ms, which would read as a real
    // measurement in any later tally.
    const started = pending[key];
    record.paired = typeof started === 'number';
    record.ms = record.paired ? now - started : null;
    if (record.paired) {
      delete pending[key];
      try { fs.writeFileSync(PENDING, JSON.stringify(pending)); } catch { /* next run re-reads */ }
    }
  }

  append(record);
  process.exit(0);
});
