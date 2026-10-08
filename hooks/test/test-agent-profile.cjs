#!/usr/bin/env node
// Behavioural tests for the agent-profile resolver.
// Run: node ~/.claude/hooks/test/test-agent-profile.cjs
//
//   agent-profile.cjs   PreToolUse Agent — rewrites subagent_type / model from a profile
//
// The hook replaces a dispatch's whole tool input, so the dangerous failures are quiet ones:
// dropping `prompt` (the subagent runs with no task), auto-approving the call by setting a
// permissionDecision, reading another session's profile, or blocking a dispatch because the
// table was malformed. Each has a case below.
//
// House style: every MUST-rewrite is paired with a MUST-NOT. A resolver that only ever
// rewrites is a model override nobody can turn off.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-agent-profile.cjs -> hooks/test -> hooks: resolve from the script's own
// location so this suite grades the checkout it lives in, not the live ~/.claude install.
const HOOKS = path.join(__dirname, '..');
const AGENTS = path.join(HOOKS, '..', 'agents');
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

// Never touch the real ~/.claude/state: every run gets its own config dir, and the variable
// is set before the module is required or any child is spawned (the hook reads it at load).
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'profconf-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const SESSION_DIR = path.join(CONFIG, 'state', 'agent-profile');
const DEFAULT_FILE = path.join(CONFIG, 'subagent-mode');

const SCRIPT = path.join(HOOKS, 'agent-profile.cjs');
let mod = null;
try { mod = require(SCRIPT); } catch (e) { console.log(`  FAIL cannot load ${SCRIPT}: ${e.message}`); }

const reset = () => {
  fs.rmSync(path.join(CONFIG, 'state'), { recursive: true, force: true });
  fs.rmSync(DEFAULT_FILE, { force: true });
};
const setDefault = (name) => fs.writeFileSync(DEFAULT_FILE, `${name}\n`);
const setSession = (sid, name) => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, sid), `${name}\n`);
};

