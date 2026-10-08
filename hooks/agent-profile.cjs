#!/usr/bin/env node
// PreToolUse (Agent): rewrites a subagent dispatch's subagent_type and model from the
// profile in force for this session, so /subagent-mode is enforced rather than asked for.
//
// The Agent tool takes a `model` but no `effort`; effort lives only in an agent's frontmatter.
// So a profile entry {model, effort} is applied as: `model` is set on the dispatch, and
// `effort` picks the agent file -- the base agent when the effort equals its own frontmatter
// effort, its `<role>-lite` twin when the effort is `medium` and that twin exists. Any other
// effort has no agent to land on, so the entry is skipped rather than guessed at. Efforts are
// read from agents/*.md, never held here, so the table cannot drift from the agent files.
//
// A plugin-prefixed `subagent_type` (`<plugin>:<role>`) is never renamed. The twin is looked up
// in this repository's agents/ directory, but a prefixed dispatch resolves in the plugin's own
// agents, which need not ship a `-lite` twin; renaming it could point the dispatch at an agent
// that does not exist. A prefixed role keeps its agent name and only the entry's `model` applies.
//
// Profile resolution: <configDir>/state/agent-profile/<session_id> (this session only), then
// <configDir>/subagent-mode (machine default), then `quality`, the empty profile.
//
// Never blocks. `updatedInput` REPLACES the whole tool input, so the original is spread in
// (returning only subagent_type and model would send the subagent off with no prompt). No
// permissionDecision is set: the rewrite is honoured without one, and `allow` would approve
// the dispatch past the user's permission rules. Any error, unknown profile or malformed
// table prints nothing and exits 0 -- a hook that could refuse a dispatch would be a gate
// nobody asked for. An unattended ship-loop pass (SHIP_LOOP_PASS=1) is never rewritten.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const TABLE_FILE = path.join(__dirname, 'agent-profiles.json');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

const FALLBACK = 'quality';
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
}

// A session id comes from the harness, never from a user, so a legitimate one never carries
// a path separator or `..`. One that does would turn the lookup below into a read of an
// arbitrary file whose content is then used as a profile name; run-state.cjs refuses the same
// ids for the same reason.
const unsafeSessionId = (sid) => /[\\/]|\.\./.test(sid);

function effectiveProfile(session, configDir = CONFIG_DIR) {
  if (typeof session === 'string' && session && !unsafeSessionId(session)) {
    const name = readTrimmed(path.join(configDir, 'state', 'agent-profile', session));
    if (name) return { name, source: 'session' };
  }
  const name = readTrimmed(path.join(configDir, 'subagent-mode'));
  if (name) return { name, source: 'default' };
  return { name: FALLBACK, source: 'fallback' };
}

// The `<key>:` of agents/<agent>.md frontmatter, or null when the file or field is absent.
function agentField(agent, key) {
  let text;
  try { text = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf-8'); } catch { return null; }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m = front && new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, 'm').exec(front[1]);
  return m ? m[1] : null;
}
const agentEffort = (agent) => agentField(agent, 'effort');

// The agent (bare name) that runs `role` at `effort`, or null when none does.
function agentFor(role, effort) {
  if (agentEffort(role) === effort) return role;
  if (effort === 'medium' && agentEffort(`${role}-lite`) !== null) return `${role}-lite`;
  return null;
}

// Returns the new tool input, or null when the profile changes nothing for this dispatch.
function rewrite(table, profile, toolInput) {
  if (!isObject(table) || !isObject(toolInput)) return null;
  if (typeof profile !== 'string' || !has(table, profile) || !isObject(table[profile])) return null;
  const type = toolInput.subagent_type;
  if (typeof type !== 'string' || !type) return null;

  // `<plugin>:<role>` matches on the bare role, the same rule verify-record.cjs applies to
  // reviewer roles. A prefixed role keeps its agent name: the twin is resolved in this
  // repository's agents/ directory while a prefixed dispatch resolves in the plugin's, so
  // choosing a twin for it could name an agent the plugin does not have.
  const cut = type.lastIndexOf(':') + 1;
  const prefix = type.slice(0, cut), role = type.slice(cut);
  const entries = table[profile];
  if (!has(entries, role) || !isObject(entries[role])) return null;
  const { model, effort } = entries[role];
  if (model !== undefined && typeof model !== 'string') return null;
  if (effort !== undefined && typeof effort !== 'string') return null;
  if (model === undefined && effort === undefined) return null;

  const next = { ...toolInput };
  if (prefix === '') {
    if (effort !== undefined) {
      const agent = agentFor(role, effort);
      if (agent === null) return null;
      next.subagent_type = agent;
    }
  } else if (model !== undefined && model === agentField(role, 'model')) {
    // No rename is possible, and the role already runs on this model, so nothing would change.
    return null;
  }
  // An explicit model on the dispatch was chosen on purpose (/blueprint's delta audit passes
  // one), so the profile fills the field only when it is empty.
  if (model !== undefined && toolInput.model === undefined) next.model = model;

  return next.subagent_type === toolInput.subagent_type && next.model === toolInput.model ? null : next;
}

function main(raw) {
  if (process.env.SHIP_LOOP_PASS === '1') return null;
  const payload = JSON.parse(raw);
  if (!isObject(payload) || payload.tool_name !== 'Agent') return null;
  const table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf-8'));
  const { name } = effectiveProfile(payload.session_id, CONFIG_DIR);
  const updatedInput = rewrite(table, name, payload.tool_input);
  if (!updatedInput) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
}

module.exports = { effectiveProfile, rewrite };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const out = main(raw);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open: print nothing, never block a dispatch */ }
    process.exit(0);
  });
}
