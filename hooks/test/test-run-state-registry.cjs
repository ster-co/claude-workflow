#!/usr/bin/env node
// Behavioural tests for the per-run registry and the per-chat selector.
// Run: node ~/.claude/hooks/test/test-run-state-registry.cjs
//
// These cover the change that lets several /ship runs be driven from ONE checkout
// by several chats. The single `<cwd>/docs/.run-state.json` cannot express that:
// one `feature`, one `phase`, one set of counters, so two chats overwrite each
// other and a bare `/ship` resumes whichever run the file happens to hold.
//
// Every assertion is paired wherever a pairing is meaningful: a selector that
// always resolves is as useless as one that never does, and an isolation test
// that cannot observe interference proves nothing. So each independence check is
// accompanied by a check that the two runs ARE both really there and really
// distinct -- otherwise "they did not interfere" passes trivially when neither
// run was written at all.
//
// The registry lives under CLAUDE_CONFIG_DIR, which every test here overrides.
// If run-state.cjs ever ignores that variable these tests would write into the
// real ~/.claude/state, so that is asserted first and on its own.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-run-state-registry.cjs -> hooks/test -> hooks: resolve
// from the script's own location, not the homedir, so this suite exercises
// the checkout it lives in rather than always the live ~/.claude install
// (the defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');
// The script under test is overridable so a new version can be driven from a
// scratch copy while a live /ship run is still invoking the installed one.
const BIN = process.env.RUN_STATE_BIN || path.join(HOOKS, 'run-state.cjs');
let pass = 0, fail = 0;
const failures = [];

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// A scratch CLAUDE_CONFIG_DIR per run, so nothing here can reach the real one.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-config-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-repo-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-other-'));

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
git(['init', '-q'], REPO);
git(['init', '-q'], OTHER);

// Two chats. The id is what the harness exports as CLAUDE_CODE_SESSION_ID; the
// selector is keyed on it, which is the convention brief-exec/brief-review and
// the other session-scoped hooks already follow.
const CHAT_A = 'sess-aaaa-0001';
const CHAT_B = 'sess-bbbb-0002';

function rs(args, { cwd = REPO, session = null, config = CONFIG } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  if (session) env.CLAUDE_CODE_SESSION_ID = session;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [BIN, ...args],
    { cwd, encoding: 'utf-8', env });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { json, stdout: r.stdout, stderr: r.stderr, code: r.status };
}

// =============================================================================
console.log('\nrun-state.cjs — the registry is isolated by CLAUDE_CONFIG_DIR');

// Asserted before anything else: if this fails, every test below is writing into
// the developer's real state directory and a "pass" would be meaningless. Counted
// entirely within a SECOND scratch config dir of its own -- reading the real
// ~/.claude/state/ship-runs directly (as this used to) makes the test fail
// whenever another session on the machine writes there at the same time,
// which is a real, observed flake and proves nothing about this script. This
// control dir is separate from CONFIG (used by every other test below) so
// checking it disturbs nothing that alpha/beta depend on afterward.
const ISOLATION = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-isolation-config-'));
const isolationRuns = path.join(ISOLATION, 'state', 'ship-runs');
const isolationBefore = fs.existsSync(isolationRuns)
  ? fs.readdirSync(isolationRuns, { recursive: true }).filter((f) => f.endsWith('.json')).length : 0;
rs(['start', '--feature', 'alpha'], { session: CHAT_A });
const isolationAfter = fs.existsSync(isolationRuns)
  ? fs.readdirSync(isolationRuns, { recursive: true }).filter((f) => f.endsWith('.json')).length : 0;
check('starting a run under the MAIN config dir does not touch this control dir',
  isolationAfter, isolationBefore);
check('the scratch config dir did receive the run',
  fs.existsSync(path.join(CONFIG, 'state', 'ship-runs')), true);
rs(['start', '--feature', 'beta'], { session: CHAT_B });
fs.rmSync(ISOLATION, { recursive: true, force: true });

// =============================================================================
console.log('\nrun-state.cjs — two runs coexist in one checkout');

// The pairing: both runs must EXIST and be DISTINCT before any isolation claim
// below means anything.
const a1 = rs(['get'], { session: CHAT_A }).json;
const b1 = rs(['get'], { session: CHAT_B }).json;
check('chat A resolves its own run', a1 && a1.feature, 'alpha');
check('chat B resolves its own run', b1 && b1.feature, 'beta');
check('the two runs are distinct objects', a1 && b1 && a1.feature !== b1.feature, true);

// The bug this whole change exists to fix: today `start` in chat B overwrites the
// one file, so chat A silently becomes chat B's run.
check('starting B did not repoint A', rs(['get'], { session: CHAT_A }).json?.feature, 'alpha');

// =============================================================================
console.log('\nrun-state.cjs — counters do not leak between runs');

rs(['phase', 'executing'], { session: CHAT_A });
rs(['phase', 'executing'], { session: CHAT_B });
rs(['begin-brief', '1'], { session: CHAT_A });
rs(['review-round'], { session: CHAT_A });
rs(['review-round'], { session: CHAT_A });

const aArmed = rs(['get'], { session: CHAT_A }).json;
check('A has two review rounds before B moves', aArmed?.reviewRounds, 2);

// `reviewRounds` is the counter that actually bounds the loop: execute.md
// escalates to the debugger at >= 2, and begin-brief zeroes it whenever the brief
// number changes. With one shared file, B beginning a different brief resets A's
// count to 0 and the implementer/reviewer ping-pong becomes unbounded.
rs(['begin-brief', '2'], { session: CHAT_B });
const aAfter = rs(['get'], { session: CHAT_A }).json;
check("B's begin-brief leaves A's reviewRounds alone", aAfter?.reviewRounds, 2);
check("B's begin-brief leaves A's currentBrief alone", aAfter?.currentBrief, 1);
check("B's own brief is its own", rs(['get'], { session: CHAT_B }).json?.currentBrief, 2);

// `attempt` too. It is not what bounds the loop -- outside run-state.cjs it is only
// printed -- but it is what a resumed run reports as "attempts on that brief so far",
// and a number inflated by another chat's re-entry is a wrong answer to a question
// someone asks when they are already confused.
rs(['begin-brief', '1'], { session: CHAT_A });     // re-entering the SAME brief
check('re-entering a brief increments its own attempt',
  rs(['get'], { session: CHAT_A }).json?.attempt, 2);
rs(['begin-brief', '2'], { session: CHAT_B });
rs(['begin-brief', '2'], { session: CHAT_B });
check("B's re-entries leave A's attempt alone",
  rs(['get'], { session: CHAT_A }).json?.attempt, 2);
check("and B's own attempt counted", rs(['get'], { session: CHAT_B }).json?.attempt, 3);

// The pairing for the two checks above: begin-brief MUST still zero the counter
// within one run, or "it did not reset" would pass because it never resets.
rs(['begin-brief', '9'], { session: CHAT_A });
check('begin-brief still zeroes reviewRounds within one run',
  rs(['get'], { session: CHAT_A }).json?.reviewRounds, 0);

// =============================================================================
console.log('\nrun-state.cjs — a misspelled address fails loudly');

// `get alpha` looks like it addresses a run and does not: a positional argument was
// ignored, so the command returned whichever run the POINTER resolved -- a different
// one -- with exit 0 and no diagnostic. That is the precise failure this whole change
// exists to stop, arriving through the interface meant to prevent it.
const stray = rs(['get', 'alpha'], { session: CHAT_B });
check('a positional run name is refused, not ignored', stray.code, 2);
check('and it says what to type instead', /--feature/.test(stray.stderr), true);

// The pairing: the supported spellings must still work, or "it refused" is just a
// broken command.
check('--feature still addresses a run',
  rs(['get', '--feature', 'alpha'], { session: CHAT_B }).json?.feature, 'alpha');
check('--all still lists', Array.isArray(rs(['get', '--all'], { session: CHAT_B }).json), true);
check('bare get still resolves this chat\'s run',
  rs(['get'], { session: CHAT_B }).json?.feature, 'beta');

// Task 1's done-when says runs must FINISH independently. Finishing both and checking
// neither is offered would pass on a shared file too, so finish one and read the other.
// In a repo of its own: finishing CHAT_A's run here would leave the checkpoint-restore
// section below with nothing unfinished to be offered, and those cases would then pass
// for the wrong reason.
const FREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-finish-'));
git(['init', '-q'], FREPO);
const F1 = 'sess-fin-0001', F2 = 'sess-fin-0002';
rs(['start', '--feature', 'fin-a'], { cwd: FREPO, session: F1 });
rs(['start', '--feature', 'fin-b'], { cwd: FREPO, session: F2 });
rs(['finish'], { cwd: FREPO, session: F1 });
check('finishing one leaves the other unfinished',
  rs(['get'], { cwd: FREPO, session: F2 }).json?.finishedAt, null);
check('and the finished one is finished',
  typeof rs(['get'], { cwd: FREPO, session: F1 }).json?.finishedAt, 'string');

// =============================================================================
console.log('\nrun-state.cjs — the selector never guesses');

// A chat with no pointer must not inherit someone else's run. This is the bare
// `/ship` bug: ship.md only refuses a second run when $ARGUMENTS is non-empty, so
// a bare resume picks up whatever the file holds.
const stranger = rs(['get'], { session: 'sess-cccc-0003' });
check('a chat with no pointer resolves no run', stranger.json?.feature ?? null, null);

// ...but it must be able to SEE them, or the table /ship prints has nothing in it.
const listed = rs(['get', '--all'], { session: 'sess-cccc-0003' }).json;
const names = Array.isArray(listed) ? listed.map((r) => r.feature).sort() : null;
check('listing shows every run in the repo', names, ['alpha', 'beta']);

// =============================================================================
console.log('\nrun-state.cjs — the repo key follows the git dir, not the path');

// Worktrees of one repo must share a registry, or a run started in the checkout
// is invisible to the agent working in its worktree.
const WT = path.join(os.tmpdir(), `rs-wt-${process.pid}`);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], REPO);
const wtAdd = git(['worktree', 'add', '-q', '-b', 'wt', WT], REPO);
if (wtAdd.status === 0) {
  const fromWorktree = rs(['get', '--all'], { cwd: WT, session: 'sess-dddd-0004' }).json;
  const wtNames = Array.isArray(fromWorktree) ? fromWorktree.map((r) => r.feature).sort() : null;
  check('a worktree sees the same repo registry', wtNames, ['alpha', 'beta']);
} else {
  check('worktree could be created for the key test', wtAdd.stderr.trim(), '');
}

// ...and an unrelated repo must NOT, or the key is not separating anything.
const elsewhere = rs(['get', '--all'], { cwd: OTHER, session: 'sess-eeee-0005' }).json;
check('an unrelated repo has its own registry', Array.isArray(elsewhere) ? elsewhere.length : null, 0);

// =============================================================================
console.log('\nrun-state.cjs — a legacy run keeps working untouched');

