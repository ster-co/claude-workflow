#!/usr/bin/env node
// PreToolUse on Bash: denies process-kill commands by what they would hit, not by
// how their text reads (docs/plans/2026-09-30-kill-gate-dryrun.md).
//
// Why it exists. On 2026-09-29 `pkill -f "cat" -U $(id -u) -x` was run to stop
// one stray `cat`. BSD pkill stops option parsing at the first operand, so `-U`,
// the uid and `-x` became extra patterns, and `-f "cat"` matched every command
// line containing "cat" -- every /Applications/... and "Application Support"
// path. Every app on the Mac quit. Text rules cannot tell a pattern that names one
// process from one that names a session's worth, so the gate asks the process table.
//
// A dry run. `pgrep` and `pkill` share one matcher, so the gate rewrites each
// `pkill`/`killall`/`kill` in command position into the equivalent read-only query
// (kill-probe.cjs: pgrep, ps or lsof, allowlisted, no shell) and judges the set:
//   match       a protected process is in it (Claude Code, the hook's own ancestor
//               chain, launchd, the login session, anything under /System or
//               /Applications: isProtected in kill-probe.cjs); or a killall NAME / pkill
//               -x pattern is itself the name of one (loginwindow, Finder...), decided from
//               the text because killall's uid-limited query would not list it;
//   count       more than MAX_MATCHES processes;
//   group       `kill` at process group 0 (`0`, `00`...), -1 or any target starting with
//               `-` (`-<n>`, `-$PGID`): decided from the text, no query;
//   unresolved  an argument the gate cannot reproduce (a substitution, or a `$`
//               other than $USER/$HOME from the environment and $UID, or `~user`), an
//               unknown killall option, or a target producer it cannot evaluate (a
//               `pgrep` with -l, -d or -q prints more than pids, or one the gate
//               would run somewhere else than the shell does: see below);
//   probe       the dry run failed, timed out or printed something unparseable, or
//               the ancestor chain could not be read;
//   parse       a command containing a kill-family word that the shell-word lexer
//               cannot read (an unterminated quote or heredoc), or that nests
//               parentheses deeper than MAX_NESTING (the lexer's cost grows with the
//               square of the depth, so it is not run): the gate cannot tell what runs,
//               so it fails closed.
// `kill -0` (signal 0) signals nothing and is allowed whatever its target.
//
// Command position. A kill word is read where the shell would run it: after VAR=val words
// and the wrappers sudo, doas, env, timeout, nohup, exec, command, time, builtin, nice,
// caffeinate and xargs; in the body of `sh|bash|zsh -c`, `eval` and `trap`; and in each
// `find -exec|-execdir|-ok|-okdir` clause. Where find (or xargs) supplies the kill's targets
// or patterns, the gate cannot see them and the command is unresolved.
//
// `kill` with literal pids is looked up with ps. A `$(...)`/backtick target, or an
// `xargs kill` fed by the previous pipeline stage, is resolved by running that
// producer (the command whose output the kill reads) read-only in the hook. That is
// sound only when the hook's run is the shell's run, so a producer is evaluated only
// when ALL of these hold, and is unresolved otherwise (fail closed, the way an
// argument the gate cannot reproduce is):
//   whole source  the kill word is exactly one substitution whose body is one simple
//                 command; or, for xargs, the producer is the immediate `|` predecessor,
//                 not the last command of a group (`(a; b) | xargs kill` reads both),
//                 and xargs has no stdin redirect that replaces the pipe;
//   unelevated    no sudo/doas in the producer's own wrapper chain, and it is not inside
//                 a body a sudo/doas hands to a shell (elevation of the kill alone is
//                 fine: the producer's output is the same);
//   as written    the producer is not itself run by xargs, and every argument is literal;
//   paths         every path argument (`cat FILE`, `-F FILE`, an lsof file) is absolute
//                 or `~/`, or relative with no cd/pushd/popd earlier in the command or
//                 any enclosing body, and then resolved against the hook input's cwd
//                 (the probe itself runs in the hook's own directory);
//   known form    `pgrep` without -l/-d/-q, `lsof -t`, or `cat` of one file.
// `kill $VAR` is allowed: the gate cannot see shell variables (a documented gap).
//
// The gate never signals a process and cannot: its only process executions are the
// injected probe and one async spawn of its own decider (process.execPath on this file),
// and it names no other way to start or signal one. That is a property of this source,
// checked by a grep and a vm sandbox in test-kill-gate.cjs (accidental regressions only; a
// sandbox is not a proof).
//
// Wall time. The hook decides in a child process and gives up on it at BUDGET_MS after the
// hook started, denying with rule `probe`: a hook that outlives its timeout does not
// block the tool call, and under load one probe call has taken 25.8 s. The abandoned
// child ends by itself. See runHook.
//
// Every rule reads the words shellWords() (gate-lib.cjs) produces -- quotes,
// escapes, comments, redirections, heredocs and command substitutions already
// resolved -- and no other parser. `-c` and `eval` bodies are lexed again. Quoting
// is not recorded, so a quoted regex anchor such as `pkill -f 'server.js$'` reads
// as a variable and denies (unresolved): an accepted false deny.
//
// Deliberately not governed by SKIP_CODE_GATES: that switch relaxes review gates,
// and this one is a safety gate. There is no bypass variable. The rules encode BSD
// pkill/killall semantics, so on any platform other than darwin the gate allows
// everything; the platform is a parameter of decide() rather than an environment
// variable so that branch is testable without a switch that could also disable it.
//
// Scope: command text only. Kill code inside scripts, kills hidden behind a
// variable or a sourced file, and PowerShell's Stop-Process are not covered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellWords, readStdin } = require('./gate-lib.cjs');
const childProcess = require('child_process');
const killProbe = require('./kill-probe.cjs');

const MAX_DEPTH = 4;
// The lexer re-reads the body of every `$(` inside the one around it, so its cost grows
// with the square of the nesting depth (a 400,000-deep command ran for minutes, and a
// few thousand levels overflow its stack). Real commands nest a handful of levels.
const MAX_NESTING = 32;
// Chosen so a dev server with its workers or a test-runner pool passes and `node`
// (128 processes on 2026-09-30) or `-x '.*'` does not. Not tuned from data.
const MAX_MATCHES = 10;
const MAX_LISTED = 5;
const MAX_ECHOED = 200;
const MAX_PIDFILE_BYTES = 64 * 1024;

const PGREP = '/usr/bin/pgrep';
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const PS_FORMAT = 'pid=,ppid=,command=';

