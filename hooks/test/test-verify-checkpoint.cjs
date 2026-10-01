#!/usr/bin/env node
// Behavioural tests for the verification gate and the compaction checkpoint.
// Run: node ~/.claude/hooks/test/test-verify-checkpoint.cjs
//
// Every assertion is paired: one case where the hook MUST fire and one where it
// MUST NOT. A guard that only ever fires is as useless as one that never does.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-verify-checkpoint.cjs -> hooks/test -> hooks: resolve from
// the script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');

// The hooks under test read <CLAUDE_CONFIG_DIR>/state. Pointing that at the live
// ~/.claude/state made this suite depend on whatever the operator's day had left
// there -- on 2026-09-22 a recorded plan-audit blocker turned `startup does not
// re-inject` and `compact with no checkpoint injects nothing` red, and /blueprint Step
// 3.5 mandates writing exactly that record. The fixtures below were also being
// written into live state. Own the directory instead.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-cfg-'));
const STATE = path.join(CONFIG, 'state');
fs.mkdirSync(STATE, { recursive: true });
let pass = 0, fail = 0;
const failures = [];

function run(script, input, env = {}) {
  const r = spawnSync('node', [path.join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SKIP_CODE_GATES: '', ...env },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
  return { out, stderr: r.stderr, code: r.status };
}

// Starts every job at once and blocks until all have exited. `spawnSync` on
// this process would serialise them end-to-end and never exercise a race, so
// a separate node driver spawns them asynchronously and this process waits on
// the driver. A node driver rather than `sh -c '... &\nwait'`: Windows has no
// `sh` on PATH, and there the shell form ran nothing at all. Each job is
// `{ script, stdin? }` -- a node script path and an optional file to feed it.
const CONCURRENT_DRIVER = `
  const { spawn } = require('child_process');
  const fs = require('fs');
  const jobs = JSON.parse(process.argv[1]);
  for (const j of jobs) {
    const stdin = j.stdin ? fs.openSync(j.stdin, 'r') : 'ignore';
    spawn(process.execPath, [j.script], { stdio: [stdin, 'ignore', 'inherit'] });
  }
`;
function concurrently(jobs, env) {
  spawnSync(process.execPath, ['-e', CONCURRENT_DRIVER, JSON.stringify(jobs)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SKIP_CODE_GATES: '', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// A Stop hook blocks by returning {"decision":"block"}; anything else lets the turn end.
const blocked = (res) => res.out?.decision === 'block';

const SID = 'test-verify-0001';
const armDir = path.join(STATE, 'brief-exec');
const reviewDir = path.join(STATE, 'brief-review');
const blockDir = path.join(STATE, 'brief-blocks');
const ckptDir = path.join(STATE, 'checkpoint');
const armFile = path.join(armDir, `${SID}.json`);
const reviewFile = path.join(reviewDir, `${SID}.json`);
const blockFile = path.join(blockDir, `${SID}.json`);
const ckptFile = path.join(ckptDir, `${SID}.json`);

const rm = (f) => { try { fs.unlinkSync(f); } catch {} };
const clean = () => [armFile, reviewFile, blockFile, ckptFile].forEach(rm);
const write = (f, obj) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
};
const readReviewOf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; } };

const stop = (sid = SID) => ({ hook_event_name: 'Stop', session_id: sid, cwd: process.cwd() });

// =============================================================================
console.log('\nverify-gate.cjs — blocks turn end while a brief is unreviewed');
clean();

// MUST NOT fire: an ordinary session that never armed the gate.
check('unarmed session: turn ends freely',
  blocked(run('verify-gate.cjs', stop())), false);

// MUST fire: a brief is in flight and no reviewer verdict was recorded.
write(armFile, { brief: '3', at: new Date().toISOString() });
check('armed + no verdict: blocks',
  blocked(run('verify-gate.cjs', stop())), true);

// MUST NOT fire: the reviewer recorded a verdict for that same brief.
write(reviewFile, { brief: '3', verdict: 'APPROVED', at: new Date().toISOString() });
check('armed + APPROVED verdict for the same brief: allows',
  blocked(run('verify-gate.cjs', stop())), false);

// MUST fire: a verdict exists, but for a different brief than the one in flight.
write(reviewFile, { brief: '2', verdict: 'APPROVED', at: new Date().toISOString() });
check('armed + verdict for a DIFFERENT brief: blocks',
  blocked(run('verify-gate.cjs', stop())), true);

// MUST fire: the reviewer explicitly rejected.
write(reviewFile, { brief: '3', verdict: 'REJECTED', at: new Date().toISOString() });
check('armed + REJECTED verdict: blocks',
  blocked(run('verify-gate.cjs', stop())), true);

// The reason must name the brief, or the block is unactionable.
write(reviewFile, { brief: '2', verdict: 'APPROVED', at: new Date().toISOString() });
const reason = run('verify-gate.cjs', stop()).out?.reason ?? '';
check('block reason names the brief in flight', /brief 3/i.test(reason), true);

// `run-state.cjs block <n>` only ever clears a PER-BRIEF arm file
// (disarmBriefArm) -- it never touches the legacy single-file marker this
// scenario is armed with (state/brief-exec/<session>.json). The message must
// say how to clear THAT marker too, or "block <n>" alone leaves the session
// still armed via the legacy file and the gate still firing.
check('block reason mentions clearing the legacy single-file marker too',
  /brief-exec\/[^\s]*\.json/.test(reason) || /legacy/i.test(reason), true);

// BRIEF 19 / M7: with no /ship run bound for this session/cwd (gate-arm.cjs
// arms from any implementer dispatch, /ship run or not), the block message
// must not tell the model to run `run-state.cjs block <n>` -- that command
// creates a run if none resolves (review-round's own save() falls back to
// runPath('unnamed')), leaving a phantom `unnamed.json` in /ship's table.
// Named instead: delete the arm file directly. Uses run-state's own
// read-only resolve() (via runFor/resolve, required from run-state.cjs) on a
// throwaway cwd that has never had a run started in it.
console.log('\nverify-gate.cjs — M7: no /ship run bound names deleting the arm file, not run-state.cjs block');
const NORUN_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-norun-'));
write(armFile, { brief: '3', at: new Date().toISOString() });
const norunRes = run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: SID, cwd: NORUN_REPO });
const norunReason = norunRes.out?.reason ?? '';
check('no run bound: the message does not INSTRUCT running `run-state.cjs block`',
  /disarm with `run-state\.cjs block/i.test(norunReason), false);
check('no run bound: the message instead instructs deleting the arm file directly',
  /disarm by deleting the arm file/i.test(norunReason), true);
check('no run bound: the message names the actual arm file path instead',
  norunReason.includes(path.join(STATE, 'brief-exec', `${SID}.json`)) ||
  norunReason.includes(`state/brief-exec/${SID}.json`), true);
fs.rmSync(NORUN_REPO, { recursive: true, force: true });
clean();

// Round 2 must-fix (M7 continued): the OTHER branch of runBound -- a session
// with a real /ship run bound (run-state.cjs start actually ran for this
// session/cwd) -- must still get told to run `run-state.cjs block <n>`, the
// advice that only makes sense once a run exists to disarm against. Without
// this case the whole runBound lookup could be hardcoded to false and every
// existing assertion would still pass, since the M7 case above never visits
// the true branch.
console.log('\nverify-gate.cjs — M7 continued: a session WITH a /ship run bound still gets `run-state.cjs block <n>`');
const BOUND_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-bound-'));
const boundRs = (args) => spawnSync('node', [path.join(HOOKS, 'run-state.cjs'), ...args], {
  cwd: BOUND_REPO, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_SESSION_ID: SID },
});
boundRs(['start', '--feature', 'verifyck-bound']);
write(armFile, { brief: '3', at: new Date().toISOString() });
const boundRes = run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: SID, cwd: BOUND_REPO });
const boundReason = boundRes.out?.reason ?? '';
check('run bound: the message INSTRUCTS running `run-state.cjs block <n>`',
  /disarm with `run-state\.cjs block/i.test(boundReason), true);
check('run bound: the message does not instruct deleting the arm file directly',
  /disarm by deleting the arm file/i.test(boundReason), false);
fs.rmSync(BOUND_REPO, { recursive: true, force: true });
clean();

// Escape hatch.
check('SKIP_CODE_GATES=1 allows the turn to end',
  blocked(run('verify-gate.cjs', stop(), { SKIP_CODE_GATES: '1' })), false);

// Never wedge a session: Claude Code overrides a Stop hook after 8 consecutive
// blocks, so stop blocking before that and say so rather than fighting it.
clean();
write(armFile, { brief: '3', at: new Date().toISOString() });
write(blockFile, { count: 5 });
check('after 5 consecutive blocks: stops blocking',
  blocked(run('verify-gate.cjs', stop())), false);

// A stop_hook_active turn must not be re-blocked (platform re-entry guard).
clean();
write(armFile, { brief: '3', at: new Date().toISOString() });
check('stop_hook_active: does not re-block',
  blocked(run('verify-gate.cjs', { ...stop(), stop_hook_active: true })), false);

// =============================================================================
console.log('\nverify-gate.cjs — several briefs armed at once');
clean();

// MUST fire: two briefs armed, only one has an APPROVED verdict on file.
write(armFile, { briefs: ['4', '5'], at: new Date().toISOString() });
write(reviewFile, { verdicts: { 4: { verdict: 'APPROVED', at: new Date().toISOString() } } });
const twoArmedRes = run('verify-gate.cjs', stop());
check('two armed, one approved: blocks', blocked(twoArmedRes), true);
check('and the message names the OTHER brief', /\b5\b/.test(twoArmedRes.out?.reason ?? ''), true);

// MUST NOT fire: both armed briefs have an APPROVED verdict.
write(reviewFile, {
  verdicts: {
    4: { verdict: 'APPROVED', at: new Date().toISOString() },
    5: { verdict: 'APPROVED', at: new Date().toISOString() },
  },
});
check('two armed, both approved: allows', blocked(run('verify-gate.cjs', stop())), false);

// The legacy single-brief marker keeps behaving exactly as before.
clean();
write(armFile, { brief: '3', at: new Date().toISOString() });
check('legacy single-brief marker: no verdict blocks',
  blocked(run('verify-gate.cjs', stop())), true);
write(reviewFile, { brief: '3', verdict: 'APPROVED', at: new Date().toISOString() });
check('legacy single-brief marker: APPROVED for it allows',
  blocked(run('verify-gate.cjs', stop())), false);
clean();