// There is a real one of these executing while this change is written: a run on
// the old single-file format, mid-flight. It must keep resolving and keep being
// written where it already lives, or the migration breaks a run in progress.
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-legacy-'));
git(['init', '-q'], LEGACY);
fs.mkdirSync(path.join(LEGACY, 'docs'), { recursive: true });
const legacyFile = path.join(LEGACY, 'docs', '.run-state.json');
fs.writeFileSync(legacyFile, JSON.stringify({
  feature: 'legacy-run', phase: 'executing', planFile: null,
  branch: 'feature/legacy-run', baseBranch: 'main', briefFile: 'docs/briefs-legacy.md',
  currentBrief: 3, attempt: 1, reviewRounds: 1, debugRounds: 0, blocked: [],
  startedAt: '2026-09-22T10:00:00.000Z', lastCommit: 'abc1234', finishedAt: null,
}, null, 2));

const legacyRead = rs(['get'], { cwd: LEGACY, session: 'sess-ffff-0006' }).json;
check('a legacy run still resolves with no pointer', legacyRead?.feature, 'legacy-run');
check('a legacy run keeps its brief number', legacyRead?.currentBrief, 3);

rs(['review-round'], { cwd: LEGACY, session: 'sess-ffff-0006' });
const legacyOnDisk = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
check('a legacy run is still written to its own file', legacyOnDisk.reviewRounds, 2);

// =============================================================================
console.log('\nreviewRounds counts REJECTED verdicts, not dispatches');

// execute.md:74 escalates to the debugger at `reviewRounds >= 2`, calling that
// "after two REJECTED verdicts". The counter was bumped when the reviewer was
// DISPATCHED, before any verdict existed, so the threshold tripped after one
// rejection. Measured on a live run: reviewRounds hit 2 thirty-two seconds before
// the second reviewer started, and that reviewer returned APPROVED.
//
// Recording it from the verdict rather than from an instruction also follows
// run-state.cjs's own rationale: a script cannot forget to bump a counter, and
// prose can.
const VREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-verdict-'));
git(['init', '-q'], VREPO);
const VS = 'sess-verdict-0001';
rs(['start', '--feature', 'verdict-feature'], { cwd: VREPO, session: VS });
rs(['begin-brief', '4'], { cwd: VREPO, session: VS });

const review = (verdict) => spawnSync('node', [path.join(HOOKS, 'verify-record.cjs')], {
  // The PostToolUse shape: SubagentStop reads the report out of a transcript file,
  // which a test has no way to fabricate honestly.
  input: JSON.stringify({
    session_id: VS, cwd: VREPO, hook_event_name: 'PostToolUse',
    tool_input: { description: 'review brief 4' },
    tool_response: { content: `## Review Verdict\n${verdict}\n` },
  }),
  encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
});
const rounds = () => rs(['get'], { cwd: VREPO, session: VS }).json?.reviewRounds;

review('REJECTED');
check('a rejection counts', rounds(), 1);
review('APPROVED');
check('an approval does NOT count', rounds(), 1);
review('REJECTED');
check('a second rejection reaches the escalation threshold', rounds(), 2);

// =============================================================================
console.log('\none subagent stop counts once however many registrations deliver it');

// The checkout's settings.json and the installed plugin's hooks.json both
// register verify-record.cjs, so on a machine with both the harness delivers one
// SubagentStop to it twice. The bump above is not idempotent, so one REJECTED
// verdict read reviewRounds = 2 and tripped /execute's debugger escalation.
const DREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-dup-'));
git(['init', '-q'], DREPO);
const DS = 'sess-dup-0001';
rs(['start', '--feature', 'dup-feature'], { cwd: DREPO, session: DS });
rs(['begin-brief', '4'], { cwd: DREPO, session: DS });
const DT = path.join(DREPO, 'transcript.jsonl');
fs.writeFileSync(DT, [
  { type: 'user', message: { role: 'user', content: 'Review BRIEF 4 against its acceptance criteria.' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'SubagentHandback', input: { message: '## Review Verdict\nREJECTED\n' } }] } },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
const dstop = (agentId) => spawnSync('node', [path.join(HOOKS, 'verify-record.cjs')], {
  input: JSON.stringify({
    session_id: DS, cwd: DREPO, hook_event_name: 'SubagentStop',
    agent_type: 'reviewer', agent_id: agentId, agent_transcript_path: DT,
  }),
  encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
});
const dget = () => rs(['get'], { cwd: DREPO, session: DS }).json;

dstop('reviewer-1');
dstop('reviewer-1');
check('one REJECTED stop delivered twice counts once', dget().inFlight?.['4']?.reviewRounds, 1);
// MUST NOT swallow a real second rejection: a different agent is a new round.
dstop('reviewer-2');
check('a second reviewer rejecting is a second round', dget().inFlight?.['4']?.reviewRounds, 2);

// =============================================================================
console.log('\na run-state call between REJECTED verdicts must not erase the count');

// verify-record.cjs writes reviewRounds directly at the top level (verify-record.cjs
// :118-126) rather than through withBriefRound/syncTop. The NEXT run-state.cjs call
// normalises the file and, before the reconcile below existed, syncTop copied the
// (stale, unbumped) per-brief entry back OVER that direct write -- so a debug-round
// dispatched right after a REJECTED verdict, or a resume via begin-brief, silently
// reset the count the escalation threshold depends on. Two REJECTED verdicts then a
// debug-round used to leave reviewRounds at 0 instead of 2; one REJECTED then a
// same-brief resume used to leave it at 0 instead of 1.
const LREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-reconcile-'));
git(['init', '-q'], LREPO);
const LS = 'sess-reconcile-0001';
rs(['start', '--feature', 'reconcile-feature'], { cwd: LREPO, session: LS });
rs(['begin-brief', '4'], { cwd: LREPO, session: LS });

const lreview = (verdict) => spawnSync('node', [path.join(HOOKS, 'verify-record.cjs')], {
  input: JSON.stringify({
    session_id: LS, cwd: LREPO, hook_event_name: 'PostToolUse',
    tool_input: { description: 'review brief 4' },
    tool_response: { content: `## Review Verdict\n${verdict}\n` },
  }),
  encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
});
const lget = () => rs(['get'], { cwd: LREPO, session: LS }).json;

lreview('REJECTED');
lreview('REJECTED');
rs(['debug-round'], { cwd: LREPO, session: LS });
check('reviewRounds survives a debug-round after two REJECTED verdicts', lget().reviewRounds, 2);
check('the debug-round itself still counted', lget().debugRounds, 1);

// A fresh brief/session for the second scenario, so its expectations do not
// depend on the counters the first scenario left behind.
const RREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-reconcile-resume-'));
git(['init', '-q'], RREPO);
const RS_ = 'sess-reconcile-resume-0001';
rs(['start', '--feature', 'reconcile-resume-feature'], { cwd: RREPO, session: RS_ });
rs(['begin-brief', '4'], { cwd: RREPO, session: RS_ });
spawnSync('node', [path.join(HOOKS, 'verify-record.cjs')], {
  input: JSON.stringify({
    session_id: RS_, cwd: RREPO, hook_event_name: 'PostToolUse',
    tool_input: { description: 'review brief 4' },
    tool_response: { content: '## Review Verdict\nREJECTED\n' },
  }),
  encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
});
rs(['begin-brief', '4'], { cwd: RREPO, session: RS_ });
check('reviewRounds survives a same-brief resume after one REJECTED verdict',
  rs(['get'], { cwd: RREPO, session: RS_ }).json?.reviewRounds, 1);

// =============================================================================
console.log('\nwrites replace the file by rename, not by mutating it in place');

// A direct fs.writeFileSync passes every other check here, including "no temp
// files are left behind" above -- that one passes trivially when no temp file
// was ever made. Atomicity is only observable through what a rename does that a
// truncate-and-rewrite cannot: a file descriptor opened before the write keeps
// reading the OLD inode's bytes afterward, because rename replaces the
// directory entry rather than touching data anyone already has open. A writer
// that mutates the same inode in place would make that same descriptor observe
// the NEW content, since there would only ever be the one inode to read from.
const ATREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-atomic-'));
git(['init', '-q'], ATREPO);
const ATS = 'sess-atomic-0001';
rs(['start', '--feature', 'atomic-feature'], { cwd: ATREPO, session: ATS });

