#!/usr/bin/env node
'use strict';
// Fixture hook for test-kill-gate.cjs: the kill gate's real runHook with a fixture
// decider in place of the gate's own decider mode, so the wall-clock budget can be timed
// against a decider that blocks, answers, or crashes.
//   KG_DECIDER     path of the fixture decider script (spawned with process.execPath)
//   KG_BUDGET_MS   the budget handed to runHook
//   KG_STARTED_AGO_MS  optional: pretend the hook process started this long ago
//   KG_BURN_MS     optional: busy-wait this long before calling runHook, with no startedAt
//                  passed, so the default deadline (process start + budget) is what is timed
const { runHook } = require('../../gates/kill-gate.cjs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
  const ago = Number(process.env.KG_STARTED_AGO_MS || 0);
  const burnUntil = Date.now() + Number(process.env.KG_BURN_MS || 0);
  while (Date.now() < burnUntil);
  runHook(input, {
    budgetMs: Number(process.env.KG_BUDGET_MS),
    deciderArgv: [process.env.KG_DECIDER],
    ...(ago ? { startedAt: Date.now() - ago } : {}),
  });
});