// `-9`, `-TERM`, `-SIGUSR1`: a signal word, by number or by a name this platform
// knows. Letter options stay options, including ones that end in digits (`-U501`).
const SIGNAL_NAMES = new Set(Object.keys(os.constants.signals).map((name) => name.slice(3)));
const isSignal = (word) => /^-\d+$/.test(word) ||
  (word.startsWith('-') && SIGNAL_NAMES.has(word.slice(1).replace(/^SIG/, '')));
// A command the lexer cannot read is denied only when it mentions a kill-family
// word: the gate then cannot tell whether that word runs.
const KILL_WORD = /\b(?:pkill|killall|kill)\b/;
// A number the shell reads as 0, in any number of digits (`0`, `00`).
const ZEROS = /^0+$/;

const LABEL = {
  match: 'protected process',
  count: 'too many matches',
  group: 'process group',
  unresolved: 'argument the gate cannot resolve',
  probe: 'dry run failed',
  parse: 'unparseable command',
  crash: 'the gate crashed',
};

// The allowed rewrite each rule ends on, so the caller knows what to run instead.
const NARROWER = 'Use a narrower `pgrep -lf <pattern>` (a port or a path) to find the pid, ' +
  '`pkill -F <pidfile>` for a process you started, or `kill <pid>` with a literal pid.';
const REWRITE = {
  match: NARROWER,
  count: NARROWER,
  group: 'Signal literal pids instead: find them with `pgrep -lf <pattern>`, then run `kill <pid>` for each.',
  unresolved: 'Resolve it to literal pids first: run `pgrep -lf <pattern>`, then `kill <pid>`.',
  probe: 'The dry run failed, not necessarily the command: retry, or use literal pids ' +
    '(`pgrep -lf <pattern>`, then `kill <pid>`).',
  parse: 'The command may be valid shell that the gate cannot read, so rewrite it more simply ' +
    '(one command per call, no deeply nested substitutions), or use literal pids.',
  crash: 'The command may be valid shell that made the gate fail, so rewrite it more simply ' +
    '(one command per call, no deeply nested substitutions), or use literal pids.',
};
// The whole reason, rewrite included, stays under this: the hook prints it in one JSON
// document and the pipe it goes through holds 64 KB.
const MAX_REASON = 4096;

const clip = (text) => (text.length > MAX_ECHOED ? `${text.slice(0, MAX_ECHOED)}...` : text);

// `hits` are the { pid, command } rows the command would have reached; the first
// MAX_LISTED are shown so the caller sees what it was about to signal.
function verdict(rule, detail, hits = []) {
  const shown = hits.slice(0, MAX_LISTED).map((row) => `  ${row.pid} ${clip(String(row.command))}`);
  const listing = shown.length
    ? `\nIt would have hit${hits.length > shown.length ? ` (${shown.length} of ${hits.length} shown)` : ''}:\n${shown.join('\n')}\n`
    : ' ';
  // The rewrite is the part the caller must see, so the head is what gets cut.
  const head = `kill-gate rule ${rule} (${LABEL[rule]}): ${detail}.${listing}`;
  const room = Math.max(0, MAX_REASON - REWRITE[rule].length);
  return { rule, reason: (head.length > room ? `${head.slice(0, room - 4)}... ` : head) + REWRITE[rule] };
}

// Everything below reads the commands of shellWords(): each `words` entry is
// `{ value, subst }` with quotes, escapes and line continuations already resolved,
// and redirections (`2>/dev/null`, `>| f`, heredocs) are kept apart in `redirs`, so
// a word after a redirect is still an argument and a redirect target never is.

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Wrapper options that take a separate value word.
const WRAPPER_VALUE_FLAGS = {
  nice: new Set(['-n']),
  caffeinate: new Set(['-t', '-w']),
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '-J', '-R', '-S']),
};

// Where the command word of a command sits once VAR=val words and wrappers are
// skipped. Returns { name, at, xargs, elevated } (`at` indexes `words`; `elevated` is
// true when sudo or doas is among the wrappers), or null.
const ELEVATORS = new Set(['sudo', 'doas']);
function commandAt(words) {
  let j = 0;
  let xargs = false;
  let elevated = false;
  for (;;) {
    while (j < words.length && ASSIGNMENT.test(words[j].value)) j++;
    if (j >= words.length) return null;
    const name = path.posix.basename(words[j].value);
    if (!(name in WRAPPER_VALUE_FLAGS) && !['nohup', 'exec', 'command', 'time', 'builtin'].includes(name)) {
      return { name, at: j, xargs, elevated };
    }
    if (name === 'xargs') xargs = true;
    if (ELEVATORS.has(name)) elevated = true;
    const valued = WRAPPER_VALUE_FLAGS[name] || new Set();
    j++;
    while (j < words.length && words[j].value.startsWith('-') && words[j].value !== '-') {
      // `command -v pkill` only prints where pkill lives.
      if (name === 'command' && /^-[vV]/.test(words[j].value)) return null;
      if (words[j].value === '--') { j++; break; }
      j += valued.has(words[j].value) ? 2 : 1;
    }
    if (name === 'timeout' && j < words.length && /^\d/.test(words[j].value)) j++;
  }
}

// The words a dry run can reproduce. A word is literal unless it holds a command
// substitution or a `$` other than $USER / $HOME (from the hook's environment) and
// $UID (the real uid). A word that starts with `~` or `~/` is the shell's tilde
// expansion, so it is read as $HOME from the hook's environment; `~user`, `~+` and
// the like cannot be reproduced. The lexer does not record quoting, so a quoted `~`
// is expanded too: an accepted over-match that can only deny more. Returns the word's
// value, or null.
function literalValue(word) {
  if (word.subst) return null;
  let text = word.value;
  if (text.startsWith('~')) {
    if (text !== '~' && !text.startsWith('~/')) return null;
    if (!process.env.HOME) return null;
    text = process.env.HOME + text.slice(1);
  }
  if (!text.includes('$')) return text;
  const known = {
    USER: process.env.USER,
    HOME: process.env.HOME,
    UID: typeof process.getuid === 'function' ? String(process.getuid()) : undefined,
  };
  const value = text.replace(/\$(?:\{(USER|HOME|UID)\}|(USER|HOME|UID)\b)/g,
    (whole, braced, bare) => known[braced || bare] ?? whole);
  return value.includes('$') ? null : value;
}

// `{ values }` when every word is literal, else `{ bad }` (the first that is not).
function literalWords(words) {
  const values = [];
  for (const word of words) {
    const value = literalValue(word);
    if (value === null) return { bad: word };
    values.push(value);
  }
  return { values };
}

function unresolvedWord(cmd, word) {
  return verdict('unresolved', `\`${cmd}\` has an argument the gate cannot reproduce (\`${clip(word.value)}\` ` +
    'holds a command substitution or a variable), so it cannot tell what the command would match; write the ' +
    'value out, or find the pid with `pgrep -lf` first');
}

