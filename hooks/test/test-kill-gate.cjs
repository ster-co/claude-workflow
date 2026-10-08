#!/usr/bin/env node
'use strict';
// Tests for hooks/gates/kill-gate.cjs: the dry-run kill gate (plan
// docs/plans/2026-09-30-kill-gate-dryrun.md, Decisions 11-16, Task 3).
// Run: node hooks/test/test-kill-gate.cjs
//
// Nothing here signals a process. The gate rewrites a kill into a read-only query and
// judges what the query returns, so every table below goes through decide() with a
// FIXTURE probe and fixture ancestors: a process table written in this file, never the
// real one. A case that lists no fixture answers must not reach the probe at all, and
// the suite fails if it does.
//
// Order matters, as in test-kill-probe.cjs. The first check greps the gate's source and
// ends the run if it fails, before any sandbox is built. After it, the whole decide
// table runs inside a vm sandbox that holds the real gate-lib.cjs, kill-probe.cjs and
// kill-gate.cjs sources, with a child_process stub that records every spawn (and throws
// for a binary off the allowlist), an fs stub, and a process.kill that throws. Nothing
// from the real modules is required, loaded or called in this process until the source
// grep and every sandbox check have passed: the real-module block at the end is the only
// place that requires the gate, and only when `failures` is still empty.
//
// The sandbox catches accidental regressions (a stray signal, a spawn of an unlisted
// binary). It does not prove the gate cannot signal: vm is not a security boundary, and a
// host object handed in can be escaped through its `constructor.constructor`, which
// reaches the real process. The source grep is a second, equally shallow net.
//
// Every deny assertion checks which rule fired, not just that something did, and every
// deny list is paired with an allow list: a gate that denies every kill passes the deny
// lists alone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

// Hooks read CLAUDE_CONFIG_DIR at load time; never let a test see the real one. USER and
// HOME are what `$USER` / `$HOME` in a command resolve to, so they are pinned here.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'killgate-cfg-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.USER = 'tester';
process.env.HOME = '/Homedirs/tester';

