---
description: Front door for a feature or a big fix — triage it, brainstorm options, stop on the direction, write the plan doc, stop at the approval gate.
argument-hint: [what you want to build or change]
# Model-invokable on purpose. /blueprint is both typed by the user and invoked by
# /ship's Start step, so blocking it severs that chain -- /ship
# reaches its first instruction and stops. Of the commands a caller invokes this
# is the least dangerous: it writes a plan doc and run state, and commits nothing.
# Named /blueprint, not /plan, on purpose. Claude Code has a built-in /plan, and
# in the desktop app typing /plan switches on plan mode instead of running this
# file. Do not recreate commands/plan.md: a branch that still edits it or says
# /plan should carry those edits here and say /blueprint. verify-all.cjs fails
# on any command named after a built-in.
---

Blueprint: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`) — the triage below, and everything downstream of
it, assumes that operating discipline is already in context. On a checkout with a
`CLAUDE.md` it is; on a plugin install there is no `CLAUDE.md` reaching the session, so
this is the point where `/blueprint` pulls it back in.

This is the step before `/brief`. It ends with a plan document and **your approval**, not with
code. Nothing downstream re-examines the plan, so the gates below — direction in Step 2.5,
then approval at the end — are the ones that have to hold.

## Step 1 — Triage. Decide which of three tracks this is, and say which.

| the work is | route |
|---|---|
| **at most 3 files and about 30 changed lines**, no design call, a cause that reproduces (for a bug), and no `Serial:`-class resource (a deploy, a migration, a production tenant) | Do it now. Do not plan it. Run the `/quick` procedure: classify, follow one path, run the related tests, read the diff, commit on a non-default branch, do not push. |
| **visual or taste-driven** — layout, spacing, copy, "make it cleaner" | **Do not plan it.** Run the app, drive a real browser, iterate in one session. `3d017c63` ran two brainstorms, a `writing-plans`, a design doc and three Explore agents on a dropdown layout and committed **nothing**, ending on the bare word *"continue?"*. Brainstorming a dropdown produces a document, not a dropdown. |
| **"will it break when combined" — a merge, a move, a dependency upgrade** | **Build a throwaway worktree first**, then write the plan from what it measured. On the LYHYT engine merge a spike at `/tmp/spike-merge` disproved three risks that three consecutive plan revisions had asserted, settled the nested-vs-sibling layout by hitting the namespace-package hazard, and produced all five real blockers. Revisions cannot falsify a risk; running it can. |
| **a subsystem, a migration, a change spanning files or repos, or a bug whose fix is bigger than one session** | Continue below. |

If you route to track 1 or 2, say so in one line and get on with it. Do not plan work that does
not need planning — that is half of what made the July tutorial era cost three mega-sessions and
produce two commits.

## Step 2 — Brainstorm. Explore the real state first.

Run `/brainstorm` on the request. It is the brainstorming skill with a hard stop: it explores,
puts up approaches and a recommendation, and ends there. The raw skill, left to itself, ends
by committing a spec under `docs/superpowers/specs/` and invoking `writing-plans` — a second
design document and a second approval loop beside the plan doc and gates this command owns.
Before proposing anything, establish what is actually there: read the code, run the thing,
check the data. Use `mcp__serena__find_referencing_symbols` and `query` on the symbols this
would touch and report the blast radius now, while it is still cheap to change direction.

Then put up **two or three approaches with their trade-offs**, not one plan presented as
inevitable. Say which you recommend and why. Name what each one forecloses.

Sessions that ran brainstorming *and* wrote a plan landed **10.1 commits per session against 1.4
for sessions that used no skill at all**. This is the highest-yield part of the whole workflow.

## Step 2.5 — Stop. Direction gate.

Brainstorming and writing the plan file used to be one continuous motion — approaches went
up, and the file started before anyone outside the model had seen them. Split it:

Print the approaches from Step 2 — trade-offs, recommendation and all — and ask which one.
**Stop.** No plan document exists yet, so this is the cheapest point in the whole exercise
to change course: a wrong call here costs one conversation, the same wrong call caught after
Step 3.5's audit costs a rewritten plan, and caught at `/execute` costs the whole run.

**Skippable, but not silently.** Go straight to Step 3 without stopping only when you do all
three of these in the same turn:
1. print the approaches;
2. name the chosen one and the reason, in the same message;
3. write one line into the plan document (Step 3, under a `## Direction gate` heading or
   folded into Context) saying the gate was skipped and why.

