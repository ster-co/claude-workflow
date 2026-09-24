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
// the developer's real state directory and a "pass" would be meaningless.
rs(['start', '--feature', 'alpha'], { session: CHAT_A });
const realState = path.join(os.homedir(), '.claude', 'state', 'ship-runs');
const realBefore = fs.existsSync(realState) ? fs.readdirSync(realState).length : 0;
rs(['start', '--feature', 'beta'], { session: CHAT_B });
const realAfter = fs.existsSync(realState) ? fs.readdirSync(realState).length : 0;
check('starting a run does not touch the real ~/.claude/state/ship-runs',
  realAfter, realBefore);
check('the scratch config dir did receive the runs',
  fs.existsSync(path.join(CONFIG, 'state', 'ship-runs')), true);

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
for (const f of ['ship.md', 'execute.md', 'brief.md', 'land.md', 'plan.md']) {
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
try {
  fs.rmSync(FB, { recursive: true, force: true });
  git(['worktree', 'remove', '--force', WT], REPO);
  [CONFIG, REPO, OTHER, LEGACY, WT].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
} catch {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
