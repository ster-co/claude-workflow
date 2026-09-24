#!/usr/bin/env node
// PreToolUse gate on Bash `git commit`: a plan document may not be committed
// until a plan-auditor has audited it and found it CLEAN.
//
// Why this gate exists. /plan says "Nothing downstream re-examines the plan, so
// this is the one gate that has to hold" — and then nothing held it. Every
// verification mechanism in this setup (reviewer, verify-gate, commit-gate) sits
// downstream of implementation, grading work against the plan. None of them can
// notice that the plan itself asserted something false.
//
// Measured on the session that prompted this: of the factual claims made while
// planning, every claim carrying a file:line or command output was correct, and
// every claim sourced from memory or from generalising a rule was wrong. Four
// wrong claims, all in plan documents, all caught by the user rather than by any
// mechanism here.
//
// The marker records a hash of the plan at audit time, so editing a plan after
// auditing invalidates the audit. That is deliberate: the edit is exactly where
// a fresh false claim enters.
//
// Three verdicts, three behaviours:
//
//   CLEAN    allowed.
//   MINOR    allowed, and the open defects are named. A citation off by a line
//            is not a reason to keep a plan out of the repository.
//   DEFECTS  denied, UNLESS every blocking defect id the audit named is written
//            down in the plan under "## Known defects — accepted".
//
// The third path exists because of a measured failure on 2026-09-22: three audit
// rounds on one plan returned 13, then 9, then 10 defects, the tenth round's haul
// being one real CI-breaking bug and nine citations off by a line. The only exits
// were a clean audit or SKIP_CODE_GATES=1, so a plan that was 90% right and knew
// exactly what was wrong with it could only be perfected or bypassed. A recorded
// open defect is worth more than a bypassed one: the bypass leaves no trace in
// the plan, and the next reader inherits the false claim with nothing marking it.
//
// Set SKIP_CODE_GATES=1 to disable.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  gatesDisabled, executableShell, deny, readStdin, planBodyHash, acceptedIds,
} = require('./gate-lib.cjs');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state', 'plan-audited');

const keyFor = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);

function allow() { process.exit(0); }

// Allowed, but with something the user should see. A gate that lets work through
// silently teaches nothing; a gate that denies over a typo gets switched off.
function allowWith(note) {
  process.stdout.write(JSON.stringify({ systemMessage: note }));
  process.exit(0);
}

/**
 * Does the marker still describe the file on disk?
 *
 * Content, not timestamp. The mtime was only ever a proxy for "the text changed",
 * and it answered wrongly in both directions: a `touch` re-locked an unchanged
 * plan, and — the reason this matters now — writing down a defect the audit
 * itself reported re-locked the plan on the acceptance path, making that path
 * impossible to walk. planBodyHash excludes the acknowledgement section for
 * exactly that reason; every other byte still invalidates.
 */
function auditIsFresh(abs, rec) {
  const hash = planBodyHash(abs);
  if (hash && rec.bodyHash) return hash === rec.bodyHash;
  // Markers written before bodyHash existed, and plans that can no longer be
  // read, fall back to the mtime rule they were written under.
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { return true; }
  if (rec.mtimeMs === null || rec.mtimeMs === undefined) return true;
  return Math.abs(mtimeMs - rec.mtimeMs) <= 1;
}

const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

// Same subcommand parse as commit-gate.cjs: git's global flags sit between `git`
// and the subcommand and several take a separate value token, so consuming the
// flag without its value lets `git -c user.name=x commit` slip past unmatched.
const VALUE_FLAGS = /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

// Shell operators separate commands whether or not they are spelled with spaces
// around them. `git add x&&git commit -m y` is two commands, and splitting on
// whitespace alone produced the token `x&&git`, so the second `git` was never
// seen and the gate did not fire at all. Normalise first, tokenise once.
const tokenize = (shell) => shell
  .replace(/(&&|\|\||[;&|<>])/g, ' $1 ')
  .split(/\s+/)
  .filter(Boolean);

const SEPARATOR = /^(&&|\|\||[;&|<>])$/;

/**
 * Walks past `git` and its global flags and returns where the subcommand sits,
 * plus the `-C <dir>` that git would run in. Returns null if this is not a git
 * invocation at all.
 */
function gitAt(tokens, i) {
  if (tokens[i] !== 'git') return null;
  let j = i + 1;
  let dir = null;
  while (j < tokens.length && tokens[j].startsWith('-')) {
    const eq = tokens[j].includes('=');
    const takesValue = VALUE_FLAGS.test(tokens[j]) && !eq;
    if (tokens[j] === '-C' && takesValue) dir = tokens[j + 1];
    j += takesValue ? 2 : 1;
  }
  return { sub: tokens[j], at: j, dir };
}

function gitSubcommandIs(shell, name) {
  const tokens = tokenize(shell);
  for (let i = 0; i < tokens.length; i++) {
    const g = gitAt(tokens, i);
    if (g && g.sub === name) return true;
  }
  return false;
}

// A plan document: markdown under any docs/plans/ directory. Deliberately narrow
// — this gate is not here to slow down ordinary documentation.
const isPlan = (p) => /(^|\/)docs\/plans\/.+\.md$/.test(p);

