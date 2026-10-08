---
description: Show or set the agent profile (quality, balanced, fast) that decides which model and effort the roles a profile lists run at.
argument-hint: [quality | balanced | fast | default <profile> — or nothing, to show the profile in force]
# Side effects: writes one small state file that changes how later dispatches are
# routed. Trigger by typing /subagent-mode, never by the model deciding it would
# save time.
disable-model-invocation: true
---

Subagent mode: **$ARGUMENTS**

(This command's hook scripts live in `${CLAUDE_PLUGIN_ROOT}/hooks`. If that path reads
as a real absolute path here — installed as a plugin — use it everywhere this file says
`~/.claude/hooks`; if it still reads as the literal placeholder — running from a
`~/.claude` checkout — use `~/.claude/hooks` as written.)

A profile is a named row of `hooks/agent-profiles.json`: the model and effort each role
the row lists runs at. `quality` is the empty row (every agent as its own file says). The
table is the only place that says which roles a row lists and what it sets for each.
**`fast` is experimental**: it is not recommended as a machine default while
any of its roles is unevaluated, so `default fast` warns (and still writes) and names the
roles in its row. `hooks/agent-profile.cjs`,
a `PreToolUse` hook on the `Agent` tool, applies the profile in force to every dispatch, so
it takes effect on the next dispatch rather than the next prompt. Each `-lite` agent is
its original's exact prompt, model and tools at effort medium; `hooks/test/verify-all.cjs`
fails if one drifts. The hooks that record verdicts accept the `-lite` names, so the gates
behave the same. That twin is chosen only for an unprefixed role: a plugin-prefixed dispatch
(`<plugin>:<role>`) is never renamed and gets no effort change.

Two scopes, resolved in this order:

1. **This session** — `<config>/state/agent-profile/<session id>`, where `<config>` is
   `${CLAUDE_CONFIG_DIR:-~/.claude}`. Other sessions on this machine are not affected.
2. **Machine default** — `<config>/subagent-mode`, shared by every session without a file
   of its own. When neither file exists the profile is `quality`.

To clear a session override, delete `<config>/state/agent-profile/<session id>`; the session
then falls back to the machine default. These state files are untracked (the repository's `.gitignore` is an allowlist).

- **`<profile>`** — set the profile for this session only.
- **`default <profile>`** — set the machine default. A session that already has its own
  file keeps it: `default` never touches `<config>/state/agent-profile/<session id>`.
- **nothing** — print the profile in force and where it came from (`session`, `default` or
  `fallback`), for example `fast (session)`. Change nothing. When the name found is not a
  key of the table (a hand-edited file), the line ends `— not a profile; the hook ignores
  it`: the hook applies no rewrite, yet that name still shadows whatever lower scope there is
  (the machine default, if the name came from the session file; the fallback `quality`, if it
  came from the machine default).
- **a name that is not a key of `hooks/agent-profiles.json`** — say so, list the valid
  names, and change nothing. The script does this check; do not write the file yourself.

Run it as one Bash call, passing the arguments as separate words (empty for the
no-argument form), then print everything the script prints: what was written, or the
profile in force, and any `warning:` line. The session id comes from
`$CLAUDE_CODE_SESSION_ID` in that call's environment.

```bash
H=~/.claude/hooks   # or the plugin path, per the note above
node - "$H" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CLAUDE_CODE_SESSION_ID:-}" fast <<'EOF'
const fs = require('fs'), path = require('path');
const [hooks, config, sid, ...args] = process.argv.slice(2);
const table = JSON.parse(fs.readFileSync(path.join(hooks, 'agent-profiles.json'), 'utf-8'));
const { effectiveProfile } = require(path.join(hooks, 'agent-profile.cjs'));
const valid = Object.keys(table);
const known = (n) => valid.includes(n);
const bad = (n) => { console.log(`"${n}" is not a profile (${valid.join(', ')}); nothing changed`); };
const write = (file, name) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${name}\n`);
};
if (args.length === 0) {
  const { name, source } = effectiveProfile(sid, config);
  // A hand-edited file can hold a name the hook treats as "no rewrite" while still
  // shadowing whatever lower scope there is (the machine default, if the name came from the
  // session file; the fallback, if it came from the machine default); say so rather than
  // print it as if in force.
  console.log(known(name) ? `${name} (${source})` : `${name} (${source}) — not a profile; the hook ignores it`);
} else if (args[0] === 'default' && args.length === 2) {
  if (!known(args[1])) bad(args[1]);
  else {
    write(path.join(config, 'subagent-mode'), args[1]);
    console.log(`${args[1]} (default) written`);
    if (args[1] === 'fast') console.log(`warning: fast is experimental (roles: ${Object.keys(table.fast).join(', ')}); not recommended as a machine default while any of them is unevaluated`);
  }
} else if (args.length === 1) {
  if (!known(args[0])) bad(args[0]);
  else if (!sid || /[\\/]|\.\./.test(sid)) console.log('no usable session id; nothing changed');
  else { write(path.join(config, 'state', 'agent-profile', sid), args[0]); console.log(`${args[0]} (session) written`); }
} else {
  console.log(`unrecognised arguments: ${args.join(' ')}; nothing changed`);
}
EOF
```

The profile word (`fast` above) is the one argument slot: replace it with what the user
typed, or with `default fast`, or drop it for the no-argument form.

Three limits to say when switching to anything but `quality`:
- **Unattended ship-loop passes ignore it.** `bin/ship-loop.cjs` runs each pass with
  `SHIP_LOOP_PASS=1`, and the hook leaves dispatches alone there: no one is watching those
  runs to have chosen less reasoning for them.
- **An explicit `model` on a dispatch wins.** The profile fills the model only when the
  dispatch names none. A profile changes only the model and effort its row gives each role; the wall-clock time of
  a run goes mostly to test runs, which this does not change.
- **A plugin-prefixed dispatch gets only the row's model.** `<plugin>:<role>` is never
  renamed to a `-lite` twin and gets no effort change; the row's model is filled in only
  when the dispatch names none and the role does not already run on it.
