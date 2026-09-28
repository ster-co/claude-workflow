#!/usr/bin/env node
// ship-loop-launch: the front door for `/ship --unattended` (see
// docs/plans/2026-09-26-ship-loop.md, "Front door: `/ship --unattended`"). It
// refuses to launch unless every readiness check holds, then writes the two
// fixtures bin/ship-loop.cjs (the driver, BRIEF 1) reads, excludes .ship-loop/
// from the worktree, and starts the driver detached.
//
// Stopping a run this launched: `touch .ship-loop/STOP` -- the driver checks
// for that file before every pass (bin/ship-loop.cjs). This script does not
// implement stopping itself; it only documents the mechanism here and in
// --help.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

// `~/.claude/hooks` resolved the same way commands/ship.md and bin/ship-loop.cjs
// both document it: `${CLAUDE_PLUGIN_ROOT}/hooks` when running as an installed
// plugin, `~/.claude/hooks` otherwise.
function hooksDir() {
  return process.env.CLAUDE_PLUGIN_ROOT
    ? path.join(process.env.CLAUDE_PLUGIN_ROOT, 'hooks')
    : path.join(os.homedir(), '.claude', 'hooks');
}

const DEFAULT_PAUSE_AT = 95;
// Same threshold bin/ship-loop.cjs's checkUsagePause uses: a reading older
// than this is unknown, not zero (see checkUsageBelowPauseAt below).
const USAGE_STALE_MS = 30 * 60 * 1000;
// Phases a plan gate would need to ask the user about -- an unattended run
// cannot answer those, so they refuse unless the project's own CLAUDE.md
// declares standing approval (searched for an `Unattended run` line/heading,
// the same substring the plan's workout-app example uses).
const GATED_PHASES = new Set(['awaiting-direction', 'awaiting-approval']);

const PASS_PROMPT_TEMPLATE = `# Unattended pass

Do exactly one unit, then exit. A unit is one brief (implement, review, fix,
commit and \`finish-brief\`) or one phase step (plan and audit, whole-tree
review, merge, deploy, product check).

Before exiting, the run state and the progress file must match the commit.

Never ask the user. Follow the repository's \`CLAUDE.md\` for stop points.

On a hard stop (a missing credential, an open gate flag), write
\`.ship-loop/HARD_STOP\` with one line naming the reason, then exit.

When the project's end condition is met, write \`.ship-loop/DONE\` with one
line, then exit. By default the end condition is "the run's \`finishedAt\` is
set".
`;

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// Anchors every git/file operation below at the repo root rather than
// process.cwd(): launched from a project subdirectory, `.ship-loop/`,
// `CLAUDE.md`, and the worktree's exclude file must all resolve to the same
// place the driver (spawned with this same cwd) expects, not scatter into
// wherever the shell happened to be. Falls back to `cwd` itself if git
// rev-parse fails (not a repo, or git missing) -- the git-based checks that
// run right after (checkCleanTree, checkBranch) will then fail clearly on
// their own rather than this function guessing at a fallback.
function resolveRepoRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) return cwd;
  return r.stdout.trim();
}

