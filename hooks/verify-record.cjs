#!/usr/bin/env node
// Records a reviewer subagent's verdict so verify-gate.cjs can tell "a reviewer
// ran and approved" from "a reviewer ran".
//
// Wired to TWO events, because a subagent's report reaches the orchestrator in
// two shapes and only one passes through a tool result:
//
//   PostToolUse Agent   the report is the tool result. The original case.
//   SubagentStop        the agent handed its report back through
//                       SubagentHandback; the tool result is a receipt and the
//                       report is in the subagent's transcript, which this event
//                       names in `agent_transcript_path`.
//
// Measured on Claude Code 2.1.278 by dumping the live payload. The receipt is
// prose written by the harness, so parsing it produced a verdict about the
// delivery note rather than the review.
//
// The contract is borrowed from cc-sdd's kiro-impl, which is the best-specified
// version of this loop found in the wild: the reviewer must end with a line
// "## Review Verdict" followed by APPROVED or REJECTED. Parsing a sentinel beats
// reading prose, because prose drifts optimistic and a gate that reads prose
// inherits the drift.
//
// A review that produces no parseable verdict is recorded as UNPARSED, never as
// approval. Silence is not consent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { reportFromTranscript, promptFromTranscript } = require('./gates/gate-lib.cjs');
const { claim, eventKey } = require('./once.cjs');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

// H3: the review file's read-modify-write must be serialised, the same
// pattern run-state.cjs's acquireLock/releaseLock/withLock use -- `wx`
// (O_CREAT|O_EXCL) makes acquisition a single atomic syscall rather than a
// check-then-create race between two reviewers recording at once. Ten
// concurrent recordings with no lock lost at least one verdict in every
// measured run; a lost APPROVED wedges the gate, a lost REJECTED loses the
// escalation count. Copied here rather than imported, because run-state.cjs
// does not export these and this file must not reach into its internals.
const LOCK_RETRY_BOUND_MS = 3_000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_MAX_MS = 80;
const lockPathFor = (file) => `${file}.lock`;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function pidIsAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

