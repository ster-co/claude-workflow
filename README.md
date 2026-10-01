# This Claude Code setup

What is installed, what enforces what, and how to check it still works.
Last substantive change 2026-09-28. Claude Code **2.1.280**, VS Code extension.

**Setting this up on another machine?** This file is a reference, not a procedure —
start with [`SETUP.md`](SETUP.md) instead: seven ordered steps, each with a command and a
check, ending in a scratch repo that proves the gates actually fire.

Design notes and the evidence behind each choice live in `audit/`:
`2026-09-21-config-improvements.md`, `2026-09-21-orchestrator-plan.md`, and the raw
research in `audit/research-2026-09-21/` — of which `06-bakeoff-results.md` is the one
that decided the code-intelligence question.

**Defending this to a colleague, or deciding whether to install it?**
[`docs/WHY-THIS-WORKFLOW.md`](docs/WHY-THIS-WORKFLOW.md) is the cited, evidence-based case
for why this is more than `superpowers` plus extra commands — the enforced gates, the plan
audit, the `/attack` whole-tree pass, and the measurement behind choosing Serena over the
alternatives, including Claude Code's own native `LSP` tool — each claim sourced to the
commit or measurement behind it.

---

## Installing this as a plugin

This repository is also a Claude Code plugin — `commands/`, `agents/`, `skills/` and
`hooks/` are already the layout a plugin root expects, so `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` point at the repo itself rather than at a generated
subdirectory. A colleague gets the whole setup — commands, agents, hooks and Serena's MCP
config — in two commands and a restart:

```
/plugin marketplace add ster-co/claude-workflow
/plugin install workflow-discipline@ster-co
```

`ster-co/claude-workflow` is real: a private repository colleagues need Read or Triage
access to (never Write — see `docs/2026-09-24-plugin-rollout-findings.md`). It is a
promoted export of this repository, not a mirror — `bin/export-to-production.sh --push`
ships a checked subset, on a release cadence, not on every commit. `SETUP.md` is the
step-by-step procedure for a new machine.

Then **restart Claude Code.** Plugin `hooks/` and `.claude-plugin/mcp.json` are read once
at startup, not watched — a hook or MCP server change picked up by the install has no
effect on the running session until it restarts.

`.claude-plugin/plugin.json` declares a dependency on the `superpowers` plugin — the
five command files under `commands/` invoke four of its skills (`brainstorming`,
`systematic-debugging`, `writing-plans`, `finishing-a-development-branch`) by name, and a
plugin cannot vendor another marketplace's skill. `superpowers` lives in the
`claude-plugins-official` marketplace, not this one, so `.claude-plugin/marketplace.json`
lists that marketplace in `allowCrossMarketplaceDependenciesOn` to permit it; a single
`/plugin install workflow-discipline@ster-co` pulls both.

### Serena — required, not optional

The plugin ships Serena's *config* (`.claude-plugin/mcp.json`), not its binary. That config
starts `bin/serena-relay.cjs` with `node`, and the relay finds or spawns the repository's
one shared Serena with `uv tool run --python 3.13 --from serena-agent serena start-mcp-server`. Each
repository gets its own shared Serena, one process per repository rather than one per
session, and the relay routes there: a lookup whose `relative_path` is an absolute path
into a `/ship` worktree, or into another repository entirely, goes to that repository's own
Serena — the relay connects to it on first use, joining the server if one is already running
for that repository or starting it if none is, with results relative to its root. There is
no per-worktree setup step: before the relay spawns a server for a root with no
`.serena/project.yml` — a `/ship` worktree, chiefly, since no session ever starts there to
run the `SessionStart` hook, but this also covers the session's own root the first time
anything opens it — it writes one itself, with every language that repository actually
has, reusing the same detection `hooks/repo-setup.cjs` uses rather than leaving Serena to
autogenerate its own config for just the dominant one. It applies the hook's own
preconditions first, not just its detection and writing: `CLAUDE_NO_AUTO_REPO_SETUP=1`
opts a repository out here too, and it will not write a config that points the gates at a
server it cannot itself start — checked by asking whether the command it is actually about
to run resolves, since `SERENA_RELAY_SERVER_CMD` can replace `uv` with anything. A path with
no `.git` or `.serena/project.yml` above it is not a repository at all, and such a lookup is
refused with an error rather than given a Serena of its own. When the relay writes a
config into a repository whose `.serena/` is not git-ignored, that file shows as
untracked, so the relay adds a one-time notice, saying so and how to fix it, to the next
successful tool call it answers for that repository. `uv`
(the same install that gives you `uvx`) must be on `PATH` **before** the first session in
any repository this workflow is meant to gate:

```
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Skip it and the discipline this config exists to enforce simply does not run. Every
session's `SessionStart` hook (`hooks/repo-setup.cjs`) checks for `uvx` on `PATH` before it
writes a repository's `.serena/project.yml`; find it missing and it writes nothing, because
the edit and commit gates key on that file existing (`hooks/gates/gate-lib.cjs`). The relay
(`bin/serena-relay.cjs`) makes the same kind of check for the repositories it configures:
it asks whether the command it is about to spawn resolves, `uv` by default, while the hook
asks for `uvx`. Without the relay's command, no repository ever gets a config this way, so no
repository is ever gated through it — the three `mcp__serena__*` symbol tools
(`find_referencing_symbols`, `find_implementations`, `find_declaration`) the `implementer`
agent declares stay unavailable, and there is no reference-lookup evidence the edit gate
can ever be satisfied with. This is reported, not silent, for the hook's own check: its
SessionStart message says `uvx` is missing, that the repository is therefore not gated, and
how to install it (the relay's check is silent on failure — see `bin/serena-relay.cjs`).
Install `uv` and start a new session to have `hooks/repo-setup.cjs` write the config the
gates need.

**Unverified, flagged rather than asserted:** Serena's Roslyn language server for C# is
*believed* to need PowerShell 7+ (`pwsh`) on Windows rather than the Windows PowerShell
5.1 that ships with the OS. This has not been checked against Serena's own documentation
— treat it as something to confirm before relying on it, not as a settled prerequisite.

### What a plugin install cannot give you

A plugin cannot ship a `CLAUDE.md` as always-on project context — that channel is not part
of the plugin system. The operating discipline lives in the `workflow-discipline` skill
instead, and `/ship` and `/blueprint` load it explicitly, by name, as the first thing they do,
rather than assuming it is ambient. A colleague who installs the plugin gets that
discipline only on the turns where a command pulls the skill in; working in this repository
directly, with its root `CLAUDE.md` still in place, gets it on every turn. The two are not
the same experience — said here rather than left for a colleague to discover on their own.

---

## The shape of it

```
you ──/ship "<idea>"──▶ /blueprint triage
                             │
                   do-it-now │      2–3 approaches on the table
                   browser   │              │
                   (stops)   │        YOU CHOOSE (Gate 1)
                             │              │
                             │           /ship
                             │              ▼
                             │          plan doc
                             │              │
                             │       YOU APPROVE (Gate 2)
                             │              │
                             │           /ship
                             ▼              ▼
                                       ┌───────────────────────────────────────┐
                                       │ /brief  → docs/briefs.md              │
                                       │ /execute, per brief:                  │
                                       │   implementer (sonnet)                │
                                       │        ▼                              │
                                       │   reviewer (opus)                     │
                                       │        │                              │
                                       │   2× REJECTED ──▶ debugger (opus)     │
                                       │   tests ──▶ commit ──▶ next           │
                                       │ /land: offers /attack, push, open PR  │
                                       └──────────────────┬────────────────────┘
                                                          ▼
                                             YOU LOOK AT THE RUNNING THING
