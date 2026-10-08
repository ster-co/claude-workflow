#!/usr/bin/env node
// Table test for shellWords() in gate-lib.cjs (plan Decision 9 / Task 0).
// Run: node hooks/test/test-shell-words.cjs
//
// shellWords only lexes strings: nothing here runs pkill, killall or kill, and the
// kill-family words below are data in JS strings. A lexer that merely split the
// input on spaces would pass the plain cases; the backslash, $'...', comment,
// redirection, heredoc and substitution cases are the ones that catch it.
//
// Conventions the table relies on (documented in gate-lib.cjs too):
//  - a word is { value, subst }; a word that holds a command substitution keeps the
//    RAW substitution text in `value` (`$( id -u )`, `` `p q` ``, `<(p q)`), so it
//    is not the words the shell would produce -- `subst: true` says so;
//  - the contents of every substitution the shell would run are lexed as commands
//    of their own and appended AFTER the commands of the level that held them;
//  - `sep` is the operator that followed a command, null after the last one; a
//    newline is ';';
//  - a redirection is { op, fd, target } with fd null when none was written;
//  - `groupEnd` is true on the last command of a `( ... )` group that held several
//    commands, when the operator after the `)` was carried onto it: what a pipe
//    after the group reads is the output of the whole group, not of that command.
const fs = require('fs');
const os = require('os');
const path = require('path');

// gate-lib reads CLAUDE_CONFIG_DIR at load time; point it at a throwaway directory.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'shellwords-cfg-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const lib = require('../gates/gate-lib.cjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

// Expected word notation: a string is a plain word; S(text) is a subst word.
const S = (value) => ({ value, subst: true });
const norm = (w) => (typeof w === 'string' ? { value: w, subst: false } : w);
const R = (op, fd, target) => ({ op, fd, target });
const ERR = { error: true };