function runStateGet(hooksD, repo, feature) {
  const args = [path.join(hooksD, 'run-state.cjs'), 'get'];
  if (feature) args.push('--feature', feature);
  // process.execPath, not the bare string 'node' -- same reasoning as
  // spawnDriverDetached below: a 'node' resolved off PATH may not be the
  // interpreter actually running this script (wrong version, or absent).
  const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// A bare `.includes('Unattended run')` would also match a sentence like "Never
// start an Unattended run without asking me first" -- anchor the match to the
// start of a line (allowing a Markdown heading prefix), the way the plan's
// workout-app example uses it as its own heading, without building a full
// Markdown parser for one substring.
const STANDING_APPROVAL_RE = /^\s{0,3}#{0,6}\s*Unattended run\b/m;

function claudeMdHasStandingApproval(repo) {
  const p = path.join(repo, 'CLAUDE.md');
  if (!fs.existsSync(p)) return false;
  try { return STANDING_APPROVAL_RE.test(fs.readFileSync(p, 'utf-8')); } catch { return false; }
}

// Each check returns a human-readable reason string naming itself, or null
// when it passes. Checked in the order the plan's front-door section lists
// them; the first failure is what gets reported.
function checkPhaseGate(state, repo) {
  if (!state || !state.feature) {
    return 'no run found for this feature -- start or resume one with /ship first';
  }
  if (GATED_PHASES.has(state.phase) && !claudeMdHasStandingApproval(repo)) {
    return `run is at phase '${state.phase}', which needs the user to answer a gate ` +
      '(no standing "Unattended run" approval found in this project\'s CLAUDE.md)';
  }
  return null;
}

// The launcher's own runtime state under .ship-loop/ -- named individually
// (rather than excluding the whole directory, see checkCleanTree below).
// pass-*.jsonl is a glob because the driver numbers one file per pass.
const SHIP_LOOP_STATE_FILES = ['STOP', 'DONE', 'HARD_STOP', 'feature', 'pass-prompt.md', 'log.md'];

function checkCleanTree(repo) {
  // Only the launcher's own managed state files under .ship-loop/ are
  // excluded from this check, not the whole directory: excluding all of
  // .ship-loop/ also hid a modified *tracked* file that happened to live
  // there, not just the launcher's own untracked runtime state (confirmed by
  // round 3's review). A project that (unusually) commits something under
  // .ship-loop/ still gets a normal dirty-tree check on it.
  //
  // The specific files still need excluding rather than left to the
  // worktree's exclude file: that file only gains its `.ship-loop/` line on a
  // *successful* launch (excludeShipLoopDir, below), so on a fresh repo -- or
  // one whose only previous launch was refused -- a leftover STOP marker
  // would otherwise make an already-clean tree look dirty here, before STOP
  // is even cleared (see the comment at the call site).
  const excludes = SHIP_LOOP_STATE_FILES.map((f) => `:(exclude).ship-loop/${f}`);
  excludes.push(':(exclude).ship-loop/pass-*.jsonl');
  const r = spawnSync(
    'git', ['status', '--porcelain', '--', ':(top)', ...excludes],
    { cwd: repo, encoding: 'utf-8' },
  );
  if (r.status !== 0) return 'git status --porcelain failed';
  return r.stdout.trim() ? 'the working tree is not clean (git status --porcelain is non-empty)' : null;
}

function checkBranch(repo, state) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' });
  const current = r.status === 0 ? r.stdout.trim() : null;
  if (!state.branch) return "the run has no recorded branch to compare HEAD against";
  if (current !== state.branch) {
    return `HEAD is on branch '${current}', not the run's recorded branch '${state.branch}'`;
  }
  return null;
}

