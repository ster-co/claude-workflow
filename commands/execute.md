---
description: Execute briefs from this repo's brief file, one subagent per brief, serially, committing as you go.
argument-hint: [brief file and range, e.g. "docs/briefs-<feature>.md 3-9" — or just a range, or nothing for all unstarted]
# Deliberately model-invokable, unlike the entry-point commands. /ship and
# /plan call this one mid-run, and a command the model cannot invoke breaks the
# chain: /ship reaches its approval gate and stops. Its side effects are bounded
# by the gates, the per-brief reviewer and /execute's termination conditions --
# not by being unreachable.
---

Execute: **$ARGUMENTS**

If no brief file is named, take `briefFile` from `run-state.cjs get` — the run records it.
Failing that, find the repo's (`docs/briefs-<feature>.md`, or the most recent
`docs/*briefs*.md`). If no range is given, run every brief not yet marked done.

## The shape this must take, and why

Measured in the user's own history. Sessions running briefs this way landed **3.55 commits
per active hour against 1.85**, wrote **9 KB of prose per session against 30 KB**, and drew
**2 interrupts across 42 sessions against 11 across 45**. The parts that make it work are
specific, and skipping any of them reproduces a known failure:

- **Serial, not parallel.** Implement one brief → review it → then dispatch the next. Cost
  per landed commit: 5–14 agents **66 k tokens**, 15+ agents **114 k**, none **210 k**. A
  wrong turn in brief 3 must be caught before brief 9 is built on it.
- **Parallel only where the brief file says the tasks are independent** — and then each agent
  gets an explicit list of the files it owns and may edit. That file-ownership line is the
  only reason four concurrent agents on one worktree never collided.
- **Commit after each brief.** Median commit in the best week was 599 lines. 41 % of
  edit-sessions in this corpus never committed at all.
- **A reviewer per implementer**, not a reviewer at the end.

## Steps

0. **Check for an unfinished run before starting a new one.**

   (Here and everywhere below, `~/.claude/hooks/run-state.cjs` and
   `~/.claude/hooks/test-delta.cjs` mean `${CLAUDE_PLUGIN_ROOT}/hooks/<file>.cjs` when
   `CLAUDE_PLUGIN_ROOT` is set in the environment — installed as a plugin — and
   `~/.claude/hooks/<file>.cjs` otherwise, running from this repo. Same scripts either
   way; only the directory changes.)

   `node ~/.claude/hooks/run-state.cjs get`. If it reports a `currentBrief` and no
   `finishedAt`, a previous session was interrupted mid-brief: resume from there rather than
   restarting the feature. The brief file is the authoritative queue — where it and the state
   file disagree, the brief file is right and the state file gets corrected from it.
   Otherwise: `node ~/.claude/hooks/run-state.cjs start --feature <name> --brief-file <path>`.

1. **Read the brief file's house rules in full.** Confirm the baseline yourself before
   starting — run the test command once and check the counts match what the file claims. If
   they do not, stop and say so; do not start work against a wrong baseline.
2. **Restate the plan back** in three lines: which briefs, in what order, which ones the file
   marks independent, and where you expect to need judgement. Then start — do not wait for
   approval unless the brief file demands it.
