#!/usr/bin/env node
// What a DEFECTS round actually found, against what the plan looks like now.
//
//   node ~/.claude/hooks/plan-audit-diff.cjs <plan>
//
// Prints the last recorded verdict, each blocking defect id with the one-line
// summary gates/plan-audit-record.cjs kept for it, and a `git diff --no-index`
// from the text that was actually audited to the file on disk today. A
// DEFECTS verdict only ever named ids; it never said which hunk they were
// still about, and by the time anyone reads the round the plan may already
// have moved past it. This is the by-hand version of the check plan-gate.cjs
// runs automatically before a commit.
//
// Exits 2 when there is no marker or no snapshot for this plan: nothing has
// been audited yet, so there is nothing to diff against.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state', 'plan-audited');

// The same key gates/plan-audit-record.cjs and gates/plan-gate.cjs compute --
// sha256 of the resolved absolute path, truncated the same way -- so all
// three always agree on which marker belongs to which plan.
const keyFor = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);

const planArg = process.argv[2];
if (!planArg) {
  process.stderr.write('usage: plan-audit-diff.cjs <plan>\n');
  process.exit(2);
}

const abs = path.resolve(planArg);
const key = keyFor(abs);
const markerPath = path.join(STATE_DIR, `${key}.json`);
const snapshotPath = path.join(STATE_DIR, `${key}.audited.md`);

let rec = null;
try { rec = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { /* none */ }
if (!rec || !fs.existsSync(snapshotPath)) {
  process.stderr.write(`plan-audit-diff: no recorded audit of ${abs}\n`);
  process.exit(2);
}

process.stdout.write(`Verdict: ${rec.verdict}\n`);
const blocking = rec.blocking || [];
if (blocking.length) {
  process.stdout.write('Blocking:\n');
  for (const id of blocking) {
    const summary = (rec.summaries || {})[id];
    process.stdout.write(`  ${id}: ${summary || '(no summary recorded)'}\n`);
  }
} else {
  process.stdout.write('Blocking: none\n');
}
process.stdout.write('\n');

// --no-index compares two plain files outside any index, which is what we
// want here: the snapshot is not part of any repo, and the plan itself may
// or may not be staged. It exits 1 when the files differ -- the expected
// case, not an error -- and only a status above 1, or a spawn failure, means
// git could not produce the diff at all.
const diff = spawnSync('git', ['diff', '--no-index', '--', snapshotPath, abs], { encoding: 'utf8' });
if (diff.error || (diff.status !== 0 && diff.status !== 1)) {
  process.stderr.write(diff.stderr || String(diff.error) || 'git diff failed\n');
  process.exit(1);
}
process.stdout.write(diff.stdout || '(no changes since the audit)\n');
process.exit(0);