```

You are in it at **three points**: choosing the direction, approving the plan, and
looking at the product. Everything between is delegated. The plan-approval split came
out of the September audit of 280 sessions, not out of taste; the direction gate was
added afterward so a plan is never written against an approach nobody chose.

`/ship` is the front door and does the whole thing. The individual commands still exist
and still work alone; `/ship` is what saves you typing four of them in order.

---

## Commands

New here? [`docs/COMMANDS.md`](docs/COMMANDS.md) explains each command in plain language,
including how `/ship` runs the others and how they differ from Claude Code's own built-ins.

| command | argument | what it does |
|---|---|---|
| **`/ship`** | idea, then nothing | **The front door.** Stops twice — once to choose a direction, once to approve the plan — then briefs, executes and lands unattended. Reads `phase` from its run under `~/.claude/state/ship-runs/`, so running it twice is the whole interface. |
| `/quick` | yes | The fast lane for a small, obvious ask — answer, brainstorm, bug or change — inline, in this session, no plan, no subagents except `scout`. Do-it-now threshold estimated before editing: ≤5 files, ~80 lines of behaviour-bearing code (tests and docs don't count), no gate/permission/auth change at any size, no design call, a reproducible cause, no shared resource outside this checkout. Crossed mid-change, edits stay uncommitted and get reported; escalates to `/diagnose` or `/ship`. |
| `/blueprint` | yes | Triages into do-it-now / iterate-in-a-browser / really-plan. For the third: explores, puts up 2–3 approaches, **stops** on the direction, writes the plan doc, **stops** again for approval. |
| `/diagnose` | yes | Refuses to diagnose until environment, one-symptom, and observed-vs-expected are settled. Fixes a simple bug test-first; hands any fix that needs a decision to `/ship`, parked at its direction gate. |
| `/brainstorm` | yes | Open-ended exploration for "I don't know what I want yet" — puts up 2–3 approaches with trade-offs, recommends one, stops with a recommendation in chat. Never writes a plan document; names `/ship` (build it, on a new branch) or `/blueprint` (plan only) as the next step. `/ship` and `/blueprint` run it for their own brainstorming step. |
| `/explain` | yes | Explains a subsystem, feature, symbol or change at the altitude the question implies — understanding-oriented, cited `file:line`, answers in chat by default. |
| `/attack` | optional target and axes | Probes a *standing system* — working tree, diff, branch, merge commit, path, subsystem or repo — along adversarial axes: security, correctness, operational excellence, idempotency, reliability, performance, cost. See below for how this differs from the bundled `code-review` skill. |
| `/brief` | yes | Turns an approved plan into numbered briefs, verifying the real test baseline first. |
| `/execute` | no | The per-brief loop. Six termination conditions. `/ship` calls it. |
| `/land` | no | Verify, commit, push, open the PR. Asks once whether to `/attack` the branch first — a "no" costs nothing. Never merges to the default branch unprompted. |
| `/handoff` | no | Writes the next session's opening prompt. For a *deliberate* session end — the checkpoint hooks cover crashes and compaction. |
| `/subagent-mode` | `fast`, `quality`, or nothing to show | Swaps `reviewer`, `debugger`, `plan-auditor` and `root-cause-auditor` for their `-lite` twins (same prompt and model, effort medium) until switched back. Unattended ship-loop passes always use the full agents. |

`/attack` probes a *standing system*, not a diff — that is what distinguishes it from the
bundled `code-review` skill (`plugins/synced/<id>/engineering~g2/skills/code-review/SKILL.md`,
3 uses recorded in `~/.claude.json`'s `skillUsage`). `/code-review` hunts correctness bugs
in a diff someone is about to merge; `/attack` fans out per architectural axis over
whatever target you name — a whole repo, a subsystem, a completed merge — and reports
what it finds without applying anything. They are not duplicates of each other.

`superpowers` sits under these — 68% of measured skill usage (`brainstorming` 48,
`writing-plans` 25, `subagent-driven-development` 25, `systematic-debugging` 23,
`test-driven-development` 14). The commands dispatch *through* it, not around it.

### `/ship`'s phases

Each run's state file, under `~/.claude/state/ship-runs/<repo-key>/<feature>.json`, carries
a `phase`, so `/ship` is resumable rather than restartable. (A repo whose legacy
`docs/.run-state.json` is still mid-run keeps using that file until the run finishes; new
runs go straight to the registry.)

| phase | `/ship` does | who acts next |
|---|---|---|
| no state, or `finishedAt` | `/blueprint` triage; only a really-plan job creates state | — |
| `awaiting-direction` | prints 2–3 approaches and the question | **you** |
| `planning` | write `docs/plans/YYYY-MM-DD-*.md` | — |
| `awaiting-approval` | prints the plan path, ≤5 lines, and the question | **you** |
| `executing` | brief, then loop `/execute` at `currentBrief` | nobody |
| `landing` | `/land`, then `run-state.cjs finish` | nobody |

`run-state.cjs`'s `phase` subcommand rejects an unknown value rather than writing it: a
typo like `excuting` would otherwise leave `/ship` in a state no branch handles, which is
the failure the phase list exists to prevent. **That guarantee does not yet extend to
`start --phase`**, which writes whatever string it is given with no validation — a gap
tracked, not fixed, as of this writing.

---

## The agent roster — and why routing works this way

`~/.claude/agents/`. Each role pins its own model and effort:

| agent | model | effort | tools | for |
|---|---|---|---|---|
| `scout` | haiku | low | read-only | "where is X", "which files do Y" |
| `researcher` | sonnet | medium | read-only + web | "how does this library work", version-pinned |
| `implementer` | sonnet | high | + Edit/Write, + the three serena lookups | one brief, test-first, never commits |
| `reviewer` | opus | high | read-only | adversarial; emits `## Review Verdict` |
| `debugger` | opus | high | read-only | root cause after two failed review rounds |