This mirrors the plan's own `## Known defects — accepted` pattern below: the shortcut is
allowed, but it leaves a trace instead of vanishing, so how often it fires can be counted
later — by grepping committed plans — rather than assumed.

**When `/blueprint` is being driven by a `/ship` run, this step does not fire.** `/ship` owns
the direction gate — it calls it Gate 1 — and this step is the standalone equivalent, for
when `/blueprint` is typed directly with no run behind it. `/ship` owns it because `/ship` holds
the run and its phase, so it is the only one of the two that can record
`awaiting-direction` and be resumed at it; a stop here as well would ask the same question
twice in one run. Hand your Step 2 approaches up to `/ship` and continue to Step 3 when it
returns a direction.

Neither case records the skip in run state — `run-state.cjs`'s schema does not carry the
field, and a value written outside it would not survive the run's next `phase` call, so
there is nothing durable to record into. The plan-doc line above is the only trace either
way, and it is sufficient: the plan document is what is committed and searchable later,
not the run state.

## Step 3 — Write the plan to a file, in the repo.

`docs/plans/YYYY-MM-DD-<topic>.md`. Committed, not in the chat — a plan that lives only in a
conversation cannot be reviewed, resumed after a compaction, or handed to another agent.

Shape, from the plan that produced the best week in this history:

```markdown
# <topic>

## Context
<what is true today, with file:line evidence. What breaks, or what is missing.>

## Decisions — do not re-litigate
<each decision, and the reason. This is what stops task 7 reopening task 2.>

## Out of scope — deliberately
<what we are NOT doing, and why. This is what stops the next person rebuilding it.>

## Tasks

### 1. <title>
Files:     <paths this creates or modifies>
Consumes:  <interfaces/behaviour it depends on, with signatures>
Produces:  <interfaces/behaviour it exposes, with signatures>
Steps:     1. Write the failing test  2. Run it, confirm it fails for the right reason
           3. Implement  4. Run it again
Done when: <a condition a machine can check>
Independent of: <task numbers, or "nothing — depends on N">

### 2. …

## If something looks wrong once you are in the code
<what to do instead of silently deviating: flag it, stop, and say which task and why.>
```

Rules that matter:
- **Every task independently executable**, and mark which are independent *of each other* —
  `/execute` reads that to decide what may run in parallel.
- **Every `Done when` machine-checkable — and say what would make it pass while the work is
  wrong.** A done-condition is a gate, and a gate nobody tried to defeat proves nothing.
  Measured on the LYHYT merge plan: Task 1's done-when grep verified **362 of 559 imports**,
  because its `^` anchor dropped every function-local and non-dotted form — a rewrite leaving
  197 imports pointing at the old package would have passed it. One clause per task, naming
  the false pass. If you cannot write a `Done when` at all, that task is taste work and
  belongs in track 2.
- **Where line references may drift, say how to re-locate the code** rather than only citing a
  line number.
- **Cite evidence, not adjectives.** "It's slow" is not a context section; a measurement is.
- **Every load-bearing claim carries a `file:line` or a command and its output.**
  Load-bearing means something rests on it: a task exists because of it, a decision's
  reason is built on it, or a `Done when` was written from it. Not just the Context
  section — everywhere in the document, including inside the reason for a decision and
  inside a task's Consumes list. Measured on the session that added this rule: of the
  factual claims made while planning, **every claim carrying a file:line or command output
  was correct, and every claim sourced from memory or from generalising a rule was wrong**
  — four wrong claims, all of them in plan documents, none caught by any mechanism. A
  claim you cannot cite is one you have not checked. Check it, or leave it out.