// pgrep options that take a value, and the options of pkill that only change what a
// dry run prints or asks: -l (long output), -q (no output), -I (confirmation) and
// -d DELIM (delimiter). They are removed; every other word stays in its original
// order, so a flag placed after the pattern stays a pattern, as it is for pkill
// (`pgrep` and `pkill` are one binary). `-F`, `-G`, `-P`, `-U`, `-g`, `-t`, `-u`
// take a value; so does -d.
const PGREP_VALUED = new Set(['F', 'G', 'P', 'U', 'd', 'g', 't', 'u']);
const PGREP_DROPPED = new Set(['l', 'q', 'I']);

// `values` are the literal words of the command; `leadingSignal` strips a first
// `-<signal>` word (pkill takes one only there; pgrep has none). Option words are
// rewritten only up to the first operand or `--`. `resolve` maps the value of -F (a
// pid file) to an absolute path: `{ path }`, or `{ why }` when it cannot. Returns
// `{ args, exact, patterns }` or `{ why }`: `exact` says -x was among the options and
// `patterns` are the operands, which -x then matches against whole process names.
function pgrepArgs(values, leadingSignal, resolve) {
  const out = [];
  let exact = false;
  let i = leadingSignal && values.length && isSignal(values[0]) ? 1 : 0;
  for (; i < values.length; i++) {
    const v = values[i];
    if (v === '--' || v.length < 2 || v[0] !== '-') break;
    let letters = '';
    for (let k = 1; k < v.length; k++) {
      const ch = v[k];
      if (PGREP_DROPPED.has(ch)) continue;
      if (!PGREP_VALUED.has(ch)) {
        if (ch === 'x') exact = true;
        letters += ch;
        continue;
      }
      // A valued letter takes the rest of its word, or the next word, and ends the group.
      const rest = v.slice(k + 1);
      const value = rest || (i + 1 < values.length ? values[++i] : null);
      if (ch === 'd') {
        if (letters) out.push(`-${letters}`);
      } else {
        out.push(`-${letters}${ch}`);
        if (value !== null && ch === 'F') {
          const file = resolve(value);
          if (file.why) return { why: file.why };
          out.push(file.path);
        } else if (value !== null) out.push(value);
      }
      letters = '';
      break;
    }
    if (letters) out.push(`-${letters}`);
  }
  const operands = values.slice(i);
  out.push(...operands);
  return { args: out, exact, patterns: operands[0] === '--' ? operands.slice(1) : operands };
}

// The arguments of an lsof producer with every path in them made absolute by `resolve`
// (as for pgrepArgs): file operands, and the values of the options that name a file
// (-A, -k, -m, +d, +D). An option that takes a value takes the rest of its word, or the
// next word: always for the required ones, and for the optional ones (-i, -g, -o, -r,
// -s, -S, -T, -f, -F) unless the next word is an option or holds a `/`, which makes it
// a file. -D takes a function letter and is not read as a file. Returns `{ args }` or
// `{ why }`.
const LSOF_VALUED = {
  '-': { required: new Set('cdDekmpuA'), optional: new Set('igorsSTfF') },
  '+': { required: new Set('Dd'), optional: new Set('rmf') },
};
const LSOF_PATH_OPTIONS = { '-': new Set('Akm'), '+': new Set('Dd') };
function lsofArgs(values, resolve) {
  const out = [];
  let failed = null;
  const pathOf = (value) => {
    const file = resolve(value);
    if (file.why) failed = file.why;
    return file.path;
  };
  let options = true;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (options && v === '--') { out.push(v); options = false; continue; }
    if (!options || v.length < 2 || (v[0] !== '-' && v[0] !== '+')) { out.push(pathOf(v)); continue; }
    const kind = LSOF_VALUED[v[0]];
    let done = false;
    for (let k = 1; k < v.length && !done; k++) {
      const required = kind.required.has(v[k]);
      if (!required && !kind.optional.has(v[k])) continue;
      const isPath = LSOF_PATH_OPTIONS[v[0]].has(v[k]);
      const rest = v.slice(k + 1);
      if (rest) {
        out.push(isPath ? v.slice(0, k + 1) + pathOf(rest) : v);
      } else {
        out.push(v);
        const next = values[i + 1];
        if (next !== undefined && (required || (!/^[-+]/.test(next) && !next.includes('/')))) {
          i++;
          out.push(isPath ? pathOf(next) : next);
        }
      }
      done = true;
    }
    if (!done) out.push(v);
  }
  return failed ? { why: failed } : { args: out };
}

// Whether a pgrep changes what it prints from one pid per line: -l (name and arguments
// after the pid), -d (delimiter) or -q (nothing). Read like pgrepArgs reads them, up to
// the first operand or `--`. `kill $(pgrep -lf x)` would receive every word of that
// output as a target, and the gate checks only the pids.
function pgrepPrintsMore(values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === '--' || v.length < 2 || v[0] !== '-') return false;
    for (let k = 1; k < v.length; k++) {
      const ch = v[k];
      if ('ldq'.includes(ch)) return true;
      if (PGREP_VALUED.has(ch)) {
        if (k + 1 === v.length) i++;
        break;
      }
    }
  }
  return false;
}

const escapeEre = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// killall (man killall): a NAME is literal unless -m, and matching is limited to the
// caller's real uid (the effective uid with -e) unless -u or the caller is the super-user
// (`elevated`: sudo or doas), which "is allowed to kill any process". Returns
// { queries: [pgrep args...], names, regex }
// (empty when the call selects nothing or signals nothing), or { unknown } for an
// option the gate cannot turn into a query. -m is a bare flag that makes every NAME a
// pattern.
//
// Every query carries -a. pgrep and pkill leave the calling process and all of its
// ancestors out of their match set unless -a is given; killall does not, so
// `killall claude` from a session's shell signals the session, and a query without -a
// would never list it.
function killallQueries(values, elevated) {
  const mode = { m: false, e: false, user: null, tty: null };
  const names = [];
  let quiet = false;
  let i = 0;
  for (; i < values.length; i++) {
    const v = values[i];
    if (v === '--') { i++; break; }
    if (v.length < 2 || v[0] !== '-') break;
    if (isSignal(v)) continue;
    for (let k = 1; k < v.length; k++) {
      const ch = v[k];
      if ('vqz'.includes(ch)) continue;
      if (ch === 'm') mode.m = true;
      else if (ch === 'e') mode.e = true;
      // -l lists signal names; -s and -d describe what would be done without signalling.
      else if ('lsd'.includes(ch)) quiet = true;
      else if ('utc'.includes(ch)) {
        const rest = v.slice(k + 1);
        const value = rest || (i + 1 < values.length ? values[++i] : null);
        if (value === null) return { unknown: v };
        if (ch === 'u') mode.user = value;
        else if (ch === 't') mode.tty = value;
        else names.push(value);
        break;
      } else return { unknown: v };
    }
  }
  names.push(...values.slice(i));
  if (quiet) return { queries: [], names: [] };
  const { m, e, user, tty } = mode;
  if (!names.length && !user && !tty) return { queries: [], names: [] };
  const ttyFlags = tty ? ['-t', tty] : [];
  if (!names.length) return { queries: [['-a', ...(user ? [e ? '-u' : '-U', user, ...ttyFlags] : ['-t', tty])]], names: [] };
  let uidFlags = [];
  if (user) uidFlags = [e ? '-u' : '-U', user];
  // With -e the caller's own uid is matched as the effective uid too, not only a -u value.
  else if (!elevated) uidFlags = [e ? '-u' : '-U', String(process.getuid())];
  return {
    queries: names.map((name) => [
      '-a', ...(m ? [] : ['-x']), ...uidFlags, ...ttyFlags,
      ...(name.startsWith('-') ? ['--'] : []),
      m ? name : escapeEre(name),
    ]),
    names,
    regex: m,
  };
}

