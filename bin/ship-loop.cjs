#!/usr/bin/env node
// ship-loop: runs an unattended /ship run, one fresh `claude -p` session per
// pass, until a stop condition holds. No model lives inside this script -- it
// only shells out to `claude -p` and reads/writes files. See
// docs/plans/2026-09-26-ship-loop.md ("One pass", "The loop", "Models") for
// the design this implements.
//
// The run is named by the front door (BRIEF 2, bin/ship-loop-launch.cjs) and
// stored in .ship-loop/feature; this script only reads it. Stopping mid-run
// is `touch .ship-loop/STOP`, checked before every pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// `~/.claude/hooks` resolved the same way commands/ship.md documents it:
// `${CLAUDE_PLUGIN_ROOT}/hooks` when running as an installed plugin,
// `~/.claude/hooks` otherwise. Same script either way; only the directory
// changes.
function hooksDir() {
  return process.env.CLAUDE_PLUGIN_ROOT
    ? path.join(process.env.CLAUDE_PLUGIN_ROOT, 'hooks')
    : path.join(os.homedir(), '.claude', 'hooks');
}

const DEFAULT_MODEL = 'opus';
const DEFAULT_PAUSE_AT = 95;
const USAGE_STALE_MS = 30 * 60 * 1000;
const POST_LIMIT_GRACE_MS = 2 * 60 * 1000;

// https://code.claude.com/docs/en/errors documents the message as
// "You've hit your … limit · resets <time>" ("…" is an optional adjective --
// "5-hour", "session", "weekly" -- the real CLI also emits a bare "You've hit
// your limit" with none). The reset text is captured up to the first
// `·`/`•` separator rather than to end-of-string: the real CLI joins
// additional feature-flag-gated segments onto the same line with ` · `
// (e.g. "... · progress saved"), and enumerating suffixes one by one would
// never keep up with new ones. The captured text is handed to
// parseResetTime() below, which understands the real CLI's format: a bare
// time-of-day or a date-prefixed time-of-day (when the reset is >24h out),
// optionally with an IANA zone in parens (e.g. "11:30am (Europe/Amsterdam)",
// "Oct 3, 9am (Europe/Amsterdam)") -- not an ISO timestamp, which Date.parse
// cannot read.
const USAGE_LIMIT_RE = /You've hit your(?:\s+.*?)?\s+limit\s*[·•]\s*resets\s+([^·•]+)/i;