- **Scale the citation density to the size of the work.** The rule above is about the
  claims that carry weight, not about decorating every sentence with a line number. Every
  citation is a new thing that can be wrong, and it rots on the next edit to that file —
  so a plan that cites everything spends its audit rounds on its own footnotes. Measured
  on 2026-09-22: a three-task change to a 78-line file produced a **266-line plan**, and
  round 3 of its audit returned one real defect and **nine citations off by a line**,
  every one of them minted by a previous revision editing prose around a correct fact.
  Concretely:
  - **A plan should be shorter than the code it changes.** If it is longer, it is
    over-planned — cut evidence, not tasks.
  - **Cite the file or the symbol when the line is incidental**, the line only when the
    line is the point. `notebooks/tools/run_course.py` is stable; `:186-187` is not.
  - **Prefer a command whose output can be re-run** to a transcribed count or a quoted
    line range. Those are the highest-drift citations there are: each revision re-renders
    them from memory.
  - **Cite a fact once.** A second copy in another section is a second thing to keep true.
  - Do not cite what the task's own `Files:` line already says.
- **No document is a citation. Only a command run now, on this branch.** Not a memory, not
  an audit finding, not a `CLAUDE.md`, not a roadmap, not an earlier revision of this plan —
  each is a snapshot of something that was true somewhere, and code moves underneath all of
  them. Every one of those has produced a false claim in a plan here: a memory naming a flag
  that had been renamed; an auditor's prose carried across as a sentence without re-running it
  (two of three were false, taking a Decision and two done-conditions with them); and
  `1280 passed, 8 skipped` copied out of the **intern-course branch's** `CLAUDE.md` into a plan
  written on `LYHYT-demo`, where it appeared six times, was a stop condition twice, and made a
  done-condition arithmetic over two wrong numbers — a state that could never occur.
  Evidence that re-reads the conclusion is not evidence either: one extraction-quality claim
  was corroborated in a circle until an auditor broke it against the raw artefacts.
- **So carry the command, not the number.** A transcribed count is stale the moment another
  session commits; a command re-derives. This is what finally converged the LYHYT plan —
  revision 4 stopped stating numbers and stated the commands that produce them. Where a number
  must appear, write the command beside it and the branch it was run on.
- **A general rule is not a claim about an instance.** "No tool resolves a string
  reference" is true; "therefore these seven `setattr` calls will break" is a separate
  claim needing its own grep. Rules license a *check*, not a conclusion.
- **A risk is a claim.** The risk list is where unmeasured speculation survives the citation
  rule, and it is what drives task count. On the LYHYT merge, three risks asserted across three
  revisions — dependency breakage, ten whole-tree gates firing, an `/api/api` double prefix —
  were all false, and a spike disproved them in minutes. Cite it, measure it, or cut it.
- **Work crossing into another codebase must enumerate that codebase's invariants**, not only
  its own. The LYHYT plan documented the engine's 8 policy gates and budgeted **zero** for
  LYHYT's ten `rglob` gates, one of which the engine trips on arrival — the auditor's phrase
  was "the mirror image of the risk the plan does document".
- **Re-derive carried-forward decisions against the current architecture — the reason *and*
  what still depends on it.** A decision whose text still parses may rest on a premise that
  has lapsed, and the next person re-derives from the reason. The consequences outlive it
  quietly: on the LYHYT plan the prose was clean of standalone-deployment fossils because two
  sections actively retract them, while a mitigation whose reason one of those sections kills,
  and a single-replica storage assumption that a five-replica container no longer honours, both
  survived into the tasks.

## Step 3.5 — Audit the plan's claims. Not optional.

Dispatch the `plan-auditor` subagent over the file you just wrote:

```
Agent(subagent_type: "plan-auditor",
      prompt: "Audit <absolute path>. Current premises: <the architecture and decisions
               that hold today — name them, especially any that superseded an earlier
               design this plan was revised through>.")
```