// A verdict left over from a PREVIOUS arming must not clear a NEW one.
// Verdicts pile up for the whole session keyed by bare brief number, so a
// session that approved brief 1 once keeps that record on disk -- arming
// brief 1 again for a later run must not read as already reviewed.
console.log('\nverify-gate.cjs — a stale verdict from a previous arming does not clear a new one');
clean();
write(armFile, { brief: '1', at: new Date().toISOString() });
// The arming's mtime is forced earlier than the verdict: on Windows the
// filesystem's clock can stamp the arm file a few ms past the `Date.now()` the
// verdict is written with, and the verdict would read as older than its arming.
const past = new Date(Date.now() - 60000);
fs.utimesSync(armFile, past, past);
write(reviewFile, { brief: '1', verdict: 'APPROVED', at: new Date().toISOString() });
check('brief 1 approved under the first arming: allows',
  blocked(run('verify-gate.cjs', stop())), false);

// Re-arm brief 1 (a new run's brief 1) with a LATER marker mtime, forced
// explicitly so the assertion cannot depend on how fast two writes land.
// No new verdict is recorded for it -- only the stale one from the first
// arming is on file.
write(armFile, { brief: '1', at: new Date().toISOString() });
const future = new Date(Date.now() + 60000);
fs.utimesSync(armFile, future, future);
check('re-armed brief 1 (later mtime) with only the earlier verdict on file: blocks',
  blocked(run('verify-gate.cjs', stop())), true);
clean();

// =============================================================================
// A verdict with a missing or unparseable `at` must NOT count as approved.
// verify-record.cjs always writes `at`, so this only happens for a
// hand-written or foreign review file -- but run-state.cjs's own
// hasFreshApproval (the check finish-brief relies on) already treats a
// missing/unparseable `at` as "not fresh", i.e. not approved. verify-gate.cjs
// must agree, or the Stop gate and finish-brief can disagree about whether
// the same brief is approved.
console.log('\nverify-gate.cjs — a verdict with no parseable `at` does not count as approved');
clean();
write(armFile, { brief: '4', at: new Date().toISOString() });
write(reviewFile, { verdicts: { 4: { verdict: 'APPROVED' } } });
check('armed + APPROVED verdict with `at` missing: blocks',
  blocked(run('verify-gate.cjs', stop())), true);

write(reviewFile, { verdicts: { 4: { verdict: 'APPROVED', at: 'bogus' } } });
check('armed + APPROVED verdict with `at` unparseable: blocks',
  blocked(run('verify-gate.cjs', stop())), true);
clean();

// =============================================================================
console.log('\nverify-record.cjs — records a reviewer verdict');
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review brief 3' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('writes a verdict marker', fs.existsSync(reviewFile), true);
let rec = {};
try { rec = JSON.parse(fs.readFileSync(reviewFile, 'utf-8')); } catch {}
check('captures the verdict', rec.verdict, 'APPROVED');
check('captures the brief number', rec.brief, '3');

// MUST NOT record: a subagent that was not a review produces no verdict.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'implement brief 4' },
  tool_response: { content: 'Done, all tests pass.' },
});
check('a non-review subagent writes no verdict', fs.existsSync(reviewFile), false);

// A review that reports no verdict line must not count as approval.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review brief 5' },
  tool_response: { content: 'Looks good to me overall.' },
});
check('review with no parseable verdict does not approve',
  fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf-8')).verdict : 'none',
  'UNPARSED');

// The brief comes from the FIRST LINE of the prompt ("Review BRIEF <n>"), not
// from the first "brief N" found anywhere -- a prompt reviewing brief 4 that
// goes on to mention brief 3 for context must still credit 4. The description
// names brief 3 too (`briefFrom(desc)` runs before `briefFrom(prompt)`), so a
// scan-anywhere fallback finds 3 FIRST and this only catches the regression
// if `firstLineBrief` actually wins -- a prompt where "BRIEF 4" merely happens
// to be the earliest match in the whole text would pass even with
// `firstLineBrief` removed.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: {
    description: 'review brief 3',
    prompt: 'Review BRIEF 4\n\nThis fix mirrors what brief 3 already does elsewhere.',
  },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('a first-line "Review BRIEF 4" credits 4, not the earlier scan-anywhere match of 3',
  JSON.parse(fs.readFileSync(reviewFile, 'utf-8')).brief, '4');

// The False pass this guards against: reading only the newest verdict
// (`{}` instead of `{...existing.verdicts}`) still passes every check above,
// because the "both approved" gate-test fixture below writes its review file
// by hand and never records twice. This drives TWO real records through the
// hook, for two different briefs on the SAME session, and checks neither one
// evicts the other.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review', prompt: 'Review BRIEF 4\n\nFirst of the pair.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review', prompt: 'Review BRIEF 5\n\nSecond of the pair.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
const bothRec = JSON.parse(fs.readFileSync(reviewFile, 'utf-8'));
check('recording brief 5 does not evict brief 4\'s verdict',
  bothRec.verdicts?.['4']?.verdict, 'APPROVED');
check('and brief 5\'s own verdict is recorded alongside it',
  bothRec.verdicts?.['5']?.verdict, 'APPROVED');
clean();

// A prompt with no first-line marker falls back to today's scan-anywhere rule.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: '', prompt: 'Please review brief 6 against its acceptance criteria.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('no first-line marker: falls back to scanning the prompt',
  JSON.parse(fs.readFileSync(reviewFile, 'utf-8')).brief, '6');
clean();

// =============================================================================
// BRIEF 18 (H1): on the PostToolUse path, when the dispatch carries a
// subagent_type, the ROLE decides -- exactly like SubagentStop already does --
// so an implementer's own result cannot self-approve merely by ending its
// report with the reviewer's sentinel. Only when NO subagent_type is present
// does the description/prompt fallback apply, unchanged.
console.log('\nverify-record.cjs (PostToolUse) — subagent_type decides over description/prompt when present');
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: {
    subagent_type: 'implementer',
    description: 'implement brief 4',
    prompt: 'Implement BRIEF 4\n\nA reviewer will review this.',
  },
  tool_response: { content: 'Done implementing.\n\n## Review Verdict\nAPPROVED\n' },
});
check('an implementer-typed dispatch ending in the sentinel records nothing',
  fs.existsSync(reviewFile), false);

// MUST: a bare `reviewer` subagent_type still records.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { subagent_type: 'reviewer', prompt: 'Review BRIEF 4\n\nChecked it.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('a bare "reviewer" subagent_type records', readReviewOf(reviewFile)?.verdict, 'APPROVED');

// MUST: a namespaced "<plugin>:reviewer" subagent_type still records, the
// same rule SubagentStop and gate-arm's implementer check already apply.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { subagent_type: 'workflow-discipline:reviewer', prompt: 'Review BRIEF 4\n\nChecked it.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('a namespaced "plugin:reviewer" subagent_type records',
  readReviewOf(reviewFile)?.verdict, 'APPROVED');

// MUST NOT: a role that merely ends in similar letters without the `:`
// separator is not a namespaced match, mirroring the SubagentStop guard.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { subagent_type: 'evil-reviewer', prompt: 'Review BRIEF 4\n\nChecked it.' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('"evil-reviewer" subagent_type does not record', fs.existsSync(reviewFile), false);

// MUST: `reviewer-lite` (the same reviewer at lower effort, picked by
// /subagent-mode fast) is a reviewer, bare or plugin-namespaced. Without this,
// a fast-mode review is never recorded and verify-gate blocks the turn.
for (const role of ['reviewer-lite', 'workflow-discipline:reviewer-lite']) {
  clean();
  run('verify-record.cjs', {
    hook_event_name: 'PostToolUse', session_id: SID,
    tool_input: { subagent_type: role, prompt: 'Review BRIEF 4\n\nChecked it.' },
    tool_response: { content: '## Review Verdict\nAPPROVED\n' },
  });
  check(`a "${role}" subagent_type records`, readReviewOf(reviewFile)?.verdict, 'APPROVED');
}

// MUST NOT: look-alikes of the lite name stay unmatched, exactly as for the base name.
for (const role of ['evil-reviewer-lite', 'reviewer-lite-x']) {
  clean();
  run('verify-record.cjs', {
    hook_event_name: 'PostToolUse', session_id: SID,
    tool_input: { subagent_type: role, prompt: 'Review BRIEF 4\n\nChecked it.' },
    tool_response: { content: '## Review Verdict\nAPPROVED\n' },
  });
  check(`"${role}" subagent_type does not record`, fs.existsSync(reviewFile), false);
}

// MUST: with NO subagent_type at all, the old description/prompt fallback
// still applies -- a payload that predates the field, or a harness that omits
// it, must not silently stop recording real reviews.
clean();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review brief 3' },
  tool_response: { content: '## Review Verdict\nAPPROVED\n' },
});
check('with no subagent_type, the description/prompt fallback still records',
  readReviewOf(reviewFile)?.verdict, 'APPROVED');
clean();

// =============================================================================
// BRIEF 18 (H3): the read-modify-write of the review file must be serialised
// with a lock, the same pattern run-state.cjs uses, or concurrent recordings
// splice into a corrupt file and lose verdicts (measured 10/10 with no lock).
// `concurrently` starts all three `verify-record.cjs` invocations at once and
// blocks until every one has exited. Each gets its input on stdin from its own
// scratch file.
console.log('\nverify-record.cjs — concurrent recordings under load keep every verdict (H3)');
{
  const briefs = ['20', '21', '22'];
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-h3-in-'));
  const inputFiles = briefs.map((n) => {
    const f = path.join(inputDir, `${n}.json`);
    fs.writeFileSync(f, JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: SID,
      tool_input: { subagent_type: 'reviewer', prompt: `Review BRIEF ${n}\n\nConcurrent run.` },
      tool_response: { content: '## Review Verdict\nAPPROVED\n' },
    }));
    return f;
  });
  const jobs = inputFiles.map((f) => ({ script: path.join(HOOKS, 'verify-record.cjs'), stdin: f }));

  let allKept = true;
  for (let iter = 0; iter < 10; iter++) {
    clean();
    concurrently(jobs);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(reviewFile, 'utf-8')); } catch {}
    const kept = briefs.every((n) => rec?.verdicts?.[n]?.verdict === 'APPROVED');
    if (!kept) allKept = false;
  }
  check('10x three concurrent recordings keep all three verdicts', allKept, true);
  fs.rmSync(inputDir, { recursive: true, force: true });
}
clean();

// =============================================================================
// The reviewer's verdict does not come back through the tool result. Measured on
// Claude Code 2.1.278: an Agent dispatch returns
// {handback:'send', content:[{text:"…delivered to you as a message from <id>"}]}
// and the report itself lives in the subagent's transcript. Recording from the
// receipt parsed a verdict out of the harness's own prose.
console.log('\nverify-record.cjs — a review handed back, not returned');

const TRANSCRIPT = path.join(os.tmpdir(), `vr-transcript-${process.pid}.jsonl`);
const writeTranscript = (blocks) => fs.writeFileSync(TRANSCRIPT,
  blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
const asked = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const handback = (message) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] },
});
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const subagentStop = (over = {}) => run('verify-record.cjs', {
  hook_event_name: 'SubagentStop', session_id: SID, cwd: process.cwd(),
  agent_type: 'reviewer', agent_id: 'r1', agent_transcript_path: TRANSCRIPT,
  ...over,
});
const readReview = () => { try { return JSON.parse(fs.readFileSync(reviewFile, 'utf-8')); } catch { return null; } };