3. **Per brief, in order:**
   - `node ~/.claude/hooks/run-state.cjs begin-brief <n>`, and arm the verification gate by
     writing `{"brief":"<n>","file":"<brief file>"}` to
     `~/.claude/state/brief-exec/<session id>.json`, where `<session id>` is the value of
     the `CLAUDE_CODE_SESSION_ID` environment variable (`$env:CLAUDE_CODE_SESSION_ID` in
     PowerShell, `$CLAUDE_CODE_SESSION_ID` in bash/zsh). The gate refuses to let the turn
     end until a matching `APPROVED` verdict is on file, so arming it is what makes the
     review step non-skippable rather than merely requested.
   - Dispatch the **`implementer`** subagent (sonnet, pinned in `~/.claude/agents/`). Its
     prompt carries: the brief verbatim, the house rules verbatim, the files it owns and may
     edit, the evidence standard, and the stop line. Tell it not to commit.
   - **If the implementer leaves the suite red, that is a failed round — but send it back to a
     reviewer anyway, or record the failure as a rejection yourself.** Do not simply re-dispatch
     the implementer: `verify-record.cjs` increments `reviewRounds` only when it parses a
     `REJECTED` verdict, so a loop that never reaches a reviewer never advances the counter and
     never reaches the two-rejections debugger escalation. Meanwhile `verify-gate.cjs` stands
     down after 5 blocked turns (`MAX_BLOCKS`), so the turn ends anyway — **with the review
     requirement silently bypassed rather than satisfied.** That is worse than a stall, because
     it looks like completion.
   - **Snapshot the tree before dispatching any Bash-capable agent.** Two commands, no
     judgement:

     ```
     git add -A
     git stash create "pre-review brief <n>"
     ```

     `git stash create` writes a commit object and leaves the working tree exactly as it was —
     nothing is staged for you, nothing moves. Note the sha it prints; that is the snapshot,
     call it `<snap>` below. **On an already-clean tree it prints nothing at all** — in that
     case use `git rev-parse HEAD` instead and note the sha it prints. That fallback matters:
     with nothing uncommitted, `HEAD` already is the recovery point, but treating "printed
     nothing" as "no snapshot" would turn the restore command into `git checkout -- .` — the
     exact command that caused the incident this rule exists to prevent. If a reviewer,
     debugger or fan-out agent damages the tree, `git checkout <snap> -- .` puts it back.

     **`git add -A` first is not optional**: a bare `git stash create` omits untracked files,
     and a brief that creates a new file — `commands/attack.md`, a new test — would be snapshot
     without the thing it made.

     This is the fix for `audit/2026-09-22-verification-defects.md` section C, where a reviewer
     ran `git checkout -- .` and reverted the brief it was reviewing. **The property being
     enforced is that everything in the tree is recoverable from a git object, not that the
     tree is clean.** That distinction is the whole of it: an earlier revision of this file
     demanded a commit instead, which forced the question "which paths belong in it?", which
     needs a clean tree — and this loop never has one. Four actors write here during a healthy
     run: the implementer, the orchestrator fixing tooling the run itself surfaced, the
     orchestrator's own bookkeeping in a brief file no brief owns, and the harness, which
     rewrote `settings.json` mid-run on 2026-09-22. A snapshot captures all of it and needs to
     classify none of it.
   - Dispatch the **`reviewer`** subagent (opus, pinned) against the working tree, as before —
     `git diff HEAD` shows this brief's work plus anything else outstanding, which is what you
     want it to see: an implementer that edited a file the brief does not own is a scope
     violation, and hiding that from the reviewer by curating a commit is how it goes
     unnoticed. Tell it the snapshot sha so it can restore if it breaks something, and tell it
     not to run `git checkout`, `git reset` or `git stash`. Read the diff with `git diff HEAD` or
     `git show <snap>`. Do NOT record the round here — `verify-record.cjs` counts it from the verdict, and counting
     the dispatch made the debugger threshold trip after one rejection. Brief it to
     *disprove*: "Your
     job is to show this does not satisfy BRIEF n. Finding nothing is a failed review.
     Re-derive from the files, cite file:line."
   - **The reviewer does not read the implementer's report, reply, or transcript.** It gets the
     brief, the diff it reads itself, and test output it produced itself. Summaries drift
     optimistic without anyone intending it, and a reviewer handed one inherits the drift —
     which is how `8e0ee4df` ended at *"state persistence is not working, all agents claimed to
     have finished."* Grade the code, never the description of the code.
   - **End the reviewer's prompt with the verdict contract**: it must close with a line
     `## Review Verdict` followed by `APPROVED` or `REJECTED`. A review returning neither is not
     an approval. `hooks/verify-record.cjs` parses exactly that, and `hooks/verify-gate.cjs`
     refuses to end the turn until a matching `APPROVED` is on file.
   - **Capture `git status --short` immediately before dispatching (BEFORE) and again the
     moment it returns (AFTER). The check is that the two are identical — never that either is
     empty.** A non-empty BEFORE is normal and not a fault: a `Status: done` mark from the
     previous brief, a tooling fix the run itself surfaced, a `settings.json` the harness
     rewrote. None of that belongs to this brief and none of it needs classifying — the
     snapshot already covers it.

     What the comparison catches: `agents/reviewer.md` grants `Read, Grep, Glob, Bash` and
     withholds `Edit`/`Write`, but that states intent and tooling, not a guarantee. `Bash` is a
     write channel — `sed -i`, `>`, `rm`, `git checkout`, `git reset` all reach the disk, and no
     denylist on a shell holds. **This is a tripwire, not a wall**: if AFTER differs from
     BEFORE, the agent wrote something it was not asked to, the verdict is void, and you restore
     with `git checkout <snap> -- .` before re-running. It detects after the fact. The snapshot
     is what makes the damage recoverable.
   - Act on the review. If the implementer and reviewer disagree, read the code yourself.
   - **Who fixes a must-fix, and what happens to a NOTED.** Both were decided ad hoc, and
     the measured cost was a brief that ran 2.2x longer than its neighbours
     (`docs/audits/2026-09-22-brief-3-slowdown.md`).
     - A **must-fix inside the files this brief owns** goes back to a fresh implementer
       with the reviewer's finding quoted verbatim. Do not patch it yourself: you have
       read the reviewer's report, so you would be fixing what it said rather than what
       the code does, and the next reviewer has no independent diff to judge. **Take a fresh
       snapshot before each new round** — the rule above applies to every dispatch, not only
       the first.
     - A **must-fix outside those files** is not this brief's work. Block the brief with
       `run-state.cjs block <n> --reason <why>` and say what it is waiting on.
     - A **NOTED finding never enters the brief in flight.** Append it as the next brief
       in the brief file and carry on. The reviewer has already said it does not block;
       folding it in re-opens a brief that was one fix from done, and the implementer
       then re-derives the whole task. In the measured case two NOTED findings were
       folded into an in-flight brief and cost a full extra implementer and reviewer
       round. Take a fresh snapshot before the next dispatch, as always — the appended brief
       is authored work living in the tree, and the snapshot is what makes it recoverable.
   - **After two REJECTED verdicts on the same brief** (`reviewRounds >= 2` in the state file,
     which is why the counter lives on disk — and is incremented by `verify-record.cjs` when
     it parses a REJECTED verdict, so it now counts what this line says it counts), stop
     alternating implementer and reviewer and
     dispatch the **`debugger`** subagent (opus, pinned) — briefed only to find the root cause
     and report it, with no mandate to fix. `agents/debugger.md` grants it the same
     `Read, Grep, Glob, Bash` as the reviewer, so it carries the same write exposure and the
     same rule applies: nothing is dispatched to it uncommitted. In practice the tree is
     already clean at this point — each must-fix before it was committed before its own
     reviewer round (above), and no implementer has run since — but confirm it, don't assume
     it: take the BEFORE/AFTER `git status --short` pair around the debugger dispatch too, and
     void the round on a mismatch the same way. Record each round with
     `node ~/.claude/hooks/run-state.cjs debug-round`. An implementer/reviewer pair with no
     exit condition ping-pongs indefinitely.
   - Run the suite, then `node ~/.claude/hooks/test-delta.cjs` and paste what it says.
     Compare against the baseline, not against zero failures — and let the tool do the
     comparing, because "the counts look about the same" is not a comparison. A brief that
     produces a NEWLY FAILING line is not done, whatever the reviewer said. Record the
     baseline once before the run starts with `--baseline`.
   - **Commit** — brief number in the subject, no AI attribution. This is where the brief's
     work lands; the snapshot above was never a commit and is gc-eligible, so nothing is
     durable in the sense that matters until this step runs.
   - Mark the brief `Status: done` in the brief file, then
     `node ~/.claude/hooks/run-state.cjs finish-brief <n> --commit <sha>`, and delete the
     `brief-exec` marker so the gate disarms. Commit the mark with the next thing you commit,
     or on its own — it does not need to be its own step, because the snapshot rule above
     protects it either way. Then the next brief.
