// Duplicate-delivery guard for hooks that record or count.
//
// A machine that has both this checkout and the installed plugin registers every
// hook twice -- settings.json for the checkout, hooks/hooks.json for the plugin --
// and the harness runs both, concurrently, with an identical payload. The gates
// are fine with that (they decide the same thing twice), but a recorder that
// appends a log line or bumps a counter does it twice. `claim` lets exactly one
// of the deliveries do the work.
//
// Two deliveries of one event arrive within about half a second of each other
// (measured over the agent log: the largest gap among true duplicates was 439ms).
// The same agent_id legitimately reports again when it is resumed, never sooner
// than several seconds later (smallest measured gap: 9s). So a claim is a
// generation, not a permanent mark: it holds for WINDOW_MS and then the same key
// can be claimed afresh.
//
// The winner is decided without deleting or replacing any file, because two
// processes that both saw an expired mark and both replaced it would both win.
// Each caller appends one line to its key's file (O_APPEND writes are atomic, so
// the file order is a single total order every caller sees the same prefix of),
// reads the file back, and walks it in order: a line starts a new generation when
// it is more than WINDOW_MS after the line that started the current one, and the
// caller wins iff its own line starts one. Only lines before its own matter, and
// those were written before it, so every caller reaches the verdict it would have
// reached with any later line missing.
//
// A hook must never fail because it could not de-duplicate: on any filesystem
// error `claim` says "yes, do the work". A doubled record is a smaller harm than a
// lost one.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 5_000;
// Claim files are tiny and only matter for a few seconds; a day is far past any
// duplicate and keeps the directory from growing without bound.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_ODDS = 0.02;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function prune(dir, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(file);
    } catch { /* another process pruned it, or it is being written: leave it */ }
  }
}

// True when this caller is the first of its generation for `key` and should do
// the work; false when another delivery of the same event already has.
// `namespace` separates unrelated uses of one key (the log append versus the
// review-round bump of the same SubagentStop).
function claim(stateDir, namespace, key, now = Date.now()) {
  try {
    const dir = path.join(stateDir, 'once', namespace);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sha1(key));
    const mine = `${now}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    fs.appendFileSync(file, `${mine}\n`);
    let leaderAt = null;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line) continue;
      const at = Number(line.split(':', 1)[0]);
      const leads = leaderAt === null || at - leaderAt > WINDOW_MS;
      if (leads) leaderAt = at;
      if (line === mine) {
        if (Math.random() < PRUNE_ODDS) prune(dir, now);
        return leads;
      }
    }
    return true;
  } catch {
    return true;
  }
}

// The identity of one event across the registrations that deliver it, or null
// when the payload carries none. SubagentStart/Stop carry `agent_id`;
// PostToolUse carries `tool_use_id`. Without either there is nothing to tell a
// duplicate from a second event, so the caller must not de-duplicate at all.
function eventKey(input) {
  const id = input?.agent_id || input?.tool_use_id;
  if (!id) return null;
  return [input.hook_event_name || '', input.session_id || '', id].join(':');
}

module.exports = { claim, eventKey, prune, WINDOW_MS, PRUNE_AFTER_MS };
