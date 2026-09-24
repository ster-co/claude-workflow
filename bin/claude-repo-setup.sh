#!/usr/bin/env bash
# Per-repo Claude Code setup: Serena language servers, jsconfig, safety caps.
# Idempotent, and prints a diff before it writes anything.
#
#   claude-repo-setup.sh                      # dry-run on the current repo
#   claude-repo-setup.sh --write              # apply to the current repo
#   claude-repo-setup.sh --all ~/…/Repositories          # dry-run over every repo there
#   claude-repo-setup.sh --all ~/…/Repositories --write  # backfill the estate
#
# Flags:
#   --write     actually write (default is dry-run; nothing is touched without it)
#   --all DIR   iterate over every git repo under DIR, nested included
#   --jsconfig  write jsconfig.json for JS repos (off by default: it is a judgement
#               call per repo, see README "Global vs per-repo")
#   --serena-only  write ONLY .serena/project.yml. What the SessionStart hook uses:
#               .serena/ is gitignored globally, so writing it unattended in any
#               repository changes nothing a git status would show, while
#               .claude/settings.json is a tracked file in the repos that have one
#               and is not something to create in a repository nobody asked about.
#
# What it deliberately does NOT do: write CLAUDE.md (that is `/init`, and a
# generated one is worse than none), touch .gitignore, or commit anything.

set -uo pipefail

WRITE=0; ALL=""; DO_JSCONFIG=0; SERENA_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --write)    WRITE=1 ;;
    --all)      ALL="${2:-}"; shift ;;
    --jsconfig) DO_JSCONFIG=1 ;;
    --serena-only) SERENA_ONLY=1 ;;
    -h|--help)  awk 'NR==1{next} /^#/{print; next} {exit}' "$0"; exit 0 ;;
    *)          echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
act()  { if [ "$WRITE" = 1 ]; then printf '   \033[32mwrite\033[0m  %s\n' "$*"; else printf '   \033[33mwould\033[0m  %s\n' "$*"; fi; }

# Count source files per language, ignoring the usual noise. Used to decide which
# language servers are worth starting: an unused server is startup latency and a
# background process for nothing.
count_ext() {
  local root="$1"; shift
  local -a args=(); local first=1
  for e in "$@"; do
    if [ $first = 1 ]; then args+=( -name "*.$e" ); first=0; else args+=( -o -name "*.$e" ); fi
  done
  find "$root" \
    \( -name .git -o -name node_modules -o -name .venv -o -name venv \
       -o -name __pycache__ -o -name dist -o -name build \
       -o -name site-packages -o -name .mypy_cache -o -name .pytest_cache \
       -o -name .serena -o -name .claude \) -prune \
    -o -type f \( "${args[@]}" \) -print 2>/dev/null | wc -l | tr -d ' '
}