clean();
writeTranscript([
  asked('Review brief 7 against its acceptance criteria.'),
  handback('Ran the suite myself.\n\n## Review Verdict\nAPPROVED\n'),
  said('Report delivered.'),
]);
subagentStop();
check('a handed-back verdict is read from the reviewer transcript', readReview()?.verdict, 'APPROVED');
check('and the brief comes from the dispatch prompt', readReview()?.brief, '7');

// MUST NOT: the ROLE decides, not the prompt. An implementer handed a
// review-shaped brief must not clear the review gate.
clean();
subagentStop({ agent_type: 'implementer' });
check('an implementer finishing writes no verdict', fs.existsSync(reviewFile), false);

// BRIEF 17: a plugin-namespaced reviewer ("<plugin>:reviewer") must still
// clear the gate, the same way gate-arm.cjs already accepts
// "<plugin>:implementer". Found live via --plugin-dir dispatch.
clean();
subagentStop({ agent_type: 'workflow-discipline:reviewer' });
check('a plugin-namespaced reviewer records', readReview()?.verdict, 'APPROVED');

// MUST NOT: a role name that merely ends with the same letters, or is
// prefixed without a `:` separator, is not a namespaced match.
clean();
subagentStop({ agent_type: 'evil-reviewer' });
check('"evil-reviewer" is not a namespaced match', fs.existsSync(reviewFile), false);

clean();
subagentStop({ agent_type: 'reviewer-helper' });
check('"reviewer-helper" is not a namespaced match', fs.existsSync(reviewFile), false);

// The lite reviewer on the SubagentStop branch, same rules as PostToolUse.
for (const role of ['reviewer-lite', 'workflow-discipline:reviewer-lite']) {
  clean();
  subagentStop({ agent_type: role });
  check(`a "${role}" finishing records (SubagentStop)`, readReview()?.verdict, 'APPROVED');
}
for (const role of ['evil-reviewer-lite', 'reviewer-lite-x']) {
  clean();
  subagentStop({ agent_type: role });
  check(`"${role}" is not a match (SubagentStop)`, fs.existsSync(reviewFile), false);
}

clean();
subagentStop({ agent_type: 'x:reviewer-2' });
check('"x:reviewer-2" is not a namespaced match', fs.existsSync(reviewFile), false);

// Only when the harness reports no role does the prompt decide, so a payload
// change degrades to the old behaviour instead of to silence.
clean();
subagentStop({ agent_type: undefined });
check('with no role reported, a review-shaped prompt still records', readReview()?.verdict, 'APPROVED');
clean();
writeTranscript([asked('Implement brief 7.'), handback('## Review Verdict\nAPPROVED\n')]);
subagentStop({ agent_type: undefined });
check('and a non-review prompt with no role records nothing', fs.existsSync(reviewFile), false);
writeTranscript([
  asked('Review brief 7 against its acceptance criteria.'),
  handback('Ran the suite myself.\n\n## Review Verdict\nAPPROVED\n'),
  said('Report delivered.'),
]);

// A rejection must be recorded as a rejection, not swallowed.
clean();
writeTranscript([asked('Review brief 7.'), handback('## Review Verdict\nREJECTED\nMust-fix: the test never fails.')]);
subagentStop();
check('a handed-back REJECTED is recorded as such', readReview()?.verdict, 'REJECTED');

// The overwrite. SubagentStop fires first and PostToolUse fires second, so a
// PostToolUse that still parsed the receipt would replace a real APPROVED with
// an UNPARSED read out of the harness's delivery note.
clean();
writeTranscript([asked('Review brief 7.'), handback('## Review Verdict\nAPPROVED\n')]);
subagentStop();
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SID,
  tool_input: { description: 'review brief 7' },
  tool_response: {
    status: 'completed', handback: 'send', agentId: 'r1',
    content: [{ type: 'text', text: "This agent's report was delivered to you as a message from \"r1\"." }],
  },
});
check('the receipt that follows does not overwrite the recorded verdict',
  readReview()?.verdict, 'APPROVED');

try { fs.unlinkSync(TRANSCRIPT); } catch {}
clean();

// =============================================================================
// A REJECTED verdict has to bump the counter run-state.cjs actually reads --
// /execute's two-REJECTED escalation to the debugger reads inFlight[n] through
// `get`, not whatever a hook wrote straight to the file. This drives the bump
// through run-state.cjs's own CLI (its atomic writer) and reads it back the
// same way, on a run with TWO briefs in flight, so a rejection on one cannot be
// mistaken for a rejection on the other.
console.log('\nverify-record.cjs — a REJECTED verdict bumps run-state.cjs, not a raw write');
clean();
const RRCONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-rrcfg-'));
const RRREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-rrrepo-'));
const RRSID = 'test-verify-rr-0001';
const rrRs = (args) => spawnSync('node', [path.join(HOOKS, 'run-state.cjs'), ...args], {
  cwd: RRREPO, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: RRCONFIG, CLAUDE_CODE_SESSION_ID: RRSID },
});
const rrGet = () => { try { return JSON.parse(rrRs(['get']).stdout); } catch { return null; } };
rrRs(['start', '--feature', 'verify-rr']);
rrRs(['begin-brief', '4']);
rrRs(['begin-brief', '5']);
check('two briefs begin at reviewRounds 0',
  [rrGet()?.inFlight?.['4']?.reviewRounds, rrGet()?.inFlight?.['5']?.reviewRounds], [0, 0]);

run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: RRSID, cwd: RRREPO,
  tool_input: { description: 'review', prompt: 'Review BRIEF 4\n\nSee also brief 5 for the paired case.' },
  tool_response: { content: '## Review Verdict\nREJECTED\nMust-fix: still red.' },
}, { CLAUDE_CONFIG_DIR: RRCONFIG });

check('REJECTED bumps THAT brief\'s reviewRounds, read via run-state.cjs get',
  rrGet()?.inFlight?.['4']?.reviewRounds, 1);
check('and leaves the OTHER brief in flight untouched',
  rrGet()?.inFlight?.['5']?.reviewRounds, 0);

for (const d of [RRCONFIG, RRREPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
clean();

// =============================================================================
// Passing no brief must not drop the bump. `review-round` with no number
// already defaults to the run's currentBrief -- that is today's behaviour and
// must survive a REJECTED verdict that names no brief at all (e.g. "Review the
// staged diff", which no rule here can attach a number to).
console.log('\nverify-record.cjs — a REJECTED verdict naming no brief still bumps the current one');
clean();
const NBCONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-nbcfg-'));
const NBREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-nbrepo-'));
const NBSID = 'test-verify-nb-0001';
const nbRs = (args) => spawnSync('node', [path.join(HOOKS, 'run-state.cjs'), ...args], {
  cwd: NBREPO, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: NBCONFIG, CLAUDE_CODE_SESSION_ID: NBSID },
});
const nbGet = () => { try { return JSON.parse(nbRs(['get']).stdout); } catch { return null; } };
nbRs(['start', '--feature', 'verify-nb']);
nbRs(['begin-brief', '3']);
check('brief 3 begins at reviewRounds 0', nbGet()?.inFlight?.['3']?.reviewRounds, 0);

run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: NBSID, cwd: NBREPO,
  tool_input: { description: '', prompt: 'Review the staged diff' },
  tool_response: { content: '## Review Verdict\nREJECTED\nMust-fix: nothing here names a brief.' },
}, { CLAUDE_CONFIG_DIR: NBCONFIG });

check('with no brief identified, the bump still lands on currentBrief',
  nbGet()?.inFlight?.['3']?.reviewRounds, 1);

// BRIEF 18 (M2): a prompt whose FIRST LINE is not "Review BRIEF <n>" but
// whose prose elsewhere mentions "brief 3" must NOT bump brief 3's counter --
// only the reviewer prompt's first-line convention identifies a brief for the
// bump; a number merely scanned out of prose falls through to the no-brief
// case (bump the current brief, touch no in-flight entry for the scanned
// number). Brief 4 is begun here specifically so a wrongly-scanned "3" would
// be distinguishable from "the current brief"; brief 3 already sits at
// reviewRounds 1 from the case just above, and the assertion is that THIS
// verdict leaves it there rather than bumping it to 2.
nbRs(['begin-brief', '4']);
check('brief 4 begins at reviewRounds 0', nbGet()?.inFlight?.['4']?.reviewRounds, 0);

run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: NBSID, cwd: NBREPO,
  tool_input: {
    description: 'review',
    prompt: 'Looks consistent with how brief 3 handled the same case.',
  },
  tool_response: { content: '## Review Verdict\nREJECTED\nMust-fix: still red.' },
}, { CLAUDE_CONFIG_DIR: NBCONFIG });

check('a prose mention of "brief 3" with no first-line marker bumps the CURRENT brief',
  nbGet()?.inFlight?.['4']?.reviewRounds, 1);
check('and leaves brief 3\'s count untouched by the number scanned out of prose',
  nbGet()?.inFlight?.['3']?.reviewRounds, 1);

for (const d of [NBCONFIG, NBREPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
clean();

// =============================================================================
// A REJECTED verdict on a session/cwd with no run at all must bump nothing --
// `review-round`'s own save() falls back to runPath('unnamed') when no run
// resolves, and a direct call would otherwise leave a phantom
// state/ship-runs/<key>/unnamed.json that shows up as a run in /ship's table.
console.log('\nverify-record.cjs — a REJECTED verdict with no run resolved creates no phantom run');
clean();
const PHCONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-phcfg-'));
const PHREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-phrepo-'));
const PHSID = 'test-verify-ph-0001';
run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: PHSID, cwd: PHREPO,
  tool_input: { description: 'review', prompt: 'Review BRIEF 2\n\nNo run was ever started for this session.' },
  tool_response: { content: '## Review Verdict\nREJECTED\nMust-fix: still red.' },
}, { CLAUDE_CONFIG_DIR: PHCONFIG });
const shipRunsDir = path.join(PHCONFIG, 'state', 'ship-runs');
const anyRunFiles = fs.existsSync(shipRunsDir)
  ? fs.readdirSync(shipRunsDir).flatMap((d) => {
      try { return fs.readdirSync(path.join(shipRunsDir, d)); } catch { return []; }
    })
  : [];
