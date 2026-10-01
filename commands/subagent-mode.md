---
description: Switch reviewer, debugger, plan-auditor and root-cause-auditor between their full agents and their lower-effort -lite twins.
argument-hint: [fast | quality — or nothing, to show the current mode]
# Side effects: writes one file that changes which agents every later dispatch
# uses, across sessions. Trigger by typing /subagent-mode, never by the model
# deciding it would save time.
disable-model-invocation: true
---

Subagent mode: **$ARGUMENTS**

The mode lives in one file, `${CLAUDE_CONFIG_DIR:-~/.claude}/subagent-mode`. It is untracked
(the repository's `.gitignore` is an allowlist) and shared by every session on this machine.

- **`fast`** — write `fast` to that file. From the next prompt on, `hooks/discipline-reminder.cjs`
  adds a standing rule: dispatch `reviewer-lite`, `debugger-lite`, `plan-auditor-lite` and
  `root-cause-auditor-lite` in place of their full-effort originals. Each `-lite` agent is its
  original's exact prompt, model and tools at effort medium; `hooks/test/verify-all.cjs`
  fails if one drifts. The hooks that record verdicts accept the `-lite` names, so the gates
  behave the same.
- **`quality`** — write `quality` to that file. This is also what an absent file means: the
  full-effort agents, as before this command existed.
- **nothing** — print the file's current content, or `quality (no file)` when it is absent.
  Change nothing.
- **anything else** — say the argument is not a mode and change nothing.

Run it as one Bash call, then print one line: the mode now in force and that it applies from
the next prompt.

```bash
f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/subagent-mode"
printf '%s\n' fast > "$f"      # or: quality
```

Two limits to say when switching to `fast`:
- **Unattended ship-loop passes ignore it.** `bin/ship-loop.cjs` runs each pass with
  `SHIP_LOOP_PASS=1`, and the hook leaves the rule out there: no one is watching those runs to
  have chosen less reasoning for them.
- **`fast` lowers effort, not the model.** It saves tokens on the four adversarial roles; the
  wall-clock time of a run goes mostly to test runs, which this does not change.
