#!/usr/bin/env node
// Behavioural tests for once.cjs, the duplicate-delivery guard.
// Run: node hooks/test/test-once.cjs
//
// Every "wins" assertion is paired with one where the claim MUST be refused: a
// guard that never refuses de-duplicates nothing, and one that always refuses
// drops real events.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = path.join(__dirname, '..');
const { claim, eventKey, prune, WINDOW_MS, PRUNE_AFTER_MS } = require(path.join(HOOKS, 'once.cjs'));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'once-'));

console.log('\nonce.cjs — claim');
const T = 1_000_000;
check('the first delivery wins', claim(STATE, 'ns', 'k1', T), true);
check('a second delivery of the same key is refused', claim(STATE, 'ns', 'k1', T + 1), false);
check('a third is refused too', claim(STATE, 'ns', 'k1', T + 400), false);
check('a different key wins', claim(STATE, 'ns', 'k2', T + 2), true);
check('the same key in another namespace wins', claim(STATE, 'other', 'k1', T + 3), true);

// A resumed agent reports again under the same id, seconds later: a new event.
check('the same key after the window is a new event', claim(STATE, 'ns', 'k1', T + WINDOW_MS + 1), true);
check('and its own duplicate is refused', claim(STATE, 'ns', 'k1', T + WINDOW_MS + 2), false);
// The window runs from the delivery that won, not from the last refused one, so a
// stream of duplicates cannot keep an expired claim alive.
check('a delivery after the second window wins again', claim(STATE, 'ns', 'k1', T + 2 * WINDOW_MS + 10), true);

// Clocks are read in separate processes: a later arrival may carry an earlier stamp.
check('a delivery stamped before the winner is still a duplicate', claim(STATE, 'ns', 'jitter', T), true);
check('(refused)', claim(STATE, 'ns', 'jitter', T - 20), false);

console.log('\nonce.cjs — never the reason a hook fails');
const blocker = path.join(STATE, 'a-file');
fs.writeFileSync(blocker, 'x');
check('an unusable state dir lets the work proceed', claim(path.join(blocker, 'under-a-file'), 'ns', 'k', T), true);
check('and does so every time', claim(path.join(blocker, 'under-a-file'), 'ns', 'k', T + 1), true);

console.log('\nonce.cjs — eventKey');
const base = { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' };
check('an agent event is keyed by agent_id', eventKey(base) !== null, true);
check('stop and start of one agent are different events', eventKey(base) !== eventKey({ ...base, hook_event_name: 'SubagentStart' }), true);
check('two agents are different events', eventKey(base) !== eventKey({ ...base, agent_id: 'a2' }), true);
check('two sessions are different events', eventKey(base) !== eventKey({ ...base, session_id: 's2' }), true);
check('identical payloads share a key', eventKey(base), eventKey({ ...base }));
check('a tool event is keyed by tool_use_id', eventKey({ hook_event_name: 'PostToolUse', session_id: 's1', tool_use_id: 't1' }) !== null, true);
// No identity: nothing distinguishes a duplicate from a second event.
check('a payload with no identity has no key', eventKey({ hook_event_name: 'SubagentStop', session_id: 's1' }), null);
check('null input has no key', eventKey(null), null);

console.log('\nonce.cjs — prune');
const PDIR = path.join(STATE, 'once', 'pruned');
fs.mkdirSync(PDIR, { recursive: true });
const oldF = path.join(PDIR, 'old'), newF = path.join(PDIR, 'new');
fs.writeFileSync(oldF, 'x\n'); fs.writeFileSync(newF, 'x\n');
const longAgo = new Date(Date.now() - PRUNE_AFTER_MS - 60_000);
fs.utimesSync(oldF, longAgo, longAgo);
prune(PDIR);
check('a claim file older than a day is removed', fs.existsSync(oldF), false);
check('a recent one is kept', fs.existsSync(newF), true);

// The race the design exists for: processes that start together and claim one
// key must produce exactly one winner, whichever order they land in.
console.log('\nonce.cjs — concurrent deliveries');
const CHILD = `
  const { claim } = require(${JSON.stringify(path.join(HOOKS, 'once.cjs'))});
  process.stdout.write(String(claim(${JSON.stringify(STATE)}, 'race', process.argv[1])));
`;
const race = (key, n) => Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
  const c = spawn(process.execPath, ['-e', CHILD, key]);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', () => resolve(out));
})));
(async () => {
  let everyRoundHadOneWinner = true;
  for (let round = 0; round < 10; round++) {
    const results = await race(`round-${round}`, 8);
    if (results.filter((r) => r === 'true').length !== 1) everyRoundHadOneWinner = false;
  }
  check('10 rounds of 8 simultaneous claims each have exactly one winner', everyRoundHadOneWinner, true);

  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})();