check('no run resolves: no phantom run file is created', anyRunFiles.length, 0);
for (const d of [PHCONFIG, PHREPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
clean();

// =============================================================================
// BRIEF 18 (11g): a spawn failure on the review-round bump must not fail
// silently -- it writes a one-line stderr warning, and the gate still holds
// the turn either way. Reused: `resolve()` keys on repoKey(cwd) via the
// session pointer, a plain string hash, so a cwd that has since been removed
// from disk still resolves the SAME run it was created against -- which is
// exactly what turns the child's spawnSync into an ENOENT (spawning `node`
// with a working directory that no longer exists) without touching the
// installed run-state.cjs at all.
console.log('\nverify-record.cjs — a spawn failure on the bump writes a stderr warning (11g)');
clean();
const SFCONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-sfcfg-'));
const SFREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-sfrepo-'));
const SFSID = 'test-verify-sf-0001';
const sfRs = (args) => spawnSync('node', [path.join(HOOKS, 'run-state.cjs'), ...args], {
  cwd: SFREPO, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: SFCONFIG, CLAUDE_CODE_SESSION_ID: SFSID },
});
sfRs(['start', '--feature', 'verify-sf']);
sfRs(['begin-brief', '4']);
// The CHILD's own process.cwd() (what run-state.cjs actually hashed into
// repoKey when it ran) is the realpath -- macOS mktemp paths live under
// /var, itself a symlink to /private/var. Resolving here, before the
// directory is removed, is what keeps this process's later cwd string
// hashing to the SAME repoKey the run was created under.
const sfRealRepo = fs.realpathSync(SFREPO);
fs.rmSync(SFREPO, { recursive: true, force: true });

const sfRes = run('verify-record.cjs', {
  hook_event_name: 'PostToolUse', session_id: SFSID, cwd: sfRealRepo,
  tool_input: { description: 'review', prompt: 'Review BRIEF 4\n\nStill failing.' },
  tool_response: { content: '## Review Verdict\nREJECTED\nMust-fix: still red.' },
}, { CLAUDE_CONFIG_DIR: SFCONFIG });
check('a spawn failure on the bump writes a stderr warning',
  /review-round bump failed/.test(sfRes.stderr), true);
check('and the verdict is still recorded despite the failed bump',
  readReviewOf(path.join(SFCONFIG, 'state', 'brief-review', `${SFSID}.json`))?.verdict, 'REJECTED');
for (const d of [SFCONFIG, SFREPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
clean();

// =============================================================================
// BRIEF 18 round 2 (must-fix 1): a lock that cannot be taken must fail
// LOUDLY, not with a silent `catch {}` -- a stale lock left by a crashed
// pid otherwise makes a reviewer's APPROVED exit 0 with nothing recorded
// and nothing on stderr to explain why. The lock path and the verdict that
// was dropped must both be named; a dead holder pid must be called "stale"
// with the exact `rm <path>` to clear it, since automatic takeover-by-path
// was proven unsafe elsewhere (run-state.cjs's own history).
console.log('\nverify-record.cjs — a lock that cannot be taken fails loudly (must-fix 1)');
clean();
{
  const DEAD_PID = 999999;
  try { process.kill(DEAD_PID, 0); throw new Error('DEAD_PID is unexpectedly alive; pick another'); }
  catch (err) { if (err.code !== 'ESRCH') throw err; }
  fs.mkdirSync(reviewDir, { recursive: true });
  const lockPath = `${reviewFile}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: 'stale-token', at: new Date().toISOString() }));

  const res = run('verify-record.cjs', {
    hook_event_name: 'PostToolUse', session_id: SID,
    tool_input: { description: 'review', prompt: 'Review BRIEF 9\n\nChecked it.' },
    tool_response: { content: '## Review Verdict\nAPPROVED\n' },
  });
  check('a stale dead-pid lock still exits 0 (the gate just asks again)', res.code, 0);
  check('stderr names the verdict as not recorded', /not recorded/i.test(res.stderr), true);
  check('stderr names the lock path', res.stderr.includes(lockPath), true);
  check('stderr calls a dead holder stale', /stale/i.test(res.stderr), true);
  check('stderr gives the exact rm command to clear it', res.stderr.includes(`rm ${lockPath}`), true);
  check('nothing is recorded while the stale lock stands', fs.existsSync(reviewFile), false);
  fs.unlinkSync(lockPath);
}
clean();

// A held lock (alive holder) at timeout must report "held", not "stale", and
// must likewise record nothing -- this process's OWN pid is guaranteed alive
// for the duration of the run below.
console.log('\nverify-record.cjs — a live-held lock at timeout is reported as held, not stale');
clean();
{
  fs.mkdirSync(reviewDir, { recursive: true });
  const lockPath = `${reviewFile}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-token', at: new Date().toISOString() }));

  const res = run('verify-record.cjs', {
    hook_event_name: 'PostToolUse', session_id: SID,
    tool_input: { description: 'review', prompt: 'Review BRIEF 9\n\nChecked it.' },
    tool_response: { content: '## Review Verdict\nAPPROVED\n' },
  });
  check('stderr calls a live holder held, not stale', /held by pid/i.test(res.stderr), true);
  check('stderr does not call a live holder stale', /stale/i.test(res.stderr), false);
  check('a held lock at timeout never writes unlocked: nothing recorded', fs.existsSync(reviewFile), false);
  fs.unlinkSync(lockPath);
}
clean();

// A release must never delete a lock whose token on disk is no longer its
// own -- standing in for a different writer having cleared and recreated the
// lock in between (e.g. a mistaken manual `rm` followed by a second
// recorder). VERIFY_RECORD_TEST_RMW_DELAY_MS widens the window between
// acquiring the lock and releasing it, the same test-only hook run-state.cjs's
// `save()` uses, so a second, truly concurrent process (started by
// `concurrently`, as in the H3 race above) can swap the token underneath the
// recorder while it still holds the lock, deterministically rather than
// racing scheduling luck.
console.log('\nverify-record.cjs — release never deletes a lock whose token is not its own');
clean();
{
  const inputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verifyck-reltok-')), 'in.json');
  fs.writeFileSync(inputFile, JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: SID,
    tool_input: { description: 'review', prompt: 'Review BRIEF 9\n\nChecked it.' },
    tool_response: { content: '## Review Verdict\nAPPROVED\n' },
  }));
  const lockPath = `${reviewFile}.lock`;
  const foreignToken = 'foreign-token-xyz';
  const swapFile = path.join(path.dirname(inputFile), 'swap.js');
  fs.writeFileSync(swapFile, `
    const fs = require('fs');
    const lockPath = ${JSON.stringify(lockPath)};
    // Waits for the recorder's own token, not just the file: the lock exists
    // from the open, a moment before the recorder writes its token into it,
    // and a swap in that moment is overwritten by the recorder's own write.
    const holdsToken = () => { try { return !!JSON.parse(fs.readFileSync(lockPath, 'utf8')).token; } catch { return false; } };
    const deadline = Date.now() + 10000;
    while (!holdsToken() && Date.now() < deadline) {}
    if (holdsToken()) {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999998, token: ${JSON.stringify(foreignToken)}, at: new Date().toISOString() }));
    }
  `);
  concurrently([
    { script: path.join(HOOKS, 'verify-record.cjs'), stdin: inputFile },
    { script: swapFile },
  ], { VERIFY_RECORD_TEST_RMW_DELAY_MS: '400' });
  const lockAfter = (() => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch { return null; } })();
  check('release leaves a lock whose token it does not own untouched',
    lockAfter && lockAfter.token, foreignToken);
  try { fs.unlinkSync(lockPath); } catch { /* a broken releaseLock may have already removed it */ }
  fs.rmSync(path.dirname(inputFile), { recursive: true, force: true });
}
clean();
clean();
const preCompact = {
  hook_event_name: 'PreCompact', session_id: SID, cwd: '/tmp/somewhere',
  transcript_path: '/nonexistent/transcript.jsonl',
};
write(armFile, { brief: '7', at: new Date().toISOString() });
run('checkpoint-write.cjs', preCompact);
check('writes a checkpoint', fs.existsSync(ckptFile), true);
let ck = {};
try { ck = JSON.parse(fs.readFileSync(ckptFile, 'utf-8')); } catch {}
check('checkpoint carries the brief in flight', ck.brief, '7');
check('checkpoint carries the cwd', ck.cwd, '/tmp/somewhere');

// The per-brief directory gate-arm.cjs writes, with no legacy marker at all.
clean();
const cwPerBriefDir = path.join(armDir, SID);
fs.mkdirSync(cwPerBriefDir, { recursive: true });
fs.writeFileSync(path.join(cwPerBriefDir, '11.json'), JSON.stringify({ armedAt: new Date().toISOString() }));
run('checkpoint-write.cjs', preCompact);
let ck2 = {};
try { ck2 = JSON.parse(fs.readFileSync(ckptFile, 'utf-8')); } catch {}
check('checkpoint carries a brief from the per-brief arm directory', ck2.brief, '11');
try { fs.rmSync(cwPerBriefDir, { recursive: true, force: true }); } catch {}

// Restore the legacy-marker checkpoint (brief 7) that the next section relies on.
clean();
write(armFile, { brief: '7', at: new Date().toISOString() });
run('checkpoint-write.cjs', preCompact);

// =============================================================================
console.log('\ncheckpoint-restore.cjs — SessionStart re-injects it');
// MUST fire: resuming after a compaction, with a checkpoint present.
const restored = run('checkpoint-restore.cjs', {
  hook_event_name: 'SessionStart', session_id: SID, source: 'compact',
});
const ctx = restored.out?.hookSpecificOutput?.additionalContext ?? '';
check('compact restore mentions the brief', /brief 7/i.test(ctx), true);

