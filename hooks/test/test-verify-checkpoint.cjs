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
// re-inject` and `compact with no checkpoint injects nothing` red, and /plan Step
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
console.log('\ncheckpoint-write.cjs — PreCompact saves the thread');
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
clean();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
