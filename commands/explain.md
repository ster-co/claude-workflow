---
description: Explain a subsystem, feature, symbol or change at the altitude the question implies — understanding-oriented, cited file:line, chat by default.
argument-hint: [what to explain — a subsystem, a path, a symbol, or a commit/branch range — and optionally the altitude]
# No side effects: answers in chat, spawns no subagents, writes nothing unless
# asked. That statelessness is what makes it safe for another command to
# invoke as a grounding step before triage — /plan Step 2 or /bug, for
# instance, could reach for it that way — which is why this command stays
# model-invokable on purpose. No such wiring exists yet.
---

Explain: **$ARGUMENTS** (if empty, ask what and at what altitude before doing anything else).

## The rule everything else here serves

`plan.md` records what happened the one time this was measured on this setup: of the factual
claims made while planning, **every claim carrying a `file:line` was correct, and every claim
sourced from memory was wrong.** A plan at least gets read and gated before anything is built
on it. An explanation does not — nothing downstream audits it, so an explanation that invents
architecture is strictly worse than no explanation at all. Two rules follow, and neither is
negotiable:

- **Every structural claim carries `file:line`.** "Structural" means what calls what, what
  depends on what, where something lives, how control or data flows between two places — the
  load-bearing content of the answer, not incidental prose.
- **"I could not determine X" is required output, not a failure.** If the index or the source
  does not show it, say that plainly and stop there. A confident guess dressed as a finding is
  the exact failure mode this command exists to prevent.

## Five altitudes — four borrowed, one not

| altitude | answers |
|---|---|
| System | what is this repo, what are its pieces, where do I start reading |
| Container | one subsystem or service |
| Component | one feature's execution path, end to end |
| Code | one symbol and its blast radius |
| **Change** | what a PR/branch/commit range actually did, and why the code is shaped like this (git archaeology) |

**The first four are C4's Context/Container/Component/Code levels, repurposed.** C4 was built
to name the levels of an architecture *diagram*, not the altitude of a prose explanation, and
the research behind this command found **no altitude taxonomy for prose explanation anywhere
in the industry** — searched for directly, nothing beyond generic abstraction-layer pages
turned up. Borrowing C4's four names here is a convenient repurposing, not an inherited
convention. Do not present it as one. **Change is not C4's at all** — it is local to this
command, because "why is this code like this" is a question C4 was never asked to answer and
the diagram vocabulary has nothing for it.

Pick the altitude the question implies. If more than one fits, say which one you picked and
why in the first line of the answer, rather than silently choosing.

## Register: Diátaxis *explanation*, not how-to, not reference

Answer in the Diátaxis explanation quadrant: understanding-oriented, the kind of answer to
*"can you tell me about…"*, one that makes connections across concepts and is allowed to admit
opinion and alternatives. Explicitly **not**:

- **task instructions** — "how do I add a route here" is how-to, not explanation. If the
  question is really that, say so and point at the right place instead of forcing a
  how-to-shaped question into an explanation-shaped answer.
- **an exhaustive inventory** — this is not a generated symbol index or an API reference. Cover
  what the question needs, cite what backs it, and stop; do not pad toward completeness.

## Index structurally before reading anything cold

Three serena tools are wired into this repo's `settings.json:79` —
`mcp__serena__find_referencing_symbols`, `mcp__serena__find_implementations` and
`mcp__serena__find_declaration` — and are the place to start: find who calls the thing, what
implements it, and where it is declared before reading files top to bottom. If other
structural-search tools are available in a given session, verify each one is real before
relying on it or naming it in the answer — naming a tool that turns out not to exist is the
same failure mode as inventing a `file:line`. Where no
indexing tool is available, `grep` and a directory listing are the fallback, but still index
first (entry points, the files involved) before reading any one of them cover to cover.

## Diagrams: Mermaid, only when the question is shaped for one

A **sequence** diagram earns its place for an execution path over time; a **component**
diagram earns its place for structure. Draw one only when the question is structural or
execution-flow shaped — never to decorate an answer that reads fine as prose, and never a
**Gantt** diagram, which is a project-planning artifact with no place in explaining code. If a
diagram would just re-draw the prose in boxes, skip it.

## Output: chat by default

Answer in chat. Do not write anything unless asked.

If a write is asked for, it goes to `docs/explain/`, unless this repo already has a
better-established place for this kind of document — check before assuming `docs/explain/` is
it. Whether that path is even trackable depends on which repo this command is running in, since
`/explain` is a global command with no fixed home repo: in `~/.claude` itself, the root
`.gitignore` is an allowlist that already re-includes `docs/` (`.gitignore:18`), so
`docs/explain/` is not gitignored by default there; in any other repo, check that repo's own
`.gitignore` before assuming the same holds. Either way, before writing to `docs/explain/` for
the first time, check for `docs/explain/.gitignore` and create one if it is missing, containing:

```
*
```

A bare `*` is self-ignoring: it hides everything under the directory, including the marker file
itself, so the tree never shows an untracked `docs/explain/.gitignore` after the first write. A
`!.gitignore` re-include was considered and rejected — it would leave the marker file itself
un-ignored, so `git status --short` shows a permanently changed tree from the first write
onward, which trips this estate's "a changed tree voids the batch" rule for reasons that have
nothing to do with the answer just given.

Writing the file is not committing it — committing is a further, separate, explicit act this
command never takes on its own.
