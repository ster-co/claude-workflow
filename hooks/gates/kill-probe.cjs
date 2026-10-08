'use strict';
// Read-only process probe and the protected-process classifier used by the kill
// gate's dry run (docs/plans/2026-09-30-kill-gate-dryrun.md, Decisions 12 and 14).
//
// This module is written to never signal a process. Its only process execution is
// `probe`, which runs spawnSync without a shell on an absolute path from a fixed
// allowlist of read-only tools and throws for anything else. (spawnSync's own `timeout`
// ends its child if the tool hangs; that is Node cleaning up a process this module
// started, not a signal to any other process.) That is a property of the code as
// written, checked by a source grep and a vm sandbox in test-kill-probe.cjs; those catch
// accidental regressions and are not a proof, since vm can be escaped on purpose.
const { spawnSync } = require('child_process');

const PGREP = '/usr/bin/pgrep';
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const ALLOWLIST = new Set([PGREP, PS, LSOF]);
const PROBE_TIMEOUT_MS = 1000;

// The one ps format the module reads: pid, parent pid, then the full command line.
const PS_FORMAT = 'pid=,ppid=,command=';
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/;
const PID_LINE = /^\s*(\d+)\s*$/;

// The only options any spawn gets, frozen so nothing can add to them. Nothing else may
// be added either: pgrep and pkill are one binary, and an option that changes the
// program name it sees would make a dry run signal its matches.
const SPAWN_OPTIONS = Object.freeze({ shell: false, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });

// Runs `bin` and returns spawnSync's result, or `{ error }` when the tool could not
// run to completion (spawn failure, timeout, ended by a signal). spawnSync gets its own
// copy of `args`, never the caller's array.
function run(bin, args) {
  const r = spawnSync(bin, [...args], SPAWN_OPTIONS);
  if (r.error) return { error: `${bin} failed: ${r.error.message}` };
  if (r.status === null) return { error: `${bin} ended by signal ${r.signal}` };
  return r;
}

// All three tools exit 0 with results and 1 with none. A 1 that also wrote to stderr
// is a real failure (bad usage, a pid list ps could not read), not "no match". Exit 0
// with nothing on stdout is deliberately not "none": it is a tool that ran but did not
// print what was asked for (`pgrep -qx Finder` exits 0 on a match and prints nothing),
// and reading it as an empty set would let a kill of a running process through. No
// query this module makes has an empty exit-0 answer, so parseRows and parsePidList
// turn it into an error.
function noMatch(r) {
  return r.status === 1 && !String(r.stdout || '').trim() && !String(r.stderr || '').trim();
}

// `pid ppid command` rows from ps -o pid=,ppid=,command=.
function parseRows(stdout) {
  const rows = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(ROW);
    if (!m) return { error: `unparseable ps row: ${line.slice(0, 80)}` };
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  if (!rows.length) return { error: 'ps exited 0 but printed no rows' };
  return { rows };
}

// One pid per line (pgrep, lsof -t).
function parsePidList(stdout) {
  const pids = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(PID_LINE);
    if (!m) return { error: `unparseable pid line: ${line.slice(0, 80)}` };
    const pid = Number(m[1]);
    if (!pids.includes(pid)) pids.push(pid);
  }
  if (!pids.length) return { error: 'tool exited 0 but printed no pids' };
  return { pids };
}

// probe(bin, args) -> { pids: [{ pid, ppid, command }] } | { error }
//
// bin must be exactly one of the three allowlisted absolute paths, otherwise it
// throws before anything is spawned. How each tool becomes rows:
//   /bin/ps          the caller passes `-o pid=,ppid=,command= -p <list>`; its rows are
//                    returned as they are. A pid list naming only dead pids (exit 1,
//                    no output) is an empty set.
//   /usr/bin/pgrep   pgrep lists pids only, so the pids are resolved to rows with one
//   /usr/sbin/lsof   further `/bin/ps -o pid=,ppid=,command= -p a,b,c` call (lsof is
//                    for `-t` output). Exit 1 with no output is "no match" and returns
//                    an empty set without a second call. A pid that exits between the
//                    two calls is dropped, since it can no longer be a target.
// A non-zero status other than that no-match case, a timeout, output that does not
// parse, or exit 0 with no pids or rows (see noMatch) returns { error } and never a
// partial set.
function probe(bin, args) {
  if (typeof bin !== 'string' || !ALLOWLIST.has(bin)) {
    throw new Error(`probe: ${JSON.stringify(bin)} is not an allowlisted binary`);
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw new TypeError('probe: args must be an array of strings');
  }
  const r = run(bin, args);
  if (r.error) return { error: r.error };
  if (noMatch(r)) return { pids: [] };
  if (r.status !== 0) return { error: `${bin} exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}` };

  if (bin === PS) {
    const parsed = parseRows(r.stdout);
    return parsed.error ? { error: parsed.error } : { pids: parsed.rows };
  }

  const listed = parsePidList(r.stdout);
  if (listed.error) return { error: listed.error };
  const resolved = run(PS, ['-o', PS_FORMAT, '-p', listed.pids.join(',')]);
  if (resolved.error) return { error: resolved.error };
  if (noMatch(resolved)) return { pids: [] };
  if (resolved.status !== 0) return { error: `${PS} exited ${resolved.status}: ${String(resolved.stderr || '').trim().slice(0, 200)}` };
  const parsed = parseRows(resolved.stdout);
  if (parsed.error) return { error: parsed.error };
  const byPid = new Map(parsed.rows.map((row) => [row.pid, row]));
  return { pids: listed.pids.filter((pid) => byPid.has(pid)).map((pid) => byPid.get(pid)) };
}