**Route by delegating, not by switching.** Changing the *main* conversation's model or
effort invalidates the prompt cache and costs a rebuild next turn. Pinning a model on a
subagent costs nothing, because a subagent is a separate context with its own prefix.
Cheap work goes to a cheap subagent; it does not go to the main loop switched down and up.

Send verbose work down (scanning trees, summarising logs, locating symbols): it is cheap
there **and its output never enters your context**. Spend opus on judgement only.

**The reviewer being opus while the implementer is sonnet is the point, not an oversight.**
A recommendation to "pin everything to haiku for 90% savings" removes the thing the money
is for. One arrived from a research subagent on 2026-09-21; it was also wrong that the
agents had no model pinned at all. Grade the artifact, not the report about it.

---

## Hooks — what is enforced rather than requested

Rules in prose get skipped under load. These do not.

| event | hook | what it does |
|---|---|---|
| `PreToolUse` Edit/Write/Bash | `gates/edit-gate.cjs` | Blocks a source edit until a **reference lookup** has run this turn — including edits made through Bash |
| `PreToolUse` Bash | `gates/commit-gate.cjs` | Blocks `git commit` until a **`git diff`** has run this turn |
| `PostToolUse` Bash | `gates/diff-record.cjs` | Records that a real `git diff` ran |
| `PostToolUse` serena refs | `gates/refs-record.cjs` | Records `find_referencing_symbols` / `find_implementations` / `find_declaration` |
| `PostToolUse` Agent | `verify-record.cjs` | Parses `## Review Verdict` → `APPROVED`/`REJECTED`. **No parseable verdict is recorded as `UNPARSED`, never as approval** |
| `SubagentStart` / `SubagentStop` | `agent-log.cjs` | Appends role, model, duration, brief and feature to `state/agent-log.jsonl` |
| `Stop` | `verify-gate.cjs` | Refuses to end the turn while a brief is armed and unreviewed. Stands down after 5 blocks (the platform overrides at 8) |
| `PreCompact` | `checkpoint-write.cjs` | Saves the thread before the context is rewritten. No matcher, so it catches **auto** compaction as well as `/compact` |
| `SessionStart` all five sources | `checkpoint-restore.cjs` | Session checkpoint for `compact`/`resume`/`clear`, the run-state registry for `startup`/`clear`/`fork` |
| `SessionStart` `startup` | `worktree-sweep.cjs` | Removes the repo's local worktrees and branches whose PR merged — only when nothing unpushed, uncommitted or in use would be lost; backs up tips, patches and `.env` first. At most hourly per repo; `CLAUDE_NO_WORKTREE_SWEEP=1` disables; `node ~/.claude/hooks/worktree-sweep.cjs --dry-run --repo <path>` shows the plan |
| `UserPromptSubmit` | `discipline-reminder.cjs` | Re-injects the rules that decay by turn forty; clears the per-turn gate markers |

**Escape hatch:** `SKIP_CODE_GATES=1`.

### What the gates actually ask for

The discipline is **look before you edit, read the diff before you commit.** What counts
as evidence is deliberately narrow:

- **`git status` does not satisfy the commit gate.** It names files and shows no content,
  so it is not evidence anyone looked at what changed — which is the only thing the gate
  is for.
- **`find_symbol` does not satisfy the edit gate.** It locates a definition and says
  nothing about callers. Only reference lookups count.
- **A repo is gated when it has `.serena/project.yml`**, not when it has a `.serena`
  directory. Serena writes a *global* `~/.serena/` holding `serena_config.yml`, `logs/`
  and `language_servers/` and no project config; keying on the directory would gate every
  file on the machine — an earlier locally-built call-graph indexing tool set the identical
  trap with its own global registry file. There is a test for this and it fails if you loosen it.