// A copy of the hook beside its own table and a copy of agents/, so a malformed or custom
// table can be tested without touching the real one: the script resolves both relative to
// its own location.
function sandbox(tableText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profbox-'));
  try {
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.copyFileSync(SCRIPT, path.join(root, 'hooks', 'agent-profile.cjs'));
    fs.writeFileSync(path.join(root, 'hooks', 'agent-profiles.json'), tableText);
    fs.cpSync(AGENTS, path.join(root, 'agents'), { recursive: true });
  } catch (e) {
    // A throw part-way would otherwise leave the directory behind; the caller never got `root`.
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return { script: path.join(root, 'hooks', 'agent-profile.cjs'), root };
}

function run(payload, { env = {}, script = SCRIPT, raw = null } = {}) {
  const r = spawnSync('node', [script], {
    input: raw !== null ? raw : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SHIP_LOOP_PASS: '', ...env },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
  return { out, code: r.status, stdout: r.stdout };
}

const dispatch = (input, sid = 's1', tool = 'Agent') => ({
  hook_event_name: 'PreToolUse', tool_name: tool, session_id: sid, tool_input: input,
});
const updated = (res) => res.out?.hookSpecificOutput?.updatedInput ?? null;
const noOut = (name, r) => check(name, [r.stdout, r.code], ['', 0]);
const base = { subagent_type: 'reviewer', description: 'Review brief 1', prompt: 'Review the diff.' };

// --- module surface ------------------------------------------------------------------
check('module exports effectiveProfile and rewrite',
  [typeof mod?.effectiveProfile, typeof mod?.rewrite], ['function', 'function']);

// --- the rewrite itself --------------------------------------------------------------
reset(); setSession('s1', 'fast');
let res = run(dispatch(base));
check('fast: reviewer -> reviewer-lite + sonnet, rest of the input kept', updated(res),
  { subagent_type: 'reviewer-lite', description: 'Review brief 1', prompt: 'Review the diff.', model: 'sonnet' });
check('fast: exits 0', res.code, 0);
check('output carries the PreToolUse event name', res.out?.hookSpecificOutput?.hookEventName, 'PreToolUse');
check('output never sets permissionDecision (it would auto-approve the dispatch)',
  Object.keys(res.out?.hookSpecificOutput ?? {}).sort(), ['hookEventName', 'updatedInput']);
check('original prompt survives in updatedInput', updated(res)?.prompt, 'Review the diff.');

reset(); setSession('s1', 'balanced');
res = run(dispatch(base));
check('balanced: reviewer -> reviewer-lite + opus', [updated(res)?.subagent_type, updated(res)?.model],
  ['reviewer-lite', 'opus']);
res = run(dispatch({ ...base, subagent_type: 'debugger' }));
check('balanced: debugger is left alone (empty stdout)', [res.stdout, res.code], ['', 0]);
res = run(dispatch({ ...base, subagent_type: 'plan-auditor' }));
check('balanced: plan-auditor -> plan-auditor-lite + opus', [updated(res)?.subagent_type, updated(res)?.model],
  ['plan-auditor-lite', 'opus']);

reset(); setSession('s1', 'fast');
res = run(dispatch({ ...base, subagent_type: 'debugger' }));
check('fast: debugger -> debugger-lite + opus', [updated(res)?.subagent_type, updated(res)?.model],
  ['debugger-lite', 'opus']);
res = run(dispatch({ ...base, subagent_type: 'implementer' }));
check('fast: a role absent from the profile is untouched', [res.stdout, res.code], ['', 0]);

// --- prefix and explicit model -------------------------------------------------------
// A prefixed dispatch resolves in the plugin's agents/, which ships no -lite twins, so the
// agent name must come back byte-identical; only the model may be applied.
const PREFIXED = 'workflow-discipline:reviewer';
res = run(dispatch({ ...base, subagent_type: PREFIXED }));
check('fast: a plugin-prefixed role keeps its subagent_type byte-identical, model added',
  updated(res), { ...base, subagent_type: PREFIXED, model: 'sonnet' });
check('fast: prefixed subagent_type is never a -lite name', updated(res)?.subagent_type.endsWith('-lite'), false);
res = run(dispatch({ ...base, subagent_type: PREFIXED, model: 'haiku' }));
noOut('fast: a prefixed dispatch with an explicit model is left alone', res);
res = run(dispatch({ ...base, subagent_type: 'some-plugin:debugger' }));
noOut('fast: a prefixed debugger (already opus, no rename possible) changes nothing', res);
res = run(dispatch({ ...base, subagent_type: 'some-plugin:plan-auditor' }));
check('fast: a prefixed plan-auditor keeps its name, model sonnet added',
  [updated(res)?.subagent_type, updated(res)?.model], ['some-plugin:plan-auditor', 'sonnet']);
reset(); setSession('s1', 'balanced');
noOut('balanced: a prefixed role changes nothing (opus/medium needs a rename), no output',
  run(dispatch({ ...base, subagent_type: PREFIXED })));
reset(); setSession('s1', 'fast');
res = run(dispatch({ ...base, subagent_type: 'reviewer-lite' }));
check('an already-lite dispatch is not rewritten', [res.stdout, res.code], ['', 0]);
res = run(dispatch({ ...base, subagent_type: 'myreviewer' }));
check('a role that merely ends in the same letters is not matched', [res.stdout, res.code], ['', 0]);
res = run(dispatch({ ...base, model: 'haiku' }));
check('explicit model wins; effort still picks the twin', [updated(res)?.subagent_type, updated(res)?.model],
  ['reviewer-lite', 'haiku']);

// --- no rewrite ----------------------------------------------------------------------

reset(); setSession('s1', 'quality');
noOut('quality: empty stdout, exit 0', run(dispatch(base)));

reset(); setSession('s1', 'nonsense');
noOut('unknown profile: empty stdout, exit 0', run(dispatch(base)));
reset(); setSession('s1', '__proto__');
noOut('profile named like an Object.prototype key: empty stdout, exit 0', run(dispatch(base)));

reset(); setSession('s1', 'fast');
noOut('non-Agent tool: empty stdout, exit 0', run(dispatch(base, 's1', 'Bash')));
noOut('SHIP_LOOP_PASS=1: empty stdout, exit 0', run(dispatch(base), { env: { SHIP_LOOP_PASS: '1' } }));
noOut('malformed stdin: empty stdout, exit 0', run(null, { raw: 'not json {' }));
noOut('no tool_input: empty stdout, exit 0', run({ tool_name: 'Agent', session_id: 's1' }));
noOut('no subagent_type: empty stdout, exit 0', run(dispatch({ prompt: 'x' })));

for (const [label, table] of [
  ['unparseable table', '{ not json'],
  ['table that is an array', '[]'],
  ['table with a non-object profile', '{"fast":"reviewer"}'],
  ['entry with a non-string model', '{"fast":{"reviewer":{"model":5,"effort":"medium"}}}'],
  ['entry with no effort and no model', '{"fast":{"reviewer":{}}}'],
]) {
  const sb = sandbox(table);
  noOut(`${label}: empty stdout, exit 0`, run(dispatch(base), { script: sb.script }));
  fs.rmSync(sb.root, { recursive: true, force: true });
}
{
  const sb = sandbox('{"fast":{"reviewer":{"model":"sonnet","effort":"medium"}}}');
  fs.rmSync(path.join(sb.root, 'hooks', 'agent-profiles.json'));
  noOut('missing table file: empty stdout, exit 0', run(dispatch(base), { script: sb.script }));
  fs.rmSync(sb.root, { recursive: true, force: true });
}

// --- effort picks the agent ----------------------------------------------------------
{
  const sb = sandbox(JSON.stringify({ fast: {
    implementer: { model: 'sonnet', effort: 'medium' },   // no twin, base is high: no rewrite
    researcher: { model: 'haiku', effort: 'medium' },     // no twin, base is medium: model only
    reviewer: { model: 'sonnet', effort: 'low' },         // twin exists but low is neither: no rewrite
    scout: { model: 'haiku', effort: 'low' },             // base effort: base name, model only
    debugger: { model: 'opus', effort: 'high' },          // base effort: base name, model only
    ghost: { model: 'sonnet', effort: 'medium' },         // no agents/ghost.md
  } }));
  const go = (type) => run(dispatch({ ...base, subagent_type: type }), { script: sb.script });
  noOut('role with no twin and a differing effort is not rewritten', go('implementer'));
  check('role at its base effort: base name, model only', updated(go('researcher')),
    { ...base, subagent_type: 'researcher', model: 'haiku' });
  noOut('an effort that is neither base nor medium is not rewritten', go('reviewer'));
  check('base effort of a role with a twin keeps the base name', updated(go('debugger')),
    { ...base, subagent_type: 'debugger', model: 'opus' });
  check('scout at its base effort: model only', updated(go('scout'))?.model, 'haiku');
  noOut('role with no agent file is not rewritten', go('ghost'));

  // The mapping is read from agents/*.md, not hardcoded: make the base reviewer medium
  // and the twin high and the same table entry must pick the other file.
  const flip = (f, from, to) => {
    const p = path.join(sb.root, 'agents', f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace(`effort: ${from}`, `effort: ${to}`));
  };
  fs.writeFileSync(path.join(sb.root, 'hooks', 'agent-profiles.json'),
    JSON.stringify({ fast: { reviewer: { model: 'sonnet', effort: 'medium' } } }));
  flip('reviewer.md', 'high', 'medium');
  check('efforts come from agents/*.md: base now medium -> base name',
    [updated(go('reviewer'))?.subagent_type, updated(go('reviewer'))?.model], ['reviewer', 'sonnet']);
  fs.rmSync(sb.root, { recursive: true, force: true });
}

// --- profile resolution --------------------------------------------------------------
reset(); setDefault('fast');
res = run(dispatch(base, 's1'));
check('machine default applies when the session has no file', updated(res)?.subagent_type, 'reviewer-lite');
setSession('s1', 'quality');
noOut('per-session file beats the machine default', run(dispatch(base, 's1')));
res = run(dispatch(base, 's2'));
check("another session's file is ignored (falls to the default)", updated(res)?.subagent_type, 'reviewer-lite');
reset(); setSession('other', 'fast');
noOut("another session's file never leaks into this one", run(dispatch(base, 's1')));

reset(); setSession('s1', 'fast');
check('effectiveProfile: session file', mod?.effectiveProfile('s1', CONFIG), { name: 'fast', source: 'session' });
check('effectiveProfile: no file for this session -> fallback',
  mod?.effectiveProfile('s2', CONFIG), { name: 'quality', source: 'fallback' });
setDefault('balanced');
check('effectiveProfile: machine default', mod?.effectiveProfile('s2', CONFIG), { name: 'balanced', source: 'default' });
check('effectiveProfile: session beats default', mod?.effectiveProfile('s1', CONFIG), { name: 'fast', source: 'session' });
check('effectiveProfile: no session id -> default', mod?.effectiveProfile(undefined, CONFIG),
  { name: 'balanced', source: 'default' });
reset();
check('effectiveProfile: nothing set -> fallback', mod?.effectiveProfile('s1', CONFIG),
  { name: 'quality', source: 'fallback' });
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSION_DIR, 's1'), '  \n');
check('effectiveProfile: blank session file is treated as absent',
  mod?.effectiveProfile('s1', CONFIG), { name: 'quality', source: 'fallback' });

