# Setup: getting this workflow onto another machine

This is a procedure, not a tour. Follow the five numbered steps top to bottom. Each has
a command and a check — run the command, then run the check, and do not move on until
the check says what it should. If a check fails, the step above it is why.

Windows and macOS/Linux commands are both given wherever they differ.

## What has not been verified

**Nothing in this document has been run on an actual Windows machine.** The commands
below are either things run on this machine (macOS) while writing this document, or
quoted verbatim from a file in this repository — each command below says which. The
PowerShell behaviour specifically (the `PowerShell` tool-name matchers in `settings.json`,
the `pwsh` requirement below) is inferred from Claude Code's own hooks documentation and
from driving the gate scripts on macOS with `tool_name: "PowerShell"` payloads instead of
`"Bash"` — not from a real Windows install. A colleague on Windows is the first real test
of this document. If something here is wrong for Windows, that is expected until someone
runs it and reports back.

---

## Before you start: what this needs, and why

### Required binaries

| binary | why | source |
|---|---|---|
| `node` | every hook is a `.cjs` script Claude Code runs with `node` | run: `node --version` on this machine → `v22.21.1` |
| `git` | the gates key off `git rev-parse --show-toplevel`; `/land` pushes and diffs | run: `git --version` on this machine → `git version 2.54.0` |
| `uv` (`uvx`) | starts Serena, the MCP server the edit/commit gates depend on | `.mcp.json`'s comment: *"Requires `uvx` on PATH — this file ships the config, not the uv/uvx binary itself."* |
| `gh` | `commands/land.md` step 8 says "Open a PR" but never names a tool — opening a PR from the CLI is Claude Code's own convention for GitHub work, and there is nothing else installed here that can do it | inferred, not quoted — `land.md` itself is silent on the mechanism |

**Windows only, and unverified:** Serena's Roslyn language server (used for C#) is
*believed* to need PowerShell 7+ (`pwsh`) rather than the Windows PowerShell 5.1 that
ships with the OS. This comes from Serena's own docs, not from anything tested in this
repository — treat it as something to confirm, not a settled fact, and only relevant if
you work in C#.

### Plugins

**`superpowers` is automatic.** `.claude-plugin/plugin.json` declares it as a dependency:

```json
"dependencies": [{ "name": "superpowers", "marketplace": "claude-plugins-official" }]
```

— quoted verbatim from that file. A single `/plugin install workflow-discipline@ster-co`
pulls both. Four of `superpowers`' skills are what the commands actually call by name:
`brainstorming` (`commands/plan.md`, `commands/ship.md`, `commands/brainstorm.md`),
`systematic-debugging` (`commands/bug.md`), `writing-plans` (`commands/plan.md`,
`commands/brainstorm.md`), `finishing-a-development-branch` (`commands/land.md`). If one of
those commands behaves as though the skill does not exist, `superpowers` did not arrive —
check `/plugin` for it before looking anywhere else.

**Six more plugins are installed on this machine and are *not* declared dependencies:**
`pyright-lsp`, `typescript-lsp`, `playwright`, `azure`, `microsoft-docs`, `frontend-design`.
Checked directly — `grep -rn "mcp__" commands/ agents/ skills/workflow-discipline
skills/refactor` finds only `mcp__serena__*` names, nowhere else, so none of the six is
wired into `/ship`, `/plan`, `/execute`, `/brief`, or `/land`: the core loop runs without
them. That is a statement about what the *commands* call, not about whether the plugins are
worth having — this is the rest of the working toolset, in regular day-to-day use on this
machine, and a colleague who wants parity with the operator's own setup should take all six,
not skip them as niche:

- `microsoft-docs` — ships the `microsoft-learn` MCP server (HTTP,
  `https://learn.microsoft.com/api/mcp`) plus three skills
  (`microsoft-code-reference`, `microsoft-docs`, `microsoft-skill-creator`). This is what
  backs the "check current documentation" rule in `CLAUDE.md` directly, so treat it as
  load-bearing rather than optional.
- `azure` — ships an `azure` MCP server (`npx -y @azure/mcp@latest server start`) plus 28
  skills covering AKS, App Service, Functions, Cosmos DB, storage, cost, diagnostics, and
  more. Verified by counting the `skills/` subdirectories in the installed plugin cache.
- `pyright-lsp` / `typescript-lsp` — language servers giving diagnostics beyond what Serena
  provides for the gates; Serena alone already satisfies the edit gate, so these are extra
  signal, not a requirement.
- `playwright` — drives a real browser. `CLAUDE.md` has a rule for exactly this: *"For
  anything with a UI, drive a real browser. A DOM assertion is not evidence."* That rule is
  what this plugin backs, so it is load-bearing for UI work rather than a nice-to-have.
- `frontend-design` — guidance for visual and taste-driven design work; not referenced by
  any command, agent, or skill in this repository, but part of the operator's own toolset
  for that kind of work.

A colleague who wants the whole toolset, not just the core loop, installs all six:

```
/plugin install microsoft-docs@claude-plugins-official
/plugin install azure@claude-plugins-official
/plugin install pyright-lsp@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
/plugin install playwright@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
```