`bin/claude-repo-setup.sh` is what extends the gated set — see **Per-repo setup**.

---

## Code intelligence

| | Serena | pyright / typescript LSP |
|---|---|---|
| callers of a symbol | 45 sites + 10 imports in 10 files, with line numbers | — |
| in-turn diagnostics after an edit | on request | **passive, ~0 context** |
| **string references** (`monkeypatch.setattr(m,"x",f)`) | **misses all 7** | **misses all 7** |
| licence | GPL app, local use fine | fine |

**No tool resolves a string reference.** That is why CLAUDE.md's *"no callers found is not
proof — confirm with a grep"* stays, and it is the single most important bake-off result.

**The predecessor call-graph tool was removed on 2026-09-21.** Not over its licence — over
measurement. Against a freshly rebuilt index, its impact analysis on `structured` returned 7
callers of which **0 were real**, missing all 8 that were, while reporting
`epistemic: "exact"`. Its rename analysis on `queueFilterKey` emitted the same declaration
line twice and missed both call sites in the same file. Its analysis step wrote 45 lines of
its own instructions into a tracked `AGENTS.md` unprompted. Its enrichment hook cost a
measured **0.64s on every Grep/Glob/Bash**, twice per Bash call.

Removing a tool is only half the job: its *instructions* outlived it, in a repo's tracked
`CLAUDE.md` and in nine global skills. Instructions naming tools that do not exist are
worse than either state — an agent reads a MUST, finds nothing to call, and learns that
the MUSTs in that file are optional. Both were removed the same day; the skills are kept,
untracked, in the dated `backups/` directory from that sweep rather than deleted outright.

---

## Per-repo setup

`bin/claude-repo-setup.sh` — dry-run by default, idempotent, prints every change first.

```
~/.claude/bin/claude-repo-setup.sh                              # this repo, dry run
~/.claude/bin/claude-repo-setup.sh --all ~/Code/Repositories
~/.claude/bin/claude-repo-setup.sh --all ~/.../Repositories --write --jsconfig
```

`~/.claude/bin` is **not** on `$PATH` — call it by the full path, or add
`export PATH="$HOME/.claude/bin:$PATH"` to your shell profile if you want the bare name.

It detects the language mix and sets `.serena/project.yml`'s `language_servers`, optionally
writes a `jsconfig.json` for plain-JS repos, and creates `.claude/settings.json` with the
concurrency caps. It rewrites only the `language_servers` block and leaves every other key
in an existing `project.yml` alone. It deliberately does **not** write `CLAUDE.md` — that
is `/init`, and a generated one is worse than none — and it does not commit anything either:
several of these repos are client work, and a scripted commit sweep across all of them is
the kind of unreviewed change this setup exists to prevent.

Run it when you clone or create a repo, when a repo's language mix shifts materially, and
after a Serena upgrade. Not on a schedule.

A one-time migration script from 2026-09-21 did the equivalent cleanup for the predecessor
tool: it stripped the block that tool had written into `CLAUDE.md`/`AGENTS.md` by its own
start/end markers, deleted the skill directory that tool had installed, and untracked the
root agent docs across every repo. That migration is finished and the script is gone — it
was scoped to that one sweep and had nothing left to run against once every repo was clean.

**A repository with no `.serena/project.yml` at all gets one Serena autogenerates itself, and
it lists only the dominant language** (Serena 1.7.0, `ProjectConfig.autogenerate`, called
only when the file does not yet exist) — and silently reports every other language as
"ignored" — the failure message names the wrong cause. Without the `typescript` entry, a
`find_referencing_symbols` over `frontend/*.js` returns nothing rather than erroring. This is
what `repo-setup.cjs` (every repository a session starts in) and `bin/serena-relay.cjs`
(every other repository, including a `/ship` worktree, that a routed call reaches first) both
write ahead of, with the full language mix instead of just the largest slice of it.
**The server reads its project config once, at startup.** When `repo-setup.cjs` writes the
file, it stops the repository's shared Serena, and each session's relay starts a new one that
reads it. An edit you make by hand takes effect when that shared server next starts, which
is after every session using it — in that repository or routed there from another — has
closed.

---