const runsRoot = path.join(CONFIG, 'state', 'ship-runs');
const atFile = (() => {
  for (const repo of fs.readdirSync(runsRoot)) {
    const p = path.join(runsRoot, repo, 'atomic-feature.json');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('atomic-feature.json was never written');
})();

// The inode argument is POSIX's. Windows refuses to rename over a file any
// process holds open, so a descriptor held across the whole write is a write
// that can never land there; the reader case below is what Windows can prove.
if (process.platform === 'win32') {
  console.log('  skip (win32 cannot rename over a file held open across the write)');
} else {
  const before = fs.readFileSync(atFile, 'utf-8');
  const preFd = fs.openSync(atFile, 'r');

  rs(['phase', 'executing'], { cwd: ATREPO, session: ATS });

  const after = fs.readFileSync(atFile, 'utf-8');
  const seenByPreFd = fs.readFileSync(preFd, 'utf-8');
  fs.closeSync(preFd);

  check('the write actually changed the file on disk', after === before, false);
  check('a handle opened before the write still sees the old content', seenByPreFd, before);
}

// A reader that has the run file open at the instant of the rename -- a hook
// reading it from another process -- must delay the write, not lose it. On
// Windows that rename fails with EPERM while the handle is open, and failing
// on the first attempt lost the update. Here a separate process holds the file
// open across a `phase` call: until the writer's temp file appears (the rename
// is next), then 300 ms more. A fixed hold from the start would expire before
// a slow process start ever reached the rename, and prove nothing.
{
  const ready = path.join(ATREPO, '.holder-ready');
  const holder = require('child_process').spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const path = require('path');
    const file = ${JSON.stringify(atFile)};
    const fd = fs.openSync(file, 'r');
    fs.writeFileSync(${JSON.stringify(ready)}, '');
    const tmpPrefix = '.' + path.basename(file) + '.';
    const deadline = Date.now() + 10000;
    const poll = setInterval(() => {
      const seen = fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(tmpPrefix) && n.endsWith('.tmp'));
      if (!seen && Date.now() < deadline) return;
      clearInterval(poll);
      setTimeout(() => fs.closeSync(fd), 300);
    }, 1);
  `], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) { /* wait for the open */ }
  check('the reader holds the run file open', fs.existsSync(ready), true);
  const beforeHeld = fs.readFileSync(atFile, 'utf-8');
  const held = rs(['phase', 'landing'], { cwd: ATREPO, session: ATS });
  check('a phase write while another process reads the file succeeds', held.code, 0);
  check('and the file on disk changed', fs.readFileSync(atFile, 'utf-8') === beforeHeld, false);
  holder.kill();
}

// =============================================================================
console.log('\nbegin-brief and finish-brief refuse a missing brief number');

// Number(undefined) is NaN, and NaN survives String() as the literal text
// "NaN" -- so a bare `begin-brief` used to create a real inFlight entry keyed
// by that string instead of failing. A usage error is the only honest response
// to a number that was never given.
const NBREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-nan-'));
git(['init', '-q'], NBREPO);
const NBS = 'sess-nan-0001';
rs(['start', '--feature', 'nan-feature'], { cwd: NBREPO, session: NBS });

const noBrief = rs(['begin-brief'], { cwd: NBREPO, session: NBS });
check('begin-brief with no number exits 2', noBrief.code, 2);
check('begin-brief with no number writes no NaN entry',
  rs(['get'], { cwd: NBREPO, session: NBS }).json?.inFlight, {});

rs(['begin-brief', '9'], { cwd: NBREPO, session: NBS });
const noFinish = rs(['finish-brief'], { cwd: NBREPO, session: NBS });
check('finish-brief with no number exits 2', noFinish.code, 2);
check('finish-brief with no number leaves brief 9 in flight',
  Object.keys(rs(['get'], { cwd: NBREPO, session: NBS }).json?.inFlight || {}), ['9']);

// =============================================================================
console.log('\ncheckpoint-write + agent-log stamp THIS chat\'s run');

// The other two readers of the old repo-global file. Both stamp `feature` and the
// brief number onto per-session records, so with two chats in one directory each
// one's checkpoint and every one of its subagent log lines carried the OTHER
// chat's feature. Nothing errored; the data was just wrong.
const XREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cross-'));
git(['init', '-q'], XREPO);
const X1 = 'sess-xa-0001', X2 = 'sess-xb-0002';
rs(['start', '--feature', 'chat-a-feature'], { cwd: XREPO, session: X1 });
rs(['begin-brief', '7'], { cwd: XREPO, session: X1 });
rs(['start', '--feature', 'chat-b-feature'], { cwd: XREPO, session: X2 });
rs(['begin-brief', '3'], { cwd: XREPO, session: X2 });

// agent-log.cjs (dispatched below) reads CLAUDE_AGENT_LOG_DIR for where to write
// its log, same as gate tests scrub SKIP_CODE_GATES: an engineer who has that
// variable exported gets every log line routed off to their own directory, so
// LOG below (read from CONFIG) comes back empty and every assertion that reads
// it fails on data that was never missing, just written somewhere else.
const hook = (script, input) => spawnSync('node', [path.join(HOOKS, script)], {
  input: JSON.stringify(input), encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_AGENT_LOG_DIR: '' },
});

// checkpoint-write stores what the session was doing, for a later restore.
hook('checkpoint-write.cjs', { session_id: X1, cwd: XREPO });
hook('checkpoint-write.cjs', { session_id: X2, cwd: XREPO });
const ck = (sid) => {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG, 'state', 'checkpoint', `${sid}.json`), 'utf-8')); }
  catch { return null; }
};
check("chat A's checkpoint carries chat A's feature", ck(X1)?.feature, 'chat-a-feature');
check("chat B's checkpoint carries chat B's feature", ck(X2)?.feature, 'chat-b-feature');
// The pairing: if both were null the two checks above would agree by accident.
check('the two checkpoints differ', ck(X1)?.feature !== ck(X2)?.feature, true);
check("and A's brief is A's", ck(X1)?.brief, 7);

// agent-log records every subagent dispatch, tagged with the run it belongs to.
const LOG = path.join(CONFIG, 'state', 'agent-log.jsonl');
try { fs.unlinkSync(LOG); } catch {}
hook('agent-log.cjs', { session_id: X1, cwd: XREPO, hook_event_name: 'SubagentStart',
  agent_type: 'implementer', tool_input: { subagent_type: 'implementer', prompt: 'x' } });
hook('agent-log.cjs', { session_id: X2, cwd: XREPO, hook_event_name: 'SubagentStart',
  agent_type: 'reviewer', tool_input: { subagent_type: 'reviewer', prompt: 'y' } });
let logged = [];
try { logged = fs.readFileSync(LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); } catch {}
const bySession = (sid) => logged.find((r) => r.session === sid);
check("chat A's log line carries chat A's feature", bySession(X1)?.feature, 'chat-a-feature');
check("chat B's log line carries chat B's feature", bySession(X2)?.feature, 'chat-b-feature');
check("and A's brief number is A's", bySession(X1)?.brief, 7);

// =============================================================================
console.log('\ncommands agree with the script they call');

// A slash command is prose, so most of what it says cannot be tested. This can:
// every run-state subcommand the commands invoke must be one the script actually
// implements. A typo here is invisible until a run reaches that line and the
// script exits 2 -- which is how `$CLAUDE_SESSION_ID` armed a gate at a path
// nothing ever read.
const COMMANDS = path.join(__dirname, '..', '..', 'commands');
const IMPLEMENTED = new Set(['start', 'current', 'phase', 'branch', 'begin-brief',
  'review-round', 'debug-round', 'block', 'finish-brief', 'finish', 'get', 'table']);

const invoked = new Set();
for (const f of ['ship.md', 'execute.md', 'brief.md', 'land.md', 'blueprint.md']) {
  let src = '';
  try { src = fs.readFileSync(path.join(COMMANDS, f), 'utf-8'); } catch { continue; }
  for (const m of src.matchAll(/run-state\.cjs\s+([a-z-]+)/g)) invoked.add(m[1]);
}
const unknown = [...invoked].filter((c) => !IMPLEMENTED.has(c)).sort();
check('every subcommand the commands call exists', unknown, []);
// The pairing: if the scrape found nothing, the check above passes vacuously.
check('the scrape actually found subcommands', invoked.size > 3, true);

// Each one is also reachable — spelled right in the script's own switch, not just
// present in a list in this test.
// Only the fall-through means unreachable, and it is recognisable because it prints
// the subcommand LIST. A subcommand's own usage message names itself. Treating any
// `usage:` as a failure made this assertion depend on every subcommand silently
// accepting `--help-probe` as a positional -- which is the same laxness that let
// `branch --base main` record '--base' as a branch name.
const FALLTHROUGH = 'usage: run-state.cjs start|';
const unreachable = [...invoked].filter((c) => {
  const r = spawnSync('node', [BIN, c, '--help-probe'],
    { cwd: REPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG } });
  return (r.stderr || '').startsWith(FALLTHROUGH);
}).sort();
check('and none falls through to the usage error', unreachable, []);

// /ship must no longer send a reader to the repo-global file: that is the bug.
const shipSrc = fs.readFileSync(path.join(COMMANDS, 'ship.md'), 'utf-8');
check('ship.md no longer points at docs/.run-state.json',
  shipSrc.includes('docs/.run-state.json'), false);
check('ship.md resolves a run through the table or the pointer',
  /run-state\.cjs\s+(table|current)/.test(shipSrc), true);

// One shared docs/briefs.md renumbers across concurrent features: two runs both
// append BRIEF 4 and the second renumbers work the first already committed.
const briefSrc = fs.readFileSync(path.join(COMMANDS, 'brief.md'), 'utf-8');
check('brief.md names the brief file after the run',
  /briefs-<feature>\.md/.test(briefSrc), true);

// No command may tell an agent to look for a file a registry run never creates. The
// /goal stop-condition named docs/.run-state.json, so an unattended run could not
// satisfy it and ran to the turn cap instead of terminating.
const execSrc = fs.readFileSync(path.join(COMMANDS, 'execute.md'), 'utf-8');
// Anchored at the start of a line: an unanchored /goal matched the PROSE mention
// of `/goal` fifteen lines above the recipe, so the guard read the wrong text and
// its own "was it located" pairing passed on it.
const goal = (execSrc.match(/^\/goal [\s\S]*?^```/m) || [''])[0];
check('the /goal recipe names no file a registry run never creates',
  /docs\/\.run-state\.json|docs\/briefs\.md/.test(goal), false);
// The pairing: if the recipe could not be found, the check above passes vacuously.
check('the /goal recipe was actually located', goal.length > 40, true);

// =============================================================================
console.log('\nrun-state.cjs — the table /ship prints');

// /ship shows this whenever the chat has no pointer, so it has to hold up with no
// network, no `gh`, and a branch that has been deleted. Everything git can answer
// is derived per call rather than stored, which means every one of those lookups
// is a place this can throw.
const TREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-table-'));
git(['init', '-q'], TREPO);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], TREPO);
const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], TREPO).stdout.trim();
git(['branch', 'feature/real-one'], TREPO);

const T1 = 'sess-tbl-0001';
rs(['start', '--feature', 'real-one'], { cwd: TREPO, session: T1 });
rs(['phase', 'executing'], { cwd: TREPO, session: T1 });
rs(['branch', 'feature/real-one', '--base', mainBranch], { cwd: TREPO, session: T1 });
rs(['begin-brief', '2'], { cwd: TREPO, session: T1 });

const T2 = 'sess-tbl-0002';
rs(['start', '--feature', 'ghost-one'], { cwd: TREPO, session: T2 });
rs(['branch', 'feature/deleted-one', '--base', mainBranch], { cwd: TREPO, session: T2 });

function table(env = {}) {
  const r = spawnSync('node', [BIN, 'table'], {
    cwd: TREPO, encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, ...env },
  });
  return { text: r.stdout, code: r.status, stderr: r.stderr };
}

const tbl = table();
check('the table exits cleanly', tbl.code, 0);
check('it lists the first run', tbl.text.includes('real-one'), true);
check('it lists the second run', tbl.text.includes('ghost-one'), true);
check('it shows the phase', tbl.text.includes('executing'), true);
check('it shows progress for a brief in flight', /\b2\b/.test(tbl.text), true);

// A branch that no longer exists is the one genuinely dead state, and the only
// thing /ship offers to drop. It must be visible, not silently blank.
check('a live branch is not flagged as gone', /real-one.*\bgone\b/i.test(tbl.text), false);
check('a deleted branch IS flagged', /ghost-one.*\bgone\b/i.test(tbl.text), true);

// The degradation case, driven rather than read. A `gh` on PATH that fails is the
// realistic shape of "no network / not logged in"; wiping PATH entirely would only
// prove that node cannot start. git and node stay reachable.
const FAKEBIN = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bin-'));
fs.writeFileSync(path.join(FAKEBIN, 'gh'),
  '#!/bin/sh\necho "error connecting to api.github.com" >&2\nexit 1\n', { mode: 0o755 });
const broken = table({ PATH: `${FAKEBIN}:${process.env.PATH}` });
check('it still exits cleanly with gh unreachable', broken.code, 0);
check('and still lists the runs', broken.text.includes('real-one'), true);
check('and throws nothing to stderr', broken.stderr.trim(), '');

// An empty repo prints a usable message rather than an empty frame.
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-empty-'));
git(['init', '-q'], EMPTY);
const none = spawnSync('node', [BIN, 'table'],
  { cwd: EMPTY, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG } });
check('an empty repo says so', /no .*runs/i.test(none.stdout), true);
check('and still exits cleanly', none.status, 0);

// =============================================================================
console.log('\ncheckpoint-restore.cjs — SessionStart still surfaces unfinished runs');

