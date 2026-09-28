#!/usr/bin/env node
// PreToolUse gate on Edit|Write|Bash: no source edit until something was looked up.
//
// CLAUDE.md requires understanding callers and dependencies before a non-trivial
// change. That rule is advisory and gets skipped under load — measured at 4.8%
// compliance across 4,874 edits — so this turns it into a gate: a change to a
// source file in a Serena-configured repo is denied until a reference lookup has
// been recorded for this turn in that same repository (refs-record.cjs writes
// the marker and the repository identities it covers; discipline-reminder.cjs
// clears both at each user prompt). A lookup in one repository does not open
// another.
//
// Bash is covered as well as Edit/Write, because two thirds of tool calls in
// this setup are Bash and file edits migrate there (`sed -i`, heredocs) under
// auto mode. An Edit|Write-only gate sees none of them. PowerShell is covered
// the same way: it is what Claude Code runs instead of Bash on Windows, and a
// gate that only recognised the tool name `Bash` let every write and commit on
// that platform through unexamined.
//
// Silent no-op everywhere else — repos with no Serena project config, non-source
// files, reads, missing state. Set SKIP_CODE_GATES=1 to disable.
const path = require('path');
const {
  markerPath, gatesDisabled, findGatedRoot: findGatedRootUncached, isSourceFile, bashWriteTargets,
  deny, readStdin, shipPhase,
} = require('./gate-lib.cjs');
const { identityRecorded, repoIdentity: repoIdentityUncached } = require('./refs-record.cjs');

// Both spawn a `git rev-parse`: findGatedRoot falls back to mainCheckoutRoot's
// `--git-common-dir` once its own filesystem walk finds nothing, and
// repoIdentity always runs its own `--show-toplevel` lookup. A Bash command
// naming many source targets calls each once per target below (the filter
// building `gated`, then the marker check building `unopened`), so a write
// touching hundreds of files would otherwise spend seconds in `git`
// subprocesses that all answer the same question for the same directory or
// the same gated root: each spawn costs roughly a dozen milliseconds, which
// adds up linearly with the target count with nothing memoized. One hook run
// is one Node process handling one PreToolUse call, so a plain module-level
// Map is scoped correctly on its own -- it never survives past this
// invocation, so there is no cross-run cache to invalidate when a worktree
// is added or a `.serena/project.yml` is written mid-session. Keyed on
// exactly what each function's own answer depends on: a directory for
// findGatedRoot's walk, a gated root for repoIdentity's.
function memoize(fn) {
  const cache = new Map();
  return (arg) => {
    if (!cache.has(arg)) cache.set(arg, fn(arg));
    return cache.get(arg);
  };
}
const findGatedRoot = memoize(findGatedRootUncached);
const repoIdentity = memoize(repoIdentityUncached);

function allow() { process.exit(0); }

function reason(targets, root) {
  const names = [...new Set(targets.map((t) => path.basename(t)))].slice(0, 5).join(', ');
  return (
    `No reference lookup has been run this turn in ${path.basename(root)}, the repository ` +
    `${names} lives in; a lookup in another repository does not count. ` +
    `Find out what depends on the symbol you are about to change — call Serena's ` +
    `"find referencing symbols" tool ({name_path: "<symbol>", relative_path: "<file>"}) — ` +
    `report what it returns, then retry. Under a plugin install the tool name is ` +
    `namespaced (mcp__plugin_<plugin-name>_serena__find_referencing_symbols, not ` +
    `mcp__serena__find_referencing_symbols); look for whichever variant is available. ` +
    `If the file is outside the repository this session started in — a /ship worktree or ` +
    `another repository — pass its absolute path as relative_path; serena-relay routes the ` +
    `call to that repository's own shared Serena. ` +
    `No tool resolves a string reference (getattr, a scheduler registry, monkeypatch.setattr), ` +
    `so where one is plausible confirm with a grep as well: "no callers found" is not proof.`
  );
}

// Phases where nothing has been agreed yet: no approach chosen, no plan
// written, no plan approved. Editing source here is the exact failure this
// gate exists to catch — measured on a real /ship run, where the agent
// edited two source files during triage and no hook caught it.
const BLOCKED_PHASES = new Set(['awaiting-direction', 'planning', 'awaiting-approval']);
const WAITING_ON = {
  'awaiting-direction': 'a chosen approach (Gate 1)',
  planning: 'a written plan',
  'awaiting-approval': 'plan approval (Gate 2)',
};

function phaseReason(phase, targets) {
  const names = [...new Set(targets.map((t) => path.basename(t)))].slice(0, 5).join(', ');
  return (
    `A /ship run bound to this session is at phase '${phase}', waiting on ${WAITING_ON[phase]}. ` +
    `${names} is a source file and nothing has been agreed yet, so editing it now is premature. ` +
    `Answer the open gate with \`/ship\` and let the run reach 'executing' before editing source. ` +
    `If this is genuinely a small fix that needs no run at all, say so and do it without starting ` +
    `one — /blueprint's "do it now" triage creates no run state and this gate does not apply to it. ` +
    `SKIP_CODE_GATES=1 overrides this gate if neither of those fits.`
  );
}

readStdin((input) => {
  if (gatesDisabled()) return allow();
  const session = input?.session_id;
  if (!session) return allow();

  const tool = input?.tool_name || '';
  const cwd = input?.cwd || process.cwd();
  let targets = [];

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const fp = input?.tool_input?.file_path;
    if (fp) targets = [fp];
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    // Windows falls back to PowerShell as the primary shell tool when Git Bash
    // is absent; the command text lives in the same tool_input.command field,
    // so the same write-target scan applies unchanged.
    targets = bashWriteTargets(input?.tool_input?.command || '', cwd);
  } else {
    return allow();
  }

  const gated = targets.filter((t) => isSourceFile(t) && findGatedRoot(path.dirname(t)));
  if (!gated.length) return allow();

  // Checked before the refs-checked marker, and unconditionally: a reference
  // lookup says what depends on the code, not whether editing it now is
  // legitimate. A run parked at 'planning' with a marker from an earlier,
  // now-superseded edit must still be denied.
  const phase = shipPhase(session, cwd);
  if (BLOCKED_PHASES.has(phase)) {
    deny(phaseReason(phase, gated));
    return;
  }

  // Every gated target's repository must have been looked up in this turn,
  // compared by repository IDENTITY rather than by gated root: a git
  // worktree and its main checkout share one identity (repoIdentity), so a
  // lookup in either opens edits in both, while findGatedRoot alone would
  // not once the worktree has its own .serena/project.yml.
  const marker = markerPath('refs-checked', session);
  const unopened = gated.filter((t) => !identityRecorded(marker, cwd, repoIdentity(findGatedRoot(path.dirname(t)))));
  if (!unopened.length) return allow();

  deny(reason(unopened, findGatedRoot(path.dirname(unopened[0]))));
});