// A crafted session id must not read an arbitrary file as a profile name.
reset();
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.writeFileSync(path.join(CONFIG, 'state', 'planted'), 'fast\n');
fs.writeFileSync(path.join(CONFIG, 'planted2'), 'fast\n');
check("session id '../planted' is ignored", mod?.effectiveProfile('../planted', CONFIG),
  { name: 'quality', source: 'fallback' });
check("session id '../../planted2' is ignored", mod?.effectiveProfile('../../planted2', CONFIG),
  { name: 'quality', source: 'fallback' });
check("session id 'a/b' is ignored", mod?.effectiveProfile('a/b', CONFIG), { name: 'quality', source: 'fallback' });
check("session id with a backslash is ignored", mod?.effectiveProfile('a\\b', CONFIG),
  { name: 'quality', source: 'fallback' });
noOut("hook run with session id '../planted' does not rewrite", run(dispatch(base, '../planted')));
fs.writeFileSync(DEFAULT_FILE, 'balanced\n');
check("unsafe session id still falls through to the machine default",
  mod?.effectiveProfile('../planted', CONFIG), { name: 'balanced', source: 'default' });

// --- rewrite() as a pure function ----------------------------------------------------
const T = { fast: { reviewer: { model: 'sonnet', effort: 'medium' } }, quality: {} };
check('rewrite: null for quality', mod?.rewrite(T, 'quality', base), null);
check('rewrite: null for an unknown profile', mod?.rewrite(T, 'nope', base), null);
check('rewrite: returns the full input, original untouched', [mod?.rewrite(T, 'fast', base)?.prompt, base.subagent_type],
  ['Review the diff.', 'reviewer']);
check('rewrite: null for a null table', mod?.rewrite(null, 'fast', base), null);

for (const d of [CONFIG]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
