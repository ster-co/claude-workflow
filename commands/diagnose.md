---
description: Diagnose one bug properly — reproduce it, find the root cause, then fix a simple one test-first or hand anything that needs a decision to /ship.
argument-hint: [the symptom, or a pasted error — whatever you have]
# Side effects: branches, commits, subagent spend. Trigger by typing /name,
# never by the model deciding it looks relevant.
disable-model-invocation: true
# Named /diagnose, not /bug, on purpose. Claude Code has a built-in /bug, and
# in the desktop app typing /bug runs that (it debugs the Claude session)
# instead of this file. Do not recreate commands/bug.md: a branch that still
# edits it or says /bug should carry those edits here and say /diagnose.
# verify-all.cjs fails on any command named after a built-in.
---

Diagnose: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). Root-cause diagnosis, verification
standards and commit hygiene below all assume it. On a checkout with a
`CLAUDE.md` it is already in context; on a plugin install no `CLAUDE.md` reaches the
session, so this is the point where `/diagnose` pulls it back in.

## Why this command exists

Bug reports are measurably the worst bucket in this user's history: **51 % of them land zero
commits** (features: 44 %), **1.44 commits per active hour** (features: 2.24), and the highest
interrupt rate of any bucket. Three failure modes account for most of it, and all three are
preventable in the first two minutes.

## Step 0 — before any diagnosis, resolve these three. Ask if you cannot infer them.

1. **Which environment?** local · local against TST resources · TST · ACC · production.
   **Six of ten bug sessions turned on this and not on the code.** `1d5527f6` t37:
   *"hold on / the tenant you are thinking about is the expensive paid acc production /
   i want to do tst first"*.
2. **One symptom, not two.** If the report contains two independent problems, say so and pick
   one. `4ffa13a8` bundled a mystery project id with a navigation reset: 245 turns, 0 commits,
   neither closed.
3. **What is the observable, and what was expected?** If all you were given is a pasted
   traceback with no question attached, ask what the user was doing and what they expected.
   That opener shape reliably produces a long diagnostic essay and 20+ turns of steering —
   `e8c66b13` (408 turns, 30 messages, 0 commits), `3d5a6e20`, `0774e702`, `632571f2`.

## Then

4. **Invoke `superpowers:systematic-debugging`** and follow it.
5. **Reproduce it yourself before theorising.** Run the thing in the repo's own venv. The
   worst diagnostic loop in the corpus (`005ba552`: 34 Bash calls for one edit) was three
   distinct root causes discovered one at a time, each only after the user pasted the next
   failure — it ends *"ffs / just try the whole thing yourself to see what goes wrong until
   you get it right"*.
6. **Look up what references the suspect symbol before editing it** —
   `mcp__serena__find_referencing_symbols` — and report what depends on it. `0c0627cb`
   burned 75 turns on a question one such lookup answers. The edit gate enforces this in
   Serena-configured repos, but do it because it saves the 75 turns, not because a hook
   asks. Remember that no tool resolves a string reference: grep as well wherever one is
   plausible.
7. **Find the root cause, not the symptom.** State the mechanism in one sentence and say what
   evidence proves it. If you are about to patch where the error surfaced rather than where it
   originated, say so explicitly and let the user choose.
8. **Audit the diagnosis before you write anything against it — when you inferred it.**

    Dispatch `root-cause-auditor`. Give it the symptom, the mechanism in one or two
    sentences, and the evidence. **Not the diagnostic conversation** — it exists to find a
    second explanation, and reading how you reached the first makes it inherit your
    premises and agree with you.

    **When to dispatch: did you *observe* the mechanism, or *infer* it?** Not size. If you
    reproduced the bug and watched the cause happen, an adversary has little to attack. If
    the mechanism is an inference that fits the evidence, that is exactly when a second
    explanation also fits. Size is handled at step 9 — anything bigger than a simple fix
    goes to `/ship`, where `plan-auditor` fires on the plan.

    The condition above is reasoning, not measurement. **For the first five real bugs,
    dispatch it regardless** and note what it returned; a trigger cannot be calibrated
    against data that does not exist yet. If it also finds things on directly-observed
    causes, drop the condition and always dispatch.

    On ALTERNATIVES: run the discriminating check it names before proceeding. That check is
    the point — it is usually one command, and it is cheaper than a fix aimed at the wrong
    mechanism.

    Why this exists: a diagnosis in this session claimed a gate was broken, on the evidence
    of an empty state directory and two real quirks in the hook's code. The actual cause was
    that the hook had been wired after the session started and was never loaded — the code
    was fine. Absence of evidence fits every explanation that never ran, and nothing in the
    loop was looking for the boring one.