const HOOKS = path.join(__dirname, '..');
const GATES = path.join(HOOKS, 'gates');
const MODULE_PATH = path.join(GATES, 'kill-gate.cjs');
const ALLOWLIST = ['/usr/bin/pgrep', '/bin/ps', '/usr/sbin/lsof'];

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${String(e.message).split('\n')[0]}`); }
}

// --- the source grep, first: text only, executes nothing ------------------------------
// A failed grep ends the run here, so there is no path from a red grep to a
// `vm.runInContext` call or a require of the gate.
const GATE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const FORBIDDEN = /execSync|exec\(|shell: *true|process\.kill|process\[\s*['"`]kill['"`]\s*\]|\.kill\s*\(|argv0|constructor\.constructor/;
const forbiddenMatch = FORBIDDEN.exec(GATE_SOURCE);
if (forbiddenMatch) {
  fs.rmSync(CONFIG, { recursive: true, force: true });
  console.log(`FAIL gate source has no shell exec or signal call: matched ${JSON.stringify(forbiddenMatch[0])}`);
  console.log('0 passed, 1 failed (nothing was loaded: no sandbox and no require ran)');
  process.exit(1);
}
passed++;

check('the gate source has no RUNTIME list and no vague() rule', () => {
  assert.ok(!/RUNTIME|vague\(/.test(GATE_SOURCE), 'a removed text rule is still present');
});
check('the gate source never consults SKIP_CODE_GATES', () => {
  assert.ok(!/SKIP_CODE_GATES|gatesDisabled/.test(GATE_SOURCE.replace(/^\/\/.*$/gm, '')), 'the gate reads the bypass switch');
});
// The decider spawn is the gate's one start of a process of its own (besides the injected
// probe): `process.execPath`, no shell, and all three stdio as pipes. An inherited stderr
// would hold the hook's own stderr open until an abandoned decider ends, which defeats
// the budget (Decision 20).
check('the gate source has exactly one spawn, of process.execPath with all three stdio as pipes and no shell', () => {
  const code = GATE_SOURCE.replace(/^\s*\/\/.*$/gm, '');
  const spawns = [...code.matchAll(/\bspawn(?:Sync)?\s*\(/g)];
  assert.equal(spawns.length, 1, `${spawns.length} spawn calls`);
  const call = code.slice(spawns[0].index, spawns[0].index + 300);
  assert.ok(/^spawn\(\s*process\.execPath\b/.test(call), 'the spawn is not of process.execPath');
  assert.ok(/stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/.test(call), 'the spawn does not pipe all three stdio');
  assert.ok(!/\bshell\b|\bdetached\b/.test(call), 'the spawn sets shell or detached');
});

// The one place the real gate is required must come after the gate that only opens when
// every check above it passed. Read from this file's own text, so it holds for any later
// edit. Every require call in this file must name MODULE_PATH or a node: builtin.
check('the only real-module require is inside the failures gate block', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const gate = /^if \(failures\.length === 0\) \{$/m.exec(self);
  assert.ok(gate, 'the failures gate line is missing');
  assert.equal([...self.matchAll(/^if \(failures\.length === 0\) \{$/gm)].length, 1, 'more than one gate line');
  const close = /^\}/m.exec(self.slice(gate.index + gate[0].length));
  assert.ok(close, 'the failures gate block is not closed');
  const blockEnd = gate.index + gate[0].length + close.index;
  const requires = [...self.matchAll(/require\(MODULE_PATH\)/g)];
  assert.equal(requires.length, 1, `${requires.length} require calls of the gate`);
  assert.ok(requires[0].index > gate.index && requires[0].index < blockEnd,
    'the gate is required outside the failures gate block');
  for (const m of self.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
    const arg = m[1].trim();
    assert.ok(arg === 'MODULE_PATH' || /^'node:[a-z/_]+'$/.test(arg), `unexpected require argument: ${arg}`);
  }
  assert.ok(!/\bimport\s*\(/.test(self), 'a dynamic import is present');
  assert.ok(!/^\s*import\s/m.test(self), 'a static import is present');
  assert.ok(!/create[R]equire|require\.resolve|process\.binding/.test(self), 'another module loader is present');
});

// --- the fixture process table --------------------------------------------------------
// Values built inside the vm carry that realm's prototypes; compare their JSON shape.
const plain = (v) => JSON.parse(JSON.stringify(v));
const UID = String(process.getuid());
const MAX_MATCHES = 10;
const ANCESTORS = [500, 400];

const row = (pid, command, ppid = 900) => ({ pid, ppid, command });
const CLAUDE_CLI = row(700, '/Homedirs/someone/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude --output-format stream-json --verbose');
const RENDERER = row(800, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer');
const LOGINWINDOW = row(200, '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow console', 1);
const FINDER = row(210, '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', 1);
const LAUNCHD = row(1, '/sbin/launchd', 0);
const SERENA = row(3100, '/opt/homebrew/bin/uv run serena start-mcp-server --context claude-code');
const SERENA2 = row(3101, '/opt/homebrew/bin/uv run serena start-mcp-server --context ide');
const VITEST = row(3001, 'node /Homedirs/someone/proj/node_modules/.bin/vitest run test_gate_store_boundary');
const ZSH_ANCESTOR = row(400, '/bin/zsh -c run');
// The calling session: the hook's grandparent, an ancestor of every query the gate runs.
const CLAUDE_SESSION = row(400, '/Homedirs/someone/.local/bin/claude --output-format stream-json', 1);
const WINDOWSERVER = row(150, '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon', 1);
const WINDOWSERVER_OWNER = '_windowserver';
const VSCODE_CLAUDE = row(720, '/Homedirs/tester/.vscode/extensions/anthropic.claude-code-2.1.284-darwin-arm64/resources/native-binary/claude --output-format stream-json');
const plainRows = (n) => Array.from({ length: n }, (_, i) => row(4000 + i, `node worker-${i}.js`));

// Deep nesting is built here in JS, never in a shell. MAX_NESTING mirrors the gate's bound
// on parenthesis depth: a command nested deeper is refused (rule parse) before it is lexed.
const MAX_NESTING = 32;
const nestedSubst = (depth, inner) => '$('.repeat(depth) + inner + ')'.repeat(depth);
const nestedGroup = (depth, inner) => '('.repeat(depth) + inner + ')'.repeat(depth);

// A probe query as a fixture key: the exact binary and argv the gate built.
const K = (bin, ...args) => JSON.stringify([bin, ...args]);
const PG = (...args) => K('/usr/bin/pgrep', ...args);
const LS = (...args) => K('/usr/sbin/lsof', ...args);
const PSQ = (...pids) => K('/bin/ps', '-o', 'pid=,ppid=,command=', '-p', pids.join(','));

// Pid files the `cat FILE` producer reads. Written for the real module and served from a
// map inside the sandbox, so both see the same bytes.
const PIDFILES = {
  claude: '700\n',
  plain: '3001\n',
  empty: '',
  junk: '3001 not-a-pid\n',
  group: '-1\n',
  big: '1\n'.repeat(40000),
};
const PIDFILE = Object.fromEntries(Object.keys(PIDFILES).map((k) => [k, path.join(CONFIG, `${k}.pid`)]));
const FILES = {};
for (const [k, content] of Object.entries(PIDFILES)) {
  fs.writeFileSync(PIDFILE[k], content);
  FILES[PIDFILE[k]] = content;
}
const MISSING_PIDFILE = path.join(CONFIG, 'missing.pid');

// The hook input's cwd: relative paths in a command resolve against it, not against the
// process the gate runs in. server.pid holds a harmless pid; other.pid's twin in OTHER_DIR
// holds the Claude CLI's.
const WORKDIR = path.join(CONFIG, 'work');
const OTHER_DIR = path.join(CONFIG, 'other');
fs.mkdirSync(WORKDIR);
fs.mkdirSync(OTHER_DIR);
for (const [file, content] of [[path.join(WORKDIR, 'server.pid'), '3001\n'], [path.join(OTHER_DIR, 'server.pid'), '700\n']]) {
  fs.writeFileSync(file, content);
  FILES[file] = content;
}

const CAT_HIT = { [PG('-f', 'cat')]: [RENDERER, CLAUDE_CLI, row(5001, 'cat')] };

// Commands the gate must refuse to evaluate a producer for: it would run the producer
// somewhere else than the shell does. No probe query may be made for any of them.
const HARMLESS = [VITEST];
const SERVER_PID_ABS = path.join(WORKDIR, 'server.pid');
const SOURCE_DENY = [
  // Only the last command of a group would be evaluated; the group's output is all of it.
  ['(pgrep -f a; pgrep -f b) | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['(lsof -ti :3000; lsof -ti :5173) | xargs kill -9', { [LS('-ti', ':3000')]: [LAUNCHD], [LS('-ti', ':5173')]: HARMLESS }],
  ['( (pgrep -f a; pgrep -f b) ) | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['{ pgrep -f a; pgrep -f b; } | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['if x; then pgrep -f a; else pgrep -f b; fi | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['(if x; then pgrep -f a; else pgrep -f b; fi) | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['while x; do pgrep -f a; done | xargs kill', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  // The producer runs as the super-user in the shell; the gate would run it unelevated.
  ['sudo lsof -ti :445 | xargs sudo kill -9', { [LS('-ti', ':445')]: HARMLESS }],
  ['timeout 5 sudo lsof -ti :445 | xargs kill', { [LS('-ti', ':445')]: HARMLESS }],
  ['doas lsof -ti :445 | xargs kill', { [LS('-ti', ':445')]: HARMLESS }],
  ['sudo -E env A=1 pgrep -f b | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['kill $(sudo lsof -ti :445)', { [LS('-ti', ':445')]: HARMLESS }],
  ['kill `doas lsof -ti :445`', { [LS('-ti', ':445')]: HARMLESS }],
  ['sudo sh -c "kill -9 \\$(lsof -ti :445)"', { [LS('-ti', ':445')]: HARMLESS }],
  ['sudo bash -c "lsof -ti :445 | xargs kill"', { [LS('-ti', ':445')]: HARMLESS }],
  ['doas sh -c "kill $(lsof -ti :445)"', { [LS('-ti', ':445')]: HARMLESS }],
  ['sudo bash -c "sh -c \\"lsof -ti :445 | xargs kill\\""', { [LS('-ti', ':445')]: HARMLESS }],
  // A relative path after a cd, pushd or popd names a file the gate cannot locate.
  ['cd DIR && kill $(cat server.pid)', { [PSQ('3001')]: HARMLESS }],
  ['cd DIR && cat server.pid | xargs kill', { [PSQ('3001')]: HARMLESS }],
  ['(cd DIR && cat server.pid) | xargs kill', { [PSQ('3001')]: HARMLESS }],
  ['pushd DIR; pkill -F server.pid', { [PG('-F', 'server.pid')]: HARMLESS, [PG('-F', SERVER_PID_ABS)]: HARMLESS }],
  ['popd; kill $(pgrep -F server.pid)', { [PG('-F', 'server.pid')]: HARMLESS, [PG('-F', SERVER_PID_ABS)]: HARMLESS }],
  ['cd DIR; kill $(lsof -t server.sock)', { [LS('-t', 'server.sock')]: HARMLESS, [LS('-t', path.join(WORKDIR, 'server.sock'))]: HARMLESS }],
  ['cd DIR; kill $(lsof -t +D logs)', { [LS('-t', '+D', 'logs')]: HARMLESS, [LS('-t', '+D', path.join(WORKDIR, 'logs'))]: HARMLESS }],
  ['cd DIR && sh -c "kill $(cat server.pid)"', { [PSQ('3001')]: HARMLESS }],
  ['cd DIR && bash -c \'kill $(cat server.pid)\'', { [PSQ('3001')]: HARMLESS }],
  ['cd DIR && eval "cat server.pid | xargs kill"', { [PSQ('3001')]: HARMLESS }],
  // A stdin redirect on xargs replaces the pipe, so the producer is not what it reads.
  ['pgrep -f b | xargs kill < DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill <<EOF\n1\nEOF', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill <<< 1', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill 0< DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill <<-EOF\n\t1\nEOF', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill <&3', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | xargs kill <> DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  // The same, written on the group xargs runs in: the redirect is parsed as a command of its
  // own after the group, and still replaces what xargs reads.
  ['pgrep -f b | (xargs kill) < DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | { xargs kill; } < DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | (xargs kill) <<< 1', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | (xargs -r kill -9) 0< DIR/server.pid', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | (xargs kill) <&3', { [PG('-f', 'b')]: HARMLESS }],
  ['pgrep -f b | (xargs kill) < DIR/server.pid; echo done', { [PG('-f', 'b')]: HARMLESS }],
  // A producer that xargs itself runs is not run as written.
  ['echo a | xargs pgrep -f b | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['echo a | xargs -n1 lsof -t | xargs kill', { [LS('-t')]: HARMLESS }],
  // The kill word is not exactly one substitution of one simple command.
  ['kill $(pgrep -f a)$(pgrep -f b)', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['kill "$(pgrep -f a; pgrep -f b)"', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['kill $(pgrep -f a && pgrep -f b)', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
  ['kill `pgrep -f a; pgrep -f b`', { [PG('-f', 'a')]: [LAUNCHD], [PG('-f', 'b')]: HARMLESS }],
];

// Cases: [want, command, answers?, extra?]. `want` is null (allow) or the rule that must
// fire. `answers` maps a probe query to its rows (or an { error }); a query it does not
// list is an error, so the argv the gate builds is pinned by the case. A case without
// `answers` must not reach the probe, or the ancestor lookup, at all.
const CASES = [
  // group: a target that reaches more than the named processes; no query is needed.
  ...[
    'kill -9 -1', 'kill 0', 'kill -- -123', 'kill -TERM -123',
    'kill -9 \\\n-1', 'kill -TERM \\\n -- -123', '\\kill -9 -1', 'kill -9 "-1"', 'kill -- "-123"',
    'kill -- -$PGID', 'kill -TERM -$pgid', 'kill -9 -"$PGID"', 'kill -s TERM -${PGID}',
    '( kill -9 -1 )', '{ kill -9 -1; }', 'bash -c "kill -9 -1"', 'echo $(kill -9 -1)',
    'pgrep x | xargs kill -9 -1', 'pgrep x | xargs -I{} sh -c "kill -9 -1"',
  ].map((cmd) => ['group', cmd]),
  // unresolved: an argument the gate cannot reproduce, or a producer it cannot run.
  ...[
    'pkill -f "cat" -U $(id -u) -x',
    'pkill -f $PATTERN', 'pkill -f "$(git rev-parse --show-toplevel)"', 'pkill -U $( id -u ) -x Simulator',
    "pkill -f 'server.js$'", 'timeout 5 pkill -f $PATTERN', 'bash -c "pkill -f $PATTERN"',
    'killall $NAME', 'killall -u $(id -un) Simulator',
    'killall -I Simulator', 'killall -help', 'killall -h', 'killall -u', 'killall -SIGNAL$X Simulator',
    'kill $(ps -ax -o pid=)', 'kill `ls /tmp`', 'kill $(pgrep -f x | head -1)', 'kill $(pgrep -f $X)',
    'kill $(lsof -i :3000)', 'kill $(cat a b)', 'kill x$(pgrep -f y)',
    'ls | xargs kill', 'xargs kill < /tmp/pids', 'pgrep x | grep y | xargs kill',
    'pgrep x | xargs pkill -f cat', 'pgrep x | xargs killall',
    'kill $(cat -n f)',
    // ~user and the directory stack forms cannot be reproduced from the hook's environment.
    'pkill -f ~root/x', 'pkill -f ~+', 'pkill -f ~1', 'killall ~foo',
    // A pgrep with -l, -d or -q prints more than pids, and kill would take those words as targets.
    'kill $(pgrep -lf "next dev -p 3917")', 'kill $(pgrep -l x)', 'kill $(pgrep -d, -f x)', 'kill $(pgrep -fd, x)',
    'kill $(pgrep -qf x)', 'kill `pgrep -lf x`', 'pgrep -lf x | xargs kill', 'pgrep -d " " x | xargs -r kill -9',
  ].map((cmd) => ['unresolved', cmd]),
  ['unresolved', `kill $(cat ${PIDFILE.junk})`, {}],
  // unresolved: a producer the gate would run in its own context, not the shell's. Each
  // fixture puts pid 1 where the command really reads it and a harmless pid where a gate
  // that picked the wrong source (or ran it unelevated, or from the wrong directory) looks.
  ...SOURCE_DENY.map(([cmd, answers]) => ['unresolved', cmd, answers]),
  // parse: a kill-family word in text the lexer cannot read.
  ['parse', 'pkill -f "unterminated'],
  ['parse', "bash -c 'pkill -f \"unterminated'"],

  // match: a protected process is in the set.
  ['match', 'pkill -f "serena start-mcp-server"', { [PG('-f', 'serena start-mcp-server')]: [SERENA, SERENA2, CLAUDE_CLI] }],
  ['match', 'killall loginwindow', { [PG('-a', '-x', '-U', UID, 'loginwindow')]: [LOGINWINDOW] }],
  ['match', 'killall "Claude Helper (Renderer)"', { [PG('-a', '-x', '-U', UID, 'Claude Helper \\(Renderer\\)')]: [RENDERER] }],
  ['match', 'killall -9 Finder', { [PG('-a', '-x', '-U', UID, 'Finder')]: [FINDER] }],
  ['match', 'pkill -qx Finder', { [PG('-x', 'Finder')]: [FINDER] }],
  // killall does not hide the caller's ancestors, so its queries carry -a (see pgrepView).
  ['match', 'killall claude', { [PG('-a', '-x', '-U', UID, 'claude')]: [CLAUDE_SESSION] }],
  ['match', 'killall zsh', { [PG('-a', '-x', '-U', UID, 'zsh')]: [ZSH_ANCESTOR] }],
  ['match', 'killall zsh', { [PG('-a', '-x', '-U', UID, 'zsh')]: [row(4500, 'zsh'), ZSH_ANCESTOR] }],
  ['match', 'killall tmux', { [PG('-a', '-x', '-U', UID, 'tmux')]: [row(400, 'tmux: server')] }],
  ['match', 'killall -m "cla.*"', { [PG('-a', '-U', UID, 'cla.*')]: [CLAUDE_SESSION] }],
  ['match', 'killall -u tester', { [PG('-a', '-U', 'tester')]: [CLAUDE_SESSION] }],
  // Under sudo killall is not limited to the caller's uid (man killall), so the query is not.
  ['match', 'sudo killall WindowServer', { [PG('-a', '-x', 'WindowServer')]: [WINDOWSERVER] }],
  ['match', 'sudo -u root killall WindowServer', { [PG('-a', '-x', 'WindowServer')]: [WINDOWSERVER] }],
  ['match', 'doas killall WindowServer', { [PG('-a', '-x', 'WindowServer')]: [WINDOWSERVER] }],
  ['match', 'sudo -E env A=1 killall WindowServer', { [PG('-a', '-x', 'WindowServer')]: [WINDOWSERVER] }],
  ['match', 'sudo bash -c "killall WindowServer"', { [PG('-a', '-x', 'WindowServer')]: [WINDOWSERVER] }],
  ['match', 'sudo killall -m "Window.*"', { [PG('-a', 'Window.*')]: [WINDOWSERVER] }],
  ['match', 'sudo killall -t ttys001 loginwindow', { [PG('-a', '-x', '-t', 'ttys001', 'loginwindow')]: [LOGINWINDOW] }],
  // ~ is expanded by the shell before pkill sees it: a query for a literal `~` matches
  // nothing, the expanded path matches the editor's Claude binary.
  ['match', 'pkill -f ~/.vscode', { [PG('-f', '/Homedirs/tester/.vscode')]: [VSCODE_CLAUDE] }],
  ['match', 'pkill -f ~', { [PG('-f', '/Homedirs/tester')]: [VSCODE_CLAUDE, ...plainRows(3)] }],
  ['match', 'pkill -f "~/.vscode"', { [PG('-f', '/Homedirs/tester/.vscode')]: [VSCODE_CLAUDE] }],
  ['match', "pkill -f '~'", { [PG('-f', '/Homedirs/tester')]: [VSCODE_CLAUDE] }],
  ['match', 'pkill -f ~/', { [PG('-f', '/Homedirs/tester/')]: [VSCODE_CLAUDE] }],
  ['match', 'killall -m ~/.vscode', { [PG('-a', '-U', UID, '/Homedirs/tester/.vscode')]: [VSCODE_CLAUDE] }],
  ['match', 'pkill -f "next start -p 3917" 2>/dev/null -x', { [PG('-f', 'next start -p 3917', '-x')]: [CLAUDE_CLI] }],
  ['match', 'pkill -f "next start" "vitest run"', { [PG('-f', 'next start', 'vitest run')]: [CLAUDE_CLI] }],
  ['match', 'pkill -f "next start -p 3917" >| /tmp/x -9', { [PG('-f', 'next start -p 3917', '-9')]: [CLAUDE_CLI] }],
  ['match', 'kill $(lsof -ti :3000)', { [LS('-ti', ':3000')]: [CLAUDE_CLI] }],
  ['match', 'kill `pgrep x`', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'kill -9 $(pgrep -f "vite dev")', { [PG('-f', 'vite dev')]: [VITEST, CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs kill', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs -r kill -9', { [PG('x')]: [CLAUDE_CLI] }],
  // macOS xargs: `-R replacements` and `-S replsize` each take a separate value (man xargs),
  // so the value is not the utility; without that `-R 2` would name a command `2`.
  ['match', 'pgrep x | xargs -R 2 -I{} kill {}', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs -S 512 -I{} kill {}', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs -I {} -R 2 -S 512 kill -9 {}', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs -R -1 -I{} sh -c "kill {}"', { [PG('x')]: [CLAUDE_CLI] }],
  ['allow', 'pgrep x | xargs -R 2 -I{} kill {}', { [PG('x')]: [VITEST] }],
  ['allow', 'pgrep x | xargs -S 512 -I{} kill {}', { [PG('x')]: [VITEST] }],
  ['unresolved', 'ls | xargs -R 2 -I{} kill {}'],
  ['match', 'pgrep x | xargs -I{} sh -c "kill -9 {}"', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'pgrep x | xargs bash -c "kill $0"', { [PG('x')]: [CLAUDE_CLI] }],
  ['match', "pgrep x | xargs eval 'kill -9'", { [PG('x')]: [CLAUDE_CLI] }],
  ['match', 'kill 1', { [PSQ('1')]: [LAUNCHD] }],
  ['match', 'kill 400', { [PSQ('400')]: [ZSH_ANCESTOR] }],
  ['match', 'kill 12345 700', { [PSQ('12345', '700')]: [VITEST, CLAUDE_CLI] }],
  ['match', `kill $(cat ${PIDFILE.claude})`, { [PSQ('700')]: [CLAUDE_CLI] }],
  // The guarded and grouped forms, and every command position, reach the same dry run.
  ['match', 'while pgrep -f cat; do pkill -f cat; done', { ...CAT_HIT }],
  ...[
    'pkill -f cat', '/usr/bin/pkill -f cat', 'sudo pkill -f cat', 'cd d && pkill -f cat', 'a;pkill -f cat',
    'timeout 5 pkill -f cat', 'bash -c "pkill -f cat"', "eval 'pkill -f cat'", 'pkill -f cat &',
    'bash -euo pipefail -c "pkill -f cat"', 'bash -eo pipefail -c "pkill -f cat"', 'bash -O extglob -c "pkill -f cat"',
    'bash -xc "pkill -f cat"', 'zsh -o errexit -c "pkill -f cat"',
    'cat <<X && pkill -f cat\nbody\nX', 'cat <<X\n$(pkill -f cat)\nX', 'echo $(pkill -f cat)', 'x=$(pkill -f cat)',
    'x=`pkill -f cat`', 'cat <(pkill -f cat)',
    '(pkill -f cat)', '{ pkill -f cat; }', 'if x; then pkill -f cat; fi', 'for p in 1; do pkill -f cat; done', '! pkill -f cat',
    '\\pkill -f cat', 'pk\\ill -f cat', 'pkill "-f" cat', "pkill -f $'cat'", 'pkill -9 -f cat', 'pkill -TERM -f cat',
  ].map((cmd) => ['match', cmd, { ...CAT_HIT }]),
  ['match', 'pkill -x \\\n node', { [PG('-x', 'node')]: [CLAUDE_CLI] }],
  ['match', 'killall -9 \\\n node', { [PG('-a', '-x', '-U', UID, 'node')]: [CLAUDE_CLI] }],
  ['match', 'killall no\\de', { [PG('-a', '-x', '-U', UID, 'node')]: [CLAUDE_CLI] }],
  ['match', "killall $'node'", { [PG('-a', '-x', '-U', UID, 'node')]: [CLAUDE_CLI] }],

  // count: more than MAX_MATCHES processes, none protected.
  ['count', "pkill -x '.*'", { [PG('-x', '.*')]: plainRows(50) }],
  ['count', "killall -m 'node.*'", { [PG('-a', '-U', UID, 'node.*')]: plainRows(MAX_MATCHES + 1) }],
  ['count', 'kill $(pgrep -f worker)', { [PG('-f', 'worker')]: plainRows(MAX_MATCHES + 1) }],
  ['count', 'pkill -f ~', { [PG('-f', '/Homedirs/tester')]: plainRows(50) }],
  ['count', 'killall -u alice', { [PG('-a', '-U', 'alice')]: plainRows(12) }],
  ['count', 'kill 1001 1002 1003 1004 1005 1006 1007 1008 1009 1010 1011',
    { [PSQ('1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010', '1011')]: plainRows(11) }],

  // probe: the dry run could not be computed.
  ['probe', 'pkill -f cat', { [PG('-f', 'cat')]: { error: 'pgrep timed out' } }],
  ['probe', 'killall Simulator', {}],
  ['probe', 'pkill -f cat', () => { throw new Error('probe blew up'); }],
  ['probe', 'pkill -f cat', () => undefined],
  ['probe', 'pkill -f cat', () => ({ pids: 'not a list' })],
  ['probe', 'kill 12345', { [PSQ('12345')]: { error: 'ps: bad' } }],
  ['probe', 'kill $(lsof -ti :3000)', { [LS('-ti', ':3000')]: { error: 'lsof timed out' } }],
  ['probe', 'pkill -f cat', { [PG('-f', 'cat')]: [VITEST] }, { ancestors: { error: 'ancestor chain is deeper than 64' } }],
  ['probe', `kill $(cat ${MISSING_PIDFILE})`],
  ['probe', `kill $(cat ${PIDFILE.big})`],

  // allow: a dry run that hits nothing protected, and nothing large.
  ['allow', 'pkill -f test_gate_store_boundary', { [PG('-f', 'test_gate_store_boundary')]: [VITEST] }],
  ['allow', 'pkill -f "next start"', { [PG('-f', 'next start')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917"', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -9 -f "next start -p 3917"', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" 2>/dev/null', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" >/dev/null 2>&1', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" &', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill 2>/dev/null -f "next start -p 3917"', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" 2>/dev/null; ls 2>/dev/null', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" 2>/dev/null; echo 2 >x', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -9 \\\n -f "next start -p 3917"', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917" \\\n 2>/dev/null', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f /tmp/my\\ dir/server.js', { [PG('-f', '/tmp/my dir/server.js')]: [VITEST] }],
  ['allow', 'pkill -f next\\ start\\ -p\\ 3917', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "next start -p 3917"  # stop dev server', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -f "server.js:3000"', { [PG('-f', 'server.js:3000')]: [VITEST] }],
  ['allow', 'bash -c "pkill -f \\"next start -p 3917\\""', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'bash -xc "pkill -f \\"next start -p 3917\\""', { [PG('-f', 'next start -p 3917')]: [VITEST] }],
  ['allow', 'pkill -F /tmp/x.pid', { [PG('-F', '/tmp/x.pid')]: [VITEST] }],
  ['allow', 'pkill -F /tmp/x.pid 2>/dev/null', { [PG('-F', '/tmp/x.pid')]: [VITEST] }],
  ['allow', 'pkill -x Simulator', { [PG('-x', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'pkill -x Simulator', { [PG('-x', 'Simulator')]: [] }],
  // pkill leaves its own ancestors out of the match set, as pgrep does (see pgrepView).
  ['allow', 'pkill -x zsh', { [PG('-x', 'zsh')]: [row(4500, 'zsh'), ZSH_ANCESTOR] }],
  ['allow', 'pkill -x claude', { [PG('-x', 'claude')]: [CLAUDE_SESSION] }],
  ['allow', 'sudo killall Simulator', { [PG('-a', '-x', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'sudo killall -u alice Simulator', { [PG('-a', '-x', '-U', 'alice', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'pkill -f ~/proj/server.js', { [PG('-f', '/Homedirs/tester/proj/server.js')]: [VITEST] }],
  ['allow', 'pkill -f "$HOME/proj/server.js"', { [PG('-f', '/Homedirs/tester/proj/server.js')]: [VITEST] }],
  ['allow', 'pkill -f a~b', { [PG('-f', 'a~b')]: [VITEST] }],
  ['allow', 'kill $(pgrep -f x -l)', { [PG('-f', 'x', '-l')]: [VITEST] }],
  ['allow', 'pkill -f test_gate_store_boundary', { [PG('-f', 'test_gate_store_boundary')]: plainRows(MAX_MATCHES) }],
  ['allow', 'pkill -u $USER -x Simulator', { [PG('-u', 'tester', '-x', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'pkill -U $UID -x Simulator', { [PG('-U', UID, '-x', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'pkill -U ${UID} -f "$HOME/proj/server.js"', { [PG('-U', UID, '-f', '/Homedirs/tester/proj/server.js')]: [VITEST] }],
  ['allow', 'killall Simulator', { [PG('-a', '-x', '-U', UID, 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'killall -9 Simulator', { [PG('-a', '-x', '-U', UID, 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'killall -u $USER Simulator', { [PG('-a', '-x', '-U', 'tester', 'Simulator')]: [row(6001, 'Simulator')] }],
  ['allow', 'killall zzqq-no-such-proc', { [PG('-a', '-x', '-U', UID, 'zzqq-no-such-proc')]: [] }],
  ['allow', 'kill 12345', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'kill -9 12345', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'kill -s TERM 12345', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'kill -- 12345', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'kill 12345  # was -1 before', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'kill 99999', { [PSQ('99999')]: [] }],
  ['allow', 'kill $(lsof -ti :3000)', { [LS('-ti', ':3000')]: [row(3000, 'node server.js --port 3000')] }],
  ['allow', 'kill $(lsof -ti :3000)', { [LS('-ti', ':3000')]: [] }],
  ['allow', 'kill $(pgrep -f x)', { [PG('-f', 'x')]: [VITEST] }],
  ['allow', 'kill `pgrep x`', { [PG('x')]: [VITEST] }],
  ['allow', 'kill -9 "$(pgrep -f x)"', { [PG('-f', 'x')]: [VITEST] }],
  ['allow', 'pgrep x | xargs kill', { [PG('x')]: [VITEST] }],
  ['allow', 'pgrep x | xargs -r kill -9', { [PG('x')]: [VITEST] }],
  ['allow', 'pgrep x | xargs -I{} sh -c "kill -9 {}"', { [PG('x')]: [VITEST] }],
  ['allow', `kill $(cat ${PIDFILE.plain})`, { [PSQ('3001')]: [VITEST] }],
  ['allow', `kill $(cat ${PIDFILE.empty})`, {}],
  ['allow', 'lsof -ti :3000 | xargs kill', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', 'sudo kill -9 $(lsof -ti :3000)', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', 'sudo kill $(pgrep -f b)', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'lsof -ti :3000 | xargs sudo kill', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', 'lsof -ti :3000 | sudo xargs kill', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', 'lsof -ti :3000 | xargs sudo sh -c "kill $0"', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', `kill $(cat ${PIDFILE.plain})`, { [PSQ('3001')]: HARMLESS }],
  ['allow', 'kill $(cat server.pid)', { [PSQ('3001')]: HARMLESS }],
  ['allow', 'kill $(cat ./server.pid)', { [PSQ('3001')]: HARMLESS }],
  ['allow', 'pkill -F server.pid', { [PG('-F', SERVER_PID_ABS)]: HARMLESS }],
  ['allow', 'kill $(pgrep -F server.pid)', { [PG('-F', SERVER_PID_ABS)]: HARMLESS }],
  ['allow', 'cat server.pid | xargs kill', { [PSQ('3001')]: HARMLESS }],
  ['allow', 'kill $(cat server.pid); cd DIR', { [PSQ('3001')]: HARMLESS }],
  ['allow', `cd DIR && kill $(cat ${PIDFILE.plain})`, { [PSQ('3001')]: HARMLESS }],
  ['allow', `cd DIR && pkill -F ${PIDFILE.plain}`, { [PG('-F', PIDFILE.plain)]: HARMLESS }],
  ['allow', 'cd DIR && pgrep -f b | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'cd DIR && kill $(lsof -ti :3000)', { [LS('-ti', ':3000')]: HARMLESS }],
  ['allow', 'pgrep -f b | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  // A redirect that does not touch stdin on the group leaves the pipe in place.
  ['allow', 'pgrep -f b | (xargs kill) 2>/dev/null', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'pgrep -f b | { xargs kill; } >/dev/null 2>&1', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', '(pgrep -f b) | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', '((pgrep -f b)) | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'echo a; (pgrep -f b) | xargs kill', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'pgrep -f b | xargs -r kill -9 2>/dev/null', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'pgrep -f b | xargs sh -c "kill $0" 2>&1', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'bash -c "pgrep -f b | xargs kill"', { [PG('-f', 'b')]: HARMLESS }],
  ['allow', 'bash -c "kill $(lsof -ti :3000)"', { [LS('-ti', ':3000')]: HARMLESS }],

  // allow: nothing here reaches a probe (kill and prose, other shells' words, data).
  ...[
    'kill $PID', 'kill %1', 'kill -TERM $pid', 'kill -9 "$PID"', 'pgrep -f x', 'ps -ax',
    'grep pkill notes.md', 'echo "pkill x"', 'git commit -m "block pkill -f cat"',
    'command -v pkill', 'echo "unterminated',
    "echo '$(pkill -f cat)'",
    "git commit -F - <<'EOF'\nblock pkill -f cat\nEOF",
    "cat <<\\EOF\ndon't run pkill -f cat\nEOF",
    'bash -euo pipefail -c "echo ok"', 'bash -O extglob -c "echo ok"', 'pgrep x | xargs -I{} sh -c "echo {}"',
    'killall', 'killall -l', 'killall -s Finder', 'killall -d Finder', 'killall -9', 'killall -m',
    'ls', 'echo hello',
  ].map((cmd) => ['allow', cmd]),

  // Signal 0 sends nothing (it only checks that the pid exists and may be signalled), so
  // `kill -0` is allowed whatever its target, without a query. `man kill` lists
  // `-signal_number` as "a non-negative decimal integer"; `-0`, `-00`, `-s 0`, `-n 0` all
  // read as 0. No signal NAME means 0 to /bin/kill or bash (`kill -l` lists none), and
  // zsh's name for slot 0, EXIT, "is not known to the operating system" (man zshparam),
  // so no name is accepted.
  ...[
    'kill -0 123', 'kill -00 123', 'kill -s 0 123', 'kill -n 0 123', 'kill -s 00 123',
    'kill -0 $PID', 'kill -0 $(pgrep -f x | head -1)', 'kill -0 `pgrep -f x | head -1`',
    'pgrep x | xargs kill -0', 'kill -0 123 && echo up', 'bash -c "kill -0 123"', 'sudo kill -0 123',
    'kill -0 1 400 700', 'while kill -0 123; do sleep 1; done',
  ].map((cmd) => ['allow', cmd]),
  // Only signal 0, and only when it is the sole option word, is exempt. Apple's bash 3.2
  // `kill` keeps re-reading `-s`/`-n` and `-SIGNAL` words until the first target, so a later
  // signal word replaces the 0: any word that starts with `-` after the signal, up to the
  // first target, takes the command out of the exemption (a `--` too, since how zsh and
  // /bin/kill read it after a signal is not known). Such a command is judged as before.
  ['group', 'kill -0 -s 9 -1'],
  ['group', 'kill -s 0 -9 -1'],
  ['group', 'kill -0 -9 -1'],
  ['group', 'kill -0 -1'],
  ['group', 'kill -0 -- -1'],
  ['group', "sh -c 'kill -s 0 -9 -1'"],
  ['match', 'kill -s 0 -s 9 1', { [PSQ('1')]: [LAUNCHD] }],
  ['match', 'kill -0 -s 9 1', { [PSQ('1')]: [LAUNCHD] }],
  ['match', "bash -c 'kill -0 -s KILL 1'", { [PSQ('1')]: [LAUNCHD] }],
  ['match', 'kill -n 0 -n 9 1', { [PSQ('1')]: [LAUNCHD] }],
  ['match', 'kill -0 -- 1', { [PSQ('1')]: [LAUNCHD] }],
  ['group', 'kill -0 -TERM 1'],
  ['allow', 'kill -0 -- 123', { [PSQ('123')]: [VITEST] }],
  // The shell expands words before kill reads its options, and bash 3.2 keeps reading `-s N` up
  // to the first target, so a word that can expand to an option word defeats the exemption.
  // Signal 0 exempts the command only when every word after the signal is plain digits, a
  // `%job`, a simple `$NAME`/`${NAME}`, or one substitution of a read-only pid producer
  // (`pgrep`, `lsof -t`, `cat FILE`, optionally piped to `head`/`tail`). Anything else is
  // judged as for any other signal.
  ['unresolved', "sh -c 'kill -0 {-s,9} -1'"],
  ['unresolved', 'kill -0 {-s,9} 1'],
  ['group', "bash -c 'kill -0 $(echo -s 9) -1'"],
  // (the literal pid is looked up first, so the fixture answers it; the substitution then fails)
  ['unresolved', "bash -c 'kill -0 $(echo -s 9) 1'", { [PSQ('1')]: [VITEST] }],
  ['group', "bash -c 'kill -0 `printf -- -s` 9 -1'"],
  ['unresolved', "bash -c 'kill -0 `printf -- -s` 9'", { [PSQ('9')]: [VITEST] }],
  ['group', "bash -c 'kill -0 ${X:--s} 9 -1'"],
  ['group', "bash -c 'A=(-s 9); kill -0 \"${A[@]}\" -1'"],
  ['group', 'kill -0 $* -1'],
  ['unresolved', "printf '%s\\n' -s 9 -1 | xargs bash -c 'kill -0 \"$@\"' _"],
  ['unresolved', 'kill -0 *'],
  ['unresolved', 'kill -0 {} 1'],
  ['unresolved', 'find . -exec kill -0 {} \\;'],
  ['unresolved', 'kill -0 $(echo 1)'],
  ['unresolved', 'kill -0 $(pgrep -lf x)'],
  ['unresolved', 'kill -0 $(pgrep x | sort)'],
  ['unresolved', 'kill -0 $(cat a b)'],
  ['unresolved', 'kill -0 $(pgrep x)$(pgrep y)'],
  ['unresolved', 'kill -0 $(pgrep x; echo -s)'],
  ['unresolved', 'kill -0 $(pgrep x | head -1 | tail -1)'],
  // The accepted gap (plan Decision 10, accidents not evasion): option words smuggled through
  // a plain variable or a pid file are not seen. `S="-s 9 -1"; kill -0 $S` really runs
  // `kill -0 -s 9 -1` and is allowed. Pinned so that a later change is deliberate.
  ['allow', "bash -c 'S=\"-s 9 -1\"; kill -0 $S'"],
  // A literal -1 after it is still a group target.
  ['group', "bash -c 'S=\"-s 9\"; kill -0 $S -1'"],
  // The common forms stay allowed with no query.
  ...[
    'kill -0 $PID', 'kill -0 "$PID"', 'kill -0 ${PID}', 'kill -0 "${PID}"', 'kill -0 $(pgrep -f x | head -1)',
    'kill -0 $(cat x.pid)', 'kill -0 $(cat x.pid | head -1)', 'kill -0 `pgrep -f x | tail -1`', 'kill -0 $(lsof -ti :3000)',
    'kill -0 %1', 'kill -0 %%', 'kill -0 %+', 'kill -0 $A $B', 'kill -0 123 456',
    'while kill -0 1234 2>/dev/null; do sleep 1; done', 'kill -s 0 $PID', 'kill -0 "$@"',
  ].map((cmd) => ['allow', cmd]),
  // `kill -l` lists signal names and sends nothing: bash 3.2 lists whenever `-l` appears, zsh
  // returns after it and /bin/kill exits.
  ...['kill -l', 'kill -l TERM', 'kill -l 9', 'kill -l -9 -1', 'kill -l 1 2 3', "bash -c 'kill -l TERM'", 'echo up | kill -l 15'].map((cmd) => ['allow', cmd]),
  // `-L` does not list in bash 3.2: it is read as an unknown signal word, which a later
  // `-s`/`-n` overwrites, so it is judged like any other word.
  ['group', 'kill -L -s 9 -1'],
  ['group', 'bash -c "kill -L -s 9 -1"'],
  ['group', 'sh -c "kill -L -n 9 -1"'],
  ['group', 'kill -L -s KILL 0'],
  ['group', 'kill -0 123; kill -9 -1'],
  ['group', 'kill -01 -1'],
  ['group', 'kill -s 01 -1'],
  ['group', 'kill -10 -1'],
  ['group', 'kill -s 10 -1'],
  ['unresolved', 'kill -1 $(pgrep -f x | head -1)'],
  ['unresolved', 'kill -s 1 $(pgrep -f x | head -1)'],
  ['match', 'kill -01 1', { [PSQ('1')]: [LAUNCHD] }],
  ['match', 'kill -EXIT 1', { [PSQ('1')]: [LAUNCHD] }],

  // A NAME (killall) or an -x pattern (pkill) that is itself a protected session-process
  // name is refused before any query: `killall` matches only the caller's uid, and
  // loginwindow's is not the user's, so the query finds nothing and the name would pass.
  // None of these lists a fixture answer, so reaching the probe fails the case.
  ...[
    'killall loginwindow', 'killall -9 WindowServer', 'killall Finder', 'killall Dock',
    'killall SystemUIServer', 'killall ControlCenter', 'sudo killall loginwindow',
    'killall Simulator Finder', 'killall -c Dock', 'killall -u alice loginwindow', 'killall -m Finder',
    'killall -e -u alice Dock', 'killall -t ttys001 WindowServer', 'bash -c "killall loginwindow"',
    'pkill -x loginwindow', 'pkill -9 -x WindowServer', 'pkill -x -U 501 loginwindow', 'pkill -xU 501 Dock',
    'pkill -qx Finder', 'pkill -x -- Dock', 'pkill -fx SystemUIServer', 'pkill -x ControlCenter &',
    'while pgrep -x Dock; do pkill -x Dock; done', 'pkill -x Simulator Finder',
  ].map((cmd) => ['match', cmd]),
  // Not a protected name, or not a command that signals: the query decides, or there is none.
  ['allow', 'killall "Finder Helper"', { [PG('-a', '-x', '-U', UID, 'Finder Helper')]: [] }],
  ['allow', 'killall FinderX', { [PG('-a', '-x', '-U', UID, 'FinderX')]: [] }],
  ['allow', 'pkill -x docker', { [PG('-x', 'docker')]: [] }],
  ['allow', 'pkill -x dock', { [PG('-x', 'dock')]: [] }],
  ['allow', 'pkill -f Dock', { [PG('-f', 'Dock')]: [] }],
  ['allow', 'killall -s Finder'],
  ['allow', 'killall -d loginwindow'],
  ['allow', 'killall -l Dock'],
  ['allow', 'pgrep -x loginwindow'],

  // Under -e the uid filter is the effective uid (loginwindow runs with euid 501 and real
  // uid 0), so the query must say so; with -m the NAMEs are regexes, and one that matches a
  // protected name is refused from the text (a single dot matches every process of the user).
  ['match', 'killall -e -m "clau.*"', { [PG('-a', '-u', UID, 'clau.*')]: [CLAUDE_CLI] }],
  ['match', 'killall -e "Claude Helper (Renderer)"', { [PG('-a', '-x', '-u', UID, 'Claude Helper \\(Renderer\\)')]: [RENDERER] }],
  ...[
    'killall -e -m loginwindo.', 'killall -m "Finde."', 'killall -m .', "killall -m '^Dock'", 'killall -m "System.*Server"',
    'killall -m Window.*', 'killall -m xyzzy "Contr.lCenter"', 'sudo killall -m "log.nwindow"', 'killall -u alice -m loginwindo.',
  ].map((cmd) => ['match', cmd]),
  // Not a match for any protected name, and not an invalid pattern the gate would trip over.
  ['allow', 'killall -m "xyzzy.*"', { [PG('-a', '-U', UID, 'xyzzy.*')]: [] }],
  ['allow', 'killall -m "Finder.Helper"', { [PG('-a', '-U', UID, 'Finder.Helper')]: [] }],
  ['allow', 'killall -m "["', { [PG('-a', '-U', UID, '[')]: [] }],

  // The shell reads `00` as 0: every all-zero spelling of the pid is group 0 (the caller's
  // whole process group), and a number that merely holds a zero is a pid.
  ...['kill -9 00', 'kill 000', 'kill -s TERM 00', 'kill -- 00', 'kill 12345 00', 'pgrep x | xargs kill -9 00',
    'kill -9 +0'].map((cmd) => ['group', cmd]),
  // find ends an exec clause at `;`, and at `+` only straight after `{}`: a `+` anywhere else
  // is an argument (here env's -u value), and the command after it still runs.
  ['group', 'find . -exec env -u + kill -9 -1 \\;'],
  ['match', 'find . -exec env -u + kill 1 \\;', { [PSQ('1')]: [LAUNCHD] }],
  ['group', 'find . -exec env -u + kill -9 -1 + -exec echo {} \\;'],
  // A literal target that is not a pid, a `$variable` or a `%job` is one the shell may read
  // in a way the gate does not (strtol and zsh accept a trailing `-`, a leading space and
  // the like), so it is refused rather than skipped.
  ...[
    'kill -9 0-', 'kill -9 4242-', 'kill -9 " -1"', 'kill -9 " 0"', 'kill 12abc', 'kill 4242 foo', 'kill -9 "1 2"',
    'kill -9 4242.', 'kill 4242 " -1"', 'bash -c "kill -9 0-"', 'kill -9 -- 0-',
  ].map((cmd) => ['unresolved', cmd]),
  ...['kill $PID $OTHER', 'kill %1 %2', 'kill ${PIDS[@]}', 'kill "$PID"', 'kill -9 $pid', 'kill %%'].map((cmd) => ['allow', cmd]),
  ['allow', 'kill 100', { [PSQ('100')]: [VITEST] }],
  ['allow', 'kill 10 1000', { [PSQ('10', '1000')]: [VITEST] }],

  // Command position: wrappers the shell runs a command through (`builtin`, `nice`,
  // `caffeinate`), the body `trap` runs later, and the command `find -exec` runs. Each
  // reaches the same dry run; where find supplies the target (`{}` or a `+` batch) the
  // gate cannot evaluate it and denies unresolved.
  ...[
    'builtin kill 1', 'nice kill 1', 'nice -n 5 kill 1', 'nice -5 kill 1', 'caffeinate kill 1',
    'caffeinate -i -t 60 kill 1', 'caffeinate -w 123 kill 1', 'nice -n 5 caffeinate -i kill 1',
    'builtin command kill 1',
    "trap 'kill 1' EXIT", 'trap "kill 1" EXIT INT', "trap -- 'kill 1' EXIT", "trap 'echo bye; kill 1' EXIT",
    'find . -name x -exec kill 1 \\;', 'find . -execdir kill 1 \\;', 'find . -ok kill 1 \\;',
    'find . -name x -exec echo hi \\; -exec kill 1 \\;',
  ].map((cmd) => ['match', cmd, { [PSQ('1')]: [LAUNCHD] }]),
  ...[
    'nice pkill -f cat', 'nice -n 5 pkill -f cat', 'nice -n -5 pkill -f cat', 'nice -5 pkill -f cat',
    'caffeinate pkill -f cat', 'caffeinate -i pkill -f cat', 'caffeinate -t 60 pkill -f cat',
    'caffeinate -w 123 -i pkill -f cat', 'nice caffeinate -i pkill -f cat', 'builtin pkill -f cat',
    "trap 'pkill -f cat' EXIT", 'trap "pkill -f cat" EXIT INT TERM', "trap -- 'pkill -f cat' EXIT",
    "trap 'cd /tmp && pkill -f cat' EXIT", "trap 'echo bye; pkill -f cat' 0",
    'find . -name x -exec pkill -f cat \\;', 'find . -execdir pkill -f cat \\;', 'find . -ok pkill -f cat \\;',
    'find . -exec echo hi \\; -exec pkill -f cat \\;', 'sudo find . -exec pkill -f cat \\;',
  ].map((cmd) => ['match', cmd, { ...CAT_HIT }]),
  ...[
    'builtin kill -9 -1', 'nice -n 5 kill -9 -1', 'caffeinate -i kill -9 -1', "trap 'kill -9 -1' EXIT",
    'find . -exec kill -9 -1 \\;',
  ].map((cmd) => ['group', cmd]),
  ...[
    "trap 'kill $(pgrep -f x | head -1)' EXIT", 'find . -name "*.pid" -exec kill {} \\;', 'find . -name "*.pid" -exec kill {} +',
    'find . -exec kill -9 {} \\;', 'find . -execdir kill {} \\;', 'find . -exec sh -c \'kill $0\' {} \\;',
    'find . -exec pkill -f {} \\;', 'find . -exec killall {} +', 'find . -exec pkill -f cat {} +',
    'nice -n 5 pkill -f $PATTERN', 'caffeinate -i killall $NAME',
  ].map((cmd) => ['unresolved', cmd]),
  // Not a kill, or a kill that signals nothing, or one whose target is judged clear.
  ...[
    "trap 'rm -f x' EXIT", 'trap - EXIT', 'trap -p', 'trap -l', 'trap', "trap 'kill $PID' EXIT", "trap 'kill -0 1' EXIT",
    'nice -n 5 make', 'caffeinate -i -t 60 sleep 1', 'builtin echo hi', 'builtin cd /tmp',
    'find . -name x -exec echo {} \\;', 'find . -name x -exec rm {} +',
    "find . -exec grep -l 'pkill' {} \\;", 'find . -name pkill', 'find . -name kill -print',
  ].map((cmd) => ['allow', cmd]),
  ['allow', 'nice -n 5 pkill -f test_gate_store_boundary', { [PG('-f', 'test_gate_store_boundary')]: [VITEST] }],
  ['allow', 'caffeinate -i pkill -f test_gate_store_boundary', { [PG('-f', 'test_gate_store_boundary')]: [VITEST] }],
  ['allow', "trap 'pkill -f test_gate_store_boundary' EXIT", { [PG('-f', 'test_gate_store_boundary')]: [VITEST] }],
  ['allow', 'find . -exec pkill -f test_gate_store_boundary \\;', { [PG('-f', 'test_gate_store_boundary')]: [VITEST] }],
  ['allow', 'find . -exec kill 12345 \\;', { [PSQ('12345')]: [VITEST] }],
  ['allow', 'builtin kill 12345', { [PSQ('12345')]: [VITEST] }],

  // The lexer is quadratic in the depth of `$(` nesting, so a kill-word command nested past
  // MAX_NESTING is refused before it is lexed; at the bound it is still read as before.
  ['parse', nestedSubst(MAX_NESTING + 1, 'kill -9 -1')],
  ['parse', nestedSubst(3000, 'kill -9 -1')],
  ['parse', nestedSubst(3000, 'pkill -f x')],
  ['parse', nestedGroup(3000, 'kill -9 -1')],
  ['parse', `echo ok; ${nestedSubst(MAX_NESTING + 1, 'echo hi')}; kill $PID`],
  ['group', nestedSubst(MAX_NESTING, 'kill -9 -1')],
  ['group', nestedGroup(10, 'kill -9 -1')],
  ['allow', nestedSubst(MAX_NESTING, 'kill $PID')],
  // No kill-family word anywhere: nothing to deny, so nothing to lex.
  ['allow', nestedSubst(3000, 'echo hi')],
];

// The exact argv the gate builds. Every query answers with one plain process, so each
// command is allowed and the recorded calls are the argv table.
const ONE = [VITEST];
const ARGV = [
  // pkill: the same words as pgrep minus a leading signal, -I, -l, -q and -d DELIM.
  ['pkill -f "next start"', [PG('-f', 'next start')]],
  ['pkill -9 -f "next start"', [PG('-f', 'next start')]],
  ['pkill -TERM -f foo', [PG('-f', 'foo')]],
  ['pkill -SIGKILL -f foo', [PG('-f', 'foo')]],
  ['pkill -USR1 -f foo', [PG('-f', 'foo')]],
  ['pkill -qx Simulator', [PG('-x', 'Simulator')]],
  ['pkill -q -x Simulator', [PG('-x', 'Simulator')]],
  ['pkill -lqf foo', [PG('-f', 'foo')]],
  ['pkill -xl foo', [PG('-x', 'foo')]],
  ['pkill -I -f foo', [PG('-f', 'foo')]],
  ['pkill -d , -f foo', [PG('-f', 'foo')]],
  ['pkill -fd, foo', [PG('-f', 'foo')]],
  ['pkill -U 501 -x Simulator', [PG('-U', '501', '-x', 'Simulator')]],
  ['pkill -U501 -x Simulator', [PG('-U', '501', '-x', 'Simulator')]],
  ['pkill -xU 501 Simulator', [PG('-xU', '501', 'Simulator')]],
  ['pkill -f foo -l', [PG('-f', 'foo', '-l')]],
  ['pkill -f "next start -p 3917" -x', [PG('-f', 'next start -p 3917', '-x')]],
  ['pkill -- -weird', [PG('--', '-weird')]],
  ['sudo pkill -f foo', [PG('-f', 'foo')]],
  // A leading ~ or ~/ is the hook's $HOME, quoted or not; a ~ elsewhere in a word is literal.
  ['pkill -f ~/proj', [PG('-f', '/Homedirs/tester/proj')]],
  ['pkill -f ~', [PG('-f', '/Homedirs/tester')]],
  ['pkill -f "~/proj"', [PG('-f', '/Homedirs/tester/proj')]],
  ['pkill -f a~b', [PG('-f', 'a~b')]],
  ['pkill -f /x/~', [PG('-f', '/x/~')]],
  ['pkill -F /tmp/x.pid', [PG('-F', '/tmp/x.pid')]],
  // killall: a NAME is a literal (ERE-escaped, exact) limited to the caller's uid; every query
  // carries -a because killall, unlike pgrep, does not leave the caller's ancestors alone.
  ['killall Simulator', [PG('-a', '-x', '-U', UID, 'Simulator')]],
  // Under sudo (or doas) there is no implicit uid filter; an explicit -u stays.
  ['sudo killall Simulator', [PG('-a', '-x', 'Simulator')]],
  ['sudo -u root killall Simulator', [PG('-a', '-x', 'Simulator')]],
  ['doas killall Simulator', [PG('-a', '-x', 'Simulator')]],
  ['sudo killall -u alice Simulator', [PG('-a', '-x', '-U', 'alice', 'Simulator')]],
  ['sudo killall -t ttys001 Simulator', [PG('-a', '-x', '-t', 'ttys001', 'Simulator')]],
  ['killall -9 Simulator', [PG('-a', '-x', '-U', UID, 'Simulator')]],
  ['killall -v -q -z Simulator', [PG('-a', '-x', '-U', UID, 'Simulator')]],
  ['killall "Claude Helper (Renderer)"', [PG('-a', '-x', '-U', UID, 'Claude Helper \\(Renderer\\)')]],
  ['killall "a.b*c+d?e"', [PG('-a', '-x', '-U', UID, 'a\\.b\\*c\\+d\\?e')]],
  ['killall Simulator "Some App"', [PG('-a', '-x', '-U', UID, 'Simulator'), PG('-a', '-x', '-U', UID, 'Some App')]],
  ['killall -c Simulator', [PG('-a', '-x', '-U', UID, 'Simulator')]],
  ['killall -u alice Simulator', [PG('-a', '-x', '-U', 'alice', 'Simulator')]],
  ['killall -ualice Simulator', [PG('-a', '-x', '-U', 'alice', 'Simulator')]],
  ['killall -e -u alice Simulator', [PG('-a', '-x', '-u', 'alice', 'Simulator')]],
  ['killall -t ttys001 Simulator', [PG('-a', '-x', '-U', UID, '-t', 'ttys001', 'Simulator')]],
  ['killall -u alice', [PG('-a', '-U', 'alice')]],
  ['killall -e -u alice', [PG('-a', '-u', 'alice')]],
  ['killall -t ttys001', [PG('-a', '-t', 'ttys001')]],
  ['killall -u alice -t ttys001', [PG('-a', '-U', 'alice', '-t', 'ttys001')]],
  ['killall Simulator -9', [PG('-a', '-x', '-U', UID, 'Simulator'), PG('-a', '-x', '-U', UID, '--', '-9')]],
  // -m is a bare flag (plan defect D1): every NAME becomes an unescaped pattern, no -x.
  ['killall -m "node.*"', [PG('-a', '-U', UID, 'node.*')]],
  ['killall -m a.b zz', [PG('-a', '-U', UID, 'a.b'), PG('-a', '-U', UID, 'zz')]],
  // -e makes killall match by effective uid, the default uid included, so the query is
  // pgrep -u (effective), not -U (real).
  ['killall -e Simulator', [PG('-a', '-x', '-u', UID, 'Simulator')]],
  ['killall -e -m "node.*"', [PG('-a', '-u', UID, 'node.*')]],
  ['killall -e -t ttys001 Simulator', [PG('-a', '-x', '-u', UID, '-t', 'ttys001', 'Simulator')]],
  ['killall -m -u alice "a.b"', [PG('-a', '-U', 'alice', 'a.b')]],
  // kill: literal pids are looked up with ps; a producer is run as written.
  ['kill 123', [PSQ('123')]],
  ['kill -9 1 2', [PSQ('1', '2')]],
  ['kill $(lsof -ti :3000)', [LS('-ti', ':3000')]],
  ['kill $(lsof -t -i tcp:3000)', [LS('-t', '-i', 'tcp:3000')]],
  ['kill $(pgrep -f x)', [PG('-f', 'x')]],
  ['kill 123 $(pgrep -f x)', [PSQ('123'), PG('-f', 'x')]],
  ['pgrep -f x | xargs kill', [PG('-f', 'x')]],
  [`kill $(cat ${PIDFILE.plain})`, [PSQ('3001')]],
  // A relative path is resolved against the hook input's cwd before it is queried (the
  // probe runs in the hook's own directory); an absolute path or ~/ is left alone.
  ['kill $(cat server.pid)', [PSQ('3001')]],
  ['pkill -F server.pid', [PG('-F', SERVER_PID_ABS)]],
  ['pkill -xF server.pid Simulator', [PG('-xF', SERVER_PID_ABS, 'Simulator')]],
  ['pkill -Fserver.pid', [PG('-F', SERVER_PID_ABS)]],
  ['pkill -F ../work/server.pid', [PG('-F', SERVER_PID_ABS)]],
  ['pkill -F ~/x.pid', [PG('-F', '/Homedirs/tester/x.pid')]],
  ['kill $(pgrep -F server.pid)', [PG('-F', SERVER_PID_ABS)]],
  ['kill $(lsof -t server.sock)', [LS('-t', path.join(WORKDIR, 'server.sock'))]],
  ['kill $(lsof -t /var/x.sock)', [LS('-t', '/var/x.sock')]],
  ['kill $(lsof -t +D logs)', [LS('-t', '+D', path.join(WORKDIR, 'logs'))]],
  ['kill $(lsof -t +Dlogs)', [LS('-t', `+D${path.join(WORKDIR, 'logs')}`)]],
  ['kill $(lsof -t -- server.sock)', [LS('-t', '--', path.join(WORKDIR, 'server.sock'))]],
  ['kill $(lsof -t -c node server.sock)', [LS('-t', '-c', 'node', path.join(WORKDIR, 'server.sock'))]],
  ['kill $(lsof -ti tcp:3000 -a -p 12)', [LS('-ti', 'tcp:3000', '-a', '-p', '12')]],
  ['kill $(lsof -t -i :3000 server.sock)', [LS('-t', '-i', ':3000', path.join(WORKDIR, 'server.sock'))]],
  // Nothing to ask: no probe at all.
  ['killall', []],
  ['killall -l', []],
  ['killall -s Finder', []],
  ['kill $PID', []],
];

// Real pgrep (and pkill) leave the calling process and all of its ancestors out of the
// match list unless -a is given (measured: the session running the hook is missing from
// `pgrep -x claude` and present in `pgrep -a -x claude`). killall does not hide them. A
// fixture that returned an ancestor for a query without -a would model a pgrep that does
// not exist, so the fixture drops the ancestors the way the tool does.
const pgrepView = (bin, args, rows) => {
  if (bin !== '/usr/bin/pgrep') return rows;
  const dashDash = args.indexOf('--');
  const options = dashDash < 0 ? args : args.slice(0, dashDash);
  if (options.some((a) => /^-[A-Za-z]*a/.test(a))) return rows;
  return rows.filter((r) => !ANCESTORS.includes(r.pid));
};

// One case through `decide`. Returns what a reader of the verdict needs.
function runCase(decide, cmd, answers, extra = {}) {
  const calls = [];
  let ancestorCalls = 0;
  const probe = (bin, args) => {
    calls.push([bin, ...args]);
    if (typeof answers === 'function') return answers(bin, args);
    const hit = (answers || {})[K(bin, ...args)];
    if (hit === undefined) return { error: `fixture has no answer for ${K(bin, ...args)}` };
    return Array.isArray(hit) ? { pids: pgrepView(bin, args, hit) } : hit;
  };
  const ancestors = () => { ancestorCalls++; return extra.ancestors || ANCESTORS; };
  const d = decide(cmd, 'darwin', { probe, ancestors, cwd: extra.cwd || WORKDIR });
  return { d: d && plain(d), calls: plain(calls), ancestorCalls };
}

const label = (cmd) => JSON.stringify(cmd).slice(0, 90);

// The allowed rewrite each rule's reason must name, as a keyword the reader can act on:
// match/count -> a narrower pattern, `pkill -F pidfile` or a literal pid; group -> literal
// pids; unresolved -> resolve to literal pids first; probe -> retry or literal pids; parse
// -> a simpler command; crash -> the same. MAX_REASON is the whole-reason cap.
const REWRITE = {
  match: /narrower[^]*pgrep[^]*pkill -F[^]*literal pid/,
  count: /narrower[^]*pgrep[^]*pkill -F[^]*literal pid/,
  group: /literal pids instead/,
  unresolved: /literal pids first[^]*pgrep -lf[^]*kill <pid>/,
  probe: /retry[^]*literal pids/,
  parse: /rewrite it more simply/,
  crash: /rewrite it more simply/,
};
const MAX_REASON = 4096;

// The whole table through one decide(): decisions and rules, the probe reached or not,
// the argv table, the reason's content, and the platform gate.
function runTable(tag, decide) {
  for (const [want, cmd, answers, extra] of CASES) {
    check(`${tag}: ${want} ${label(cmd)}`, () => {
      const { d, calls, ancestorCalls } = runCase(decide, cmd, answers, extra);
      if (want === 'allow') {
        assert.equal(d, null, JSON.stringify(d));
      } else {
        assert.ok(d, 'allowed');
        assert.equal(d.rule, want, `rule ${d.rule}: ${d.reason}`);
        assert.ok(new RegExp(`rule ${want}\\b`).test(d.reason), d.reason);
        assert.ok(REWRITE[want].test(d.reason), `rule ${want} does not name its rewrite: ${d.reason}`);
        assert.ok(d.reason.length <= MAX_REASON, `${d.reason.length} characters`);
      }
      if (answers === undefined) {
        assert.deepEqual(calls, [], 'a case with no fixture answers reached the probe');
        assert.equal(ancestorCalls, 0, 'the ancestor chain was read for a case that needs no dry run');
      }
    });
  }
  // A pid with no query result (an empty set) never needs the ancestor chain.
  // The same three reviewer cases against a fixture that behaves like the tools, not one
  // that answers a pinned argv: the gate must be denied for the reason the real tool would
  // return the process, and allowed only if the real tool would hide it.
  check(`${tag}: killall of the calling session's name is denied (pgrep hides ancestors, killall does not)`, () => {
    const model = (bin, args) => ({ pids: pgrepView(bin, args, [CLAUDE_SESSION]) });
    for (const cmd of ['killall claude', 'killall zsh', 'killall -m "cla.*"']) {
      const r = runCase(decide, cmd, model);
      assert.equal(r.d && r.d.rule, 'match', `${cmd}: ${JSON.stringify(r.d)}`);
    }
    assert.equal(runCase(decide, 'pkill -x claude', model).d, null, 'pkill excludes its ancestors itself');
  });
  check(`${tag}: sudo killall reaches processes of every user, not only the caller's`, () => {
    // The process is owned by _windowserver, so a query limited to the caller's uid is empty.
    // Its name is not a protected one (those are refused before any query), so the query decides.
    const model = (bin, args) => ({ pids: args.includes('-U') && !args.includes(WINDOWSERVER_OWNER) ? [] : [WINDOWSERVER] });
    assert.equal(runCase(decide, 'sudo killall wsdaemon', model).d.rule, 'match');
    assert.equal(runCase(decide, 'killall wsdaemon', model).d, null, 'without sudo the uid filter applies');
  });
  check(`${tag}: a leading ~ is expanded before the query, quoted or not`, () => {
    const model = (bin, args) => ({ pids: args.includes('/Homedirs/tester/.vscode') ? [VSCODE_CLAUDE] : [] });
    for (const cmd of ['pkill -f ~/.vscode', 'pkill -f "~/.vscode"', "pkill -f '~/.vscode'"]) {
      assert.equal(runCase(decide, cmd, model).d.rule, 'match', cmd);
    }
  });
  check(`${tag}: a pgrep that prints more than pids feeds kill words it cannot check`, () => {
    // `pgrep -lf "next dev -p 3917"` prints "4001 node next dev -p 3917": kill gets 4001, node, next, dev, -p, 3917.
    const model = () => ({ pids: [VITEST] });
    for (const cmd of ['kill $(pgrep -lf "next dev -p 3917")', 'kill $(pgrep -d, x)', 'kill $(pgrep -q x)']) {
      const r = runCase(decide, cmd, model);
      assert.equal(r.d && r.d.rule, 'unresolved', cmd);
      assert.deepEqual(r.calls, [], `${cmd}: the producer must not be run`);
    }
  });
  check(`${tag}: a producer the gate would run in the wrong place is refused before any query`, () => {
    for (const [cmd, answers] of SOURCE_DENY) {
      const { d, calls, ancestorCalls } = runCase(decide, cmd, answers);
      assert.equal(d && d.rule, 'unresolved', `${label(cmd)}: ${JSON.stringify(d)}`);
      assert.deepEqual(calls, [], `${label(cmd)} ran ${JSON.stringify(calls)}`);
      assert.equal(ancestorCalls, 0, `${label(cmd)} read the ancestor chain`);
    }
  });
  check(`${tag}: a relative path is read from the hook input's cwd`, () => {
    // The same command, two directories: server.pid holds a harmless pid in one and the
    // Claude CLI's in the other.
    const answers = { [PSQ('3001')]: [VITEST], [PSQ('700')]: [CLAUDE_CLI] };
    assert.equal(runCase(decide, 'kill $(cat server.pid)', answers, { cwd: WORKDIR }).d, null);
    assert.equal(runCase(decide, 'kill $(cat server.pid)', answers, { cwd: OTHER_DIR }).d.rule, 'match');
    assert.equal(runCase(decide, 'cat server.pid | xargs kill', answers, { cwd: OTHER_DIR }).d.rule, 'match');
    const pg = { [PG('-F', path.join(OTHER_DIR, 'server.pid'))]: [CLAUDE_CLI] };
    assert.equal(runCase(decide, 'pkill -F server.pid', pg, { cwd: OTHER_DIR }).d.rule, 'match');
  });
  check(`${tag}: a relative path after a cd is refused, whatever directory the input names`, () => {
    for (const cwd of [WORKDIR, OTHER_DIR]) {
      const r = runCase(decide, 'cd sub && kill $(cat server.pid)', { [PSQ('3001')]: [VITEST], [PSQ('700')]: [VITEST] }, { cwd });
      assert.equal(r.d && r.d.rule, 'unresolved');
      assert.deepEqual(r.calls, []);
    }
  });
  check(`${tag}: an empty match set does not read the ancestor chain`, () => {
    const { d, ancestorCalls } = runCase(decide, 'pkill -x Simulator', { [PG('-x', 'Simulator')]: [] });
    assert.equal(d, null);
    assert.equal(ancestorCalls, 0);
  });
  check(`${tag}: the ancestor chain is read once for a multi-query command`, () => {
    const { d, ancestorCalls } = runCase(decide, 'killall A B', {
      [PG('-a', '-x', '-U', UID, 'A')]: [VITEST], [PG('-a', '-x', '-U', UID, 'B')]: [row(3002, 'node b.js')],
    });
    assert.equal(d, null);
    assert.equal(ancestorCalls, 1);
  });
  for (const [cmd, expected] of ARGV) {
    check(`${tag}: argv ${label(cmd)}`, () => {
      const { d, calls } = runCase(decide, cmd, () => ({ pids: ONE }));
      assert.equal(d, null, JSON.stringify(d));
      assert.deepEqual(calls, expected.map((k) => JSON.parse(k)));
    });
  }
  check(`${tag}: a pid file is read with ps for its pids, in the file's order`, () => {
    const many = path.join(CONFIG, 'many.pid');
    fs.writeFileSync(many, '3002 3001\n');
    FILES[many] = '3002 3001\n';
    const { d, calls } = runCase(decide, `kill $(cat ${many})`, () => ({ pids: ONE }));
    assert.equal(d, null);
    assert.deepEqual(calls, [JSON.parse(PSQ('3002', '3001'))]);
  });
  check(`${tag}: a match denial lists the protected process first, with pid and command`, () => {
    const { d } = runCase(decide, 'pkill -f "serena start-mcp-server"',
      { [PG('-f', 'serena start-mcp-server')]: [SERENA, SERENA2, CLAUDE_CLI] });
    const lines = d.reason.split('\n').filter((l) => /^ {2}\d+ /.test(l));
    assert.equal(lines[0], `  ${CLAUDE_CLI.pid} ${CLAUDE_CLI.command}`);
    assert.equal(lines.length, 3);
  });
  check(`${tag}: a denial lists at most five pid command lines`, () => {
    const { d } = runCase(decide, "pkill -x '.*'", { [PG('-x', '.*')]: plainRows(50) });
    const lines = d.reason.split('\n').filter((l) => /^ {2}\d+ /.test(l));
    assert.equal(lines.length, 5);
    assert.ok(/5 of 50/.test(d.reason), d.reason);
  });
  check(`${tag}: a match names the ancestor when the hook's own chain is hit`, () => {
    const { d } = runCase(decide, 'kill 400', { [PSQ('400')]: [ZSH_ANCESTOR] });
    assert.ok(/ancestor/.test(d.reason), d.reason);
  });
  check(`${tag}: MAX_MATCHES is 10 and ten unprotected matches pass`, () => {
    const { d } = runCase(decide, 'pkill -f foo', { [PG('-f', 'foo')]: plainRows(10) });
    assert.equal(d, null);
    const over = runCase(decide, 'pkill -f foo', { [PG('-f', 'foo')]: plainRows(11) });
    assert.equal(over.d.rule, 'count');
  });
  check(`${tag}: a list of ancestors that is an array is passed to the classifier, not reread`, () => {
    const calls = [];
    const d = decide('kill 12345', 'darwin', {
      probe: (bin, args) => { calls.push([bin, ...args]); return { pids: [row(12345, 'node x.js')] }; },
      ancestors: [12345],
    });
    assert.equal(d && d.rule, 'match');
  });
  check(`${tag}: only darwin is governed`, () => {
    for (const [want, cmd] of CASES) {
      if (want === 'allow') continue;
      for (const platform of ['win32', 'linux']) {
        let touched = false;
        const r = decide(cmd, platform, { probe: () => { touched = true; return { pids: [] }; }, ancestors: [] });
        assert.equal(r, null, `${platform} denied ${label(cmd)}`);
        assert.equal(touched, false, `${platform} reached the probe`);
      }
    }
  });
  check(`${tag}: non-string and empty commands are allowed`, () => {
    for (const v of ['', undefined, null, 42]) assert.equal(decide(v, 'darwin', { probe: () => ({ error: 'no' }), ancestors: [] }), null);
  });
  check(`${tag}: a dry run without an injected probe is an error, not a silent allow`, () => {
    // The error is built inside the sandbox realm, so it is matched by name.
    const isTypeError = (e) => e.name === 'TypeError';
    assert.throws(() => decide('pkill -f foo', 'darwin', {}), isTypeError);
    assert.throws(() => decide('kill 12345', 'darwin', { probe: () => ({ pids: [VITEST] }) }), isTypeError);
  });
  check(`${tag}: a parse denial does not claim the quoting is wrong (it may be valid zsh)`, () => {
    const { d } = runCase(decide, 'pkill -f "unterminated', undefined);
    assert.equal(d.rule, 'parse');
    assert.ok(!/fix the quoting|quoting is wrong|bad quot/i.test(d.reason), d.reason);
    assert.ok(/valid/.test(d.reason), d.reason);
  });
  check(`${tag}: an operand of 200 KB is echoed at 200 characters and the reason stays under 4 KB`, () => {
    const big = 'x'.repeat(200 * 1024);
    for (const [cmd, rule] of [[`kill -9 -${big}`, 'group'], [`pkill -f $${big}`, 'unresolved'], [`killall -${big} A`, 'unresolved']]) {
      const { d } = runCase(decide, cmd, undefined);
      assert.equal(d.rule, rule, d.reason.slice(0, 200));
      assert.ok(d.reason.length <= MAX_REASON, `${rule}: ${d.reason.length} characters`);
      assert.ok(!d.reason.includes('x'.repeat(201)), `${rule}: an operand was echoed past 200 characters`);
    }
  });
  check(`${tag}: a command nested far past the bound is refused in well under a second`, () => {
    // Lexed, 6000 levels cost several seconds (the cost grows with the square of the depth).
    const started = Date.now();
    const { d } = runCase(decide, nestedSubst(6000, 'kill -9 -1'), undefined);
    const ms = Date.now() - started;
    assert.equal(d && d.rule, 'parse', JSON.stringify(d).slice(0, 200));
    assert.ok(ms < 500, `${ms} ms`);
  });
  check(`${tag}: a reason never exceeds a few KB for a kill of a long command line`, () => {
    const huge = row(9001, `/Applications/Claude.app/${'x'.repeat(100000)}`);
    const { d } = runCase(decide, 'pkill -f foo', { [PG('-f', 'foo')]: [huge] });
    assert.ok(d.reason.length < 2000, `${d.reason.length} characters`);
  });
}

// --- the sandbox: the gate and the modules it loads evaluated with no real process,
// subprocess or signal capability, so a missing guard fails a test and never signals ----
const SOURCES = {
  './kill-gate.cjs': GATE_SOURCE,
  './gate-lib.cjs': fs.readFileSync(path.join(GATES, 'gate-lib.cjs'), 'utf8'),
  './kill-probe.cjs': fs.readFileSync(path.join(GATES, 'kill-probe.cjs'), 'utf8'),
  '../run-state.cjs': fs.readFileSync(path.join(HOOKS, 'run-state.cjs'), 'utf8'),
};
const PURE_BUILTINS = { path, os, crypto };

function makeSandbox(respond = () => { throw new Error('the sandbox has no OS'); }) {
  const spawns = [];
  const kills = [];
  const requested = [];
  const childProcess = {
    spawnSync(bin, args, options) {
      spawns.push({ bin, args, options });
      if (!ALLOWLIST.includes(bin)) throw new Error(`Unexpected spawn: ${bin}`);
      return respond(bin, args, options);
    },
    execFileSync(bin) { spawns.push({ bin }); throw new Error(`Unexpected exec: ${bin}`); },
    // runHook's decider spawn. The table runs decide only, so reaching this at all is a
    // regression: it is recorded (the table check below expects no spawns) and refused.
    spawn(bin) { spawns.push({ bin }); throw new Error(`Unexpected spawn: ${bin}`); },
  };
  const fakeFs = {
    statSync(p) {
      if (!Object.hasOwn(FILES, p)) throw new Error(`ENOENT: ${p}`);
      return { isFile: () => true, size: FILES[p].length };
    },
    readFileSync(p) {
      if (!Object.hasOwn(FILES, p)) throw new Error(`ENOENT: ${p}`);
      return FILES[p];
    },
    existsSync: () => false,
  };
  const context = vm.createContext({
    process: {
      platform: 'darwin',
      pid: 500,
      ppid: 400,
      env: { USER: 'tester', HOME: '/Homedirs/tester', CLAUDE_CONFIG_DIR: CONFIG },
      getuid: () => process.getuid(),
      kill: (...a) => { kills.push(a); throw new Error('a signal was sent'); },
    },
  });
  const cache = {};
  function sandboxRequire(name) {
    requested.push(name);
    if (Object.hasOwn(PURE_BUILTINS, name)) return PURE_BUILTINS[name];
    if (name === 'child_process') return childProcess;
    if (name === 'fs') return fakeFs;
    if (Object.hasOwn(SOURCES, name)) return load(name);
    throw new Error(`Unexpected import: ${name}`);
  }
  function load(name) {
    if (cache[name]) return cache[name].exports;
    const mod = { exports: {} };
    cache[name] = mod;
    const body = SOURCES[name].replace(/^#!.*\n/, '');
    const wrapped = vm.runInContext(`(function (module, exports, require, __dirname, __filename) {${body}\n})`, context, { timeout: 5000 });
    wrapped(mod, mod.exports, sandboxRequire, GATES, path.join(GATES, name));
    return mod.exports;
  }
  return { load, spawns, kills, requested, gate: () => load('./kill-gate.cjs') };
}

// The stub is live: a sandbox-loaded kill-probe reaches it, and an unlisted binary throws.
// Without this a stub that was never wired would make "no spawn recorded" mean nothing.
check('sandbox: the child_process stub records spawns and refuses an unlisted binary', () => {
  const s = makeSandbox(() => ({ status: 1, stdout: '', stderr: '' }));
  const sandboxedProbe = s.load('./kill-probe.cjs');
  assert.deepEqual(plain(sandboxedProbe.probe('/usr/bin/pgrep', ['-x', 'zzqq-no-such-proc'])), { pids: [] });
  assert.equal(s.spawns.length, 1);
  assert.equal(s.spawns[0].bin, '/usr/bin/pgrep');
  assert.throws(() => sandboxedProbe.probe('/bin/sh', ['-c', 'true']));
  assert.equal(s.spawns.length, 1, 'an unlisted binary reached spawnSync');
  assert.deepEqual(plain(s.kills), []);
});

const sandbox = makeSandbox();
check('sandbox: the gate loads with the real gate-lib and kill-probe and exports decide', () => {
  assert.equal(typeof sandbox.gate().decide, 'function');
  assert.equal(sandbox.gate().MAX_MATCHES, MAX_MATCHES);
  assert.ok(sandbox.requested.includes('./gate-lib.cjs') && sandbox.requested.includes('./kill-probe.cjs'));
});
if (typeof sandbox.gate().decide === 'function') runTable('sandbox', sandbox.gate().decide);
check('sandbox: the whole table never spawned a process and never signalled one', () => {
  assert.deepEqual(plain(sandbox.spawns.map((c) => c.bin)), []);
  assert.deepEqual(plain(sandbox.kills), []);
});

// --- the real module: only when the source grep and every sandbox check passed ---------
// The spawned hook is the entrypoint Claude Code runs (JSON on stdin). It reaches the real
// probe only for a pattern that matches nothing (`pgrep -x zzqq-no-such-proc`); every
// other spawned case is decided before a query: group, unresolved, parse, prose.
if (failures.length === 0) {
  const { decide, MAX_MATCHES: realMax, BUDGET_MS: realBudget, runHook: realRunHook } = require(MODULE_PATH);
  check('real: MAX_MATCHES is 10', () => assert.equal(realMax, 10));
  runTable('real', decide);

  const hook = (command, { tool = 'Bash', env = {}, cwd } = {}) => {
    const r = spawnSync(process.execPath, [MODULE_PATH], {
      input: JSON.stringify({ tool_name: tool, tool_input: { command }, ...(cwd ? { cwd } : {}) }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, SKIP_CODE_GATES: '', ...env },
    });
    let out = null;
    try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
    const h = out && out.hookSpecificOutput;
    return {
      code: r.status,
      stderr: r.stderr,
      decision: (h && h.permissionDecision) || 'allow',
      reason: (h && h.permissionDecisionReason) || '',
      raw: r.stdout,
    };
  };
  const noProbe = CASES.filter(([want, , answers]) => want !== 'allow' && want !== 'match' && want !== 'count' && want !== 'probe' && answers === undefined);
  const noProbeAllow = CASES.filter(([want, , answers]) => want === 'allow' && answers === undefined);
  for (const [want, cmd] of noProbe) {
    check(`spawned hook: ${want} ${label(cmd)}`, () => {
      const r = hook(cmd);
      assert.equal(r.code, 0, r.stderr.slice(0, 200));
      assert.equal(r.decision, 'deny', r.raw.slice(0, 200));
      assert.ok(new RegExp(`rule ${want}\\b`).test(r.reason), r.reason);
    });
    check(`SKIP_CODE_GATES=1 still denies: ${want} ${label(cmd)}`, () => {
      const r = hook(cmd, { env: { SKIP_CODE_GATES: '1' } });
      assert.equal(r.code, 0);
      assert.equal(r.decision, 'deny');
      assert.ok(new RegExp(`rule ${want}\\b`).test(r.reason), r.reason);
    });
  }
  for (const [, cmd] of noProbeAllow) {
    check(`spawned hook allows in silence: ${label(cmd)}`, () => {
      const r = hook(cmd);
      assert.equal(r.code, 0, r.stderr.slice(0, 200));
      assert.equal(r.decision, 'allow');
      assert.equal(r.raw, '');
    });
  }
  check('spawned hook allows a non-Bash tool, even with a pkill command', () => {
    const r = hook('pkill -f cat', { tool: 'PowerShell' });
    assert.equal(r.code, 0);
    assert.equal(r.raw, '');
  });
  // The only real-OS dry runs: read-only queries for a process name that does not exist.
  for (const cmd of ['pkill -x zzqq-no-such-proc', 'killall zzqq-no-such-proc', 'pkill -qx zzqq-no-such-proc']) {
    check(`spawned hook with the real probe allows a pattern that matches nothing: ${cmd}`, () => {
      const r = hook(cmd);
      assert.equal(r.code, 0, r.stderr.slice(0, 200));
      assert.equal(r.decision, 'allow', r.reason);
      assert.equal(r.raw, '');
    });
  }
  // The entrypoint hands the hook input's cwd to decide: a pid file that exists only there
  // is found. It is empty, so no query is made.
  check('spawned hook resolves a relative pid file against the input cwd', () => {
    fs.writeFileSync(path.join(WORKDIR, 'nobody.pid'), '');
    const r = hook('kill $(cat nobody.pid)', { cwd: WORKDIR });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.decision, 'allow', r.reason);
    const elsewhere = hook('kill $(cat nobody.pid)', { cwd: OTHER_DIR });
    assert.equal(elsewhere.decision, 'deny', 'the file exists only in the input cwd');
    assert.ok(/rule probe\b/.test(elsewhere.reason), elsewhere.reason);
  });
  // A pathological command must be refused, not lexed. A 5000-deep `$(` is built here in JS,
  // never in a shell; it is refused as rule parse before the lexer runs, so the decider does
  // not spend seconds of CPU (lexed, 5000 levels cost about 1.5 s and end in a stack overflow).
  // On a machine under heavy load the budget (a deny of its own, rule probe) can run out first.
  const nested = (inner) => '$('.repeat(5000) + inner + ')'.repeat(5000);
  const asJson = (r) => { try { return JSON.parse(r.raw); } catch { return null; } };
  check('spawned hook on a 5000-deep $( around a group kill denies as parse and exits 0', () => {
    const r = hook(nested('kill -9 -1'));
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.equal(r.decision, 'deny', `no deny printed: ${r.raw.slice(0, 200)}`);
    assert.ok(asJson(r), 'stdout is not one JSON document');
    assert.ok(/rule parse\b/.test(r.reason) || /rule probe\b.*did not finish within/.test(r.reason),
      r.reason.slice(0, 300));
    const rule = /rule (\w+)/.exec(r.reason)[1];
    assert.ok(REWRITE[rule].test(r.reason), r.reason.slice(0, 300));
    assert.ok(r.reason.length <= MAX_REASON, `${r.reason.length} characters`);
  });
  check('spawned hook on a 5000-deep $( around a harmless command allows in silence', () => {
    const r = hook(nested('echo hi'));
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.equal(r.raw, '');
  });
  check('spawned hook: a 200 KB operand in a deny case prints complete JSON under 8 KB', () => {
    const big = 'x'.repeat(200 * 1024);
    for (const [want, cmd] of [['group', `kill -9 -${big}`], ['unresolved', `pkill -f $${big}`], ['parse', `pkill -f "${big}`]]) {
      const r = hook(cmd);
      assert.equal(r.code, 0, `${want}: exit ${r.code}: ${r.stderr.slice(0, 200)}`);
      assert.equal(r.decision, 'deny', `${want}: ${r.raw.slice(0, 200)}`);
      assert.ok(asJson(r), `${want}: stdout is not valid JSON (${r.raw.length} bytes)`);
      assert.ok(r.raw.length < 8 * 1024, `${want}: ${r.raw.length} bytes`);
      assert.ok(new RegExp(`rule ${want}\\b`).test(r.reason), r.reason.slice(0, 200));
      assert.ok(REWRITE[want].test(r.reason), `${want}: ${r.reason.slice(0, 300)}`);
    }
  });

  // --- the decider's own crash path and the exits that wait for a write ---------------
  // Decider mode is what the hook spawns: JSON request on stdin, one JSON verdict on stdout,
  // exit 0. A request it cannot act on is a `crash` verdict, never a silent exit (which the
  // hook would read as no verdict at all), and the process ends only once the verdict has
  // been handed to the pipe.
  const deciderMode = (stdin) => {
    const r = spawnSync(process.execPath, [MODULE_PATH, '--decider'], {
      input: stdin,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    let verdict;
    try { verdict = JSON.parse(r.stdout); } catch { verdict = { RAW: r.stdout }; }
    return { code: r.status, stderr: r.stderr, raw: r.stdout, verdict };
  };
  const REQUEST = { command: 'pkill -f x', cwd: WORKDIR, ppid: process.pid };
  for (const [name, stdin] of [
    ['a request with no ppid', JSON.stringify({ command: REQUEST.command, cwd: WORKDIR })],
    ['a request whose ppid is not a number', JSON.stringify({ ...REQUEST, ppid: 'nope' })],
    ['stdin that is not JSON', 'this is not json'],
    ['empty stdin', ''],
  ]) {
    check(`decider mode: ${name} answers a crash verdict, exit 0`, () => {
      const r = deciderMode(stdin);
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
      assert.equal(r.verdict.rule, 'crash', r.raw.slice(0, 300));
      assert.ok(/rule crash\b/.test(r.verdict.reason), r.verdict.reason);
      assert.ok(REWRITE.crash.test(r.verdict.reason), r.verdict.reason);
      assert.ok(r.verdict.reason.length <= MAX_REASON, `${r.verdict.reason.length} characters`);
      assert.ok(/kill-gate crashed/.test(r.stderr), r.stderr.slice(0, 200));
    });
  }
  check('decider mode: a command that is allowed answers the JSON text null, exit 0', () => {
    const r = deciderMode(JSON.stringify({ ...REQUEST, command: 'pkill -x zzqq-no-such-proc' }));
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.equal(r.raw, 'null');
  });
  check('decider mode: a verdict for a 200 KB operand is written in full, exit 0', () => {
    const r = deciderMode(JSON.stringify({ ...REQUEST, command: `kill -9 -${'x'.repeat(200 * 1024)}` }));
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.equal(r.verdict.rule, 'group', r.raw.slice(0, 200));
    assert.ok(r.raw.length < 8 * 1024, `${r.raw.length} bytes`);
  });
  // The hook ends in the callback of its stdout write, not right after it. A pipe holds 64 KB,
  // so an exit straight after a larger write loses the rest when the reader is slow: measured
  // with a reader that waits 1.5 s, an immediate exit delivers 65,536 bytes of a 200 KB write
  // and the callback form delivers all of it. A verdict reason is capped well under that in
  // real use, so the fixture decider answers one just under the decider's own 64 KB cap, which
  // puts the hook's JSON (the reason plus its envelope) past the pipe. The decider and the
  // slow reader are written here, in the temp directory, and nothing is signalled.
  const BIG_DECIDER = path.join(CONFIG, 'decider-big.cjs');
  fs.writeFileSync(BIG_DECIDER, [
    "'use strict';",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ rule: 'match', reason: 'x'.repeat(65500) }));",
    '});',
    '',
  ].join('\n'));
  const SLOW_READER = path.join(CONFIG, 'slow-reader.cjs');
  fs.writeFileSync(SLOW_READER, [
    "'use strict';",
    "const { spawn } = process.getBuiltinModule('child_process');",
    "const child = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'pipe', 'inherit'] });",
    'const chunks = [];',
    "child.stdout.on('data', (c) => chunks.push(c));",
    'child.stdout.pause();',
    'child.stdin.end(process.env.KG_INPUT);',
    'setTimeout(() => child.stdout.resume(), 1500);',
    "child.on('close', (code) => {",
    "  const out = Buffer.concat(chunks).toString('utf8');",
    '  let parsed = false;',
    '  try { JSON.parse(out); parsed = true; } catch { /* truncated */ }',
    '  process.stdout.write(JSON.stringify({ code, bytes: Buffer.byteLength(out), parsed }));',
    '});',
    '',
  ].join('\n'));
  check('hook: a deny larger than the pipe is written in full to a slow reader before the hook exits', () => {
    const r = spawnSync(process.execPath, [SLOW_READER, path.join(__dirname, 'fixtures', 'kill-gate-hook.cjs')], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: CONFIG,
        KG_DECIDER: BIG_DECIDER,
        KG_BUDGET_MS: '20000',
        KG_INPUT: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pkill -f foo' } }),
      },
    });
    assert.equal(r.status, 0, r.stderr.slice(0, 200));
    const got = JSON.parse(r.stdout);
    assert.equal(got.code, 0);
    assert.equal(got.parsed, true, `the hook's JSON was cut short at ${got.bytes} bytes (the pipe holds 65536)`);
    assert.ok(got.bytes > 65536, `the hook wrote ${got.bytes} bytes: not larger than the pipe, so this does not test the exit`);
  });

  // --- the wall-clock budget (Decision 20) -------------------------------------------
  // Each case spawns the fixture hook, which calls the real runHook with a fixture
  // decider, and times the hook PROCESS: spawn to exit, stdout and stderr closed
  // (spawnSync returns only then, so a decider that inherited the hook's stderr would
  // hold it open and show up here). A decider blocked in spawnSync is what makes the
  // timing mean something: a promise or an Atomics.wait stand-in would pass while the
  // real process still hung. Nothing is signalled: the abandoned blocking decider's
  // `sleep` ends by itself, a few seconds after the case that left it behind.
  const FIXTURES = path.join(__dirname, 'fixtures');
  const decider = (name) => path.join(FIXTURES, `kill-gate-decider-${name}.cjs`);
  const KILL_CMD = 'pkill -f foo';
  // BUDGET is for the cases about timing, where the hook must be gone within BUDGET + 2 s.
  // Every other case gives the hook a budget it cannot reach (the decider answers at once;
  // two node startups under heavy load have taken seconds), and tells a verdict or a crash
  // from a timeout by the rule in the reason, never by the clock.
  const BUDGET = 1500;
  const FAST_BUDGET = 20000;
  let markerCount = 0;
  const budgeted = (name, command, { budgetMs = FAST_BUDGET, agoMs = 0, burnMs = 0, tool = 'Bash', cwd, marker } = {}) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(FIXTURES, 'kill-gate-hook.cjs')], {
      input: JSON.stringify({ tool_name: tool, tool_input: { command }, ...(cwd ? { cwd } : {}) }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: CONFIG,
        KG_DECIDER: decider(name),
        KG_BUDGET_MS: String(budgetMs),
        KG_STARTED_AGO_MS: String(agoMs),
        KG_BURN_MS: String(burnMs),
        ...(marker ? { KG_MARKER: marker } : {}),
      },
    });
    const ms = Date.now() - started;
    let out = null;
    try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
    const h = out && out.hookSpecificOutput;
    return {
      code: r.status, ms, stderr: r.stderr, raw: r.stdout,
      decision: (h && h.permissionDecision) || 'allow',
      reason: (h && h.permissionDecisionReason) || '',
    };
  };

  check('real: BUDGET_MS is 6000 and runHook is exported', () => {
    assert.equal(realBudget, 6000);
    assert.equal(typeof realRunHook, 'function');
  });
  check('budget: a decider blocked in spawnSync is abandoned at the budget: deny probe, exit 0, hook gone within budget + 2 s', () => {
    const r = budgeted('block', KILL_CMD, { budgetMs: BUDGET });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.ok(r.ms >= BUDGET, `the hook gave up after ${r.ms} ms, before its ${BUDGET} ms budget`);
    assert.ok(r.ms < BUDGET + 2000, `the hook process lasted ${r.ms} ms: it outlived budget + 2000 ms (${BUDGET + 2000})`);
    assert.equal(r.decision, 'deny', `no deny printed: ${r.raw.slice(0, 200)}`);
    assert.ok(/rule probe\b/.test(r.reason), r.reason);
    assert.ok(REWRITE.probe.test(r.reason), r.reason);
    assert.ok(/did not finish within the [\d.]+ s budget/.test(r.reason), r.reason);
    assert.ok(r.reason.length <= MAX_REASON, `${r.reason.length} characters`);
  });
  check('budget: startedAt in the past shortens the wait', () => {
    const budget = 3000;
    const r = budgeted('block', KILL_CMD, { budgetMs: budget, agoMs: 2500 });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.ok(/rule probe\b/.test(r.reason), r.reason);
    assert.ok(r.ms < budget, `${r.ms} ms: the wait was not shortened by the 2500 ms already spent`);
  });
  // With no startedAt passed, the deadline counts from the hook process's start: the
  // fixture burns 2.5 s before calling runHook, so a deadline counted from the call
  // instead would end the wait at burn + budget, past the bound below.
  check('budget: the default deadline counts from process start, not from the runHook call', () => {
    const budget = 3000;
    const r = budgeted('block', KILL_CMD, { budgetMs: budget, burnMs: 2500 });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.ok(r.ms >= budget, `the hook gave up after ${r.ms} ms, before its ${budget} ms budget`);
    assert.ok(r.ms < budget + 2000, `${r.ms} ms: the deadline was counted from the runHook call, not from process start`);
    assert.ok(/rule probe\b/.test(r.reason), r.reason);
  });
  check('budget: a decider that answers a verdict yields that deny, at once', () => {
    const r = budgeted('deny', KILL_CMD);
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'kill-gate rule match (fixture decider): denied. fixture');
  });
  check('budget: a decider that answers allow yields silence', () => {
    const marker = path.join(CONFIG, `marker-${markerCount++}`);
    const r = budgeted('allow', KILL_CMD, { marker });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.raw, '');
    assert.equal(r.decision, 'allow');
    assert.ok(fs.existsSync(marker), 'the decider was never started (the marker is missing)');
  });
  // `exit1` prints a valid allow and then exits 1: only a decider that ended cleanly is trusted.
  for (const name of ['crash', 'garbage', 'exit1']) {
    check(`budget: a decider that ends without a usable verdict (${name}) denies as a crash for a kill-word command`, () => {
      const r = budgeted(name, KILL_CMD);
      assert.equal(r.code, 0, r.stderr.slice(0, 200));
      assert.equal(r.decision, 'deny', `no deny printed: ${r.raw.slice(0, 200)}`);
      assert.ok(/rule crash\b/.test(r.reason), r.reason);
      assert.ok(REWRITE.crash.test(r.reason), r.reason);
      assert.ok(r.reason.length <= MAX_REASON, `${r.reason.length} characters`);
    });
  }
  // A decider that exits without reading its stdin closes the pipe under the hook's write.
  // A request this large cannot fit in the pipe, so the write is still going when that
  // happens: without a handler for the stream's error the hook dies on an unhandled 'error'
  // event, exit 1 with no output, and the command runs.
  check('budget: a 400 KB kill-word command sent to a decider that exits without reading denies as a crash and exits 0', () => {
    const command = `pkill -f ${'x'.repeat(400 * 1024)}`;
    const r = budgeted('crash', command);
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr.slice(0, 300)}`);
    assert.equal(r.decision, 'deny', `no deny printed: ${r.raw.slice(0, 200)}`);
    assert.ok(/rule crash\b/.test(r.reason), r.reason.slice(0, 300));
  });
  check('budget: a command with no kill word exits in silence and starts no decider', () => {
    const marker = path.join(CONFIG, `marker-${markerCount++}`);
    const r = budgeted('allow', 'echo hello', { marker });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.raw, '');
    assert.ok(!fs.existsSync(marker), 'a decider was started for a command with no kill word');
  });
  check('budget: a non-Bash tool exits in silence and starts no decider', () => {
    const marker = path.join(CONFIG, `marker-${markerCount++}`);
    const r = budgeted('allow', KILL_CMD, { tool: 'PowerShell', marker });
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.raw, '');
    assert.ok(!fs.existsSync(marker), 'a decider was started for a non-Bash tool');
  });
  check('budget: the decider is handed the command, the input cwd and the hook\'s own ppid', () => {
    const r = budgeted('echo', KILL_CMD, { cwd: WORKDIR });
    assert.equal(r.decision, 'deny', r.raw.slice(0, 200));
    const sent = JSON.parse(r.reason);
    // The fixture hook's parent is this process, so that is the pid the ancestor walk starts from.
    assert.deepEqual(sent, { command: KILL_CMD, cwd: WORKDIR, ppid: process.pid });
  });
  check('budget: the real hook walks ancestors from its own ppid (a kill of this process is a protected match)', () => {
    const r = hook(`kill ${process.pid}`);
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    assert.equal(r.decision, 'deny', `no deny printed: ${r.raw.slice(0, 200)}`);
    assert.ok(/rule match\b/.test(r.reason), r.reason.slice(0, 300));
    assert.ok(new RegExp(`pid ${process.pid} is an ancestor of this hook`).test(r.reason), r.reason.slice(0, 400));
  });
  // A synchronous throw in the hook must not fail open. With no `cwd` in the input the hook
  // asks the process for its directory, which throws when that directory has been removed.
  // The shell enters a fresh directory, removes it and runs the hook from there.
  const GONE_SCRIPT = 'cd "$1" && rmdir "$1" && exec "$2" "$3"';
  const fromRemovedDir = (command) => {
    const dir = fs.mkdtempSync(path.join(CONFIG, 'gone-'));
    const r = spawnSync('/bin/sh', ['-c', GONE_SCRIPT, 'sh', dir, process.execPath, MODULE_PATH], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    assert.ok(!fs.existsSync(dir), 'the directory was not removed');
    return r;
  };
  check('budget: a kill-word command from a removed working directory denies as a crash and exits 0', () => {
    const r = fromRemovedDir(KILL_CMD);
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(/rule crash\b/.test(out.hookSpecificOutput.permissionDecisionReason), out.hookSpecificOutput.permissionDecisionReason);
    assert.ok(REWRITE.crash.test(out.hookSpecificOutput.permissionDecisionReason));
  });
  check('budget: a command with no kill word from a removed working directory exits 0 in silence', () => {
    const r = fromRemovedDir('echo hello');
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.equal(r.stdout, '');
  });
  // A three-byte character split across two chunks of stdin must be read whole: a
  // replacement character would change the text the gate judges and echoes.
  check('budget: the hook reads a multibyte character split across two stdin chunks', () => {
    const wide = '€'.repeat(20);
    const r = spawnSync(process.execPath, [path.join(FIXTURES, 'kill-gate-split-stdin.cjs'), MODULE_PATH], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `kill -9 -${wide}` } }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.ok(/rule group\b/.test(reason), reason.slice(0, 300));
    assert.ok(reason.includes(wide), `the character was cut: ${reason.slice(0, 300)}`);
    assert.ok(!reason.includes('�'), 'a replacement character reached the reason');
  });
  check('budget: a 15000-character multibyte command reaches the decider intact', () => {
    const command = `pkill -f ${'€'.repeat(15000)}`;
    const r = budgeted('echo', command);
    assert.equal(r.decision, 'deny', r.raw.slice(0, 200));
    assert.equal(JSON.parse(r.reason).command, command);
  });
} else {
  failures.push('SKIPPED: the real-module tests did not run because a sandbox check failed');
}

fs.rmSync(CONFIG, { recursive: true, force: true });
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