// The crash / reboot / fork path. checkpoint-restore.cjs's own header says the
// session id is NEW for startup|clear|fork, which is exactly why durable state
// exists -- so a pointer keyed on the session can never resolve here. It must
// therefore LIST what is unfinished rather than select one, or moving runs into
// the registry silently deletes the recovery offer.
function restore(cwd, source = 'startup', session = 'sess-fresh-0009') {
  const r = spawnSync('node', [path.join(HOOKS, 'checkpoint-restore.cjs')], {
    input: JSON.stringify({ session_id: session, cwd, source }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = null; }
  return out?.hookSpecificOutput?.additionalContext || '';
}

// REPO holds alpha (brief 9 in flight) and beta (brief 2 in flight) from above.
const ctx = restore(REPO);
check('a fresh session is told about alpha', ctx.includes('alpha'), true);
check('a fresh session is told about beta', ctx.includes('beta'), true);

// The pairing, and the point of accepted-defect D1: with two runs unfinished it
// must not pick one. A hook that announces "the" run has guessed.
check('it does not claim there is a single run', /\bthe run\b/i.test(ctx), false);

// A finished run is not an unfinished one -- without this, "it mentions alpha"
// would keep passing forever once alpha completes.
rs(['finish'], { session: CHAT_A });
rs(['finish'], { session: CHAT_B });
const afterFinish = restore(REPO);
check('a finished run is not offered', afterFinish.includes('alpha'), false);
check('neither is the other one', afterFinish.includes('beta'), false);

// A legacy run must still be surfaced, or a run in flight when this lands loses
// its recovery the moment the machine reboots.
check('a legacy run is still surfaced', restore(LEGACY).includes('legacy-run'), true);

// And a repo with nothing unfinished says nothing at all.
check('a repo with no runs injects nothing', restore(OTHER).trim(), '');

// =============================================================================
// `branch` takes a name first. ship.md's Start step documents
// `run-state.cjs branch --base <branch>` for recording the base before the work
// branch exists, and that form put the literal string '--base' in `branch` --
// after which the real `branch feature/x` call was refused as "already on
// '--base'", which is how this was found: it blocked a live run.
const FB = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-flagbranch-'));
git(['init', '-q'], FB);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], FB);
const FBS = 'sess-flagbranch-01';
rs(['start', '--feature', 'flagbranch'], { cwd: FB, session: FBS });

rs(['branch', '--base', 'main'], { cwd: FB, session: FBS });
const afterBaseOnly = rs(['get'], { cwd: FB, session: FBS }).json;
check('branch --base does not record the flag as a branch name',
  afterBaseOnly?.branch, null);
check('branch --base still records the base', afterBaseOnly?.baseBranch, 'main');

// And the real call must then succeed, rather than being refused against a
// branch name that was never a branch.
const realBranch = rs(['branch', 'feature/flagbranch'], { cwd: FB, session: FBS });
check('the real branch call is accepted afterwards', realBranch.code, 0);
check('and it is the one recorded',
  rs(['get'], { cwd: FB, session: FBS }).json?.branch, 'feature/flagbranch');

// =============================================================================
console.log('\nrun-state.cjs — inFlight tracks several briefs within one run');

// A parallel review group (BRIEF 8) begins more than one brief in the SAME run
// before any of them finishes. One shared top-level counter cannot tell brief 1's
// rounds from brief 2's; inFlight must.
const IFREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-inflight-'));
git(['init', '-q'], IFREPO);
const IFS = 'sess-inflight-0001';
rs(['start', '--feature', 'inflight-feature'], { cwd: IFREPO, session: IFS });

rs(['begin-brief', '1'], { cwd: IFREPO, session: IFS });
rs(['begin-brief', '2'], { cwd: IFREPO, session: IFS });
const bothBegun = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('brief 1 is in flight', bothBegun?.inFlight?.['1']?.reviewRounds, 0);
check('brief 2 is in flight', bothBegun?.inFlight?.['2']?.reviewRounds, 0);

// A round on brief 1 must not move brief 2's count.
rs(['review-round', '1'], { cwd: IFREPO, session: IFS });
const afterRound1 = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('a review-round on brief 1 counts on brief 1',
  afterRound1?.inFlight?.['1']?.reviewRounds, 1);
check("brief 2's count is left at 0 by brief 1's round",
  afterRound1?.inFlight?.['2']?.reviewRounds, 0);

// A debug-round on brief 2 must equally not move brief 1's count.
rs(['debug-round', '2'], { cwd: IFREPO, session: IFS });
const afterDebug2 = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('a debug-round on brief 2 counts on brief 2',
  afterDebug2?.inFlight?.['2']?.debugRounds, 1);
check("brief 1's debugRounds is left at 0 by brief 2's round",
  afterDebug2?.inFlight?.['1']?.debugRounds, 0);

// Finishing brief 1 must not drop brief 2's entry.
rs(['finish-brief', '1'], { cwd: IFREPO, session: IFS });
const afterFinish1 = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('finishing brief 1 removes its entry', afterFinish1?.inFlight?.['1'], undefined);
check('finishing brief 1 keeps brief 2 in flight',
  afterFinish1?.inFlight?.['2']?.reviewRounds, 0);
check('finishing brief 1 keeps brief 2\'s debugRounds',
  afterFinish1?.inFlight?.['2']?.debugRounds, 1);

// Re-entering brief 2 keeps its counters and only bumps attempt.
rs(['begin-brief', '2'], { cwd: IFREPO, session: IFS });
const reentered2 = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('re-entering brief 2 keeps its reviewRounds',
  reentered2?.inFlight?.['2']?.reviewRounds, 0);
check('re-entering brief 2 keeps its debugRounds',
  reentered2?.inFlight?.['2']?.debugRounds, 1);
check('re-entering brief 2 bumps its own attempt',
  reentered2?.inFlight?.['2']?.attempt, 2);

// The false pass the plan calls out by name: an in-process check would still see
// inFlight on the object even if blank() never declared it, because the value in
// memory carries forward regardless. Only a SEPARATE process, reading the file
// back from disk through normalise(), notices the field was never a legal key.
// So this drives it through the CLI on both sides of an unrelated `phase` call.
rs(['phase', 'executing'], { cwd: IFREPO, session: IFS });
const afterPhase = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check('inFlight survives a following phase call',
  afterPhase?.inFlight?.['2']?.reviewRounds, 0);
check('and the phase itself was recorded', afterPhase?.phase, 'executing');
check('and brief 2 is still the only one in flight',
  Object.keys(afterPhase?.inFlight || {}), ['2']);

// Writes go through a temp file and a rename: nothing named *.tmp should ever be
// left lying around the run's own directory after a burst of writes, which is
// what a group of reviewers finishing at once produces.
for (let i = 0; i < 5; i++) rs(['review-round', '2'], { cwd: IFREPO, session: IFS });
const ifDir = path.join(CONFIG, 'state', 'ship-runs');
let leftoverTmp = [];
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.tmp$/.test(entry.name)) leftoverTmp.push(p);
  }
};
try { walk(ifDir); } catch {}
check('no temp files are left behind by the atomic writer', leftoverTmp, []);

// An EXPLICIT numeric brief argument equal to currentBrief must still sync
// the top-level mirror -- the check above only proved no temp files leaked
// from the same five calls, never that their effect reached the fields every
// single-brief caller (execute.md's own reviewRounds >= 2 check) actually
// reads. Brief 2 was made current by the begin-brief calls above, so
// `review-round 2` here is exercising withBriefRound's `n === s.currentBrief`
// branch with an explicit, not defaulted, `n`.
const afterExplicitCurrent = rs(['get'], { cwd: IFREPO, session: IFS }).json;
check("an explicit review-round on the CURRENT brief syncs the top-level mirror",
  afterExplicitCurrent?.reviewRounds, afterExplicitCurrent?.inFlight?.['2']?.reviewRounds);
check('and that mirrored value is the one the five calls actually produced',
  afterExplicitCurrent?.reviewRounds, 5);

// =============================================================================
console.log('\nrun-state.cjs — writeJson removes its own .tmp file when the write fails');

// writeJson's try/catch only has a real branch to prove if fs.writeFileSync
// (or the rename) can be made to throw. Sabotaging the DIRECTORY into a file
// makes mkdirSync succeed (it already exists) while the write inside it
// fails, which is the shape a full disk or a permissions error takes without
// this test needing to actually fill a disk.
{
  const WJREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-writejson-tmp-'));
  git(['init', '-q'], WJREPO);
  const wjSession = 'sess-writejson-tmp-0001';
  rs(['start', '--feature', 'writejson-tmp-feature'], { cwd: WJREPO, session: wjSession });
  const wjRunDir = (() => {
    for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
      const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'writejson-tmp-feature.json');
      if (fs.existsSync(p)) return path.dirname(p);
    }
    throw new Error('writejson-tmp-feature.json was never written');
  })();
  // Replace the run file itself with a directory of the SAME name: writeJson's
  // rename(tmp, file) then fails with EISDIR (a directory cannot be the target
  // of a rename onto a regular file), landing squarely in writeJson's catch.
  const wjFile = path.join(wjRunDir, 'writejson-tmp-feature.json');
  fs.rmSync(wjFile, { force: true });
  fs.mkdirSync(wjFile);
  const wjResult = rs(['phase', 'executing'], { cwd: WJREPO, session: wjSession });
  check('a write that fails to rename exits non-zero', wjResult.code === 0, false);
  const leftoverWjTmp = fs.readdirSync(wjRunDir).filter((f) => /\.tmp$/.test(f));
  check('and its .tmp file was cleaned up rather than left behind', leftoverWjTmp, []);
  fs.rmSync(wjFile, { recursive: true, force: true });
  fs.rmSync(WJREPO, { recursive: true, force: true });
}

// =============================================================================
console.log('\nrun-state.cjs — block and finish-brief refuse a missing brief number the same way begin-brief does');

// `block` had no guard at all: Number(undefined) is NaN, and String(NaN) is
// the literal text "NaN" -- a bare `block` used to write a real blocked entry
// keyed by that string (brief: NaN) instead of failing loudly, the same
// defect begin-brief and finish-brief were already fixed for.
const NB2REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-block-nan-'));
git(['init', '-q'], NB2REPO);
const NB2S = 'sess-block-nan-0001';
rs(['start', '--feature', 'block-nan-feature'], { cwd: NB2REPO, session: NB2S });
const noBlockNumber = rs(['block'], { cwd: NB2REPO, session: NB2S });
check('block with no number exits 2', noBlockNumber.code, 2);
check('block with no number records no NaN entry',
  rs(['get'], { cwd: NB2REPO, session: NB2S }).json?.blocked, []);

// =============================================================================
console.log('\nrun-state.cjs — finish clears every stale inFlight entry, not just currentBrief');

// `finish` only ever cleared `currentBrief`, `phase` and set `finishedAt` --
// any OTHER brief still recorded in inFlight (a parallel review group that
// finished the run before every one of its briefs individually called
// finish-brief) survived into the "finished" run file. A resumed run that
// reads inFlight afterward would see counters for briefs the run no longer
// has any business tracking.
const FINREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-finish-inflight-'));
git(['init', '-q'], FINREPO);
const FINS = 'sess-finish-inflight-0001';
rs(['start', '--feature', 'finish-inflight-feature'], { cwd: FINREPO, session: FINS });
rs(['begin-brief', '1'], { cwd: FINREPO, session: FINS });
rs(['begin-brief', '2'], { cwd: FINREPO, session: FINS });
rs(['finish'], { cwd: FINREPO, session: FINS });
const finishedState = rs(['get'], { cwd: FINREPO, session: FINS }).json;
check('finish clears every inFlight entry', finishedState?.inFlight, {});
check('and still records finishedAt', typeof finishedState?.finishedAt, 'string');

// =============================================================================
console.log('\nrun-state.cjs — a session id that could climb out of its directory is rejected');

