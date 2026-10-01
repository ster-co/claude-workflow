---
description: Probe or audit a target along adversarial axes — security, correctness, operational excellence, idempotency, reliability, performance, cost.
argument-hint: "[target: working tree, diff, branch, merge commit, path, subsystem, or repo] [axes, optional]"
# Side effects: fans out parallel opus subagents, and on a Correctness finding the
# orchestrator briefly breaks and restores a guard in the working tree (Step 4).
# Trigger by typing /attack, never by the model deciding it looks relevant.
disable-model-invocation: true
---

Attack: **$ARGUMENTS** (if empty, the current branch against its trunk).

## Why

This exact pattern — parallel agents over a completed merge or a standing system, each briefed
to disprove rather than confirm — found **three real defects that a green 2,298-test suite
missed**: a dropped `.gitignore` entry that would have committed verbatim user queries, a tool
returning soft-deleted rows that the prompt treats as outranking ground truth, and a
schema-drift check blind to two migrations while exiting 0 against all three live databases.

A per-commit review had **passed** one of those seven days earlier. It did not exist in any
single commit; it existed in the merged tree. Per-commit review is not a substitute for
whole-tree review, and `/execute`'s per-brief opus reviewer is a per-commit review — so a
`/ship` run that reaches `/land` has never had a whole-tree look.

## Step 1 — Establish the target and the weight, and announce the weight before spending anything

**Target: anything.** A working tree, a diff, a branch, a merge commit, a path, a subsystem, or
the whole repo. Default, unchanged from before this command had a name: the current branch
against its trunk.

For a diff, branch, merge-commit, or working-tree target, establish it concretely before
dispatching anything, using the form that matches the target's shape — do not default to
`HEAD` for a target that is not `HEAD`:

- **current branch** (the default, or a bare `$ARGUMENTS`): `git diff --stat <trunk>...HEAD`.
- **another named branch**: `git diff --stat <trunk>...<branch>` — the diff is against the named
  branch's tip, not the current branch's.
- **merge commit** `<merge>` (two parents): `git diff --stat <merge>^1 <merge>`, or
  `git show --stat <merge>` — first-parent, i.e. what the merge brought onto the branch it
  landed on. `<trunk>...HEAD` would brief the agents on the current branch's diff rather than
  on the merge named in `$ARGUMENTS`, and silently review the wrong thing. An octopus merge
  has no single first parent worth assuming; say so and ask which one rather than guessing.
- **explicit `<base>..<target>`**: `git diff --stat <base>...<target>`, with both ends taken
  from `$ARGUMENTS` and never assumed. Note the deliberate three dots even if two were typed:
  a review wants what the target added since it diverged, not every change the base made
  meanwhile. Say that you widened it.
- **working tree** (uncommitted changes, nothing else named): `git status --short` **and**
  `git diff --stat HEAD`. Not a bare `git diff --stat` — that shows unstaged changes only, so
  anything already `git add`ed is invisible to it, which is the whole of the work on a tree
  someone is part-way through staging. Untracked files appear in no diff form at all, which is
  why the `status` call is not optional.

Whichever form applies, get the file list before dispatching, and include the affected execution
flows in every brief.

Read `$ARGUMENTS`. If it names axes explicitly, use them. Otherwise classify the request into
one of two weights and say in **one line** which weight you picked and why, before doing
anything else:

| weight | triggered by | cost | gate |
|---|---|---|---|
| **Probe** | one axis, narrow target — a file, a function, one feature | one agent, or inline, no fan-out | none — it runs immediately |
| **Audit** | several axes, or a broad target — branch, merge, subsystem, repo | one agent per axis, parallel | proposes an axis set + agent count, then waits |

