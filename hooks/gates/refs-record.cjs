#!/usr/bin/env node
// PostToolUse AND PostToolUseFailure on Serena's reference tools: records that
// something was looked up this turn, which is what edit-gate.cjs checks before
// allowing a source edit. The marker is cleared at each user prompt, so the
// requirement is per-turn rather than once-per-session.
//
// Only tools that answer "what else touches this" count. find_symbol locates a
// definition and says nothing about its callers, so it is deliberately absent:
// accepting it would let a lookup that proves nothing open the gate.
//
// A lookup on a file with no symbols does not return empty — Serena raises,
// so the call arrives here as PostToolUseFailure rather than PostToolUse, and
// without this a colleague editing a symbol-free file could never satisfy the
// gate at all. "Nothing depends on this" is as real an answer as a populated
// result list, so a failure of that shape counts too — but not every failure:
// accepting a wrong path, a malformed call, or Serena being down would let
// something that never looked open the gate just as well as something that
// did. Checked live against a real Serena (2026-09-24): PostToolUseFailure's
// only error information is a free-text `error` string, e.g. "Error executing
// tool find_referencing_symbols: ValueError: No symbol matching 'X' found" for
// find_referencing_symbols/find_implementations, and "...ValueError: No match
// found for regex: X" for find_declaration — there is no separate error-code
// or error-type field to key on instead. NOTHING_FOUND_RE is a text match on
// that string for exactly that reason, and will need updating if Serena
// rewords either message.
//
// The marker records WHICH repositories were looked up in, not just that a
// lookup happened: alongside the marker, one file per repository IDENTITY a
// successful lookup this turn was about is written into a per-session
// directory. edit-gate.cjs opens a repository only when its identity is
// among them, so a lookup in one repository never opens another. The
// granularity is deliberately the repository, not the file: looking up a
// function and then editing its callers elsewhere in the same repository is
// the intended workflow.
//
// A git worktree is its main checkout (operator decision, 2026-09-26): a
// lookup in a worktree, or in the checkout it belongs to, must open edits in
// either. `findGatedRoot` alone is not enough for this, because once a
// worktree gets its own `.serena/project.yml` (Serena writes one on first
// use), `findGatedRoot` returns the worktree, not the checkout. Identity
// (`repoIdentity` below) is compared instead of the gated root: a git
// worktree's identity is the same path under its main checkout that
// `findGatedRoot` would have returned had the worktree had no config of its
// own, so both forms of the same worktree collapse to one identity, while a
// nested Serena project below the same repository's top-level (`mono/svc`,
// `mono/web`) still keeps its own.
//
// Recording is one file write per identity, never a read-modify-write of a
// shared list: two lookups racing to record two DIFFERENT identities each
// touch only their own file and cannot lose each other's write, and two
// racing to record the SAME identity idempotently overwrite the same file.
// The reader (edit-gate.cjs, via `identityRecorded`) never lists or parses
// these files for the decision -- it hashes the identity it is checking and
// tests whether a file of that name exists, so a half-written file can never
// be misread as an answer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { markerPath, readStdin, findGatedRoot } = require('./gate-lib.cjs');
const { repoKey } = require('../serena-registry.cjs');

const SATISFYING_TOOLS = new Set([
  'find_referencing_symbols',
  'find_implementations',
  'find_declaration',
]);

const NOTHING_FOUND_RE = /\bValueError:\s*No\b[^\n]*\bfound\b/i;

// A user-level Serena is called as mcp__serena__<tool>. A plugin-provided one is
// renamed by Claude Code to mcp__plugin_<plugin-name>_<server-name>__<tool>,
// giving names like mcp__plugin_workflow-discipline_serena__find_referencing_symbols
// — the plugin name is not ours to assume, so this only checks that the server
// segment ends in "serena". Matching is done on the segment before the FINAL
// "__" (the tool name never contains "__" itself) rather than a fixed prefix
// list, so both naming forms are accepted without hardcoding any plugin's name.
function satisfies(toolName) {
  const i = toolName.lastIndexOf('__');
  if (i === -1) return false;
  const server = toolName.slice(0, i);
  const tool = toolName.slice(i + 2);
  if (!SATISFYING_TOOLS.has(tool)) return false;
  return server === 'mcp__serena' || (server.startsWith('mcp__plugin_') && server.endsWith('_serena'));
}

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// The repository the session started in. CLAUDE_PROJECT_DIR is what Claude
// Code sets for hooks; the hook's cwd is the fallback. repoKey returns a
// realpath, so every root compared below is one: os.tmpdir() on macOS sits
// under the /var -> /private/var symlink.
function sessionRoot(cwd) {
  return repoKey(process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd()).root;
}

