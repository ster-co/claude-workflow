---
description: One entry point from idea to merged PR. Stops twice — once to choose a direction, once to approve the plan — then briefs, executes and lands unattended.
argument-hint: [what to build — later calls answer whichever gate is open, or resume with nothing]
# Side effects: branches, commits, subagent spend. Trigger by typing /name,
# never by the model deciding it looks relevant.
disable-model-invocation: true
---

Ship: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). This command assumes that discipline is
already ambient — on a checkout with a `CLAUDE.md` it is — but a plugin install has no
`CLAUDE.md` reaching the session, and this is the one place `/ship` can pull the rules
(autonomy, verification standards, root-cause diagnosis, subagent delegation, planning
non-trivial work, commit hygiene) back in on invocation.

**`--unattended`, if it is the leading token of `$ARGUMENTS`:** this turn only launches an
unattended loop and stops — it does not fall through to Step 0 or any phase logic below.
Run `node ~/.claude/bin/ship-loop-launch.cjs` with the rest of `$ARGUMENTS` passed through
as flags (for example `/ship --unattended --model fable --plan-model haiku` runs
`node ~/.claude/bin/ship-loop-launch.cjs --model fable --plan-model haiku`) — resolved the same
way `~/.claude/hooks/run-state.cjs` is below: `${CLAUDE_PLUGIN_ROOT}/bin/ship-loop-launch.cjs`
when `CLAUDE_PLUGIN_ROOT` is set, `~/.claude/bin/ship-loop-launch.cjs` otherwise. The script
lives under `~/.claude`, not under the project being shipped, so it must never be run as a
path relative to the project's own working directory. That script checks the run
is ready to proceed without the user (clean tree, on the run's branch, past any gate that
needs a decision — or this project's `CLAUDE.md` declares standing approval — and usage
below its pause threshold), refuses and prints which check failed if not, and on success
writes `.ship-loop/feature` and `.ship-loop/pass-prompt.md`, excludes `.ship-loop/` from
the worktree, and starts `bin/ship-loop.cjs` detached — one fresh `claude -p "/ship"`
session per unit of work, re-entering this command's own phase logic one step at a time,
until it hits a stop condition. Report the PID and log path
(`.ship-loop/log.md`) it prints, and stop this turn. To stop a launched loop after its
current pass: `touch .ship-loop/STOP`.

`/ship` is one command run more than once. It reads `phase` from
its own run out of `~/.claude/state/` and does whatever comes next. The run stops twice
for the user — once to choose a direction, once to approve the plan — and each `/ship`
after the first either answers whichever of those two gates is open or resumes the run
where it left off.

**Step 0, always, before anything else:** `node ~/.claude/hooks/run-state.cjs get`.

(This command's hook scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path reads
as a real absolute path here — installed as a plugin — use it everywhere this file says
`~/.claude/hooks`; if it still reads as the literal placeholder — running from a
`~/.claude` checkout — use `~/.claude/hooks` as written.)

If it prints a run with a `feature`, that is this chat's run and its `phase` decides
which section below applies. If `feature` is `null`, this chat is not driving a run
yet — **do not guess one.** Several runs can be live in one checkout at once, and a
bare `/ship` picking whichever it finds is how a chat resumes work that belongs to
another. Instead:

```
node ~/.claude/hooks/run-state.cjs table
```

Show that table, ask which run, and record the answer with
`node ~/.claude/hooks/run-state.cjs current <feature>`. It is remembered for the rest
of this chat, so you ask once. A run whose branch is marked `(gone)` is the one dead
state worth offering to drop; everything else is just old.

Do not infer the phase from the conversation: after a crash or a `/clear` the
conversation is gone and the run is not, which is the whole reason it is on disk.

| `phase` | do this |
|---|---|
| no state file, or `finishedAt` set | **Start** — below |
| `awaiting-direction` | resume at **Gate 1** under Start — the argument (if any) is *read*, not assumed to be assent; if the approaches are still on record in this chat, re-print them and wait, if not, re-derive them (re-run brainstorming) before asking again — unless `planFile` has a `## Diagnosis` section, in which case the run came from `/diagnose` and its approaches are in that file (see **Arriving from `/diagnose`**) |
| `planning` | resume planning — writing or auditing the plan doc — where it stopped |
| `awaiting-approval` | bare `/ship` **is** approval — go to Execute; an argument is *read* at that gate per rule 3, not assumed to be approval |
| `executing` | resume Execute at `currentBrief`, on the run's own `branch` |
| `landing` | resume Land |