**The audit gate is not a yes/no.** State the proposed axes and the agent count, then wait. The
answer may edit that set — drop axes, add axes, replace it outright — not merely accept or
refuse it. Forcing an accept/refuse either overpays for axes nobody wanted or makes the user
abandon the run and retype it, and seven axes is exactly where that bites: a full run is seven
opus agents. Where `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is set to 4 — `bin/claude-repo-setup.sh`
writes that cap into `.claude/settings.json` for repos it has been run on — seven agents against
that cap runs in two waves; in a repo without that setting, it fans out however the harness's own
default concurrency allows, which this command does not control or assume. Choosing the axes
*is* the cost control regardless of wave count. A confirmation on the cheap path is friction
that trains the user to click through it, which is precisely the moment the expensive path would
slip past unexamined — so a **probe** never asks, it runs.

The user may override the announced weight ("go deep", "just the one axis"). A probe keeps
everything that makes the fan-out work — disprove rather than confirm, cite `file:line`,
declare what cannot be assessed from source, name what was traded against — and drops only the
parallelism.

If unsure whether a request is a probe or an audit, say which way you are leaning and why in
that one line, rather than silently picking one.

## Step 2 — The axes

Security, Correctness, Operational excellence, Idempotency, Reliability, Performance, Cost.

| axis | what it plausibly trades against | readable from source? |
|---|---|---|
| **Security** | inspection and validation controls add latency and complexity elsewhere | yes, largely |
| **Correctness** | exhaustive checks slow the change down and can crowd out shipping it | partly — a suite's real behaviour cannot be judged without running it |
| **Operational excellence** | more observability and guardrails cost complexity and maintenance | partly — instrumentation and failure handling read from source, but which environment this has actually been exercised against does not |
| **Idempotency** | idempotency keys and dedup add storage and latency to every call | yes, largely |
| **Reliability** | redundancy and retries cost money and can mask a root cause | partly — error rates and saturation need runtime data |
| **Performance** | speed often trades against cost, simplicity, or correctness margins | partly — real latency numbers need runtime data |
| **Cost** | the cheapest option is usually the least reliable or least observable one | partly — actual spend needs billing data |

**The Security axis brief must explicitly name: ignore files, secrets, env defaults, auth
paths, and anything now logged that was not before — including secrets and identifying data in
logs, error messages and telemetry.** There is no separate privacy axis in this command; that
clause is the entire reason it is safe to omit one — losing it loses the coverage.

**The Correctness axis brief must, for the riskiest change in the target, name the test that
would fail if it were wrong and the guard it exercises. If none exists, say so.** The axis agent
only names it and does not sabotage anything itself — it is instructed not to, and it is not
handed `Edit`/`Write` tools, but `Bash` alone would be enough to sabotage if it chose to anyway;
the abstention is instruction and tooling, not a mechanical guarantee. That is exactly why the
`git status --short` check in Step 3 matters: it is the tripwire that would catch a fan-out agent
sabotaging on its own instead of naming what to sabotage, not proof in advance that none of them
can. **The orchestrator performs the sabotage in Step 4**, once the fan-out has completed and the
check has confirmed the tree is unchanged: break the named guard, confirm the named test goes
red, then restore the guard and confirm the suite is green again, before that finding is
reported. A green suite that has never been watched go red on the change it claims to cover has
proven nothing, and a named sabotage that is never actually run proves the same nothing with
extra words.

**The Operational-excellence axis brief must cover migrations, env vars, resource assumptions,
and which environment this has and has not been exercised against.** A change that only ever
ran against a laptop and a mocked dependency is not deploy-ready merely because its tests pass.

**Idempotency is folklore, not a pillar.** It appears in none of the SRE golden-signals
chapter, 12-Factor, or the AWS/Azure/Google Well-Architected pillars. Its authority is Stripe's
idempotency-key docs and the at-least-once delivery literature. It is a good axis. Never present
it as inherited from a framework it is not part of.

Each axis brief must, without exception:
- **name what it plausibly traded against** — nothing is free; say what the tradeoff was;
- **declare what it cannot assess from source**, rather than guessing at a number it does not
  have. "I could not determine X without runtime data" is required output on that axis, not a
  failure of the run.

### The `merge` preset

For a diff-shaped target, `merge` runs Security, Correctness and Operational excellence plus two
diff-only dimensions that do not generalize to a standing system and so are not axes of their
own:

- **Conflict resolutions** — for every hand-resolved file, did the resolution keep both sides'
  intent, or silently drop one?
- **Silent semantic drift** — behaviour that changed without any test noticing: renamed fields,
  changed defaults, dropped filters, altered ordering.

`/attack <branch>` with no axes named runs `merge` against that branch's diff with its trunk.

## Step 3 — Dispatch

**Every brief, probe or audit, carries this verbatim, unchanged from the command this replaces:**
*"Your job is to disprove that this merge is correct. Finding nothing is a failed review.
Re-derive every claim from the files and the raw data — do not restate a conclusion the code or
a document asserts. Cite file:line for every finding."* When the target is not a merge, read
"this merge" as "this target" in the agent's head, but do not reword the brief itself — it is
carried over verbatim because it is evidence-backed, not rewritten to fit each target.

**No agent sees the change's own summary, an implementer's report, or another agent's
findings.** Those are where the work gets described as better than it is, and an agent handed
one inherits the optimism. Each agent reads the target and the raw data itself.

**Snapshot before the fan-out.**

```
git add -A
git stash create "pre-attack"
```

Note the sha it prints; that is the snapshot, call it `<snap>` below. **On an already-clean
tree it prints nothing at all** — in that case use `git rev-parse HEAD` instead and note the
sha it prints. One commit object, working tree untouched, and `git checkout <snap> -- .`
restores it. `git add -A` first, or untracked files are missed; the `HEAD` fallback matters
because treating "printed nothing" as "no snapshot" would make that restore `git checkout --
.`, which is the command that caused the incident.
The axis agents have `Bash`, and on 2026-09-22 a review agent in this estate ran exactly that
and reverted the work it was reviewing.

**Run `git status --short` before and after the fan-out.** This is a tripwire, not a wall: the
axis agents are given `Read, Grep, Glob, Bash` and withheld `Edit`/`Write`, but that only
states intent and tooling — it does not guarantee anything cannot write. `Bash` is itself a
write channel (`sed -i`, `>`, `rm`, `git checkout`, `git reset` are all reachable through it,
and no denylist on a shell holds), so an agent that reaches for it anyway is not actually
stopped by the absence of `Edit`/`Write`. What the `git status --short` check gives you is
detection, not prevention: it runs *after* the fan-out has already had the chance to write, so
if the tree moved, one of them did something it was not asked to do and every verdict from that
batch is void — but anything it destroyed is already gone by the time the check catches it.

## Step 4 — Verify, triage, report

**Verify each finding yourself** against the repo before reporting it. Discard what does not
survive. For a Correctness finding, verification means actually running the sabotage the axis
brief named — break the guard, run the named test, confirm red, then restore the guard and
confirm the suite is green again **and** that `git status --short` is back where it started —
not merely restating that the brief named one. Restore by reverting your own edit, never with
`git checkout -- <file>`: on a working-tree target the file you sabotaged may hold the very
uncommitted work under audit, and checkout would destroy it. If the axis brief reported that no
test covers the riskiest change, there is nothing to sabotage — report that absence as the
finding, which is what it is. Only the orchestrator has Edit or Write access at this point in
the run, which is why this step happens here and not inside the fan-out.

Triage every survivor explicitly — assign severity, and **dismiss with a stated reason, never
silently**. A finding that disappears without a recorded reason is indistinguishable from one
that was never looked at.

**Treat agreement between two agents on the same model as one opinion, not two.** They read the
same target with the same weights; concurrence is close to guaranteed and is not independent
evidence. `EveryInc/compound-engineering#1663` is the worked example: two personas pushed two
findings to *confidence 100*, both **with zero occurrences in the data**, because the code
counted same-model reviewers as independent. Where a finding actually matters, get the second
opinion from a different model or from a held-out test — not from another persona.

**Report ranked by severity, then ask whether to fix or to document. It proposes remedies; it
does not apply them.** Do not fix unprompted.

## The one thing this cannot do

Subagent review chains verify plan conformance, not the product. End with one product-level
check against the running thing, or say plainly that you have not run one.