Or install individually, picking by what each gives you above — none of the six is required
for `/ship` to run, but two of them (`microsoft-docs`, `playwright`) back rules `CLAUDE.md`
states as musts.

### MCP servers

`serena` ships in `.mcp.json` and is required — see step 1.

**Correction to check before you read further:** a `grep -rn "mcp__" commands/ agents/
skills/workflow-discipline skills/refactor` (same command as above) turns up nothing named
`mcp__memory__`, `mcp__claude_browser__`, `mcp__computer*`, or `mcp__remote*`. Those
prefixes exist only in `skills/synced/` — Anthropic's own bundled global skills
(`computer-use`, `chrome-browser`, `built-in-browser`, `import-memory`) that ship with the
Claude Code app itself, on every account, independent of installing this plugin. Nothing
in `/ship`, `/plan`, `/execute`, `/brief`, or `/land` calls them. Whether they work for a
colleague depends on their own Claude Code app settings and entitlements (Settings →
Capabilities, computer use, connected browsers), not on anything in this setup.

---

## Step 1 — install `uv`, first

Without it, nothing downstream works, and nothing tells you loudly — it tells you exactly
once, in a `SessionStart` message you have to be looking for.

```
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Both commands are quoted verbatim from `hooks/repo-setup.cjs`'s own message text (see
`hooks/repo-setup.cjs`, the `uvxOnPath()` failure branch) and from `README.md`.

**Check:**

```
uvx --version
```

expect something like `uvx 0.11.21 (...)` — any version string, not an error.

**Why this is first, not step 3 or 4:** `hooks/repo-setup.cjs` runs on every `SessionStart`
and checks for `uvx` on `PATH` before it writes a repository's `.serena/project.yml`. Miss
it, and the hook writes nothing — not "writes a broken config", nothing at all — because
`.serena/project.yml` existing is exactly what `hooks/gates/gate-lib.cjs`'s `findGatedRoot`
checks to decide a repo is gated. No file, no gate, on any repository, ever, until a new
session starts with `uvx` reachable. This is proved in step 5, not asserted here.

---

## Step 2 — install the plugin

```
/plugin marketplace add ster-co/claude-workflow
/plugin install workflow-discipline@ster-co
```

The plugin name `workflow-discipline` and marketplace name `ster-co` are quoted
verbatim from `.claude-plugin/plugin.json` (`"name": "workflow-discipline"`) and
`.claude-plugin/marketplace.json` (`"name": "`ster-co`"`) — read, not typed from
memory. The repository is private to the `ster-co` organisation, so you need to be a member with
read access for `/plugin marketplace add` to reach it.

**Check:** `/plugin` lists `workflow-discipline@ster-co` and
`superpowers@claude-plugins-official` as installed — the second arrived automatically from
step 2's dependency declaration, not from a separate command.

---

## Step 3 — copy `settings.json` and `CLAUDE.md`

Both live at `~/.claude/` (`%USERPROFILE%\.claude\` on Windows). The operator of this
repository has confirmed overwriting a colleague's own copies of these two files is fine.

```
# macOS/Linux
cp settings.json ~/.claude/settings.json
cp CLAUDE.md ~/.claude/CLAUDE.md