**On any resume, check you are on the run's branch** — `git rev-parse --abbrev-ref HEAD`
against `branch` in the state — and switch back if not. A resumed run that commits onto
whatever branch the window happened to be left on scatters one feature across two.

**Argument precedence.** Step 0's table above and the checks below can each match a
non-empty `$ARGUMENTS` — answering Gate 1 (below) *is* a non-empty argument, and until
this rule was written down nothing said which wins. Fixed order, confirmed with the
operator on 2026-09-22:

1. **No argument** → resume this chat's run per the table above. If no run is bound to
   this chat, print `table` and ask which — never guess.
2. **An argument naming a file that exists** → it is a plan, not an idea, regardless of
   phase. Record it and stop at the approval gate, exactly as if `/ship` had written it:

   ```
   node ~/.claude/hooks/run-state.cjs start --feature <short-kebab-name>
   node ~/.claude/hooks/run-state.cjs phase awaiting-approval --plan <path>
   ```

   Then print the plan's path, a summary of at most five lines, and the question. The
   user's next `/ship` answers that gate — bare, it is the approval; with an argument it is
   read per rule 3 below, not assumed to be one. Skip `/blueprint` entirely — re-planning an
   approved plan produces a second plan document and a second audit, not progress.
3. **An argument on a run whose `phase` is `awaiting-approval` or `awaiting-direction`**
   → it is *read* as the answer to that gate, not assumed to be one, and never a new
   idea. **Read it before acting on it.** An answer that assents — approves the plan, or
   names one of the approaches on offer — advances the phase, exactly as described under
   Execute or Gate 1 below. An answer that does *not* assent — an objection, a
   correction, a change of direction, anything short of clearly picking an approach or
   clearly approving the plan — is feedback on what is already on the table, and it does
   **not** advance the phase. The run stays at the gate, or drops back a step, until an
   assenting answer arrives. Either way, handle it where that phase is handled — Execute
   for `awaiting-approval`, Gate 1 under Start for `awaiting-direction` — and do not start
   a second run.

   **The tie-break, for an input that both assents and corrects** — *"yes, but use
   approach 2"*, *"approve it, though the budget looks wrong"*. Assent and correction are
   not mutually exclusive and the two clauses above can both match: the phase decides which
   reading is even available, and at `awaiting-approval` an input naming an approach
   satisfies the assent clause while plainly not being an approval. **When in doubt, do not
   advance.** Treat it as feedback, answer the correction, and stay at the gate until an
   answer arrives that is only assent. A gate held one turn too long costs a message; a
   gate advanced on a misread costs the run.
4. **Any other non-empty argument** → starts a NEW run, whatever else is unfinished.
   Runs are per feature now, so two of them no longer collide — the refusal that used
   to live here was a consequence of the single-file layout, not a rule worth keeping.

Rules 3 and 4 cannot both match the same input: rule 3 is keyed on *this chat's current
run's phase*, checked first; rule 4 is only the fallback for whatever rule 3 did not
claim. When Step 0 found no run bound to this chat, rule 3 has nothing to test against,
so rule 4 is what applies — an argument typed with no run yet bound always reads as a
new idea, never as a gate answer nobody could have been waiting on.

---

## Start

Run `/blueprint` on `$ARGUMENTS` and follow its triage exactly. `/blueprint` decides between
three outcomes and you do not override it. Before doing anything else, print which one
it picked — "do it now", "iterate in a browser", or "really plan" — so a silently-skipped
triage is visible to the user; this is a reporting requirement only, not one a hook can
check, since "do it now" is exactly the outcome that creates no run state for a hook to
find:

**One gate, and it is this one.** `/blueprint` has its own direction gate at its Step 2.5.
Inside a `/ship` run **that stop does not fire** — `/ship` owns it, as Gate 1 below,
because `/ship` is what holds the run and its phase and is therefore the only one of the
two that can record `awaiting-direction` and be resumed at it. Take `/blueprint`'s Step 2
approaches, carry them to Gate 1, and stop there once. `/blueprint`'s Step 2.5 applies when
`/blueprint` is typed directly, with no run behind it. Do not stop twice, and do not skip
Gate 1 on the grounds that `/blueprint` already asked.

- **Do it now** — a small, obvious change: at most 3 files, about 30 changed lines, no
  design call, a cause that reproduces, and no `Serial:`-class shared resource. Do it,
  verify it, and stop. Do **not** create a run state, do not write a plan doc, do not brief
  it. Manufacturing five briefs for a one-line fix is the most expensive failure this
  command can have. `/quick` is this same lane typed directly, without going through
  `/blueprint`'s triage first — reach for it by name when you already know the ask is this
  small.
- **Iterate in a browser** — visual or taste-driven work. Run the app, drive it, iterate.
  Plans are the wrong artifact here; `/blueprint` says so and it is right.
- **Really plan** — anything else. Continue below.

For the third case only:

```
node ~/.claude/hooks/run-state.cjs start --feature <short-kebab-name> --phase awaiting-direction
```

That sets `phase: awaiting-direction` — the run exists and no approach has been chosen yet.
On a *fresh* run no plan document exists either; on a run that **dropped back** here from
`awaiting-approval` because the approach was rejected, `planFile` still names the plan written
under the old approach. Treat that document as superseded, not as the plan — the next approach
gets its own. The one exception is a run `/diagnose` started, whose `planFile` holds the diagnosis
from the start; see **Arriving from `/diagnose`**. **Ask what this run should be based on**, defaulting to
the branch the user is on, and record it with
`node ~/.claude/hooks/run-state.cjs branch --base <branch>` once the branch is made.
Asking is not optional now that several runs share one checkout: the user stays on one
branch while driving runs that belong on others, so where they are standing says
nothing about where the work goes. Several runs may share one integration branch as a
base, and each opens its PR against it.

Then brainstorm through `/brainstorm` — two or three approaches with
trade-offs and a recommendation, not one plan presented as inevitable. Say which you
recommend and why, and what each one forecloses. `/brainstorm` stops at the
recommendation and writes nothing, which is the point: the raw brainstorming skill
would go on to commit a spec of its own and invoke `writing-plans`, and the plan doc
here is `/blueprint`'s.

### Gate 1 — direction

Print the approaches **numbered**, with trade-offs and your recommendation, and ask which
one. Number them because the answer may come back as bare `/ship 2`.
**Stop.** Nothing has been built against the answer yet, so this is the cheapest point in the
whole run to change course — a wrong call here costs one conversation, the same wrong call
caught at brief 9 costs the whole run.

**Resuming here:** Start already set this run's phase to `awaiting-direction`, so per
the argument precedence above, the next non-empty `/ship <answer>` on this run is *read*
as the answer to this gate (rule 3) — never assumed to be one. If it clearly names one
of the approaches on offer, take that approach and continue below. If it does not — an
objection, a change of direction, or anything that is not a selection — that is feedback,
not a choice: fold it in, re-brainstorm or narrow the approaches, print the (possibly
revised) list, and stop again. A bare `/ship` (rule 1) means the operator has not
answered yet. If the approaches brainstormed above are still on record in this chat, re-print
them and wait again; the run's state records only the phase, not the approaches
themselves, so a chat that resumes this run without that history (after a crash or
`/clear`) has nothing to re-print — re-run brainstorming first, then print what it turns
up and wait.

**Skippable, but not silently.** Continue straight to the plan doc, without stopping,
only when you do all three of these in the same turn:
1. print the approaches;
2. name the chosen one and the reason, in the same message;
3. write one line into the plan document (below) saying the gate was skipped and why.

This mirrors the plan's own `## Known defects — accepted` pattern: the shortcut is
allowed, but it leaves a trace instead of vanishing, so how often it fires can be
counted later — from the plan docs — rather than assumed. If the skip becomes the
normal path, the gate has failed; that is what the trace is for.