// The identity of the repository a GATED ROOT (as returned by findGatedRoot)
// belongs to. A plain directory and every git worktree of it share one
// `--git-common-dir`, so a lookup made in any of them and an edit made in any
// other must agree on the same identity -- but `findGatedRoot` alone cannot
// give that agreement once a worktree has picked up its own
// `.serena/project.yml` (Serena writes one on first use): from that point on
// `findGatedRoot` returns the worktree itself, not the checkout the two used
// to share.
//
// The identity is the gated root's path EXPRESSED UNDER THE MAIN CHECKOUT:
// `<main checkout> + relative(<top-level>, realpath(<gated root>))`, from one
// `git rev-parse --path-format=absolute --git-common-dir --show-toplevel` run
// IN the realpath of the gated root (never the typed path: `findGatedRoot`
// only calls `path.resolve`, while git prints physically-resolved paths, and
// os.tmpdir() on macOS sits under the /var -> /private/var symlink -- taking
// `relative` across a symlinked and a resolved form of the same directory
// does not cancel to '.', it wanders off elsewhere entirely).
//
// `--show-toplevel` is what keeps two Serena projects in ONE git repository
// (`mono/svc`, `mono/web`) apart: both share a `--git-common-dir`, but their
// paths below `--show-toplevel` differ, and that suffix survives being
// rewritten onto the main checkout.
//
// Outside git, or on any git failure (a plain directory, a repo whose `.git`
// this process cannot read), the identity is the realpath of the gated root
// itself: with no git, there is no main checkout to map it onto.
function repoIdentity(gatedRoot) {
  const real = realpathOr(path.resolve(gatedRoot));
  let out;
  try {
    // Every non-git directory this runs against (a plain, ungated-of-git
    // fixture or repository) makes this fail with "fatal: not a git
    // repository", and execFileSync's default stdio pipes that straight
    // through to THIS process's own stderr rather than only attaching it to
    // the thrown error -- so a session working in an ordinary non-git repo
    // printed that line to the hook's stderr on every single lookup. Nothing
    // here reads stderr on failure (the catch below falls back to `real`
    // unconditionally), so it is piped and dropped instead of inherited.
    out = execFileSync('git', [
      'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel',
    ], { cwd: real, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return real; }
  const [commonDir, topLevel] = out.split('\n');
  if (!commonDir || !topLevel) return real;
  const mainCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return path.join(mainCheckout, path.relative(topLevel, real));
}

// The session's own identity, or its root when that is not gated. It is what
// a lookup with no path was about, and what an old-format marker vouches for.
// dirname is never taken here: the session's root is a directory, not a file.
function sessionIdentity(cwd) {
  const root = sessionRoot(cwd);
  const gated = findGatedRoot(root);
  return gated ? repoIdentity(gated) : root;
}

// The identity a lookup was about. A relative path resolves against the
// session's root, which is what Serena itself resolves it against, so
// `../<worktree>/x` lands in the worktree. An absolute path is the form
// serena-relay routes to another repository's Serena. findGatedRoot is the
// same walk edit-gate.cjs uses on the edit side, so a nested .git below a
// gated root cannot split the two; repoKey only names a root for a file
// outside every gated repository, and that fallback is used AS IS (a
// non-gated root is not a worktree-identity question at all).
function lookupIdentity(relativePath, cwd) {
  if (typeof relativePath !== 'string' || !relativePath) return sessionIdentity(cwd);
  const resolved = path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(sessionRoot(cwd), relativePath);
  const dir = path.dirname(resolved);
  const gated = findGatedRoot(dir);
  return gated ? repoIdentity(gated) : repoKey(dir).root;
}

// The per-session directory holding one file per recorded identity, sitting
// beside the session's own `<session>.json` marker (same `refs-checked/`
// folder, named after the bare session id -- a marker file always carries the
// `.json` suffix, so the two names never collide).
function identityDir(markerFile) {
  return path.join(path.dirname(markerFile), path.basename(markerFile, '.json'));
}

// The filename an identity is recorded under: a hash, never the identity
// text itself, so a slash-bearing path never has to be encoded into a single
// path segment. The read side (identityRecorded) only ever tests this name
// for EXISTENCE -- it never reads a file's content back out to decide
// anything, so a write that raced to completion after the read started can
// only be missed (treated as "not yet recorded"), never misread as a wrong
// answer.
function identityFileName(identity) {
  return `${crypto.createHash('sha256').update(identity).digest('hex')}.json`;
}

// Records that `identity` was looked up this turn: one file, named for the
// identity's hash, written into the session's identity directory. Two
// lookups racing to record two DIFFERENT identities each touch only their
// own file -- there is no shared list to read, modify and write back, so
// neither can clobber the other's write. Two racing to record the SAME
// identity idempotently overwrite the same file with the same content. The
// identity itself is kept as the file's content purely so a human (or a
// test) can read it back; the gate decision never depends on that content.
function recordIdentity(markerFile, identity) {
  const dir = identityDir(markerFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, identityFileName(identity)), JSON.stringify({ identity }));
}

// Whether `identity` was recorded this turn. False with no marker at all (no
// lookup was ever recorded). With a marker but no identity directory, or an
// empty one -- the old format, written either before identities existed or by
// an older hook version -- the marker vouches for the session's own identity
// only, and nothing else. Otherwise membership is decided purely by whether
// the hashed filename exists; the directory's other entries are never read.
function identityRecorded(markerFile, cwd, identity) {
  if (!fs.existsSync(markerFile)) return false;
  const dir = identityDir(markerFile);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* no directory: old format */ }
  if (!entries.length) return identity === sessionIdentity(cwd);
  return fs.existsSync(path.join(dir, identityFileName(identity)));
}

