# `/ship` run deviations: enter-key-inputs and enter-key-submit, 2026-09-24

**Summary.** In the first `/ship` run (`enter-key-inputs`) the agent broke four written rules. The workflow caught none of them; the user caught each one. The rules themselves were correct. What was missing was enforcement: the run's phase state is the only thing the workflow checks, and every one of these slips happened before a run existed or inside a single step. A fifth finding, that the scout ran on the wrong model, turned out to be a display bug: the transcripts show it ran on Haiku. The second run (`enter-key-submit`) landed as PR #170 and surfaced six gaps in the plugin's own tooling (see the last section).

## Context

- Request: `/ship on some txt inputs nothing happens when pressing enter pull and base it from main`
- Repo: SDB-Calculation-v2
- Plugin: workflow-discipline 0.2.0 (first run), 0.4.0 (second run)
- Run 1: `enter-key-inputs`, branch `bugs/enter-key-inputs`, base `main`, worktree `../SDB-enter-key`
- Run 2: `enter-key-submit`, branch `feature/enter-key-submit`, base `main`, worktree `../SDB-Calculation-v2-enter-key-submit`, PR https://github.com/ster-co/SDB-Calculation-v2/pull/170

## Deviations in run 1

| # | What happened | Rule broken | Caught by |
|---|---|---|---|
| 1 | The agent decided on its own that this was a small "do it now" fix, never ran `/plan`, and never told the user it had skipped the triage. | `/ship` Start: "Run `/plan` … follow its triage exactly." A vague scope ("some txt inputs") does not qualify as a do-it-now change. | User |
| 2 | The agent edited `CustomDialog.jsx` and `SupplierOverview.jsx` without running impact analysis first. | Repo CLAUDE.md: "MUST run impact analysis before editing." | Nobody |
| 3 | The user asked a question mid-task. The agent answered it, but then read the user's reply, "nvm", as permission to carry on editing. | Global rule: a question that arrives mid-task gets answered, then the agent stops and waits. | User |
| 4 | The agent sent the `scout` subagent (Haiku, low effort) a brief that asked for judgement (Enter behaviour, risk assessment) and for a file write. | Model routing: the cheap model locates code, the expensive model makes judgement calls, and `scout` is read-only. | User |
| 5 | The subagent panel in the VS Code extension labels the `scout` as **Opus 5.5**. The scout actually ran on **Haiku**, as its `model: haiku` frontmatter declares. The agent's claim at the time ("it would have been Haiku") was correct, but it rested on the frontmatter rather than on the running agent, so it was unverified. | "A claimed limitation is a material claim" (global CLAUDE.md), which applies equally to a claimed guarantee. Not a routing defect; see below. | User (the label), resolved from the transcripts |

**Resolution of #5.** The subagent transcripts record the model the API returned on every response, and every entry is Haiku, for this run's scout and for both scouts in run 2. The main session's responses carry the Opus ID, so the two are recorded separately and don't get mixed up:

```
subagents/agent-af5a54bfc44c31a91.jsonl   26 × "model":"claude-haiku-4-5-20251001"   (run 1 scout)
subagents/agent-afa9c8d5be2fd18df.jsonl   61 × "model":"claude-haiku-4-5-20251001"   (run 2 scout)
main session                               distinct models: [ 'claude-opus-5-5' ]
```

