---
name: refactor
description: Change the shape of code without changing what it does — renames, extraction, moves, splits, dead-code removal. Use when the intended diff is structural and behaviour must be identical afterwards. Covers the safety net to establish first, commit granularity, and why a refactor reviewer grades against previous behaviour rather than against a spec.
---

# Refactoring

Refactoring inverts the normal loop. **There is no failing test to write first**, because
nothing new should become true — the tests passing afterwards is the entire point rather
than a side effect.

It also inverts what review is for. A feature reviewer asks *does this do what the brief
said*. A refactor reviewer asks *does this still do exactly what it did before* — a question
that cannot be answered against a spec, only against the previous behaviour.

**Measured 2026-09-22:** an ablation on a real cross-language rename found the model already
greps thoroughly and already refuses to write redundant characterisation tests when coverage
exists. What follows is deliberately narrow — the parts that were *not* already reliable.
Blast-radius discipline lives in the repo's own instructions, not here.

## When this does not apply

- **The behaviour changes, even slightly.** Then it is a feature or a fix, and it goes
  through `/plan` or `/bug`. "Refactor and also fix that bug while I'm in there" is how a
  behaviour change ships inside a diff nobody reviewed for behaviour.
- **Legacy modernization, cross-stack rewrites, framework version uplifts.** The first-party
  `code-modernization` plugin owns that — `uplift-migrator`, `version-delta-analyst`, and a
  staged assess/map/transform workflow. Use it rather than improvising.

## 1. A safety net you have watched fail

**If the code has no coverage, you are not refactoring — you are rewriting and hoping.**

Where coverage is absent, write **characterisation tests**: assertions of what the code
*currently does*, including behaviour that looks wrong. You are not judging it, you are
pinning it so a change becomes visible. If something looks like a bug, pin the buggy
behaviour and note it; fixing it is a separate change, after.

Where coverage already exists, **do not write them** — redundant scaffolding over adequate
tests is cost without signal.

Either way, the net is worthless until you have seen it fail:

- Break the thing it guards, run it, watch it go red, restore. A net nobody has broken is a
  belief about a net.
- **Prefer a sabotage that is on your path anyway.** On a rename spanning a language
  boundary, do the first half, watch the gate go red, then do the second. That is free, and
  it is stronger evidence than an artificial break because it exercises the exact edge at
  risk.
- **Check the net is not skipping itself.** A test that skips when a runtime is missing
  reports `s` and lets the suite exit 0. This estate had four such gates; on a machine
  without `node` the only tests that could see a broken rename silently stood down.

## 2. One mechanical change per commit

Rename, then commit. Extract, then commit. Move, then commit. **Never bundled**, even when
the tool could do all three at once and the result would be correct.

This is the rule most likely to be skipped, because an agent *can* produce the whole diff in
one shot and it feels efficient. It is the wrong trade: when the suite goes red after a
combined change you have lost the thing that makes refactoring safe — knowing which
transformation broke it. A three-step refactor that breaks on step two is a ten-second
`git diff`; the same work as one commit is a bisect through your own diff.

**What this does not mean:** splitting one transformation across files or languages. If a
rename touches JavaScript and a copy of that JavaScript embedded in a Python test, both move
in the same commit — an intermediate commit where one is renamed and the other is not is a
knowingly-broken tree, which is worse than a large one.

Run the suite between every step, not at the end. Compare against the baseline you measured
*before* starting, not against "zero failures".

## 3. Grade behaviour, not intent

If you dispatch a reviewer, brief it on **behaviour preservation**. Its job is to find a
behaviour that differs; "it matches the plan" is not evidence of that, and a refactor has no
brief to conform to.

Two questions worth answering explicitly before declaring it done:

- **Which changed lines does the suite actually execute?** A function exported but never
  imported, or a call site reachable only through the DOM, can be renamed wrongly and leave
  the suite's number completely unchanged. Find those lines and check them another way.
- **Did the tool's idea of a reference match the language's?** Where a name crosses a
  boundary — embedded source, a registry key, a serialised fixture — the reference exists
  and the symbol tool does not see it.

## 4. When it goes wrong

- **Stop at the first red suite.** Do not push forward to where you think it resolves. The
  commit you are on is the smallest reproduction you will ever have.
- **If the refactor reveals a bug**, note it and finish the refactor first. A fix inside a
  structural diff is invisible to review and cannot be reverted separately.
- **If the change stops being mechanical** — you are deciding what the code *should* do
  rather than how it should be shaped — stop. That is a design change and it needs `/plan`.