## Global vs per-repo — what colleagues see

**Everything substantial lives in `~/.claude/` and is yours alone.** A colleague cloning a
repo you work in inherits none of it: not the hooks, not the agents, not the commands.

| path | scope | commit? |
|---|---|---|
| `~/.claude/**` | you, everywhere | n/a — never in a repo |
| `.claude/settings.json` | **the team**, this repo | **yes** — permissions, hooks, plugins, safety caps |
| `.claude/settings.local.json` | you, this repo | **no** — globally ignored |
| `.claude/skills/`, `agents/`, `commands/`, `rules/` | the team, this repo | yes, if the team should have them |
| `docs/briefs.md` | the work queue — a real artifact | **yes** |
| `docs/.run-state.json` | legacy per-repo run state — new runs use `~/.claude/state/ship-runs/` instead | **no** — globally ignored |
| `.serena/` | Serena's index for this repo | **no** — globally ignored |
| `jsconfig.json` | editor/LSP hint, not Claude-specific | per repo — judgement call |

Precedence runs **managed → CLI → project-local → shared-project → user**, so a repo's
`.claude/settings.json` overrides `~/.claude/settings.json`. That is the point: a repo can
tighten a rule for everyone, and a teammate can still make a personal exception in their
own `settings.local.json` without a commit.

`jsconfig.json` is the judgement call. It genuinely improves IntelliSense for vanilla JS
for anyone, Claude Code or not — but in a repo that deliberately has no build manifest, an
unexplained one is noise. Commit it where the team edits JS daily; keep it local on a
teaching branch.

### `~/.gitignore_global`

```
.serena/
docs/.run-state.json
**/.claude/settings.local.json
/CLAUDE.md
/AGENTS.md
```

**The last two are anchored on purpose.** A root `CLAUDE.md` describes one person's
assistant, config and workflow; colleagues run different ones, so it is not a project
file. But a bare `CLAUDE.md` pattern matches at *any* depth and would also swallow
`docs/intern/CLAUDE.md`, which is course material an intern is meant to receive. Verified
with `git check-ignore` against both spellings before this was written — bare ignores the
nested file, anchored does not.

Note that ignoring does not untrack: a repo that already committed these keeps shipping
them until `git rm --cached CLAUDE.md AGENTS.md` runs by hand in that repo.

**Do not move `core.excludesFile` without merging what the old file held.** Claude Code
writes `**/.claude/settings.local.json` into whichever global excludes file is in effect
*at the time* — `~/.config/git/ignore` when `core.excludesFile` is unset. Pointing it
somewhere new orphans that pattern silently, and every teammate's personal settings file in
every repo becomes committable. That happened here on 2026-09-21 and was caught only by
testing `git check-ignore` directly.

---

## What else is installed

| | |
|---|---|
| **MCP servers** | `serena` (user scope, stdio: `node ~/.claude/bin/serena-relay.cjs` — the shell expands `~` when the entry is added, so the stored path is absolute, matching SETUP step 5 — a relay to one shared Serena per repository). It serves every repository, this one included: the repo's `.mcp.json` declares no `serena`, so without the plugin or this entry there is no Serena. See SETUP.md step 5 |
| **Plugins** | `superpowers`, `pyright-lsp`, `typescript-lsp`, `playwright`, `frontend-design`, `azure`, `microsoft-docs` |
| **Marketplaces** | official, plus `microsoft/skills` |
| **Output style** | Concise |
| **Permissions** | `defaultMode: auto` — required for unattended `/goal` turns |
| **Model** | whatever VS Code last wrote back. **Not a considered choice** — do not reason about cost as though it were |
| **Memory** | `projects/<repo>/memory/`, indexed by `MEMORY.md`, one fact per file |
| **Connectors** | Gmail and Google Calendar are registered but **unauthorised**; authorise from claude.ai connector settings |

---

## Recovery

| what happened | `source` | what restores you |
|---|---|---|
| context compacted (auto or `/compact`) | `compact` | `PreCompact` saved it; the session checkpoint comes back |
| session resumed | `resume` | same path |
| `/clear` | `clear` | session checkpoint if present, else the run-state registry |
| crash, reboot, new session | `startup` | the run-state registry under `~/.claude/state/ship-runs/` — **only** when a brief is unfinished |
| session forked | `fork` | the run-state registry |
| run finished | — | nothing injected; `finishedAt` stops it |

