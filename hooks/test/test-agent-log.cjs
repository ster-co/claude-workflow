#!/usr/bin/env node
// Behavioural tests for agent-log.cjs (SubagentStart / SubagentStop).
// Run: node ~/.claude/hooks/test/test-agent-log.cjs
//
// Same discipline as the other hook tests: every assertion is paired with one
// where the hook MUST NOT fire. A logger that logs everything is as useless as
// one that logs nothing, because neither tells you what actually ran.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-agent-log.cjs -> hooks/test -> hooks: resolve from the
// script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// Each run gets its own state dir so the tests never read the real agent log.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlog-'));
const LOG = path.join(SANDBOX, 'agent-log.jsonl');

function run(input, { raw = null } = {}) {
  const r = spawnSync('node', [path.join(HOOKS, 'agent-log.cjs')], {
    input: raw !== null ? raw : JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_AGENT_LOG_DIR: SANDBOX },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = () => {
  try {
    return fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const reset = () => { try { fs.rmSync(LOG); } catch {} };

const start = (over = {}) => ({
  hook_event_name: 'SubagentStart',
  session_id: 'sess-1',
  agent_id: 'agent-aaa',
  agent_type: 'reviewer',
  cwd: SANDBOX,
  ...over,
});
const stop = (over = {}) => ({
  hook_event_name: 'SubagentStop',
  session_id: 'sess-1',
  agent_id: 'agent-aaa',
  agent_type: 'reviewer',
  cwd: SANDBOX,
  ...over,
});

// =============================================================================
console.log('\nagent-log.cjs — records a subagent run');
reset();

run(start());
let L = lines();
check('start writes one line', L.length, 1);
check('start line is an event', L[0]?.event, 'start');
check('start records the agent type', L[0]?.agent, 'reviewer');
check('start records the session', L[0]?.session, 'sess-1');

run(stop());
L = lines();
check('stop appends a second line', L.length, 2);
check('stop line is an event', L[1]?.event, 'stop');
check('stop carries the agent type', L[1]?.agent, 'reviewer');
check('stop measures a duration', typeof L[1]?.ms === 'number' && L[1].ms >= 0, true);

// =============================================================================
console.log('\nagent-log.cjs — pairs a stop with the right start');
reset();
// Two agents of DIFFERENT types running concurrently: each stop must be matched
// to its own start, not to whichever one happened to be written last.
run(start({ agent_id: 'a1', agent_type: 'implementer' }));
run(start({ agent_id: 'a2', agent_type: 'scout' }));
run(stop({ agent_id: 'a2', agent_type: 'scout' }));
L = lines();
check('the scout stop is attributed to the scout', L[2]?.agent, 'scout');
check('and it is paired, not orphaned', L[2]?.paired, true);

// Two agents of the SAME type: without per-id pairing these collapse into one.
reset();
run(start({ agent_id: 'b1', agent_type: 'reviewer' }));
run(start({ agent_id: 'b2', agent_type: 'reviewer' }));
run(stop({ agent_id: 'b1', agent_type: 'reviewer' }));
run(stop({ agent_id: 'b2', agent_type: 'reviewer' }));
L = lines();
check('two same-type agents produce two paired stops',
  L.filter((r) => r.event === 'stop' && r.paired).length, 2);

// MUST NOT claim a pairing it does not have: a stop with no start is still worth
// logging (it happened) but must be marked unpaired rather than given a bogus 0ms.
reset();
run(stop({ agent_id: 'never-started' }));
L = lines();
check('an unmatched stop is still logged', L.length, 1);
check('an unmatched stop is marked unpaired', L[0]?.paired, false);
check('an unmatched stop reports no duration', L[0]?.ms, null);

// =============================================================================
console.log('\nagent-log.cjs — carries the brief in flight');
reset();
// The whole point of this log is attributing cost to work. A run-state file in
// cwd names the brief; without it the field must be absent, not invented.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrepo-'));
fs.mkdirSync(path.join(REPO, 'docs'));
fs.writeFileSync(path.join(REPO, 'docs', '.run-state.json'),
  JSON.stringify({ feature: 'ship-command', currentBrief: 4 }));
run(start({ cwd: REPO }));
L = lines();
check('start records the brief in flight', L[0]?.brief, 4);
check('start records the feature', L[0]?.feature, 'ship-command');

reset();
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplain-'));
run(start({ cwd: PLAIN }));
L = lines();
check('no run state means no brief field', L[0]?.brief, undefined);

// =============================================================================
console.log('\nagent-log.cjs — never breaks the session');
reset();
// A logging hook that throws would take a real subagent dispatch down with it.
const bad = run(null, { raw: '{ not json at all' });
check('garbled stdin exits 0', bad.code, 0);
check('garbled stdin logs nothing', lines().length, 0);

const empty = run(null, { raw: '' });
check('empty stdin exits 0', empty.code, 0);

// MUST NOT fire: an unrelated event reaching this script writes nothing.
run({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: SANDBOX });
check('an unrelated hook event logs nothing', lines().length, 0);

// The hook must stay silent on stdout — anything it prints lands in the
// transcript on every single subagent dispatch.
reset();
const quiet = run(start());
check('the hook prints nothing to stdout', quiet.stdout, '');

// =============================================================================
console.log('\nagent-log.cjs — captures fields the docs do not specify');
reset();
// SubagentStart/Stop payloads are not fully documented. Recording unrecognised
// keys is how the first real orchestrator run tells us the true schema instead
// of us guessing it now.
run(start({ model: 'claude-opus-5', undocumented_thing: 42 }));
L = lines();
check('a known extra field is kept', L[0]?.model, 'claude-opus-5');
check('an unknown field is captured', L[0]?.extra?.undocumented_thing, 42);

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
try { fs.rmSync(PLAIN, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
