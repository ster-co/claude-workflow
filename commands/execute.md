---
description: Execute briefs from this repo's brief file, one subagent per brief (or per parallel-group member), committing as you go.
argument-hint: [brief file and range, e.g. "docs/briefs-<feature>.md 3-9" — or just a range, or nothing for all unstarted]
# Deliberately model-invokable, unlike the entry-point commands. /ship and
# /blueprint call this one mid-run, and a command the model cannot invoke breaks the
# chain: /ship reaches its approval gate and stops. Its side effects are bounded
# by the gates, the per-brief reviewer and /execute's termination conditions --
# not by being unreachable.
---

Execute: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). The implementer, reviewer and debugger
loop below grades against its verification standards and commit rules. On a checkout with a
`CLAUDE.md` it is already in context; on a plugin install no `CLAUDE.md` reaches the
session, so this is the point where `/execute` pulls it back in.

If no brief file is named, take `briefFile` from `run-state.cjs get` — the run records it.
Failing that, find the repo's (`docs/briefs-<feature>.md`, or the most recent
`docs/*briefs*.md`). If no range is given, run every brief not yet marked done.

## The shape this must take, and why

Measured in the user's own history. Sessions running briefs this way landed **3.55 commits
per active hour against 1.85**, wrote **9 KB of prose per session against 30 KB**, and drew
**2 interrupts across 42 sessions against 11 across 45**. The parts that make it work are
specific, and skipping any of them reproduces a known failure:

- **Serial by default, parallel only inside a declared group.** Implement one brief → review
  it → then dispatch the next. Cost per landed commit: 5–14 agents **66 k tokens**, 15+
  agents **114 k**, none **210 k**. A wrong turn in brief 3 must be caught before brief 9 is
  built on it — a parallel group is the one exception, described below, and even inside it
  every member still gets an explicit list of the files it owns and may edit. That
  file-ownership line is the only reason concurrent agents on one worktree never collided.
- **Commit after each brief.** Median commit in the best week was 599 lines. 41 % of
  edit-sessions in this corpus never committed at all.
- **A reviewer per implementer**, not a reviewer at the end.

## Steps

0. **Check for an unfinished run before starting a new one.**

   (This command's hook scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path
   reads as a real absolute path here — installed as a plugin — use it everywhere
   this file says `~/.claude/hooks`; if it still reads as the literal placeholder
   — running from a `~/.claude` checkout — use `~/.claude/hooks` as written.)

   `node ~/.claude/hooks/run-state.cjs get --feature <name>`, naming this feature. A bare
   `get` reports whichever run this chat's pointer names, which says nothing about whether
   *this* feature has a run — a fresh or resumed chat may point nowhere, or at another run.
   If `get --feature <name>` shows the run exists, bind this chat to it with
   `node ~/.claude/hooks/run-state.cjs current <name>` and resume. Call `start` only when it
   prints **no run at all** for this feature (`feature` is `null`). Any run that already exists
   for this feature is resumed, never restarted, whatever `currentBrief` holds:
   - a `currentBrief` set and no `finishedAt` — a previous session was interrupted mid-brief:
     resume from there.
   - `currentBrief` empty (`null`) but the run itself exists and is not finished — this is the
     ordinary hand-off from `/ship`, which starts the run and sets `phase: executing` before
     `/execute` ever runs; there is no brief in flight yet, but the run, its branch, its base
     and its counters are already live and must not be overwritten. Resume from the brief file
     with no `start` call at all.

   Either way the brief file is the authoritative queue — where it and the state file
   disagree, the brief file is right and the state file gets corrected from it, not restarted.
   Only when no run exists yet:
   `node ~/.claude/hooks/run-state.cjs start --feature <name> --brief-file <path> --phase executing`.
   The `--phase executing` is not optional: `start` defaults to `planning`, and the edit gate
   refuses every source edit while a run sits at `planning`, so the first implementer is
   blocked before it writes a line. **Never call `start` on a feature that already has a run**
   — `start` always writes a blank state (`blank()` in `run-state.cjs`), so calling it on an
   existing run — including one with an empty `currentBrief` — discards the branch, base, plan
   and counters `/ship` already recorded.