It verifies load-bearing claims against the repository — the ones a task, a decision's
reason, or a `Done when` rests on — flags uncited ones, and flags **stale premises**:
tasks, mitigations and decisions that only made sense under an architecture that no longer
holds. It does not judge whether the plan is good; that is your job and the user's.

**Give it the path and the premises, and nothing else.** It does not get the conversation
that produced the plan, and that is the point: the plan's wrong claims came from a chain of
reasoning, and an auditor handed that reasoning inherits the same premises and confirms the
same errors. The repository is its only authority.

Editing the plan invalidates the previous audit by design, because the edit is exactly
where a fresh false claim enters.

Act on the verdict, do not file it. It comes in three:

| verdict | what it means | what you do |
|---|---|---|
| **CLEAN** | nothing found | Say what it checked. A clean audit that cannot name what it attacked has told you nothing. |
| **MINOR** | citation drift only — the facts are right, the pointers are off | Record each finding under `## Known defects — accepted` as its id plus a one-line summary, with no fix instructions — that section is excluded from the audit hash, so writing it does not invalidate the audit. Commit either way; the gate does not hold a plan out of the repository over a line number. No round follows a MINOR. |
| **DEFECTS** | at least one blocking defect | Fix the false claims, or delete the tasks that rested on them — a task whose premise was wrong is usually not a task to re-word. If you edited the plan to do so, dispatch a **delta round**, below, to check the fix. If instead every blocking id is recorded under `## Known defects — accepted` and nothing else changed, no delta round: `plan-gate.cjs` accepts a DEFECTS verdict once every blocking id it named is listed there, the same path it allows for a carried MINOR. |

**A blocking defect you have decided not to fix goes in the plan, not in a bypass.** Add:

```markdown
## Known defects — accepted
- D1: <what is wrong, and why we are committing anyway>
```

and the gate lets the commit through, carrying the defect on the record. Every blocking id
the audit named must be there. This exists because the alternative was measured and it was
worse: on 2026-09-22 a plan went through three audit rounds — 13, then 9, then 10 defects —
and the only exits from the third were to perfect it or to set `SKIP_CODE_GATES=1`. A
bypass leaves no trace in the plan and the next reader inherits the false claim with
nothing marking it. Writing the section does not invalidate the audit; editing anything
else does.

**A re-audit after DEFECTS is a delta round, not a fresh one.** (This command's hook
scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path reads as a real absolute
path here — installed as a plugin — use it everywhere this file says
`~/.claude/hooks`; if it still reads as the literal placeholder — running from a
`~/.claude` checkout — use `~/.claude/hooks` as written.) Round 1 runs on
the auditor's own `opus`. Every round after it is dispatched with the Agent tool's
`model: sonnet` override, fed the output of `node ~/.claude/hooks/plan-audit-diff.cjs
<path>` — the last verdict, the blocking ids, and a `git diff --no-index` from the text
that was audited to the plan now — so it covers only the diff since the last audit, the
named blocking ids, and any unchanged text that cites a fact the diff changed.
`plan-audit-record.cjs` still accepts the report: it checks the reporting agent's role, not
its model. `plan-auditor.md`'s own `## Delta audit` section carries that scope and a
tool-call budget, so a prompt alone is not what holds it.

```
Agent(subagent_type: "plan-auditor", model: "sonnet",
      prompt: "Audit <absolute path>. Current premises: <as above>.
               <paste the output of `node ~/.claude/hooks/plan-audit-diff.cjs <path>`>",
      run_in_background: false)
```

Print one status line per round, for example `Audit r2: DEFECTS — 1 blocking (D1 stale
path), fixing` or `Audit r3: CLEAN`.

**Do not re-run the auditor to make a MINOR go away.** Each round edits prose around
correct facts and mints fresh off-by-ones — that is what 13 → 9 → 10 was. Two rounds found
real things. The third found one bug and nine typos.

This is not ceremony. On 2026-09-22 an audit of a plan that had been written carefully,
revised once under challenge and self-reviewed returned **seven defects** — including a
false safety claim ("this script cannot spend money") asserted twice as a load-bearing
decision, and a task that would have reimplemented a weaker copy of two existing tests.
None were reachable by re-reading the plan, because re-reading it means re-reading it with
the belief that put them there.

