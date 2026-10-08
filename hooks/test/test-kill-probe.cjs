'use strict';
// Tests for hooks/gates/kill-probe.cjs: the allowlisted read-only process probe and
// the protected-process classifier. Nothing here signals a process.
//
// Order matters. The first check greps the module source and ends the run if it fails,
// before any sandbox is built. After it, every check runs the
// module inside a vm sandbox whose spawnSync stub records each call (and throws for a
// binary outside the allowlist) and whose process.kill throws. Nothing from the real
// module is required, loaded or called until all of those have passed: the real-OS
// block at the end is the only place that requires it, and only when `failures` is
// still empty.
//
// The sandbox catches accidental regressions (a stray process.kill, a spawn of an
// unlisted binary). It does not prove the module cannot signal: vm is not a security
// boundary, and a host object handed in can be escaped through its
// `constructor.constructor`, which reaches the real process. The source grep is a
// second, equally shallow net.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Hooks read CLAUDE_CONFIG_DIR at load time; never let a test see the real one.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-probe-test-'));

const MODULE_PATH = path.join(__dirname, '..', 'gates', 'kill-probe.cjs');
const ALLOWLIST = ['/usr/bin/pgrep', '/bin/ps', '/usr/sbin/lsof'];

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); }
}

// --- the source grep, first: text only, executes nothing ------------------------------
// A failed grep ends the run here. The sandbox loads below evaluate the module source,
// and a source the grep rejected (for instance one that reaches the real process through
// `constructor.constructor`) must not be evaluated at all, so there is no path from a red
// grep to a `vm.runInContext` call or a require.
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const FORBIDDEN = /execSync|exec\(|shell: *true|process\.kill\(|process\[\s*['"`]kill['"`]\s*\]|\.kill\s*\(|constructor\.constructor/;
const forbiddenMatch = FORBIDDEN.exec(MODULE_SOURCE);
if (forbiddenMatch) {
  fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  console.log(`FAIL module source has no shell exec or signal call: matched ${JSON.stringify(forbiddenMatch[0])}`);
  console.log('0 passed, 1 failed (nothing was loaded: no sandbox and no require ran)');
  process.exit(1);
}
passed++;

// The one place the real module is required must come after the gate that only opens
// when every check above it passed. Read from this file's own text, so it holds for any
// later edit of the test. The patterns are regexes so they do not match themselves here.
check('the only real-module require is inside the failures gate block', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const gate = /^if \(failures\.length === 0\) \{$/m.exec(self);
  assert.ok(gate, 'the failures gate line is missing');
  assert.equal([...self.matchAll(/^if \(failures\.length === 0\) \{$/gm)].length, 1, 'more than one gate line');
  // The gate block is closed by the next line that starts with a brace at column 0
  // (`} else {`); everything this file does at top level is unindented.
  const close = /^\}/m.exec(self.slice(gate.index + gate[0].length));
  assert.ok(close, 'the failures gate block is not closed');
  const blockEnd = gate.index + gate[0].length + close.index;
  const requires = [...self.matchAll(/require\(MODULE_PATH\)/g)];
  assert.equal(requires.length, 1, `${requires.length} require calls of the module`);
  assert.ok(requires[0].index > gate.index && requires[0].index < blockEnd,
    'the module is required outside the failures gate block');
  // Any other way of loading the module (a literal path, a computed path, a dynamic or
  // static import, a resolver) would sidestep the gate. Every require call in this file
  // must name MODULE_PATH, a node: builtin, or be the sandbox's own `name` parameter.
  for (const m of self.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
    const arg = m[1].trim();
    assert.ok(arg === 'MODULE_PATH' || arg === 'name' || /^'node:[a-z/_]+'$/.test(arg), `unexpected require argument: ${arg}`);
  }
  assert.ok(!/\bimport\s*\(/.test(self), 'a dynamic import is present');
  assert.ok(!/^\s*import\s/m.test(self), 'a static import is present');
  assert.ok(!/create[R]equire|require\.resolve|process\.binding/.test(self), 'another module loader is present');
});

// Values built inside the vm carry that realm's prototypes, which strict deepEqual
// rejects; compare their plain JSON shape.
const plain = (v) => JSON.parse(JSON.stringify(v));

// --- the sandbox: the module evaluated with no real process, filesystem or subprocess
// capability, so a missing guard produces a test failure, never a signal ------------------
function makeSandbox(respond) {
  const calls = [];
  const kills = [];
  const source = MODULE_SOURCE;
  const module = { exports: {} };
  const requested = [];
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(name) {
      requested.push(name);
      if (name !== 'child_process') throw new Error(`Unexpected import: ${name}`);
      return {
        spawnSync(bin, args, options) {
          calls.push({ bin, args, options });
          if (!ALLOWLIST.includes(bin)) throw new Error(`Unexpected spawn: ${bin}`);
          return respond(bin, args, options);
        },
      };
    },
    process: { platform: 'darwin', pid: 500, kill: (...a) => { kills.push(a); throw new Error('process.kill called'); } },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return { api: module.exports, calls, kills, requested };
}

const PS_TABLE = {
  101: '  101   500 node server.js',
  102: '  102   500 /opt/homebrew/bin/node /Homedirs/someone/app/worker.js',
  500: '  500   400 /bin/zsh -c run',
  400: '  400   300 claude --resume',
  300: '  300     1 /Applications/Claude.app/Contents/MacOS/Claude',
};
function fakeOs(bin, args) {
  if (bin === '/usr/bin/pgrep') {
    return args.includes('-x') && args.includes('nomatch')
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: '101\n102\n', stderr: '' };
  }
  if (bin === '/usr/sbin/lsof') return { status: 0, stdout: '101\n', stderr: '' };
  if (bin === '/bin/ps') {
    const list = args[args.indexOf('-p') + 1].split(',');
    const rows = list.filter((p) => PS_TABLE[p]).map((p) => PS_TABLE[p]);
    return rows.length ? { status: 0, stdout: rows.join('\n') + '\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
  }
  throw new Error(`unhandled ${bin}`);
}

// --- the classifier, in the sandbox ---------------------------------------------------
const CLAUDE_CLI = '/Homedirs/someone/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude --output-format stream-json --verbose';
const CLAUDE_VSCODE = '/Homedirs/someone/.vscode/extensions/anthropic.claude-code-2.1.283-darwin-arm64/resources/native-binary/claude --output-format stream-json';
const CLAUDE_CLI_PROFILE = '/Homedirs/tester/Library/Application Support/Claude-Workout/claude-code/2.1.284/claude.app/Contents/MacOS/claude --output-format stream-json --verbose --input-format stream-json --effort high --model claude-opus-5-5 --permission-prompt-tool stdio';
const CLAUDE_VSCODE_NODE ='node /Homedirs/someone/.vscode/extensions/anthropic.claude-code-2.1.283-darwin-arm64/resources/claude-code/cli.js --resume';
const CLAUDE_VSCODE_SPACE = '/Homedirs/some one/.vscode/extensions/anthropic.claude-code-2.1.283-darwin-arm64/resources/native-binary/claude --output-format stream-json';
const CLAUDE_APP = '/Applications/Claude.app/Contents/MacOS/Claude';
const CLAUDE_HELPER = '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer';
const CLAUDE_DISCLAIMER = '/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Homedirs/someone/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude --output-format stream-json';

const PROTECTED = [
  ['Claude Code CLI path family', { pid: 700, ppid: 600, command: CLAUDE_CLI }, 'desktop app CLI'],
  // A second desktop profile keeps its CLI under `Application Support/Claude-<Name>/`; the
  // first row is the shape ps prints for one (home directory replaced).
  ['Claude Code CLI of a second desktop profile', { pid: 760, ppid: 600, command: CLAUDE_CLI_PROFILE }, 'desktop app CLI'],
  ['Claude Code CLI of another profile name', { pid: 761, ppid: 600, command: CLAUDE_CLI_PROFILE.replace('Claude-Workout', 'Claude-3P') }, 'desktop app CLI'],
  ['Claude Code CLI profile, disclaimer wrapper', { pid: 762, ppid: 1, command: `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${CLAUDE_CLI_PROFILE}` }, 'Claude'],
  // The extension rule is reached by its own path family, not by the "first word ends in
  // /claude" rule: a native-binary path ends in /claude, and a node script under the
  // extension does not.
  ['Claude Code VS Code extension path family', { pid: 701, ppid: 600, command: CLAUDE_VSCODE }, 'editor extension'],
  ['Claude Code VS Code extension run by node', { pid: 740, ppid: 600, command: CLAUDE_VSCODE_NODE }, 'editor extension'],
  ['Claude Code VS Code extension, path with a space', { pid: 741, ppid: 600, command: CLAUDE_VSCODE_SPACE }, 'editor extension'],
  // An npm install runs as `node <script>`: the first word is node, so only the script says what it is.
  ['npm install: node running a bin named claude', { pid: 742, ppid: 600, command: 'node /Homedirs/someone/.nvm/versions/node/v22.21.1/bin/claude --resume' }, 'npm'],
  ['npm install: absolute node, package entry point', { pid: 743, ppid: 600, command: '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }, 'npm'],
  ['npm install: node option before the script', { pid: 744, ppid: 600, command: 'node --no-warnings /usr/local/bin/claude' }, 'npm'],
  ['npm install: bare claude script', { pid: 745, ppid: 600, command: 'node claude' }, 'npm'],
  ['Claude desktop app path family', { pid: 702, ppid: 1, command: CLAUDE_APP }, 'Claude'],
  ['Claude desktop app helper', { pid: 703, ppid: 702, command: CLAUDE_HELPER }, 'Claude'],
  ['Claude desktop disclaimer wrapper', { pid: 704, ppid: 702, command: CLAUDE_DISCLAIMER }, 'Claude'],
  ['first word ending in /claude', { pid: 705, ppid: 600, command: '/Homedirs/someone/.local/bin/claude --resume' }, 'Claude Code'],
  ['bare claude first word', { pid: 706, ppid: 600, command: 'claude --resume' }, 'Claude Code'],
  ['pid 1', { pid: 1, ppid: 0, command: '/sbin/launchd' }, 'launchd'],
  ['loginwindow by name', { pid: 710, ppid: 1, command: 'loginwindow console' }, 'loginwindow'],
  ['WindowServer by name', { pid: 711, ppid: 1, command: 'WindowServer -daemon' }, 'WindowServer'],
  ['Finder by name', { pid: 712, ppid: 1, command: 'Finder' }, 'Finder'],
  ['Dock by name', { pid: 713, ppid: 1, command: 'Dock' }, 'Dock'],
  ['SystemUIServer by name', { pid: 714, ppid: 1, command: 'SystemUIServer' }, 'SystemUIServer'],
  ['ControlCenter by name', { pid: 715, ppid: 1, command: 'ControlCenter' }, 'ControlCenter'],
  ['loginwindow by full path', { pid: 716, ppid: 1, command: '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow console' }, 'loginwindow'],
  ['/System/ command', { pid: 717, ppid: 1, command: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder' }, 'Finder'],
  ['Dock by full path', { pid: 720, ppid: 1, command: '/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock' }, 'Dock'],
  ['SystemUIServer by full path', { pid: 721, ppid: 1, command: '/System/Library/CoreServices/SystemUIServer.app/Contents/MacOS/SystemUIServer' }, 'SystemUIServer'],
  ['ControlCenter by full path', { pid: 722, ppid: 1, command: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter' }, 'ControlCenter'],
  ['WindowServer by full path', { pid: 723, ppid: 1, command: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon' }, 'WindowServer'],
  ['/System/ command outside the named set', { pid: 719, ppid: 1, command: '/System/Library/Frameworks/Foo.framework/foo' }, '/System/'],
  ['/Applications/ command', { pid: 718, ppid: 1, command: '/Applications/Safari.app/Contents/MacOS/Safari' }, '/Applications/'],
  // ps prints a parenthesised name when a process is exiting or its arguments are
  // unreadable; the name is classified as it would be without the parentheses.
  ['(claude), an exiting or unreadable Claude Code', { pid: 730, ppid: 600, command: '(claude)' }, 'Claude Code'],
  ['(Claude)', { pid: 731, ppid: 1, command: '(Claude)' }, 'Claude'],
  ['(Claude Helper)', { pid: 732, ppid: 731, command: '(Claude Helper)' }, 'Claude'],
  ['(Claude Helper (Renderer))', { pid: 733, ppid: 731, command: '(Claude Helper (Renderer))' }, 'Claude'],
  ['(claude) with surrounding whitespace', { pid: 734, ppid: 600, command: '  (claude)  ' }, 'Claude Code'],
  ['(Finder)', { pid: 735, ppid: 1, command: '(Finder)' }, 'Finder'],
  ['(WindowServer)', { pid: 736, ppid: 1, command: '(WindowServer)' }, 'WindowServer'],
  ['(loginwindow)', { pid: 737, ppid: 1, command: '(loginwindow)' }, 'loginwindow'],
  // A native install can show its version instead of its name once ps cannot read its arguments.
  ['(2.1.284), a native Claude Code showing its version', { pid: 750, ppid: 600, command: '(2.1.284)' }, 'version'],
  ['(2.1.7)', { pid: 751, ppid: 600, command: '(2.1.7)' }, 'version'],
  ['(2.1.284) with surrounding whitespace', { pid: 752, ppid: 600, command: '  (2.1.284)  ' }, 'version'],
  ['(2.1.284-beta.1)', { pid: 753, ppid: 600, command: '(2.1.284-beta.1)' }, 'version'],
];
const PLAIN = [
  { pid: 800, ppid: 500, command: 'node server.js' },
  { pid: 801, ppid: 500, command: '/opt/homebrew/bin/node /Homedirs/someone/app/server.js --port 3000' },
  { pid: 802, ppid: 500, command: 'vim claude.md' },
  { pid: 803, ppid: 500, command: '/Homedirs/someone/proj/claude-notes.sh' },
  { pid: 804, ppid: 500, command: 'node dock-server.js' },
  { pid: 805, ppid: 500, command: '/opt/homebrew/bin/python3 -m http.server 8766' },
  { pid: 806, ppid: 500, command: '/Homedirs/someone/Applications-old/thing' },
  { pid: 807, ppid: 500, command: 'sleep 90' },
  { pid: 808, ppid: 500, command: '(node)' },
  { pid: 809, ppid: 500, command: '(sleep)' },
  { pid: 810, ppid: 500, command: '(claudette)' },
  { pid: 811, ppid: 500, command: '(vim claude.md)' },
  { pid: 812, ppid: 500, command: '(python3.12)' },
  { pid: 813, ppid: 500, command: '(2.1)' },
  { pid: 814, ppid: 500, command: '(12)' },
  { pid: 815, ppid: 500, command: '(v2.1.284)' },
  // node running something else, even with claude in a later argument or a longer file name
  { pid: 816, ppid: 500, command: 'node server.js --root /srv/me/claude' },
  { pid: 817, ppid: 500, command: 'node /Homedirs/someone/app/claude-notes.js' },
  { pid: 818, ppid: 500, command: 'node claude.js' },
  { pid: 819, ppid: 500, command: '/opt/homebrew/bin/node /Homedirs/someone/app/worker.js --name claude' },
  { pid: 820, ppid: 500, command: 'node' },
  // an Application Support directory that is not a Claude profile, or a path that only looks like the CLI tree
  { pid: 821, ppid: 500, command: '/Homedirs/tester/Library/Application Support/ClaudeX/claude-code/1.0.0/tool run' },
  { pid: 822, ppid: 500, command: '/Homedirs/tester/Library/Application Support/Claudette/claude-code/1.0.0/tool run' },
  { pid: 823, ppid: 500, command: '/Homedirs/tester/Library/Application Support/Claude-Workout/cache/claude-code-notes/tool run' },
];
const ANCESTORS = [4242, 4200];

// One sandbox serves the whole classifier table; the check after it proves no row, of
// any kind, signalled or spawned anything. The results are strings or null, which are
// realm-neutral, so they are compared without `plain`.
const classifier = makeSandbox(fakeOs);
for (const [name, proc, expected] of PROTECTED) {
  check(`protected: ${name}`, () => {
    const reason = classifier.api.isProtected(proc, ANCESTORS);
    assert.equal(typeof reason, 'string', `expected a reason for ${proc.command}`);
    assert.ok(reason.includes(expected), `reason ${JSON.stringify(reason)} should mention ${expected}`);
  });
}
// The names the gate refuses before a query come from the classifier's own list.
check('isProtectedName is true for exactly the names the classifier protects by name', () => {
  for (const name of ['loginwindow', 'WindowServer', 'Finder', 'Dock', 'SystemUIServer', 'ControlCenter']) {
    assert.equal(classifier.api.isProtectedName(name), true, name);
    assert.equal(typeof classifier.api.isProtected({ pid: 900, ppid: 1, command: name }, []), 'string', name);
  }
  for (const name of ['claude', 'loginwindo', 'loginwindow2', 'finder', 'Finder Helper', '', 'node']) {
    assert.equal(classifier.api.isProtectedName(name), false, JSON.stringify(name));
  }
});
check('protected: a pid in the ancestor chain', () => {
  const reason = classifier.api.isProtected({ pid: 4200, ppid: 4100, command: '/bin/zsh -c whatever' }, ANCESTORS);
  assert.equal(typeof reason, 'string');
  assert.ok(reason.includes('ancestor'));
});
check('protected: ancestors default to none', () => {
  assert.equal(classifier.api.isProtected({ pid: 4200, ppid: 4100, command: 'node server.js' }), null);
});
for (const proc of PLAIN) {
  check(`plain: ${proc.command}`, () => assert.equal(classifier.api.isProtected(proc, ANCESTORS), null));
}
check('sandbox: the whole classifier table never signalled or spawned anything', () => {
  assert.deepEqual(plain(classifier.kills), []);
  assert.deepEqual(plain(classifier.calls), []);
});

// --- probe and ancestorPids over a stubbed spawnSync, inside a vm sandbox --------
// The allowlist, exercised in the sandbox: a bin outside it must throw before anything
// is spawned, so a regressed guard fails an assertion instead of running a binary.
const REJECTED_BINS = ['/bin/sh', '/usr/bin/pkill', '/usr/bin/killall', '/bin/kill', '/usr/bin/env', 'pgrep', '/tmp/usr/bin/pgrep', undefined, null, 42];
for (const bin of REJECTED_BINS) {
  check(`sandbox: probe rejects ${String(bin)}`, () => {
    const s = makeSandbox(fakeOs);
    assert.throws(() => s.api.probe(bin, ['-x', 'zzqq-no-such-proc']));
    assert.equal(s.calls.length, 0);
    assert.deepEqual(plain(s.kills), []);
  });
}
// The module's own allowlist is pinned to exactly the three read-only tools: a fourth
// entry (say a launchctl path) would make probe spawn it, and none of the named rejections
// above would notice.
check('sandbox: the module allowlist is exactly pgrep, ps and lsof', () => {
  const s = makeSandbox(fakeOs);
  assert.deepEqual(plain(s.api.ALLOWLIST).sort(), [...ALLOWLIST].sort());
});
// Anything not exactly equal to one of the three paths throws before a spawn: near
// misses of each allowlisted path (whitespace, dot segments, doubled slashes, a prefix, a
// case change, a trailing slash or NUL) plus binaries no one would put on the list.
const NEAR_MISS_BINS = [
  ...ALLOWLIST.flatMap((p) => {
    const dir = p.slice(0, p.lastIndexOf('/'));
    const base = p.slice(p.lastIndexOf('/') + 1);
    return [
      `${p} `, ` ${p}`, `${p}\n`, `${p}\0`, `${p}/`,
      `${dir}/../${dir.split('/').pop()}/${base}`, `${dir}/./${base}`, `${dir}//${base}`,
      `/private${p}`, `/tmp${p}`, p.toUpperCase(), p.replace(/^\//, ''), `./${p.slice(1)}`,
    ];
  }),
  '/bin/launchctl', '/usr/bin/osascript', '/usr/bin/xargs', '/usr/bin/nohup', '/bin/bash', '',
];
for (const bin of NEAR_MISS_BINS) {
  check(`sandbox: probe throws for ${JSON.stringify(bin)} and spawns nothing`, () => {
    const s = makeSandbox(fakeOs);
    assert.ok(!ALLOWLIST.includes(bin), 'the generated bin is one of the allowlisted paths');
    assert.throws(() => s.api.probe(bin, ['-x', 'zzqq-no-such-proc']));
    assert.equal(s.calls.length, 0, `spawnSync was reached with ${JSON.stringify(s.calls[0] && s.calls[0].bin)}`);
    assert.deepEqual(plain(s.kills), []);
  });
}
check('sandbox: probe rejects args that are not an array of strings', () => {
  const s = makeSandbox(fakeOs);
  assert.throws(() => s.api.probe('/usr/bin/pgrep', 'x'));
  assert.throws(() => s.api.probe('/usr/bin/pgrep', [1]));
  assert.equal(s.calls.length, 0);
});

check('sandbox: pgrep pids become rows via one ps call', () => {
  const s = makeSandbox(fakeOs);
  const r = plain(s.api.probe('/usr/bin/pgrep', ['-f', 'server']));
  assert.deepEqual(r, { pids: [
    { pid: 101, ppid: 500, command: 'node server.js' },
    { pid: 102, ppid: 500, command: '/opt/homebrew/bin/node /Homedirs/someone/app/worker.js' },
  ] });
  assert.deepEqual(plain(s.calls.map((c) => c.bin)), ['/usr/bin/pgrep', '/bin/ps']);
  assert.deepEqual(plain(s.calls[1].args), ['-o', 'pid=,ppid=,command=', '-p', '101,102']);
});
// Any spawnSync option beyond these three is a hazard: pgrep and pkill are one binary,
// and an `argv0` other than "pgrep" makes it run in pkill mode, turning a dry run into a
// real signal. So the options must be exactly this object, with no extra key of any kind.
check('sandbox: every spawn has exactly the options {shell:false, timeout:1000, encoding:utf8}', () => {
  const s = makeSandbox(fakeOs);
  const callerArgs = [['-f', 'server'], ['-t', '-i', ':3000'], ['-o', 'pid=,ppid=,command=', '-p', '500']];
  s.api.probe('/usr/bin/pgrep', callerArgs[0]);
  s.api.probe('/usr/sbin/lsof', callerArgs[1]);
  s.api.probe('/bin/ps', callerArgs[2]);
  assert.ok(s.calls.length >= 4);
  for (const c of s.calls) {
    // Values built in the vm carry that realm's prototypes; compare keys and values.
    assert.deepEqual(Reflect.ownKeys(c.options).sort(), ['encoding', 'shell', 'timeout']);
    const d = Object.getOwnPropertyDescriptors(c.options);
    assert.ok(Object.values(d).every((x) => 'value' in x), 'an option is an accessor');
    assert.deepEqual({ shell: c.options.shell, timeout: c.options.timeout, encoding: c.options.encoding },
      { shell: false, timeout: 1000, encoding: 'utf8' });
    assert.equal(Object.isFrozen(c.options), true, 'the options object is not frozen');
  }
});
check('sandbox: every spawn passes an allowlisted bin and a fresh array of strings', () => {
  const s = makeSandbox(fakeOs);
  const callerArgs = [['-f', 'server'], ['-t', '-i', ':3000'], ['-o', 'pid=,ppid=,command=', '-p', '500']];
  s.api.probe('/usr/bin/pgrep', callerArgs[0]);
  s.api.probe('/usr/sbin/lsof', callerArgs[1]);
  s.api.probe('/bin/ps', callerArgs[2]);
  assert.ok(s.calls.length >= 4);
  for (const c of s.calls) {
    assert.equal(typeof c.bin, 'string');
    assert.ok(ALLOWLIST.includes(c.bin), `${c.bin} is not an allowlist entry`);
    assert.equal(Array.isArray(c.args), true);
    assert.ok(c.args.every((a) => typeof a === 'string'));
    assert.ok(!callerArgs.includes(c.args), "the caller's own array was handed to spawnSync");
  }
  assert.equal(new Set(s.calls.map((c) => c.args)).size, s.calls.length, 'two spawns shared one args array');
  assert.deepEqual(plain(s.calls[0].args), callerArgs[0]);
});
check('sandbox: pgrep with no match (exit 1) is an empty set and spawns no ps', () => {
  const s = makeSandbox(fakeOs);
  assert.deepEqual(plain(s.api.probe('/usr/bin/pgrep', ['-x', 'nomatch'])), { pids: [] });
  assert.deepEqual(plain(s.calls.map((c) => c.bin)), ['/usr/bin/pgrep']);
});
check('sandbox: lsof -t pids become rows', () => {
  const s = makeSandbox(fakeOs);
  assert.deepEqual(plain(s.api.probe('/usr/sbin/lsof', ['-t', '-i', ':3000'])), { pids: [{ pid: 101, ppid: 500, command: 'node server.js' }] });
});
check('sandbox: ps of a pid that is gone (exit 1, no output) is an empty set', () => {
  const s = makeSandbox(fakeOs);
  assert.deepEqual(plain(s.api.probe('/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', '99999'])), { pids: [] });
});
check('sandbox: a pid that vanishes between pgrep and ps is dropped, not an error', () => {
  const s = makeSandbox((bin, args) => (bin === '/usr/bin/pgrep'
    ? { status: 0, stdout: '101\n999\n', stderr: '' }
    : fakeOs(bin, args)));
  assert.deepEqual(plain(s.api.probe('/usr/bin/pgrep', ['-f', 'x']).pids.map((p) => p.pid)), [101]);
});
const ERROR_CASES = [
  ['a timeout', () => ({ error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '' })],
  ['a spawn failure', () => ({ error: new Error('spawnSync ENOENT'), status: null, stdout: '' })],
  ['pgrep exit 2 (bad usage)', (bin) => (bin === '/usr/bin/pgrep' ? { status: 2, stdout: '', stderr: 'pgrep: bad option' } : null)],
  ['pgrep exit 3 (fatal)', (bin) => (bin === '/usr/bin/pgrep' ? { status: 3, stdout: '', stderr: 'boom' } : null)],
  ['pgrep ended by a signal', (bin) => (bin === '/usr/bin/pgrep' ? { status: null, signal: 'SIGKILL', stdout: '' } : null)],
  ['pgrep output that is not pids', (bin) => (bin === '/usr/bin/pgrep' ? { status: 0, stdout: 'not a pid\n' } : null)],
  ['pgrep exit 1 with stderr (a failure, not "no match")', (bin) => (bin === '/usr/bin/pgrep' ? { status: 1, stdout: '', stderr: 'pgrep: something went wrong' } : null)],
  ['ps output that is not rows', (bin, args) => (bin === '/bin/ps' ? { status: 0, stdout: 'garbage line\n' } : fakeOs(bin, args))],
  ['ps failing after pgrep succeeded', (bin, args) => (bin === '/bin/ps' ? { status: 2, stdout: '', stderr: 'ps: bad' } : fakeOs(bin, args))],
  ['ps exit 1 with stderr after pgrep succeeded', (bin, args) => (bin === '/bin/ps' ? { status: 1, stdout: '', stderr: 'ps: illegal argument' } : fakeOs(bin, args))],
];
// Exit 0 with nothing to report is a tool that did not do what was asked, never
// "none": pgrep -qx prints nothing but exits 0 on a match, so reading it as no match
// would let a kill of a running process through. The only legitimate empty results are
// exit 1 with no output and no stderr (no match / dead pid list), tested above.
const EMPTY_SUCCESS_CASES = [
  ['pgrep exit 0 with empty output (pgrep -qx Finder)', '/usr/bin/pgrep', ['-qx', 'Finder'], (bin, args) => (bin === '/usr/bin/pgrep' ? { status: 0, stdout: '', stderr: '' } : fakeOs(bin, args))],
  ['pgrep exit 0 with whitespace-only output', '/usr/bin/pgrep', ['-x', 'Finder'], (bin, args) => (bin === '/usr/bin/pgrep' ? { status: 0, stdout: '\n', stderr: '' } : fakeOs(bin, args))],
  ['lsof exit 0 with empty output', '/usr/sbin/lsof', ['-t', '-i', ':3000'], (bin, args) => (bin === '/usr/sbin/lsof' ? { status: 0, stdout: '', stderr: '' } : fakeOs(bin, args))],
  ['ps exit 0 with empty output', '/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', '500'], (bin, args) => (bin === '/bin/ps' ? { status: 0, stdout: '', stderr: '' } : fakeOs(bin, args))],
  ['ps exit 0 after pgrep listed pids, with no rows', '/usr/bin/pgrep', ['-f', 'x'], (bin, args) => (bin === '/bin/ps' ? { status: 0, stdout: '\n', stderr: '' } : fakeOs(bin, args))],
  ['ps exit 1 with stderr (a failure, not a dead pid list)', '/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', '500'], (bin, args) => (bin === '/bin/ps' ? { status: 1, stdout: '', stderr: 'ps: illegal argument' } : fakeOs(bin, args))],
];
for (const [name, bin, args, respond] of EMPTY_SUCCESS_CASES) {
  check(`sandbox: ${name} is an error`, () => {
    const s = makeSandbox(respond);
    const r = s.api.probe(bin, args);
    assert.equal(typeof r.error, 'string', JSON.stringify(r));
    assert.equal(r.pids, undefined);
  });
}
for (const [name, respond] of ERROR_CASES) {
  check(`sandbox: ${name} is an error`, () => {
    const s = makeSandbox((bin, args, options) => respond(bin, args, options) || fakeOs(bin, args));
    const r = s.api.probe('/usr/bin/pgrep', ['-f', 'x']);
    assert.equal(typeof r.error, 'string', JSON.stringify(r));
    assert.equal(r.pids, undefined);
  });
}
check('sandbox: a disallowed bin throws before any spawn', () => {
  const s = makeSandbox(fakeOs);
  for (const bin of ['/bin/sh', '/usr/bin/pkill', '/usr/bin/killall', '/bin/kill', '/usr/bin/env']) {
    assert.throws(() => s.api.probe(bin, ['-x', 'zzqq-no-such-proc']));
  }
  assert.equal(s.calls.length, 0);
});
check('sandbox: ancestorPids walks ppid up to launchd', () => {
  const s = makeSandbox(fakeOs);
  assert.deepEqual(plain(s.api.ancestorPids(500)), [500, 400, 300]);
  for (const c of s.calls) {
    assert.equal(c.bin, '/bin/ps');
    assert.deepEqual(plain(c.args.slice(0, 3)), ['-o', 'pid=,ppid=,command=', '-p']);
  }
});
check('sandbox: ancestorPids defaults to this process', () => {
  const s = makeSandbox(fakeOs);
  assert.equal(s.api.ancestorPids()[0], 500);
});
check('sandbox: ancestorPids stops on a cycle', () => {
  const s = makeSandbox((bin, args) => {
    const p = args[args.indexOf('-p') + 1];
    return { status: 0, stdout: p === '10' ? '10 20 a\n' : '20 10 b\n' };
  });
  assert.deepEqual(plain(s.api.ancestorPids(10)), [10, 20]);
});
check('sandbox: ancestorPids reports a probe failure as { error }, not a shortened chain', () => {
  const s = makeSandbox((bin, args) => (args.includes('400')
    ? { status: 2, stdout: '', stderr: 'ps: bad' }
    : fakeOs(bin, args)));
  const r = plain(s.api.ancestorPids(500));
  assert.equal(Array.isArray(r), false, JSON.stringify(r));
  assert.equal(typeof r.error, 'string');
});
check('sandbox: ancestorPids reports a ps exit 1 with stderr as { error }', () => {
  const s = makeSandbox((bin, args) => (args.includes('400')
    ? { status: 1, stdout: '', stderr: 'ps: illegal argument' }
    : fakeOs(bin, args)));
  const r = plain(s.api.ancestorPids(500));
  assert.equal(Array.isArray(r), false, JSON.stringify(r));
  assert.equal(typeof r.error, 'string');
});
check('sandbox: ancestorPids reports a ps timeout as { error }', () => {
  const s = makeSandbox(() => ({ error: new Error('spawnSync ETIMEDOUT'), status: null, stdout: '' }));
  assert.equal(typeof plain(s.api.ancestorPids(500)).error, 'string');
});
check('sandbox: ancestorPids ends the chain quietly when a parent has already exited', () => {
  const s = makeSandbox((bin, args) => (args.includes('400')
    ? { status: 1, stdout: '', stderr: '' }
    : fakeOs(bin, args)));
  assert.deepEqual(plain(s.api.ancestorPids(500)), [500, 400]);
});
// Every pid's parent is the pid before it, down to launchd at pid 1.
const descending = (bin, args) => {
  const p = Number(args[args.indexOf('-p') + 1]);
  return { status: 0, stdout: `${p} ${p - 1} step\n` };
};
check('sandbox: ancestorPids reports hitting its depth limit as { error }, not a truncated chain', () => {
  const s = makeSandbox((bin, args) => {
    const p = Number(args[args.indexOf('-p') + 1]);
    return { status: 0, stdout: `${p} ${p + 1} step\n` }; // never reaches launchd
  });
  const r = plain(s.api.ancestorPids(10));
  assert.equal(Array.isArray(r), false, `got a chain of ${Array.isArray(r) ? r.length : '?'}`);
  assert.equal(typeof r.error, 'string');
  assert.ok(s.calls.length <= 64, `${s.calls.length} probes`);
});
check('sandbox: ancestorPids returns a chain of exactly the depth limit that ends at launchd', () => {
  const s = makeSandbox(descending);
  const r = plain(s.api.ancestorPids(65)); // 65 .. 2, then launchd
  assert.equal(Array.isArray(r), true, JSON.stringify(r));
  assert.equal(r.length, 64);
});
check('sandbox: ancestorPids one pid past the depth limit is { error }', () => {
  const s = makeSandbox(descending);
  const r = plain(s.api.ancestorPids(66)); // 66 .. 2 is 65 pids
  assert.equal(Array.isArray(r), false, `got a chain of ${Array.isArray(r) ? r.length : '?'}`);
  assert.equal(typeof r.error, 'string');
});
check('sandbox: isProtected works in the sandbox and imports only child_process', () => {
  const s = makeSandbox(fakeOs);
  assert.equal(typeof s.api.isProtected({ pid: 700, ppid: 1, command: CLAUDE_CLI }, []), 'string');
  assert.deepEqual(plain([...new Set(s.requested)]), ['child_process']);
});
check('sandbox: loading and exercising the module never calls process.kill', () => {
  const s = makeSandbox(fakeOs);
  s.api.probe('/usr/bin/pgrep', ['-f', 'x']);
  s.api.probe('/usr/sbin/lsof', ['-t']);
  s.api.probe('/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', '500']);
  s.api.ancestorPids(500);
  for (const p of PROTECTED) s.api.isProtected(p[1], [1]);
  for (const bin of ['/bin/sh', '/usr/bin/pkill']) { try { s.api.probe(bin, []); } catch { /* expected */ } }
  assert.deepEqual(plain(s.kills), []);
  assert.ok(s.calls.every((c) => ALLOWLIST.includes(c.bin)));
});

// --- the real-OS tests: read-only, match nothing / this process ------------------------
// The gate: reached only when the source grep and every sandbox check above passed, so a
// broken allowlist guard or a stray process.kill has already failed the suite before any
// real module code exists in this process. The real module is required here and nowhere
// else. A skipped real-OS block fails the suite: it is not evidence that the probe works.
if (failures.length === 0) {
  const { probe } = require(MODULE_PATH);
  check('real OS: pgrep -x zzqq-no-such-proc finds nothing', () => {
    assert.deepEqual(probe('/usr/bin/pgrep', ['-x', 'zzqq-no-such-proc']), { pids: [] });
  });
  check('real OS: ps of this process returns its own row', () => {
    const r = probe('/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', String(process.pid)]);
    assert.equal(r.error, undefined);
    assert.equal(r.pids.length, 1);
    assert.equal(r.pids[0].pid, process.pid);
    assert.equal(r.pids[0].ppid, process.ppid);
    assert.ok(r.pids[0].command.includes('test-kill-probe'), r.pids[0].command);
  });
} else {
  failures.push('SKIPPED: the real-OS tests did not run because a sandbox check failed');
}

fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