**This was broken until 2026-09-21.** The matcher read `compact|resume`, so
`checkpoint-restore.cjs` never ran on `startup` at all: the entire cross-session recovery
path was dead in the live config while 38 unit tests reported green on the script that
implements it. `verify-all.cjs` now *asserts* the wiring rather than printing it, and fails
if a hook handles a source the matcher does not select, or if any wired hook points at a
file that does not exist.

Two constraints the restore respects, both from the SessionStart contract: injected context
stays under **10,000 characters** (above that, Claude Code writes it to a file and hands
over a path it is *not* asked to read), and it is phrased as **factual statements** —
imperative framing can trip prompt-injection defenses and get surfaced to you instead of used.

---

## Cost controls

- `subagentPromptCacheTtl: "1h"` — subagents, workflows and forks otherwise default to a
  **5-minute** cache even on a subscription. With 851 Agent calls on record, this is the
  highest-leverage single setting here.
- `state/agent-log.jsonl` is what turns that from an assertion into a measurement: role,
  model, duration and brief per dispatch.
- Per-repo `.claude/settings.json`: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=4` (default 20),
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` (default 3), `workflowSizeGuideline: small`.
- Headless runs: `claude -p --max-turns N --max-budget-usd X`. Subagent spend counts toward it.
- **Never enable `ultracode` for a brief run** — it exempts the concurrent-subagent limit.
- **Never resume a finished subagent to ask a follow-up.** Spawn a fresh one with the diff.
- On a 1M context every turn pays for the whole transcript, so a long session is expensive
  regardless of compaction. **Shorter sessions with a deliberate `/handoff` beat one long
  session with a tuned `autoCompactWindow`** — compaction is lossy and unreviewable; a
  handoff is neither.

---

## Known, and deliberately not fixed

- **`claude doctor` reports the 2026-09-03 update failure.** `.last-update-result.json` is
  only rewritten by the *auto*-updater, and still records that one attempt: `install_failed`,
  from 2.1.251, `version_to: null`, nothing since. `~/.claude.json` still has
  `"autoUpdates": false`, but `claude doctor` itself now reports `Auto-updates: enabled`
  (`native (2.1.280)`, channel `latest`) — the two disagree, and the running build is well
  past 2.1.251, so it has kept updating since that recorded failure regardless of which
  setting doctor is actually honoring. **Do not delete that file to make the check green.**
- **No statusline.** It does not render in the VS Code panel at all
  (`anthropics/claude-code#77829`, open since July).
- **VS Code gaps vs the CLI**: no `!` bash shortcut, no tab completion, a subset of `/`
  commands, and the extension does not put the CLI on `$PATH`.

---

## Checking it still works

```
node ~/.claude/hooks/test/verify-all.cjs             # everything below, plus wiring assertions
node ~/.claude/hooks/test/test-gates.cjs             # 217 — edit gate, commit gate, markers
node ~/.claude/hooks/test/test-verify-checkpoint.cjs # 192 — verdicts, checkpoints, run state, /ship phase
node ~/.claude/hooks/test/test-agent-log.cjs         # 24 — subagent accounting
claude doctor                                        # install health, update channel
```

`verify-all.cjs` exits non-zero on a wiring failure **or on any failing unit test** — it
prints twelve per-file counts and no total; summed, 2,001 tests at last count
(2026-09-28). Until 2026-09-22 each test was piped
to `tail -2`, so the script reported the status of `tail` and a red test could not fail it.

Its gated-repos report always covers this repo; to have it also scan elsewhere on your
machine, set `CLAUDE_REPO_SCAN_ROOTS` to one or more directories
(`path.delimiter`-separated — `:` on macOS/Linux, `;` on Windows) before running it, e.g.
`CLAUDE_REPO_SCAN_ROOTS=~/Code/Repositories node ~/.claude/hooks/test/verify-all.cjs`.
Unset, only this repo is reported on.

**A test counts only if you sabotage what it guards, watch it go red, and restore.** This
is not a slogan here. On 2026-09-21 a "finished run injects nothing" test passed while its
guard was deleted, because the case also satisfied a *different* condition. The sabotage
found it; the green suite had not. If you change a hook, break it deliberately first and
confirm the *right* test fails — every guard in this setup has been through that.