// A NAME (killall) or an -x pattern (pkill) that is itself the name of a protected
// session process, or, when `regex` (killall -m), a NAME that as a regular expression
// matches one. Judged from the text, before any query: killall's query is limited to the
// caller's uid, loginwindow and its kind run under another, so the query would find
// nothing and let the name through. Returns the verdict, or null.
function protectedNameVerdict(cmd, names, regex = false) {
  let hit;
  for (const name of names) {
    hit = regex ? killProbe.protectedNameMatching(name) : (killProbe.isProtectedName(name) ? name : null);
    if (hit) break;
  }
  if (!hit) return null;
  return verdict('match', `\`${cmd}\` ${regex ? 'selects' : 'names'} \`${clip(hit)}\`, a protected session process (the login ` +
    'session, the window server or the desktop), which no pattern kill may target');
}

// What the dry run needs from outside: the probe and the hook's ancestor chain. The
// chain is read only once a query returned something, so an ordinary command, or a
// kill of nothing, costs no process at all.
function makeContext(deps) {
  let ancestors;
  const need = (name) => {
    if (deps[name] === undefined) throw new TypeError(`decide: a dry run needs deps.${name}`);
  };
  return {
    probe(bin, args) {
      need('probe');
      let r;
      try { r = deps.probe(bin, [...args]); } catch (e) { return { error: `the probe threw: ${e.message}` }; }
      if (!r || typeof r !== 'object') return { error: 'the probe returned nothing' };
      if (r.error) return { error: String(r.error) };
      if (!Array.isArray(r.pids)) return { error: 'the probe returned no process list' };
      return { pids: r.pids };
    },
    // The directory relative paths in the command resolve against: the hook input's cwd.
    cwd: () => (typeof deps.cwd === 'string' && deps.cwd ? deps.cwd : process.cwd()),
    ancestors() {
      if (ancestors === undefined) {
        need('ancestors');
        try { ancestors = typeof deps.ancestors === 'function' ? deps.ancestors() : deps.ancestors; }
        catch (e) { ancestors = { error: `the ancestor lookup threw: ${e.message}` }; }
      }
      return ancestors;
    },
  };
}

// Runs one read-only query. `{ rows }` or `{ deny }`.
function dryRun(ctx, bin, args) {
  const r = ctx.probe(bin, args);
  if (r.error) {
    return { deny: verdict('probe', `the dry run \`${path.posix.basename(bin)} ${clip(args.join(' '))}\` failed (${clip(r.error)}), ` +
      'so the gate cannot tell what the command would hit') };
  }
  return { rows: r.pids };
}

// `{ rows }` of the processes with these pids, looked up with ps; `{ deny }` on failure.
function lookupPids(ctx, pids) {
  return dryRun(ctx, PS, ['-o', PS_FORMAT, '-p', pids.join(',')]);
}

// A file the command names, as an absolute path: `{ path }`, or `{ why }`. An absolute
// path (a `~/` was already expanded) is as written. A relative one depends on the
// directory the shell is in, which a cd, pushd or popd earlier in the command changes
// by an amount the gate does not track; without one it is the hook input's cwd.
// `src.cdSeen` says whether such a command came earlier.
function resolvePath(ctx, file, src) {
  if (path.isAbsolute(file)) return { path: file };
  if (src.cdSeen) {
    return { why: `the relative path \`${clip(file)}\` follows a cd, pushd or popd, so the gate cannot tell which file it names` };
  }
  return { path: path.resolve(ctx.cwd(), file) };
}

const unresolvedPath = (cmd, why) => verdict('unresolved', `\`${cmd}\`: ${why}; use an absolute path`);

// Judges a match set: a protected process denies, then so does a set larger than
// MAX_MATCHES. Protected rows lead the listing.
function judge(ctx, rows, what) {
  const unique = [...new Map(rows.map((row) => [row.pid, row])).values()];
  if (!unique.length) return null;
  const ancestors = ctx.ancestors();
  if (!Array.isArray(ancestors)) {
    return verdict('probe', `the hook's own ancestor chain could not be read (${clip(String(ancestors && ancestors.error))}), ` +
      `so the gate cannot tell whether ${what} would hit the calling session`, unique);
  }
  const tagged = unique.map((row) => ({ row, why: killProbe.isProtected(row, ancestors) }));
  const guarded = tagged.filter((t) => t.why);
  if (guarded.length) {
    const ordered = [...guarded, ...tagged.filter((t) => !t.why)].map((t) => t.row);
    return verdict('match', `${what} would hit a protected process: ${guarded[0].why}`, ordered);
  }
  if (unique.length > MAX_MATCHES) {
    return verdict('count', `${what} would hit ${unique.length} processes (the limit is ${MAX_MATCHES})`, unique);
  }
  return null;
}

function checkPkill(ctx, args, src) {
  const lit = literalWords(args);
  if (lit.bad) return unresolvedWord('pkill', lit.bad);
  const parsed = pgrepArgs(lit.values, true, (file) => resolvePath(ctx, file, src));
  if (parsed.why) return unresolvedPath('pkill', parsed.why);
  const named = parsed.exact ? protectedNameVerdict('pkill -x', parsed.patterns) : null;
  if (named) return named;
  const r = dryRun(ctx, PGREP, parsed.args);
  return r.deny || judge(ctx, r.rows, '`pkill` with these arguments');
}