// MUST NOT fire: a fresh startup is not a compaction and gets no injection.
const fresh = run('checkpoint-restore.cjs', {
  hook_event_name: 'SessionStart', session_id: SID, source: 'startup',
});
check('startup does not re-inject',
  (fresh.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// MUST fire: `/clear` wipes the context but keeps the session, so the session
// checkpoint is still on disk under this id and is the best source available.
// SessionStart's matcher values are startup|resume|clear|compact|fork, and
// `clear` is its own value — a config matching only compact|resume|startup
// restores nothing at all after a /clear.
const cleared = run('checkpoint-restore.cjs', {
  hook_event_name: 'SessionStart', session_id: SID, source: 'clear',
});
check('clear re-injects the session checkpoint',
  /brief 7/i.test(cleared.out?.hookSpecificOutput?.additionalContext ?? ''), true);

// MUST NOT fire: a compaction with no checkpoint on disk injects nothing.
rm(ckptFile);
const none = run('checkpoint-restore.cjs', {
  hook_event_name: 'SessionStart', session_id: SID, source: 'compact',
});
check('compact with no checkpoint injects nothing',
  (none.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// =============================================================================
// A blocker that nobody resolved before the session ended has to be in front of
// you when you come back. The audit marker already records which ids block and,
// since summaries were added, what each one was -- so this is surfacing, not new
// state.
console.log('\ncheckpoint-restore.cjs — unresolved plan blockers survive the session');

const BCONF = fs.mkdtempSync(path.join(os.tmpdir(), 'blockconf-'));
const BREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'blockrepo-'));
fs.mkdirSync(path.join(BREPO, 'docs', 'plans'), { recursive: true });
const BPLAN = path.join(BREPO, 'docs', 'plans', '2026-09-22-thing.md');
const crypto = require('crypto');
const bKey = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);
const { planBodyHash } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
const putMarker = (over = {}) => {
  const dir = path.join(BCONF, 'state', 'plan-audited');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${bKey(BPLAN)}.json`), JSON.stringify({
    plan: BPLAN, verdict: 'DEFECTS', blocking: ['D1'], minor: ['D2'],
    summaries: { D1: 'CI does not install the notebook requirements' },
    mtimeMs: null, bodyHash: planBodyHash(BPLAN), at: new Date().toISOString(), ...over,
  }));
};
const startIn = (cwd, source = 'startup') => run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', source, session_id: 'new-session', cwd },
  { CLAUDE_CONFIG_DIR: BCONF });
const context = (res) => res.out?.hookSpecificOutput?.additionalContext ?? '';

fs.writeFileSync(BPLAN, '# thing\n');
putMarker();
check('an unresolved blocker is surfaced on a new session',
  /D1/.test(context(startIn(BREPO))), true);
check('with what it actually was',
  /CI does not install/.test(context(startIn(BREPO))), true);
check('and which plan it is in',
  /2026-09-22-thing\.md/.test(context(startIn(BREPO))), true);
// Minor defects are not blockers and must not be dragged along.
check('citation drift is not surfaced', /D2/.test(context(startIn(BREPO))), false);

// MUST NOT: a plan in some OTHER repository is not this session's problem.
const OTHERCWD = fs.mkdtempSync(path.join(os.tmpdir(), 'blockother-'));
check('a blocker in another repository is not surfaced',
  context(startIn(OTHERCWD)), '');

// MUST NOT: resolved means resolved.
putMarker({ verdict: 'CLEAN', blocking: [] });
check('a clean audit surfaces nothing', context(startIn(BREPO)), '');

// The verdict decides, not the leftover list. A marker is plain JSON on disk and
// an older version or a hand edit can leave ids beside a verdict that cleared
// them; reading the list alone would resurrect a defect that is gone.
putMarker({ verdict: 'MINOR', blocking: ['D1'] });
check('ids left beside a non-blocking verdict surface nothing', context(startIn(BREPO)), '');

// Acknowledged in the plan is resolved as far as the gate is concerned, so it
// must not come back as an open blocker either.
// The acknowledgement must name the audit it answers, or an entry written for an
// earlier round would suppress the reminder for a later round's defect of the same
// number -- ids restart at D1 every audit.
const bAt = new Date().toISOString();
fs.writeFileSync(BPLAN,
  `# thing\n\n## Known defects — accepted\n- D1 (audit ${bAt}): accepted on purpose.\n`);
putMarker({ at: bAt });
check('an acknowledged blocker surfaces nothing', context(startIn(BREPO)), '');

// MUST-NOT pair: the same words, stamped with a different audit, still surface.
putMarker({ at: new Date(Date.now() + 1000).toISOString() });
check("an acknowledgement from another audit still surfaces",
  /D1/.test(context(startIn(BREPO))), true);

// The pick-it-up case: the plan was edited to fix D1 but never re-audited. The
// marker no longer describes the file, and saying nothing loses the blocker
// entirely -- so it is reported, marked as no longer current.
fs.writeFileSync(BPLAN, '# thing\n\nfixed, but never re-audited\n');
putMarker({ bodyHash: 'stale-hash-from-an-older-body' });
const staleCtx = context(startIn(BREPO));
check('a blocker whose plan changed since the audit is still surfaced',
  /D1/.test(staleCtx), true);
check('and is marked as no longer current', /edited since/i.test(staleCtx), true);

for (const d of [BCONF, BREPO, OTHERCWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// =============================================================================
// Feature-scoped run state. The session checkpoint above dies with the session;
// this is what a NEW session recovers from after a crash or /clear.
console.log('\nrun-state.cjs — durable, feature-scoped, in the repo');
clean();
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-'));
fs.mkdirSync(path.join(REPO, 'docs'));
const rsFile = path.join(REPO, 'docs', '.run-state.json');
// Overridable so a new run-state.cjs can be driven from a scratch copy while a
// live /ship run is still invoking the installed one.
const RS_BIN = process.env.RUN_STATE_BIN || path.join(HOOKS, 'run-state.cjs');
// Runs live in the registry under CLAUDE_CONFIG_DIR now, not at <repo>/docs/.
// A scratch config dir keeps this suite out of the real one, and a session id is
// what the per-chat pointer is keyed on. The assertions below are about BEHAVIOUR
// -- counters, phases, the branch refusal -- so they are unchanged; only how the
// state is read back had to move.
const RS_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-cfg-'));
const rs = (args, cwd = REPO) => spawnSync('node', [RS_BIN, ...args],
  { encoding: 'utf-8', cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: RS_CONFIG, CLAUDE_CODE_SESSION_ID: 'test-runstate-0001' } });
const readRs = () => { try { return JSON.parse(rs(['get']).stdout); } catch { return null; } };

rs(['start', '--feature', 'supplier-comparison', '--brief-file', 'docs/briefs.md']);
check('start creates a run', readRs()?.feature != null, true);
check('and it is NOT written to the repo', fs.existsSync(rsFile), false);
check('start records the feature', readRs()?.feature, 'supplier-comparison');

rs(['begin-brief', '3']);
check('begin-brief sets currentBrief', readRs()?.currentBrief, 3);
check('begin-brief resets reviewRounds', readRs()?.reviewRounds, 0);

rs(['review-round']);
rs(['review-round']);
check('review rounds accumulate ON DISK', readRs()?.reviewRounds, 2);

// The whole point of on-disk counters: a resume must NOT reset them to zero.
rs(['begin-brief', '3']);
check('re-entering the SAME brief keeps its counters', readRs()?.reviewRounds, 2);
rs(['begin-brief', '4']);
check('moving to a NEW brief resets counters', readRs()?.reviewRounds, 0);

rs(['block', '4', '--reason', 'premise wrong']);
check('block records the brief', (readRs()?.blocked ?? []).some((b) => b.brief === 4), true);

rs(['finish-brief', '4', '--commit', 'abc1234']);
check('finish-brief records the commit', readRs()?.lastCommit, 'abc1234');

// =============================================================================
// The /ship phase. /ship is one command run twice: it reads the phase and does
// whatever comes next, so the phase is the thing that makes a single entry point
// resumable after a crash instead of restarting the feature.
console.log('\nrun-state.cjs — the /ship phase');
rs(['start', '--feature', 'ship-me', '--brief-file', 'docs/briefs.md']);
check('a new run starts in planning', readRs()?.phase, 'planning');

rs(['phase', 'awaiting-approval', '--plan', 'docs/plans/2026-09-21-ship.md']);
check('the phase advances', readRs()?.phase, 'awaiting-approval');
check('and the plan doc is recorded', readRs()?.planFile, 'docs/plans/2026-09-21-ship.md');

// MUST NOT accept a phase it cannot act on. A typo that silently writes
// "excuting" leaves /ship in a state no branch handles, and the next run has
// nothing to resume from — the exact failure the phase exists to prevent.
const bogus = rs(['phase', 'excuting']);
check('an unknown phase is rejected', bogus.status !== 0, true);
check('and the previous phase is left intact', readRs()?.phase, 'awaiting-approval');

// `awaiting-direction` sits before `planning`: a run can be waiting on which
// approach to take before any plan document exists, which is earlier than
// anything the original four phases could express. It is the earliest phase
// chronologically, and the second place /ship stops -- both are true, so the
// comments say "earliest" rather than picking an ordinal that reads as the
// other one.
rs(['phase', 'awaiting-direction']);
check('awaiting-direction is accepted', readRs()?.phase, 'awaiting-direction');

// Paired with the acceptance, and it is the assertion that carries the weight.
// A test that only checked the new phase was accepted would pass just as well
// against a PHASES replaced by an accept-anything check -- which is the
// regression this array exists to prevent, and the reason the `excuting` case
// above was written in the first place.
const nearMiss = rs(['phase', 'awaiting-direciton']);
check('a near-miss of the new phase is rejected', nearMiss.status !== 0, true);
check('and it leaves awaiting-direction intact', readRs()?.phase, 'awaiting-direction');

// `phase` was guarded; `start --phase` was not, and /ship Start is the entry
// point that actually passes it. A typo therefore reached the run file with a
// clean exit, leaving /ship in a phase its table has no branch for -- the exact
// state the whitelist exists to prevent, reachable one subcommand over.
const startTypo = rs(['start', '--feature', 'phase-typo', '--phase', 'awaiting-direciton']);
check('start rejects an unknown --phase', startTypo.status !== 0, true);
// Exit code alone is not enough: a `start` that validated only after writing
// would report the typo and persist it anyway. The run must not exist.
check('and no run file was written for it',
  fs.existsSync(path.join(RS_CONFIG, 'state', 'ship-runs')) &&
    fs.readdirSync(path.join(RS_CONFIG, 'state', 'ship-runs'))
      .some((d) => fs.existsSync(path.join(RS_CONFIG, 'state', 'ship-runs', d, 'phase-typo.json'))),
  false);
// The default is not part of what changed.
rs(['start', '--feature', 'phase-default']);
check('start with no --phase still defaults to planning', readRs()?.phase, 'planning');
rs(['current', 'supplier-comparison']);

rs(['phase', 'executing']);
rs(['begin-brief', '2']);
check('beginning a brief does not disturb the phase', readRs()?.phase, 'executing');

// =============================================================================
// The work branch. /ship always creates one, so it never matters which branch
// you were standing on — a hardcoded list of "protected" branch names is a
// local accident, and the repo it was written for is the only one it fits.
console.log('\nrun-state.cjs — the work branch');
rs(['start', '--feature', 'descriptor-shortcut']);
check('a new run has no branch until one is made', readRs()?.branch, null);

rs(['branch', 'feature/descriptor-shortcut', '--base', 'development']);
check('the work branch is recorded', readRs()?.branch, 'feature/descriptor-shortcut');
check('and so is the base it forked from', readRs()?.baseBranch, 'development');

// MUST NOT silently adopt a second branch mid-run. A resume that re-branches
// splits the feature in two: half the briefs committed on each, and the PR
// carries whichever half the run happened to end on.
const rebranch = rs(['branch', 'feature/something-else', '--base', 'development']);
check('re-branching an unfinished run is rejected', rebranch.status !== 0, true);
check('and the original branch is left intact', readRs()?.branch, 'feature/descriptor-shortcut');

// Re-recording the SAME branch is what a resume does, and must be allowed —
// otherwise every resumed run dies on its own bookkeeping.
const same = rs(['branch', 'feature/descriptor-shortcut', '--base', 'development']);
check('re-recording the same branch is fine', same.status, 0);

rs(['finish']);
check('finishing the run clears the phase', readRs()?.phase, null);
check('and records finishedAt', typeof readRs()?.finishedAt, 'string');
// The branch is kept after the run: the PR points at it and a later session
// still needs to know which branch the work landed on.
check('the branch survives finishing', readRs()?.branch, 'feature/descriptor-shortcut');

// A finished run is what lets the NEXT feature branch freely.
rs(['start', '--feature', 'next-thing']);
check('a new run clears the previous branch', readRs()?.branch, null);
const afterStart = rs(['branch', 'bugs/anchor-ordering', '--base', 'development']);
check('and the next run may branch again', afterStart.status, 0);
check('with its own name', readRs()?.branch, 'bugs/anchor-ordering');

// Never throw on a corrupt file — a crashed writer must not wedge every later
// session. Tested in a repo of its own, with no pointer and no registry run: the
// corrupt legacy file has to be what `get` actually resolves to, or this passes
// while reading something else entirely.
const CORRUPT = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-corrupt-'));
fs.mkdirSync(path.join(CORRUPT, 'docs'));
fs.writeFileSync(path.join(CORRUPT, 'docs', '.run-state.json'), '{ this is not json');
const corrupt = spawnSync('node', [RS_BIN, 'get'],
  { encoding: 'utf-8', cwd: CORRUPT, env: { ...process.env, CLAUDE_CONFIG_DIR: RS_CONFIG } });
check('garbled state file does not crash the script', corrupt.status, 0);
check('a corrupt file reads back a null phase, not undefined',
  JSON.parse(corrupt.stdout).phase, null);

// =============================================================================
console.log('\ncheckpoint-restore.cjs — cross-session recovery (source: startup)');
// MUST fire: a new session in a repo whose run state has unfinished work.
fs.writeFileSync(rsFile, JSON.stringify({
  feature: 'supplier-comparison', briefFile: 'docs/briefs.md',
  currentBrief: 3, attempt: 1, reviewRounds: 1, debugRounds: 0, blocked: [],
}));
const recovered = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'brand-new-session', source: 'startup', cwd: REPO });
const rctx = recovered.out?.hookSpecificOutput?.additionalContext ?? '';
check('a NEW session recovers the unfinished brief', /brief 3/i.test(rctx), true);
check('and names the feature', /supplier-comparison/.test(rctx), true);

// The injected text must stay under the 10,000-char cap, or Claude Code writes it
// to a file and hands over a path it is never asked to read.
check('injection stays under the 10k cap', rctx.length < 10000, true);

// MUST NOT fire: the run is finished, so there is nothing to recover.
fs.writeFileSync(rsFile, JSON.stringify({
  feature: 'supplier-comparison', briefFile: 'docs/briefs.md',
  currentBrief: null, finishedAt: '2026-09-21T00:00:00Z', blocked: [],
}));
const done = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'brand-new-session', source: 'startup', cwd: REPO });
check('a finished run injects nothing',
  (done.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// `finishedAt` must be decisive on its own. A run that finished while a brief number
// was still recorded is finished; without this case the previous test passes on the
// currentBrief check alone and the finishedAt guard is never exercised.
fs.writeFileSync(rsFile, JSON.stringify({
  feature: 'supplier-comparison', briefFile: 'docs/briefs.md',
  currentBrief: 9, finishedAt: '2026-09-21T00:00:00Z', blocked: [],
}));
const doneWithBrief = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'brand-new-session', source: 'startup', cwd: REPO });
check('finishedAt alone stops the injection',
  (doneWithBrief.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// MUST NOT fire: an unrelated repo with no run state.
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'plainrepo-'));
const unrelated = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'brand-new-session', source: 'startup', cwd: PLAIN });
check('an unrelated repo injects nothing',
  (unrelated.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// A fork gets a NEW session id, so its parent's checkpoint is unreachable by
// definition and the repo run state is the only thing left to recover from.
fs.writeFileSync(rsFile, JSON.stringify({
  feature: 'supplier-comparison', briefFile: 'docs/briefs.md',
  currentBrief: 5, attempt: 1, reviewRounds: 0, debugRounds: 0, blocked: [],
}));
const forked = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'forked-session', source: 'fork', cwd: REPO });
check('a fork recovers the unfinished brief',
  /brief 5/i.test(forked.out?.hookSpecificOutput?.additionalContext ?? ''), true);