# Windows
copy settings.json %USERPROFILE%\.claude\settings.json
copy CLAUDE.md %USERPROFILE%\.claude\CLAUDE.md
```

(Run from a checkout of this repository, or with `settings.json`/`CLAUDE.md` replaced by
their full paths.)

**What each brings:**

- `settings.json` carries the hook wiring (`PreToolUse`, `PostToolUse`, `SessionStart`,
  `Stop`, `PreCompact`, `SubagentStart`/`Stop`, `UserPromptSubmit` — read directly from the
  file, see `hooks` key), the `Edit|Write|Bash|PowerShell` and `Bash|PowerShell` matchers
  that make the gates fire on Windows's PowerShell tool as well as Bash, and the
  effort/permission defaults (`"permissions": {"defaultMode": "auto"}`,
  `"effortLevel": "high"`). It also carries this operator's own `enabledPlugins` list
  (the seven named above) — a colleague who has not installed all seven will simply not
  have those extras enabled; nothing in the core loop needs them, per the plugins section
  above. **It also registers a third-party marketplace**, not just this operator's own
  plugin list — `settings.json`'s `extraKnownMarketplaces` points at
  `github.com/microsoft/skills`. Copying the file adds that source to a colleague's
  `/plugin marketplace` list, the same as the official one. Read directly from the cached
  copy of that repository: it is Microsoft's own catalogue of skills, agents and MCP
  configs for Azure SDKs and Microsoft AI Foundry (`azure-skills`, `azure-sdk-python`,
  `azure-sdk-dotnet`, `deep-wiki`, and more — 175 skills at last count, per that repo's own
  README). Registering the marketplace only makes its plugins installable; nothing from it
  is in `enabledPlugins`, so nothing installs merely by copying this file — a colleague
  would still run `/plugin install <name>@skills` to pull anything from it.
- `CLAUDE.md` restores the discipline as **always-on** context — every turn, not only the
  turns where a command pulls it in. A plugin cannot ship this file as project context; that
  channel does not exist in the plugin system. The `workflow-discipline` skill is the
  fallback a plugin-only install gets, loaded explicitly by `/ship` and `/plan` as the first
  thing they do — real coverage, but only on the turns those commands run. Copying the file
  is strictly better where you can do it.

**Check:** `cat ~/.claude/settings.json` shows your own copy's `hooks` key populated (not
empty), and `cat ~/.claude/CLAUDE.md` shows the "Operating style" section from this
repository's `CLAUDE.md`, not whatever was there before.

---

## Step 4 — restart Claude Code

Plugin `hooks/` and `.mcp.json` are read once at session start, not watched. A hook or MCP
config change from steps 2–3 has no effect on a session that was already running —
verbatim from `README.md`'s "Installing this as a plugin" section.

**Check:** start a brand-new session (not a resumed one) before step 5.

---

## Step 5 — verify it actually works

This is the step that matters. Files existing is not evidence; the gates firing is. Do
this in a **scratch git repository with one `.py` file** — not this repository, and not
one you care about.

```
mkdir /tmp/setup-check && cd /tmp/setup-check
git init
printf 'def greet(name):\n    return f"hello {name}"\n\ndef caller():\n    return greet("world")\n' > app.py
git add app.py && git commit -m init
```

**5a. Start a session in that directory.** Expect the session to open with a message
naming the file it created and the language server it chose — the literal text this
machine produced for an equivalent scratch repo:

> *"This repository had no Serena configuration. .serena/project.yml was created with
> language servers: python. Serena reads a project's configuration once when its server
> starts, so these servers are available from the next session rather than this one.
> .serena/ is gitignored, so this added nothing that git status reports."*

Confirm the file exists: `cat .serena/project.yml` should show `language_servers:` with
`- python` under it.

**5b. Try to edit `app.py` without looking anything up first** — ask Claude to change
`"hello {name}"` to `"hi {name}"` directly, with no prior tool call in that turn. Expect
the edit to be **denied**, with a reason naming the exact tool to call:

> *"No reference lookup has been run this turn, and app.py lives in setup-check. Find out
> what depends on the symbol you are about to change —
> `mcp__serena__find_referencing_symbols({name_path: "<symbol>", relative_path: "<file>"})`
> — report what it returns, then retry. ..."*

This is the literal `permissionDecisionReason` produced by driving `hooks/gates/edit-gate.cjs`
against an equivalent scratch repo on this machine.

**5c. Satisfy the gate properly.** Ask Claude to call
`mcp__serena__find_referencing_symbols` on `greet` (or just let it do this on its own once
denied — that is the point of the deny message). Then retry the same edit. Expect it to go
through this time with no denial.

**5d. If you skipped step 1**, 5a fails instead: the session-start message names `uvx`
directly and says the repository is **not gated** —

> *"This repository has files Serena could configure, but uvx is not on PATH, so
> .serena/project.yml was not written. This repository is therefore not gated: the edit
> and commit discipline hooks key on that file existing, and it does not. ..."*

— and `.serena/project.yml` does not exist. This was reproduced directly on this machine:
running `hooks/repo-setup.cjs` against a scratch repo with `PATH` stripped to nothing but
`git`, `node` and `which` (no `uvx`) produced exactly that message and wrote no file; the
same repo with a normal `PATH` produced the 5a message and did write the file. The
project's own regression suite covers the identical case —
`hooks/test/test-repo-setup.cjs`'s *"no config is written when uvx is not on PATH"* test,
built the same way (a `PATH` holding only `git`, `node`, and the platform's `which`/`where`,
symlinked in, with `uvx` genuinely absent rather than mocked as absent).

**5e. The automated suite** — only if you have a checkout of this repository, not from a
plugin-only install (a plugin install does not give you `hooks/test/`):

```
node ~/.claude/hooks/test/verify-all.cjs
```

Run on this machine just now: **7 suites, 359 passed, 0 failed, exit code 0.** Per-suite
counts were `68, 65, 87, 69, 24, 22, 24` (sums to 359); `verify-all.cjs` prints these seven
lines and no total.

| install shape | which check applies |
|---|---|
| plugin install only (`/plugin install`) | 5a–5d, in a scratch repo — this is the only check you have |
| full checkout of this repository | 5a–5d, plus 5e (`verify-all.cjs`) as a second, independent check |

---

## Summary: commands run here vs. quoted from a file

- **Run on this machine** while writing this document: `uvx --version`, `node --version`,
  `git --version`, `gh --version`, the full scratch-repo sequence in step 5 (both with a
  normal `PATH` and with `PATH` stripped to prove step 5d), and
  `node ~/.claude/hooks/test/verify-all.cjs`.
- **Quoted from a file, not run by this document's author on Windows:** the `uv` installer
  commands (from `hooks/repo-setup.cjs` and `README.md`), the `/plugin marketplace add` /
  `/plugin install` commands (names read from `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`, but the install itself not run — installing plugins is
  outside what this document's author is permitted to do on this machine), and everything
  marked unverified above.
