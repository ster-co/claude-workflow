# What each command does

A plain-language guide for someone new to this setup. `docs/CHEATSHEET.md` is the one-page
"what to type"; `README.md` explains how the machinery works.

**If you remember one thing:** type `/ship` to build something, `/diagnose` when something is
broken, `/brainstorm` when you don't know what you want yet.

---

## `/ship` — the front door for building anything

**Use when:** you want something built and landed as a PR.

**How it works:** `/ship` is a conductor. It runs the other commands in order and keeps track of
where it is:

```
/ship "idea"
  ├─ /blueprint  sort the work, brainstorm approaches (runs /brainstorm),
  │              write and audit the plan
  │     ⏸ you pick a direction
  │     ⏸ you approve the plan
  ├─ /brief      split the plan into numbered briefs
  ├─ /execute    build each brief: implementer → reviewer → commit
  └─ /land       verify, push, open the PR   (offers /attack first)
```

**It stops for you twice, and only twice:**
- **Direction** — pick one of two or three approaches.
- **Approval** — approve the written plan. After that it runs on its own until the PR is open.

At the start it also asks which branch the work should be based on (default: the one you are
on).

**It works on its own branch.** It opens a dev branch in a separate worktree, forked from a
freshly fetched base, so your checkout stays on whatever branch you like and several runs can
be live in one repo at once.

**Small work skips the machinery.** `/blueprint`'s first step sorts the request:
- **Small, obvious change** → just done. No plan, no briefs, no run.
- **Visual or taste-driven** → iterated in a browser, not planned.
- **Real feature** → the full chain.

**It never merges.** The final report separates *"the briefs were executed as written"* from
*"the thing works"*, and names the one check you should do on the running product.

### What to type

`/ship` is one command typed more than once. What it does depends on what you give it and on
whether this chat is already driving a run:

| You type | When | What happens |
|---|---|---|
| `/ship <idea>` | Any time | **Starts a new run**, even if other runs are unfinished — each feature is its own run. A small change is just done on the spot and creates no run. |
| `/ship <path to a plan file>` | You already have a plan, e.g. from `/blueprint` | **Skips planning.** Records the plan and stops at the approval gate. |
| `/ship` | This chat is driving a run | **Continues it.** At the direction gate: re-prints the approaches and waits. At the approval gate: counts as your approval. Mid-build: resumes at the current brief, on the run's own branch. |
| `/ship` | This chat is not driving a run — a new chat, or one where you never typed `/ship` | **Shows a table** of the unfinished runs in this repo and asks which one. It remembers your answer for the rest of the chat. It never guesses. |
| `/ship <answer>` | The run is waiting at a gate | **Read as your answer.** `/ship 2` picks approach 2; `yes` / `go` approves the plan. An objection or correction is treated as feedback: the approaches or the plan are revised and you are asked again. When in doubt, it does not advance. |
| `/ship <n>` | Right after `/diagnose` handed over a fix | Picks fix approach *n* — the diagnosis is already the start of the plan. |

### Mid-conversation

- **You discussed an idea without `/ship`.** Type `/ship <idea>`. If the approaches are
  already on screen it may skip asking for a direction — but only by listing them, saying which
  it picked and why, and noting the skip in the plan document. Otherwise it asks as usual.
- **You have a plan, but only in the chat.** Same: `/ship <the idea>`. The plan gets written to
  a file and audited, and you approve that.
- **You have a plan file.** `/ship <path>` — it goes straight to the approval gate.
- **A run is mid-build and you type `/ship <new idea>`.** That starts a second run and this chat
  switches to it. The first run stays on disk; any chat can pick it up again with a bare `/ship`.

### How it keeps track

- **Each run is saved on disk** under `~/.claude/state/`, per repository and per feature: its
  phase, branch, base branch, plan file and current brief.
- **Each chat remembers which run it is driving.** That is why a bare `/ship` continues the
  right one, and why a chat that is not driving any run shows the table instead of guessing.
- **A new session in a repo with unfinished runs lists them** when it starts, so you know
  they are there.
- **After a crash or a lost conversation**, the run is still on disk: type `/ship`, pick it
  from the table, and it resumes at the recorded step.
- **A run whose branch has been deleted** is marked `(gone)` in the table and offered for
  removal.

---

## What `/ship` runs — each also usable on its own

### `/blueprint` — design before code

- **Use when:** you want a reviewed plan without committing to building it yet.
- Sorts the request into one of three tracks, then brainstorms two or three approaches by
  running `/brainstorm`.
- Writes `docs/plans/<date>-<topic>.md`, which must carry **Decisions — do not re-litigate**
  and **Out of scope — deliberately** sections and a verification step per task.
- A **`plan-auditor`** agent checks every claim in the plan against the repo.
- Stops for your approval, then tells you the next step is `/brief <plan>`.
- **Typed on its own, it stays on your current branch:** you run `/brief` and `/execute`
  yourself. `/ship` is the one that opens a dev branch and drives the rest.
- **Not the built-in plan mode.** Plan mode is a read-only session that proposes a plan in
  chat: no triage, no plan file, no audit, nothing to resume from.

### `/brief` — turn a plan into work orders