// `/clear` with no session checkpoint (a machine restart between the write and
// the clear) must still fall through to the durable state rather than give up.
const clearedFallback = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'no-checkpoint-here', source: 'clear', cwd: REPO });
check('clear falls back to the repo run state',
  /brief 5/i.test(clearedFallback.out?.hookSpecificOutput?.additionalContext ?? ''), true);

// MUST NOT fire: the same two sources on a finished run stay silent. Without
// these, the two cases above would pass on a hook that injects unconditionally.
fs.writeFileSync(rsFile, JSON.stringify({
  feature: 'supplier-comparison', briefFile: 'docs/briefs.md',
  currentBrief: 5, finishedAt: '2026-09-21T00:00:00Z', blocked: [],
}));
const forkDone = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'forked-session', source: 'fork', cwd: REPO });
check('a fork over a finished run injects nothing',
  (forkDone.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);
const clearDone = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'no-checkpoint-here', source: 'clear', cwd: REPO });
check('a clear over a finished run injects nothing',
  (clearDone.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

// MUST NOT throw: a corrupt state file on startup.
fs.writeFileSync(rsFile, 'not json at all');
const badStart = run('checkpoint-restore.cjs',
  { hook_event_name: 'SessionStart', session_id: 'brand-new-session', source: 'startup', cwd: REPO });
check('corrupt state file on startup does not crash the hook', badStart.code, 0);
check('corrupt state file injects nothing',
  (badStart.out?.hookSpecificOutput?.additionalContext ?? '') === '', true);

try { fs.rmSync(REPO, { recursive: true, force: true }); fs.rmSync(PLAIN, { recursive: true, force: true }); fs.rmSync(CONFIG, { recursive: true, force: true }); } catch {}

// =============================================================================
// gate-arm.cjs — the PreToolUse hook that arms the gate from the dispatch
// itself, rather than the model Writing a marker file by hand. Own config dir
// and session per block, since these drive run-state.cjs's own CLI with a
// real (fake) CLAUDE_CODE_SESSION_ID, and must never touch the live install.
console.log('\ngate-arm.cjs — arms a brief from an implementer dispatch, never blocks it');

const GACONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'gatearm-cfg-'));
const gaArmDir = (sid) => path.join(GACONFIG, 'state', 'brief-exec', sid);
const gaArmFile = (sid, n) => path.join(gaArmDir(sid), `${n}.json`);
const gaRun = (input, env = {}) => {
  const r = spawnSync('node', [path.join(HOOKS, 'gate-arm.cjs')], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: GACONFIG, SKIP_CODE_GATES: '', ...env },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
  return { out, stderr: r.stderr, code: r.status };
};
const gaDenied = (res) => res.out?.hookSpecificOutput?.permissionDecision === 'deny';
const agentDispatch = (over = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'gatearm-sess-1', cwd: process.cwd(),
  tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 4\n\nRest of the prompt.' },
  ...over,
});
const gaClean = (sid = 'gatearm-sess-1') => { try { fs.rmSync(gaArmDir(sid), { recursive: true, force: true }); } catch {} };

gaClean();
const armed4 = gaRun(agentDispatch());
check('implementer dispatch never blocks the tool call', gaDenied(armed4), false);
check('and it arms brief 4', fs.existsSync(gaArmFile('gatearm-sess-1', '4')), true);
let armed4Rec = {};
try { armed4Rec = JSON.parse(fs.readFileSync(gaArmFile('gatearm-sess-1', '4'), 'utf-8')); } catch {}
check('the arm file records armedAt', typeof armed4Rec.armedAt, 'string');

// A leading-zero brief number ("Implement BRIEF 04") arms the STRIPPED key
// ("4"), not the literal text -- so it lines up with run-state.cjs's own
// `String(Number(rest[0]))` normalisation and with verify-gate.cjs's lookup.
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 04\n\nRest.' } }));
check('a leading-zero brief number arms the stripped key', fs.existsSync(gaArmFile('gatearm-sess-1', '4')), true);
check('and not the literal zero-padded filename', fs.existsSync(path.join(gaArmDir('gatearm-sess-1'), '04.json')), false);

// MUST NOT: a different subagent_type arms nothing, even with the same first line.
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'reviewer', prompt: 'Implement BRIEF 4\n\nRest.' } }));
check('a non-implementer subagent_type arms nothing', fs.existsSync(gaArmDir('gatearm-sess-1')), false);

// A plugin-namespaced implementer (":implementer" suffix) still arms.
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'myplugin:implementer', prompt: 'Implement BRIEF 4\n\nRest.' } }));
check('a plugin-namespaced implementer still arms', fs.existsSync(gaArmFile('gatearm-sess-1', '4')), true);

// MUST NOT: a first line that is not "Implement BRIEF <n>" arms nothing.
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'implementer', prompt: 'Please implement brief 4 at your leisure.' } }));
check('a first line not matching "Implement BRIEF <n>" arms nothing', fs.existsSync(gaArmDir('gatearm-sess-1')), false);

// MUST NOT: a payload carrying agent_id (a call made from inside a subagent)
// arms nothing — a subagent must never be able to arm the orchestrator's gate.
gaClean();
gaRun(agentDispatch({ agent_id: 'sub-1' }));
check('a dispatch made from inside a subagent (agent_id present) arms nothing',
  fs.existsSync(gaArmDir('gatearm-sess-1')), false);

