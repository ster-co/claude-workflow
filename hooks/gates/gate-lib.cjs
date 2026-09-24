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
    if (parent === dir) return null;
    dir = parent;
  }
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
 * `/plan`'s "do it now" triage is the reason this must default open: it
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
function executableShell(command) {
  return stripHeredocBodies(command)
    // Backslash-escaped quotes are literal characters, not delimiters. Leaving them
    // in mis-pairs the strippers below and exposes the inside of a JSON payload as
    // if it were shell — which is how this gate blocked a command that only *named*
    // `git commit` inside a quoted argument.
    .replace(/\\["']/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

/**
 * Paths a Bash command would WRITE to. Reads (`cat`, `grep`), test runs and
 * `git status` yield nothing. Returns absolute paths.
 */
function bashWriteTargets(command, cwd) {
  const targets = [];
  const add = (raw) => {
    if (!raw) return;
    const t = unquote(raw.trim());
    if (!t || t.startsWith('-') || t === '&1' || t === '&2' || t === '/dev/null') return;
    if (t.startsWith('~')) return;              // unexpanded tilde: not a real path
    const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t);
    // A write target's directory must already exist. Without this, any path-shaped
    // token resolves under cwd and appears to live inside the indexed repo.
    try {
      if (!fs.existsSync(path.dirname(abs))) return;
    } catch { return; }
    targets.push(abs);
  };

  // Quoted strings are data, not commands: a JSON payload containing `sed -i`
  // is not a `sed -i` invocation.
  const shell = executableShell(command);

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
//    That is a fail-closed nuisance, not a fail-open: the reverse of the
//    PowerShell defect this section used to carry for the same character,
//    which was fixed by making comment-handling part of the quote-aware scan
//    above instead of a pre-pass blind to quoting.

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
  isSourceFile, bashWriteTargets, executableShell, deny, readStdin, shipPhase,
  planBody, planBodyHash, acceptedIds, reportFromTranscript, promptFromTranscript,
};