function stagedFiles(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd, encoding: 'utf8', timeout: 5000,
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Paths a `git add` / `git stage` in this same command would stage. Deliberately
// literal: a glob or a pathspec this cannot expand is left to the index check
// above, which sees it on the next attempt. Over-blocking a commit nobody asked
// about is worse than catching it one try later.
function willStage(shell, cwd) {
  const out = [];
  const tokens = tokenize(shell);
  for (let i = 0; i < tokens.length; i++) {
    const g = gitAt(tokens, i);
    if (!g || (g.sub !== 'add' && g.sub !== 'stage')) continue;
    // `git -C <dir> add foo` stages dir/foo, not cwd/foo.
    const base = g.dir ? path.resolve(cwd, g.dir) : cwd;
    for (let k = g.at + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (SEPARATOR.test(tok)) break;
      if (tok.startsWith('-')) continue;
      const abs = path.resolve(base, tok.replace(/^['"]|['"]$/g, ''));
      out.push(path.relative(cwd, abs));
    }
    i = g.at;
  }
  return out;
}

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const tool = input?.tool_name || '';
  // PowerShell is what Claude Code runs instead of Bash on Windows; the
  // command text lives in the same tool_input.command field either way.
  if (tool !== 'Bash' && tool !== 'PowerShell') return allow();

  const command = input?.tool_input?.command || '';
  if (!gitSubcommandIs(executableShell(command), 'commit')) return allow();

  const cwd = input?.cwd || process.cwd();
  // What the index holds NOW, plus what this command is about to put in it.
  // PreToolUse runs before the command, so `git add plan.md && git commit` found
  // an empty index and sailed through — the gate only ever worked when staging
  // happened in an earlier call, and the compound form is the habitual one.
  // Found live 2026-09-22 after the unit tests had been green for hours.
  const plans = [...new Set([
    ...stagedFiles(cwd),
    ...willStage(executableShell(command), cwd),
  ])].filter(isPlan);
  if (!plans.length) return allow();

  const problems = [];
  const carried = [];
  for (const rel of plans) {
    const abs = path.resolve(cwd, rel);
    const marker = path.join(STATE_DIR, `${keyFor(abs)}.json`);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* none */ }

    if (!rec) { problems.push(`${rel} — never audited`); continue; }

    // Freshness before severity: a verdict of any kind only covers the text the
    // auditor read, and an acknowledgement of a defect from some older audit is
    // not an acknowledgement of anything that is in the file now.
    if (!auditIsFresh(abs, rec)) {
      problems.push(`${rel} — edited since its audit`);
      continue;
    }

    if (rec.verdict === 'CLEAN') continue;

    if (rec.verdict === 'MINOR') {
      const ids = (rec.minor || []).join(', ') || 'unnamed';
      carried.push(`${rel} — audit found no blocking defect; still open: ${ids}`);
      continue;
    }

    if (rec.verdict === 'DEFECTS') {
      const blocking = rec.blocking || [];
      if (!blocking.length) {
        // Nothing to write down, so the acceptance path cannot be walked and
        // the only honest move is another audit.
        problems.push(`${rel} — last audit returned DEFECTS but named no blocking `
          + 'defect id, so there is nothing to fix or record. Re-run the audit.');
        continue;
      }
      const accepted = acceptedIds(readText(abs), rec.at);
      const missing = blocking.filter((id) => !accepted.includes(id));
      if (missing.length) {
        problems.push(`${rel} — blocking defect${missing.length > 1 ? 's' : ''} `
          + `${missing.join(', ')} neither fixed nor recorded. To record one, write `
          + `"- ${missing[0]} (audit ${rec.at}): <why>" under "## Known defects — accepted"`);
      } else {
        carried.push(`${rel} — committed with ${blocking.length} accepted blocking `
          + `defect${blocking.length > 1 ? 's' : ''}: ${blocking.join(', ')}`);
      }
      continue;
    }

    problems.push(`${rel} — last audit returned ${rec.verdict}`);
  }
  if (!problems.length) {
    return carried.length ? allowWith(`Plan gate: ${carried.join('; ')}`) : allow();
  }

  deny(
    `Plan documents are staged that no audit clears:\n  ${problems.join('\n  ')}\n\n` +
    'A plan is the one artifact nothing downstream re-examines — briefs amplify it and ' +
    'implementers execute it, so a false claim in it gets built rather than caught. ' +
    'Run the plan-auditor over each file listed above:\n\n' +
    '  Agent(subagent_type: "plan-auditor", prompt: "Audit <abs path>. Current premises: ' +
    '<the architecture and decisions that hold today>.", run_in_background: false)\n\n' +
    'It must end with "## Audit Verdict / <CLEAN|MINOR|DEFECTS> / Blocking: … / Minor: … / ' +
    'Plan: <abs path>". MINOR passes on its own — citation drift does not hold a plan out ' +
    'of the repository.\n\n' +
    'For a BLOCKING defect you have decided not to fix here, record it in the plan and the ' +
    'gate will let it through:\n\n' +
    '  ## Known defects — accepted\n' +
    '  - D1 (audit <at>): <what is wrong, and why we are committing anyway>\n\n' +
    'Every blocking id the audit named must appear there, each stamped with the `at` of ' +
    'the audit that found it — the exact value is in the marker under ' +
    'state/plan-audited/, and is printed beside each plan above. That stamp is what ' +
    'stops an entry written for one round quietly accepting the next round\'s defect of ' +
    'the same number, since ids restart at D1 every audit. Editing anything else in the ' +
    'plan invalidates the audit by design — that edit is where a fresh false claim enters ' +
    '— but writing this section does not.\n\n' +
    'Set SKIP_CODE_GATES=1 only if you have decided this plan does not need auditing at all.',
  );
});