// A group of two: each dispatch arms its own brief, independently.
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 6\n\nFirst of the pair.' } }));
gaRun(agentDispatch({ tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 7\n\nSecond of the pair.' } }));
check('a group of two arms both briefs', [fs.existsSync(gaArmFile('gatearm-sess-1', '6')), fs.existsSync(gaArmFile('gatearm-sess-1', '7'))], [true, true]);
gaClean();

// Re-arming an already-armed brief resets armedAt to the new dispatch's own
// time (BRIEF 19 / H2). Keeping the original armedAt let an APPROVED verdict
// recorded for the FIRST dispatch go on covering a fix round or a re-dispatch
// of the same brief number later in the same session -- the new code never
// gets its own review, because verify-gate.cjs only checks that the verdict
// postdates SOME armedAt, and the old one was still on file. A review already
// in flight is not lost by this: verify-record.cjs stamps a verdict's `at`
// only when it is actually recorded, which is always after the dispatch that
// prompted it, so a fresh arm can never invalidate a verdict for review work
// that has not landed yet.
gaClean();
gaRun(agentDispatch());
const firstArmedAt = JSON.parse(fs.readFileSync(gaArmFile('gatearm-sess-1', '4'), 'utf-8')).armedAt;
const laterTime = new Date(Date.now() + 5000);
fs.utimesSync(gaArmFile('gatearm-sess-1', '4'), laterTime, laterTime);
gaRun(agentDispatch());
const secondArmedAt = JSON.parse(fs.readFileSync(gaArmFile('gatearm-sess-1', '4'), 'utf-8')).armedAt;
check('re-arming an already-armed brief resets armedAt to the new dispatch',
  secondArmedAt !== firstArmedAt, true);
gaClean();

// A sibling's re-arm must not disturb an already-approved brief's own armedAt
// or arm file — verify-gate.cjs reads per-brief armedAt, so this is really a
// verify-gate assertion, exercised below once both hooks exist.
console.log('\ngate-arm.cjs — denies a subagent trying to drive run-state.cjs directly');
const gaBashDeny = (command, over = {}) => gaRun({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'gatearm-sess-1', cwd: process.cwd(),
  tool_input: { command },
  agent_id: 'sub-1',
  ...over,
});
check('a subagent calling run-state.cjs start is denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs start --feature x')), true);
check('a subagent calling run-state.cjs finish-brief is denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs finish-brief 4')), true);
check('a subagent calling run-state.cjs block is denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs block 4 --reason x')), true);
check('a subagent calling run-state.cjs current is denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs current somefeature')), true);
check('a subagent calling run-state.cjs review-round (not in the deny list) is allowed',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs review-round 4')), false);
check('the SAME command with no agent_id (main thread) is allowed',
  gaDenied(gaRun({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'gatearm-sess-1', cwd: process.cwd(),
    tool_input: { command: 'node ~/.claude/hooks/run-state.cjs finish-brief 4' },
  })), false);
check('an unrelated Bash command with agent_id present is allowed',
  gaDenied(gaBashDeny('ls -la')), false);

// BRIEF 19 / M3: the deny regex is anchored on the SUBCOMMAND POSITION --
// `run-state.cjs` followed by optional quote/whitespace, then exactly one of
// start|current|finish-brief|block as the NEXT WORD -- so a `--feature` value
// or subcommand that merely CONTAINS one of those words as a substring
// ("quick-start", "block-parser") is not mistaken for the real subcommand.
check('a subagent calling run-state.cjs get --feature quick-start is allowed',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs get --feature quick-start')), false);
check('a subagent calling run-state.cjs get --feature block-parser is allowed',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs get --feature block-parser')), false);
// The real subcommands, still denied under the anchored regex.
check('a subagent calling run-state.cjs block 4 is still denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs block 4')), true);
check('a subagent calling "$X/run-state.cjs" finish-brief 4 (quoted path) is still denied',
  gaDenied(gaBashDeny('"$X/run-state.cjs" finish-brief 4')), true);
check('a subagent calling run-state.cjs start --feature x is still denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs start --feature x')), true);

// Round 2 must-fix (H1): shell quoting or escaping around the subcommand
// itself must not defeat the anchor -- `'block'`, `"finish-brief"` and
// `\block` are all still exactly the subcommand in the very next word once
// the shell strips the quote/backslash, so denying them must not depend on
// that stripping never happening. These three were caught at HEAD (whose
// regex matched anywhere after the script name) and slipped through the
// anchored regex above until quotes/backslashes are stripped before matching.
check('a subagent calling run-state.cjs \'block\' 4 (single-quoted subcommand) is still denied',
  gaDenied(gaBashDeny("node ~/.claude/hooks/run-state.cjs 'block' 4")), true);
check('a subagent calling run-state.cjs "finish-brief" 4 (double-quoted subcommand) is still denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs "finish-brief" 4')), true);
check('a subagent calling run-state.cjs \\block 4 (backslash-escaped subcommand) is still denied',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs \\block 4')), true);
// The normalisation that catches the three forms above must not turn a
// legitimate --feature value into a false positive: quotes/backslashes
// stripped from "quick-start" still leave "quickstart", nowhere near the
// anchored `\s+(start|...)"` pattern since there is no whitespace before it.
check('a subagent calling run-state.cjs get --feature quick-start is still allowed after normalisation',
  gaDenied(gaBashDeny('node ~/.claude/hooks/run-state.cjs get --feature quick-start')), false);

// =============================================================================
console.log('\ngate-arm.cjs — matches "Implement BRIEF" case-insensitively (like verify-record)');
gaClean();
gaRun(agentDispatch({ tool_input: { subagent_type: 'implementer', prompt: 'implement brief 4\n\nRest.' } }));
check('a lowercase "implement brief 4" still arms brief 4',
  fs.existsSync(gaArmFile('gatearm-sess-1', '4')), true);
gaClean();

// BRIEF 19 / LOW (case-sensitivity + session_id): a session_id containing a
// path separator or '..' must arm nothing at all -- run-state.cjs already
// refuses a session id shaped like this outright (rejectUnsafeSessionId), and
// gate-arm.cjs joins the session id straight into a directory path with no
// equivalent guard, so the same rule is reused here.
console.log('\ngate-arm.cjs — refuses to arm when the session_id is unsafe as a path segment');
const UNSAFE_SIDS = ['../evil', 'a/b', 'a\\b', '..'];
for (const sid of UNSAFE_SIDS) {
  gaRun({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: sid, cwd: process.cwd(),
    tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 4\n\nRest.' },
  });
}
check('none of the unsafe session ids left a brief-exec dir under the config root',
  fs.existsSync(path.join(GACONFIG, 'state', 'brief-exec', '..', 'evil')) ||
  fs.readdirSync(path.join(GACONFIG, 'state', 'brief-exec'))
    .some((d) => UNSAFE_SIDS.includes(d)),
  false);

// =============================================================================
// BRIEF 19 / H2 end to end: arm brief 4, get it APPROVED, then re-dispatch
// "Implement BRIEF 4" (a fix round, or a same-numbered brief in a later run)
// -- the Stop gate must block again, because the re-arm reset armedAt past
// the earlier verdict's `at`.
console.log('\ngate-arm.cjs + verify-gate.cjs — a re-dispatch of the same brief needs its own fresh review');
gaClean();
const REDISID = 'gatearm-sess-1';
gaRun(agentDispatch({ session_id: REDISID }));
const rediArmedAt1 = JSON.parse(fs.readFileSync(gaArmFile(REDISID, '4'), 'utf-8')).armedAt;
const rediReviewFile = path.join(GACONFIG, 'state', 'brief-review', `${REDISID}.json`);
fs.mkdirSync(path.dirname(rediReviewFile), { recursive: true });
// The verdict is dated JUST after the first arming -- postdating THAT arm is
// all that is needed for the first Stop call to allow the turn to end.
const rediApprovedAt = new Date(Date.parse(rediArmedAt1) + 10).toISOString();
fs.writeFileSync(rediReviewFile, JSON.stringify({
  verdicts: { 4: { verdict: 'APPROVED', at: rediApprovedAt } },
}));
check('after APPROVED postdating the first arm: turn ends freely',
  blocked(run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: REDISID, cwd: process.cwd() }, { CLAUDE_CONFIG_DIR: GACONFIG })),
  false);

// Re-dispatch: gate-arm.cjs writes a brand-new armedAt at ITS OWN wall-clock
// time. Busy-wait past the verdict's `at` first (spawnSync alone is not
// guaranteed to take >10ms) so the new armedAt is deterministically later,
// not dependent on scheduling luck. No new verdict is written for this
// second dispatch, so the earlier APPROVED (now stale relative to the fresh
// armedAt) must no longer cover it.
while (Date.now() <= Date.parse(rediApprovedAt)) { /* busy-wait past the verdict's `at` */ }
gaRun(agentDispatch({ session_id: REDISID }));
const rediArmedAt2 = JSON.parse(fs.readFileSync(gaArmFile(REDISID, '4'), 'utf-8')).armedAt;
check('the re-dispatch actually produced a new, later armedAt',
  Date.parse(rediArmedAt2) > Date.parse(rediApprovedAt), true);
check('re-dispatching the same brief after APPROVED blocks the turn again (no re-review = no exit)',
  blocked(run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: REDISID, cwd: process.cwd() }, { CLAUDE_CONFIG_DIR: GACONFIG })),
  true);
gaClean();
try { fs.unlinkSync(rediReviewFile); } catch {}

// =============================================================================
console.log('\nverify-gate.cjs — reads the per-brief arm directory gate-arm.cjs writes');
clean();
const PBSID = 'test-verify-perbrief-0001';
const pbArmDir = path.join(STATE, 'brief-exec', PBSID);
const pbReviewFile = path.join(reviewDir, `${PBSID}.json`);
const pbClean = () => {
  try { fs.rmSync(pbArmDir, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(pbReviewFile); } catch {}
};
const pbWriteArm = (n, armedAt) => {
  fs.mkdirSync(pbArmDir, { recursive: true });
  fs.writeFileSync(path.join(pbArmDir, `${n}.json`), JSON.stringify({ armedAt }));
};
const pbStop = () => ({ hook_event_name: 'Stop', session_id: PBSID, cwd: process.cwd() });

pbClean();
pbWriteArm('8', new Date().toISOString());
pbWriteArm('9', new Date().toISOString());
check('per-brief dir: two armed, no verdicts: blocks', blocked(run('verify-gate.cjs', pbStop())), true);

write(pbReviewFile, { verdicts: { 8: { verdict: 'APPROVED', at: new Date().toISOString() } } });
const pbPartial = run('verify-gate.cjs', pbStop());
check('per-brief dir: one of two approved: still blocks', blocked(pbPartial), true);
check('and names the missing one', /\b9\b/.test(pbPartial.out?.reason ?? ''), true);

write(pbReviewFile, {
  verdicts: {
    8: { verdict: 'APPROVED', at: new Date().toISOString() },
    9: { verdict: 'APPROVED', at: new Date().toISOString() },
  },
});
check('per-brief dir: both approved: allows', blocked(run('verify-gate.cjs', pbStop())), false);
pbClean();

// A verdict recorded under a zero-padded key ("04") must still satisfy an
// arm normalised to "4" -- gate-arm.cjs strips leading zeros when it names
// the arm file, but verify-record.cjs's own brief-number capture does not,
// so the two can disagree on the literal key even though both mean brief 4.
pbWriteArm('4', new Date().toISOString());
write(pbReviewFile, { verdicts: { '04': { verdict: 'APPROVED', at: new Date().toISOString() } } });
check('a zero-padded verdict key still satisfies the normalised arm',
  blocked(run('verify-gate.cjs', pbStop())), false);
pbClean();

// BRIEF 19 / 11g: the `armedAt` field branch of verify-gate.cjs's own
// armedAtOf, exercised directly (not through finish-brief) -- an arm file
// that DOES carry armedAt uses that value as the cutoff even though the
// file's mtime is forced much later, so a verdict dated between the two
// is accepted only because the FIELD, not the mtime, decided.
fs.mkdirSync(pbArmDir, { recursive: true });
const pbArm10File = path.join(pbArmDir, '10.json');
const pbArmedAtField = new Date(Date.now() - 60000).toISOString();
fs.writeFileSync(pbArm10File, JSON.stringify({ armedAt: pbArmedAtField }));
const pbMuchLater = new Date(Date.now() + 60000);
fs.utimesSync(pbArm10File, pbMuchLater, pbMuchLater);
write(pbReviewFile, { verdicts: { 10: { verdict: 'APPROVED', at: new Date().toISOString() } } });
check('the armedAt FIELD (not the later mtime) decides the cutoff: a verdict after the field allows',
  blocked(run('verify-gate.cjs', pbStop())), false);
pbClean();

// The mtime-fallback branch: an arm file with NO armedAt field at all must
// fall back to the file's own mtime as the cutoff, read directly through
// verify-gate.cjs (finish-brief's own fallback is covered elsewhere, but
// that never exercises THIS hook's armedAtOf).
fs.mkdirSync(pbArmDir, { recursive: true });
const pbArm11File = path.join(pbArmDir, '11.json');
fs.writeFileSync(pbArm11File, JSON.stringify({})); // no armedAt field
const pbMtime = new Date();
fs.utimesSync(pbArm11File, pbMtime, pbMtime);
write(pbReviewFile, { verdicts: { 11: { verdict: 'APPROVED', at: new Date(pbMtime.getTime() - 60000).toISOString() } } });
check('no armedAt field: falls back to the arm file\'s mtime, rejecting a verdict dated before it',
  blocked(run('verify-gate.cjs', pbStop())), true);
write(pbReviewFile, { verdicts: { 11: { verdict: 'APPROVED', at: new Date(pbMtime.getTime() + 60000).toISOString() } } });
check('no armedAt field: a verdict dated after the mtime allows',
  blocked(run('verify-gate.cjs', pbStop())), false);
pbClean();

// =============================================================================
console.log('\nrun-state.cjs finish-brief — disarms the per-brief gate only on approval');
const FBCONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'finishbrief-cfg-'));
const FBREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'finishbrief-repo-'));
const FBSID = 'test-finishbrief-0001';
const fbArmDir = path.join(FBCONFIG, 'state', 'brief-exec', FBSID);
const fbReviewFile = path.join(FBCONFIG, 'state', 'brief-review', `${FBSID}.json`);
const fbArm = (n, armedAt) => {
  fs.mkdirSync(fbArmDir, { recursive: true });
  fs.writeFileSync(path.join(fbArmDir, `${n}.json`), JSON.stringify({ armedAt }));
};
const fbRs = (args, env = {}) => spawnSync('node', [path.join(HOOKS, 'run-state.cjs'), ...args], {
  cwd: FBREPO, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: FBCONFIG, CLAUDE_CODE_SESSION_ID: FBSID, ...env },
});