// [input, expected commands (arrays of words), extras]. extras: seps (one per
// command), redirs (one array per command) and groupEnds (one boolean per command)
// are only checked when given.
const CASES = [
  // --- plan Task 0 -------------------------------------------------------
  ['a \\\nb', [['a', 'b']]],
  ['pk\\ill -f cat', [['pkill', '-f', 'cat']]],
  ["x \"a b\" 'c d' e\\ f", [['x', 'a b', 'c d', 'e f']]],
  ["$'no\\x64e'", [['node']]],
  ['cmd # note', [['cmd']]],
  ['a#b', [['a#b']]],
  ['kill $( id -u )', [['kill', S('$( id -u )')], ['id', '-u']]],
  ['cat <(p q)', [['cat', S('<(p q)')], ['p', 'q']]],
  ['p 2>/dev/null -x', [['p', '-x']], { redirs: [[R('>', 2, '/dev/null')]] }],
  ['p >| f -9', [['p', '-9']], { redirs: [[R('>|', null, 'f')]] }],
  ['p 2 >f', [['p', '2']], { redirs: [[R('>', null, 'f')]] }],
  ['a && b; c | d & e', [['a'], ['b'], ['c'], ['d'], ['e']],
    { seps: ['&&', ';', '|', '&', null] }],
  ["cat <<\\EOF\ndon't pkill it\nEOF", [['cat']], { redirs: [[R('<<', null, 'EOF')]] }],
  ["cat <<'MSG-END'\nit's\nMSG-END", [['cat']], { redirs: [[R('<<', null, 'MSG-END')]] }],
  ['cat <<X && a\nbody\nX', [['cat'], ['a']], { seps: ['&&', ';'] }],
  ['cat <<X\n$(p q)\nX', [['cat'], ['p', 'q']]],
  ["cat <<'X'\n$(p q)\nX", [['cat']]],
  ['echo $(p q)', [['echo', S('$(p q)')], ['p', 'q']]],
  ['echo "a $(p q)"', [['echo', S('a $(p q)')], ['p', 'q']]],
  ['x=`p q`', [[S('x=`p q`')], ['p', 'q']]],
  ["echo '$(p q)'", [['echo', '$(p q)']]],
  ['cat <<X\nno end', ERR],
  ['"unterminated', ERR],
  ['echo "pkill -f cat"', [['echo', 'pkill -f cat']]],

  // --- words: quoting, escapes, continuation, comments --------------------
  ['foo\\\nbar', [['foobar']]],
  ["echo ''", [['echo', '']]],
  ['echo a"b c"d', [['echo', 'ab cd']]],
  ['echo "a\\"b" "c\\\\d" "e\\qf"', [['echo', 'a"b', 'c\\d', 'e\\qf']]],
  ['echo "a\\\nb"', [['echo', 'ab']]],
  ["echo 'a\\nb'", [['echo', 'a\\nb']]],
  ['echo "a #b"', [['echo', 'a #b']]],
  ['echo a;#c\nb', [['echo', 'a'], ['b']]],
  ['echo \\#x', [['echo', '#x']]],
  ["echo $'a\\tb\\n' $'\\101\\u0042\\x43' $'it\\'s'", [['echo', 'a\tb\n', 'ABC', "it's"]]],
  ["echo $'unterminated", ERR],
  // `$"..."` lexes as the double-quoted string without the `$` (bash's reading). zsh
  // would keep the `$`, but a gate that lexes the body of `bash -c` must see what bash
  // runs; dropping the `$` only over-denies under zsh.
  ['echo $"a b"', [['echo', 'a b']]],
  ['$"p q" r', [['p q', 'r']]],

  // --- operators and command boundaries -----------------------------------
  ['a\nb', [['a'], ['b']], { seps: [';', null] }],
  ['a &&\nb', [['a'], ['b']], { seps: ['&&', null] }],
  ['a || b', [['a'], ['b']], { seps: ['||', null] }],
  ['a |& b', [['a'], ['b']], { seps: ['|&', null] }],
  ['sleep 1 &', [['sleep', '1']], { seps: ['&'] }],
  ['a;b', [['a'], ['b']], { seps: [';', null] }],
  ['', []],
  ['   ', []],

  // --- redirections -------------------------------------------------------
  ['p 2>&1', [['p']], { redirs: [[R('>&', 2, '1')]] }],
  ['p >&2', [['p']], { redirs: [[R('>&', null, '2')]] }],
  ['p 2>&-', [['p']], { redirs: [[R('>&', 2, '-')]] }],
  ['p &>f', [['p']], { redirs: [[R('&>', null, 'f')]] }],
  ['p &>>f', [['p']], { redirs: [[R('&>>', null, 'f')]] }],
  ['p >>f', [['p']], { redirs: [[R('>>', null, 'f')]] }],
  ['p <f', [['p']], { redirs: [[R('<', null, 'f')]] }],
  ['p <>f', [['p']], { redirs: [[R('<>', null, 'f')]] }],
  ['p <<<x', [['p']], { redirs: [[R('<<<', null, 'x')]] }],
  ["p <<< 'a b' -x", [['p', '-x']], { redirs: [[R('<<<', null, 'a b')]] }],
  ['p 1>f 2>>g', [['p']], { redirs: [[R('>', 1, 'f'), R('>>', 2, 'g')]] }],
  ['p a2>f', [['p', 'a2']], { redirs: [[R('>', null, 'f')]] }],
  ['p "2">f', [['p', '2']], { redirs: [[R('>', null, 'f')]] }],
  ['p > f -x; q 2>g', [['p', '-x'], ['q']],
    { redirs: [[R('>', null, 'f')], [R('>', 2, 'g')]] }],
  ['p >', ERR],
  ['p > > f', ERR],

  // --- heredocs -----------------------------------------------------------
  ['cat <<-X\n\tbody\n\tX', [['cat']], { redirs: [[R('<<-', null, 'X')]] }],
  ['cat <<X\n\tX\nX', [['cat']]],
  ['cat <<"X"\n$(p q)\nX', [['cat']]],
  ['cat <<E"O"F\n$(p q)\nEOF', [['cat']], { redirs: [[R('<<', null, 'EOF')]] }],
  ['cat <<X <<Y\na\nX\nb\nY\nls', [['cat'], ['ls']]],
  ['cat <<X\n\\$(p q)\nX', [['cat']]],
  ['cat <<X\n`p q`\nX', [['cat'], ['p', 'q']]],
  ['cat <<X\n<(p q)\nX', [['cat']]],
  ['cat <<X\nbody\nX\necho after', [['cat'], ['echo', 'after']]],
  ['cat <<X', ERR],
  ['cat <<', ERR],
  ['cat <<X\n$(p q\nX', ERR],

  // --- command substitution -----------------------------------------------
  ['echo $(a $(b c))', [['echo', S('$(a $(b c))')], ['a', S('$(b c)')], ['b', 'c']]],
  ['echo $(a; b)', [['echo', S('$(a; b)')], ['a'], ['b']]],
  ['echo $(echo ")" x)', [['echo', S('$(echo ")" x)')], ['echo', ')', 'x']]],
  ['echo "$(echo "a b")"', [['echo', S('$(echo "a b")')], ['echo', 'a b']]],
  ['echo $(a # ) not the end\n)', [['echo', S('$(a # ) not the end\n)')], ['a']]],
  ['echo $((1+2))', [['echo', S('$((1+2))')], ['1+2']]],
  ['echo `a \\`b\\``', [['echo', S('`a \\`b\\``')], ['a', S('`b`')], ['b']]],
  ['echo "a `p q`"', [['echo', S('a `p q`')], ['p', 'q']]],
  ['echo \\$\\(p\\ q\\)', [['echo', '$(p q)']]],
  ['echo "\\$(p q)"', [['echo', '$(p q)']]],
  ['echo $(p q', ERR],
  ['echo "$(p q"', ERR],
  ['echo `p q', ERR],
  // The shell runs process substitution only in an unquoted word: in "..." it is
  // literal text (plan Known defects, D1 amendment audit r5).
  ['echo "a <(p q)"', [['echo', 'a <(p q)']]],
  ['echo "<(p q)"', [['echo', '<(p q)']]],
  ['p >(q r)', [['p', S('>(q r)')], ['q', 'r']]],

  // --- groups, keywords, case arms (plan Decision 17 / Task 1) ------------
  // A `(`, `{`, keyword or `pat)` arm starts or ends a command instead of
  // becoming a word of the previous one; the header words of `for`/`case` are
  // not commands.
  ['( p q )', [['p', 'q']]],
  ['(p q)', [['p', 'q']]],
  ['{ p q; }', [['p', 'q']]],
  ['if x; then p q; fi', [['x'], ['p', 'q']]],
  ['while x; do p q; done', [['x'], ['p', 'q']]],
  ['until x; do p q; done', [['x'], ['p', 'q']]],
  ['case a in a) p q;; esac', [['p', 'q']]],
  ['! p q', [['p', 'q']]],
  ['if ! x; then p q; elif y; then r; else s; fi', [['x'], ['p', 'q'], ['y'], ['r'], ['s']]],
  ['for i in a b; do p q; done', [['p', 'q']]],
  ['case a in a|b) p q;; c) r;; esac', [['p', 'q'], ['r']]],
  ['case a in\n  (a) p q ;;\n  *) r\nesac\ns', [['p', 'q'], ['r'], ['s']]],
  ['( p q ) && r', [['p', 'q'], ['r']], { seps: ['&&', null] }],
  ['( p q ); r &', [['p', 'q'], ['r']], { seps: [';', '&'] }],
  ['( ( p q ) )', [['p', 'q']]],
  // The sep after a group's `)` is carried onto its last command; `groupEnd` marks it
  // when the group held more than one command.
  ['(p; q) | r', [['p'], ['q'], ['r']], { seps: [';', '|', null], groupEnds: [false, true, false] }],
  ['(p) | r', [['p'], ['r']], { seps: ['|', null], groupEnds: [false, false] }],
  ['p | q', [['p'], ['q']], { seps: ['|', null], groupEnds: [false, false] }],
  ['((p; q)) | r', [['p'], ['q'], ['r']], { groupEnds: [false, true, false] }],
  ['((p)) | r', [['p'], ['r']], { groupEnds: [false, false] }],
  ['(p; (q)) | r', [['p'], ['q'], ['r']], { seps: [';', '|', null], groupEnds: [false, true, false] }],
  // A `fi` or `}` before the `)` leaves nothing to carry the `|` onto: `p` keeps its `;`, so
  // no pipe reads it.
  ['(if x; then p; fi) | r', [['x'], ['p'], ['r']], { seps: [';', ';', null], groupEnds: [false, false, false] }],
  ['a; (p) | (q; r) | s', [['a'], ['p'], ['q'], ['r'], ['s']],
    { seps: [';', '|', ';', '|', null], groupEnds: [false, false, false, true, false] }],
  ['f() { p q; }', [['p', 'q']]],
  ['f () { p q; }', [['p', 'q']]],
  ['( p q ) > f', [['p', 'q'], []], { redirs: [[], [R('>', null, 'f')]] }],
  // Keywords count only at command position and unquoted.
  ["'if' p", [['if', 'p']]],
  ['echo if then done }', [['echo', 'if', 'then', 'done', '}']]],
  ['p in q', [['p', 'in', 'q']]],
  // A command substitution in a header still runs.
  ['for i in $(p q); do r; done', [['r'], ['p', 'q']]],
  ['x=$(case a in a) p q;; esac)', [[S('x=$(case a in a) p q;; esac)')], ['p', 'q']]],
  ['echo $(case a in a|b) p q;; esac) r', [['echo', S('$(case a in a|b) p q;; esac)'), 'r'], ['p', 'q']]],
  ['x=$( (p q) )', [[S('x=$( (p q) )')], ['p', 'q']]],
  // A `(` inside a case pattern (zsh glob group, bash extglob) is closed by its
  // own `)`; only the `)` outside every such group ends the pattern.
  ['case $f in *.(js|ts)) p q;; esac', [['p', 'q']]],
  ['case $f in *.(js|ts)) p q;; *.(md)) r s;; esac', [['p', 'q'], ['r', 's']]],
  ['case $f in *.@(js|ts)) p q;; esac', [['p', 'q']]],
  ['case $f in !(a|b)) p q;; esac', [['p', 'q']]],
  ['case $f in (*.(js|ts)) p q;; esac', [['p', 'q']]],
  ['case $x in (a) p q;; esac', [['p', 'q']]],
  ['echo "$(case $f in *.(js|ts)) r s;; esac)"',
    [['echo', S('$(case $f in *.(js|ts)) r s;; esac)')], ['r', 's']]],
  ['x=$(case $f in *.@(js|ts)) r s;; esac)',
    [[S('x=$(case $f in *.@(js|ts)) r s;; esac)')], ['r', 's']]],
  ['x=$(case $f in *.(js|ts)) r s;; *.(md)) t u;; esac)',
    [[S('x=$(case $f in *.(js|ts)) r s;; *.(md)) t u;; esac)')], ['r', 's'], ['t', 'u']]],
  ['x=$(case $f in (a) r s;; esac)', [[S('x=$(case $f in (a) r s;; esac)')], ['r', 's']]],
  // Heredocs inside a substitution: the scanner skips bodies, so a `)` or an
  // apostrophe in one does not end or break the substitution.
  ["git commit -m \"$(cat <<'EOF'\ndon't 1) x\nEOF\n)\"",
    [['git', 'commit', '-m', S("$(cat <<'EOF'\ndon't 1) x\nEOF\n)")], ['cat']]],
  ["git commit -m \"$(cat <<'EOF'\nFix (closes #12)\nEOF\n)\" && a",
    [['git', 'commit', '-m', S("$(cat <<'EOF'\nFix (closes #12)\nEOF\n)")], ['a'], ['cat']],
    { seps: ['&&', null, ';'] }],
  ['x=$(cat <<-E\n\t)\n\tE\n)', [[S('x=$(cat <<-E\n\t)\n\tE\n)')], ['cat']]],
  ["echo \"$(cat <<'A' <<'B'\n)\nA\n(\nB\n)\" c", [['echo', S("$(cat <<'A' <<'B'\n)\nA\n(\nB\n)"), 'c'], ['cat']]],
  ['x=$(cat <<X\na\nX\nX\np q\n)', [[S('x=$(cat <<X\na\nX\nX\np q\n)')], ['cat'], ['X'], ['p', 'q']]],
  ['x=$(cat <<X\n)\nno end\n)', ERR],
  // A repeated delimiter line: the FIRST one closes the body, so what follows
  // it is lexed as commands (the shape of the 2026-09-29 incident).
  ['cat <<X\na\nX\nX\np q', [['cat'], ['X'], ['p', 'q']]],
  ["cat <<'EOF'\nbash <<EOF\nEOF\np q\nEOF", [['cat'], ['p', 'q'], ['EOF']]],
  // `<<` in arithmetic is a shift, not a heredoc, when scanning for the `)`.
  ['echo $((1 + 2)) x', [['echo', S('$((1 + 2))'), 'x'], ['1', '+', '2']]],
  // `here-strings` are not heredocs.
  ['x=$(p <<<a) q', [[S('x=$(p <<<a)'), 'q'], ['p']], { redirs: [[], [R('<<<', null, 'a')]] }],
];