// ancestorPids(pid = process.pid, probeFn = probe) -> number[] | { error }
// The pid itself, then each parent up to (and excluding) launchd, read with one
// `/bin/ps -o pid=,ppid=,command= -p <pid>` probe per step. This is the "hook's own
// ancestor chain" of Decision 12: the calling Claude Code session and its shell. It
// stops at pid <= 1, at a repeated pid, or when a parent has already exited (ps exit 1,
// no output), and returns the chain; the caller treats every pid in it as protected.
// When ps itself fails (timeout, bad exit, unparseable output) or the walk runs out of
// MAX_DEPTH steps with parents still to go, the chain would be short, so it returns
// { error } instead and the caller denies (Decision 14) rather than trusting a partial
// protected set.
const MAX_DEPTH = 64;
function ancestorPids(pid = process.pid, probeFn = probe) {
  const chain = [];
  let current = pid;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!Number.isSafeInteger(current) || current <= 1 || chain.includes(current)) break;
    chain.push(current);
    const r = probeFn(PS, ['-o', PS_FORMAT, '-p', String(current)]);
    if (r.error) return { error: r.error };
    if (!r.pids.length) break;
    current = r.pids[0].ppid;
  }
  // Out of steps. The chain is complete only if the next parent would have ended it
  // anyway; otherwise the walk was cut short and a partial protected set is not trusted.
  if (Number.isSafeInteger(current) && current > 1 && !chain.includes(current)) {
    return { error: `ancestor chain of pid ${pid} is deeper than ${MAX_DEPTH}` };
  }
  return chain;
}

const PROTECTED_NAMES = new Set(['loginwindow', 'WindowServer', 'Finder', 'Dock', 'SystemUIServer', 'ControlCenter']);

// Whether `name` is exactly the name of a protected session process. The one list
// isProtected classifies by, exported so the gate can refuse such a name before it
// runs a query (a query limited to the caller's uid does not list loginwindow).
const isProtectedName = (name) => PROTECTED_NAMES.has(name);

// The protected name an unanchored, case-sensitive regular expression (killall -m) would
// match, or null. A pattern JavaScript cannot compile is not matched here: the dry run
// still sees what it selects.
function protectedNameMatching(pattern) {
  let re;
  try { re = new RegExp(pattern); } catch { return null; }
  return [...PROTECTED_NAMES].find((name) => re.test(name)) ?? null;
}

// isProtected(proc, ancestors = []) -> reason | null
// A protected process is never a valid target of a kill (Decision 12); the reason
// names the family so the gate's deny message can say why. `ancestors` is the pid
// chain from ancestorPids. The command's first word is only used where it is a real
// executable path; Claude's paths hold spaces ("Application Support"), so the
// path-family checks look at the whole command line.
function isProtected(proc, ancestors = []) {
  const command = String(proc.command || '').trim();
  const first = command.split(/\s+/)[0] || '';
  const name = first.slice(first.lastIndexOf('/') + 1);

  if (ancestors.includes(proc.pid)) return `pid ${proc.pid} is an ancestor of this hook (the calling session or its shell)`;
  if (proc.pid === 1) return 'pid 1 is launchd';
  // ps prints a bare `(name)` instead of the command line when a process is exiting or
  // its arguments cannot be read. It is classified by that name. "claude" is matched
  // case-insensitively as a leading word (the desktop app is "Claude", the CLI "claude",
  // helpers "Claude Helper (...)"): a false protect only denies a kill, a miss could let
  // one through.
  const parenthesised = command.match(/^\((.+)\)$/);
  if (parenthesised) {
    const inner = parenthesised[1].trim();
    if (isProtectedName(inner)) return `${inner} is a macOS system process (ps shows only (${inner}))`;
    if (/^claude\b/i.test(inner)) return `Claude Code or the Claude desktop app (ps shows only (${inner}): exiting or unreadable arguments)`;
    // A native install names its process by its version (`2.1.284`) when it has no readable
    // arguments; nothing else prints a bare three-part number.
    if (/^\d+\.\d+\.\d+\S*$/.test(inner)) return `Claude Code (ps shows only its version (${inner}): exiting or unreadable arguments)`;
    return null;
  }
  if (isProtectedName(name)) return `${name} is a macOS system process`;
  // The path families come before the generic "ends in /claude" rule, which every
  // native-binary path would otherwise satisfy first and leave them unreachable.
  // `Claude` is the default desktop profile; others are `Claude-<Name>`.
  if (/\/Application Support\/Claude(?:-[^/]+)?\/claude-code\//.test(command)) return 'Claude Code (desktop app CLI)';
  if (/\/anthropic\.claude-code-[^/]*\//.test(command)) return 'Claude Code (editor extension)';
  if (first === 'claude' || first.endsWith('/claude')) return 'Claude Code (command ends in /claude)';
  // An npm install runs as `node <script>`, so the first word is node: the script, the
  // first word that is not an option, is what names it. Only that word is read, so an
  // option with a separate value (`node -r x <script>`) hides the script from this rule;
  // reading further would protect `node server.js --root /srv/me/claude`.
  if (name === 'node') {
    const script = command.split(/\s+/).slice(1).find((word) => !word.startsWith('-')) || '';
    if (script === 'claude' || script.endsWith('/claude') || script.includes('/@anthropic-ai/claude-code/')) {
      return 'Claude Code (npm install, run by node)';
    }
  }
  if (command.startsWith('/Applications/Claude.app/')) return 'Claude desktop app';
  if (command.startsWith('/System/')) return 'a /System/ process';
  if (command.startsWith('/Applications/')) return 'an /Applications/ process';
  return null;
}

module.exports = { probe, isProtected, isProtectedName, protectedNameMatching, ancestorPids, ALLOWLIST: [...ALLOWLIST], PROBE_TIMEOUT_MS };