fbRs(['start', '--feature', 'finishbrief-test']);
fbRs(['begin-brief', '4']);
const t0 = new Date();
fbArm('4', t0.toISOString());

// No approval on file: finish-brief must exit non-zero and leave the arm.
const fbNoApproval = fbRs(['finish-brief', '4']);
check('finish-brief without an approval exits non-zero', fbNoApproval.status !== 0, true);
check('and leaves the arm file in place', fs.existsSync(path.join(fbArmDir, '4.json')), true);

// An approval dated BEFORE armedAt does not count — belongs to a previous arming.
fs.mkdirSync(path.dirname(fbReviewFile), { recursive: true });
fs.writeFileSync(fbReviewFile, JSON.stringify({
  verdicts: { 4: { verdict: 'APPROVED', at: new Date(t0.getTime() - 60000).toISOString() } },
}));
const fbStaleApproval = fbRs(['finish-brief', '4']);
check('finish-brief with an approval dated BEFORE armedAt still exits non-zero', fbStaleApproval.status !== 0, true);
check('and still leaves the arm file', fs.existsSync(path.join(fbArmDir, '4.json')), true);

// An approval dated AFTER armedAt: finish-brief succeeds and disarms.
fs.writeFileSync(fbReviewFile, JSON.stringify({
  verdicts: { 4: { verdict: 'APPROVED', at: new Date(t0.getTime() + 60000).toISOString() } },
}));
const fbApproved = fbRs(['finish-brief', '4']);
check('finish-brief with a fresh approval exits zero', fbApproved.status, 0);
check('and removes the arm file', fs.existsSync(path.join(fbArmDir, '4.json')), false);

// `block <n>` removes the arm unconditionally, approval or not.
fbRs(['begin-brief', '5']);
fbArm('5', new Date().toISOString());
fbRs(['block', '5', '--reason', 'blocked without review']);
check('block removes the arm file unconditionally', fs.existsSync(path.join(fbArmDir, '5.json')), false);

// A verdict recorded under a zero-padded key ("06") must still satisfy the
// normalised arm for brief 6 -- same mismatch hasFreshApproval must tolerate
// as verify-gate.cjs, since verify-record.cjs's own capture is not normalised.
fbRs(['begin-brief', '6']);
const t1 = new Date();
fbArm('6', t1.toISOString());
fs.writeFileSync(fbReviewFile, JSON.stringify({
  verdicts: { '06': { verdict: 'APPROVED', at: new Date(t1.getTime() + 1000).toISOString() } },
}));
const fbZeroPadded = fbRs(['finish-brief', '6']);
check('finish-brief accepts a zero-padded verdict key for a normalised arm', fbZeroPadded.status, 0);
check('and removes brief 6\'s arm file', fs.existsSync(path.join(fbArmDir, '6.json')), false);

// An arm file with NO armedAt field at all (legacy write, or one gate-arm.cjs
// never touched) must fall back to the arm FILE'S OWN MTIME as the cutoff --
// the same rule verify-gate.cjs applies -- not "no cutoff, anything counts".
// A verdict dated BEFORE that mtime is stale and must still be rejected.
fbRs(['begin-brief', '7']);
fs.mkdirSync(fbArmDir, { recursive: true });
const fbArm7File = path.join(fbArmDir, '7.json');
fs.writeFileSync(fbArm7File, JSON.stringify({})); // no armedAt
const mtime = new Date();
fs.utimesSync(fbArm7File, mtime, mtime);
fs.writeFileSync(fbReviewFile, JSON.stringify({
  verdicts: { 7: { verdict: 'APPROVED', at: new Date(mtime.getTime() - 60000).toISOString() } },
}));
const fbNoArmedAtStale = fbRs(['finish-brief', '7']);
check('finish-brief with no armedAt falls back to the arm file\'s mtime, rejecting a stale verdict',
  fbNoArmedAtStale.status !== 0, true);
check('and leaves brief 7\'s arm file in place', fs.existsSync(fbArm7File), true);

for (const d of [FBCONFIG, FBREPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// =============================================================================
// A sibling's re-arm (gate-arm.cjs re-dispatching an implementer for brief 6
// while brief 5 is already approved and awaiting finish-brief) must not
// disturb brief 5's own approved status or armedAt. Brief 6 is armed AFTER
// brief 5's approval `at` (not just after brief 5's OWN armedAt) -- this is
// what separates a genuinely per-brief armedAt from an implementation that
// collapses all armed briefs to a single shared timestamp (their max or their
// min): under either of those, brief 6's later arming would push the shared
// cutoff past brief 5's approval and wrongly invalidate it too.
console.log('\ngate-arm.cjs + verify-gate.cjs — a sibling\'s re-arm keeps an approved brief approved');
gaClean();
const SIBSID = 'gatearm-sess-1';
gaRun({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: SIBSID, cwd: process.cwd(),
  tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 5\n\nFirst of the pair.' },
});
const sibArmedAt = JSON.parse(fs.readFileSync(gaArmFile(SIBSID, '5'), 'utf-8')).armedAt;
const sibApprovedAt = new Date(Date.parse(sibArmedAt) + 1000).toISOString();
const sibReviewFile = path.join(GACONFIG, 'state', 'brief-review', `${SIBSID}.json`);
fs.mkdirSync(path.dirname(sibReviewFile), { recursive: true });
fs.writeFileSync(sibReviewFile, JSON.stringify({
  verdicts: { 5: { verdict: 'APPROVED', at: sibApprovedAt } },
}));
// Re-arm a SIBLING brief (6), not brief 5 -- with an armedAt written directly,
// AFTER brief 5's approval time, rather than relying on gaRun's real wall
// clock to land there (a same-millisecond dispatch would not distinguish the
// per-brief rule from a shared one).
fs.mkdirSync(gaArmDir(SIBSID), { recursive: true });
fs.writeFileSync(gaArmFile(SIBSID, '6'), JSON.stringify({
  armedAt: new Date(Date.parse(sibApprovedAt) + 1000).toISOString(),
}));
const sibGateRes = run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: SIBSID, cwd: process.cwd() }, { CLAUDE_CONFIG_DIR: GACONFIG });
check('brief 5 stays approved (only brief 6 is missing) after a sibling re-arm',
  /\b5\b/.test(sibGateRes.out?.reason ?? ''), false);
check('and brief 6 (the fresh, unapproved arm) is what blocks',
  /\b6\b/.test(sibGateRes.out?.reason ?? ''), true);
gaClean();

// The mirror case, needed to catch a shared MIN as well as a shared MAX: an
// EARLIER-armed sibling (5) must not drag the cutoff down far enough to make
// a STALE verdict for a LATER-armed brief (6) read as fresh. Per-brief armedAt
// rejects this verdict (it predates brief 6's own arming); collapsing to
// min(armedAt) would accept it, because the min is pinned to brief 5's early
// arming regardless of when 6 was (re-)armed.
console.log('\ngate-arm.cjs + verify-gate.cjs — an earlier sibling does not resurrect a stale verdict');
gaClean();
gaRun({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: SIBSID, cwd: process.cwd(),
  tool_input: { subagent_type: 'implementer', prompt: 'Implement BRIEF 5\n\nEarlier sibling.' },
});
const earlySibArmedAt = JSON.parse(fs.readFileSync(gaArmFile(SIBSID, '5'), 'utf-8')).armedAt;
// Brief 6 armed well after brief 5.
fs.writeFileSync(gaArmFile(SIBSID, '6'), JSON.stringify({
  armedAt: new Date(Date.parse(earlySibArmedAt) + 2000).toISOString(),
}));
// A verdict for brief 6 recorded AFTER brief 5's arming but BEFORE brief 6's
// own arming -- stale for 6, and must not be resurrected by 5's early arm.
const staleVerdictAt = new Date(Date.parse(earlySibArmedAt) + 1000).toISOString();
fs.writeFileSync(sibReviewFile, JSON.stringify({
  verdicts: { 6: { verdict: 'APPROVED', at: staleVerdictAt } },
}));
const staleGateRes = run('verify-gate.cjs', { hook_event_name: 'Stop', session_id: SIBSID, cwd: process.cwd() }, { CLAUDE_CONFIG_DIR: GACONFIG });
check('a stale verdict for the later-armed brief 6 is rejected (6 still blocks)',
  /\b6\b/.test(staleGateRes.out?.reason ?? ''), true);
gaClean();
try { fs.rmSync(GACONFIG, { recursive: true, force: true }); } catch {}

// =============================================================================
clean();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