9. **Triage the fix: simple, or a decision.** A simple fix goes ahead here without stopping.
   Anything else is handed to `/ship` — see **Handing to `/ship`** below — and this command
   ends there. The fix is **simple** only when all four hold:

    - **The mechanism is settled** — you watched it happen, or `root-cause-auditor` returned
      CONFIRMED, or the discriminating check it named came back your way.
    - **There is one reasonable fix.** No behaviour, data, product or UX trade-off between
      alternatives that the user would want to choose between.
    - **It is small** — one module, no schema or migration, no change to a public interface
      or a config contract, no second repo.
    - **Applying it touches nothing but local** — no deploy, no write to TST, ACC or
      production.

    Two cases are neither track. A mechanism that is **not settled** — the auditor's
    discriminating check went against you — goes back to step 7; handing `/ship` an
    unproven root cause builds a plan on it. A root cause that is **configuration or ops**
    rather than code stops here, per the Report below.

    **When in doubt, hand it off.** A stop costs one message; a fix aimed at the wrong
    decision costs the session. Before the simple track's first edit, say in one line what
    you are about to change and where, so the user can interrupt without being asked to.

    Why the split: `/diagnose` used to go from diagnosis straight into the fix, and only reached
    for `/blueprint` when it judged the fix architectural. In practice that judgement rarely
    fired — a real run (`f2346a9e`) diagnosed, branched, changed approach mid-fix, renamed
    its branch twice and opened a PR without the user choosing anything. Simple fixes still
    go straight through; everything else gets `/ship`'s gates.

The simple track:

10. **Branch before you fix.** Put the fix on its own branch, in a worktree of its own,
    forked from the freshly fetched base — the same way `/ship` makes its work branch:

    ```
    git rev-parse --abbrev-ref HEAD
    git fetch origin
    git log --oneline origin/<base>..<base>
    git worktree add ../<repo>-<kebab-summary> -b bugs/<kebab-summary> origin/<base>
    ```

    The first command prints the branch the window is on — call it `<base>`; `/land` at the
    end needs it. Fetch before forking so the fix starts from what the remote has now, not
    from whenever this checkout last pulled. The `git log` lists commits on the local
    `<base>` that the remote does not have: if it prints any, stop and ask whether the fix
    should include them rather than silently dropping or keeping them. If `origin/<base>`
    does not exist (a branch never pushed), fork from `<base>` itself.

    Work in that worktree for the rest of the fix, so the user's checkout stays where it
    was. If it needs a `.env`, symlink the main checkout's rather than copying it. If
    `bugs/<kebab-summary>` already exists, stop and ask; do not append a suffix.

    Diagnosis needs no branch — reproducing and reading code changes nothing. Create it at
    the point the first edit is about to happen, and not before, so a bug that turns out to
    be configuration leaves no stray branch behind.
11. **Write the failing test first.** Run it, watch it fail *for the right reason*, then fix,
    then run it again. A regression test that never failed proves nothing.
12. **Finish with `/land`**, opening the PR against `<base>` (noted in step 10) rather than
    the repo default.

## Handing to `/ship`

`/diagnose` cannot invoke `/ship` — both are typed by the user only — so the hand-off is the run
state: `/diagnose` starts the run at `/ship`'s direction gate and stops, and the user's
`/ship <n>` picks it up from there. Everything after that is `/ship`'s: the plan, its audit,
the approval gate, a `bugs/` branch in its own worktree, briefs, `/land`.

1. **Write the diagnosis to `docs/plans/YYYY-MM-DD-<kebab-summary>.md`.** That file becomes
   the plan; `/ship` writes the rest of it below these two sections, so a resume after a
   crash or `/clear` has the diagnosis on disk rather than in a lost conversation.

    ```
    # <one-line title>

    ## Diagnosis

    - **Environment:** …  **Observed:** …  **Expected:** …
    - **Mechanism:** one sentence.
    - **Evidence:** the commands and their output, with file:line.
    - **root-cause-auditor:** CONFIRMED | ALTERNATIVES, and the check that settled it.

    ## Fix approaches

    1. … — trade-offs, and what it forecloses.
    2. …

    **Recommended:** n, because …
    ```

    Do not commit it. The plan gate refuses a `docs/plans/` file until `plan-auditor` has
    audited it, and that audit belongs to the finished plan, not to this half of it.

2. **Start the run, parked at the direction gate:**

    (This command's hook scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path
    reads as a real absolute path here — installed as a plugin — use it everywhere
    this file says `~/.claude/hooks`; if it still reads as the literal placeholder
    — running from a `~/.claude` checkout — use `~/.claude/hooks` as written.)

    ```
    node ~/.claude/hooks/run-state.cjs start --feature <kebab-summary> --phase awaiting-direction
    node ~/.claude/hooks/run-state.cjs phase awaiting-direction --plan docs/plans/<file>.md
    node ~/.claude/hooks/run-state.cjs branch --base <branch the bug was found on>
    ```

    `start` binds this chat to the run, which is what lets the next `/ship <n>` here read
    as the answer to the gate rather than as a new idea.

3. **Stop.** Print the mechanism in one sentence, the numbered approaches with your
   recommendation, and the base you recorded so a wrong one is caught before anything is
   built on it. Say that `/ship <n>` **in this chat** picks an approach — the run is bound
   to this chat, so from any other chat a bare `/ship` shows the runs table to pick it from
   first. Change no code.

## Report

Mechanism in one sentence → the evidence → the fix → the test that failed before it and passes
after, with literal output. On a hand-off, the report is step 3 of **Handing to `/ship`**
instead: there is no fix yet to report. If the root cause turns out to be configuration or ops
rather than code, say that and **stop before changing code**.