function checkKillall(ctx, args, elevated) {
  const lit = literalWords(args);
  if (lit.bad) return unresolvedWord('killall', lit.bad);
  const parsed = killallQueries(lit.values, elevated);
  if (parsed.unknown) {
    return verdict('unresolved', `\`killall\` option \`${clip(parsed.unknown)}\` is not one the gate can turn into a ` +
      'query (it handles -SIGNAL, -v, -q, -z, -e, -m, -u, -t, -c, and -l/-s/-d, which signal nothing)');
  }
  const named = protectedNameVerdict('killall', parsed.names, parsed.regex);
  if (named) return named;
  const rows = [];
  for (const query of parsed.queries) {
    const r = dryRun(ctx, PGREP, query);
    if (r.deny) return r.deny;
    rows.push(...r.rows);
  }
  return judge(ctx, rows, '`killall` with these arguments');
}

// Rows of the pids a producer command would print: `pgrep ...`, `lsof -t ...` or
// `cat FILE` (read with fs, capped at MAX_PIDFILE_BYTES), run only when the hook's run
// is the shell's run (see the header). `src` is where the producer runs: `{ elevated,
// cdSeen }`. `{ rows }` or `{ deny }`.
function producerRows(ctx, cmd, src) {
  const c = commandAt(cmd.words);
  const unknown = (why) => ({ deny: verdict('unresolved', `the command feeding \`kill\` ${why}, so the gate cannot tell which ` +
    'processes it would signal; use a literal pid, or `pgrep`, `lsof -t` or `cat <pidfile>` directly') });
  if (!c) return unknown('is empty');
  if (src.elevated || c.elevated) {
    return unknown('runs as the super-user (sudo or doas), and the gate would run it as the calling user');
  }
  if (c.xargs) return unknown('is run by xargs, with arguments the gate cannot see');
  const lit = literalWords(cmd.words.slice(c.at + 1));
  if (lit.bad) return { deny: unresolvedWord(c.name, lit.bad) };
  const resolve = (file) => resolvePath(ctx, file, src);
  const withPaths = (parsed) => (parsed.why ? { deny: unresolvedPath(c.name, parsed.why) } : null);
  if (c.name === 'pgrep') {
    if (pgrepPrintsMore(lit.values)) {
      return unknown('is `pgrep` with -l, -d or -q (it prints more than pids, and `kill` would take those words as targets)');
    }
    const parsed = pgrepArgs(lit.values, false, resolve);
    return withPaths(parsed) || dryRun(ctx, PGREP, parsed.args);
  }
  if (c.name === 'lsof') {
    if (!lit.values.some((v) => /^-[A-Za-z]*t/.test(v))) return unknown('is `lsof` without -t (it prints a table, not pids)');
    const parsed = lsofArgs(lit.values, resolve);
    return withPaths(parsed) || dryRun(ctx, LSOF, parsed.args);
  }
  if (c.name === 'cat') {
    if (lit.values.length !== 1 || lit.values[0].startsWith('-')) return unknown('is `cat` of something other than one file');
    const file = resolve(lit.values[0]);
    return file.why ? { deny: unresolvedPath('cat', file.why) } : pidfileRows(ctx, file.path);
  }
  return unknown(`is \`${clip(c.name)}\``);
}

function pidfileRows(ctx, file) {
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_PIDFILE_BYTES) throw new Error(`not a regular file of at most ${MAX_PIDFILE_BYTES} bytes`);
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { deny: verdict('probe', `the pid file \`${clip(file)}\` could not be read (${clip(e.message)}), ` +
      'so the gate cannot tell which processes `kill` would signal') };
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const bad = tokens.find((t) => !/^[1-9]\d*$/.test(t));
  if (bad !== undefined) {
    return { deny: verdict('unresolved', `the pid file \`${clip(file)}\` holds \`${clip(bad)}\`, which is not a pid`) };
  }
  return tokens.length ? lookupPids(ctx, tokens) : { rows: [] };
}

// A target written `$(...)` or `` `...` `` whole: the producer is the one command inside.
// The word is lexed on its own, which yields its own command plus one command per command
// inside its substitutions: exactly two means one substitution holding one simple command.
// Anything else (a pipeline, a list, text around or beside the substitution) is unresolved.
function substitutionRows(ctx, word, src) {
  const inner = wholeSubstitution(word.value);
  if (!inner || inner.length !== 1) {
    return { deny: verdict('unresolved', `the \`kill\` target \`${clip(word.value)}\` is not one substitution of a single command ` +
      'the gate can run read-only; use `pgrep`, `lsof -t` or `cat <pidfile>` alone, or a literal pid') };
  }
  return producerRows(ctx, inner[0], src);
}

// The commands inside a word that is exactly one `$(...)` or `` `...` ``, or null. The word
// is lexed on its own, which yields its own command plus one command per command inside its
// substitutions (a nested substitution adds one more).
function wholeSubstitution(t) {
  const lexed = (t.startsWith('$(') && t.endsWith(')')) || (t.length > 1 && t.startsWith('`') && t.endsWith('`'))
    ? shellWords(t) : null;
  if (!lexed || lexed.error) return null;
  const [outer, ...inner] = lexed.commands;
  return outer && inner.length && outer.words.length === 1 && outer.words[0].value === t ? inner : null;
}

// Whether a substitution can print nothing but pids: one `pgrep` (without -l, -d or -q),
// `lsof -t` or `cat FILE`, optionally piped to a single `head` or `tail`. What a pid file
// holds is not checked (a file written to smuggle words is evasion, out of scope).
function printsOnlyPids(t) {
  const inner = wholeSubstitution(t);
  if (!inner || inner.length > 2) return false;
  const [producer, filter] = inner;
  if (filter) {
    const f = commandAt(filter.words);
    if (!f || f.xargs || !['head', 'tail'].includes(f.name) || producer.sep !== '|') return false;
  }
  const c = commandAt(producer.words);
  if (!c || c.xargs) return false;
  const values = producer.words.slice(c.at + 1).map((w) => w.value);
  if (c.name === 'pgrep') return !pgrepPrintsMore(values);
  if (c.name === 'lsof') return values.some((v) => /^-[A-Za-z]*t/.test(v));
  if (c.name === 'cat') return values.length === 1 && !values[0].startsWith('-');
  return false;
}

// A word after kill's signal that cannot expand to an option word: plain digits, a `%job`,
// a simple `$NAME` or `${NAME}`, or a substitution that prints only pids. The shell expands
// words before kill reads its options, so anything else (braces, globs, `$@`, `${X:-...}`,
// arrays, other substitutions, a word that starts with `-`) might supply a `-s 9`.
const SIMPLE_PARAMETER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const JOB = /^%(?:[%+-]|\d+|[A-Za-z_][A-Za-z0-9_]*)?$/;
const isInertTarget = (word) => (word.subst
  ? printsOnlyPids(word.value)
  : /^\d+$/.test(word.value) || JOB.test(word.value) || SIMPLE_PARAMETER.test(word.value));