A plan is the one artifact nothing downstream re-examines: briefs amplify it, implementers
execute it, reviewers grade work *against* it. A false claim in a plan is executed, not
caught.

**Enforced, not remembered.** `hooks/gates/plan-gate.cjs` (PreToolUse Bash) refuses to
commit a file under `docs/plans/` until `hooks/gates/plan-audit-record.cjs` (PostToolUse
Agent) has recorded a verdict that clears it for *that* path — it reads `Plan: <abs path>`
from the verdict footer and keys the marker by a hash of the path, so a verdict for a
different plan does not unlock this one. CLEAN and MINOR pass; DEFECTS passes only with
every blocking id acknowledged in the plan. The marker stores a hash of the plan *minus*
its `## Known defects — accepted` section, so editing a plan after auditing invalidates
the audit — the edit is exactly where a fresh false claim enters — while recording a
defect the audit itself reported does not.

**`~/.claude` is a repository too, and its plans are gated like anyone else's.**
`plan-gate.cjs` fires on `git commit` and matches `docs/plans/**.md` in whatever repository the
commit runs in. `~/.claude` is a git repository, with its own remote
(`github.com/klosoter/claude-configuration.git`) and its own history. A plan written under
`~/.claude/docs/plans/` was nonetheless never gated, and not for want of a repo to catch it:
`.gitignore` here is an allowlist — `/*`, then explicit `!` re-includes — and `docs/` was not
on it, so `git add` of a plan written there failed outright. Nothing was ever committed, so
there was never anything for the gate to intercept. `!/docs/` has since been added, so a plan
written under `~/.claude/docs/plans/` is now tracked, committed and gated exactly like a plan
in any other repo — `docs/plans/2026-09-22-command-surface.md` is one, committed after this
gate cleared it on a MINOR verdict.

None of that changes where plans belong: **plans that drive code belong in the repo the code
lives in**, where they can be committed, reviewed and gated. That now includes a plan about the
global setup, because `~/.claude` is the repo that setup's code lives in.

One limit worth knowing: the gate is a `PreToolUse` hook on the **Bash tool**, so it sees a
`git commit` an agent runs and not one you type in a terminal yourself. That is true in every
repo, not just this one.

**Dispatch it with `run_in_background: false`.** This is not a preference. Subagents are
backgrounded by default, and for a backgrounded agent the tool result is a launch receipt —
the report arrives later as a user-role message, which fires no `PostToolUse` at all. The
recording hook then sees a receipt with no verdict in it and writes nothing, so the gate
stays locked no matter how clean the audit was. Measured: seven `plan-auditor` dispatches,
zero markers.

The path itself comes from the auditor's reply — `plan-auditor.md` already tells it to end
with `Plan: <absolute path>`, and that reply *is* the tool result once the dispatch is
synchronous.

## Step 4 — Stop. Hand it back.

Print the path and a three-line summary: how many tasks, which are independent, and the one place
you expect judgement will be needed. Then **stop and wait**.

Do not start implementing. Do not run `/brief` yourself. `2e1152a7` ran the full subagent
machinery against a plan whose rationale was thin and ended on *"should we revert?"* — the
machinery amplifies a plan, it does not validate one.

When the user approves, the next step is `/brief <path to this plan>`.

## Two housekeeping notes

`docs/superpowers/plans/` is where the stock `superpowers:writing-plans` skill writes, and where
colleagues' tooling still writes. It is not ours. Do not detect it, do not write to it, and do not
widen `plan-gate.cjs` to cover it — the gate keys on staged paths, so covering it would demand an
audit of someone else's plan whenever a merge carried one. Plans already sitting there stay there;
nothing is migrated.

88 plan files exist in these repos and almost all of them sit on unmerged feature branches — one
repo had 20 sitting on a feature branch against 6 on `main`. Write the plan on the branch the work
will land on, or commit it to the trunk first, so it is still findable after the branch merges or
dies.
