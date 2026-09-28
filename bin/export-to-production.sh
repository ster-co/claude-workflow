#!/usr/bin/env bash
# Promote the playground to production.
#
# This repository is the playground: the working copy, with its own development
# history in docs/plans and docs/briefs-*. ster-co/claude-workflow is what
# colleagues install. Promotion is a release, not a mirror -- it happens when
# the playground has been tested, not on every commit.
#
# The export is a SUBSET. docs/plans/ and docs/briefs-* are deliberately left
# behind: they are this repository's development record and they still carry
# absolute home paths and the retired indexer's name. Harmless here, wrong in
# something colleagues clone.
#
# Refuses to push if the export carries an absolute home path or a client name.
# That check is the point of the script: a promotion that would leak fails
# instead of shipping.
#
#   bin/export-to-production.sh            # build and check, do not push
#   bin/export-to-production.sh --push     # build, check, commit and push
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD_REMOTE="git@github.com:ster-co/claude-workflow.git"
STAGE="${TMPDIR:-/tmp}/claude-workflow-export.$$"
PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

# What a colleague needs. Everything else stays in the playground.
INCLUDE=(
  .claude-plugin commands agents skills hooks output-styles bin
  .mcp.json settings.json CLAUDE.md README.md SETUP.md .gitignore
)

say() { printf '%s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; rm -rf "$STAGE"; exit 1; }

say "== building the export =="
rm -rf "$STAGE"; mkdir -p "$STAGE"
for p in "${INCLUDE[@]}"; do
  [ -e "$REPO/$p" ] && cp -R "$REPO/$p" "$STAGE/"
done
mkdir -p "$STAGE/docs"
[ -f "$REPO/docs/CHEATSHEET.md" ] && cp "$REPO/docs/CHEATSHEET.md" "$STAGE/docs/"
[ -f "$REPO/docs/COMMANDS.md" ] && cp "$REPO/docs/COMMANDS.md" "$STAGE/docs/"
[ -f "$REPO/docs/WHY-THIS-WORKFLOW.md" ] && cp "$REPO/docs/WHY-THIS-WORKFLOW.md" "$STAGE/docs/"
# Anthropic's bundled skills ship with the app; they are not ours to distribute.
rm -rf "$STAGE/skills/synced"
find "$STAGE" -name .DS_Store -delete
# enabledPlugins is this machine's own plugin enablement, not something a colleague
# should inherit -- shipping it clobbers theirs if they ever copy settings.json
# wholesale instead of using SETUP.md's merge script (step 4b). Strip it here so the
# risk doesn't depend on which of the two documented paths a colleague picks.
[ -f "$STAGE/settings.json" ] && node -e "
  const fs = require('fs');
  const p = '$STAGE/settings.json';
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete s.enabledPlugins;
  // permissions.additionalDirectories names this machine's own directories (e.g. a
  // personal Coding folder) -- meaningless, and an absolute path pointing nowhere,
  // on a colleague's machine. Each colleague adds their own via /add-dir.
  if (s.permissions) delete s.permissions.additionalDirectories;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
"
say "   $(find "$STAGE" -type f | wc -l | tr -d ' ') files"

say "== refusing to ship anything that should not leave =="
# An absolute home path in a copied settings.json points a colleague's hooks at
# a directory that does not exist, and hook errors are non-blocking, so all of
# them fail silently while the plugin's own wiring keeps working.
# Patterns are assembled at runtime so this script's own source cannot match
# them -- otherwise the check fails on the file that implements it.
HOME_PAT="/Use""rs/|/ho""me/[a-z]"
if grep -rIlE "$HOME_PAT" "$STAGE" 2>/dev/null | grep -q .; then
  grep -rIlE "$HOME_PAT" "$STAGE" 2>/dev/null | sed "s|$STAGE|  |"
  die "absolute home paths in the export"
fi
# This repository was briefly public with client material in it.
CLIENT_PAT="ster""co|SD""B-|STA""BU|get""mail|offerte-""comparison|Doc""ling|PCF""Controls|Ster""Calendar"
if grep -rIilE "$CLIENT_PAT" "$STAGE" 2>/dev/null | grep -q .; then
  grep -rIilE "$CLIENT_PAT" "$STAGE" 2>/dev/null | sed "s|$STAGE|  |"
  die "client names in the export"
fi
OLD_PAT="git""nexus"
if grep -rIil "$OLD_PAT" "$STAGE" 2>/dev/null | grep -q .; then
  grep -rIil "$OLD_PAT" "$STAGE" 2>/dev/null | sed "s|$STAGE|  |"
  die "references to the retired indexer in the export"
fi
say "   no absolute paths, no client names"

# A release nobody can install is worse than no release: Claude Code pins a
# plugin to the version in plugin.json, so `claude plugin update` finds nothing
# when the field has not moved. Four promotions went out before this was
# noticed, each carrying real fixes that no installed copy ever received.
say "== the version must have moved since the last release =="
LOCAL_VER="$(node -e "process.stdout.write(require('$REPO/.claude-plugin/plugin.json').version)")"
# GitHub does not serve `git archive --remote`, so read production's manifest
# from a shallow clone. An unreadable remote must not silently pass the check.
PROBE="$STAGE.probe"
rm -rf "$PROBE"
REMOTE_VER=""
if git clone -q --depth 1 --filter=blob:none --no-checkout "$PROD_REMOTE" "$PROBE" 2>/dev/null; then
  REMOTE_VER="$(git -C "$PROBE" show HEAD:.claude-plugin/plugin.json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).version||'')}catch{}})" || true)"
  rm -rf "$PROBE"
else
  die "cannot read production's manifest -- refusing to release blind"
fi
if [ -z "$REMOTE_VER" ]; then
  say "   $LOCAL_VER (production has no manifest yet -- first release)"
elif [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
  die "plugin.json is still $LOCAL_VER, same as production -- bump it or nobody receives this release"
else
  say "   $LOCAL_VER (production has $REMOTE_VER)"
fi

say "== the plugin must still validate =="
( cd "$STAGE" && claude plugin validate . >/dev/null 2>&1 ) || die "claude plugin validate rejected the export"
say "   validate passed"

say "== the suite must pass from the export, not just from here =="
# The suites resolve their target from __dirname, so this genuinely exercises
# the exported tree rather than the live install.
( cd "$STAGE" && git init -q . && node hooks/test/verify-all.cjs >/dev/null 2>&1 ) \
  || die "the suite does not pass from the exported tree"
say "   suite passed"

if [ "$PUSH" = 0 ]; then
  say ""
  say "Built and checked, not pushed. Re-run with --push to release."
  say "Staged at: $STAGE"
  exit 0
fi

say "== pushing to production =="
cd "$STAGE"
git remote add origin "$PROD_REMOTE"
git fetch -q origin main 2>/dev/null && git reset -q --soft origin/main
git add -A
if git diff --cached --quiet; then
  say "   production already matches the playground; nothing to release."
  rm -rf "$STAGE"; exit 0
fi
git commit -q -m "Promote from playground

Exported subset of the configuration repository: the plugin manifests and the
commands, agents, skills and hooks a colleague installs. The playground's own
development history is deliberately left behind.

Checked before push: no absolute home paths, no client names, plugin manifest
validates, and the suite passes from the exported tree rather than from the
live install."
git push -q origin HEAD:main && say "   pushed"
rm -rf "$STAGE"
