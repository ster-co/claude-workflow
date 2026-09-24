---
description: Diagnose one bug properly — reproduce it, find the root cause, prove the fix with a test that failed first.
argument-hint: [the symptom, or a pasted error — whatever you have]
# Side effects: branches, commits, subagent spend. Trigger by typing /name,
# never by the model deciding it looks relevant.
disable-model-invocation: true
---

Bug: **$ARGUMENTS**

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
8. **Size the fix before writing it.** If the root cause needs a subsystem change, a migration,
   or work spanning several files or repos, **stop and run `/plan`** — do not grind it out inline.
   A bug whose fix is architectural is a planning job wearing a bug's clothes, and bug sessions
   already land zero commits 51 % of the time.
9. **Audit the diagnosis before you write anything against it — when you inferred it.**

    Dispatch `root-cause-auditor`. Give it the symptom, the mechanism in one or two
    sentences, and the evidence. **Not the diagnostic conversation** — it exists to find a
    second explanation, and reading how you reached the first makes it inherit your
    premises and agree with you.

    **When to dispatch: did you *observe* the mechanism, or *infer* it?** Not size. If you
    reproduced the bug and watched the cause happen, an adversary has little to attack. If
    the mechanism is an inference that fits the evidence, that is exactly when a second
    explanation also fits. Size is already handled at step 8 — anything subsystem-sized
    goes to `/plan`, where `plan-auditor` fires.

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

10. **Branch before you fix.** Once the root cause is known and the fix is small enough to do
   here, put it on its own branch rather than on whatever branch the window was left on:

    ```
    git rev-parse --abbrev-ref HEAD
    git switch -c bugs/<kebab-summary>
    ```

    Note the branch name the first command prints — call it `<base>` — before switching off
    it; `/land` at the end needs it.

    Diagnosis needs no branch — reproducing and reading code changes nothing. Create it at
    the point the first edit is about to happen, and not before, so a bug that turns out to
    be configuration leaves no stray branch behind.
11. **Write the failing test first.** Run it, watch it fail *for the right reason*, then fix,
    then run it again. A regression test that never failed proves nothing.
12. **Finish with `/land`**, opening the PR against `<base>` (noted in step 10) rather than
    the repo default.

## Report

Mechanism in one sentence → the evidence → the fix → the test that failed before it and passes
after, with literal output. If the root cause turns out to be configuration or ops rather than
code, say that and **stop before changing code**.