// `xargsFrom` is null, or { producer, src, why, runner } when xargs (or, for `runner`
// 'find', a find -exec clause that hands over file names) runs this kill: `producer` is
// the command whose output xargs reads, or null with `why` saying what the gate cannot
// tell; `src` is where that producer runs. `src` (here) is where the kill runs, which is
// where a `$(...)` target runs.
function checkKill(ctx, args, xargsFrom, src) {
  let i = 0;
  let sawSignal = false;
  // Signal 0 is only the existence-and-permission check of kill(2): nothing is signalled,
  // whatever the target. It is read the way /bin/kill reads a number (`-0`, `-00`,
  // `-s 0`, `-n 0`). A name is never read as 0: none means 0 to /bin/kill or bash, and
  // zsh's EXIT "is not known to the operating system". It exempts the command only when
  // it is the one option word: Apple's bash 3.2 keeps reading `-s`/`-n` and `-SIGNAL`
  // words up to the first target, and the last one wins, so a second option word (a later
  // `-s`, a `-9`, or a `--`, which zsh and /bin/kill may read differently) leaves the
  // command to be judged as any other signal. The words are expanded before kill reads
  // them, so every word after the signal must also be one that cannot expand to an option
  // (isInertTarget).
  // `kill -l` only lists signal names (bash 3.2 lists whenever `-l` appears, zsh returns after
  // it, /bin/kill exits). `-L` does not: bash 3.2 reads it as an unknown signal word that a
  // later `-s`/`-n` overwrites, so it is judged like any other word.
  if (args.length && args[0].value === '-l') return null;
  let zero = false;
  let moreOptions = false;
  for (; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { moreOptions = true; i++; break; }
    if (v === '-s' || v === '-n') {
      if (sawSignal) moreOptions = true;
      else if (i + 1 < args.length && ZEROS.test(args[i + 1].value)) zero = true;
      i++; sawSignal = true; continue;
    }
    if (!sawSignal && /^-([0-9]+|[A-Za-z][A-Za-z0-9]*)$/.test(v)) {
      if (/^-0+$/.test(v)) zero = true;
      sawSignal = true; continue;
    }
    break;
  }
  if (zero && !moreOptions && args.slice(i).every(isInertTarget)) return null;
  const pids = [];
  const substitutions = [];
  for (; i < args.length; i++) {
    // A target that starts with `-` is a process group (`-1`, `-$PGID`, `-"$PGID"`);
    // the lexer has already dropped the quotes. A bare `--` only ends options.
    const v = args[i].value;
    if (/^\+?0+$/.test(v) || (v.startsWith('-') && v !== '--')) {
      return verdict('group', `target \`${clip(v)}\` is a process group, which can signal every process of a user`);
    }
    if (args[i].subst) substitutions.push(args[i]);
    else if (/^\d+$/.test(v)) pids.push(v);
    // A `$variable` or `%job` is something the gate cannot see. Any other literal (`0-`,
    // `4242-`, ` -1`) is read by strtol and zsh in ways the gate does not model, so it is
    // refused. Under xargs or find the words that are not pids include the placeholder.
    else if (!xargsFrom && !/^[$%]/.test(v)) {
      return verdict('unresolved', `the \`kill\` target \`${clip(v)}\` is not a pid, a \`$variable\` or a \`%job\`, ` +
        'so the gate cannot tell which process or group the shell would signal');
    }
  }
  const rows = [];
  const collect = (r) => { if (r.rows) rows.push(...r.rows); return r.deny; };
  if (pids.length) { const d = collect(lookupPids(ctx, pids)); if (d) return d; }
  for (const word of substitutions) { const d = collect(substitutionRows(ctx, word, src)); if (d) return d; }
  if (xargsFrom) {
    if (!xargsFrom.producer) {
      return verdict('unresolved', `\`kill\` run by ${xargsFrom.runner} takes its targets from input the gate cannot see (${xargsFrom.why}); ` +
        'pipe `pgrep`, `lsof -t` or `cat <pidfile>` directly into it, or use literal pids');
    }
    const d = collect(producerRows(ctx, xargsFrom.producer, xargsFrom.src));
    if (d) return d;
  }
  return judge(ctx, rows, '`kill` with these targets');
}

// The body a shell or eval hands to the shell as a command string, or null.
// Options are read the way bash/sh/zsh do: a combined short-option word (`-euo`,
// `-xc`) carries every letter, `o` and `O` each take the next word as their value
// (`-o pipefail`, `-O extglob`), and `c` marks that the first word after the
// options is the command string.
function shellBody(name, args) {
  if (name === 'eval') return args.map((a) => a.value).join(' ');
  let i = 0;
  let hasC = false;
  for (; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { i++; break; }
    if (v.startsWith('--')) {
      if (v === '--rcfile' || v === '--init-file') i++;
      continue;
    }
    if (v.length < 2 || !/^[-+]/.test(v)) break;
    if (/c/.test(v)) hasC = true;
    if (/[oO]/.test(v)) i++;
  }
  return hasC && i < args.length ? args[i].value : null;
}

// Redirections that replace what a command reads from its pipe: `<`, `<<`, `<<-`, `<<<`,
// `<&` and `<>` on fd 0 (written or implied).
const STDIN_REDIRECTS = new Set(['<', '<<', '<<-', '<<<', '<&', '<>']);
const hasStdinRedirect = (cmd) => cmd.redirs.some((r) => STDIN_REDIRECTS.has(r.op) && (r.fd === null || r.fd === 0));

// A word that may change the shell's directory, in any spelling the gate can see
// (`builtin cd`, `eval "cd d"`, `sh -c 'cd d; ...'`): read as a superset, since the only
// cost of a false positive is a relative path it then refuses.
const CD_WORD = /\b(?:cd|pushd|popd|chdir)\b/;
const mentionsCd = (cmd) => cmd.words.some((w) => CD_WORD.test(w.value));

// What feeds an xargs: `prev` is the command before it in this list and `next` the one
// after. Only the previous stage of a pipe qualifies, and only when it is the whole of what
// the pipe carries: a group's output is all of its commands', and a stdin redirect on xargs
// replaces the pipe. A redirect written after the group xargs runs in (`(xargs kill) < f`)
// is lexed as a command of its own with no words, which follows the group's last command;
// it is read as replacing the pipe too, which also refuses `(a | xargs kill) < f`, where
// the redirect is the group's and not xargs's: a rare form, refused rather than guessed.
function xargsSource(cmd, prev, next, src) {
  const none = (why) => ({ producer: null, why, runner: 'xargs' });
  if (!prev || (prev.sep !== '|' && prev.sep !== '|&')) return none('no pipeline feeds it');
  if (prev.groupEnd) return none('the previous stage is a group of commands, and its output is all of them, not only its last');
  if (hasStdinRedirect(cmd) || (next && next.words.length === 0 && hasStdinRedirect(next))) {
    return none('a stdin redirect replaces the pipe');
  }
  return { producer: prev, src, runner: 'xargs' };
}