The panel entry for that scout shows the right agent (its token count matches the dispatch's `subagent_tokens`) but the wrong model. It most likely shows the parent session's model. This is a display bug in the Claude Code extension, to be reported there. Plugin-agent `model:` routing works.

## Root cause (run 1)

Each of these steps depends on the agent reading the rules and applying them. The only thing the workflow enforces mechanically is the `phase` recorded in `run-state.cjs`. No hook blocks an edit made before a run exists, or during the `awaiting-direction` or `planning` phases, and nothing checks whether a subagent brief fits the agent's role.

## Recommendations (workflow-discipline plugin, not this repo)

1. **Edit gate:** a `PreToolUse` hook on `Edit`/`Write` that refuses edits to source files while a `/ship` is in progress and its run is not in the `executing` phase. That would have stopped #1 and #2.
2. **Triage trace:** require `/ship` to print the `/plan` triage result ("do it now", "iterate in a browser" or "really plan") before any other step, so a skipped triage is visible to the user. (Present in 0.4.0.)
3. **Brief-to-role check:** a `PreToolUse` hook on `Agent` that flags a `scout` brief asking for writes or for assessments. That would have stopped #4.
4. **Log the model when the subagent stops:** at `start` no response exists yet, so the model can't be known then. The `stop` event already receives `agent_transcript_path`. Have `agent-log.cjs` read the distinct `"model"` values from that transcript, record them, and warn when they differ from the agent's `model:` frontmatter. That makes the log the authority rather than the panel, and would have settled #5 immediately. Stop asking subagents to report their own model: in run 2 the scout ignored the request, and self-report is not evidence anyway.
5. **Routing nudge:** an advisory `PostToolUse` hook on Bash/Grep/Read that fires during `awaiting-direction` and `planning`. After N consecutive read-only searches in the main conversation, it says "route this to scout". In run 2 the agent did its first exploration inline and kept searching inline after saying it would use the scout.
6. **Verbatim evidence from the scout:** require `scout.md` to quote the source line for every attribute it reports, and never to report an attribute that isn't in the quoted text. In run 2 an unquoted report called two typeless buttons `type="button"`, which was the one fact the design depended on. The next brief, which required quotes, came back correct.

## Tooling gaps found in run 2 (enter-key-submit)

| # | Gap | Effect | Workaround used |
|---|---|---|---|
| G1 | `plan-gate.cjs` keys the audit marker on the plan's **absolute path**, but `/ship` writes the plan before the worktree exists. | A plan copied into the worktree has no marker and can't be committed. | A fresh `plan-auditor` run on the worktree copy. That run found a real blocking defect (native validation would stop existing saves), so the extra audit paid off. The keying should still use the repo-relative path plus a content hash. |
| G2 | `test-delta.cjs` detects the suite only at the repo root (pytest config or a root `package.json`). | "No test suite detected" in a repo whose frontend suite lives in `frontend/`, so no baseline and no delta. | Counts compared by hand against a measured baseline (45/452 → 46/457). |
| G3 | `run-state.cjs` has no way to unblock a brief. | Once blocked, a brief stays in `blocked` after the user answers and it is completed. | The brief file, which is authoritative per `/execute`, records it as done. |
| G4 | `reviewRounds` stayed at 0 after a `REJECTED` verdict. Reviewer reports arrive as a separate SubagentHandback message, not in the Agent tool result that `verify-record.cjs` parses. | Neither the two-rejection debugger escalation nor the verification gate is enforced mechanically. | The orchestrator counted rounds by hand (brief 7: rejected once, approved in round 2). |
| G5 | `--brief-file` is accepted only by `start`, which resets the run. | Recording a per-run brief file mid-run means calling `start` again and then restoring the phase, plan and branch. | Did exactly that and checked the state afterwards. |
| G6 | `/ship` says to symlink `.env` into the worktree. On Windows without admin rights, `New-Item -ItemType SymbolicLink` fails ("Administrator privilege required"). | The worktree can't get its `.env`. | A hard link (`New-Item -ItemType HardLink`) works without admin and is still the same file, not a copy. |

Other observations from run 2 that are not plugin defects:
- An implementer reported untracked files that exist only in the main checkout. The main checkout was verified unchanged, so it was a misreport, not a write.
- `HelpPage.test.js` failed 4 tests once on a `waitFor` timeout and then passed on four later full runs. It doesn't load anything the branch changes. Probably a flaky test.

## State left behind

- Run 1 (`enter-key-inputs`) is still at `awaiting-direction`: Gate 1 was never answered. Its worktree holds uncommitted draft edits to `CustomDialog.jsx` (Enter now confirms) and `SupplierOverview.jsx` (Enter now saves), plus a test, `CustomDialog.test.js`. Run 2 found that `CustomDialog`'s prompt input is unreachable (no caller passes `type="prompt"`), so that draft fixes nothing a user can reach. Run 2 supersedes this run. Dropping it is the user's call.
- Run 2 (`enter-key-submit`) is finished. PR #170 is open against `main` and not merged. The browser check (BRIEF 4) was handed to the user because the local app requires Microsoft login.
