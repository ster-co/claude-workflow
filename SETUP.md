# Setup

Installs the `workflow-discipline` plugin and its supporting pieces on a new machine.
Takes about fifteen minutes. Do the steps in order: each ends with a **Check**, and a
failed check means the step it belongs to is not done — fix that before moving on.

Windows (PowerShell) and macOS/Linux commands are both given wherever they differ.
Windows commands have not yet been run on a real Windows machine — see
[What has and has not been verified](#what-has-and-has-not-been-verified).

**Checklist**

1. [Install the four tools](#step-1--install-the-four-tools): `node`, `git`, `gh`, `uv`
2. [Give git access to GitHub](#step-2--give-git-access-to-github) (HTTPS via `gh`, or SSH)
3. [Install the plugin](#step-3--install-the-plugin)
4. [Copy `CLAUDE.md`, merge the settings, ignore `.serena/`](#step-4--copy-claudemd-merge-the-settings-ignore-serena)
5. [Restart Claude Code / reload VS Code](#step-5--restart-claude-code--reload-vs-code)
6. [Open a git repository](#step-6--open-a-git-repository)
7. [Prove the gates fire](#step-7--prove-the-gates-fire)

---

## Step 1 — install the four tools

| tool | why |
|---|---|
| `node` | every hook is a `.cjs` script run with `node` |
| `git` | the setup hook and the gates find a repository with `git rev-parse --show-toplevel`; `/land` diffs and pushes |
| `uv` (provides `uvx`) | starts Serena, the code-intelligence server the edit gate depends on |
| `gh` | **optional.** Nothing in the workflow calls it — `git grep gh` across `commands/`, `agents/`, `hooks/` and `skills/` returns nothing. `commands/land.md:74` says only "Open a PR" and names no tool. It is a convenience for two things: logging in to GitHub in step 2 (Git Credential Manager does the same on Windows) and opening the pull request at the end of `/land` instead of clicking the compare link git prints on push |

Check what you already have — install only what is missing:

```
node --version
git --version
gh --version
uvx --version
```

```
# Windows (winget ships with Windows 10/11)
winget install OpenJS.NodeJS
winget install Git.Git
winget install GitHub.cli
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS (Homebrew)
brew install node git gh
curl -LsSf https://astral.sh/uv/install.sh | sh

# Debian/Ubuntu
sudo apt install -y nodejs git
# gh needs its own apt repository: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Then close every terminal and open a new one** — and if you use VS Code, quit it fully
and reopen it (VS Code's integrated terminal and the Claude Code extension inherit `PATH`
from when VS Code started). An installer that edits `PATH` does not change processes that
were already running, and a `uvx` that is installed but not on `PATH` fails exactly like
one that is not installed.

**Check:** all four `--version` commands print a version, not an error, in a *new* terminal.

**Do not skip `uv`.** Without `uvx`, the setup hook refuses to configure any repository
(it would point the gates at a server that cannot start), so nothing is ever gated. It
does say so — but only once, at session start, in context you have to ask Claude about.

**Windows, C# only, unverified:** Serena's C# language server is believed to need
PowerShell 7+ (`pwsh`) rather than the built-in Windows PowerShell 5.1. Only relevant if
you work in C#; confirm against Serena's docs before relying on it.

---

## Step 2 — give git access to GitHub

The plugin lives in a **private** repository, `ster-co/claude-workflow`. You need to be a
member of the `ster-co` organisation with read access, and git on your machine needs to be
able to authenticate to GitHub. Pick **one** of the two routes.

### Route A — HTTPS (simplest, recommended)

**On Windows, try nothing first.** Git for Windows bundles Git Credential Manager, which
opens a browser login the first time git needs credentials. So just run step 2's
`claude plugin marketplace add` and let it prompt you. If it succeeds, you are done — skip
to step 3.

If it does not prompt, or fails, authenticate explicitly with `gh`:

```
gh auth login
```

Answer: `GitHub.com` → protocol **HTTPS** → **Yes** to "Authenticate Git with your GitHub
credentials" → log in with a web browser.

**If `gh auth login` itself fails** — the interactive prompt does not render in every
console, notably inside an editor's integrated terminal — use a token instead. Create a
*classic* personal access token at <https://github.com/settings/tokens> with scopes `repo`,
`read:org` and `gist` (the minimum `gh` documents), then:

```
# PowerShell, persisted for your user
[Environment]::SetEnvironmentVariable("GH_TOKEN","<your token>","User")
```

Open a new terminal and check with `gh auth status`. Use a classic token rather than a
fine-grained one: `gh`'s own help warns that fine-grained tokens behave confusingly when
passed to `--with-token`.

**Check:**

```
gh auth status
git ls-remote https://github.com/ster-co/claude-workflow.git HEAD
```

The second command prints one line (a commit hash and `HEAD`). An authentication error or
"Repository not found" means either the login did not take or your account has no access
to the repository — ask for access before going further.

### Route B — SSH (optional; for people who already use SSH, or whose network or org requires it)

Use this if you already clone with `git@github.com:...` URLs, if HTTPS to GitHub is blocked
on your network, or if you simply prefer keys over tokens.

The easy way is still `gh`, which can generate and upload the key for you:

```
gh auth login
```

Answer: `GitHub.com` → protocol **SSH** → **Generate a new SSH key** (or pick an existing
`~/.ssh/id_ed25519.pub`) → log in with a web browser. `gh` uploads the public key to your
GitHub account.

By hand instead:

```
# macOS/Linux and Windows (OpenSSH ships with Windows 10/11)
ssh-keygen -t ed25519 -C "you@example.com"
# accept the default file location; a passphrase is recommended
```

Then add the **public** key (`~/.ssh/id_ed25519.pub`, on Windows
`%USERPROFILE%\.ssh\id_ed25519.pub`) at GitHub → Settings → SSH and GPG keys → New SSH key,
or with `gh ssh-key add ~/.ssh/id_ed25519.pub`.

If you set a passphrase, load the key into an agent so you are not asked on every fetch:

```
# macOS
ssh-add --apple-use-keychain ~/.ssh/id_ed25519

# Linux
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519

# Windows (PowerShell as Administrator, once)
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

**If the organisation uses SAML single sign-on**, a key is not usable for `ster-co`
repositories until you authorise it: GitHub → Settings → SSH and GPG keys → **Configure
SSO** next to the key → Authorize for `ster-co`. The symptom of skipping this is
"Repository not found" or a permission error, even though `ssh -T` below succeeds.

**Check:**

```
ssh -T git@github.com
git ls-remote git@github.com:ster-co/claude-workflow.git HEAD
```

The first prints `Hi <your-username>! You've successfully authenticated...` (it exits
non-zero — that is normal for this command). The second prints one line with a commit
hash.

With SSH, install the marketplace in step 3 using the SSH URL rather than the shorthand.

---

## Step 3 — install the plugin

Run these inside Claude Code — in the terminal (`claude`) or in the VS Code extension's
chat box:

```
/plugin marketplace add ster-co/claude-workflow
/plugin install workflow-discipline@ster-co
```

If you chose SSH in step 2, add the marketplace by its SSH URL instead:

```
/plugin marketplace add git@github.com:ster-co/claude-workflow.git
/plugin install workflow-discipline@ster-co
```

`superpowers` is installed automatically as a dependency — `.claude-plugin/plugin.json`
declares it. You do not install it separately.

**Check:** `/plugin` lists both `workflow-discipline@ster-co` and
`superpowers@claude-plugins-official` as installed and enabled. If
`/plugin marketplace add` fails with an authentication or "not found" error, step 2 is not
done: rerun its check.

**Updating later:** from a terminal, `claude plugin marketplace update ster-co` then
`claude plugin update workflow-discipline@ster-co`, then repeat step 4a — the plugin update
refreshes the downloaded repository but not the `CLAUDE.md` you copied out of it — then a
new session (step 5).

---

## Step 4 — copy `CLAUDE.md`, merge the settings, ignore `.serena/`

Step 3 already downloaded the whole repository to
`~/.claude/plugins/marketplaces/ster-co/` (`%USERPROFILE%\.claude\plugins\marketplaces\ster-co\`
on Windows). You do not need to clone it. Three things to do from there.

### 4a. Copy `CLAUDE.md`

This makes the working rules **always-on** context in every session. A plugin cannot ship
that — the `workflow-discipline` skill is the fallback, but it is only loaded on the turns
one of six commands runs (`/ship`, `/blueprint`, `/diagnose`, `/brief`, `/execute`,
`/land`). This overwrites any `~/.claude/CLAUDE.md` you already have; back yours up first if
you care about it. Repeat this step after every plugin update, or your copy stays at the
version you first installed.

```
# macOS/Linux
cp ~/.claude/plugins/marketplaces/ster-co/CLAUDE.md ~/.claude/CLAUDE.md

# Windows (PowerShell)
copy "$env:USERPROFILE\.claude\plugins\marketplaces\ster-co\CLAUDE.md" "$env:USERPROFILE\.claude\CLAUDE.md"
```

### 4b. Merge the settings — do not copy `settings.json` over yours

The repository's `settings.json` is the author's own. Its `hooks` block wires every hook to
`~/.claude/hooks/...`, which exists on the author's machine and **not on yours** — on
yours the plugin already runs the same hooks from its own install directory. Copying the
file wholesale would add seventeen hooks pointing at files that do not exist, and would
also replace the `enabledPlugins` list that step 3 just wrote, switching the plugin off.

Instead, this merges everything else (permission mode `auto`, effort `high`, the `Concise`
output style, attribution off, and the author's other preferences) into your own file,
drops `hooks`, and keeps your `enabledPlugins` as they are. It is the same command on
every platform — it uses `node`, which step 1 installed:

```
node -e "const fs=require('fs'),path=require('path'),os=require('os');const dir=path.join(os.homedir(),'.claude');const src=JSON.parse(fs.readFileSync(path.join(dir,'plugins','marketplaces','ster-co','settings.json'),'utf8'));const file=path.join(dir,'settings.json');let own={};try{own=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}delete src.hooks;const out={...own,...src,enabledPlugins:own.enabledPlugins,extraKnownMarketplaces:{...own.extraKnownMarketplaces,...src.extraKnownMarketplaces}};fs.writeFileSync(file,JSON.stringify(out,null,2)+'\n');console.log('merged into '+file)"
```

It prints `merged into <path>/settings.json`.

The merge also registers one extra marketplace, `skills` (`github.com/microsoft/skills`,
Microsoft's catalogue of Azure SDK and Foundry skills). Registering only makes its plugins
installable; nothing from it is installed.

### 4c. Make git ignore `.serena/` everywhere

The setup hook writes a `.serena/` folder into each repository you open. It must never be
committed, and on the author's machine a global git ignore rule guarantees that. Yours
does not have that rule yet. This adds it to whichever global ignore file git already
uses (or git's default one), and does nothing if the line is already there:

```
# macOS/Linux
f=$(git config --global --path core.excludesFile || echo "$HOME/.config/git/ignore")
mkdir -p "$(dirname "$f")"
grep -qxF '.serena/' "$f" 2>/dev/null || echo '.serena/' >> "$f"

# Windows (PowerShell)
$f = git config --global --path core.excludesFile
if (-not $f) { $f = "$env:USERPROFILE\.config\git\ignore" }
New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
if (-not (Select-String -Quiet -SimpleMatch -Pattern '.serena/' -Path $f -ErrorAction SilentlyContinue)) { Add-Content $f '.serena/' }
```

Do not point `core.excludesFile` somewhere new to do this: Claude Code writes its own
`**/.claude/settings.local.json` rule into whichever file is in effect, and moving it
orphans that rule.

**Check (all of step 4):**

```
# the rules file is in place
head -5 ~/.claude/CLAUDE.md                      # shows "# Global instructions"

# settings merged without hooks, plugin still enabled
node -e "const s=require(require('os').homedir()+'/.claude/settings.json');console.log('stale hooks:',JSON.stringify(s.hooks||{}).includes('.claude/hooks/')?'YES - see Troubleshooting':'none');console.log(s.enabledPlugins)"

# .serena/ is ignored (run inside any git repository)
git check-ignore -v .serena/project.yml          # prints the ignore file and ".serena/"
```

It must print `stale hooks: none`, and `enabledPlugins` must include
`workflow-discipline@ster-co: true`.

---

## Step 5 — restart Claude Code / reload VS Code

Hooks, plugins and MCP servers are read **once, when a session starts**. Nothing you
installed or changed in steps 3–4 affects a session that was already running.

- **Terminal:** exit every running `claude` (`/exit` or Ctrl+D) and start a new one.
  Start fresh — not `claude --resume` or `claude --continue`.
- **VS Code:** open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P) → **Developer: Reload
  Window**. Then start a **new** conversation in the Claude Code panel rather than
  continuing an old one. (For a plugin change alone, a new conversation is enough — plugin
  changes apply to conversations started afterwards. After installing a tool in step 1,
  quit and reopen VS Code entirely: a reload does not pick up a new `PATH`.)

**The same rule applies later:** any time you install or update a plugin, change
`settings.json`, or open a repository for the first time (step 6), start a new session. If
something "should work" but doesn't, a new session is the first thing to try.

**Check:** in the new session, `/mcp` lists `serena` as connected. The very first time
this can take a minute or so — `uv` is downloading Serena. If it stays failed, see
[Troubleshooting](#troubleshooting).

What `serena` runs is `bin/serena-relay.cjs`, a small Node relay, not Serena itself. The
relay joins the repository's shared Serena if one is running, or starts it. So every
session in the same repository shares one Serena and one set of language servers instead
of starting its own. It stops when the last session using it closes — which, with routing
(below), may be a session in another repository, and can be before any session has
started in the repository whose Serena it is: a lookup routed there from elsewhere can
start it first, and that server then outlives the session that started it for as long as
any other session using it still does.

The relay also works outside the session's own repository: a lookup whose `relative_path`
is an absolute path — into a `/ship` worktree or a different repository altogether — is
routed to that repository's own shared Serena, joined, or started if none is running, and
its result is relative to that repository's root, not the session's. A path with no `.git`
or `.serena/project.yml` above it is refused with an error instead: falling back to the
directory itself would give a Serena to `/`, `/tmp` or `~/Downloads`, which then idles for
the rest of the session.

**Without the plugin** (this repository checked out as `~/.claude`, which is how the author
runs it), every session gets Serena from a user-scope entry, including sessions in this
repository. The repository's own `.mcp.json` deliberately declares no `serena`, so **a
clone with neither the plugin nor this user-scope entry has no Serena at all**, and the
edit gate's reference lookups cannot run. Add the entry from a shell, so that the shell
expands `~`; JSON args are not expanded. If an older user-scope `serena` entry exists,
remove it first with `claude mcp remove serena -s user`.

```
# macOS/Linux
claude mcp add serena -s user -- node ~/.claude/bin/serena-relay.cjs
# Windows (PowerShell)
claude mcp add serena -s user -- node $HOME\.claude\bin\serena-relay.cjs
```

---

## Step 6 — open a git repository

**The discipline only switches on inside a git repository.** At session start the setup
hook asks git for the repository root; if the folder is not inside a git repository, it
does nothing, no `.serena/project.yml` is written, and the edit and commit gates never
fire. The slash commands (`/ship`, `/blueprint`, `/land`, …) still load, but nothing is
enforced and Serena has no project to index.

Three rules follow from that:

1. **Open the repository folder itself** — in VS Code, *File → Open Folder…* on the folder
   that contains `.git`. A parent folder holding several repositories is not itself a
   repository, and a session there configures nothing.
2. **The repository needs source files the hook recognises:** any `.py`, any
   `.ts/.tsx/.js/.jsx/.mjs/.cjs`, any `.cs`, or ten or more `.yml/.yaml`. A docs-only or
   empty repository is left alone, silently. Add code and the next session configures it.
3. **A folder that isn't a repository yet can be made into one** — locally, no GitHub
   needed:

   ```
   cd path/to/your/project
   git init
   git add -A
   git commit -m "Initial commit"
   ```

   If `git commit` complains that it does not know who you are, set your name and email
   once: `git config --global user.name "Your Name"` and
   `git config --global user.email "you@example.com"`. A GitHub remote can be added later
   (`gh repo create`, or `git remote add origin <url>`); nothing here needs one, except
   `/land`, which pushes and opens a PR.

### What happens, session by session

**First session in a repository.** The setup hook sees no `.serena/project.yml`, counts the
file types, and writes one listing the language servers it chose (for example `python`,
`typescript`). It reports this to Claude — not to you; you will not see a banner. To see
it, ask: *"What did the SessionStart hook say about Serena?"* Or just look:

```
cat .serena/project.yml        # Windows: type .serena\project.yml
```

Serena reads that file only when its server starts, and the repository's shared Serena
server may already be running. So after writing the file, the hook stops that server. The
session's next Serena call starts a new one, which reads the file. There is no second session
to open.

**This is what "working" looks like, from the first session on:**

- `/mcp` shows `serena` connected.
- Serena's dashboard is at <http://localhost:24282/dashboard/>. There is one dashboard per
  repository, not per session, because sessions in one repository share one Serena. Each
  additional repository with a shared Serena running at the same time takes the next free
  port up: 24283, 24284, and so on — including a repository with no session of its own,
  reached only because a session elsewhere routed a lookup into it. It does **not** open a
  browser tab by itself; that is deliberate.
- `.serena/project.yml` exists and `git status` does not show `.serena/` (step 4c).
- When Claude goes to edit a source file without first checking what depends on it, the
  edit is **denied** with a message naming `mcp__serena__find_referencing_symbols`. Claude
  then runs that lookup and retries. This deny-lookup-retry loop is the system working, not
  an error — you will see it regularly.
- Committing is similarly gated: Claude has to run `git diff` in the same turn before
  `git commit` goes through (`git status` does not count).

If you open the same repository again later, nothing is rewritten — an existing
`.serena/project.yml` is never touched. If the repository's languages change a lot
(say a Python repo gains a TypeScript frontend), delete `.serena/project.yml` and start a
new session to regenerate it — the file is local and git-ignored, so nothing is lost.

---

## Step 7 — prove the gates fire

Files existing is not evidence; a denied edit is. Do this once, in a throwaway repository —
not one you care about.

```
# macOS/Linux
mkdir -p /tmp/setup-check && cd /tmp/setup-check
# Windows (PowerShell)
mkdir $env:TEMP\setup-check; cd $env:TEMP\setup-check

git init
```

Create `app.py` with this content:

```python
def greet(name):
    return f"hello {name}"

def caller():
    return greet("world")
```

```
git add app.py
git commit -m init
```

**7a. First session.** Start Claude Code in that folder (`claude`, or *File → Open
Folder…* in VS Code and a new conversation). Check `.serena/project.yml` now exists and
lists `- python` under `language_servers:`.

**7b. Edit without looking first.** In that same session, ask Claude to change
`"hello {name}"` to `"hi {name}"`. Expect the first edit attempt to be **denied**, with a
reason like:

> *No reference lookup has been run this turn in setup-check, the repository app.py lives
> in; a lookup in another repository does not count. Find out what depends on the symbol
> you are about to change — call Serena's "find referencing symbols" tool
> (`{name_path: "<symbol>", relative_path: "<file>"}`) — report what it returns, then
> retry. ...*

**7c. Let it recover.** Claude should call `find_referencing_symbols` on `greet` (finding
`caller`) and retry — and the edit goes through.

If 7a produced no `.serena/project.yml`, or 7b's edit went through with no denial, the
setup is not working: see Troubleshooting.

Delete `setup-check` afterwards.

---

## Troubleshooting

| symptom | likely cause | fix |
|---|---|---|
| `/plugin marketplace add` fails with an auth error or "not found" | git cannot reach the private repo | step 2's check; with SSH, check SSO authorisation and use the SSH URL |
| `/plugin` doesn't list `workflow-discipline` as enabled | `settings.json` was overwritten after install | `claude plugin enable workflow-discipline@ster-co`; use step 4b, not a plain copy |
| hook errors mentioning `.claude/hooks/...cjs` / "Cannot find module", or `stale hooks: YES` in step 4's check | `settings.json` was copied wholesale, so it has the author's `hooks` block | delete the `hooks` block from `~/.claude/settings.json` by hand (4b's merge keeps hooks already in your file), then `claude plugin enable workflow-discipline@ster-co` |
| no `.serena/project.yml` after a session | not in a git repo; no recognised source files; or `uvx` not on `PATH` | step 6 rules; `uvx --version` in a *new* terminal; ask Claude what the SessionStart hook reported |
| `/mcp` shows `serena` failed | `node` or `uv` missing from the `PATH` Claude Code started with, or, without the plugin, the user-scope relay path is wrong | fully quit and reopen VS Code / the terminal after installing node/uv; without the plugin, check `claude mcp list` shows an absolute path ending in `.claude/bin/serena-relay.cjs` (`.claude\bin\serena-relay.cjs` on Windows) with no literal `~` — if it has one, re-add the entry with step 5 |
| edits are never denied | repo not configured (above), or the plugin's hooks are not loaded | check `.serena/project.yml`; `/hooks` should list `edit-gate.cjs` under `PreToolUse`; start a new session |
| every edit is denied, even after a lookup | Serena not connected, so the lookup never succeeds | `/mcp`; start a new session |
| `git status` shows `.serena/` | step 4c not done | run 4c |
| a change to the plugin or settings "does nothing" | old session still running | new session (step 5) |
| a command acts as if `brainstorming` or `systematic-debugging` doesn't exist | `superpowers` did not install | `/plugin` — install `superpowers@claude-plugins-official` |

Two environment-variable escape hatches: `CLAUDE_NO_AUTO_REPO_SETUP=1` stops the setup hook
writing `.serena/project.yml` (for a repository where you do not want Serena at all) — the
relay (`bin/serena-relay.cjs`) honours the same variable before it writes one for a
repository the hook never ran in — and `SKIP_CODE_GATES=1` switches the edit and commit
gates off. Both are for exceptions, not for making a denial go away.

---

## Optional: the rest of the author's toolset

None of these is needed for `/ship`, `/blueprint`, `/execute`, `/brief` or `/land` — no command,
agent or skill in this repository calls them. They are the rest of the author's day-to-day
setup; two of them back rules in `CLAUDE.md` directly.

| plugin | what it gives you |
|---|---|
| `microsoft-docs` | the Microsoft Learn MCP server and three skills; backs `CLAUDE.md`'s "check current documentation" rule — **recommended** |
| `playwright` | drives a real browser; backs `CLAUDE.md`'s "for anything with a UI, drive a real browser" rule — **recommended** for UI work |
| `azure` | an Azure MCP server plus skills for AKS, App Service, Functions, Cosmos DB, storage, cost, diagnostics |
| `pyright-lsp`, `typescript-lsp` | extra diagnostics beyond Serena; not needed for the gates |
| `frontend-design` | guidance for visual design work |

```
/plugin install microsoft-docs@claude-plugins-official
/plugin install playwright@claude-plugins-official
/plugin install azure@claude-plugins-official
/plugin install pyright-lsp@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
```

Start a new session afterwards.

Skills such as `computer-use`, `chrome-browser` and `import-memory` ship with the Claude
Code app itself, not with this plugin; whether they work depends on your own Claude Code
settings and account, not on anything here.

---

## Running the test suite (checkout only)

A plugin install has no `hooks/test/`; step 7 is your check. With a full checkout of this
repository at `~/.claude`:

```
node ~/.claude/hooks/test/verify-all.cjs
```

It prints one pass/fail line per suite; exit code 0 means every suite passed.

---

## What has and has not been verified

- **Run on macOS** while writing this document: the version checks in step 1, the scratch
  repository in step 7 (including the `uvx`-missing case, where the hook writes no config
  and reports the repository as not gated), the settings merge in step 4b and the ignore
  rule in step 4c (both against a throwaway home directory), and the Serena dashboard
  port.
- **Quoted, not run here:** the `uv` installer commands (from `hooks/repo-setup.cjs`'s own
  message), the plugin install commands (names read from `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`; the install itself has not been run on this machine,
  which is the source rather than an install).
- **Not run on Windows at all.** Every PowerShell command here, and the PowerShell
  tool-name matchers in the plugin's hooks, come from Claude Code's documentation and from
  driving the gate scripts on macOS with PowerShell-shaped input. The first colleague on
  Windows is the real test; if something is wrong, report it.