- **Use when:** you have an approved plan and want to hand-feed it.
- Writes numbered, self-contained briefs, each with a checkable **Done when**.
- Checks the real test baseline first; if it disagrees with the plan, it stops and says so.

### `/execute` — build the briefs

- **Use when:** resuming a run, or running briefs you wrote yourself.
- One brief at a time:
  - an **implementer** agent builds it test-first;
  - a **reviewer** agent approves or rejects it;
  - two rejections bring in a **debugger**.
- Commits after each approved brief. A blocked brief stops the run rather than being skipped.

### `/land` — get it pushed and reviewed

- **Use when:** you did work by hand and want it landed properly.
- Runs the suite and quotes the real output, reads the diff, and commits with no AI attribution.
- Offers `/attack` once, then pushes and opens a PR.
- **Never merges** unless you say so.

---

## Standalone commands

### `/quick` — the fast lane for a small ask

- **Use when:** a question, a brainstorm, a bug, or a change that is small and obvious —
  **do-it-now** territory, without going through `/ship` to get there.
- **Threshold, estimated before editing anything:** at most 3 files, about 30 changed lines,
  no design call, a cause that reproduces, and no shared resource outside this checkout (a
  deploy, a migration, a production tenant). Crossing it, even mid-change, stops the command
  and hands off to `/diagnose` or `/ship` — any edits already made are left uncommitted and
  reported, never reverted and never committed.
- **No subagents except `scout`** for search — an explicit override of the discipline
  skill's usual fresh-reviewer advice, not an oversight. You read the diff yourself.
- Commits on the current branch (or a new `quick/<summary>` branch if you were on the
  default branch). **Never pushes.**

### `/diagnose` — something is broken

- **Settles three things first:** which environment, one symptom only, and what was observed
  versus expected.
- **Then** reproduces the bug, finds the root cause, and has a **`root-cause-auditor`** agent
  look for a second explanation that fits the same evidence.
- **Simple fix** → a failing test first, then the fix, then `/land`. Done on a `bugs/` branch
  in its own worktree.
- **Fix needs a decision** → writes the diagnosis and hands it to `/ship`, parked at the
  direction gate. Answer with `/ship <n>` in the same chat.
- **Not the built-in `/bug`.** That one reports feedback about Claude Code to Anthropic (in the
  terminal) or debugs the Claude session itself (in the desktop app). Neither debugs your code.

### `/brainstorm` — "I don't know what I want yet"

- Reads the real code, asks one question at a time, and puts up two or three approaches with
  trade-offs and a recommendation.
- **Writes nothing** — no plan, no file, no commit.
- `/ship` and `/blueprint` run this same command for their brainstorming step; typed on its
  own, it stops there.
- **Once you've decided:** `/ship <decision>` to build it, or `/blueprint <decision>` for the
  plan only.

### `/explain` — understand existing code

- Explains a subsystem, symbol or change at the level of detail your question implies, citing
  `file:line`.
- **Answers in chat and changes nothing.**

### `/attack` — try to break it

- **Use when:** before merging anything that matters. Per-commit review never sees the combined
  result.
- Parallel reviewers go after up to seven angles: security, correctness, operations,
  idempotency, reliability, performance, cost.
- Announces how heavy the run will be before spending anything.
- Confirms a correctness finding by briefly breaking the guard it names, then restoring it.
- **You type it yourself** — `/ship` and `/land` only offer it.

### `/handoff` — end a session cleanly

- Writes lasting findings to a file.
- Prints one ready-to-paste opening prompt for the next session.

---

---

## Skills — loaded when relevant, not typed

These are not commands. Claude loads them by itself when the work matches their description;
you can also ask for one by name.

### `refactor` — change the shape of code, not what it does

- **Loads when:** the intended change is structural — a rename, an extraction, a move, a split,
  removing dead code — and behaviour must be identical afterwards.
- **No failing test first.** Nothing new should become true; the tests still passing is the
  whole point.
- **A safety net you have watched fail.** Where coverage is missing, it writes
  characterisation tests that pin what the code does today, bugs included. Where coverage
  exists, it writes none.
- **One mechanical change per commit**, with the suite run between steps, so a red suite
  points at the one transformation that broke it.
- **Reviewed against the previous behaviour**, not against a spec: the question is "does this
  still do exactly what it did before?"
- **Not for behaviour changes.** "Refactor and fix that bug while I'm in there" goes through
  `/blueprint` or `/diagnose` instead.

### `workflow-discipline` — the house rules

- The operating rules behind every command: when to ask and when to act, root cause before a
  fix, what counts as verification, when work needs a written plan, commit hygiene.
- `/ship`, `/blueprint`, `/diagnose`, `/brief`, `/execute` and `/land` load it first thing,
  because a plugin install has no `CLAUDE.md` to carry these rules into every session.

---

## About the names

- **Installed as a plugin, every command is namespaced:** `/workflow-discipline:ship`,
  `/workflow-discipline:diagnose`, and so on. In a `claude -p` test, a plugin command's bare
  name did not resolve at all — only the full name ran.
- **No command shares a name with a Claude Code built-in.** In the desktop app, typing `/bug`
  debugged the session and `/plan` switched on plan mode, never reaching this setup's files —
  which is why those two are `/diagnose` and `/blueprint`. `hooks/test/verify-all.cjs` fails if
  a command is ever given a built-in's name again.
