#!/usr/bin/env node
// Behavioural tests for bin/update-plugin.cjs, the "Updating" section
// collapsed into one command. Run: node hooks/test/test-update-plugin.cjs
//
// No test shells out to a real `claude` binary: runUpdateCommands and main
// both take an injectable `exec`, recorded to an array instead of spawning
// anything real.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-update-plugin.cjs -> hooks/test -> hooks -> ROOT: resolve
// from this script's own location so the suite exercises the checkout it
// lives in, never the live ~/.claude install (see test-verify-checkpoint.cjs's
// header).
const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'bin', 'update-plugin.cjs');
const mod = require(SCRIPT);

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}
function checkTrue(name, cond) { check(name, !!cond, true); }
function checkThrows(name, fn) {
  try { fn(); fail++; failures.push(name); console.log(`  FAIL ${name}: did not throw`); }
  catch (e) { pass++; console.log(`  ok   ${name} (threw: ${e.message})`); }
}

function mkHome({ claudeMd, settings } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-plugin-home-'));
  const marketplace = path.join(home, 'plugins', 'marketplaces', 'ster-co');
  fs.mkdirSync(marketplace, { recursive: true });
  if (claudeMd !== undefined) fs.writeFileSync(path.join(marketplace, 'CLAUDE.md'), claudeMd);
  if (settings !== undefined) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  return home;
}

// --- isStaleHooksBlock -------------------------------------------------
checkTrue('windows-style hook path is stale', mod.isStaleHooksBlock({
  PreToolUse: [{ hooks: [{ command: 'node "C:\\Users\\Niels\\.claude\\hooks\\gates\\edit-gate.cjs"' }] }],
}));
checkTrue('unix-style hook path is stale', mod.isStaleHooksBlock({
  PreToolUse: [{ hooks: [{ command: 'node "$HOME/.claude/hooks/gates/edit-gate.cjs"' }] }],
}));
check('empty hooks block is clean', mod.isStaleHooksBlock({}), false);
check('undefined hooks is clean', mod.isStaleHooksBlock(undefined), false);

// --- copyClaudeMd --------------------------------------------------------
{
  const home = mkHome({ claudeMd: '# Global instructions\nv2\n' });
  const { from, to } = mod.copyClaudeMd({ homeDir: home });
  checkTrue('copyClaudeMd wrote the destination', fs.existsSync(to));
  check('copyClaudeMd copied the current content', fs.readFileSync(to, 'utf8'), '# Global instructions\nv2\n');
  checkTrue('copyClaudeMd reports the source path', from.endsWith(path.join('marketplaces', 'ster-co', 'CLAUDE.md')));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = mkHome(); // no CLAUDE.md in the marketplace dir
  checkThrows('copyClaudeMd on a missing source names the path', () => mod.copyClaudeMd({ homeDir: home }));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // A stale destination must be overwritten, not merged or left alone.
  const home = mkHome({ claudeMd: 'fresh' });
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'stale-from-first-install');
  mod.copyClaudeMd({ homeDir: home });
  check('copyClaudeMd overwrites a stale existing copy', fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), 'fresh');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- checkSettings ---------------------------------------------------------
{
  const home = mkHome({ settings: { hooks: {}, enabledPlugins: { 'workflow-discipline@ster-co': true } } });
  const r = mod.checkSettings({ homeDir: home });
  check('checkSettings: clean settings.json reports not stale', r.stale, false);
  check('checkSettings: enabledPlugins passed through', r.enabledPlugins, { 'workflow-discipline@ster-co': true });
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = mkHome({
    settings: { hooks: { PreToolUse: [{ hooks: [{ command: 'node "$HOME/.claude/hooks/gates/edit-gate.cjs"' }] }] } },
  });
  checkTrue('checkSettings: stale hooks block reports stale', mod.checkSettings({ homeDir: home }).stale);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- runUpdateCommands -------------------------------------------------
{
  const calls = [];
  mod.runUpdateCommands({ exec: (cmd, args) => calls.push([cmd, ...args]), log: () => {} });
  check('runUpdateCommands: marketplace update runs first', calls[0], ['claude', 'plugin', 'marketplace', 'update', 'ster-co']);
  check('runUpdateCommands: plugin update runs second', calls[1], ['claude', 'plugin', 'update', 'workflow-discipline@ster-co']);
  check('runUpdateCommands: exactly two commands', calls.length, 2);
}

// --- main: end-to-end orchestration ----------------------------------------
{
  const home = mkHome({
    claudeMd: 'updated content',
    settings: { hooks: {}, enabledPlugins: { 'workflow-discipline@ster-co': true } },
  });
  const calls = [];
  const logs = [];
  const code = mod.main({ homeDir: home, exec: (cmd, args) => calls.push([cmd, ...args]), log: (l) => logs.push(l) });
  check('main: clean install exits 0', code, 0);
  check('main: still ran both update commands', calls.length, 2);
  check('main: copied CLAUDE.md', fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), 'updated content');
  checkTrue('main: logged a clean stale-hooks result', logs.some((l) => l.includes('stale hooks: none')));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = mkHome({
    claudeMd: 'updated content',
    settings: {
      hooks: { PreToolUse: [{ hooks: [{ command: 'node "C:\\Users\\Niels\\.claude\\hooks\\gates\\edit-gate.cjs"' }] }] },
      enabledPlugins: { 'workflow-discipline@ster-co': true },
    },
  });
  const code = mod.main({ homeDir: home, exec: () => {}, log: () => {} });
  check('main: stale hooks after update exits 2, not 0', code, 2);
  fs.rmSync(home, { recursive: true, force: true });
}

// =============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