4. **If a brief turns out not to be worth doing, say so and stop** rather than manufacturing
   work. If a brief's premise is wrong once you are in the code, flag it and stop — do not
   silently deviate.
5. **At the end**: `node ~/.claude/hooks/run-state.cjs finish`, then land the work —
   the procedure in `/land`: state, the diff read in full, tests with literal output, commit,
   **push**, **open the PR**. Never merge to the default branch unprompted. Then tell the user
   in one line what to look at in the running product. Do not claim it works.

## Termination — the run stops for exactly these reasons

Everything else is a bug, and a run that ends for an unlisted reason should say so.

1. Every brief is `done` or `blocked` → land.
2. Two `REJECTED` verdicts on one brief → debugger.
3. Two debug rounds without resolution → `run-state.cjs block <n> --reason <why>`, and
   **stop the run**. These briefs are sequential, so a blocked one halts rather than being
   leapfrogged — brief 7 built on a broken brief 6 is worse than an unfinished run.
4. All remaining briefs blocked → stop and report.
5. A brief's premise is wrong once you are in the code → stop, do not deviate.
6. The turn or spend ceiling is reached → stop and report what is left.

## Running it unattended

`/execute` does one pass. To have it carry a whole feature without per-turn prompting, set a
goal first and run in auto mode — `/goal` is a session-scoped Stop hook whose evaluator
(a small fast model) checks the condition after every turn and starts another turn until it
is met or judged impossible:

```
/goal Every brief in the run's brief file is marked done or blocked, each done brief has
its own commit, the suite matches the baseline in the house rules, and `run-state.cjs get`
reports the final state. Work one brief at a time per /execute. Stop after 25 turns and
report if any brief is still pending.
```

The evaluator sees only the transcript, so keep printing test counts, verdicts and commit
lines — a condition it cannot observe is a condition it cannot confirm. `/goal` and the
verification gate are both Stop hooks and are designed to coexist; the gate stands down after
5 consecutive blocks so neither can wedge the session.

## The failure mode to guard against

Subagent chains verify conformance to the brief, never the product. In the reference sessions
every agent reported success while the feature was visibly broken — *"state persistence is not
working, all agents claimed to have finished."* Your final report must separate **"the briefs
were executed as written"** from **"the thing works"**, and you can only assert the second if
you drove it yourself.

## Report

A table: brief → commit(s) → test result → anything you deviated from and why. A REJECTED
round legitimately produces more than one commit for the brief (the reviewed commit plus each
follow-up fix, and the `Mark brief <n> done` commit) — list them all, not just the last. Then
the one product-level check the user should do.