The run state does **not** record this skip. `run-state.cjs`'s `normalise()` only
carries fields declared in `blank()`, `directionGate` is not one of them, and a field
written out-of-band would be silently dropped by the very next `phase` call — a record
that cannot survive one call is not a record. The plan-doc line above is the only
durable trace. Restoring a state-file record would need `blank()`/`normalise()` in
`run-state.cjs` to learn the field first; that is a separate change, not made here.

### Arriving from `/diagnose`

`/diagnose` hands a fix that needs a decision to `/ship` by starting the run itself, parked at
`awaiting-direction`, with `planFile` pointing at a document that holds a `## Diagnosis`
section and a numbered `## Fix approaches` section, and the base already recorded. The user
answers with `/ship <n>`. Everything in Gate 1 above applies, with three differences:

- **The approaches are in the file.** On a resume without them in the chat, re-print the
  file's `## Fix approaches` rather than re-brainstorming — brainstorming from the symptom
  alone throws away the reproduction and the audited root cause.
- **The plan goes into that same file,** below the two sections, which stay: the diagnosis
  is the plan's context and the approaches record what was rejected. On a drop-back the
  diagnosis still stands; only what was written below it is superseded.
- **The work branch takes the `bugs/` prefix** in Execute.

A `## Diagnosis` section that `plan-auditor` finds false is a defect in the plan like any
other: the root cause is exactly the claim a fix is built on.

Either way — answered or skipped — continue:

```
node ~/.claude/hooks/run-state.cjs phase planning
```

and write the plan doc to `docs/plans/YYYY-MM-DD-<topic>.md` — or, on a run from `/diagnose`,
into the diagnosis file `planFile` already names. The plan must carry what
`/blueprint` requires, including the **Decisions — do not re-litigate** and
**Out of scope — deliberately** sections, and, if Gate 1 was skipped, the line recording
it.

Then:

```
node ~/.claude/hooks/run-state.cjs phase awaiting-approval --plan docs/plans/<file>.md
```

**Stop.** Print the plan path, a summary of at most five lines, and one question: whether
to proceed. Say that `/ship` with no argument resumes.

This run waits for the user at two points — direction, then approval. Approval never
skips; Gate 1 may, under the three conditions stated there, and only leaving the trace
those conditions require. Each gate is the cheapest place to catch its own kind of wrong
call: a wrong direction costs one conversation here; caught at brief 9 it costs the whole
run.

Do not start briefing because the plan looks obviously right. Approval is a fact on the
transcript, not a judgement you make on the user's behalf.

---

## Execute

Reached when the phase is `awaiting-approval` and the answer **assents** — a bare
`/ship` (rule 1: no argument at this gate is approval, unchanged from before this gate
existed) or an argument that plainly approves ("yes", "approved", "go", "ship it") — per
rule 3 above. Also reached directly on a resume when the phase is already `executing`.

**Arrival at this gate is not approval by itself.** If `$ARGUMENTS` raises an objection,
a correction, or a change of direction instead of agreeing, read it as exactly that —
not as assent — and do **not** run `phase executing`. Instead:
- if it corrects or extends the plan without changing the chosen approach, revise the
  plan document and stop again at `awaiting-approval` with the updated summary and the
  same question;
- if it rejects the approach itself, drop the phase back
  (`node ~/.claude/hooks/run-state.cjs phase awaiting-direction`) and re-open Gate 1
  with the objection folded in.

Nothing below this point runs unless the answer was assent:

```
node ~/.claude/hooks/run-state.cjs phase executing
```

**Then make the work branch, before the first brief.** `/ship` always creates one, so it
never matters which branch you were standing on. The alternative — a list of "protected"
branch names to refuse — is a local accident that fits exactly one repo and silently
fails to protect every other.

The run already knows its base — it was asked for at Start and is in the state. Make
the branch in a worktree of its own, so runs executing at the same time are not fighting
over one working tree, and so the user's checkout stays on whatever branch they like:

```
node ~/.claude/hooks/run-state.cjs get
```

Read `baseBranch` out of the JSON it prints, and use that value directly wherever `<base>`
appears below — do not assign it to a shell variable, which only `sh` understands and
PowerShell does not:

```
git fetch origin
git log --oneline origin/<base>..<base>
git worktree add ../<repo>-<kebab-name> -b <prefix>/<kebab-name> origin/<base>
node ~/.claude/hooks/run-state.cjs branch <prefix>/<kebab-name>
```

Fetch before forking so the work starts from what the remote has for `<base>` now, not
from whenever this checkout last pulled — the base is often an integration branch other
runs are landing on. The `git log` lists commits on the local `<base>` that the remote
does not have: if it prints any, stop and ask whether the run should include them rather
than silently dropping or keeping them. If `origin/<base>` does not exist (a base never
pushed), fork from `<base>` itself.

Work in that worktree for the rest of the run. If it needs a `.env`, symlink the main
checkout's rather than copying it.

The prefix follows what the work is, matching the command that would have produced it:

| the work is | prefix | example |
|---|---|---|
| a feature, a change, anything from `/blueprint` | `feature/` | `feature/descriptor-shortcut` |
| a defect with a reproduction — always so when `/diagnose` handed it over (`planFile` has a `## Diagnosis` section) | `bugs/` | `bugs/anchor-ordering` |
| an experiment you may well throw away | `spike/` | `spike/jev-classification` |

The base is whatever Start recorded. Do not substitute the default branch and do not
re-derive it from HEAD: with several runs driven from one checkout, the branch the user
happens to be standing on is unrelated to where this run's work belongs. If Start did
not record one, ask — do not guess.

On a resume `branch` is already set; `git switch` to it rather than creating another. The
`run-state.cjs branch` call refuses a *different* branch on an unfinished run, which is
the backstop — but do not rely on the backstop, check first.

If `git worktree add -b` fails because the branch already exists, that is a collision with an
earlier abandoned run. Stop and ask; do not append a suffix and carry on.

1. **`/brief`** against the approved plan, unless `briefFile` already lists briefs for
   this feature — on a resume it will, and re-briefing would renumber work that is
   already committed. `/brief` verifies the real test baseline before writing anything;
   if the baseline it measures disagrees with the plan's, stop and say so.
   `/brief` ends by printing an opener; that opener is not a stopping point here. Go
   straight on to step 2 in the same turn.

2. **`/execute`**. It owns the per-brief loop — implementer, reviewer, the two-rejection
   debugger escalation, commit, mark done — and its six termination conditions are
   `/ship`'s too. Do not reimplement any of that here and do not add a seventh condition.

   For an unattended run, set the `/goal` condition documented in `execute.md` first.
   `/goal`'s evaluator sees only the transcript, so keep printing test counts, verdicts
   and commit lines.

3. If `/execute` stops for any reason other than "every brief done or blocked", **stop
   here**. Report which condition fired and what is left. Do not advance the phase: a
   blocked run that walks into landing pushes a branch nobody has finished.

---

## Land

```
node ~/.claude/hooks/run-state.cjs phase landing
```

Follow `/land`: verify, read the diff, commit anything outstanding. Before pushing, ask once
whether to run `/attack` on this branch first — whatever review it has had was per-commit, and
nothing has looked at the merged tree. A "no" costs nothing: move straight to push. On a yes,
say `/attack <branch>` and stop; `/attack` is not model-invokable, and that is deliberate.
Then push, open the PR against `baseBranch` from the run state — the branch the work actually forked from, not the repo default. **Never
merge it unprompted.** Then:

```
node ~/.claude/hooks/run-state.cjs finish
```

which clears the phase and stamps `finishedAt`, so the next session's `SessionStart` hook
stops offering to resume a run that is over.

---

## Report

A table: brief → commit → test result → anything you deviated from and why. Then the PR
link.

Then, separately and in your own words, the distinction that matters most:

> **the briefs were executed as written** is not **the thing works**.

You may only assert the second if you drove the running product yourself. If you did not,
say which one product-level check the user should do, and name the URL or command.

Subagent chains verify conformance to a brief, never the product. In the reference
sessions every agent reported success while the feature was visibly broken — *"state
persistence is not working, all agents claimed to have finished."* A `/ship` run that ends
with a green table and an untested product has reproduced exactly that.
