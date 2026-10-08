---
description: Turn a task or an approved plan into numbered briefs in this repo's brief file, then print the opener that executes them.
argument-hint: [what to do — a task description, or a path to an approved plan doc]
# Deliberately model-invokable, unlike the entry-point commands. /ship and
# /blueprint call this one mid-run, and a command the model cannot invoke breaks the
# chain: /ship reaches its approval gate and stops. Its side effects are bounded
# by the gates, the per-brief reviewer and /execute's termination conditions --
# not by being unreachable.
---

Write brief(s) for: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). Every brief inherits its verification
standards and scope rules, so they have to be in context while writing them. On a checkout with a
`CLAUDE.md` it is already in context; on a plugin install no `CLAUDE.md` reaches the
session, so this is the point where `/brief` pulls it back in.

The plan doc normally comes from `/blueprint`. If you were handed a task description for work that
needs a design call first, say so and route to `/blueprint` rather than inventing the design inside a
brief.

If the argument is **a path to a plan or design document**, read it in full and write the whole
ladder, in dependency order, and fill every brief's `Depends on` line from the plan's own
`Depends on` / `Independent of` lines for its tasks, translated into brief numbers. Where
the plan states nothing for a task, list every earlier brief: an undeclared dependency runs
serially, which is slower but never wrong. Two briefs whose red-first steps run the same
shared suite — both add a `verify-all.cjs` check, or one adds or changes a suite that
another's suite runner includes — depend on each other even when their owned files are
disjoint, so the later one lists the earlier: each one's deliberately red check turns the
other's suite run red. Cost: the ship-review-weight plan listed such a pair as independent
and had to be corrected (plan audit finding D4). A task is
**mechanical** when it deletes files, edits prose or config, renames or moves something
without changing behaviour, or is a one-line change, and adds no behaviour and no test —
anything else is **behavioural**, and if the text does not settle it, treat it as
behavioural. Mechanical tasks share a brief, up to 3 per brief; give each behavioural task
its own brief. Findings a reviewer marks NOTED go into follow-ups briefs appended at the end
of the file once the ladder is done — mechanical NOTED findings grouped together, up to 3
per brief, and a behavioural NOTED finding still gets its own brief. If it is **a
task description**, write one brief.

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
   `node ~/.claude/hooks/run-state.cjs get` (this command's hook scripts live in
   `${CLAUDE_PLUGIN_ROOT}/hooks`; if that path reads as a real absolute path here —
   installed as a plugin — use it everywhere this file says `~/.claude/hooks`; if it
   still reads as the literal placeholder — running from a `~/.claude` checkout — use
   `~/.claude/hooks` as written). One shared `docs/briefs.md` renumbers across
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
5. **Print the opener** and nothing else after it. Inside a `/ship` run, the opener is not a stop:
   print it, then hand straight back to `/ship`, which runs `/execute` in the same turn. The
   opener is for a human pasting it into a fresh session, not a cue to end this one.

## House rules block (once per file, at the top)

```markdown
## House rules  (read before any brief)
- Work in: <worktree path> on branch `<branch>`. Main checkout is <path> on `<branch>` —
  never commit there.
- Tests (full): `<exact command with absolute interpreter path>`
  This is the exact command `test-delta.cjs --command` will run — do not append `; echo` or
  anything else after it, because that always makes the exit code 0.
  Baseline: <N passed, M failed, K skipped>. Already-red: <named test> — do not fix it,
  do not report it as a regression.
- Tests (fast): `<exact per-repo changed-file/affected command>` or `TBD` — this is what the
  implementer runs while working, per `agents/implementer.md`'s "run only the tests related
  to the change" bullet. Fill this in only when you can verify a real command against this
  repo (its runner and its changed-file mechanism both confirmed) — leave it `TBD` rather
  than guess. The reviewer, the orchestrator and `/land` always use Tests (full), never this
  line.
- Money/scope guard: <endpoints or commands that bill or mutate shared state, and the
  sanctioned stub for testing those paths>
- Never touch: <paths, sibling repos, consumed packages>
- If this repo's hooks or tools read a config directory from the environment at load time
  (as `~/.claude`'s hooks read `CLAUDE_CONFIG_DIR`), any probe or test must set that variable
  before requiring or spawning the module, never after. Cost: a reviewer's probe that set it
  late wrote into the live `~/.claude/state`.
- Evidence standard: paste the literal terminal output — the command, its output, and the
  exit code from `echo $?`. Not a summary, not "it passed". The implementer proves each new
  test by seeing it red before the change and green after, with no separate sabotage pass;
  the reviewer names one sabotage per test and the orchestrator performs it, once per
  behavioural brief. Before reporting, the implementer also checks that each branch the
  brief names is pinned by some test (at most 3 one-line mutations, restored).
- Report back: what changed, the test output, the commit hash.
- If a brief turns out not to be worth doing, say so and stop rather than manufacturing work.
```

## Brief template

```markdown
## BRIEF <n> — <title>
**Class:** mechanical | behavioural
**Depends on:** <brief numbers, comma-separated | none>
**Serial:** <optional — a shared outside resource this brief needs alone: a fixed port, a
database or emulator, a migration, a deploy, or a browser check>
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
- **A wording or cleanup brief states the rule once and carries the complete list of lines to
  change, produced before briefing, never example phrases.** It owns every file on its list.
  Cost: gate-followups BRIEF 4, rejected twice with one leftover phrase per round, and one
  file not owned.

## The opener to print

For a single brief:

```
Read <path/to/briefs.md> — the house rules, then execute BRIEF <n> exactly as written.
```

For a ladder, hand it to `/execute` instead — it groups briefs whose `Depends on` is
satisfied and whose owned files are disjoint, dispatching each group's members together and
every other brief one at a time, with a reviewer per brief and a commit per brief as it goes:

```
/execute <path/to/briefs.md> <first>-<last>
```