// Never takes a lock over by path alone -- only `releaseLock` below, and only
// when the token on disk still matches the one this process wrote, removes
// it. Refuses loudly (throws) once the retry bound expires rather than ever
// proceeding unlocked; the caller decides what "loudly" means for a hook that
// must still exit 0 either way (see the try/catch around withLock's caller).
function acquireLock(file) {
  const lockPath = lockPathFor(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + LOCK_RETRY_BOUND_MS;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        const holder = readJson(lockPath);
        const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
        if (holderPid !== null && pidIsAlive(holderPid)) {
          throw new Error(`brief-review lock is held by pid ${holderPid} at ${lockPath}; retry`);
        }
        // Named "stale" rather than taken over automatically: renaming a lock
        // by path alone can yank a lock a different process just created at
        // that same path (the exact hole run-state.cjs's own history closed).
        // The fix is a human running the `rm` this error names, never code.
        throw new Error(
          `stale brief-review lock left by crashed pid ${holderPid ?? '?'} at ${lockPath} `
          + `-- clear it with: rm ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS)));
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch (err) {
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      throw err;
    }
    return { lockPath, token };
  }
}

function releaseLock({ lockPath, token }) {
  const current = readJson(lockPath);
  if (current && current.token === token) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

function withLock(file, fn) {
  const held = acquireLock(file);
  try {
    // Test-only hook (VERIFY_RECORD_TEST_RMW_DELAY_MS): widens the window
    // this process holds the lock, the same pattern run-state.cjs's `save()`
    // uses, so a test can deterministically swap the on-disk token out from
    // under a running recorder instead of racing scheduling luck. Production
    // never sets it.
    const rmwDelay = Number(process.env.VERIFY_RECORD_TEST_RMW_DELAY_MS);
    if (Number.isFinite(rmwDelay) && rmwDelay > 0) sleepSync(rmwDelay);
    return fn();
  } finally {
    releaseLock(held);
  }
}

// "review brief 3", "reviewing brief 12", "brief 7 review"
const briefFrom = (text) => {
  const m = /brief\s*#?\s*(\d+)/i.exec(text || '');
  return m ? m[1] : null;
};

// /execute's dispatch contract (task 8) fixes the reviewer prompt's FIRST LINE
// as "Review BRIEF <n>". Reading only that line is what stops a prompt from
// crediting the wrong brief when it goes on to mention another one for
// context -- "Review BRIEF 4" followed by "...matches brief 3's fix..." must
// still record 4. A prompt without that first line (written before the
// convention existed, or with no prompt at all) falls through to `briefFrom`,
// today's scan-anywhere rule, unchanged.
const firstLineBrief = (text) => {
  const first = (text || '').split('\n', 1)[0];
  const m = /^\s*Review\s+BRIEF\s+(\d+)\b/i.exec(first);
  return m ? m[1] : null;
};

const isReview = (desc) => /\breview/i.test(desc || '');

// The same rule SubagentStop applies to `agent_type`, and gate-arm.cjs applies
// to "implementer": a plugin install namespaces the role, e.g.
// "workflow-discipline:reviewer" -- accept the bare name or a "<plugin>:"
// prefix, but a role that merely ends in similar letters with no `:`
// separator ("evil-reviewer") is not a match. `reviewer-lite` is the same
// reviewer at lower effort (agents/reviewer-lite.md, picked by /subagent-mode
// fast); it is matched by exact name only, never by a looser pattern.
const REVIEWER_ROLES = ['reviewer', 'reviewer-lite'];
const isReviewerRole = (role) => REVIEWER_ROLES.some((r) => role === r || role.endsWith(`:${r}`));

const verdictFrom = (text) => {
  if (!text) return 'UNPARSED';
  // The sentinel, allowing for the verdict on the same line or the next.
  const m = /##\s*Review\s+Verdict\s*:?\s*\n?\s*(APPROVED|REJECTED)\b/i.exec(text);
  if (m) return m[1].toUpperCase();
  // A bare sentinel word on its own line is accepted as a fallback.
  const bare = /^\s*(APPROVED|REJECTED)\s*$/im.exec(text);
  return bare ? bare[1].toUpperCase() : 'UNPARSED';
};

const asText = (r) => {
  if (typeof r === 'string') return r;
  if (!r) return '';
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  }
  return JSON.stringify(r);
};

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const session = input?.session_id;
  if (!session) process.exit(0);

  let desc, prompt, body;
  if ((input?.hook_event_name || '') === 'SubagentStop') {
    // The ROLE decides, not the prompt. An implementer handed a review-shaped
    // brief must not clear the review gate -- the same hole a scout dispatched
    // with "plan audit" in its description once opened in the plan gate.
    // /execute dispatches `reviewer`, and verify-all.cjs asserts that it still
    // does. Only when the harness reports no role at all does the prompt decide,
    // so a payload change degrades to the old behaviour rather than to silence.
    //
    // Under a plugin install the harness reports the role namespaced, e.g.
    // "workflow-discipline:reviewer" -- accept the bare name or a
    // "<plugin>:reviewer" suffix, the same rule gate-arm.cjs applies to
    // "implementer" and plan-audit-record.cjs applies to "plan-auditor". A role
    // that merely ends in similar letters without the `:` separator
    // ("evil-reviewer") must not match.
    const transcript = input?.agent_transcript_path || '';
    desc = input?.agent_type || '';
    prompt = promptFromTranscript(transcript);
    if (desc ? !isReviewerRole(desc) : !isReview(prompt.slice(0, 200))) process.exit(0);
    body = reportFromTranscript(transcript);
  } else {
    // A handed-back report is not in the tool result, and SubagentStop has
    // already recorded it by the time this fires. Parsing the receipt here
    // replaced a real APPROVED with an UNPARSED read out of the delivery note.
    if (input?.tool_response?.handback) process.exit(0);
    desc = input?.tool_input?.description ?? '';
    prompt = input?.tool_input?.prompt ?? '';
    // BRIEF 18 / H1: an implementer whose prompt happens to say "a reviewer
    // will review this" and whose result happens to end in the sentinel must
    // not self-approve -- the same self-approval hole SubagentStop already
    // closes by role above. When the dispatch names a subagent_type, THAT
    // decides, exactly like SubagentStop's agent_type; only when the harness
    // reports no role at all (a payload that predates the field) does the
    // description/prompt fallback apply, unchanged.
    const subagentType = input?.tool_input?.subagent_type;
    if (subagentType) {
      if (!isReviewerRole(String(subagentType))) process.exit(0);
    } else if (!isReview(desc) && !isReview(prompt.slice(0, 200))) {
      process.exit(0);
    }
    body = asText(input?.tool_response);
  }

  // BRIEF 18 / M2: the bump below must only ever number an in-flight entry
  // from the reviewer prompt's OWN first-line convention, never from a number
  // merely scanned out of prose -- kept separately from `brief` (which still
  // uses the wider scan for the verdict record itself, unchanged).
  const firstLine = firstLineBrief(prompt);
  const brief = firstLine ?? briefFrom(desc) ?? briefFrom(prompt) ?? briefFrom(body);

  const verdict = verdictFrom(body);

  const dir = path.join(STATE_DIR, 'brief-review');
  const reviewFile = path.join(dir, `${session}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // H3: the read AND the write must be atomic together, held across both --
    // a lock released between the read and the write closes nothing, since a
    // second recorder could still land its own read-modify-write in the gap.
    withLock(reviewFile, () => {
      const existing = readJson(reviewFile);
      // Verdicts are kept per brief, because a parallel review group arms
      // several briefs on one session and each one's verdict must stay its
      // own -- an armed brief 5 must never read as approved because brief 4's
      // review landed after it. `brief`/`verdict`/`at` at the top level mirror
      // whichever verdict was recorded most recently, for readers that predate
      // per-brief tracking (checkpoint-write.cjs) and only ever read those.
      const verdicts = existing?.verdicts && typeof existing.verdicts === 'object'
        ? { ...existing.verdicts } : {};
      const at = new Date().toISOString();
      if (brief !== null) verdicts[brief] = { verdict, at };
      fs.writeFileSync(reviewFile, JSON.stringify({ verdicts, brief, verdict, at }));
    });
  } catch (err) {
    // The gate simply asks again on the next turn -- but silently is not an
    // option: a stale lock left by a crashed pid used to make a reviewer's
    // APPROVED exit 0 with 0 bytes of stderr and nothing recorded, and
    // nothing on disk to explain why. Naming the dropped verdict AND the
    // exact error (which already distinguishes "held" from "stale ... rm
    // <path>", see acquireLock above) is what turns that into something a
    // human can act on instead of a silently repeating no-op.
    process.stderr.write(
      `verify-record: ${verdict} for session ${session}${brief !== null ? ` (brief ${brief})` : ''} `
      + `was NOT recorded: ${err.message}\n`);
  }

  // The escalation counter is bumped HERE, from the verdict, rather than by
  // /execute when it dispatches the reviewer. execute.md escalates to the debugger
  // at `reviewRounds >= 2` and calls that "after two REJECTED verdicts"; counting
  // dispatches made the threshold trip after one rejection. Measured on a live run:
  // the counter reached 2 thirty-two seconds before the second reviewer started,
  // and that reviewer returned APPROVED.
  //
  // Routed through run-state.cjs's OWN CLI, not a direct write of its state
  // file: `review-round <n>` writes through writeJson's temp-file-and-rename,
  // which is what keeps a parallel review group's simultaneous writers from
  // splicing two writes into one corrupt file -- the exact risk a direct
  // writeFileSync here would reintroduce for the very counter this exists to
  // protect. Passing the brief number also means the bump lands on THAT
  // brief's inFlight entry, not whichever brief the run considered "current".
  if (verdict === 'REJECTED') {
    try {
      // resolve() only reads; calling it directly (not through the CLI) costs
      // nothing and lets the bump be skipped BEFORE it ever reaches
      // run-state.cjs. That matters because `review-round`'s own save() falls
      // back to runPath('unnamed') when no run resolves for this session/cwd
      // -- a REJECTED verdict on a session with no run in flight would
      // otherwise conjure a phantom `unnamed.json` that then shows up as a
      // run in /ship's table. Skip here; never create one.
      const { resolve: resolveRun } = require('./run-state.cjs');
      const cwd = input?.cwd || process.cwd();
      // repoKey() hashes whatever cwd it is given, and a spawned child sees
      // its cwd already resolved past any symlink (getcwd(2), same as
      // `spawnSync(..., { cwd })` gives the review-round CLI below). Calling
      // resolve() in-process on the RAW path instead hashed a different
      // string on a host where the temp dir is a symlink (macOS /var ->
      // /private/var) and always read back `kind: 'none'`.
      let realCwd = cwd;
      try { realCwd = fs.realpathSync(cwd); } catch { /* fall back to the raw cwd */ }
      const runRes = resolveRun(realCwd, null, session);
      // Unlike the verdict write above, which stores the same value however
      // often it runs, the bump adds one. The checkout and an installed plugin
      // each register this script, so one SubagentStop can arrive twice and
      // would otherwise read as two rejections and trip the debugger escalation
      // after one. Only one delivery of an event may bump.
      const eventId = eventKey(input);
      if (runRes.file && (eventId === null || claim(STATE_DIR, 'review-round', eventId))) {
        const args = [path.join(__dirname, 'run-state.cjs'), 'review-round'];
        // No first-line brief identified: bump the bare counter (which lands
        // on the run's currentBrief), matching the pre-per-brief behaviour,
        // rather than dropping the bump entirely OR numbering it from a
        // "brief N" that only ever appeared in prose -- that would create a
        // phantom in-flight entry for whatever number the scan found while
        // leaving the real brief's count untouched.
        if (firstLine !== null) args.push(firstLine);
        const r = spawnSync(process.execPath, args, {
          cwd,
          env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
          timeout: 5000,
        });
        // Best-effort: a failed bump must not fall back to a direct write of
        // the state file (that reintroduces the splice risk the CLI's
        // temp-file-and-rename exists to avoid). A one-line warning is all
        // that is owed here -- the gate still holds the turn either way.
        if (r.error || r.status !== 0) {
          process.stderr.write(
            `verify-record: review-round bump failed (status ${r.status ?? 'n/a'})${r.error ? `: ${r.error.message}` : ''}\n`);
        }
      }
    } catch { /* counting is best-effort; the gate still holds the turn */ }
  }
  process.exit(0);
});
