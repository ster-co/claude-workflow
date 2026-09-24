---
description: End this session by writing the opening prompt for the next one.
argument-hint: [optional: what the next session should pick up]
# Side effects: branches, commits, subagent spend. Trigger by typing /name,
# never by the model deciding it looks relevant.
disable-model-invocation: true
---

Write the opener for the next session. Focus: **$ARGUMENTS** (if empty, infer it from what
this session did not finish).

## Why

Four times in the user's history a session ended with this request, and **the successor
outperformed its parent every time** — once at 8.9 commits per active hour against a 2.9
average. It is the highest-yield thing done at the end of a hard session.

## Steps

1. **Write the durable findings to a file first**, if they are not already in one. The opener
   points at an artefact; it does not carry the content. Use the repo's existing docs
   location. Commit it.
2. **Write the opener** in the four-part shape below.
3. **Print it in a single fenced block**, ready to paste, and say nothing after it.

## Shape

```
<one paragraph: the problem in the user's own words, with the user-visible symptom>
<what has already been tried, and why it did not work>

Read <path/to/findings-or-plan.md> in full first — <what it contains, and how complete it is>.

Environment: <local | local against TST resources | TST | ACC>. <what that implies>

Tool guidance:
  Superpowers: <use X then Y | skip X because ...>
  Subagents:   <how many, serial or parallel, what each is briefed on | not needed because ...>
  Serena:      <find_referencing_symbols before <symbol>; grep as well because <string refs>
                | not applicable here because ...>

## 1. <first job>   ## 2. <second job, in this order>
Do NOT <the specific shortcut you expect it to take>.

Model: <model id>, effort <level>.
```

## Rules

- **The "not applicable because…" branch is what makes this work**, rather than becoming a
  checklist. The best-calibrated example in the user's history reads: *"this renames plain
  string literals inside `os.getenv(...)`, not code symbols — a symbol tool is not the right
  tool"*, and the next session correctly grepped instead of asking the index. That judgement
  still holds: no symbol tool resolves a string reference.
- **Always name the model and the effort level.** Sessions whose opener did this show zero
  instances of "are you on thinking mode? your answers seem way too fast".
- **Name the environment.** Six of ten bug sessions turned on which deployment was meant,
  not on the code.
- Point at a committed file. An opener that carries its own context re-derives it next time.