// The command a `trap` runs when its condition fires, as the string it was given, or null:
// `trap [--] ACTION CONDITION...` sets one; `-p`, `-l`, a lone `-` (reset) and an ACTION with
// no condition set nothing.
function trapBody(args) {
  const values = args.map((a) => a.value);
  let i = values[0] === '--' ? 1 : 0;
  if (i >= values.length || (values[i].startsWith('-') && values[i] !== '--')) return null;
  const action = values[i++];
  return i < values.length ? action : null;
}

// What a `find` runs: the words of each -exec/-execdir/-ok/-okdir clause. A clause ends at
// `;`, or at `+` only when that `+` comes straight after `{}` (any other `+` is an argument
// of the command, as in `env -u + kill ...`). `batched` is true for a `+` clause or one that
// holds `{}`: find then hands the command the file names it matched, which the gate cannot see.
function findExecs(args) {
  const execs = [];
  for (let i = 0; i < args.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i].value)) continue;
    const words = [];
    let batched = false;
    for (i++; i < args.length; i++) {
      const v = args[i].value;
      if (v === ';') break;
      if (v === '+' && words.length && words[words.length - 1].value === '{}') break;
      words.push(args[i]);
    }
    if (i < args.length && args[i].value === '+') batched = true;
    if (words.some((w) => w.value.includes('{}'))) batched = true;
    if (words.length) execs.push({ words, batched });
  }
  return execs;
}

// One command of a list: `commands[k]`. `inherited` is where a surrounding xargs (or find)
// gets its input from, null when none runs this command.
function scanCommand(commands, k, depth, inherited, ctx, elevatedOuter, src) {
  const cmd = commands[k];
  const c = commandAt(cmd.words);
  if (!c) return null;
  const args = cmd.words.slice(c.at + 1);
  // xargs reads the previous stage of its pipeline; a kill in a body that xargs
  // runs is still a kill run by xargs.
  const xargsFrom = c.xargs ? xargsSource(cmd, commands[k - 1], commands[k + 1], src) : inherited;
  // A body handed to a shell by sudo runs as the super-user too.
  const elevated = elevatedOuter || c.elevated;
  const runner = xargsFrom && xargsFrom.runner;
  if (c.name === 'pkill' || c.name === 'killall') {
    return xargsFrom
      ? verdict('unresolved', `\`${c.name}\` run by ${runner} takes its patterns from input the gate cannot see`)
      : (c.name === 'pkill' ? checkPkill(ctx, args, src) : checkKillall(ctx, args, elevated));
  }
  if (c.name === 'kill') return checkKill(ctx, args, xargsFrom, src);
  if (depth >= MAX_DEPTH) return null;
  if (['sh', 'bash', 'zsh', 'eval'].includes(c.name)) {
    const body = shellBody(c.name, args);
    return body ? scan(body, depth + 1, xargsFrom, ctx, elevated, src.cdSeen) : null;
  }
  // The action of a trap is a command string the shell runs later, like a `-c` body.
  if (c.name === 'trap') {
    const body = trapBody(args);
    return body ? scan(body, depth + 1, xargsFrom, ctx, elevated, src.cdSeen) : null;
  }
  // find runs each -exec clause as a command of its own. One that carries the matched file
  // names reads its targets from find, which the gate cannot see; any other runs as written.
  if (c.name === 'find') {
    for (const exec of findExecs(args)) {
      const fromFind = { producer: null, why: 'find supplies the file names it matched', runner: 'find' };
      const sub = [{ words: exec.words, redirs: [], sep: null }];
      const r = scanCommand(sub, 0, depth + 1, exec.batched ? fromFind : xargsFrom, ctx, elevated, src);
      if (r) return r;
    }
  }
  return null;
}

// Whether `(` nests deeper than MAX_NESTING in the text, counted without regard to quoting
// (over-counting is safe: it only denies more). One pass, stopping at the first excess.
function nestsTooDeep(text) {
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 40) { if (++open > MAX_NESTING) return true; }
    else if (ch === 41 && open > 0) open--;
  }
  return false;
}

// `cdOuter`: a cd, pushd or popd came earlier in an enclosing body.
function scan(command, depth, inherited, ctx, elevatedOuter = false, cdOuter = false) {
  // Checked before lexing, which is what a deeply nested command would burn its time in.
  // Like a lex error, it denies only a command that mentions a kill-family word.
  if (nestsTooDeep(command)) {
    if (!KILL_WORD.test(command)) return null;
    return verdict('parse', `the command nests parentheses more than ${MAX_NESTING} deep, which the gate does not ` +
      'read, so it cannot tell what its kill-family word runs');
  }
  const lexed = shellWords(command);
  if (lexed.error) {
    if (!KILL_WORD.test(command)) return null;
    return verdict('parse', `the gate could not read the command (${clip(String(lexed.error))}), so it cannot ` +
      'tell what its kill-family word runs');
  }
  const commands = lexed.commands;
  let cdSeen = cdOuter;
  for (let k = 0; k < commands.length; k++) {
    // Where this command's producers run: as the caller unless a body handed to a shell by
    // sudo/doas holds them, and in the directory a cd before this command left behind.
    const src = { elevated: elevatedOuter, cdSeen };
    if (mentionsCd(commands[k])) cdSeen = true;
    const r = scanCommand(commands, k, depth, inherited, ctx, elevatedOuter, src);
    if (r) return r;
  }
  return null;
}

/**
 * `null` to allow, or `{ rule, reason }` to deny. `platform` is
 * `process.platform` for the hook; anything but 'darwin' is allowed outright.
 * `deps.probe(bin, args)` is kill-probe.cjs's probe (or a fixture) and
 * `deps.ancestors` the hook's ancestor pids, `{ error }`, or a function returning
 * either; both are needed only when a command reaches a dry run. `deps.cwd` is the hook
 * input's cwd, which relative paths in the command resolve against (default: the
 * process's own).
 */
function decide(command, platform, deps = {}) {
  if (platform !== 'darwin') return null;
  if (typeof command !== 'string' || !command) return null;
  return scan(command, 0, null, makeContext(deps));
}

// An uncaught exception exits 1 with no output, which Claude Code treats as non-blocking:
// the command would run. A command that holds a kill word is therefore denied when the
// gate cannot reach a verdict, whatever the cause (`what` says which).
const crashVerdict = (what) => verdict('crash', `${what} while reading a command that holds a ` +
  'kill-family word, so it cannot tell what that word runs');

