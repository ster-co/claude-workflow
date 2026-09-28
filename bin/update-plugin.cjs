#!/usr/bin/env node
// Runs every step SETUP.md's "Updating" section calls for, in one command,
// on any platform. The section used to hand people four separate
// commands -- two `claude` invocations plus a `cp`/`copy` and a `node -e`
// one-liner with hand-escaped backslashes for the stale-hooks check -- and a
// colleague's PowerShell paste of the copy step broke on quoting he never
// wrote. Node runs identically under bash, zsh and PowerShell without any of
// that, which is why the rest of this repo's cross-platform checks already
// go through `node -e` rather than shell syntax; this just moves the whole
// sequence into a real script instead of a string a shell has to re-parse.
//
// Run: node ~/.claude/plugins/marketplaces/ster-co/bin/update-plugin.cjs
//      (Windows: node $env:USERPROFILE\.claude\plugins\marketplaces\ster-co\bin\update-plugin.cjs)
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Matches settings.json's `hooks` block wired to the pre-versioned-cache
// `~/.claude/hooks/...` layout, on either path-separator style -- see
// SETUP.md step 4's check for why this needs both.
const STALE_HOOKS_PATTERN = /\.claude[\\/]+hooks[\\/]+/;

function isStaleHooksBlock(hooks) {
  return STALE_HOOKS_PATTERN.test(JSON.stringify(hooks || {}));
}

// Runs the two `claude` CLI update commands. Injectable so tests never shell
// out to a real `claude` binary.
function runUpdateCommands({ exec = execFileSync, log = console.log } = {}) {
  for (const args of [
    ['plugin', 'marketplace', 'update', 'ster-co'],
    ['plugin', 'update', 'workflow-discipline@ster-co'],
  ]) {
    log(`> claude ${args.join(' ')}`);
    exec('claude', args, { stdio: 'inherit' });
  }
}

// Step 4a, repeated: refresh the user's own CLAUDE.md from the marketplace
// download the update just refreshed. Throws with the offending paths on a
// missing source -- silently doing nothing here is how a copy goes stale.
function copyClaudeMd({ homeDir }) {
  const from = path.join(homeDir, 'plugins', 'marketplaces', 'ster-co', 'CLAUDE.md');
  const to = path.join(homeDir, 'CLAUDE.md');
  if (!fs.existsSync(from)) {
    throw new Error(`CLAUDE.md not found at ${from} -- is the plugin installed? (SETUP.md step 3)`);
  }
  fs.copyFileSync(from, to);
  return { from, to };
}

// Step 4b's check, repeated: read the user's own settings.json and report
// whether it still carries a stale hooks block.
function checkSettings({ homeDir }) {
  const file = path.join(homeDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, stale: isStaleHooksBlock(settings.hooks), enabledPlugins: settings.enabledPlugins };
}

// Orchestrates the whole "Updating" section. Returns an exit code: 0 when
// everything is clean, 2 when the stale-hooks check still needs the
// Troubleshooting fix by hand (copy and update both still succeeded), 1 on
// any other failure.
function main({ homeDir = path.join(os.homedir(), '.claude'), exec = execFileSync, log = console.log } = {}) {
  runUpdateCommands({ exec, log });

  const { from, to } = copyClaudeMd({ homeDir });
  log(`copied ${from} -> ${to}`);

  const { stale, enabledPlugins } = checkSettings({ homeDir });
  log(`stale hooks: ${stale ? 'YES - see SETUP.md Troubleshooting' : 'none'}`);
  log(`enabledPlugins: ${JSON.stringify(enabledPlugins)}`);

  log('\nStart a new session now -- hooks, plugins and MCP servers are only read at session start.');
  return stale ? 2 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { isStaleHooksBlock, runUpdateCommands, copyClaudeMd, checkSettings, main };
