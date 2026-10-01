---
description: Fast lane for a small ask — answer, brainstorm, bug or change — inline in one session, no plan, no audit, no subagents except a search scout.
argument-hint: [the question, idea, bug or change — whatever it is]
# Side effects: commits. Trigger by typing /quick, never by the model deciding
# a task looks small — that judgement is this command's own first step, not
# a reason to skip asking for it.
disable-model-invocation: true
---

Quick: **$ARGUMENTS**

**Before anything else, load the `workflow-discipline` skill** (by name — in this
repo it lives at `skills/workflow-discipline/SKILL.md`). The verification standards and
commit rules below assume it. On a checkout with a `CLAUDE.md` it is already in context; on
a plugin install no `CLAUDE.md` reaches the session, so this is the point where `/quick`
pulls it back in.

## Why this command exists

Every other entry point pays for a plan document, an audit, briefs and a reviewer — full
cost even for a one-line change. `/quick` is the fast lane: inline, in this session, no
subagents except `scout` for search.

**"No subagents except `scout`" is a rule for this command, not background colour.** The
`workflow-discipline` skill loaded above recommends a fresh reviewer for anything that
touches code, and that advice is right in general — it does not apply here. `/quick`
overrides it explicitly: the point of this command is doing a small change without paying
for a second agent, and dispatching a reviewer anyway (however tempting for a change that
turns out bigger than expected) reintroduces the exact cost this command exists to avoid.
Read the diff yourself instead — step 2's "change" path already says so.

## Step 1 — Classify. Say which, in one line.

**question · brainstorm · bug · change**

If it does not obviously fit one, or fits two at once, say so and pick one — do not run two
paths in the same turn.

## Step 2 — Follow exactly one path.

- **question** → answer it from a command or a file read. Use `scout` if you need to locate
  something first. No edits.
- **brainstorm** → put up 2 options and a recommendation, in 10 lines at most. No edits.
- **bug** → reproduce it, fix it, verify it. No `root-cause-auditor` — if the cause will not
  reproduce, that is the escalation condition below, not a reason to theorise further.
- **change** → edit it, run the tests related to the change (plus a new regression test when
  behaviour changes, not just prose or config), read the diff yourself, then commit. "Related"
  means the repo's fast command where one is written down — a brief file's House rules
  `Tests (fast):` line, or the repo's own `CLAUDE.md` — and otherwise the test files next to
  what you changed. The full suite is not part of `/quick`.

Print one status line per step, so a wrong turn is visible before the next one starts.

## Step 3 — Escalate instead, when any of these holds

**Estimate before you edit anything**, not after: read enough of the change to guess the
file count and line count, then decide whether this fits `/quick` before touching a file.
Discovering the threshold after half the edits are made is the failure this step exists to
prevent — starting the estimate late does not make the change any smaller.

The work fits `/quick` at **at most 5 files and about 80 changed lines of behaviour-bearing
code** — tests, docs and generated files do not count, because they carry no behaviour risk —
with no design call, **no change to a gate, permission or auth check** (or anything else that
decides whether something runs), a cause that reproduces, and no `Serial:`-class resource.
Size is only a proxy; a one-character slip in a gate silently disables a check, so a gate
escalates at any size.

Stop and name `/diagnose` or `/ship` — do not push further into this session — when any of
these holds:

- **more than 5 files or about 80 changed lines of behaviour-bearing code**;
- **a change to a gate, permission or auth check**, or to anything that decides whether
  something else runs — at any size;
- **a design call** — more than one reasonable approach, or a trade-off the user should pick;
- **a cause that will not reproduce**;
- **a `Serial:`-class resource** — a deploy, a migration, a production tenant, or anything
  else shared outside this checkout.

Say which threshold fired and what you found so far. Do not manufacture a smaller version of
the ask to stay inside `/quick`.

**If the threshold is crossed mid-change** — the estimate was wrong, or the fix grew once
you were inside the code — stop editing at that point. **Leave whatever edits already exist
in the working tree uncommitted**; do not revert them (they are evidence of what was tried
and may be exactly right) and do not commit them (that would land a change `/quick` never
finished evaluating). Report which files were touched and what state they are in, then name
`/diagnose` or `/ship` to pick the work up with the process it now needs.

## Commit

- **On the default branch**, create `quick/<kebab-summary>` and commit there.
- **On any other branch**, commit on the current branch.
- **Never push.**
- No AI attribution in the commit message.

## Report

One status line per step already printed above. Close with: what changed, the test command
and its exit code, and the branch and commit sha. On escalation caught before any edit,
close with the one line naming `/diagnose` or `/ship` and why, and change no code. On
escalation caught mid-change, close the same way but also list the files left uncommitted
and their state — see Step 3.