// Reads cachedUsageUtilization.utilization.{limits,fetchedAtMs} from the
// ~/.claude.json-shaped file (overridable via CLAUDE_CONFIG_JSON, same field
// BRIEF 1's driver reads).
//
// "Unknown" -- no file, unparseable JSON, no cachedUsageUtilization/utilization
// shape at all, a fetchedAtMs older than USAGE_STALE_MS, or a candidate whose
// own resets_at has already passed (the limit should have reset since the
// reading was taken, whatever fetchedAtMs says) -- proceeds rather than
// refuses. Unlike the driver's per-pass loop, this is a one-time check with no
// second chance to un-refuse itself on the next pass, so refusing on data that
// may already be stale or expired would be a false refusal on an otherwise
// launchable run; the driver's own checkUsagePause (bin/ship-loop.cjs) runs
// again as the real authority immediately before the first pass, catching a
// wrongly-permissive "unknown" there instead. "Unknown" is still surfaced, not
// silent, so it is never indistinguishable from "usage confirmed low".
function checkUsageBelowPauseAt(pauseAt) {
  const configJson = process.env.CLAUDE_CONFIG_JSON || path.join(os.homedir(), '.claude.json');
  const data = readJsonSafe(configJson);
  const utilization = data && data.cachedUsageUtilization && data.cachedUsageUtilization.utilization;
  if (!utilization) {
    console.error('ship-loop-launch: no usage reading found in the config file -- proceeding without a usage check');
    return null;
  }
  const { fetchedAtMs, limits } = utilization;
  if (typeof fetchedAtMs !== 'number' || Date.now() - fetchedAtMs > USAGE_STALE_MS) {
    console.error('ship-loop-launch: usage reading is stale or missing a timestamp -- proceeding without a usage check');
    return null;
  }
  const now = Date.now();
  const hot = (Array.isArray(limits) ? limits : []).find((l) => {
    if (!l || !l.is_active || typeof l.percent !== 'number' || l.percent < pauseAt) return false;
    const resetMs = Date.parse(l.resets_at);
    return Number.isNaN(resetMs) || resetMs > now;
  });
  if (!hot) return null;
  return `usage is at ${hot.percent}% (>= --pause-at ${pauseAt}%) on ${hot.kind || 'a'} limit, resets ${hot.resets_at || 'unknown'}`;
}

// Leftover markers from an earlier run's driver (bin/ship-loop.cjs's own
// checkStopFiles, checked at the top of every pass). A relaunch that ignores
// them would spawn a driver whose very first action is to see the marker and
// exit -- "ship-loop launched: pid N" with nothing behind it, since the
// driver's stdio is discarded below.
function checkStopMarkers(shipDir) {
  for (const name of ['DONE', 'HARD_STOP']) {
    const p = path.join(shipDir, name);
    if (!fs.existsSync(p)) continue;
    let content = '';
    try { content = fs.readFileSync(p, 'utf-8'); } catch { /* present but unreadable */ }
    return `a previous run left .ship-loop/${name} in place -- remove it first if you mean to ` +
      `start a new run. Its content:\n${content}`;
  }
  return null;
}

// STOP only asks the driver to stop after its current pass -- unlike DONE and
// HARD_STOP it is not a record of why the run ended, so a fresh, explicit
// `--unattended` invocation is allowed to clear it rather than refuse on it
// forever.
function clearStopMarker(shipDir) {
  const p = path.join(shipDir, 'STOP');
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// Adds `.ship-loop/` to the worktree's own exclude file -- a worktree's `.git`
// is a file, not a directory, so this is resolved per-worktree rather than
// assumed to be `.git/info/exclude`. Idempotent: running the launcher twice
// must not duplicate the line.
function excludeShipLoopDir(repo) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) return;
  const rel = r.stdout.trim();
  const excludePath = path.isAbsolute(rel) ? rel : path.join(repo, rel);
  let content = '';
  try { content = fs.readFileSync(excludePath, 'utf-8'); } catch { /* file may not exist yet */ }
  if (content.split('\n').includes('.ship-loop/')) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const sep = content.length && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(excludePath, `${content}${sep}.ship-loop/\n`);
}

// The driver script to spawn. Overridable via SHIP_LOOP_DRIVER so tests never
// start a real unattended loop -- see the brief's "Stop at": no test launches
// a real loop against this or any other run.
function driverPath() {
  return process.env.SHIP_LOOP_DRIVER || path.join(__dirname, 'ship-loop.cjs');
}

// Starts the driver detached: its own session, stdio ignored, unref'd, so it
// outlives this process's exit and this script's own turn ends without
// waiting on it.
function spawnDriverDetached(repo, extraArgs) {
  // process.execPath (the node binary actually running this script) rather
  // than the bare string 'node', so this does not depend on a `node` on PATH
  // that may not match -- or may not exist -- in whatever environment spawned
  // this process.
  const child = spawn(process.execPath, [driverPath(), ...extraArgs], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
  });
  // A detached, unref'd child normally outlives this process silently; an
  // 'error' here (e.g. ENOENT on driverPath()) would otherwise vanish with no
  // indication the loop never started.
  child.on('error', (err) => {
    console.error(`ship-loop-launch: failed to start the driver: ${err.message}`);
  });
  child.unref();
  return child;
}