1. **Read the brief file's house rules in full.** Confirm the baseline yourself before
   starting — run the test command once and check the counts match what the file claims. If
   they do not, stop and say so; do not start work against a wrong baseline.
2. **Restate the plan back** in three lines: which briefs, in what order, which ones the file
   marks independent, and where you expect to need judgement. Then start — do not wait for
   approval unless the brief file demands it.
3. **Per brief, in order:**
   - `node ~/.claude/hooks/run-state.cjs begin-brief <n>`.
   - Dispatch the **`implementer`** subagent (sonnet, pinned in `~/.claude/agents/`), and
     **its prompt must start with the literal first line `Implement BRIEF <n>`.** There is no
     marker to write by hand: that exact dispatch is itself what arms the verification gate —
     `gate-arm.cjs`, a `PreToolUse` hook on the Agent tool, recognises an `implementer`
     dispatch whose prompt opens that way and writes the arm file for you, keyed to this
     session and this brief. The gate refuses to let the turn end until a matching `APPROVED`
     verdict is on file, so arming it this way is what makes the review step non-skippable
     rather than merely requested — and, unlike a model-issued Write, it fires even where a
     Write to `~/.claude/state/...` would prompt or be silently denied. The rest of the
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
   - Dispatch the **`reviewer`** subagent against the working tree, as before — `git diff HEAD`
     shows this brief's work plus anything else outstanding, which is what you want it to see:
     an implementer that edited a file the brief does not own is a scope violation, and hiding
     that from the reviewer by curating a commit is how it goes unnoticed. A **mechanical**
     brief (its `Class:` line says so) gets the reviewer's `## Light review (mechanical
     briefs)` section: same role, dispatched with the Agent tool's `model: sonnet` override
     instead of opus, scoped to owned files, the `Done when` commands and one suite run — no
     sabotage step. A **behavioural** brief keeps the full opus review, and **a brief with no
     `Class:` line is behavioural** — the light review is opt-in, never the default when the
     line is missing. Either way, **the reviewer's
     prompt must start with the literal first line `Review BRIEF <n>`, and it must review
     exactly that one brief** — `verify-record.cjs` reads only that first line, so a second
     `Review BRIEF <m>` line anywhere later in the same prompt is never read: it does not
     split credit between the two, it credits only the first. Dispatch one reviewer per
     brief, even inside a parallel group (below), never one reviewer prompt covering several.
     A prompt that opens with anything else falls back to the first `brief <n>` found
     anywhere in the description, the prompt or the report — which is how a prompt that
     mentions brief 3 for context before reviewing brief 4 credits the wrong one. Tell it the snapshot sha
     so it can restore if it breaks something,
     and tell it not to run `git checkout`, `git reset`, or `git stash` bare or with
     `pop`/`apply`/`drop` — all of those move or discard working-tree content. `git stash
     create` is the one exception: it writes a commit object and touches neither the working
     tree nor the index, which is exactly why the tree-hash step above uses it instead of a
     destructive stash. Read the diff with
     `git diff HEAD` or `git show <snap>`. Do NOT record the round here — `verify-record.cjs`
     counts it from the verdict, and counting the dispatch made the debugger threshold trip
     after one rejection. Brief it to *disprove*: "Your
     job is to show this does not satisfy BRIEF n. Finding nothing is a failed review.
     Re-derive from the files, cite file:line." Print one status line when the verdict is in,
     for example `BRIEF 3 review: APPROVED`.
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
     - A **NOTED finding never enters the brief in flight.** It goes into a follow-ups
       brief at the end of the brief file instead — mechanical NOTED findings grouped
       together, up to 3 to a brief (a fourth starts a second follow-ups brief), and a
       behavioural NOTED finding always getting its own — rather than reopening the brief
       that produced it. The reviewer has already said it does not block; folding it in
       re-opens a brief that was one fix from done, and the implementer then re-derives the
       whole task. In
       the measured case two NOTED findings were folded into an in-flight brief and cost a
       full extra implementer and reviewer round. Take a fresh snapshot before the next
       dispatch, as always — the appended brief is authored work living in the tree, and
       the snapshot is what makes it recoverable.
   - **After two failed review rounds on the same brief** — a REJECTED verdict, a sabotage
     that stayed green, or a behavioural review missing `## SABOTAGE` (the sabotage step
     below) — read `inFlight["<n>"].reviewRounds >= 2` for this brief in
     `run-state.cjs get`'s output rather than counting verdicts yourself. The counter lives
     on disk; `verify-record.cjs` increments it when it parses a REJECTED verdict, and the
     sabotage step increments it with `run-state.cjs review-round <n>` for the other two
     cases. The top-level `reviewRounds` field only mirrors
     whichever brief is `currentBrief`, so when a parallel group has more than one brief in
     flight, read the per-brief entry under `inFlight`, not the top-level field — a group
     member that is not the current brief would otherwise never escalate to the debugger.
     Stop alternating implementer and reviewer and
     dispatch the **`debugger`** subagent (opus, pinned) — briefed only to find the root cause
     and report it, with no mandate to fix. `agents/debugger.md` grants it the same
     `Read, Grep, Glob, Bash` as the reviewer, so it carries the same write exposure and the
     same rule applies: everything in the tree must be recoverable from a snapshot before it
     is dispatched. The tree is not clean here — a brief is committed only once it is
     approved (below), so this brief's own rejected work is still uncommitted — which is why
     a fresh snapshot is taken before the debugger, as before every dispatch. **Inside a
     group** the tree also holds sibling briefs' uncommitted work, because members are
     committed only after the group's single suite pass (step 4 below). Either way, confirm
     rather than assume it: take the BEFORE/AFTER `git status --short` pair around the debugger
     dispatch too, and void the round on a mismatch the same way — a mismatch inside a group
     still means something wrote outside what the debugger was told to look at. Record each
     round with
     `node ~/.claude/hooks/run-state.cjs debug-round <n>` (`<n>` is this brief — the CLI
     defaults to `currentBrief` when omitted, but naming it keeps the count on the right
     entry when a parallel group has more than one brief in flight). An
     implementer/reviewer pair with no exit condition ping-pongs indefinitely. Print one
     status line per round, implementer, reviewer or debugger — for example
     `BRIEF 3 review: APPROVED` or `BRIEF 3 debugger: round 2`.
   - **Perform the reviewer's named sabotages** — behavioural briefs only, once the brief is
     APPROVED, before the suite pass below. The implementer proved each new test red→green;
     this is the step that proves the finished code is what keeps it green. The reviewer
     names them under `## SABOTAGE` and you perform them, because it cannot: it has no Edit
     tool, the edit gate refuses its Bash edits without a lookup it has no tool for, and
     reviewers in a parallel group share one worktree, so one reviewer's broken file would
     turn a sibling's concurrent suite run red. For each named sabotage, one at a time
     (inside a group, serially, after every member is APPROVED): `b=$(mktemp)`, `cp <file>
     "$b"`, apply the named edit, run only the named test, and confirm it goes red for the
     named reason; then restore with `cp "$b" <file>` — never with `git checkout -- <file>`,
     which would also discard the uncommitted work under review — and confirm
     `cmp "$b" <file>`. A byte-identical restore leaves the tree hash the reviewer recorded
     valid for the solo-brief reuse below. A test that stays green is a must-fix inside the
     brief's own files: a fresh implementer round with that finding, as above. A behavioural
     review with new tests and no `## SABOTAGE` section is incomplete: dispatch the reviewer
     again. **Either outcome is a failed review round — record it with
     `node ~/.claude/hooks/run-state.cjs review-round <n>`.** `verify-record.cjs` counts only
     a parsed REJECTED, and the gate already holds this brief's APPROVED, so without this a
     sabotage that never reaches the test's assertion loops implementer → reviewer →
     sabotage forever and the two-round debugger threshold never fires. Print
     `BRIEF <n> sabotage: <k>/<k> red`.
   - Run one suite pass, judged by exit code. **For a solo (non-group) brief only:** if the
     just-APPROVED round's reviewer report already carries that exact `test-delta.cjs
     --command` invocation, **its `on <repo>@<branch>` label matches this brief's own
     worktree directory name and current branch** — the command string alone is not enough,
     since the reviewer could have run it from a different checkout (its default cwd) whose
     label would not match — and **the recorded test-delta.cjs exit code is 0 and its
     verdict line is one of the passing forms** ("nothing newly failing", "FLAKY (...) ...
     not blocking", or "no baseline existed, so this run is the baseline"), and the
     orchestrator's own freshly computed tree hash EXACTLY MATCHES the tree hash the
     reviewer recorded in its `TESTS` line, skip the orchestrator's own rerun and cite the
     reviewer's recorded result instead — name the reviewer's `TESTS` line rather than
     running it again. Compute that tree hash the same way the reviewer did: `git add -A
     && git stash create` — the same first two commands this file's own "Snapshot the tree
     before dispatching" step above uses — then `git rev-parse <that-sha>^{tree}`, or
     `git rev-parse HEAD^{tree}` if `git stash create` prints nothing (an already-clean
     tree). **Compare the `^{tree}` hash, never the stash/HEAD commit sha itself**:
     `git stash create` bakes an author/committer timestamp into the commit object it
     writes, so invoking it twice against a byte-identical tree returns two different
     commit shas even though both point at the same tree — a check keyed on the commit sha
     would never match the reviewer's own earlier run, defeating the skip entirely, safely
     but silently (it would just always rerun). Do this immediately before deciding whether
     to skip — not earlier in the round, since anything can have touched the tree since. A
     `git status --short` comparison cannot do this job either: it compares status LETTERS
     (e.g. `M reviewer.md`), and a file the reviewer's review process touches, or that the
     sabotage step imperfectly restores, after a green test-delta run was recorded still reads `M
     reviewer.md` both before and after — identical output, tripwire silent — even though
     its content changed out from under the recorded result. Only a content-addressed tree
     hash (the same `git stash create` plus `^{tree}` mechanism above, which identifies the
     exact working-tree content, staged and unstaged, without touching the tree, and does so
     deterministically regardless of when it is computed) can tell two different contents of
     an already-modified file apart, which is the whole point of trusting the reviewer's
     recorded run instead of re-running it. The exit code and verdict
     line that matter here are
     `test-delta.cjs`'s OWN process exit code and its own final `test-delta:` verdict line —
     never the test command's echoed `` `cmd` exit N on <label> `` line `test-delta.cjs`
     prints mid-run for the raw command it ran, which is a different number and can disagree
     with `test-delta.cjs`'s own verdict in either direction: a red baseline or a
     non-repeating flake echoes exit 1 there while `test-delta.cjs` itself exits 0 (safe, but
     wrongly read as a reason not to skip if keyed on that line instead), and a piped test
     command can echo exit 0 there while `test-delta.cjs` itself blocks with exit 1 (unsafe
     to skip on). Otherwise (no matching recorded run, the label names a different repo or
     branch, the recorded exit code is non-zero, the verdict line is anything else — a
     "NEWLY FAILING" line, or nothing recorded at all — or the freshly computed tree hash
     does not exactly match the reviewer's recorded one — this is how "the tree changed after
     review" gets checked now, not assumed) run it as below. A
     parallel group always keeps its own single
     combined pass after the whole group (below), unchanged — this skip applies only to a
     solo brief's own rerun, never to the group pass:
     `node ~/.claude/hooks/test-delta.cjs --command "<house-rules Tests command>"` — the
     exact string from the brief file's house rules, unmodified. Paste what it says.
     Compare against the baseline, not against zero failures — and let the tool do the
     comparing, because "the counts look about the same" is not a comparison. A brief that
     produces a NEWLY FAILING line is not done, whatever the reviewer said. Record the
     baseline once before the run starts with `--command "<the same command>" --baseline`.
     **This run can take up to 15 minutes** (`test-delta.cjs`'s own timeout, plus one
     automatic re-run on a newly-red first pass) — longer than the Bash tool's 2-minute
     default and even its 600000 ms (10-minute) maximum. Pass `timeout: 600000` explicitly on
     every `--command` call, and when the suite is known to run long (a large repo, or a
     command whose baseline recorded a slow prior run), start it with `run_in_background:
     true` instead and read the result back rather than letting the tool kill it at its
     ceiling. **A run the Bash tool killed or that hit its timeout is not a verdict** — it
     produced no exit code from `test-delta.cjs` itself, only the tool's own kill, so there is
     nothing here to compare against a baseline. Do not read a kill as red, green or FLAKY;
     re-run it (backgrounded, if it was not already) and wait for an actual exit code before
     judging the brief.
   - **Commit** — brief number in the subject, no AI attribution. This is where the brief's
     work lands; the snapshot above was never a commit and is gc-eligible, so nothing is
     durable in the sense that matters until this step runs. In a group, commit each
     member separately, one commit per brief, its own number in its own subject — never one
     commit spanning two briefs, even though they were reviewed together.
   - For each member, mark the brief `Status: done` in the brief file, then
     `node ~/.claude/hooks/run-state.cjs finish-brief <n> --commit <sha>`. In a group this
     runs once per member, each with its own `<n>` and its own commit sha. `finish-brief`
     disarms only that member's own gate — it refuses (non-zero, message on stderr, the arm
     left in place) unless an `APPROVED` verdict for `<n>` recorded after that member's own
     arming is on file, so there is no shared marker to delete and no way for one member's
     approval to disarm a sibling that is still unreviewed. Commit the marks with the next
     thing you commit, or on their own — they do not need to be their own step, because the
     snapshot rule above protects them either way. Then the next brief or group.
4. **Parallel groups.** Before dispatching the next brief, check whether it can join the
   *current* group instead of running alone. A brief joins the group when all three hold:
   - its dependencies are already committed;
   - its **owned files are disjoint** from every other member already in the group — check
     the "Files you own" lines pairwise, not just by eye; two briefs sharing one file cannot
     share a group, however small the overlap looks;
   - it carries **no `Serial:` line** in the brief file (a `Serial:` line names a shared
     outside resource — a fixed port, a database or emulator, a migration, a deploy, or a
     browser check — and a brief that needs one runs alone).

   Dispatch every member of a group in **one message, in the foreground** — never with a
   background agent, because a backgrounded agent conflicts with the Stop hook the
   verification gate runs on. Each member's own implementer dispatch (prompt opening
   `Implement BRIEF <n>`) arms that member's own gate independently — there is nothing extra
   to do to arm a group; dispatching all of them is what arms all of them. Give each member's
   reviewer prompt its own first line, `Review BRIEF <n>`, naming that member's brief —
   `verify-record.cjs` credits a verdict to whichever brief that first line names, and the
   gate only releases the turn once every armed brief has an `APPROVED` verdict on file. Run
   **one** `test-delta.cjs --command` pass after the whole group, not one per member. If it is
   red, run each member's own related tests to localise the failure, then re-run the culprit
   brief on its own before moving on — do not re-run the whole group.

   A brief with no eligible group — its dependencies are not yet committed, no other member
   is file-disjoint from it, or it carries a `Serial:` line — runs alone, exactly as
   step 3 describes.
5. **If a brief turns out not to be worth doing, say so and stop** rather than manufacturing
   work. If a brief's premise is wrong once you are in the code, flag it and stop — do not
   silently deviate.
6. **At the end**: `node ~/.claude/hooks/run-state.cjs finish`, then land the work —
   the procedure in `/land`: state, the diff read in full, tests with literal output, commit,
   **push**, **open the PR**. Never merge to the default branch unprompted. Then tell the user
   in one line what to look at in the running product. Do not claim it works.

## Termination — the run stops for exactly these reasons

Everything else is a bug, and a run that ends for an unlisted reason should say so.

1. Every brief is `done` or `blocked` → land.
2. Two failed review rounds on one brief (REJECTED, a green sabotage, or a missing
   `## SABOTAGE`; `inFlight["<n>"].reviewRounds >= 2`) → debugger.
3. Two debug rounds without resolution → `run-state.cjs block <n> --reason <why>`, and
   **stop the run**. Briefs are sequential between groups, and a brief that does not qualify
   for the current parallel group is sequential too, so a blocked one halts rather than being
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
reports the final state. Work sequentially between briefs and groups per /execute, running a
brief's parallel group members together and everything else one at a time. Stop after 25
turns and report if any brief is still pending.
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