// The wall-clock budget. A timed-out command hook does not block the tool call, so a hook
// that outlives its 10 s timeout fails open. Under heavy load one probe call has taken
// 25.8 s, so the hook decides in a child process and gives up on it at the deadline.
const BUDGET_MS = 6000;
const DECIDER_FLAG = '--decider';
// The decider's verdict is one small JSON document; more than this is not a verdict.
const MAX_DECIDER_OUTPUT = 64 * 1024;
const MAX_DECIDER_STDERR = 4096;

// The decider's stdout: the JSON text `null` (allow) or `{ rule, reason }` (deny). Anything
// else, including no output at all, is `undefined`.
function parseVerdict(text) {
  let v;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (v === null) return null;
  if (v && typeof v === 'object' && Object.hasOwn(LABEL, v.rule) && typeof v.reason === 'string') {
    return { rule: v.rule, reason: v.reason };
  }
  return undefined;
}

// Write a deny (or nothing) and exit 0. deny() in gate-lib.cjs exits at once, which can cut
// a write to a full pipe short; exit only once the JSON has been handed to the pipe.
let finished = false;
function finish(r) {
  if (finished) return;
  finished = true;
  if (!r) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: r.reason,
    },
  }), () => process.exit(0));
}

/**
 * The hook for one PreToolUse input: writes the deny JSON (or nothing) and exits 0.
 * A kill-word Bash command on darwin is decided by a child process (`deciderArgv` run by
 * `process.execPath`; default: this file in decider mode), spawned asynchronously, without
 * a shell, with all three stdio as pipes: a stdio the child inherited from the hook would
 * be held open by the child after the hook exits. If no verdict has come by `startedAt` +
 * `budgetMs` (default: this process's start + BUDGET_MS) the hook denies with rule `probe`
 * and exits, leaving the child to finish by itself: it is never signalled. A child that
 * does not start, does not exit 0, or prints no parseable verdict, and any throw in this
 * function, is a crash (Decision 18). Anything else exits in silence without starting a
 * child.
 */
function runHook(input, options = {}) {
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || process.platform !== 'darwin' ||
      typeof command !== 'string' || !KILL_WORD.test(command)) {
    return finish(null);
  }
  // Any synchronous throw below (process.cwd() in a removed directory, a failed spawn) would
  // exit 1 with no output, and the command would run. It denies instead, as every other way
  // of not reaching a verdict does.
  try {
    return decideInChild(input, command, options);
  } catch (e) {
    process.stderr.write(`kill-gate crashed: ${String(e && e.stack).slice(0, 1000)}\n`);
    return finish(crashVerdict(`the gate threw ${clip(String(e && e.name))} (${clip(String(e && e.message))})`));
  }
}

function decideInChild(input, command, {
  budgetMs = BUDGET_MS,
  deciderArgv = [__filename, DECIDER_FLAG],
  startedAt = Date.now() - process.uptime() * 1000,
}) {
  // Built before anything is started, so a throw leaves no timer and no child behind.
  const request = JSON.stringify({
    command,
    cwd: input?.cwd || process.cwd(),
    // The decider's own parent is this hook, so the ancestor walk must start from the hook's.
    ppid: process.ppid,
  });
  let settled = false;
  let timer = null;
  const settle = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(r);
  };
  // The deadline is absolute, so time spent starting this process and spawning the decider
  // counts against the budget. The hook exits when this fires; the decider is left to end
  // by itself.
  timer = setTimeout(() => {
    settle(verdict('probe', `the dry run did not finish within the ${Math.round(budgetMs / 100) / 10} s budget ` +
      '(the machine is likely under heavy load)'));
  }, Math.max(0, startedAt + budgetMs - Date.now()));
  let child;
  try {
    child = childProcess.spawn(process.execPath, deciderArgv, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    process.stderr.write(`kill-gate crashed: ${String(e && e.stack).slice(0, 1000)}\n`);
    return settle(crashVerdict(`the gate could not start its decider (${clip(String(e && e.message))})`));
  }
  let out = '';
  let overflow = false;
  let err = '';
  child.stdout.setEncoding('utf8');
  let outBytes = 0;
  child.stdout.on('data', (chunk) => {
    outBytes += Buffer.byteLength(chunk);
    if (outBytes > MAX_DECIDER_OUTPUT) overflow = true;
    else out += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { if (err.length < MAX_DECIDER_STDERR) err += chunk; });
  // A decider that exited before reading its input closes the pipe under the write.
  child.stdin.on('error', () => {});
  child.on('error', (e) => {
    settle(crashVerdict(`the gate could not start its decider (${clip(String(e && e.message))})`));
  });
  // Only a decider that ended cleanly (exit 0, not a signal) is trusted, whatever it printed.
  child.on('close', (code, signal) => {
    const v = code === 0 && !signal && !overflow ? parseVerdict(out) : undefined;
    if (v !== undefined) return settle(v);
    const how = signal ? `was ended by ${signal}` : `ended (exit ${code})`;
    process.stderr.write(`kill-gate crashed: the decider ${how} with no usable verdict: ${err.slice(0, 1000)}\n`);
    return settle(crashVerdict(`the decider process ${how} without a usable verdict`));
  });
  child.stdin.end(request);
}

// Decider mode: read { command, cwd, ppid } from stdin, run decide with the real probe,
// write the verdict (`null` or { rule, reason }) to stdout and exit. A throw is a crash
// verdict, never a silent exit.
function runDecider() {
  let raw = '';
  // Decoded as the chunks arrive: a character split across two chunks stays whole.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let r;
    try {
      const req = JSON.parse(raw);
      if (!Number.isSafeInteger(req.ppid)) throw new TypeError('the request carries no ppid');
      r = decide(req.command, process.platform, {
        probe: killProbe.probe,
        cwd: req.cwd || process.cwd(),
        ancestors: () => killProbe.ancestorPids(req.ppid, killProbe.probe),
      });
    } catch (e) {
      process.stderr.write(`kill-gate crashed: ${String(e && e.stack).slice(0, 1000)}\n`);
      r = crashVerdict(`the gate threw ${clip(String(e && e.name))} (${clip(String(e && e.message))})`);
    }
    process.stdout.write(JSON.stringify(r), () => process.exit(0));
  });
}

module.exports = { decide, MAX_MATCHES, runHook, BUDGET_MS };

if (require.main === module) {
  if (process.argv.includes(DECIDER_FLAG)) runDecider();
  else {
    // readStdin concatenates chunks as text; decoding them here keeps a character split
    // across two chunks whole.
    process.stdin.setEncoding('utf8');
    readStdin((input) => runHook(input));
  }
}