function printHelp() {
  console.log(`ship-loop-launch: the front door for /ship --unattended.

Usage: node bin/ship-loop-launch.cjs [--feature <name>] [--model <name>]
                                      [--plan-model <name>] [--pause-at <n>]

Refuses to launch (prints which readiness check failed, exits non-zero)
unless the named run (or, with no --feature, this chat's current run) can be
resumed without a gate, the working tree is clean, HEAD is on the run's
recorded branch, and the last usage reading is below --pause-at (default ${DEFAULT_PAUSE_AT}).

On success, writes .ship-loop/feature and .ship-loop/pass-prompt.md, excludes
.ship-loop/ from the worktree, and starts bin/ship-loop.cjs detached.

To stop a launched run after its current pass: touch .ship-loop/STOP
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }

  const repo = resolveRepoRoot(process.cwd());
  const shipDir = path.join(repo, '.ship-loop');
  const featureFlag = flag(argv, '--feature', null);
  const model = flag(argv, '--model', null);
  const planModel = flag(argv, '--plan-model', null);
  const pauseAtFlag = flag(argv, '--pause-at', null);
  const pauseAtRaw = Number(pauseAtFlag !== null ? pauseAtFlag : DEFAULT_PAUSE_AT);
  const pauseAt = Number.isNaN(pauseAtRaw) ? DEFAULT_PAUSE_AT : pauseAtRaw;
  const hooksD = hooksDir();

  // DONE/HARD_STOP are checked first, and refused by name, before anything
  // else runs: they are a record of why an earlier run ended, and must never
  // be silently discarded by a launch that is itself refused.
  const markerRefusal = checkStopMarkers(shipDir);
  if (markerRefusal) {
    console.error(`REFUSED: ${markerRefusal}`);
    process.exitCode = 1;
    return;
  }

  const state = runStateGet(hooksD, repo, featureFlag);
  const refusal = checkPhaseGate(state, repo)
    || checkCleanTree(repo)
    || checkBranch(repo, state)
    || checkUsageBelowPauseAt(pauseAt);
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    process.exitCode = 1;
    return;
  }

  // STOP is cleared only once every readiness check above has passed --
  // clearing it any earlier would silently discard the marker on a launch
  // that ends up refused (e.g. a dirty tree), even though the run was never
  // actually superseded. checkCleanTree excludes .ship-loop/ from its own
  // dirty check specifically so a not-yet-cleared STOP can never itself be
  // the reason the tree looks dirty here.
  const stopCleared = clearStopMarker(shipDir);
  if (stopCleared) {
    console.log('removed a leftover .ship-loop/STOP -- this launch supersedes the earlier stop request');
  }

  fs.mkdirSync(shipDir, { recursive: true });
  fs.writeFileSync(path.join(shipDir, 'feature'), `${state.feature}\n`);
  fs.writeFileSync(path.join(shipDir, 'pass-prompt.md'), PASS_PROMPT_TEMPLATE);
  excludeShipLoopDir(repo);

  const driverArgs = [];
  if (model) driverArgs.push('--model', model);
  if (planModel) driverArgs.push('--plan-model', planModel);
  if (pauseAtFlag !== null) driverArgs.push('--pause-at', pauseAtFlag);
  const child = spawnDriverDetached(repo, driverArgs);
  console.log(`ship-loop launched: pid ${child.pid}`);
  console.log(`log: ${path.join(shipDir, 'log.md')}`);
  console.log('stop after the current pass with: touch .ship-loop/STOP');
}

if (require.main === module) {
  main();
}

module.exports = {
  PASS_PROMPT_TEMPLATE,
  checkPhaseGate,
  checkCleanTree,
  checkBranch,
  checkUsageBelowPauseAt,
};
