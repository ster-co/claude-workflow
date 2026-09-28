---
description: Land the work — verify, commit, push, and open the PR. Never merges to main unprompted.
argument-hint: [optional: branch or scope to land]
# Deliberately model-invokable, unlike the entry-point commands. /ship and
# /blueprint call this one mid-run, and a command the model cannot invoke breaks the
# chain: /ship reaches its approval gate and stops. Its side effects are bounded
# by the gates, the per-brief reviewer and /execute's termination conditions --
# not by being unreachable.
---

Land the work in this repo. Scope: **$ARGUMENTS** (if empty, everything in the working tree
and on the current branch).

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). The verification standards and commit
hygiene this command checks against come from it. On a checkout with a
`CLAUDE.md` it is already in context; on a plugin install no `CLAUDE.md` reaches the
session, so this is the point where `/land` pulls it back in.

## Why

41 % of the user's sessions that changed code never ran a commit — 1,786 edits left dirty,
and 36 % of all output tokens paid for went to sessions that landed nothing. One branch is
still 118 commits ahead of its trunk carrying +23,885 lines. Writing code is not the
deliverable.

## Steps — in order, stopping at the first real failure

1. **Show the state.** `git status --porcelain`, the unpushed log, and `git diff --stat`
   against the trunk.
2. **Check the blast radius.** Read the diff yourself — `git diff` and `git diff --cached`,
   and `git diff <base>...HEAD` against the branch this forked from if
   this is a branch — and report anything touched that was not intended. This also satisfies
   the commit gate.
3. **Run the suite.** One run, judged by its exit code — the exact command
   from this repo's `CLAUDE.md`, passed as the `--command` argument below. Paste the
   literal output and the exit code.

   Then answer the only question that matters in a repository whose suite is already red:
   **did this change break something that used to work?**

   (This command's hook scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path
   reads as a real absolute path here — installed as a plugin — use it everywhere
   this file says `~/.claude/hooks`; if it still reads as the literal placeholder
   — running from a `~/.claude` checkout — use `~/.claude/hooks` as written.)

   ```
   node ~/.claude/hooks/test-delta.cjs --command "<the exact suite command from CLAUDE.md>"
   ```

   **This can take up to 15 minutes** (`test-delta.cjs`'s own timeout, plus one automatic
   re-run on a newly-red first pass) — longer than the Bash tool's 2-minute default and even
   its 600000 ms (10-minute) maximum. Pass `timeout: 600000` explicitly, and when the suite is
   known to run long, start it with `run_in_background: true` instead and read the result back
   rather than letting the tool kill it at its ceiling. **A run the Bash tool killed or that
   hit its timeout is not a verdict** — there is no exit code from `test-delta.cjs` to compare
   against the baseline, only the tool's own kill. Do not read a kill as red, green or FLAKY;
   re-run it (backgrounded, if it was not already) and wait for an actual exit code.

   It runs that command in the repo root — once, plus one automatic re-run only when the
   first run is newly red — and names the tests failing now that were
   not failing in the recorded baseline for this repo, branch and command. **A green first
   run records the baseline** for you. **A red first run with no baseline records nothing
   and exits non-zero** — a repo that was already red before this work reaches `/land` and
   stops here on every retry, because there is no prior run to compare it against. If that
   is this repo's situation, record the baseline explicitly on the work branch, right after
   forking it and before changing anything (the baseline is keyed by repo, branch and
   command, so one recorded on the base does not apply here) —
   `node ~/.claude/hooks/test-delta.cjs --command "<cmd>" --baseline` — and say so in
   the PR; never use it to paper over a failure this branch introduced. `--show --command
   "<cmd>"` inspects that command's recorded baseline; a bare `--show` shows the runner
   baseline, not the command's.

   Paste its output. **NEWLY FAILING is a stop** — a failure the tool's own re-run still
   reproduces. `FLAKY` is a failure seen only on the first of its two runs and does not
   block. Counting totals instead is what makes "9 failed" in a repo whose suite is already
   red unreadable: the number is the same whether you fixed one and broke one or touched
   nothing.
4. **Sort the working tree.** For each uncommitted file, say whether it belongs in this
   change, in a different one, or is debris. Do not blanket-add — other agents may be live in
   this tree; stage explicit paths.
5. **Commit** in coherent units, imperative English subjects. **No AI attribution anywhere:
   no co-author trailer, no generated-with line, no mention of Claude or Anthropic.**
6. **Ask, once, whether to run a whole-tree pass first.** Whatever review these commits have
   had was per-commit — `/execute`'s reviewer grades one brief's diff, and a change arriving
   here from `/blueprint`'s track 1 or `/diagnose` may have had none at all. Either way nothing has
   looked at the merged tree, which is the gap `/attack` exists to close: its own Why records
   a defect a per-commit review passed seven days before five whole-tree reviewers found it.
   Ask: *"Want to run `/attack` on this branch before it's pushed?"* A "no" costs nothing:
   move straight to Push. Ask it once — not a loop.

   **On a yes, say `/attack <branch>` and stop — do not dispatch it yourself.** `/attack` sets
   `disable-model-invocation: true` because it fans out one opus subagent per axis, and
   `hooks/test/verify-all.cjs` asserts that on the axis *"is it ever invoked by another
   command"*. Answering "yes" here is the operator asking for it, not this command acquiring
   the right to spend it. Hand-rolling a fan-out instead would skip `/attack`'s own gate, where
   the axis set is proposed and can be edited before anything is spent.
7. **Push.** An unpushed commit is not landed — *"what is the whole point of committing all
   the time if we don't push?"*
8. **Open a PR. Do not merge to the default branch unless the user says so in this session.**
   `main` is unprotected in these repos, so nothing but this rule stops an unreviewed merge —
   and a merge is the one step here that is hard to undo. The observed convention varies by
   repo: one repo takes PRs into `main` (#133–#145, all authored by the user) and separate PRs
   into a `TST` branch from colleagues; another merges locally without PRs; a third has had
   one PR ever. When the repo's convention is a local merge, still say what you are
   about to merge and into what, and wait for a yes.
9. **If a release is involved**, publish it before telling any consumer to pin the new
   version. Three repos were once told to pin a version that did not exist yet.

## Report

One short block: commits made with hashes, what was pushed where, the PR or merge, the test
result, and **anything still left in the working tree and why**. If something could not be
landed, say exactly what and what it needs. Do not leave it silent.
