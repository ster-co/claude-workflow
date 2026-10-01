// Shared helpers for the discipline gates.
//
// The gates exist because CLAUDE.md's "look before you edit" was honoured in
// 4.8% of edits: advisory rules decay under load. They are deliberately
// conservative — a gate that blocks work it was never meant to police is worse
// than no gate, because it gets switched off.
//
// Ported from an earlier locally-built call-graph indexing tool's gates on
// 2026-09-21, after that tool's index was measured returning 0 of 8 true
// callers with 7 false positives on a freshly built index. That tool answered
// "who calls this symbol?" from a graph it built and had to keep rebuilt; the
// discipline here is unchanged, only the evidence that satisfies it moved —
// from its caller report to mcp__serena__find_referencing_symbols, and from
// its own file-change tracking to an actual `git diff`. The shell parsing
// below is carried over verbatim: it is the part that took the most
// iterations to get right.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runFor } = require('../run-state.cjs');

const SOURCE_EXT = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.cs', '.swift', '.c', '.h', '.cpp', '.hpp',
]);

// Claude Code lets CLAUDE_CONFIG_DIR move the whole config elsewhere. Building
// the marker path from the home directory ignored that, so running against a
// throwaway config still wrote per-turn state into the real ~/.claude.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'state');
const markerPath = (kind, session) => path.join(STATE_DIR, kind, `${session}.json`);

function gatesDisabled() {
  return process.env.SKIP_CODE_GATES === '1';
}

/**
 * The main checkout a directory's `.git` ultimately shares, via
 * `git rev-parse --git-common-dir`. A plain repo and every `git worktree` of
 * it all resolve to the same `.git` here, which is what lets a worktree be
 * recognised as belonging to a gated repo whose `.serena/project.yml` lives
 * only in the main checkout — a worktree does not get its own `.serena/`
 * (`claude-repo-setup.sh` runs once, against the checkout it was pointed at).
 * Returns null for anything that is not inside a git working tree at all.
 */
function mainCheckoutRoot(dir) {
  let out;
  try {
    // --git-common-dir is printed relative to the directory git actually ran
    // in, which for a symlinked `dir` is the symlink's RESOLVED target
    // (getcwd() inside git sees through the symlink), not `dir` itself.
    // Resolving that relative output against `dir` then landed nowhere near
    // the real repo — a symlink into a subdirectory of a gated main checkout
    // read as ungated. --path-format=absolute makes git do that resolution
    // itself, from the directory it is actually standing in, instead of this
    // function redoing it against a path that may not match.
    // findGatedRoot calls this as a fallback once its own walk up from
    // `start` finds no `.serena/project.yml`, so `dir` routinely names a
    // directory outside any git working tree entirely -- there `git
    // rev-parse` exits non-zero with "fatal: not a git repository ...".
    // execFileSync's default stdio would inherit that message onto THIS
    // process's own stderr in addition to attaching it to the thrown error;
    // the stdio option here discards stderr instead, the same way
    // repoIdentity's own execFileSync in refs-record.cjs already does.
    // Nothing here reads stderr on failure (the catch below returns null
    // unconditionally), so discarding it costs nothing.
    out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
  if (!out) return null;
  return path.basename(out) === '.git' ? path.dirname(out) : out;
}

/**
 * A repo counts as gated when Serena has a PROJECT config for it —
 * `.serena/project.yml`. Keying on the directory alone would be a trap: Serena
 * also writes a GLOBAL `~/.serena/` holding `serena_config.yml`, `logs/` and
 * `language_servers/` and no project.yml at all, so a directory test would make
 * the home folder look gated and fire these gates on every file on the machine.
 * The earlier call-graph indexing tool set exactly the same trap with its own
 * global registry file; this is that lesson carried over rather than
 * relearned.
 *
 * Scoping to Serena-configured repos also keeps coverage honest: the gate applies
 * exactly where the tool that satisfies it actually works, and claude-repo-setup.sh
 * is what extends that set.
 */
function findGatedRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.serena', 'project.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found by walking up from `start` itself. `start` may be a
  // worktree whose OWN directory tree never reaches the `.serena/` that
  // governs it, because that lives only in the main checkout — resolve it
  // via the shared `.git` and check there before giving up. This also
  // re-runs the identical (fast, cheap) check for the ordinary non-worktree
  // case that already failed above; it is not expected to find anything new
  // there.
  const common = mainCheckoutRoot(path.resolve(start));
  if (common && fs.existsSync(path.join(common, '.serena', 'project.yml'))) return common;
  return null;
}

function isSourceFile(p) {
  return SOURCE_EXT.has(path.extname(p).toLowerCase());
}

/**
 * The phase of the `/ship` run bound to this session in this repo, or null
 * when no run constrains this edit.
 *
 * `null` covers three cases a caller must NOT distinguish: no session, no
 * pointer for it, or a pointer that names a run in a different repository —
 * run-state.cjs's `resolve` already refuses a pointer whose `repoKey` does not
 * match this `cwd`, which is what stops a run in one repo blocking edits in
 * another, and `runFor` is the entry point that carries that check rather than
 * a hand-rolled read of the pointer file. It also covers a run that has
 * finished (`finishedAt` set): `run-state.cjs finish` already clears `phase`
 * to null when it stamps `finishedAt`, but that is treated as authoritative
 * here rather than assumed, so a state file written by an older run-state.cjs
 * that stamped `finishedAt` without also clearing `phase` still reads as
 * unconstrained.
 *
 * `/blueprint`'s "do it now" triage is the reason this must default open: it
 * deliberately creates no run state for a small fix, so a session with
 * nothing bound here must read exactly like one with a run parked at
 * `executing` — both allowed.
 */
function shipPhase(session, cwd) {
  if (!session) return null;
  let state;
  try {
    state = runFor(cwd, session);
  } catch {
    return null;
  }
  if (!state || state.finishedAt) return null;
  return state.phase || null;
}