// Time-of-day form: "11:30am", "11:30am (Europe/Amsterdam)", "3pm
// (America/New_York)" -- hour, optional minute, required am/pm, optional
// parenthesised IANA zone. Optionally prefixed with a date when the reset is
// >24h out: "Oct 3, 9am (...)", "Sep 29, 6:02pm (...)", or, crossing a year
// boundary, "Jan 4, 2027, 4pm (...)" -- month abbreviation, day, optional
// explicit year.
const RESET_TIME_RE =
  /^(?:([A-Za-z]{3})\s+(\d{1,2}),\s*(?:(\d{4}),\s*)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?$/i;

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Resolve "hour:minute in `zone`, today" to the UTC instant it names, using
// the standard double-format trick: guess the instant assuming UTC, read
// back what that guess looks like when formatted in `zone`, and correct by
// the difference. One correction is enough here -- the wall-clock time this
// loop is ever asked to resolve does not itself fall inside a DST gap.
function zonedWallTimeToUtc(zone, y, mo, d, hour, minute) {
  const guess = Date.UTC(y, mo - 1, d, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  return new Date(guess - (asIfUtc - guess));
}

function ymdInZone(zone, date) {
  const fmt = new Intl.DateTimeFormat('en-US',
    { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
}

// Parses the real usage-limit message's reset time into a future Date.
//
// Two forms. The no-date, time-only form ("11:30am (...)") names only a
// time of day, so if that time has already passed today (in the relevant
// zone) it rolls to tomorrow -- the message always means the NEXT
// occurrence of that time. The date-prefixed form ("Oct 3, 9am (...)",
// "Jan 4, 2027, 4pm (...)") already names an exact calendar date, so it is
// resolved literally: that month/day (and year, if given, else the current
// year) -- no roll-forward, since a wrong date is a parsing bug, not a
// "today already passed" case the roll-forward logic is for.
//
// Returns null when the text does not match either format, names an
// invalid month abbreviation, or names a zone Intl does not recognise --
// the caller's job, not this function's, is to turn that into a visible
// failure rather than a silent short wait.
function parseResetTime(text, now = new Date()) {
  const m = RESET_TIME_RE.exec(text.trim());
  if (!m) return null;
  const [, monAbbr, dayStr, yearStr, hourStr, minuteStr, meridiemStr, zoneStr] = m;
  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  const meridiem = meridiemStr.toLowerCase();
  const zone = zoneStr ? zoneStr.trim() : null;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  if (monAbbr) {
    const mo = MONTH_ABBR.indexOf(monAbbr.toLowerCase()) + 1;
    if (mo === 0) return null; // not a recognised month abbreviation
    const day = Number(dayStr);
    if (!zone) {
      const year = yearStr ? Number(yearStr) : now.getFullYear();
      return new Date(year, mo - 1, day, hour, minute, 0, 0);
    }
    try {
      const year = yearStr ? Number(yearStr) : ymdInZone(zone, now).y;
      return zonedWallTimeToUtc(zone, year, mo, day, hour, minute);
    } catch {
      return null; // an IANA zone name Intl does not recognise
    }
  }

  if (!zone) {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  try {
    let { y, mo, d } = ymdInZone(zone, now);
    let candidate = zonedWallTimeToUtc(zone, y, mo, d, hour, minute);
    if (candidate.getTime() <= now.getTime()) {
      ({ y, mo, d } = ymdInZone(zone, new Date(candidate.getTime() + 24 * 60 * 60 * 1000)));
      candidate = zonedWallTimeToUtc(zone, y, mo, d, hour, minute);
    }
    return candidate;
  } catch {
    return null; // an IANA zone name Intl does not recognise
  }
}

// The pass's stdout is stream-json: one JSON object per line, assistant text
// living at message.content[].text. Matching the regex against the raw
// stdout blob would let it run into the JSON syntax AROUND that text (a
// trailing `"}]}}`) and capture that too, which Date.parse then rejects. Pull
// the text fields out first so the regex only ever sees plain prose.
function extractTexts(stdout) {
  const texts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj && obj.message && obj.message.content;
    if (Array.isArray(content)) {
      for (const c of content) if (c && typeof c.text === 'string') texts.push(c.text);
    }
  }
  return texts;
}

function findUsageLimitReset(stdout) {
  for (const text of extractTexts(stdout)) {
    const m = USAGE_LIMIT_RE.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// Injected so tests never actually wait: when SHIP_LOOP_TEST_SLEEP_LOG is set,
// sleeping is replaced with appending the requested duration to that file and
// resolving immediately. Production behaviour (the else branch) really waits.
function makeSleep() {
  const log = process.env.SHIP_LOOP_TEST_SLEEP_LOG;
  if (log) {
    return (ms) => {
      fs.appendFileSync(log, `${Math.round(ms)}\n`);
      return Promise.resolve();
    };
  }
  return (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function headOf(repo) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runStateGet(hooksD, feature, repo) {
  const r = spawnSync('node', [path.join(hooksD, 'run-state.cjs'), 'get', '--feature', feature],
    { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function markersOf(shipDir) {
  return ['DONE', 'HARD_STOP', 'STOP'].map((name) => fs.existsSync(path.join(shipDir, name)));
}

// What "no progress" means: HEAD, the run's phase + currentBrief, and the
// three marker files, all read once before a pass and again after it. A pass
// that stopped at a gate to ask something, or looped without committing,
// leaves every one of these unchanged.
function snapshot(repo, hooksD, feature, shipDir) {
  const state = runStateGet(hooksD, feature, repo) || {};
  return {
    head: headOf(repo),
    phase: state.phase ?? null,
    brief: state.currentBrief ?? null,
    markers: markersOf(shipDir),
  };
}

function sameSnapshot(a, b) {
  return a.head === b.head && a.phase === b.phase && a.brief === b.brief
    && a.markers.every((v, i) => v === b.markers[i]);
}

function checkStopFiles(shipDir) {
  if (fs.existsSync(path.join(shipDir, 'STOP'))) {
    return { stop: true, message: 'STOPPED (user request)' };
  }
  for (const name of ['DONE', 'HARD_STOP']) {
    const p = path.join(shipDir, name);
    if (fs.existsSync(p)) {
      const line = fs.readFileSync(p, 'utf-8').trim().split('\n')[0] || name;
      return { stop: true, message: line };
    }
  }
  return { stop: false, message: null };
}

// Read cachedUsageUtilization.utilization.{limits,fetchedAtMs} from the
// ~/.claude.json-shaped file (overridable via CLAUDE_CONFIG_JSON so tests
// never touch the real file). If any active limit is at or above pauseAt,
// sleep until its resets_at. A fetchedAtMs older than 30 minutes is treated
// as unknown -- not as zero -- and the pass proceeds; the post-pass
// usage-limit-message check is what covers that case instead.
async function checkUsagePause(pauseAt, sleepFn) {
  const configJson = process.env.CLAUDE_CONFIG_JSON || path.join(os.homedir(), '.claude.json');
  const data = readJsonSafe(configJson);
  const utilization = data && data.cachedUsageUtilization && data.cachedUsageUtilization.utilization;
  if (!utilization) return;
  const { fetchedAtMs, limits } = utilization;
  if (typeof fetchedAtMs !== 'number' || Date.now() - fetchedAtMs > USAGE_STALE_MS) return;
  const hot = (Array.isArray(limits) ? limits : [])
    .find((l) => l && l.is_active && typeof l.percent === 'number' && l.percent >= pauseAt);
  if (!hot) return;
  const resetMs = Date.parse(hot.resets_at);
  const waitMs = Number.isNaN(resetMs) ? 0 : Math.max(0, resetMs - Date.now());
  await sleepFn(waitMs);
}

function pad3(n) { return String(n).padStart(3, '0'); }

function nextPassIndex(shipDir) {
  let max = 0;
  let files = [];
  try { files = fs.readdirSync(shipDir); } catch { /* first run: no dir yet */ }
  for (const f of files) {
    const m = /^pass-(\d+)\.jsonl$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function ensureLogHeader(shipDir, model, planModel) {
  const logPath = path.join(shipDir, 'log.md');
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(logPath, `model=${model} plan-model=${planModel || 'none'}\n`);
  }
  return logPath;
}

function appendLogLine(logPath, { nnn, durationMs, costUsd, before, after }) {
  fs.appendFileSync(logPath,
    `pass ${nnn}: duration=${durationMs}ms cost_usd=${costUsd ?? 'unknown'} ` +
    `phase ${before.phase}->${after.phase} brief ${before.brief}->${after.brief} ` +
    `HEAD ${before.head}->${after.head}\n`);
}

function parseCost(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (typeof obj.total_cost_usd === 'number') return obj.total_cost_usd;
    } catch { /* not every stream-json line is a result line */ }
  }
  return null;
}

// The command a pass runs: `claude` from PATH, spawned without a shell (on
// Windows that finds claude.exe, which the native installer puts there).
// SHIP_LOOP_CLAUDE_CMD, tests only, is a JSON array of argv to run instead,
// the way SERENA_RELAY_SERVER_CMD stands in for Serena: a script-file fake
// cannot be run as `claude` on Windows.
function claudeCommand() {
  const override = process.env.SHIP_LOOP_CLAUDE_CMD;
  if (!override) return ['claude'];
  let argv;
  try { argv = JSON.parse(override); } catch { argv = null; }
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) {
    throw new Error('SHIP_LOOP_CLAUDE_CMD must be a JSON array of strings');
  }
  return argv;
}

// One pass, retried in place (same pass index, its own -retryN file) when the
// output shows a usage-limit message rather than advancing to the next pass.
async function runPassWithRetry({ repo, hooksD, feature, model, passBudget, shipDir, sleepFn, nnn }) {
  let retry = 0;
  for (;;) {
    const uuid = crypto.randomUUID();
    // Writes the per-session run-state pointer so the fresh `claude -p`
    // session's own /ship Step 0 finds this run without asking.
    const pointerResult = spawnSync('node', [path.join(hooksD, 'run-state.cjs'), 'current', feature],
      { cwd: repo, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: uuid } });
    if (pointerResult.error || pointerResult.status !== 0) {
      const reason = pointerResult.error ? pointerResult.error.message
        : `exited ${pointerResult.status}: ${(pointerResult.stderr || '').trim()}`;
      throw new Error(`run-state.cjs current failed (${reason})`);
    }

    const start = Date.now();
    // --verbose stream-json output for a real pass routinely runs past
    // Node's 1 MiB default maxBuffer; size this generously so a real pass's
    // full output is never silently truncated or the child killed for it.
    const [claudeBin, ...claudePrefix] = claudeCommand();
    const r = spawnSync(claudeBin, [
      ...claudePrefix,
      '-p', '/ship',
      '--session-id', uuid,
      '--model', model,
      '--permission-mode', 'auto',
      '--permission-prompts', 'none',
      '--output-format', 'stream-json',
      '--verbose',
      ...(passBudget === null ? [] : ['--max-budget-usd', String(passBudget)]),
      '--append-system-prompt-file', path.join(shipDir, 'pass-prompt.md'),
    ], {
      // SHIP_LOOP_PASS marks the pass as unattended: hooks/agent-profile.cjs
      // then never rewrites its dispatches, so no profile (session or machine
      // default) can swap in lower-effort agents that no one is around to
      // have chosen for it.
      // MCP_TIMEOUT: a pass starts every configured MCP server at once, and
      // under heavy host load (many lanes, Xcode builds) Serena's relay misses
      // Claude Code's default startup timeout. The server then shows as
      // "failed" for the whole pass and the edit gate refuses every source
      // edit, so the brief parks. Five minutes outlasts a loaded startup; an
      // MCP_TIMEOUT the caller set (non-empty) is kept.
      cwd: repo, encoding: 'utf-8', env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: uuid,
        SHIP_LOOP_PASS: '1',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT || '300000',
      },
      maxBuffer: 100 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    const stdout = r.stdout || '';
    // A retried attempt gets its own numbered file instead of reusing
    // pass-NNN.jsonl -- overwriting it would discard the original (limit-hit)
    // attempt's own log. `nextPassIndex`'s regex only matches the bare
    // `pass-NNN.jsonl` form, so these retry files are never mistaken for a
    // new highest pass index on a later driver run.
    const passFile = retry === 0 ? `pass-${pad3(nnn)}.jsonl` : `pass-${pad3(nnn)}-retry${retry}.jsonl`;
    fs.writeFileSync(path.join(shipDir, passFile), stdout);

    // A spawn error or a killed child is always a genuine crash -- there is
    // no output worth parsing for a usage limit, so these throw immediately
    // rather than falling through to the limit check below.
    if (r.error || r.signal) {
      const reason = r.error ? r.error.message : `killed by signal ${r.signal}`;
      const stderrTail = (r.stderr || '').trim().slice(-4000);
      throw new Error(`claude pass failed (${reason})${stderrTail ? `\n${stderrTail}` : ''}`);
    }

    // A real `claude -p` exits with status 1 on a usage-limit hit, not 0 --
    // so a non-zero status must fall through to the limit check BEFORE being
    // treated as a crash. Throwing on r.status !== 0 here (before this
    // check) would report every usage-limit hit as a crash and never reach
    // the sleep-and-retry path below.
    //
    // The limit check itself is gated on that same non-zero status: a
    // SUCCESSFUL pass's own assistant prose could otherwise quote
    // limit-shaped text (plausible when this loop runs against this very
    // repo) and be misread as a limit hit.
    const resetText = r.status !== 0 ? findUsageLimitReset(stdout) : null;
    if (resetText) {
      const resetDate = parseResetTime(resetText);
      if (!resetDate) {
        // Not a format this driver can parse into a real wait time. The old
        // behaviour -- silently waiting the 2-minute grace period and
        // retrying forever -- would hammer `claude -p` for the rest of the
        // limit window. Make it a visible, stoppable failure instead.
        fs.writeFileSync(path.join(shipDir, 'HARD_STOP'),
          `HARD_STOP: could not parse usage-limit reset time "${resetText}"\n`);
        return { durationMs, costUsd: parseCost(stdout) };
      }
      const rawWaitMs = resetDate.getTime() - Date.now();
      if (rawWaitMs < 0) {
        // Should not happen with the real CLI's own message formats, but a
        // parsing edge case could produce a reset time already in the past.
        // Log it as visibly stale rather than silently treating it as an
        // ordinary near-future reset -- the clamp below still applies either
        // way, so this never busy-loops on a negative wait.
        console.error(`ship-loop: parsed usage-limit reset time ${resetDate.toISOString()} ` +
          `is already in the past (stale); waiting the ${POST_LIMIT_GRACE_MS / 60000}-minute grace minimum instead`);
      }
      const waitMs = Math.max(0, rawWaitMs) + POST_LIMIT_GRACE_MS;
      await sleepFn(waitMs);
      retry += 1;
      continue; // retry the SAME pass rather than advancing
    }

    // No usage limit detected in the output: a non-zero exit here is a
    // genuine crash/error, not a limit hit -- report it as such.
    if (r.status !== 0) {
      const stderrTail = (r.stderr || '').trim().slice(-4000);
      throw new Error(`claude pass failed (exited with status ${r.status})${stderrTail ? `\n${stderrTail}` : ''}`);
    }

    return { durationMs, costUsd: parseCost(stdout) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = process.cwd();
  const shipDir = path.join(repo, '.ship-loop');
  const feature = fs.readFileSync(path.join(shipDir, 'feature'), 'utf-8').trim();
  const model = flag(argv, '--model', DEFAULT_MODEL);
  const planModel = flag(argv, '--plan-model', null);
  const pauseAtRaw = Number(flag(argv, '--pause-at', DEFAULT_PAUSE_AT));
  if (Number.isNaN(pauseAtRaw)) {
    console.error(`--pause-at value is not a number; using default ${DEFAULT_PAUSE_AT}`);
  }
  const pauseAt = Number.isNaN(pauseAtRaw) ? DEFAULT_PAUSE_AT : pauseAtRaw;
  // Opt-in per-pass usage cap (API-price estimate, passed to claude as
  // --max-budget-usd). Without the flag no cap is passed: a pass that hit the
  // cap mid-group would end with nothing committed. The usage-limit pause
  // (--pause-at) is what protects the account's rolling limits.
  const passBudgetRaw = flag(argv, '--pass-budget-usd', null);
  const passBudget = passBudgetRaw === null ? null : Number(passBudgetRaw);
  const hooksD = hooksDir();
  const sleepFn = makeSleep();

  const logPath = ensureLogHeader(shipDir, model, planModel);
  let nnn = nextPassIndex(shipDir);
  let stallCount = 0;

  for (;;) {
    const stopCheck = checkStopFiles(shipDir);
    if (stopCheck.stop) { console.log(stopCheck.message); return; }

    await checkUsagePause(pauseAt, sleepFn);

    const before = snapshot(repo, hooksD, feature, shipDir);
    // Opus for every pass by default, planning included. --model overrides
    // every pass; --plan-model overrides only a pass whose phase (read
    // BEFORE the pass runs) is `planning`.
    const chosenModel = (planModel && before.phase === 'planning') ? planModel : model;

    const { durationMs, costUsd } = await runPassWithRetry({
      repo, hooksD, feature, model: chosenModel, passBudget, shipDir, sleepFn, nnn,
    });

    const after = snapshot(repo, hooksD, feature, shipDir);
    appendLogLine(logPath, { nnn, durationMs, costUsd, before, after });

    if (sameSnapshot(before, after)) {
      stallCount += 1;
      if (stallCount >= 2) { console.log('STALLED'); return; }
    } else {
      stallCount = 0;
    }
    nnn += 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { checkStopFiles, sameSnapshot, snapshot, USAGE_LIMIT_RE, parseResetTime };