// briefExecArmFile joins the raw session id straight into a path with no
// safe() flattening (unlike pointerPath, which already flattens it): a
// session id of '../../../../tmp/x' resolves the arm-file directory entirely
// outside state/brief-exec, escaping CLAUDE_CONFIG_DIR. Reached through
// block/finish-brief, the only two callers of disarmBriefArm.
const TRAVREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-traversal-'));
git(['init', '-q'], TRAVREPO);
const traversalSession = '../../../../tmp/rs-traversal-marker';
const travStart = rs(['start', '--feature', 'traversal-feature'], { cwd: TRAVREPO, session: traversalSession });
check('a session id containing .. is rejected before any write',
  travStart.code, 2);
check('and it says why', /session|\.\.|separator/i.test(travStart.stderr), true);

const slashSession = 'sess/with/slash';
const slashStart = rs(['start', '--feature', 'slash-feature'], { cwd: TRAVREPO, session: slashSession });
check('a session id containing a path separator is rejected', slashStart.code, 2);

// The pairing: an ordinary session id must still work, or the guard is
// rejecting everything rather than just the dangerous shapes.
const ordinaryStart = rs(['start', '--feature', 'ordinary-feature'], { cwd: TRAVREPO, session: 'sess-ordinary-0001' });
check('an ordinary session id is accepted', ordinaryStart.code, 0);

// The escape itself must never have landed on disk even before this session
// id was rejected outright -- proving the traversal path is closed, not just
// that main() now refuses early for an unrelated reason.
const escapedDir = path.resolve(CONFIG, '..', '..', '..', 'tmp', 'rs-traversal-marker');
check('no directory was ever created outside the config dir', fs.existsSync(escapedDir), false);
fs.rmSync(TRAVREPO, { recursive: true, force: true });

// =============================================================================
console.log('\nrun-state.cjs — a legacy run\'s lock and temp files never land in the repo');

// LOW finding: lockPathFor(file) is `${file}.lock`, and for a legacy run
// `file` IS <repo>/docs/.run-state.json -- so its lock and writeJson's own
// .tmp both used to appear inside docs/, where `git add -A` (or an
// unsuspecting `git status`) would see them. Every legacy lock/tmp must
// instead live under <CLAUDE_CONFIG_DIR>/state/locks/, keyed by a hash of the
// legacy file's path so two different repos' legacy runs never collide there.
const LOCKLEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-locklegacy-'));
git(['init', '-q'], LOCKLEGACY);
fs.mkdirSync(path.join(LOCKLEGACY, 'docs'), { recursive: true });
const llFile = path.join(LOCKLEGACY, 'docs', '.run-state.json');
fs.writeFileSync(llFile, JSON.stringify({
  feature: 'll-run', phase: 'executing', planFile: null, branch: null, baseBranch: null,
  briefFile: 'docs/briefs.md', currentBrief: 1, attempt: 1, reviewRounds: 0, debugRounds: 0,
  blocked: [], startedAt: new Date().toISOString(), lastCommit: null, finishedAt: null,
}, null, 2));
const llSession = 'sess-locklegacy-0001';
rs(['phase', 'executing'], { cwd: LOCKLEGACY, session: llSession });
const docsEntries = fs.readdirSync(path.join(LOCKLEGACY, 'docs'));
check('docs/ holds only the legacy state file itself, no .lock or .tmp',
  docsEntries.filter((f) => f !== '.run-state.json'), []);
// The rest of this scenario (proving the redirected lock is actually held
// under CONFIG, not just absent from docs/) needs to catch it WHILE it is
// still open, which needs an async spawn -- continued in raceMain() below,
// where that machinery already exists. LOCKLEGACY is cleaned up there.

// =============================================================================
console.log('\nrun-state.cjs — unlock lists a legacy run\'s lock without ever touching it');

// Round 3 ruling: `unlock` is read-only. It used to resolve `--feature` for
// a legacy run against the REGISTRY path (a different file from where a
// legacy run's lock actually lives, redirected under CONFIG/state/locks/,
// keyed by a hash of the legacy file's own absolute path -- see
// sideFileBase), silently report "no lock present", and leave the real
// legacy lock in place. Now unlock takes no --feature at all: it lists
// EVERY lock for the repo, legacy included, so a legacy lock is found
// through enumeration rather than through a name that could resolve wrong.
const UNLOCKLEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-unlocklegacy-'));
git(['init', '-q'], UNLOCKLEGACY);
fs.mkdirSync(path.join(UNLOCKLEGACY, 'docs'), { recursive: true });
const ulFile = path.join(UNLOCKLEGACY, 'docs', '.run-state.json');
fs.writeFileSync(ulFile, JSON.stringify({
  feature: 'll-run', phase: 'executing', planFile: null, branch: null, baseBranch: null,
  briefFile: 'docs/briefs.md', currentBrief: 1, attempt: 1, reviewRounds: 0, debugRounds: 0,
  blocked: [], startedAt: new Date().toISOString(), lastCommit: null, finishedAt: null,
}, null, 2));
// realpathSync, not path.resolve: the child process's own cwd (what
// legacyPath(cwd) is actually built from) reports macOS's /private/var/...
// form, while UNLOCKLEGACY's raw mkdtemp string is the /var/... symlink
// alias -- the two disagree unless resolved through the same symlink.
const ulHash = crypto.createHash('sha256').update(fs.realpathSync(ulFile)).digest('hex').slice(0, 16);
const ulLockPath = path.join(CONFIG, 'state', 'locks', `${ulHash}.lock`);
fs.mkdirSync(path.dirname(ulLockPath), { recursive: true });
// A lock recorded under a pid that is not alive -- exactly the "crashed
// holder" shape acquireLock's own stale-lock error names in its message.
fs.writeFileSync(ulLockPath, JSON.stringify({ pid: 999999, token: 'dead-legacy-token', at: '2020-01-01T00:00:00.000Z' }));

// A registry run in the SAME repo, alongside the legacy one, so a single
// `unlock` call is proven to enumerate both kinds of lock together rather
// than only the one it happens to be tested against alone.
rs(['start', '--feature', 'll-registry-run'], { cwd: UNLOCKLEGACY, session: 'sess-ll-registry-0001' });
const ulRegistryFile = (() => {
  for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
    const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'll-registry-run.json');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('ll-registry-run.json was never written');
})();
const ulRegistryLockPath = `${ulRegistryFile}.lock`;
fs.writeFileSync(ulRegistryLockPath, JSON.stringify({ pid: 999998, token: 'dead-registry-token', at: '2020-01-01T00:00:00.000Z' }));

const ulReport = rs(['unlock'], { cwd: UNLOCKLEGACY });
check('unlock exits 0 while a legacy lock is present', ulReport.code, 0);
check('and it names the legacy lock\'s own (redirected) path', ulReport.stdout.includes(ulLockPath), true);
check('and it prints an rm line for the dead holder', ulReport.stdout.includes(`rm '${ulLockPath}'`), true);
check('and the legacy lock file itself still exists afterward', fs.existsSync(ulLockPath), true);
check('the SAME call also lists the registry run\'s lock', ulReport.stdout.includes(ulRegistryLockPath), true);
check('and prints its rm line too', ulReport.stdout.includes(`rm '${ulRegistryLockPath}'`), true);
fs.rmSync(UNLOCKLEGACY, { recursive: true, force: true });

// =============================================================================
console.log('\nrun-state.cjs — concurrent writers do not lose an update');

// The reproduction: two parallel `begin-brief` calls both read the file, both
// modify their own in-memory copy, and whichever writes last wins -- the
// other's entry never reaches disk. Measured red against the code before this
// change: 14 of 20 runs lost an inFlight entry. Every write to a run file (or
// the session pointer) must take an exclusive lock around its own
// read-modify-write, or this is exactly the shape that drops a REJECTED
// verdict's review-round bump when two reviewers land at once.
// spawnSync blocks the caller, so "concurrent" here means several child
// processes launched with the async `spawn` API and awaited together --
// spawnSync one after another could never race in the first place.
const { spawn } = require('child_process');
function spawnAsync(args, { cwd = REPO, session = null, config = CONFIG, env: envOverride = {} } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, ...envOverride };
  if (session) env.CLAUDE_CODE_SESSION_ID = session;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const child = spawn('node', [BIN, ...args], { cwd, env });
  const promise = new Promise((resolvePromise) => {
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolvePromise({ code, stderr }));
  });
  // Exposed so a caller can poll the CHILD's own liveness (exitCode) rather
  // than inferring "is it still running" from filesystem side effects that
  // may already have existed before this process was even spawned.
  promise.child = child;
  return promise;
}

async function runConcurrentBeginBriefTrial(cwd, session) {
  await spawnAsync(['start', '--feature', 'race-feature'], { cwd, session });
  const [r4, r5] = await Promise.all([
    spawnAsync(['begin-brief', '4'], { cwd, session }),
    spawnAsync(['begin-brief', '5'], { cwd, session }),
  ]);
  const state = rs(['get'], { cwd, session }).json;
  return { r4, r5, keys: Object.keys(state?.inFlight || {}).sort() };
}