function unquote(t) {
  return t.replace(/^['"]|['"]$/g, '');
}

// Heredoc bodies are stripped before shell-level parsing so that a `.py` string
// merely *printed* inside a script is not mistaken for a redirect target. The
// python-level detector below re-reads the full text for actual write calls.
function stripHeredocBodies(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, '<<HEREDOC');
}

/**
 * The shell text with heredoc bodies and quoted strings removed, i.e. what the
 * command actually *runs*. Prose that names a command — documentation, an echo, a
 * JSON payload being piped to a script — is not that command. Both gates fired on
 * exactly that before this existed.
 */
function executableShellViews(command) {
  const text = stripHeredocBodies(command)
    // Backslash-escaped quotes are literal characters, not delimiters. Leaving them
    // in mis-pairs the strippers below and exposes the inside of a JSON payload as
    // if it were shell — which is how this gate blocked a command that only *named*
    // `git commit` inside a quoted argument.
    .replace(/\\["']/g, '');
  const SINGLE = [/'[^']*'/g, "''"];
  const DOUBLE = [/"[^"]*"/g, '""'];
  const blank = (first, second) => text.replace(...first).replace(...second);
  // Two readings, one per stripping order. Blanking single-quoted spans first
  // pairs an apostrophe inside a double-quoted word (`"it's"`) with the next
  // `'` anywhere later, and blanks every command in between; blanking
  // double-quoted spans first reads that command correctly, and has the mirror
  // weakness for a `"` inside single quotes. A gate that denies when EITHER
  // reading shows a command sees everything the single-first reading alone
  // saw, plus what it hid.
  return [blank(SINGLE, DOUBLE), blank(DOUBLE, SINGLE)];
}

// Both readings joined by a newline, which tokenize and gitSubcommandIs treat
// as a command separator, so each reading's commands stay separate. The
// redirect and tee patterns in bashWriteTargets can cross a newline, so it
// walks the two readings one at a time instead of using this.
function executableShell(command) {
  return executableShellViews(command).join('\n');
}

// Shell operators separate commands whether or not they are spelled with spaces
// around them. `git add x&&git commit -m y` is two commands, and splitting on
// whitespace alone produced the token `x&&git`, so the second `git` was never
// seen. Normalise first, tokenise once. Shared by both gates, and by
// gitRunDirs below, so the three do not carry three slightly different copies
// of the same parse.
const SEPARATOR = /^(&&|\|\||[;&|<>])$/;
const tokenize = (shell) => shell
  .replace(/(&&|\|\||[;&|<>])/g, ' $1 ')
  // A newline is a command separator too. `\s+` already treats it as
  // whitespace between tokens, which is exactly the bug: the newline
  // disappears into that whitespace run instead of surviving as a token of
  // its own, so a `cd sub\ngit commit` looks to every SEPARATOR-testing
  // consumer like there was never anything between `sub` and `git` at all —
  // the `git` token, and the command it names, went unseen. A newline runs
  // the next statement unconditionally, exactly like `;`, so it is folded
  // into the same separator token rather than kept distinct.
  .replace(/\r?\n/g, ' ; ')
  .split(/\s+/)
  .filter(Boolean);

// Git's global flags sit between `git` and the subcommand, and several take a
// separate value token (`-c user.name=x`, `-C dir`, `--git-dir path`).
// Consuming the flag without its value lets the value be mistaken for the
// subcommand, or the subcommand be mistaken for that flag's value.
const VALUE_FLAGS = /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

/**
 * Walks past `git` and its global flags and returns where the subcommand sits,
 * plus the `-C <dir>` that git would run in (as the raw token, still quoted /
 * unresolved). Returns null if this is not a git invocation at all.
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

/**
 * A `cd`/`-C` argument fit to trust as a literal directory name, per
 * Decision 9's allowlist grammar: no quote character anywhere in it, no `$`
 * or backtick (a variable or command substitution), no `~` (needs `$HOME`
 * to expand), no glob metacharacter (`*`, `?`, `[...]` character classes,
 * `{...}` brace expansion), no parenthesis (a subshell marker masquerading
 * as a word), no leading `-` (an option, not a path), and not empty. A
 * bracketed token such as `n[o]pe` may not land where its own text says it
 * does — the shell can expand it against whatever else happens to be on
 * disk — so trusting it just because a directory of that exact bracketed
 * name happens to exist would be the same mistake `~`/`*`/`?` are already
 * refused for.
 *
 * `raw` must be the token as it appears in the ORIGINAL, unquote-blanked
 * shell text — gitRunDirs below is deliberately given that text rather than
 * the quote-blanked `shell` every other helper in this file uses, because a
 * quoted `-C` target used to be blanked to `''`/`""` by that shared stripper
 * and then treated as a literal empty-string path, silently resolving to
 * "the current directory" instead of being refused as unresolvable.
 */
function isCleanLit(raw) {
  if (!raw || raw.startsWith('-')) return false;
  return !/['"$`~*?()[\]{}]/.test(raw);
}

/**
 * The inner text of `raw` when it is a whole, balanced QUOTED literal --
 * trusted by `universalFallback`'s `bashWriteTargets` caller even though
 * isCleanLit (correctly) refuses it there for its own quote characters.
 * `'...'` of any content is trusted unconditionally: POSIX single quotes
 * admit no escaping at all, so a balanced pair can only ever hold literal
 * text -- the same fact `stripSafeQuotes` below relies on for a
 * single-quoted span. `"..."` is trusted only when its content has no `$`
 * or backtick (a substitution could be hiding in it) and no `\` that escapes
 * anything (one followed by $ ` " \ or a newline); a backslash before any
 * other character is literal text, as in a Windows path.
 *
 * `raw` must be a token straight out of `gitDirTokens`, which keeps quote
 * characters IN the token rather than stripping them. Checking `raw[0]` and
 * its last character against the SAME quote character rules out a quote that
 * does not bound the WHOLE token (`'B'foo`, `foo'B'`), but that alone is not
 * enough to prove the token is nothing but one quoted span: `'a'b'c'` and
 * `"a"b"c"` pass that check too, yet each is several quoted fragments the
 * shell concatenates side by side (`cd 'a'b'c'` names the directory `abc`),
 * not one literal `a'b'c`/`a"b"c`. So the inner text is refused whenever it
 * contains the SAME quote character again -- a genuine, single quoted span
 * can never hold an unescaped copy of its own delimiter.
 *
 * Returns null for anything that is not a whole, trustworthy quoted span.
 * Never called from `gitRunDirs`' own candidate collection, or from the
 * strict per-`git` grammar below, both of which trust only what isCleanLit
 * accepts.
 */
function quotedLitValue(raw) {
  if (!raw || raw.length < 2) return null;
  const q = raw[0];
  if ((q !== "'" && q !== '"') || raw[raw.length - 1] !== q) return null;
  const inner = raw.slice(1, -1);
  if (inner.includes(q)) return null;
  // Inside double quotes `$` and backtick can substitute, and `\` escapes only
  // when followed by $ ` " \ or a newline. A `\` before anything else is
  // literal text, in bash and PowerShell alike -- which is every backslash in a
  // Windows path (`"C:\repo"`). Refusing those dropped the directory from the
  // candidate set, so a gated repo named that way went unchecked.
  if (q === '"' && (/[$`]/.test(inner) || /\\([$`"\\\n]|$)/.test(inner))) return null;
  return inner;
}

/**
 * The index in `tokens` (a segment's own token list, with `tokens[0] ===
 * 'cd'` already confirmed by the caller) of `cd`'s directory argument, or
 * null when there is none. `acceptFlags` additionally skips a leading `--`,
 * `-P` or `-L` -- `cd -- B`, `cd -P B`, `cd -L B` are all ordinary POSIX
 * `cd` invocations naming B, not B named `--`/`-P`/`-L` itself. Passed only
 * from `bashWriteTargets`: `gitRunDirs`' own strict grammar, and its
 * universalFallback fallback, trust only the unadorned `cd LIT` shape.
 */
function cdArgIndex(tokens, acceptFlags) {
  let i = 1;
  if (acceptFlags) {
    while (i < tokens.length && (tokens[i] === '--' || tokens[i] === '-P' || tokens[i] === '-L')) i++;
  }
  return i < tokens.length ? i : null;
}

function isRealDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// `p` with every symlink component dereferenced, or `p` itself when it does
// not exist (a candidate directory this walk could not resolve at all is
// still worth keeping AS TYPED — universalFallback already only adds
// candidates isRealDir confirms exist, so this only ever fires on `start`,
// which must stay a candidate even when it happens not to exist).
function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Whether `lit` contains a `..` PATH COMPONENT anywhere in it — not merely the
 * two characters, which could also occur inside a longer segment name like
 * `foo..bar`. Reviewer must-fix: `git -C F/L/..`, where `L` is a symlink into
 * a gated repo's subdirectory, is trusted enough by isCleanLit alone (no quote,
 * no glob character) to enter the strict per-`git` grammar below, which then
 * resolves it with plain `path.resolve` — a purely textual operation that
 * cancels `L` against the trailing `..` without ever knowing `L` is a symlink,
 * landing on the symlink's ungated HOST directory instead of its real,
 * possibly gated, parent. Refusing any literal that spells `..` at all, on the
 * strict/fast path only, closes that off structurally: a literal this
 * function refuses is never trusted to drop the session directory, so it
 * falls to universalFallback instead, which keeps the session directory (and
 * every directory the command names) a candidate regardless of what this
 * function made of the rest of the path. This is deliberately broader than
 * the exact shape found — belt and braces alongside physicalResolve below,
 * not a substitute for it.
 */
function hasDotDotSegment(lit) {
  return lit.split(/[\\/]/).includes('..');
}

/**
 * A cd/-C literal resolved the way an actual `chdir` — and so `git -C` itself
 * — resolves it: physically, following whatever symlinks the path passes
 * through, rather than the textual, lexical collapsing `path.resolve` alone
 * performs. Concatenating with `path.resolve` first and dereferencing after
 * only works when nothing in `cur`/`lit` needs a filesystem lookup to make
 * sense of; a `cur` that is itself a symlink still resolves correctly here
 * because `fs.realpathSync` dereferences the WHOLE input, not just its own
 * argument — the caller does not need to have realpath'd `cur` already.
 *
 * hasDotDotSegment above already refuses to let a `..`-bearing literal reach
 * this function on the strict/fast path at all, so in practice every `lit`
 * arriving here needs only its symlinks dereferenced, never a `..` walked
 * back out of one — but resolving physically at every step, rather than
 * trusting that argument to hold for every shape nobody has tried yet, is the
 * belt this file's own reviewer asked for.
 *
 * Returns null when the result does not exist (or `cur` itself no longer
 * does), so the caller treats it exactly like any other unresolvable
 * literal: ineligible for the fast path.
 */
function physicalResolve(cur, lit) {
  try {
    return fs.realpathSync(path.resolve(fs.realpathSync(cur), lit));
  } catch { return null; }
}

/**
 * A quote-aware tokenizer over the RAW (heredoc-stripped, otherwise
 * unmodified) command text — kept separate from the shared `tokenize`
 * above because that one runs on `executableShell`'s output, which has
 * already replaced every quoted span with `''`/`""`. That is fine for
 * deciding whether an unquoted `git commit` is really there; it is useless
 * for telling a token that TYPED like a plain path from one that only
 * looks that way after blanking erased its quotes.
 *
 * Whitespace and operator characters are token/statement boundaries only
 * OUTSIDE a quote — inside one they are literal content, so `-m "a && b"`
 * stays one token and its `&&` is never mistaken for a real separator. A
 * multi-character operator (`&&`, `||`) is matched before the
 * single-character set, and a newline is folded into `;`, the same way
 * `tokenize` above folds it: it runs the next statement unconditionally,
 * exactly like `;` does.
 */
function gitDirTokens(command) {
  const text = stripHeredocBodies(command);
  const OPERATOR_CHARS = ';&|<>';
  const tokens = [];
  let cur = '';
  let quote = null;
  const push = () => { if (cur) { tokens.push(cur); cur = ''; } };
  const pushOp = (op) => { push(); tokens.push(op); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { cur += ch + text[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '&' && text[i + 1] === '&') { pushOp('&&'); i++; continue; }
    if (ch === '|' && text[i + 1] === '|') { pushOp('||'); i++; continue; }
    if (OPERATOR_CHARS.includes(ch)) { pushOp(ch); continue; }
    if (ch === '\n') { pushOp(';'); continue; }
    if (ch === '\r') continue;
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
  }
  push();
  return tokens;
}

/**
 * The command's tokens cut into the shell segments `&&`/`||`/`;`/`&`/`|`/
 * `<`/`>` join, each segment keeping only its own word tokens and the single
 * operator token that led into it (`null` for the very first segment). This
 * is what lets gitRunDirs check the ONE shape it trusts enough to drop the
 * session directory: an unbroken `cd LIT &&` prefix running from the very
 * start of the command, with nothing else mixed in anywhere in that prefix.
 */
function splitSegments(tokens) {
  const OPS = new Set(['&&', '||', ';', '&', '|', '<', '>']);
  const segments = [];
  let cur = [];
  let precededBy = null;
  for (const t of tokens) {
    if (OPS.has(t)) {
      segments.push({ tokens: cur, precededBy });
      precededBy = t;
      cur = [];
    } else {
      cur.push(t);
    }
  }
  segments.push({ tokens: cur, precededBy });
  return segments;
}

/**
 * The fail-closed candidate set used whenever a `git` invocation does not
 * match the strict allowlist grammar below: the session directory itself,
 * plus every OTHER directory the command so much as mentions via a `cd`
 * that is the first word of its own segment, or a `-C` flag wherever it
 * sits (`env -C DIR ...` included -- this loop does not care what precedes
 * the flag), as long as that argument is a clean literal (isCleanLit)
 * resolving to a directory that actually exists. None of this claims to
 * know which of them the git command actually ran in — that is exactly what
 * could not be established — it only widens the set a caller denies
 * against, per Decision 9: "the gate denies if any candidate blocks."
 *
 * `opts.acceptQuotedLit` and `opts.acceptCdFlags` are for `bashWriteTargets`
 * alone. `gitRunDirs`' two calls below pass neither, so its own candidate
 * set — and the strict per-`git` grammar's own fallback — are exactly as
 * narrow as isCleanLit makes them: only the caller that opts in trusts
 * a quoted literal (`quotedLitValue`) as a directory argument — a `cd`'s own
 * argument (via `cdArgIndex`, which also admits a `cd --`/`cd -P`/`cd -L`
 * prefix) OR a `-C` flag's argument, since `add` below is the single path
 * both go through.
 */
function universalFallback(segments, start, opts = {}) {
  const out = new Set([start]);
  const add = (lit) => {
    if (!isCleanLit(lit)) {
      if (!opts.acceptQuotedLit) return;
      const unquoted = quotedLitValue(lit);
      if (unquoted === null) return;
      lit = unquoted;
    }
    const abs = path.resolve(start, lit);
    if (isRealDir(abs)) out.add(realOrSelf(abs));
  };
  for (const seg of segments) {
    if (seg.tokens[0] === 'cd') {
      const i = cdArgIndex(seg.tokens, opts.acceptCdFlags);
      if (i !== null) add(seg.tokens[i]);
    }
    for (let i = 0; i < seg.tokens.length; i++) {
      if (seg.tokens[i] === '-C') add(seg.tokens[i + 1]);
    }
  }
  return out;
}

// Shell features whose comment / heredoc / quote / subshell handling
// gitDirTokens takes on faith rather than fully parses. Get one wrong — an
// unmatched `'` inside a `#` comment, inside `$'...'` ANSI-C quoting, or
// inside a heredoc body stripHeredocBodies failed to recognise (its
// delimiter grammar does not accept a hyphen, so `<<END-MSG` slips through
// unstripped) — and the quote-aware tokenizer's quote state desyncs for the
// rest of the command, silently losing whatever `git` token came after the
// corruption. Reviewer-found: `"# don't forget\ngit commit -m x"`,
// `"echo hi # it's done\ngit commit -m x"`, `"echo $'it\\'s' && git commit"`,
// and a heredoc with an apostrophe in its body all made gitRunDirs return
// `[]` — no candidates at all, so both gates allowed a commit HEAD used to
// deny. `(`/`)` get the same treatment: a subshell's `cd` must never be
// trusted as a literal, and the strict grammar below already refuses it, but
// a stray unmatched paren inside one of these same risky spans can desync
// the tokenizer exactly like a quote can. `$` joins the set for the same
// reason a bare, unquoted one always could start a `$(...)`/`${...}`
// substitution this parser does not evaluate.
const RAW_RISKY_CHARS = /[#'"\\`()$]/;

/**
 * Replaces every quoted span in `command` that cannot execute or expand
 * anything with a single placeholder word, so isSimpleCommand's
 * risky-character scan below never has to see it: a `'...'` of any content
 * (POSIX single quotes admit no escaping at all, so a balanced pair can only
 * ever hold literal text) or a `"..."` whose content has none of `$`,
 * backtick, `\` (so no command/variable substitution and no escape sequence
 * can be hiding in it — inside double quotes those three are the ONLY
 * characters with special meaning; parentheses and apostrophes are plain
 * text there).
 *
 * A `"..."` that DOES contain one of those, or a `'`/`"` with no matching
 * close, is left exactly as it was — quote character and all — rather than
 * guessed at. That is deliberate: it is what makes isSimpleCommand's scan
 * below fail such a command, the same way it always has.
 *
 * This has no effect on what gitRunDirs actually trusts as a `cd`/`-C`
 * literal: that walk always tokenizes the ORIGINAL, unstripped command via
 * gitDirTokens, and isCleanLit rejects any token that still contains a quote
 * character. A quoted string can supply nothing to that grammar whether or
 * not this function judged it safe to elide from isSimpleCommand's view.
 */
function stripSafeQuotes(command) {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) { out += ch; continue; } // unmatched: leave it to fail the scan below
      out += 'Q';
      i = end;
      continue;
    }
    if (ch === '"') {
      // Walk to the matching close, honouring backslash-escaping exactly like
      // gitDirTokens does, so an escaped `"` inside the string is not
      // mistaken for its end.
      let j = i + 1;
      let content = '';
      let closed = false;
      while (j < command.length) {
        const c = command[j];
        if (c === '\\' && j + 1 < command.length) { content += c + command[j + 1]; j += 2; continue; }
        if (c === '"') { closed = true; break; }
        content += c;
        j++;
      }
      if (!closed) { out += ch; continue; } // unmatched: leave it to fail the scan below
      if (/[$`\\]/.test(content)) {
        // Cannot prove this span is inert: leave the whole thing, quotes
        // included, so the scan below still sees why.
        out += command.slice(i, j + 1);
      } else {
        out += 'Q';
      }
      i = j;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Whether `command` is safe to hand to the strict per-`git` allowlist grammar
 * below at all. Every quoted span stripSafeQuotes can prove is inert is first
 * replaced by a placeholder word; what is left must contain none of
 * RAW_RISKY_CHARS and no heredoc `<<`. Failing that makes the tokenizer's own
 * quote/comment/heredoc handling irrelevant to the allow decision: gitRunDirs
 * falls back to universalFallback for the WHOLE command below, which always
 * keeps the session directory a candidate regardless of what gitDirTokens
 * made of the rest of the text.
 *
 * This used to also require exactly one `git` word in the stripped text, on
 * the theory that a second `git` elsewhere is exactly the shape that can go
 * missing from gitDirTokens' output without this function ever finding out.
 * That check was itself unsound: stripSafeQuotes collapses an ENTIRE inert
 * quoted span to one placeholder before the count runs, so a real, executing
 * `git` sitting inside such a span — `'git'`, `"git"`, `g''it`, and
 * `sh -c 'git commit'` are all, to the shell, just `git` — vanished from the
 * count instead of being counted as a second one. A genuine, structurally
 * eligible `git` earlier in the command then made the whole thing look
 * "simple" under that undercount, and the hidden one's real directory (often
 * the session dir, since nothing needed to `cd` for it) went unrepresented in
 * gitRunDirs' result. Removed rather than patched: the eligibility walk below
 * now requires the recognised `git`'s segment to be the LAST segment of the
 * whole command, which closes this off structurally — anything capable of
 * running a second command, spelled any way at all, has to sit in a later
 * segment or later in the same one, so the earlier `git` is then not last and
 * falls back regardless of whether this function ever saw the second one.
 */
function isSimpleCommand(command) {
  const stripped = stripSafeQuotes(command);
  return !RAW_RISKY_CHARS.test(stripped) && !stripped.includes('<<');
}

/**
 * The directory (or directories, when the command can't be trusted to name
 * just one) that each `git` invocation in `command` actually runs in.
 *
 * This replaced a first cut that tracked a single "certain" directory
 * FORWARD through the token stream, breaking that certainty on any operator
 * but `&&`. Two review rounds rejected it: each round's fix patched one
 * shape the walk had failed to model — an `echo cd U` mistaken for a real
 * `cd`, a `git -C "$VAR"` whose quotes were blanked away by the shared
 * stripper before this function ever saw them, a bare `env -C`/`pushd`
 * redirection the walk had no notion of at all — and the next review found
 * another. The root cause: forward tracking treats "so far, nothing has
 * broken certainty" as proof of safety, which is only true until the next
 * shape someone thinks of.
 *
 * This is the allowlist that replaced it: the session directory (`cwd`) may
 * be dropped for a given `git` ONLY when the entire command, start to end,
 * matches, token for token,
 *
 *   (cd LIT &&)* git [-C LIT]... SUBCOMMAND ...
 *
 * with NOTHING after it — `cd` and `git` each the very first word of their
 * segment, segments joined by `&&` alone, every LIT a single clean literal
 * (isCleanLit) that resolves to a directory that actually exists, nothing
 * between `git` and the subcommand except repeated `-C LIT` (no `-c`,
 * `--git-dir`, `--work-tree`, or anything else global git accepts there),
 * and this `git`'s segment is the LAST segment of the whole command: no
 * `;`, `&&`, `||`, `|`, `&`, newline or redirect follows it, spelled any way
 * at all. That last clause is load-bearing on its own, not just one more
 * shape to recognise: quoting a word does not stop the shell from running
 * it — `'git' commit -m y` executes exactly like `git commit -m y` — so a
 * second, real git invocation can hide behind a quote (`'git'`, `"git"`,
 * `g''it`) or a nested interpreter (`sh -c 'git commit'`) in a way no
 * amount of better quote-parsing forecloses in general. Requiring the
 * recognised `git` to be the command's last segment closes that off
 * structurally instead: anything capable of running a second command has to
 * sit in a later segment or later in the same one, and either way this
 * `git` is then not the last segment and falls back. Anything at all
 * outside the full shape above — for THIS `git`, not just its immediate
 * neighbour — and the session directory stays a candidate alongside every
 * other directory the command so much as names (universalFallback). A
 * caller that denies when ANY candidate is a problem (both gates here do)
 * fails closed on the shape it does not recognise instead of trusting
 * whichever directory happened to be cheapest to compute.
 *
 * `command` must be the RAW shell text, not `executableShell`'s
 * quote-blanked output — see isCleanLit's comment for why.
 *
 * That precise per-`git` walk runs only when isSimpleCommand(command) says
 * the raw text is free of the shell features whose handling gitDirTokens
 * takes on faith. Otherwise every candidate this function could return is
 * exactly as uncertain as the "not eligible" branch inside the walk below,
 * so the whole command goes straight to universalFallback instead of trusting
 * per-git-invocation results built on a tokenization that might have silently
 * lost a `git` token to an unmatched quote in a comment, a heredoc, or
 * `$'...'` quoting.
 *
 * Returns absolute paths, deduplicated, in the order first reached.
 */
function gitRunDirs(command, cwd) {
  // BRIEF 12 (BRIEF 2 review, accepted open): this used to return each
  // candidate WITHOUT realpath'ing it, on the theory that findGatedRoot
  // resolves gated-ness physically itself (via a real git subprocess), so the
  // TYPED form was good enough for that caller and better for plan-gate's own
  // marker keying. That theory held for a symlink INTO the middle of a gated
  // checkout — findGatedRoot's own git subprocess sees through it — but not
  // for a symlink to a NESTED repo (a vendored checkout under a gated tree's
  // own vendor/, say): findGatedRoot walks up from whatever directory string
  // it is handed looking for `.serena/project.yml`, and a symlink's own,
  // un-dereferenced ancestry never reaches the gated tree that symlink stands
  // inside of at all. Every candidate is realpath'd here instead, and
  // plan-gate.cjs no longer depends on the un-resolved form: it derives its
  // own physically-resolved root independently (repoRootFor) and tries the
  // session's typed and realpath forms itself when keying a marker, rather
  // than relying on this function to hand it one un-dereferenced.
  const start = realOrSelf(path.resolve(cwd));
  const segments = splitSegments(gitDirTokens(command));
  // The fallback candidate set also takes a whole, clean quoted literal
  // (`git -C "<dir>"`, `cd "<dir>"`), as bashWriteTargets does: adding a
  // candidate can only add a denial. The strict per-`git` grammar below still
  // trusts unquoted literals only.
  const FALLBACK_OPTS = { acceptQuotedLit: true, acceptCdFlags: true };
  if (!isSimpleCommand(command)) return [...universalFallback(segments, start, FALLBACK_OPTS)];
  let fallback = null;
  const results = [];

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    for (let i = 0; i < seg.tokens.length; i++) {
      if (seg.tokens[i] !== 'git') continue;
      const g = gitAt(seg.tokens, i);
      if (!g) continue; // `git` with nothing recognisable as a subcommand after it

      // `git` must be the first word of its own segment, that segment must
      // be the LAST segment of the whole command (nothing follows this git
      // invocation at all — see the grammar comment above for why that is
      // load-bearing, not just one more shape), and nothing between `git`
      // and the subcommand except repeated `-C LIT` — gitAt itself is more
      // tolerant (it also skips `-c`/`--git-dir`/`--work-tree`/etc, so it
      // can still find the subcommand for gitSubcommandIs elsewhere); the
      // grammar this function trusts is stricter than what gitAt merely
      // parses.
      let eligible = i === 0 && segIdx === segments.length - 1;
      const cLits = [];
      for (let j = i + 1; eligible && j < g.at;) {
        // A `..`-bearing -C literal is refused here on the fast path even
        // when it is otherwise clean (isCleanLit) — see hasDotDotSegment.
        if (seg.tokens[j] === '-C' && isCleanLit(seg.tokens[j + 1]) &&
            !hasDotDotSegment(seg.tokens[j + 1])) {
          cLits.push(seg.tokens[j + 1]);
          j += 2;
        } else {
          eligible = false;
        }
      }

      // Every segment before this one, back to the start of the command,
      // must be a bare `cd LIT`, joined to what follows it by `&&` alone.
      // Each step is verified PHYSICALLY (physicalResolve), not merely by
      // textual path.resolve plus an existence check — a `cd`/`-C` through a
      // symlink followed by a literal `..` does not cancel out the way plain
      // string-joining suggests; see physicalResolve's and hasDotDotSegment's
      // comments. The CANDIDATE pushed below is physicalResolve's own
      // dereferenced result at each step, not the textual join: a symlink hop
      // to a NESTED repo (findGatedRoot walks up from whatever it is handed,
      // and a symlink's own ancestry never reaches what it points INTO) needs
      // the real directory to be seen as gated at all, and plan-gate.cjs no
      // longer needs the un-dereferenced form here — it resolves its own
      // physical root independently and tries the session's typed path
      // itself when keying a marker.
      let base = start;
      for (let k = 0; eligible && k < segIdx; k++) {
        const s = segments[k];
        if (segments[k + 1].precededBy !== '&&' || s.tokens.length !== 2 ||
            s.tokens[0] !== 'cd' || !isCleanLit(s.tokens[1]) ||
            hasDotDotSegment(s.tokens[1])) { eligible = false; break; }
        const resolved = physicalResolve(base, s.tokens[1]);
        if (!resolved) { eligible = false; break; }
        base = resolved;
      }
      for (const lit of cLits) {
        if (!eligible) break;
        const resolved = physicalResolve(base, lit);
        if (!resolved) { eligible = false; break; }
        base = resolved;
      }

      if (eligible) { results.push(base); continue; }
      if (!fallback) fallback = universalFallback(segments, start, FALLBACK_OPTS);
      for (const d of fallback) results.push(d);
    }
  }
  return [...new Set(results)];
}

/**
 * Paths a Bash command would WRITE to. Reads (`cat`, `grep`), test runs and
 * `git status` yield nothing. Returns absolute paths, deduplicated.
 *
 * A RELATIVE target is resolved against every candidate base this command
 * could plausibly have run in, not only `cwd`: the session's own cwd exactly
 * as given (not realpath'd), so a target under it keeps the path form the
 * caller passed in, PLUS every directory `universalFallback` collects —
 * which always seeds its own output with a realpath'd copy of that same cwd
 * (`start`), `cd` or no `cd` at all, and then adds one more directory for
 * each `cd LIT` starting a segment or `-C LIT` anywhere in the command. A
 * symlinked session cwd therefore yields both the typed and the realpath'd
 * candidate — fail-safe, not a narrowing: an extra candidate can only add
 * denials, per Decisions' "`cd` widens the candidate set; it never narrows
 * it", never allow a write a single candidate would have blocked. This is
 * `gitRunDirs`' own fail-closed "any candidate blocks" rule, reused here for
 * the same reason: a `cd` inside the command can otherwise defeat a lookup
 * made only in the directory the session started in. An ABSOLUTE target is
 * unaffected — there is only one place it can name.
 *
 * Unlike `gitRunDirs`, this caller passes `acceptQuotedLit`/`acceptCdFlags`
 * to `universalFallback`: a whole, clean QUOTED literal (`quotedLitValue`) is
 * trusted as a candidate base too, whether it is a `cd`'s own argument or a
 * `-C` flag's argument, and a `cd` led by `cd --`, `cd -P` or `cd -L` is
 * trusted the same as a bare `cd LIT`. `gitRunDirs`' strict `-C`/`cd` grammar
 * above trusts neither: it accepts only the unquoted literal isCleanLit
 * allows.
 */
function bashWriteTargets(command, cwd) {
  const targets = [];
  const seen = new Set();
  const start = realOrSelf(path.resolve(cwd));
  const bases = new Set([path.resolve(cwd),
    ...universalFallback(splitSegments(gitDirTokens(command)), start,
      { acceptQuotedLit: true, acceptCdFlags: true })]);
  const add = (raw) => {
    if (!raw) return;
    const t = unquote(raw.trim());
    if (!t || t.startsWith('-') || t === '&1' || t === '&2' || t === '/dev/null') return;
    if (t.startsWith('~')) return;              // unexpanded tilde: not a real path
    const push = (abs) => {
      // A write target's directory must already exist. Without this, any
      // path-shaped token resolves under some base and appears to live
      // inside the indexed repo.
      try {
        if (!fs.existsSync(path.dirname(abs))) return;
      } catch { return; }
      if (seen.has(abs)) return;
      seen.add(abs);
      targets.push(abs);
    };
    if (path.isAbsolute(t)) { push(t); return; }
    for (const base of bases) push(path.resolve(base, t));
  };

  // Quoted strings are data, not commands: a JSON payload containing `sed -i`
  // is not a `sed -i` invocation. Each stripping order is read separately and
  // the targets merged (see executableShellViews).
  for (const shell of executableShellViews(command)) {

  // redirects:  > file   >> file
  for (const m of shell.matchAll(/(?<![0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(m[1]);

  // sed -i / perl -i: every path-shaped argument
  if (/\bsed\b[^|;]*\s-i\b/.test(shell) || /\bperl\b[^|;]*\s-i/.test(shell)) {
    for (const m of shell.matchAll(/("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) {
      const t = unquote(m[1]);
      if (isSourceFile(t)) add(m[1]);
    }
  }

  // tee [flags] file...
  for (const m of shell.matchAll(/\btee\b((?:\s+-{1,2}[\w-]+)*)((?:\s+("[^"]+"|'[^']+'|[^\s;|&<>()]+))+)/g)) {
    for (const t of m[2].trim().split(/\s+/)) add(t);
  }

  // conflict resolution and patch application write files in place
  for (const m of shell.matchAll(/\bgit\s+checkout\s+--(?:theirs|ours)\s+([^\s;|&]+)/g)) add(m[1]);
  if (/\b(?:git\s+apply|patch)\b/.test(shell)) {
    for (const m of shell.matchAll(/("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) {
      const t = unquote(m[1]);
      if (isSourceFile(t)) add(m[1]);
    }
  }
  }

  // PowerShell fallback: on Windows, Claude Code runs PowerShell instead of Bash
  // when Git Bash is absent, so a write arrives as Set-Content / Out-File /
  // Add-Content rather than a `>` redirect. Matched against a text with heredoc
  // bodies stripped, like `shell` above, but with real quotes and `#` left in
  // place: `shell`'s stripper blanks quoted content entirely, which would
  // destroy a quoted -Path value, and comments are handled below by the same
  // quote-aware scan rather than by a pre-pass, for the reason given there. A
  // match whose cmdlet name sits inside a quoted span (a commit message that
  // mentions Set-Content, a heredoc body already erased above) is prose, not
  // an invocation, and is dropped.
  const psText = stripHeredocBodies(command).replace(/\\["']/g, '');
  // One quote-aware pass over psText, replacing what used to be three separate
  // ad-hoc passes (a paired-quote regex for "is this cmdlet name quoted", and
  // an unquote-blind `.split(/[|;\n]/)` for "where does its argument list
  // end") that each had to remember, on their own, not to treat a quoted `;`,
  // `|` or newline as significant. quotedAt[i] is true when index i sits
  // inside a '...' or "..." span, inside a `#` comment, or is consumed by a
  // backtick escape — PowerShell's escape character, which also covers
  // backtick-newline line continuation outside any string.
  //
  // A `#` comment used to be stripped by a separate pre-pass that ran before
  // this scan existed and had no quote state of its own, so a `#` inside a
  // quoted -Value — `Set-Content -Value "import os  # noqa" -Path app.py` —
  // erased everything after it, -Path included, and the write went unseen.
  // Comments are handled in this same pass instead, so a `#` only starts one
  // when it is outside every quote and here-string, exactly like the shell it
  // is borrowed from: preceded by whitespace, a separator, or the start of a
  // line, not sitting mid-word (a URL fragment, say). A commented span is
  // marked quoted like any other inert text, up to but not including the
  // newline that ends it — that newline must stay a live statement
  // separator, or a comment on one line of a multi-statement command would
  // swallow the statements after it too.
  // A `@"..."@` / `@'...'@` here-string is found as a whole span up front,
  // below, rather than by the same char-by-char toggle: its body is allowed to
  // contain an UNPAIRED quote (`he said "hi` with no closing `"` is a normal
  // line inside one), and counting quotes one at a time treats that stray
  // quote as closing the string. That desyncs the toggle for everything after
  // it — including the here-string's own closing delimiter, which then
  // re-opens a quote that never closes, silently marking the rest of the
  // command (a real Set-Content call and all) as quoted prose. Here-strings
  // are lexically self-contained (the opening delimiter must be alone at
  // end-of-line, the closing delimiter alone at start-of-line), so they can be
  // located structurally and skipped as a block instead.
  const HERE_STRING = /@(["'])[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*\1@/g;
  const hereStringEnd = new Map();
  for (const m of psText.matchAll(HERE_STRING)) hereStringEnd.set(m.index, m.index + m[0].length);
  const psQuotedAt = new Array(psText.length).fill(false);
  {
    let quote = null;
    let commented = false;
    for (let i = 0; i < psText.length; i++) {
      if (commented) {
        // The comment ends at the newline, and that newline is left alone —
        // not marked quoted — so it still reads as a statement separator.
        if (psText[i] === '\n') { commented = false; continue; }
        psQuotedAt[i] = true;
        continue;
      }
      if (!quote && hereStringEnd.has(i)) {
        const end = hereStringEnd.get(i);
        for (let j = i; j < end; j++) psQuotedAt[j] = true;
        i = end - 1;
        continue;
      }
      const ch = psText[i];
      if (ch === '`' && quote !== "'") {
        psQuotedAt[i] = true;
        if (i + 1 < psText.length) psQuotedAt[++i] = true;
        continue;
      }
      if (quote) {
        psQuotedAt[i] = true;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; psQuotedAt[i] = true; continue; }
      if (ch === '#' && (i === 0 || /[\s;|&()]/.test(psText[i - 1]))) {
        commented = true;
        psQuotedAt[i] = true;
      }
    }
  }
  // The first `;`, `|` or newline from `from` that is not inside a quote and
  // not backtick-escaped: the end of this invocation's argument list. A later
  // cmdlet in the same pipeline gets its own match.
  const psStatementEnd = (from) => {
    for (let i = from; i < psText.length; i++) {
      if (!psQuotedAt[i] && (psText[i] === ';' || psText[i] === '|' || psText[i] === '\n')) return i;
    }
    return psText.length;
  };
  // Parameters that take a value, so the positional scan below can step over both
  // the switch and its value instead of mistaking the value for the path. Anything
  // not listed here (-Force, -Append, -NoNewline, ...) is a SwitchParameter and
  // takes none.
  const VALUE_SWITCHES = /^-(?:Path|FilePath|LiteralPath|Value|Encoding|Filter|Include|Exclude|Stream|Delimiter|Width|Credential|ErrorAction|ErrorVariable|WarningAction|WarningVariable|InformationAction|InformationVariable|OutVariable|OutBuffer|PipelineVariable)$/i;
  for (const m of psText.matchAll(/\b(?:Set-Content|Add-Content|Out-File)\b/gi)) {
    if (psQuotedAt[m.index]) continue;
    const restStart = m.index + m[0].length;
    const rest = psText.slice(restStart, psStatementEnd(restStart));
    // Quote-aware, like the cmdlet-name check above: `-Path` inside a quoted
    // -Value string (prose mentioning a flag, or one command's argument naming
    // another path) is text, not this invocation's path argument, and is
    // skipped in favour of the next candidate rather than taken as the match.
    const flagged = [...rest.matchAll(/-(?:Path|FilePath|LiteralPath)\s+("[^"]+"|'[^']+'|[^\s;|]+)/gi)]
      .find((m) => !psQuotedAt[restStart + m.index]);
    if (flagged) { add(flagged[1]); continue; }
    // Positional form: `Set-Content x.py -Value ...` / piped `... | Out-File x.py`,
    // possibly preceded by switches (`-Append`, `-Force`, `-Encoding utf8`, ...).
    // Walk the tokens, skipping each switch (and its value, when it takes one),
    // until the first token that looks like a path rather than a flag or a value.
    const tokens = rest.trim() ? rest.trim().match(/"[^"]+"|'[^']+'|\S+/g) || [] : [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) { if (VALUE_SWITCHES.test(t)) i++; continue; }
      const bare = unquote(t);
      if (/[\\/]/.test(bare) || /\.[A-Za-z0-9]+$/.test(bare)) { add(t); break; }
    }
  }

  // python/node writing a file from inside a heredoc or -c string
  for (const m of command.matchAll(/(?:open|Path)\s*\(\s*(['"])([^'"]+)\1\s*(?:\)\s*)?,\s*(['"])[wa]\+?\3/g)) add(m[2]);
  for (const m of command.matchAll(/(['"])([^'"]+)\1\s*\)?\s*\.\s*write_text\s*\(/g)) add(m[2]);
  for (const m of command.matchAll(/\bwriteFileSync\s*\(\s*(['"])([^'"]+)\1/g)) add(m[2]);

  return targets;
}

// ## Known defects — accepted
//
// Holes in bashWriteTargets' write-detection that are known and deliberately
// left open, rather than fixed only on the PowerShell side while the POSIX
// detectors above ship with the same gap — that asymmetry would create a
// false impression of coverage without closing anything real.
//
//  - `pwsh -c "..."` / `bash -c "echo x > app.py"` — a write issued through an
//    interpreter's `-c` string is invisible to both the PowerShell cmdlet
//    scan and the POSIX redirect scan; neither looks inside a string handed
//    to another shell.
//  - Variable indirection — `$f = "app.py"; Set-Content $f` and
//    `f=app.py; echo x > $f` — both detectors match literal path-shaped
//    tokens, not the value a variable holds, on either side.
//  - Unquoted prose false positives — `echo use Out-File for app.py` denies,
//    and so does the POSIX `echo use sed -i on app.py`: prose that merely
//    names a cmdlet or flag next to a path reads as an invocation on both
//    sides. (executableShell's quote-stripping only protects *quoted*
//    prose.)
//  - The POSIX side has no notion of a `#` comment at all: `executableShell`
//    only strips heredoc bodies and quoted strings, so `# echo x > app.py` —
//    a line that runs nothing — still matches the redirect scan and denies.
//    That is a fail-closed nuisance, not a fail-open. The PowerShell side
//    handles `#` inside its quote-aware scan above, so a quoted `#` there is
//    never mistaken for a comment.
//  - A non-literal `cd` (`cd "$X"`, `cd $(pwd)/x`), a subshell's own `cd`
//    (`( cd U ) && ...`), `pushd`, and PowerShell's `Set-Location` / `sl` /
//    `Push-Location` are none of them candidate bases: `universalFallback`
//    only widens the set for a `cd`/`-C` argument `isCleanLit` can trust as
//    a literal, or (bashWriteTargets only) a whole, clean quoted one
//    (quotedLitValue). `env -C DIR` is NOT one of these gaps, despite
//    looking like it should be: its `-C` is the very flag this function
//    already collects wherever it sits in the command, git's or not.
//  - A SECOND relative `cd` chained after the first (`cd A && cd B && ...`)
//    resolves against the SESSION'S cwd, not against A: `universalFallback`
//    treats each `cd LIT` starting its own segment as its own independent
//    candidate rather than composing them in sequence, so `cd A && cd B`
//    adds `<session cwd>/B` as a candidate, never `<session cwd>/A/B`.
//    The session's cwd, and every other literal directory the command
//    names, stay candidates regardless — this is the same residual gap
//    `gitRunDirs` accepts for the commit gate.

/**
 * A plan's "## Known defects — accepted" section: where a blocking audit finding
 * is recorded rather than fixed. Everything from that heading to the next `## `
 * heading belongs to it.
 *
 * It is matched case-insensitively and the dash is not policed, because the
 * alternative is a gate that denies a commit over an em-dash.
 */
const ACCEPTED_HEADING = /^##\s+Known defects\b.*$/im;

function acceptedSection(text) {
  const m = ACCEPTED_HEADING.exec(text || '');
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return { start: m.index, body: next ? rest.slice(0, next.index) : rest,
           after: next ? rest.slice(next.index) : '' };
}

/**
 * The plan MINUS its acknowledgement section — what an audit actually covers.
 *
 * Recording a defect the audit itself reported is an edit, and an edit
 * invalidates an audit. Hashing the body instead of the whole file is what lets
 * the acceptance path be walked at all: writing down D1 does not re-lock the
 * plan, while changing anything else still does. The cost is that the section is
 * unaudited text, which is the right trade only because nothing in it is a claim
 * about the code — it is a list of ids the auditor itself produced.
 */
function planBody(text) {
  const sec = acceptedSection(text);
  if (!sec) return text;
  return text.slice(0, sec.start) + sec.after;
}

/**
 * Blank lines are normalised before hashing. Removing a section at the end of a
 * file leaves the blank line that separated it, so the very act of adding an
 * acknowledgement changed the hash of the text that was supposed to be
 * unaffected by it. Whitespace is not a claim about the code; nothing this gate
 * protects can hide in it.
 */
function planBodyHash(abs) {
  try {
    const body = planBody(fs.readFileSync(abs, 'utf8'))
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return crypto.createHash('sha256').update(body).digest('hex');
  } catch { return null; }
}

/**
 * The defect ids written down in that section, e.g. ['D1', 'D4'].
 *
 * An entry must name the audit it answers — `- D1 (audit <at>): …` — and `at` must
 * be the timestamp on the marker being cleared. Without that binding the section
 * accumulated bare ids while every audit renumbers from D1, so an entry written for
 * one round's D1 silently pre-accepted the NEXT round's D1 and the plan committed
 * carrying a blocking defect nobody had read. Measured on a real plan: this function
 * returned ['D1','D6'] from entries written two rounds earlier, and one of them
 * matched a live blocking finding.
 *
 * Called with no `auditAt` it returns every id regardless of stamp, which is what a
 * reader wants when listing what a plan carries; only the gate passes the timestamp.
 */
function acceptedIds(text, auditAt = null) {
  const sec = acceptedSection(text);
  if (!sec) return [];
  if (!auditAt) {
    return [...new Set([...sec.body.matchAll(/\bD\d+\b/g)].map((m) => m[0]))];
  }
  // The id and its stamp must be in the same entry, so one stamped entry cannot
  // vouch for a bare id sitting beside it.
  const ids = [];
  for (const line of sec.body.split(/\n(?=\s*[-*]\s)/)) {
    if (!line.includes(auditAt)) continue;
    for (const m of line.matchAll(/\bD\d+\b/g)) ids.push(m[0]);
  }
  return [...new Set(ids)];
}

/**
 * A subagent's report, out of its own transcript.
 *
 * Since Claude Code 2.1.278 an agent hands its report back through
 * SubagentHandback, so the Agent tool result is a delivery receipt and the
 * report text is only here. Measured: three synchronous plan-auditor dispatches,
 * every tool result a receipt, zero verdicts recorded.
 *
 * Prefer the last handback message. The agent typically says something brief
 * after handing back ("Report delivered."), so the last assistant TEXT is the
 * chatter, not the report; text blocks are the fallback for an agent that
 * answered inline without handing back.
 */
function reportFromTranscript(transcriptPath) {
  let handed = '', spoken = '';
  for (const rec of transcriptRecords(transcriptPath)) {
    const msg = rec?.message;
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && b?.name === 'SubagentHandback') {
        if (typeof b?.input?.message === 'string' && b.input.message.trim()) handed = b.input.message;
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        spoken = b.text;
      }
    }
  }
  return handed || spoken;
}

/**
 * The prompt the subagent was dispatched with — its first user message. On
 * SubagentStop there is no tool_input to read it from, and it is what says which
 * brief a review was about.
 */
function promptFromTranscript(transcriptPath) {
  for (const rec of transcriptRecords(transcriptPath)) {
    const msg = rec?.message;
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .map((b) => (typeof b === 'string' ? b : (b?.type === 'text' ? b.text : '')))
        .filter(Boolean).join('\n');
      if (text.trim()) return text;
    }
  }
  return '';
}

function* transcriptRecords(transcriptPath) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* a partial line is not a record */ }
  }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function readStdin(cb) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
    cb(input);
  });
}

module.exports = {
  SOURCE_EXT, CONFIG_DIR, STATE_DIR, markerPath, gatesDisabled, findGatedRoot,
  isSourceFile, bashWriteTargets, executableShell, executableShellViews, deny, readStdin, shipPhase,
  planBody, planBodyHash, acceptedIds, reportFromTranscript, promptFromTranscript,
  SEPARATOR, tokenize, VALUE_FLAGS, gitAt, gitSubcommandIs, gitRunDirs,
};