setup_repo() {
  local root="$1"
  local name; name="$(basename "$root")"
  say ""
  say "=== $name"

  local n_py n_ts n_js n_yaml n_cs n_nb
  n_py=$(count_ext   "$root" py)
  n_ts=$(count_ext   "$root" ts tsx)
  n_js=$(count_ext   "$root" js jsx mjs cjs)
  n_yaml=$(count_ext "$root" yml yaml)
  n_cs=$(count_ext   "$root" cs)
  n_nb=$(count_ext   "$root" ipynb)
  note "files: py=$n_py ts=$n_ts js=$n_js yaml=$n_yaml cs=$n_cs ipynb=$n_nb"

  # ---- 1. Serena language servers -----------------------------------------
  # Serena ships python-only and reports every other language as "ignored"
  # rather than failing, so a repo without this silently answers JS/TS
  # questions with nothing. The threshold is deliberately low but non-zero:
  # one stray .yml in a Python repo is not a reason to start a yaml server.
  local -a servers=()
  [ "$n_py"   -gt 0  ] && servers+=("python")
  # One typescript server serves both .ts and .js — Serena has no separate
  # javascript id.
  { [ "$n_ts" -gt 0 ] || [ "$n_js" -gt 0 ]; } && servers+=("typescript")
  [ "$n_yaml" -ge 10 ] && servers+=("yaml")
  [ "$n_cs"   -gt 0  ] && servers+=("csharp")

  if [ ${#servers[@]} -eq 0 ]; then
    note "no supported language detected — skipping Serena config"
  else
    local yml="$root/.serena/project.yml"
    local desired; desired=$(printf 'language_servers:\n'; for s in "${servers[@]}"; do printf -- '- %s\n' "$s"; done)
    local current=""
    [ -f "$yml" ] && current=$(awk '/^language_servers:/{f=1;print;next} f&&/^- /{print;next} f{exit}' "$yml")

    if [ "$current" = "$desired" ]; then
      note "serena language_servers already ${servers[*]}"
    else
      act "serena language_servers -> ${servers[*]}  ($yml)"
      if [ "$WRITE" = 1 ]; then
        mkdir -p "$root/.serena"
        if [ -f "$yml" ]; then
          # Replace the existing block in place; everything else in the file
          # (ignored_paths, read_only, modes) is the user's and stays.
          python3 - "$yml" "${servers[@]}" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1]); servers = sys.argv[2:]
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
out, i, replaced = [], 0, False
while i < len(lines):
    if lines[i].startswith("language_servers:"):
        out.append("language_servers:\n")
        out.extend(f"- {s}\n" for s in servers)
        i += 1
        while i < len(lines) and (lines[i].startswith("- ") or lines[i].strip() == ""):
            if lines[i].strip() == "":
                break
            i += 1
        replaced = True
        continue
    out.append(lines[i]); i += 1
if not replaced:
    out.append("\nlanguage_servers:\n")
    out.extend(f"- {s}\n" for s in servers)
path.write_text("".join(out), encoding="utf-8")
PY
        else
          {
            printf 'project_name: "%s"\n\n' "$name"
            printf 'language_servers:\n'
            for s in "${servers[@]}"; do printf -- '- %s\n' "$s"; done
            printf '\nignore_all_files_in_gitignore: true\n'
          } > "$yml"
        fi
      fi
    fi
  fi

  if [ "$SERENA_ONLY" = 1 ]; then return 0; fi

  # ---- 2. jsconfig.json ----------------------------------------------------
  # Only for repos with plain JS and no existing manifest: with a package.json
  # or tsconfig.json the editor and the TS server already know the module
  # layout, and a second manifest just competes with the first.
  if [ "$DO_JSCONFIG" = 1 ] && [ "$n_js" -gt 0 ] \
     && [ ! -f "$root/jsconfig.json" ] && [ ! -f "$root/tsconfig.json" ] && [ ! -f "$root/package.json" ]; then
    act "jsconfig.json (plain-JS repo, no existing manifest)"
    if [ "$WRITE" = 1 ]; then
      cat > "$root/jsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,
    "module": "es2022",
    "target": "es2022",
    "moduleResolution": "bundler"
  },
  "include": ["**/*.js"]
}
JSON
    fi
  fi

  # ---- 3. Repo safety caps -------------------------------------------------
  # Committed on purpose: these bound what any agent run in this repo can spawn,
  # and a teammate cloning it should inherit that bound. Never overwritten — a
  # repo that already has one has made its own choices.
  if [ -f "$root/.claude/settings.json" ]; then
    note ".claude/settings.json exists — left alone"
  else
    act ".claude/settings.json (concurrency 4, depth 2, small workflows)"
    if [ "$WRITE" = 1 ]; then
      mkdir -p "$root/.claude"
      cat > "$root/.claude/settings.json" <<'JSON'
{
  "env": {
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "4",
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "2"
  },
  "workflowSizeGuideline": "small"
}
JSON
    fi
  fi

  # ---- 4. What the script cannot decide ------------------------------------
  [ -f "$root/CLAUDE.md" ] || note "NO CLAUDE.md — run /init in a session started here"
}

if [ -n "$ALL" ]; then
  [ -d "$ALL" ] || { echo "not a directory: $ALL" >&2; exit 1; }
  # Nested, not just one level: ~/Code/Repositories/Some Project/Sub-Five is two
  # deep, and a "$ALL"/*/ glob never sees it. -name .git matches the directory and
  # the file a linked worktree uses, which is what the old -e test was for.
  while IFS= read -r g; do
    setup_repo "${g%/.git}"
  done < <(find "$ALL" -maxdepth 5 \
            \( -name node_modules -o -name .venv -o -name venv \
               -o -name dist -o -name build -o -name .next \) -prune -o \
            -name .git -print 2>/dev/null | sort)
else
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not in a git repo" >&2; exit 1; }
  setup_repo "$root"
fi

say ""
[ "$WRITE" = 1 ] || say "Dry run. Nothing was written. Re-run with --write to apply."
