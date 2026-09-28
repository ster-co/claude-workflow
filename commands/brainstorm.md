---
description: Open-ended exploration for "I don't know what I want yet" — reads the real state, puts up 2-3 approaches with trade-offs, recommends one, and stops with a recommendation in chat. Never writes a plan document.
argument-hint: [what you're trying to figure out — a problem, a rough idea, a direction you're unsure of]
# No side effects: answers in chat, writes no files, commits nothing. It must
# stay model-invokable: /blueprint and /ship run it as their brainstorming
# step, and a command the model cannot invoke breaks that chain.
---

Brainstorm: **$ARGUMENTS** (if empty, ask what the user is trying to figure out before doing
anything else).

This command is for the moment before the moment `/blueprint` is for: **you do not yet know what
you want to build**, only that something is unclear, or that there might be more than one
reasonable way to go. `/blueprint` already assumes a track has been picked and existence of a
document at the end. This command assumes neither. Its terminal state is a **recommendation
typed into this chat**, nothing more.

## The rule that overrides everything else in this file

**Do not write a plan document. Do not invoke the `writing-plans` skill. Not at any point in
this conversation, not as a final step, not because the conversation drifted toward one being
useful.** This is stated here on purpose, not left to be inferred from silence.

If `superpowers:brainstorming` gets reached for to help structure the conversation, its own
architectural track says, near the end of its instructions: *"Invoke the writing-plans skill
to create a detailed implementation plan... Do NOT invoke any other skill. writing-plans is
the next step."* That instruction describes what `/blueprint` does with the same skill. **It does
not apply here.** From inside this command, that step is never taken — stop the conversation
before it, regardless of what the skill's own text says comes next. A command that merely
avoids *mentioning* a plan while still walking that path would produce a plan document anyway;
this command refuses to walk it.

If the direction becomes settled enough to act on, **say so, stop, and name the next step:**

> **Next:** `/ship <what was decided>` to build it — it opens a dev branch in its own worktree
> and ends with a PR — or `/blueprint <what was decided>` for the plan only; you then run
> `/brief` and `/execute` yourself, on your current branch.

Do not slide from "we've landed on an approach" into writing anything down yourself — that
hand-off is `/ship`'s or `/blueprint`'s job, not this one's.

**When `/blueprint` or `/ship` runs this command** as its brainstorming step, stop after the
recommendation and name no next step: the caller owns what comes next — its direction gate —
and a "Next:" line there would point the user away from the run they are in. The rule above
still holds in full: no plan document, no `writing-plans`.

## What this command still does, because it's the useful part

1. **Explore the real state before proposing anything.** Read the code, run the thing, check
   the data — do not propose an approach against a guess of what's there. Where the question
   touches existing symbols, use `mcp__serena__find_referencing_symbols` (or the closest
   structural-search tool actually available) to see who depends on what before floating a
   direction that would move it.

2. **Ask one clarifying question at a time** where the goal, the constraints, or what "done"
   would look like are still unclear. Do not front-load a list of questions; a brainstorm is a
   conversation, not a questionnaire.

3. **Put up two or three approaches, with trade-offs — never one presented as inevitable.**
   For each: what it costs, what it risks, and **what it forecloses** — the option it quietly
   takes off the table for later. A single "here's the plan" answer is not a brainstorm; it's
   a plan wearing this command's name.

4. **Say which you recommend, and why.** A recommendation without a stated reason is not more
   useful than the bare list of options.

5. **Stop there.** No design doc, no spec file, no plan file, no code. If the user wants to
   keep exploring, keep talking — that is still this command's job. If the direction is
   settled, say so plainly and give the **Next:** line above; do not take that next step
   yourself.
