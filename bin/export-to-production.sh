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
# Anthropic's bundled skills ship with the app; they are not ours to distribute.
rm -rf "$STAGE/skills/synced"
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