async function raceMain() {
  let lostAnEntry = false;
  let lockFailures = 0;
  for (let i = 0; i < 20; i++) {
    const RACEREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-race-'));
    git(['init', '-q'], RACEREPO);
    const sid = `sess-race-${i}`;
    const { r4, r5, keys } = await runConcurrentBeginBriefTrial(RACEREPO, sid);
    if (JSON.stringify(keys) !== JSON.stringify(['4', '5'])) lostAnEntry = true;
    if (r4.code !== 0) lockFailures++;
    if (r5.code !== 0) lockFailures++;
    fs.rmSync(RACEREPO, { recursive: true, force: true });
  }
  check('20x concurrent begin-brief 4/5 never loses an entry', lostAnEntry, false);
  check('and neither concurrent call was refused the lock', lockFailures, 0);

  // Same shape for review-round: two concurrent bumps on the SAME brief must
  // both land, or the escalation threshold verify-record.cjs relies on can be
  // undercounted by a rejection that arrived at the same instant as another.
  const RRREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-race-round-'));
  git(['init', '-q'], RRREPO);
  const rrSession = 'sess-race-round-0001';
  await spawnAsync(['start', '--feature', 'race-round-feature'], { cwd: RRREPO, session: rrSession });
  let roundLoss = 0;
  for (let i = 0; i < 10; i++) {
    await spawnAsync(['begin-brief', '4'], { cwd: RRREPO, session: rrSession });
    const before = rs(['get'], { cwd: RRREPO, session: rrSession }).json?.inFlight?.['4']?.reviewRounds || 0;
    const bumps = await Promise.all([
      spawnAsync(['review-round', '4'], { cwd: RRREPO, session: rrSession }),
      spawnAsync(['review-round', '4'], { cwd: RRREPO, session: rrSession }),
    ]);
    const after = rs(['get'], { cwd: RRREPO, session: rrSession }).json?.inFlight?.['4']?.reviewRounds || 0;
    if (after - before !== 2) {
      roundLoss++;
      // A refused lock (non-zero exit) and a silently lost update are
      // different bugs; say which one this was.
      console.log(`  round ${i}: ${before} -> ${after}; exits ${bumps.map((b) => b.code).join(', ')}; `
        + `stderr ${JSON.stringify(bumps.map((b) => b.stderr.trim()).filter(Boolean))}`);
    }
    rs(['finish-brief', '4'], { cwd: RRREPO, session: rrSession });
  }
  check('10x concurrent review-round x2 always lands both bumps', roundLoss, 0);
  fs.rmSync(RRREPO, { recursive: true, force: true });

  // =============================================================================
  console.log('\nrun-state.cjs — lock takeover and lock timeout');

  // Automatic stale-lock takeover was removed: renaming a lock by PATH can
  // yank a live lock out from under its real holder (measured directly, by
  // inode tracing, as the cause of a lost `begin-brief` entry under 8-way
  // contention -- see the takeover-safety test below). A lock left by a
  // crashed process is instead diagnosed by whether its recorded pid is
  // still alive, and only a human running `unlock` clears it.
  //
  // A lock recorded under a DEAD pid must make the write fail loudly, naming
  // `unlock`, and must never write anyway.
  const STALEREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-stale-lock-'));
  git(['init', '-q'], STALEREPO);
  const staleSession = 'sess-stale-0001';
  rs(['start', '--feature', 'stale-feature'], { cwd: STALEREPO, session: staleSession });
  const staleRunFile = (() => {
    for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
      const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'stale-feature.json');
      if (fs.existsSync(p)) return p;
    }
    throw new Error('stale-feature.json was never written');
  })();
  const staleLockPath = `${staleRunFile}.lock`;
  // A pid guaranteed not to be alive: kill(DEAD_PID, 0) below must throw ESRCH
  // for this test to mean anything, so that is asserted before relying on it.
  const DEAD_PID = 999999;
  try { process.kill(DEAD_PID, 0); throw new Error('DEAD_PID is unexpectedly alive; pick another'); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
  const staleToken = 'dead-token-aaaa';
  fs.writeFileSync(staleLockPath, JSON.stringify({ pid: DEAD_PID, token: staleToken, at: new Date().toISOString() }));
  const beforeStalePhase = rs(['get'], { cwd: STALEREPO, session: staleSession }).json?.phase;
  const afterStale = rs(['phase', 'executing'], { cwd: STALEREPO, session: staleSession });
  check('a lock seeded with a dead pid fails the command non-zero', afterStale.code !== 0, true);
  check('and it names unlock', /unlock/.test(afterStale.stderr), true);
  // Round 3: `unlock` no longer takes `--feature` or clears anything, so the
  // stale-lock error names the lock's own exact PATH plus both of the two
  // things a human can do about it -- inspect with `unlock`, or `rm` it by
  // hand once the holder pid is confirmed dead.
  check('the stale-lock message names the exact lock path',
    afterStale.stderr.includes(staleLockPath), true);
  check('and it says to run unlock to inspect, or rm if the holder is dead',
    /run `?node .*unlock`? to inspect/.test(afterStale.stderr) && afterStale.stderr.includes(`rm '${staleLockPath}'`), true);
  check('and it does NOT write',
    rs(['get'], { cwd: STALEREPO, session: staleSession }).json?.phase, beforeStalePhase);

  // `unlock` never deletes (round 3 ruling): the dead-pid lock above must
  // still exist after unlock inspects it, and the command that was blocked
  // must still be blocked -- proving unlock reports rather than fixes.
  const inspected = spawnSync('node', [BIN, 'unlock'],
    { cwd: STALEREPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG } });
  check('unlock never exits non-zero for a lock it found', inspected.status, 0);
  check('and the lock file still exists afterward', fs.existsSync(staleLockPath), true);
  check('and it prints the rm line for the dead holder',
    inspected.stdout.includes(`rm '${staleLockPath}'`), true);
  fs.unlinkSync(staleLockPath);
  const afterManualClear = rs(['phase', 'executing'], { cwd: STALEREPO, session: staleSession });
  check('and the command succeeds only once a human removes it by hand', afterManualClear.code, 0);

  // `unlock` prints no rm line while the holder pid is alive -- proven
  // against a real spawned sleeping child, not a guess about what "alive"
  // means.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const ALIVEREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-alive-lock-'));
  git(['init', '-q'], ALIVEREPO);
  const aliveSession = 'sess-alive-lock-0001';
  rs(['start', '--feature', 'alive-feature'], { cwd: ALIVEREPO, session: aliveSession });
  const aliveRunFile = (() => {
    for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
      const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'alive-feature.json');
      if (fs.existsSync(p)) return p;
    }
    throw new Error('alive-feature.json was never written');
  })();
  const aliveLockPath = `${aliveRunFile}.lock`;
  fs.writeFileSync(aliveLockPath, JSON.stringify({ pid: sleeper.pid, token: 'alive-token', at: new Date().toISOString() }));
  const aliveReport = spawnSync('node', [BIN, 'unlock'],
    { cwd: ALIVEREPO, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_SESSION_ID: aliveSession } });
  check('unlock exits 0 while the holder pid is alive', aliveReport.status, 0);
  check('and it prints no rm line for a live holder', aliveReport.stdout.includes('rm '), false);
  check('and the lock file is still there', fs.existsSync(aliveLockPath), true);
  sleeper.kill();
  fs.unlinkSync(aliveLockPath);
  fs.rmSync(ALIVEREPO, { recursive: true, force: true });

  // A FRESH lock, held by a process that is still (simulated as) alive, must
  // make the command fail loudly rather than write without ever taking it, or
  // silently skip the write and report success anyway.
  const FRESHREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-fresh-lock-'));
  git(['init', '-q'], FRESHREPO);
  const freshSession = 'sess-fresh-lock-0001';
  rs(['start', '--feature', 'fresh-feature'], { cwd: FRESHREPO, session: freshSession });
  const freshRunFile = (() => {
    for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
      const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'fresh-feature.json');
      if (fs.existsSync(p)) return p;
    }
    throw new Error('fresh-feature.json was never written');
  })();
  const freshLockPath = `${freshRunFile}.lock`;
  fs.writeFileSync(freshLockPath, JSON.stringify({ pid: process.pid, token: 'fresh-token', at: new Date().toISOString() }));
  const beforePhase = rs(['get'], { cwd: FRESHREPO, session: freshSession }).json?.phase;
  const blocked = rs(['phase', 'landing'], { cwd: FRESHREPO, session: freshSession });
  check('a fresh lock held beyond the bound makes the command exit non-zero', blocked.code !== 0, true);
  check('and it says so on stderr', /lock/i.test(blocked.stderr), true);
  check('and names the holder pid', new RegExp(`pid ${process.pid}\\b`).test(blocked.stderr), true);
  check('and the write never landed',
    rs(['get'], { cwd: FRESHREPO, session: freshSession }).json?.phase, beforePhase);
  fs.unlinkSync(freshLockPath);

  fs.rmSync(STALEREPO, { recursive: true, force: true });
  fs.rmSync(FRESHREPO, { recursive: true, force: true });

  // =============================================================================
  console.log('\nrun-state.cjs — a legacy run\'s lock is redirected under CONFIG while actually held');

  // Continues the LOCKLEGACY scenario above: a synchronous call already
  // proved docs/ ends up clean, but that alone would pass even if the lock
  // were never created anywhere (a no-op writer). Catching the lock file
  // WHILE it is open -- widened with RUN_STATE_TEST_RMW_DELAY_MS -- proves
  // it was really acquired, and specifically under CONFIG's state/locks/.
  const llCall = spawnAsync(['phase', 'landing'], {
    cwd: LOCKLEGACY, session: 'sess-locklegacy-0002', env: { RUN_STATE_TEST_RMW_DELAY_MS: '250' },
  });
  const locksDir = path.join(CONFIG, 'state', 'locks');
  const llDeadline = Date.now() + 2000;
  let sawLegacyLockUnderConfig = false;
  while (Date.now() < llDeadline) {
    try {
      if (fs.readdirSync(locksDir).some((f) => f.endsWith('.lock'))) { sawLegacyLockUnderConfig = true; break; }
    } catch { /* not created yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  await llCall;
  check('the config dir\'s state/locks holds the legacy lock while it is held',
    sawLegacyLockUnderConfig, true);
  fs.rmSync(LOCKLEGACY, { recursive: true, force: true });

  // =============================================================================
  console.log('\nrun-state.cjs — release never deletes a lock whose token is not its own');

  // The takeover this replaces renamed a lock by PATH, which can yank a lock
  // a DIFFERENT process just created at that same path. The token written
  // into the lock at acquire time is what release must check before ever
  // unlinking. Exercised for real, not simulated: a command is given a wide
  // read-modify-write window (RUN_STATE_TEST_RMW_DELAY_MS) so it is still
  // genuinely holding its own lock file when this test process overwrites
  // that SAME file's token underneath it -- standing in for some other
  // writer having cleared and recreated the lock in between (e.g. a
  // mistaken `unlock`). When the command's own `finally` then calls
  // releaseLock, the on-disk token no longer matches what it wrote at
  // acquire time, so a release that checks the token leaves the file alone;
  // a release that deletes unconditionally (the sabotage this pairs with)
  // would destroy the other writer's lock.
  const RELREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-release-token-'));
  git(['init', '-q'], RELREPO);
  const relSession = 'sess-release-token-0001';
  await spawnAsync(['start', '--feature', 'release-token-feature'], { cwd: RELREPO, session: relSession });
  const relRunFile = (() => {
    for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
      const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'release-token-feature.json');
      if (fs.existsSync(p)) return p;
    }
    throw new Error('release-token-feature.json was never written');
  })();
  const relLockPath = `${relRunFile}.lock`;

  const relCommand = spawnAsync(['phase', 'executing'],
    { cwd: RELREPO, session: relSession, env: { RUN_STATE_TEST_RMW_DELAY_MS: '300' } });
  // Poll for the lock file to exist rather than a fixed sleep, so this does
  // not depend on how fast the child reaches acquireLock on a loaded machine.
  // Must yield the event loop between checks (setTimeout, not a synchronous
  // spin) -- a synchronous busy-wait here starves the event loop that
  // `relCommand`'s own spawned child depends on to ever report back, which
  // deadlocks the `await relCommand` below instead of merely polling slowly.
  const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));
  const relDeadline = Date.now() + 2000;
  while (!fs.existsSync(relLockPath) && Date.now() < relDeadline) await sleepAsync(10);
  if (!fs.existsSync(relLockPath)) throw new Error('release-token test: lock file never appeared');
  const foreignToken = 'foreign-token-xyz';
  fs.writeFileSync(relLockPath, JSON.stringify({ pid: 999998, token: foreignToken, at: new Date().toISOString() }));
  const relResult = await relCommand;
  check('the command whose token was swapped still exits 0 (it never re-checks mid-flight)',
    relResult.code, 0);
  const relAfter = readJsonFile(relLockPath);
  check('release leaves a lock whose token it does not own untouched',
    relAfter && relAfter.token, foreignToken);
  try { fs.unlinkSync(relLockPath); } catch { /* a broken releaseLock may have already removed it */ }
  fs.rmSync(RELREPO, { recursive: true, force: true });

  // =============================================================================
  console.log('\nrun-state.cjs — every locked command survives two concurrent invocations');

  // One pairing per command that takes the lock and mutates state keyed so
  // two concurrent calls have two independently observable effects, proving
  // BOTH landed rather than one silently overwriting the other. This is what
  // would go unnoticed if withRunLock's lock were removed from just one
  // command, or if ExitSignal were swapped for process.exit() (which skips
  // withLock's `finally` and leaves the lock behind, wedging the SECOND
  // concurrent call until the retry bound expires and it exits non-zero
  // instead of landing).
  // RUN_STATE_TEST_RMW_DELAY_MS widens the gap between reading state and
  // writing it back on EVERY command (see withRunLock), so two concurrent
  // calls are forced to overlap their read-modify-write instead of only
  // occasionally doing so by scheduling luck. With the lock genuinely held
  // this just makes the pair take longer -- both still land, serialised.
  // Without it (the regression these tests exist to catch), it turns "might
  // lose an update" into "reliably does": both processes read before either
  // writes, so whichever writes last silently discards the other's effect.
  async function concurrentPairLandsBoth(label, cwd, session, mkArgsPair, readBoth) {
    const [a, b] = mkArgsPair();
    const [ra, rb] = await Promise.all([
      spawnAsync(a, { cwd, session, env: { RUN_STATE_TEST_RMW_DELAY_MS: '200' } }),
      spawnAsync(b, { cwd, session, env: { RUN_STATE_TEST_RMW_DELAY_MS: '200' } }),
    ]);
    const bothLanded = readBoth();
    check(`${label}: both concurrent calls exit 0`, ra.code === 0 && rb.code === 0, true);
    check(`${label}: both effects landed`, bothLanded, true);
  }

  // debug-round: two different briefs bumped concurrently must both count.
  {
    const DRREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-debinfo-'));
    git(['init', '-q'], DRREPO);
    const sess = 'sess-lock-debinfo-0001';
    await spawnAsync(['start', '--feature', 'lock-debinfo'], { cwd: DRREPO, session: sess });
    await spawnAsync(['begin-brief', '1'], { cwd: DRREPO, session: sess });
    await spawnAsync(['begin-brief', '2'], { cwd: DRREPO, session: sess });
    await concurrentPairLandsBoth(
      'debug-round',
      DRREPO, sess,
      () => [['debug-round', '1'], ['debug-round', '2']],
      () => {
        const s = rs(['get'], { cwd: DRREPO, session: sess }).json;
        return (s?.inFlight?.['1']?.debugRounds || 0) === 1 && (s?.inFlight?.['2']?.debugRounds || 0) === 1;
      },
    );
    fs.rmSync(DRREPO, { recursive: true, force: true });
  }

  // block: two different briefs blocked concurrently must both be recorded.
  {
    const BLREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-block-'));
    git(['init', '-q'], BLREPO);
    const sess = 'sess-lock-block-0001';
    await spawnAsync(['start', '--feature', 'lock-block'], { cwd: BLREPO, session: sess });
    await spawnAsync(['begin-brief', '1'], { cwd: BLREPO, session: sess });
    await spawnAsync(['begin-brief', '2'], { cwd: BLREPO, session: sess });
    await concurrentPairLandsBoth(
      'block',
      BLREPO, sess,
      () => [['block', '1', '--reason', 'x'], ['block', '2', '--reason', 'y']],
      () => {
        const s = rs(['get'], { cwd: BLREPO, session: sess }).json;
        const blockedNums = (s?.blocked || []).map((b) => b.brief).sort();
        return JSON.stringify(blockedNums) === JSON.stringify([1, 2]);
      },
    );
    fs.rmSync(BLREPO, { recursive: true, force: true });
  }

  // phase: `phase` itself only ever has one caller's value win when raced
  // against another `phase` call on the SAME field, so racing it against
  // ITSELF cannot show two effects landing -- pairing it with `branch
  // --base` (also lock-guarded, also a read-modify-write of the same run
  // file, but a DIFFERENT field) is what actually exercises phase's own
  // lock: without it, phase's read of the pre-branch state and branch's read
  // of the pre-phase state can each compute a `next` that is missing the
  // OTHER's field, and whichever write lands second silently drops it.
  {
    const PHREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-phase-'));
    git(['init', '-q'], PHREPO);
    const sess = 'sess-lock-phase-0001';
    await spawnAsync(['start', '--feature', 'lock-phase'], { cwd: PHREPO, session: sess });
    await concurrentPairLandsBoth(
      'phase',
      PHREPO, sess,
      () => [
        ['phase', 'executing'],
        ['branch', '--base', 'main'],
      ],
      () => {
        const s = rs(['get'], { cwd: PHREPO, session: sess }).json;
        return s?.phase === 'executing' && s?.baseBranch === 'main';
      },
    );
    fs.rmSync(PHREPO, { recursive: true, force: true });
  }

  // finish-brief: two different briefs finished concurrently must both clear.
  {
    const FBREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-finish-'));
    git(['init', '-q'], FBREPO);
    const sess = 'sess-lock-finish-0001';
    await spawnAsync(['start', '--feature', 'lock-finish'], { cwd: FBREPO, session: sess });
    await spawnAsync(['begin-brief', '1'], { cwd: FBREPO, session: sess });
    await spawnAsync(['begin-brief', '2'], { cwd: FBREPO, session: sess });
    await concurrentPairLandsBoth(
      'finish-brief',
      FBREPO, sess,
      () => [['finish-brief', '1'], ['finish-brief', '2']],
      () => {
        const s = rs(['get'], { cwd: FBREPO, session: sess }).json;
        return !('1' in (s?.inFlight || {})) && !('2' in (s?.inFlight || {}));
      },
    );
    fs.rmSync(FBREPO, { recursive: true, force: true });
  }

  // =============================================================================
  console.log('\nrun-state.cjs — withRunLock re-resolves after acquiring, and retries if the pointer moved');

  // Reviewer repro (round 3): pointer -> alpha; a holder locks alpha.json; a
  // pointer-routed command (no --feature) picks alpha as its lock target from
  // an UNLOCKED provisional resolve and then waits on alpha.lock; while it
  // waits, the pointer is repointed at beta; the waiter finally gets
  // alpha.lock -- but by the time its callback runs, the pointer names beta,
  // so the state it reads and writes is beta's, yet the lock it holds (and
  // will release) is alpha's. Two processes can then hold "a" lock each on
  // two DIFFERENT files while believing they are mutually exclusive on the
  // one the pointer now names. Measured effect: a review-round meant for
  // beta lands unlocked, racing anything else touching beta.json directly.
  //
  // withRunLock must notice the mismatch after acquiring and retry: release
  // the lock it holds, resolve again, lock whatever file THAT names, and keep
  // going until the file it holds and the file resolve() names agree.
  {
    const PMREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-pointer-move-'));
    git(['init', '-q'], PMREPO);
    const pmSession = 'sess-pointer-move-0001';
    rs(['start', '--feature', 'pm-alpha'], { cwd: PMREPO, session: pmSession });
    rs(['start', '--feature', 'pm-beta'], { cwd: PMREPO, session: pmSession });
    // Back to alpha: this is the pointer state the waiter's provisional,
    // unlocked resolve will see.
    rs(['current', 'pm-alpha'], { cwd: PMREPO, session: pmSession });
    rs(['begin-brief', '7'], { cwd: PMREPO, session: pmSession, config: CONFIG });
    // `begin-brief` above ran against whatever the pointer named at the time
    // (alpha) and only initialises brief 7 there; beta needs its own brief 7
    // in flight too, addressed explicitly so the pointer is not disturbed.
    rs(['begin-brief', '7', '--feature', 'pm-beta'], { cwd: PMREPO, session: pmSession });

    const pmAlphaFile = (() => {
      for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
        const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'pm-alpha.json');
        if (fs.existsSync(p)) return p;
      }
      throw new Error('pm-alpha.json was never written');
    })();
    const pmAlphaLock = `${pmAlphaFile}.lock`;

    // E holds alpha's lock by hand, standing in for a concurrent command
    // already inside its own withRunLock critical section.
    const eToken = 'pointer-move-holder';
    fs.writeFileSync(pmAlphaLock, JSON.stringify({ pid: process.pid, token: eToken, at: new Date().toISOString() }));

    // A: a pointer-routed review-round (no --feature), given a wide RMW
    // window so its callback is still running (and its lock still held) well
    // after it acquires -- long enough for this test to repoint the session
    // and release E's lock while A is provably still waiting, AND long
    // enough for F (below) to land its own concurrent write to beta while
    // A's write to beta is still in flight.
    const aCall = spawnAsync(['review-round'], {
      cwd: PMREPO, session: pmSession, env: { RUN_STATE_TEST_RMW_DELAY_MS: '250' },
    });

    // The directory already holds pm-alpha.json, pm-beta.json and
    // pm-alpha.json.lock (this test wrote the lock itself, above) BEFORE A
    // is even spawned, so a readdir-length check here is true on its very
    // first read and never actually waits for anything -- its redness, if A
    // were somehow not blocked at all, would depend entirely on scheduling
    // luck rather than on this loop ever iterating. What genuinely indicates
    // A is blocked retrying is A's own child process having been alive for
    // at least one full backoff cycle (LOCK_RETRY_MAX_MS, comfortably over)
    // without exiting -- exitCode stays null on a still-running child.
    const pmStart = Date.now();
    const pmDeadline = pmStart + 2000;
    while ((aCall.child ? aCall.child.exitCode === null : true) && Date.now() - pmStart < 150 && Date.now() < pmDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // A genuine wait has an observable floor: this loop must not return
    // before its own minimum has elapsed, which the readdir version above
    // never guaranteed (it could -- and did -- return on the very first
    // check with zero elapsed time).
    if (Date.now() - pmStart < 150) throw new Error('pointer-move test: wait loop returned without waiting');
    // A is now blocked retrying acquireLock against alpha.lock (held by E).
    // Repoint this session's pointer at beta while A still waits.
    rs(['current', 'pm-beta'], { cwd: PMREPO, session: pmSession });
    // Give A's retry loop a couple of backoff cycles to observe the still-held
    // lock before E releases it.
    await new Promise((r) => setTimeout(r, 60));
    fs.unlinkSync(pmAlphaLock);

    // F: a SEPARATE process, addressed explicitly with --feature pm-beta (its
    // own provisional resolve always names beta, so it always takes beta's
    // real lock). If A's retry-on-mismatch is what actually re-acquires
    // beta's lock -- rather than A going on to write beta while still only
    // holding alpha's -- F is genuinely excluded from A for the length of
    // A's own RMW window and this read-modify-write race cannot drop either
    // increment. Without the fix, A holds no lock that excludes F at all:
    // both read beta's pre-round count, both compute +1 in memory, and
    // whichever rename lands second silently discards the other's bump --
    // the exact shape measured as 14/20 lost updates before locking existed.
    const fCall = spawnAsync(['review-round', '7', '--feature', 'pm-beta'], { cwd: PMREPO, session: pmSession });

    const [aResult, fResult] = await Promise.all([aCall, fCall]);
    check('the pointer-routed call still exits 0 after retrying onto the new target', aResult.code, 0);
    check('the directly-addressed concurrent call also exits 0', fResult.code, 0);

    // The session pointer now names beta (it was moved above), so alpha has
    // to be read explicitly by --feature -- a bare `get` here would silently
    // read beta a second time and let this check pass by asking the wrong
    // file the wrong question.
    const pmAlphaState = rs(['get', '--feature', 'pm-alpha'], { cwd: PMREPO, session: pmSession }).json;
    const pmBetaState = rs(['get', '--feature', 'pm-beta'], { cwd: PMREPO, session: pmSession }).json;
    check("alpha's reviewRounds is untouched by a round meant for beta",
      pmAlphaState?.inFlight?.['7']?.reviewRounds || 0, 0);
    // Both A's (pointer-routed, retried) round and F's (directly-addressed,
    // concurrent) round must land -- 2, not 1. This is the assertion that
    // actually depends on real mutual exclusion rather than just on A
    // eventually writing the right FILE: two increments with no exclusion
    // between them collapse to one on a large majority of runs.
    check("both A's retried round and F's concurrent round land on beta",
      pmBetaState?.inFlight?.['7']?.reviewRounds, 2);
    check('alpha is never left locked behind by the retry', fs.existsSync(pmAlphaLock), false);

    fs.rmSync(PMREPO, { recursive: true, force: true });
  }

  // =============================================================================
  console.log('\nrun-state.cjs — the lock releases on the ExitSignal (refusal) path');

  // A refused `branch` call (re-branching an unfinished run onto a different
  // name) exits non-zero from INSIDE a withRunLock callback via exitWith(),
  // not process.exit(). If that refusal ever used process.exit() directly,
  // the `finally` in withLock would never run -- process.exit() tears the
  // process down immediately -- and the lock file would be left behind,
  // wedging every later command on this run until the stale-lock timeout
  // (several seconds) expired. A `phase` call issued immediately afterward
  // must succeed promptly, proving the lock was actually released rather
  // than merely eligible for later takeover.
  {
    const EXREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-exitsignal-'));
    git(['init', '-q'], EXREPO);
    const sess = 'sess-exitsignal-0001';
    rs(['start', '--feature', 'exitsignal-feature'], { cwd: EXREPO, session: sess });
    rs(['branch', 'work/first'], { cwd: EXREPO, session: sess });
    const refused = rs(['branch', 'work/second'], { cwd: EXREPO, session: sess });
    check('a re-branch onto a different name is refused', refused.code !== 0, true);

    const start = Date.now();
    const afterRefusal = rs(['phase', 'executing'], { cwd: EXREPO, session: sess });
    const elapsedMs = Date.now() - start;
    check('phase right after a refused branch call still succeeds', afterRefusal.code, 0);
    // Comfortably under the retry bound (3s): a lock actually left behind by
    // a process.exit() skip of `finally` would force this to either wait out
    // the full stale-lock timeout or fail outright.
    check('and it did not have to wait out a leaked lock', elapsedMs < 2000, true);
    fs.rmSync(EXREPO, { recursive: true, force: true });
  }

  // =============================================================================
  console.log('\nrun-state.cjs — unlock finds a dead lock with no run file behind it');

  // listRegistryLockNames (and the legacy branch) used to enumerate locks
  // through the run files that still EXIST (`*.json`), not through the lock
  // files themselves. A run file removed out from under its lock -- `y.json`
  // deleted while `y.json.lock` is still on disk, the exact shape a crash
  // between writeJson's rename and a later cleanup leaves behind -- meant
  // `start --feature y` failed loudly naming that lock's path, while `unlock`
  // (walking `runsDir`'s `.json` files, and `y.json` is gone) reported "no
  // run-state locks present": the one tool built to inspect a stuck lock
  // could not find the very lock blocking the run it was asked about.
  {
    const NOFILEREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-no-run-file-'));
    git(['init', '-q'], NOFILEREPO);
    const nofileSession = 'sess-lock-no-run-file-0001';
    rs(['start', '--feature', 'y'], { cwd: NOFILEREPO, session: nofileSession });
    const yFile = (() => {
      for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
        const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'y.json');
        if (fs.existsSync(p)) return p;
      }
      throw new Error('y.json was never written');
    })();
    const yLockPath = `${yFile}.lock`;
    fs.writeFileSync(yLockPath, JSON.stringify({ pid: 999999, token: 'dead-y-token', at: '2020-01-01T00:00:00.000Z' }));
    fs.unlinkSync(yFile); // the run file itself is gone; its dead lock is not

    const startAgain = rs(['start', '--feature', 'y'], { cwd: NOFILEREPO, session: 'sess-lock-no-run-file-0002' });
    check('start against a dead lock with no run file behind it still fails naming that lock',
      startAgain.stderr.includes(yLockPath), true);

    const unlockReport = rs(['unlock'], { cwd: NOFILEREPO });
    check('unlock finds the SAME lock rather than reporting none present',
      unlockReport.stdout.includes(yLockPath), true);
    check('and it is not the "no locks present" fallback message',
      unlockReport.stdout.includes('no run-state locks present'), false);
    fs.rmSync(NOFILEREPO, { recursive: true, force: true });
  }

  // =============================================================================
  console.log('\nrun-state.cjs — a path containing an apostrophe is still a valid shell command');

  // Both the stale-lock error's `rm '<path>'` hint and unlock's own `rm` line
  // single-quote the path with no escaping. CLAUDE_CONFIG_DIR is attacker-free
  // but not apostrophe-free -- a machine account or CI workspace named
  // o'brien-config puts an unescaped `'` inside the quoted path, and the
  // resulting line is not valid shell at all (`bash -n` rejects it), not
  // merely wrong for a path with a literal quote in it.
  {
    const APOSBASE = fs.mkdtempSync(path.join(os.tmpdir(), "rs-apos-"));
    const APOSCONFIG = path.join(APOSBASE, "o'brien-config");
    fs.mkdirSync(APOSCONFIG, { recursive: true });
    const APOSREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-apos-repo-'));
    git(['init', '-q'], APOSREPO);
    const aposSession = 'sess-apos-0001';
    const spawnWithConfig = (args, cwd, session) => spawnSync('node', [BIN, ...args],
      { cwd, encoding: 'utf-8', env: { ...process.env, CLAUDE_CONFIG_DIR: APOSCONFIG, CLAUDE_CODE_SESSION_ID: session } });
    spawnWithConfig(['start', '--feature', 'apos-feature'], APOSREPO, aposSession);
    const aposFile = (() => {
      for (const repo of fs.readdirSync(path.join(APOSCONFIG, 'state', 'ship-runs'))) {
        const p = path.join(APOSCONFIG, 'state', 'ship-runs', repo, 'apos-feature.json');
        if (fs.existsSync(p)) return p;
      }
      throw new Error('apos-feature.json was never written');
    })();
    const aposLockPath = `${aposFile}.lock`;
    fs.writeFileSync(aposLockPath, JSON.stringify({ pid: 999999, token: 'dead-apos-token', at: '2020-01-01T00:00:00.000Z' }));

    const aposStart = spawnWithConfig(['start', '--feature', 'apos-feature'], APOSREPO, 'sess-apos-0002');
    const startRmLine = (aposStart.stderr.match(/rm '.*'/) || [])[0];
    check('the stale-lock error contains an rm line', typeof startRmLine, 'string');
    // The rm lines are for Claude Code's Bash tool, which on Windows is Git
    // Bash -- not on PATH there, but always at <git root>\bin\bash.exe, three
    // levels above `git --exec-path`.
    const bash = process.platform !== 'win32' ? 'bash' : path.resolve(
      spawnSync('git', ['--exec-path'], { encoding: 'utf-8' }).stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
    if (startRmLine) {
      const startCmd = spawnSync(bash, ['-n'], { input: startRmLine, encoding: 'utf-8' });
      check('and that rm line parses as valid shell despite the apostrophe in the path',
        startCmd.status, 0);
    }

    const aposUnlock = spawnWithConfig(['unlock'], APOSREPO, aposSession);
    const unlockRmLine = (aposUnlock.stdout.match(/rm '.*'/) || [])[0];
    check('unlock also prints an rm line for the apostrophe-bearing path', typeof unlockRmLine, 'string');
    if (unlockRmLine) {
      const unlockCmd = spawnSync(bash, ['-n'], { input: unlockRmLine, encoding: 'utf-8' });
      check('and unlock\'s own rm line is valid shell too',
        unlockCmd.status, 0);
    }
    fs.rmSync(APOSBASE, { recursive: true, force: true });
    fs.rmSync(APOSREPO, { recursive: true, force: true });
  }

  // =============================================================================
  console.log('\nrun-state.cjs — an unparseable lock is only reported clearable once it is old enough');

  // UNLOCK_UNPARSEABLE_AGE_MS (60s) exists so a lock file caught mid-write --
  // created by `wx` but not yet holding a parseable pid/token -- is never
  // mistaken for one abandoned by a crash. describeLock's `clearable` for the
  // pid === null branch has to actually apply that bound; nothing before this
  // exercised the pid === null branch at all, so a `clearable` that always
  // returned true for an unparseable lock (regardless of age) would still
  // have passed every existing check.
  {
    const UNPARSEREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-unparseable-lock-'));
    git(['init', '-q'], UNPARSEREPO);
    const unparseSession = 'sess-unparseable-0001';
    rs(['start', '--feature', 'unparseable-feature'], { cwd: UNPARSEREPO, session: unparseSession });
    const unparseFile = (() => {
      for (const repo of fs.readdirSync(path.join(CONFIG, 'state', 'ship-runs'))) {
        const p = path.join(CONFIG, 'state', 'ship-runs', repo, 'unparseable-feature.json');
        if (fs.existsSync(p)) return p;
      }
      throw new Error('unparseable-feature.json was never written');
    })();
    const unparseLockPath = `${unparseFile}.lock`;

    // Garbage, not JSON at all -- readJson returns null, so held.pid is never
    // reached; this is the shape a write torn mid-way (before the pid/token
    // object ever landed) leaves behind.
    fs.writeFileSync(unparseLockPath, 'not valid json');
    const oldEnoughMs = Date.now() - 90_000; // safely past UNLOCK_UNPARSEABLE_AGE_MS (60s)
    fs.utimesSync(unparseLockPath, oldEnoughMs / 1000, oldEnoughMs / 1000);
    const oldReport = rs(['unlock'], { cwd: UNPARSEREPO });
    check('an unparseable lock older than 60s gets an rm line',
      oldReport.stdout.includes(`rm '${unparseLockPath}'`), true);

    // Same file, but its mtime is fresh -- a write that could still be
    // mid-acquire right now must not be reported clearable.
    fs.utimesSync(unparseLockPath, Date.now() / 1000, Date.now() / 1000);
    const freshReport = rs(['unlock'], { cwd: UNPARSEREPO });
    check('the same unparseable lock, freshly touched, gets no rm line',
      freshReport.stdout.includes(`rm '${unparseLockPath}'`), false);
    check('but it is still listed', freshReport.stdout.includes(unparseLockPath), true);

    fs.rmSync(UNPARSEREPO, { recursive: true, force: true });
  }
}

// =============================================================================
raceMain().then(() => {
  try {
    fs.rmSync(FB, { recursive: true, force: true });
    fs.rmSync(IFREPO, { recursive: true, force: true });
    git(['worktree', 'remove', '--force', WT], REPO);
    [CONFIG, REPO, OTHER, LEGACY, WT].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
});
