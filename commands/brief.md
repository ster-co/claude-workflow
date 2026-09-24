---
description: Turn a task or an approved plan into numbered briefs in this repo's brief file, then print the opener that executes them.
argument-hint: [what to do — a task description, or a path to an approved plan doc]
# Deliberately model-invokable, unlike the entry-point commands. /ship and
# /plan call this one mid-run, and a command the model cannot invoke breaks the
# chain: /ship reaches its approval gate and stops. Its side effects are bounded
# by the gates, the per-brief reviewer and /execute's termination conditions --
# not by being unreachable.
---

Write brief(s) for: **$ARGUMENTS**

The plan doc normally comes from `/plan`. If you were handed a task description for work that
needs a design call first, say so and route to `/plan` rather than inventing the design inside a
brief.

If the argument is **a path to a plan or design document**, read it in full and write the whole
ladder — one brief per independently executable task, in dependency order, marking which ones
are independent of each other. If it is **a task description**, write one brief.

## Why this format

Measured across the user's own history: sessions opened by pointing at a numbered brief in
a committed file landed **3.55 commits per active hour against 1.85**, produced **9 KB of
assistant prose against 30 KB**, and drew **2 interrupts across 42 sessions against 11
across 45**. In Document-parser the same protocol moved user messages per commit from
**12.3 to 1.7**. The brief carries the design call, the evidence standard and the stop
condition, so the session needs no steering.

## Steps

1. **Find or create the brief file.** Look for an existing `docs/*briefs*.md` in this repo.
   If none exists, create `docs/briefs-<feature>.md` — named after the run, taken from
   `node ~/.claude/hooks/run-state.cjs get` (that path means
   `${CLAUDE_PLUGIN_ROOT}/hooks/run-state.cjs` when `CLAUDE_PLUGIN_ROOT` is set —
   installed as a plugin — and `~/.claude/hooks/run-state.cjs` otherwise, running from
   this repo). One shared `docs/briefs.md` renumbers across
   concurrent features: two runs in one checkout both append BRIEF 4, and the second
   renumbers work the first has already committed. Record it with `--brief-file` so
   /execute finds the same file. Then fill in a `## House rules` section (below)
   from what you can verify in this repo — do not invent commands.
2. **A `Done when` may cite only a committed file or an inline command.** Never a path
   that exists in your working tree and nowhere else. A brief in this estate cited
   `scratchpad/ci-equivalent.sh`; the file was never written, so the recipe could not be
   run by the reviewer, by the next session, or by anyone reading it afterwards. If the
   verification needs a script, commit the script in the same brief that cites it.
3. **Verify the house rules against the repo**, every time. The test command, the interpreter
   path and the baseline counts must come from actually running or reading them, not from
   convention. Run the suite once to get the real baseline if it is cheap.
4. **Append the next BRIEF n.** Use the template below.
5. **Print the opener** and nothing else after it.

## House rules block (once per file, at the top)

```markdown
## House rules  (read before any brief)
- Work in: <worktree path> on branch `<branch>`. Main checkout is <path> on `<branch>` —
  never commit there.
- Tests: `<exact command with absolute interpreter path>`
  Baseline: <N passed, M failed, K skipped>. Already-red: <named test> — do not fix it,
  do not report it as a regression.
- Money/scope guard: <endpoints or commands that bill or mutate shared state, and the
  sanctioned stub for testing those paths>
- Never touch: <paths, sibling repos, consumed packages>
- Evidence standard: paste the literal terminal output — the command, its output, and the
  exit code from `echo $?`. Not a summary, not "it passed". A test counts only if you
  sabotage what it guards, see red, and restore.
- Report back: what changed, the test output, the commit hash.
- If a brief turns out not to be worth doing, say so and stop rather than manufacturing work.
```

## Brief template

```markdown
## BRIEF <n> — <title>
**Do:** <one imperative paragraph>
**Files you own (edit only these):** <explicit paths>
**Done when:** <a condition a machine can check>
**Stop at:** <do not push | do not deploy | do not write production code in this chat>
```

## Rules for filling it in

- **Every number must be measured** — baseline counts, a sha, a line number. Adjective-based
  briefs ("make it cleaner", "it's inaccurate") produce negotiation, not work.
- **Every prohibition carries its consequence.** "Don't do X" is ignored; "don't do X,
  because you will conclude Y, which is false" is not.
- **Every trap names the session it already cost.**
- **`Done when` must be machine-checkable.** The demo-ladder cost 23.3 active hours for 13
  commits because its done-condition was taste; the same-day sharepoint-perf ladder cost 1.7
  hours for 6 commits with an identical process and a checkable one. If you cannot write a
  checkable condition, this is UI/taste work — say so, and recommend running the app and
  iterating in one session instead of writing a brief.
- **Name the task, not the tools.** Openers naming superpowers/subagents/MCP servers land 1.79
  commits per hour; openers naming a task land 2.27.

## The opener to print

For a single brief:

```
Read <path/to/briefs.md> — the house rules, then execute BRIEF <n> exactly as written.
```

For a ladder, hand it to `/execute` instead — it runs them serially with a reviewer per brief
and commits as it goes:

```
/execute <path/to/briefs.md> <first>-<last>
```
