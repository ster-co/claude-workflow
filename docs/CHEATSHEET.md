# Cheatsheet

Eleven commands, seven agent roles, five hard gates. Written 2026-09-23, updated 2026-09-28.
`README.md` explains how it works; this says what to type.
[`COMMANDS.md`](COMMANDS.md) explains what each command does, in plain language.

---

## The one-line version

```
/brainstorm   I don't know what I want yet
/explain      I don't understand this code
/ship         build the thing            ← the front door, covers plan→brief→execute→land
/quick        a small, obvious ask — answer, brainstorm, bug or change, inline, no plan
/diagnose     something is broken
/attack       try to break this
/land         get it pushed and reviewed
```

Everything else is a step `/ship` already does for you.

---

## Starting something

| you have | type | what happens |
|---|---|---|
| a vague itch | `/brainstorm <thing>` | 2–3 approaches with trade-offs, a recommendation, **stops**. Never writes a plan. Type `/blueprint` when you know what you want. |
| a small, obvious ask | `/quick <ask>` | answer, brainstorm, bug fix or change, inline, no plan, no subagents except `scout`. **Do-it-now threshold** (estimated before editing): ≤5 files, ~80 lines of behaviour-bearing code (tests and docs don't count), no gate/permission/auth change at any size, no design call, a cause that reproduces, no shared resource outside this checkout. Crossing it — even mid-change — escalates to `/diagnose` or `/ship`; edits already made stay uncommitted and get reported. |
| a clear feature | `/ship <idea>` | the whole pipeline; stops twice for you |
| a written plan already | `/ship path/to/blueprint.md` | skips planning, stops at the approval gate |
| a bug | `/diagnose <symptom>` | refuses to diagnose until environment, one-symptom and expected-vs-observed are settled; a simple fix goes straight through, anything needing a decision is handed to `/ship` — answer with `/ship <n>` in the same chat |
| a question about code | `/explain <what>` | answer in chat, `file:line` on every structural claim |
| code you distrust | `/attack <target> [axes]` | one axis = cheap probe; several = fan-out, asks first |

### `/ship` is typed more than once

```
/ship add a CSV export to the quote screen
      → triages, brainstorms, puts up approaches, STOPS          ← Gate 1: direction
/ship 2                                                          ← pick approach 2
      → writes docs/plans/YYYY-MM-DD-*.md, audits it, STOPS      ← Gate 2: the plan
/ship                                                            ← bare = approval
      → briefs, executes brief by brief, lands. Unattended.
```

**At either gate, what you type is read as an answer, not as consent.** `/ship no, the
migration order is wrong` revises and stops again — it does not proceed. Bare `/ship` at the
plan gate is approval; that is the one unambiguous "yes".

An argument that is **a path to a file** is always a plan, whatever phase you are in.
An argument **on a run that is not at a gate** starts a new run.

### Resuming

`/ship` with no argument resumes this chat's run. Lost track?

```
node ~/.claude/hooks/run-state.cjs table     # every run, its phase, its branch
node ~/.claude/hooks/run-state.cjs get       # this chat's run
node ~/.claude/hooks/run-state.cjs current <feature>   # bind this chat to a run
```

Several runs can be live in one checkout. `/ship` will ask which rather than guess.

---

## `/explain` — five altitudes

Say the altitude or let it infer:

| altitude | ask it |
|---|---|
| System | "what is this repo, where do I start reading" |
| Container | "explain the quote-comparison subsystem" |
| Component | "how does a PDF get from upload to parsed anchors" |
| Code | "what does `resolve()` do and what calls it" |
| **Change** | "what did PR #142 actually do" · "why is this code like this" |

Answers in **chat** by default — it writes nothing unless you ask. Every structural claim
carries `file:line`, and **"I could not determine X" is required output**, so an answer that
admits a gap is working correctly, not failing.

---

## `/attack` — seven axes, two weights

```
/attack                                   # current branch vs trunk, the merge preset
/attack src/billing performance           # one axis, narrow → probe, runs immediately
/attack feature/x security,idempotency    # two axes → audit, proposes and waits
/attack <merge-sha>                       # reviews the merge, not your branch
```

**Axes**, as `commands/attack.md` names them: Security · Correctness · Operational
excellence · Idempotency · Reliability · Performance · Cost. Name them however you like in the
argument — it reads $ARGUMENTS and classifies.

**Probe** (one axis, narrow target) runs immediately — no fan-out, no prompt.
**Audit** (several axes or a broad target) proposes an axis set and **waits — and you can edit
the set**, not just accept or refuse it. Seven axes is seven opus agents, so choosing the axes
*is* the cost control.

It proposes remedies and **never applies them**. It ends by asking whether to fix or document.

Not to be confused with the bundled `code-review` skill: that hunts correctness bugs in a
*diff*; `/attack` probes a *standing system* along architectural axes.

---

## The pipeline, if you want the pieces

`/ship` runs these in order. Use them alone when you want one step.

| | |
|---|---|
| `/blueprint <idea>` | triage → brainstorm → direction gate → plan doc → `plan-auditor` → stop |
| `/brief <plan>` | plan → numbered briefs in `docs/briefs-<feature>.md` |
| `/execute [range]` | per brief: implementer → reviewer → commit → next |
| `/land` | verify, read the diff, **offer `/attack`**, commit, push, open PR |
| `/handoff` | write the next session's opening prompt, deliberately |
| `/subagent-mode <profile>` | set this session's agent profile (`quality` default, `balanced`, `fast`); `default <profile>` sets the machine default; roles per row are in `hooks/agent-profiles.json`; `fast` is experimental |

`/blueprint` triages into three tracks and you do not override it: **do it now** (small and
obvious), **iterate in a browser** (visual/taste work — a plan is the wrong artifact), or
**really plan**.

---

## The agent roster

Dispatch by role and the model routing follows. Never switch the main conversation's model —
that invalidates the prompt cache. Send the work down instead.

| role | model | for |
|---|---|---|
| `scout` | haiku | "where is X", "which files do Y" |
| `researcher` | sonnet | "how does this library work", version-pinned |
| `implementer` | sonnet | one brief, test-first, never commits |
| `reviewer` | opus | adversarial; emits `## Review Verdict` |
| `debugger` | opus | root cause after two failed review rounds |
| `plan-auditor` | opus | verifies a plan's claims against the repo |
| `root-cause-auditor` | opus | attacks a diagnosis before code is written against it |
| `…-lite` | opus, effort medium | effort-medium twins of the roles above: same prompt, less reasoning; selected when a profile entry sets effort `medium` |

---

## What will stop you, and what it wants

These are hooks. They fire whether or not anyone remembers the rule.

| you tried | it wants |
|---|---|
| editing a `.py/.js/.cjs/.ts` file under a gated repo | a **reference lookup** first — `mcp__serena__find_referencing_symbols`. `find_symbol` does not count. |
| `git commit` | a real **`git diff`** this turn. `git status` does not count — it shows no content. |
| committing a plan under `docs/plans/` | a **`plan-auditor`** verdict for that exact path. CLEAN and MINOR pass; DEFECTS passes only with every blocking id written into a `## Known defects — accepted` section. |
| ending a turn mid-brief | an `APPROVED` reviewer verdict on file. Stands down after 5 blocks. |

**Escape hatch:** `SKIP_CODE_GATES=1`. Use it when you have decided the gate does not apply,
not to get past one you have not read.

**A gated repo is one with `.serena/project.yml`.** `~/.claude/bin/claude-repo-setup.sh --write`
creates it. `--all <dir>` walks a whole tree, nested repos included.

---

## Checking it still works

```
node ~/.claude/hooks/test/verify-all.cjs   # 2,001 tests, twelve files, wiring assertions
```

Exit 0 means all of it passed — **that was not true before 2026-09-22**, when unit tests were
piped to `tail -2` and the script reported `tail`'s status.

**A test counts only if you sabotage what it guards, watch it go red, and restore.** Not a
slogan: three checks in that file were found unable to fail, and each was fixed by breaking it
deliberately first.

---

## Things that will bite you

- **Subagents have no MCP tools.** The `implementer` role lists serena lookups; the harness does
  not honour them. Anything needing a reference lookup has to be done in the main conversation.
- **"Read-only" agents are not.** `reviewer` and `debugger` have no `Edit`/`Write` — but `Bash`
  reaches `rm`, `sed -i` and `git checkout`. One destroyed this repo's working tree on
  2026-09-22. `/execute` and `/attack` now snapshot with `git stash create` before every
  dispatch. Do not assume; snapshot.
- **`git status` satisfies nothing.** Not the commit gate, not the tripwire.
- **`grep` here is `ugrep`** and emits paths without `./`, so `grep -v '^\./foo'` and
  `grep -vE '/(foo)/'` filters silently fail. Scope greps to a directory instead.
- **Plans belong in `docs/plans/`**, unconditionally, in every repo — including `~/.claude`,
  which is itself a git repo and whose plans are gated like anyone else's.
- **`/execute` is strictly serial.** Parallelism lives in `/attack`'s fan-out and nowhere else.

---

## Where things live

```
~/.claude/commands/     the ten commands
~/.claude/agents/       the seven roles, each pinning its own model
~/.claude/hooks/        the gates, the run state, the tests
~/.claude/audit/        why every choice was made, dated, with evidence
~/.claude/state/        run state, verdicts, agent log — gitignored
<repo>/docs/plans/      plan docs — gated
<repo>/docs/briefs-*.md the work queue — a real artifact, committed
```