if (typeof lib.shellWords !== 'function') {
  check('shellWords is exported as a function', false, `typeof ${typeof lib.shellWords}`);
} else {
  check('shellWords is exported as a function', true);
  for (const [input, expected, extras = {}] of CASES) {
    const label = JSON.stringify(input);
    let got;
    try { got = lib.shellWords(input); } catch (e) { got = { threw: e.message }; }
    if (expected === ERR) {
      check(`${label} -> { error }`, typeof got.error === 'string' && got.error.length > 0 && !got.commands,
        JSON.stringify(got));
      continue;
    }
    if (!Array.isArray(got.commands)) { check(`${label} -> commands`, false, JSON.stringify(got)); continue; }
    const words = got.commands.map((c) => c.words);
    const want = expected.map((c) => c.map(norm));
    check(`${label} -> words`, JSON.stringify(words) === JSON.stringify(want),
      `got ${JSON.stringify(words)}, want ${JSON.stringify(want)}`);
    if (extras.seps) {
      const seps = got.commands.map((c) => c.sep);
      check(`${label} -> seps`, JSON.stringify(seps) === JSON.stringify(extras.seps),
        `got ${JSON.stringify(seps)}`);
    }
    if (extras.groupEnds) {
      const ends = got.commands.map((c) => c.groupEnd === true);
      check(`${label} -> groupEnds`, JSON.stringify(ends) === JSON.stringify(extras.groupEnds),
        `got ${JSON.stringify(ends)}`);
    }
    if (extras.redirs) {
      const redirs = got.commands.map((c) => (c.redirs || []).map((r) => ({ op: r.op, fd: r.fd, target: r.target })));
      const wantR = expected.map((_, i) => extras.redirs[i] || []);
      check(`${label} -> redirs`, JSON.stringify(redirs) === JSON.stringify(wantR),
        `got ${JSON.stringify(redirs)}`);
    }
  }
}

try { fs.rmSync(CONFIG, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