// Claude Code's own session ids are UUIDs; this is deliberately looser than
// that (plain alphanumerics, `_` and `-`) so it never rejects a real one, but
// it still refuses anything containing `/` or `.` -- the two characters a
// path-traversal payload needs. `session` is attacker-shaped input (it flows
// straight from hook JSON into a filesystem path below, with no sanitising in
// between), and an unvalidated `../../settings` or `..` there reaches outside
// the per-session marker/identity directory entirely. A session that fails
// this is treated exactly like no session at all: nothing is read or written
// for it, as in the `if (!session)` check below.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

module.exports = { lookupIdentity, sessionIdentity, identityRecorded, repoIdentity, identityFileName, realpathOr };

if (require.main === module) {
  readStdin((input) => {
    const session = input?.session_id;
    if (!session || !SESSION_ID_RE.test(session)) process.exit(0);
    if (!satisfies(input?.tool_name || '')) process.exit(0);

    const failed = input?.hook_event_name === 'PostToolUseFailure';
    // On failure, only a "looked and found nothing" answer counts. Anything
    // else (a bad call, a down server, a timeout) did not satisfy the
    // discipline the gate exists to enforce, so it must not open it.
    if (failed && !NOTHING_FOUND_RE.test(String(input?.error ?? ''))) process.exit(0);

    const m = markerPath('refs-checked', session);
    try {
      const cwd = input?.cwd;
      const identity = lookupIdentity(input?.tool_input?.relative_path, cwd);
      // Written before the marker: a reader that sees the marker already
      // wrote is guaranteed the identity file it names is there too.
      recordIdentity(m, identity);
      fs.mkdirSync(path.dirname(m), { recursive: true });
      fs.writeFileSync(m, JSON.stringify({
        at: new Date().toISOString(),
        tool: input.tool_name,
        target: input?.tool_input?.name_path ?? null,
        outcome: failed ? 'empty' : 'ok',
      }));
    } catch { /* a missing marker only means the gate asks again */ }
    process.exit(0);
  });
}
