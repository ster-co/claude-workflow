#!/usr/bin/env node
// Behavioural tests for the stdio relay in front of one shared Serena per
// repository.
// Run: node hooks/test/test-serena-relay.cjs
//
//   bin/serena-relay.cjs — the stdio MCP server Claude Code starts. It finds
//   or starts the repository's shared server through hooks/serena-registry.cjs
//   and forwards JSON-RPC to it over streamable HTTP.
//
// Every server here is hooks/test/fixtures/fake-mcp-http.cjs, never real
// Serena: SERENA_RELAY_SERVER_CMD points the relay at it. The fake rejects an
// unknown Mcp-Session-Id with 404 and a missing one with 400, as Serena does,
// so a relay that drops the header cannot pass.
//
// Process guard. CLAUDE_CONFIG_DIR is a fresh temp dir, so the registry this
// suite reads and writes is never the operator's. Nothing here signals a
// process it did not spawn: relays are this suite's own children
// (ChildProcess#kill); servers are stopped through killRecordServer on a
// record a relay of this suite wrote; the one relay whose failed stop is
// tested runs against a stubbed registry that touches no process, and the
// idle child its record names is stopped through its own handle; and the
// final sweep signals a fake only
// after its live command line is checked to contain this run's temp dir,
// which no process outside this run can have.
//
// House style: every MUST-fire paired with a MUST-NOT.
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

const HOOKS = path.join(__dirname, '..');
const RELAY = path.join(HOOKS, '..', 'bin', 'serena-relay.cjs');
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-http.cjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

const trash = [];
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-relay-'));
trash.push(CONFIG);

// gate-lib.cjs reads CLAUDE_CONFIG_DIR once, at require time, so it is set
// before the registry is loaded and this process's view of the registry is
// the same temp one the relays write.
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const reg = require(path.join(HOOKS, 'serena-registry.cjs'));
const { STATE_DIR } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));

function tmpRepo(name, files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`));
  trash.push(d);
  execFileSync('git', ['init', '-q', d]);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return d;
}

// The real git this machine already has on PATH, resolved once so the shim
// below can hand every subcommand but one to it unchanged.
const REAL_GIT = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
  .trim().split('\n')[0];

// A directory holding a `git` that answers `check-ignore` with `code` --
// neither 0 (ignored) nor 1 (not ignored) -- and forwards every other
// subcommand to the real git. Prepending it to a relay's PATH stands in for
// git failing to answer the ignored-or-not question at all: a timeout, or a
// fatal error such as running outside any repository, without this suite
// waiting out a real one.
function gitCheckIgnoreShim(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-'));
  trash.push(dir);
  const script = `#!/bin/sh\nif [ "$1" = "check-ignore" ]; then exit ${code}; fi\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`;
  fs.writeFileSync(path.join(dir, 'git'), script);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

// The language_servers: list a .serena/project.yml has, the way
// repo-setup.cjs's own tests read it back.
function serversIn(yml) {
  try {
    const lines = fs.readFileSync(yml, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.startsWith('language_servers:'));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j++) out.push(lines[j].slice(2).trim());
    return out;
  } catch { return []; }
}

// One fake-server log per repository, so "how many servers did this repo
// get" is a count of that file's listen events.
function fakeCmd(logFile, extra = []) {
  return JSON.stringify([process.execPath, FAKE, '--port', '{port}', '--log', logFile, ...extra]);
}
// A /bin/sh wrapper around the fake server, so a test can see what the
// filesystem looked like at the moment the server's command was actually
// exec'd -- before the fake ever answers a request, and so before a relay
// could possibly still be deciding whether to write .serena/project.yml.
// Checking after the handshake instead (as the block above this one does)
// only proves the file exists eventually; it cannot tell "written before
// spawn" from "written after", and the config must be on disk before the
// relay spawns a server. $1 is the repository root (the relay substitutes `{root}` before
// exec), so the wrapper can stat `$1/.serena/project.yml` for itself, with no
// fixture edit needed.
function fakeCmdRecordingConfig(logFile, markerFile) {
  const script = [
    'if [ -e "$1/.serena/project.yml" ]; then echo present > "$2"; else echo absent > "$2"; fi;',
    'exec "$3" "$4" --port "$5" --log "$6" --root "$1"',
  ].join(' ');
  return JSON.stringify(['/bin/sh', '-c', script, 'wrapper', '{root}', markerFile,
    process.execPath, FAKE, '{port}', logFile]);
}
function logEvents(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const allLogs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(25);
  }
}

const relays = [];
class Relay {
  // `nodeArgs` go before the relay's path on node's command line: `-r` a
  // preload, for the one test that swaps the registry out.
  constructor(repo, cmd, env = {}, nodeArgs = []) {
    this.repo = repo;
    this.seq = 0;
    this.messages = [];
    this.rawLines = [];
    // Called with each stdout message as its line is read, for a test that
    // must answer before the next event-loop turn rather than on a poll.
    this.watchers = [];
    this.stderr = '';
    this.child = spawn(process.execPath, [...nodeArgs, RELAY], {
      cwd: repo,
      env: {
        ...process.env,
        // Blanked by default: an operator's own shell may export this to opt
        // a real session out of automatic repo setup (SETUP.md), and that
        // must not leak into a relay this suite starts to test the setup
        // itself. A test that means to exercise the opt-out passes it
        // through `env`, which is spread after this and wins.
        CLAUDE_NO_AUTO_REPO_SETUP: '',
        CLAUDE_CONFIG_DIR: CONFIG,
        CLAUDE_PROJECT_DIR: repo,
        SERENA_RELAY_SERVER_CMD: cmd,
        SERENA_RELAY_READY_TIMEOUT_MS: '5000',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    relays.push(this);
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    this.child.stdin.on('error', () => { /* the relay exited first; reported by the checks */ });
    this.child.stderr.on('data', (b) => { this.stderr += b; });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.rawLines.push(line);
      let m;
      try { m = JSON.parse(line); } catch { return; /* counted by the one-line check */ }
      this.messages.push(m);
      for (const w of this.watchers) w(m);
    });
  }
  send(msg) { this.child.stdin.write(`${JSON.stringify(msg)}\n`); }
  async request(method, params, timeoutMs = 10_000) {
    const id = ++this.seq;
    this.send({ jsonrpc: '2.0', id, method, params });
    return until(() => this.messages.find((m) => m.id === id && !m.method), timeoutMs,
      `a reply to ${method} #${id} from relay ${this.pid} (stderr: ${this.stderr.trim().slice(-400)})`);
  }
  async handshake() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    this.initId = r.id;
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  // The echo tool's text is JSON naming the server pid and the session.
  async echo(args = {}) {
    const r = await this.request('tools/call', { name: 'echo', arguments: args });
    if (!r.result) return { error: r.error };
    return JSON.parse(r.result.content[0].text);
  }
  close() { this.child.stdin.end(); }
  async waitExit(timeoutMs = 10_000) {
    return Promise.race([this.exited, sleep(timeoutMs).then(() => ({ timeout: true }))]);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function rawRequest(method, port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const rawPost = (port, body, headers) => rawRequest('POST', port, body, headers);
const ACCEPT = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

// A process this run started, and still the same one: its live command line
// names this run's temp config dir. Anything else is left alone.
function ownFakeAlive(pid) {
  if (!reg.isAlive(pid)) return false;
  let ident = '';
  try { ident = reg.captureIdentity(pid); } catch { return false; }
  return ident.includes(FAKE) && ident.includes(CONFIG);
}
function serverPids(logFile, ev = 'listen') {
  return logEvents(logFile).filter((e) => e.ev === ev).map((e) => e.pid);
}

async function main() {
  // ---------------------------------------------------------------------------
  console.log('fake-mcp-http.cjs — the fixture enforces sessions');
  {
    const port = await freePort();
    const log = path.join(CONFIG, 'fixture.log');
    allLogs.push(log);
    const fake = spawn(process.execPath, [FAKE, '--port', String(port), '--log', log], { stdio: 'ignore' });
    try {
      await until(() => logEvents(log).some((e) => e.ev === 'listen'), 5000, 'the fixture to listen');
      const transports = () => logEvents(log).filter((e) => e.ev === 'transport').length;
      // Two ways to ask "is the port up": a bare POST makes Serena create a
      // session transport it never frees; a made-up session id is refused
      // before anything is created, which is why the relay's probe sends one.
      const bare = await rawPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      check('a bare POST (no Content-Type) gets 400', bare.status, 400);
      check('... and leaves a session transport behind on the server', transports(), 1);
      const madeUp = await rawRequest('POST', port, undefined, { 'mcp-session-id': 'no-such-session' });
      check('a bodiless POST with a made-up Mcp-Session-Id gets 404', madeUp.status, 404);
      check('... and creates nothing (MUST-NOT add a transport)', transports(), 1);
      const noSession = await rawPost(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ACCEPT);
      check('tools/list without Mcp-Session-Id gets 400 (Missing session ID)', noSession.status, 400);
      const unknown = await rawPost(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...ACCEPT, 'mcp-session-id': 'nope' });
      check('tools/list with an unknown Mcp-Session-Id gets 404', unknown.status, 404);
      const init = await rawPost(port, { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }, ACCEPT);
      const sid = init.headers['mcp-session-id'];
      ok('initialize issues a session id', init.status === 200 && sid);
      const withSid = { ...ACCEPT, 'mcp-session-id': sid };
      const early = await rawPost(port, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, withSid);
      ok('tools/list before notifications/initialized is refused with an error',
        early.status === 200 && JSON.parse(early.body).error);
      const note = await rawPost(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, withSid);
      check('notifications/initialized gets 202', note.status, 202);
      const known = await rawPost(port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, withSid);
      check('tools/list with the issued session id is answered (MUST-NOT 404)', known.status, 200);
      ok('... with the tools, once the session is initialized', JSON.parse(known.body).result);
      const badVersion = await rawPost(port, { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        { ...withSid, 'mcp-protocol-version': '2099-01-01' });
      check('an unsupported MCP-Protocol-Version gets 400', badVersion.status, 400);
      const del = await rawRequest('DELETE', port, undefined, { 'mcp-session-id': sid });
      check('DELETE with the session id ends the session', del.status, 200);
      const afterDel = await rawPost(port, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, withSid);
      check('... after which the session id gets 404', afterDel.status, 404);
    } finally {
      fake.kill('SIGKILL');
    }
  }

  // ---------------------------------------------------------------------------
  // The parser is tested directly because the "\n" join cannot be seen
  // through the relay: a JSON message tolerates any whitespace, or none,
  // between tokens, so a relay joining data lines with "" or " " re-emits the
  // same message. Requiring a relay that lacks the guard would RUN it, and
  // with no override it would start real Serena for this checkout; the
  // source is checked for the guard first.
  console.log('\nserena-relay.cjs — the SSE parser');
  {
    const src = fs.readFileSync(RELAY, 'utf8');
    const guard = src.indexOf('if (require.main !== module)');
    const guarded = guard >= 0 && guard < src.indexOf('registry.repoKey(projectDir)');
    ok('the relay can be loaded for its SSE parser without starting anything', guarded);
    if (guarded) {
      const { sseParser } = require(RELAY);
      const feed = (chunks) => {
        const out = [];
        const parse = sseParser((d) => out.push(d));
        for (const c of chunks) parse(c);
        return out;
      };
      check('an event\'s data lines are joined with "\\n"', feed(['data: a\ndata: b\n\n']), ['a\nb']);
      check('a CRLF split across two reads ends the line once', feed(['data: a\r', '\ndata: b\r\n\r\n']), ['a\nb']);
      check('a CR at the end of a read followed by a CR is still a blank line', feed(['data: a\r', '\r']), ['a']);
      check('a lone CR ends a line', feed(['data: a\rdata: b\r\r']), ['a\nb']);
      check('a line split mid-way across reads is reassembled', feed(['da', 'ta: {"x"', ':1}\n', '\n']), ['{"x":1}']);
    }
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — two relays in one repository share one server');
  const repo1 = tmpRepo('one');
  const log1 = path.join(CONFIG, 'repo1.log');
  allLogs.push(log1);
  const key1 = reg.repoKey(repo1).key;
  // The server takes a while to listen, so the second relay finds a record
  // whose server is still starting and has to wait on it, not spawn another.
  const cmd1 = fakeCmd(log1, ['--delay-listen', '700']);
  const A = new Relay(repo1, cmd1);
  await until(() => reg.read(key1), 5000, 'relay A to record a server');
  const B = new Relay(repo1, cmd1);
  const [initA, initB] = await Promise.all([A.handshake(), B.handshake()]);
  ok('relay A gets an initialize result', initA.result && initA.result.serverInfo);
  ok('relay B gets an initialize result', initB.result && initB.result.serverInfo);
  const [eA, eB] = await Promise.all([A.echo(), B.echo()]);
  ok('relay A\'s tools/call is answered', eA.pid);
  ok('relay B\'s tools/call is answered', eB.pid);
  ok('both relays reach the same server', eA.pid && eA.pid === eB.pid);
  check('one server was started for the repository', serverPids(log1).length, 1);
  ok('each relay has its own session', eA.session && eB.session && eA.session !== eB.session);
  const rec1 = reg.read(key1);
  check('the record names the server that answered', rec1 && rec1.pid, eA.pid);
  check('both relays registered their own pid as a client', rec1 && [...rec1.clients].sort(), [A.pid, B.pid].sort());
  ok('the record carries the server identity captured at spawn', rec1 && rec1.identity && rec1.identity.includes(FAKE));
  const sessionless = logEvents(log1).filter((e) => e.ev === 'request' && e.method !== 'initialize' && !e.known);
  check('every non-initialize request carried a session the server knows', sessionless, []);
  // Each session-less POST makes Serena create a session transport, and one
  // that is not an initialize is never used or freed. The readiness probes
  // of two relays must add none.
  check('the server created one session transport per initialize, none for the readiness probes (MUST-NOT)',
    serverPids(log1, 'transport').length, serverPids(log1, 'session').length);
  check('every request after initialize carried the negotiated MCP-Protocol-Version',
    logEvents(log1).filter((e) => e.ev === 'request' && e.method !== 'initialize' && e.protocol !== '2025-06-18'), []);

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — a relay in another repository gets its own server');
  const repo2 = tmpRepo('two');
  const log2 = path.join(CONFIG, 'repo2.log');
  allLogs.push(log2);
  const key2 = reg.repoKey(repo2).key;
  const C = new Relay(repo2, fakeCmd(log2));
  await C.handshake();
  const eC = await C.echo();
  ok('relay C\'s tools/call is answered', eC.pid);
  ok('repository two is served by a different server than repository one', eC.pid && eC.pid !== eA.pid);
  ok('the two repositories have separate records', key1 !== key2 && reg.read(key2) && reg.read(key2).pid === eC.pid);
  check('relay C did not join repository one\'s record', reg.read(key1).clients.includes(C.pid), false);

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — JSON and SSE replies both reach stdout, one line each');
  {
    const before = A.messages.length;
    const j = await A.echo({ reply: 'json', n: 1 });
    check('a JSON reply comes back', j.args, { reply: 'json', n: 1 });
    const s = await A.echo({ reply: 'sse', n: 2 });
    check('an SSE reply comes back, reassembled from two data lines', s.args, { reply: 'sse', n: 2 });
    const sseId = A.seq;
    const progress = A.messages.slice(before).filter((m) => m.method === 'notifications/progress');
    check('the SSE stream\'s notification is forwarded too, as its own message', progress.map((m) => m.params.progressToken), [sseId]);
    check('every stdout line is one complete JSON message', A.rawLines.length, A.messages.length);
    const none = await A.request('tools/call', { name: 'no_reply', arguments: {} }, 5000).catch((e) => ({ timeout: e.message }));
    ok('a 200 stream that never carries the reply is answered with an error, not left hanging',
      none.error && /no response/.test(none.error.message));
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — a lost session (404) is re-initialized and retried');
  {
    const oldSession = (await A.echo()).session;
    await A.request('tools/call', { name: 'forget_sessions', arguments: {} });
    const mark = logEvents(log1).length;
    const e = await A.echo({ after: 'forget' });
    ok('the call after the server forgot the session is answered, by the same server', e.pid && e.pid === eA.pid);
    ok('it ran on a new session', e.session && e.session !== oldSession);
    const after = logEvents(log1).slice(mark).filter((x) => x.ev === 'request');
    const seq = after.map((x) => `${x.method}:${x.known ? 'known' : 'unknown'}`);
    check('the relay replayed initialize and notifications/initialized before retrying',
      seq, ['tools/call:unknown', 'initialize:unknown', 'notifications/initialized:known', 'tools/call:known']);
    check('the retried call has exactly one response line',
      A.messages.filter((m) => m.id === A.seq && !m.method).length, 1);
    check('the replayed initialize\'s reply is not written to stdout (MUST-NOT)',
      A.messages.filter((m) => m.id === A.initId && !m.method).length, 1);
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — a killed server is respawned and initialize replayed');
  {
    const recBefore = reg.read(key1);
    reg.killRecordServer(recBefore);
    await until(() => !reg.isAlive(recBefore.pid), 5000, 'the killed server to exit');
    const mark = logEvents(log1).length;
    const e = await A.echo({ after: 'kill' });
    ok('the next call after the kill is answered', e.pid);
    ok('by a new server', e.pid && e.pid !== recBefore.pid);
    check('a second server was started', serverPids(log1).length, 2);
    const fromNew = logEvents(log1).slice(mark).filter((x) => x.ev === 'request' && x.pid === e.pid);
    // The old server's port now refuses connections: the one failure, besides
    // a 404, that proves the request never ran, and so the one that is retried.
    check('the new server got initialize, then notifications/initialized, then the call',
      fromNew.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/call']);
    check('the retried call has exactly one response line',
      A.messages.filter((m) => m.id === A.seq && !m.method).length, 1);
    check('the replayed initialize\'s reply is not written to stdout (MUST-NOT)',
      A.messages.filter((m) => m.id === A.initId && !m.method).length, 1);
    const eB2 = await B.echo({ after: 'kill' });
    ok('relay B reconnects to the same new server', eB2.pid && eB2.pid === e.pid);
    check('relay B did not start a third server (MUST-NOT)', serverPids(log1).length, 2);
    const rec = reg.read(key1);
    check('the new record still lists both relays', rec && [...rec.clients].sort(), [A.pid, B.pid].sort());
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — closing: the last client stops the server, others do not');
  {
    const server = reg.read(key1).pid;
    const aSession = (await A.echo({ before: 'close' })).session;
    const bSession = (await B.echo({ before: 'A closes' })).session;
    const markClose = logEvents(log1).length;
    A.close();
    const aExit = await A.waitExit();
    check('relay A exits on stdin end', aExit.code, 0);
    // Checked the moment A has exited: the fake logs a DELETE before it
    // answers it, so a relay that waits for the answer has it logged by then.
    check('relay A closed its own session with DELETE before it exited, the server staying up for B',
      logEvents(log1).slice(markClose).filter((x) => x.ev === 'delete')
        .map((x) => `${x.session === aSession ? 'A' : x.session === bSession ? 'B' : x.session}:${x.known}`), ['A:true']);
    await sleep(300);
    ok('the server keeps running while relay B is still a client (MUST-NOT)', reg.isAlive(server));
    check('relay A removed itself from the record', reg.read(key1).clients, [B.pid]);
    const stillServed = await B.echo({ after: 'A closed' });
    check('relay B is still served', stillServed.pid, server);
    check('... on its own session, which A\'s DELETE left alone (MUST-NOT)', stillServed.session, bSession);
    B.close();
    const bExit = await B.waitExit();
    check('relay B exits on stdin end', bExit.code, 0);
    await until(() => !reg.isAlive(server), 8000, 'the last relay to stop the server').catch(() => {});
    check('the last relay closing stopped the server', reg.isAlive(server), false);
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — SIGTERM and SIGINT also stop the server of the last client');
  {
    const server2 = reg.read(key2).pid;
    C.child.kill('SIGTERM');
    const cExit = await C.waitExit();
    check('relay C exits on SIGTERM', cExit.code, 0);
    await until(() => !reg.isAlive(server2), 8000, 'SIGTERM to stop the server').catch(() => {});
    check('SIGTERM on the last relay stopped the server', reg.isAlive(server2), false);

    const repo3 = tmpRepo('three');
    const log3 = path.join(CONFIG, 'repo3.log');
    allLogs.push(log3);
    const D = new Relay(repo3, fakeCmd(log3));
    await D.handshake();
    const eD = await D.echo();
    ok('relay D is served', eD.pid);
    D.child.kill('SIGINT');
    const dExit = await D.waitExit();
    check('relay D exits on SIGINT', dExit.code, 0);
    await until(() => !reg.isAlive(eD.pid), 8000, 'SIGINT to stop the server').catch(() => {});
    check('SIGINT on the last relay stopped the server', reg.isAlive(eD.pid), false);
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — a server that fails to start is retried on a fresh port');
  {
    const repo4 = tmpRepo('four');
    const log4 = path.join(CONFIG, 'repo4.log');
    allLogs.push(log4);
    const E = new Relay(repo4, fakeCmd(log4, ['--fail-first', path.join(CONFIG, 'fail-first.marker')]));
    await E.handshake();
    const eE = await E.echo();
    ok('the call is answered after the first server exited at startup', eE.pid);
    check('the first server did exit at startup', serverPids(log4, 'fail-first').length, 1);
    check('exactly one server then listened', serverPids(log4).length, 1);
    const serverLog = fs.readFileSync(path.join(STATE_DIR, 'serena', `${reg.repoKey(repo4).key}.log`), 'utf8');
    ok('the server log keeps the failed first attempt\'s output (MUST-NOT truncate it on the second spawn)',
      serverLog.includes('failing this first start on purpose'));
    ok('... followed by a separator naming the second attempt',
      /failing this first start on purpose[\s\S]*\n--- serena-relay \d+: spawn attempt 2 /.test(serverLog));
    E.close();
    await E.waitExit();
    await until(() => !reg.isAlive(eE.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  console.log('\nserena-relay.cjs — a server that never becomes ready is treated as dead');
  {
    const repo5 = tmpRepo('five');
    const log5 = path.join(CONFIG, 'repo5.log');
    allLogs.push(log5);
    // The suite's usual 5 s ready timeout, not a shorter one: it is also all
    // the time the replacement server gets to start, and under load a node
    // process can take longer than 1.5 s to listen.
    const F = new Relay(repo5, fakeCmd(log5, ['--hang-first', path.join(CONFIG, 'hang-first.marker')]));
    await F.handshake();
    const eF = await F.echo();
    ok('the call is answered by a second server', eF.pid);
    const hung = serverPids(log5, 'hang-first');
    check('the first server hung without listening', hung.length, 1);
    ok('the hung server was stopped when it was given up on', hung.length && !reg.isAlive(hung[0]));
    check('exactly one server then listened', serverPids(log5).length, 1);
    F.close();
    await F.waitExit();
    await until(() => !reg.isAlive(eF.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // `uvx` execs into `uv tool uvx` after it starts (seen on the real check:
  // the recorded pid's command is `uv tool uvx …`). An identity captured
  // before that exec names a command line the pid no longer has, and
  // killRecordServer would then refuse forever and leak the server. Here the
  // fake is started through `sh -c 'sleep …; exec …'`, so the command line
  // changes after spawn on purpose. POSIX only: there is no exec on win32.
  console.log('\nserena-relay.cjs — the recorded identity survives an exec during startup');
  if (process.platform !== 'win32') {
    const repo6 = tmpRepo('six');
    const log6 = path.join(CONFIG, 'repo6.log');
    allLogs.push(log6);
    const key6 = reg.repoKey(repo6).key;
    const G = new Relay(repo6, JSON.stringify(['/bin/sh', '-c', 'sleep 0.3; exec "$0" "$@"',
      process.execPath, FAKE, '--port', '{port}', '--log', log6]));
    await G.handshake();
    const eG = await G.echo();
    ok('relay G is served', eG.pid);
    const rec = reg.read(key6);
    ok('the record\'s pid is the exec\'d server', rec && rec.pid === eG.pid);
    ok('the recorded identity matches the live process once the server is ready',
      rec && rec.identity === reg.captureIdentity(rec.pid));
    G.close();
    await G.waitExit();
    await until(() => !reg.isAlive(eG.pid), 8000, 'the server to stop').catch(() => {});
    check('the last relay closing stopped the exec\'d server', reg.isAlive(eG.pid), false);
  } else {
    console.log('  skip (win32 has no exec)');
  }

  // ---------------------------------------------------------------------------
  // A tool call is forwarded at most once. The relay retries only where the
  // server cannot have run the request: the connection was refused, or the
  // server answered 404 for the session (both pinned above). Any other broken
  // connection, before the headers or after them, may have run the tool, and
  // the relay cannot tell a stale socket from a server that died mid-tool.
  // Retrying would apply an edit such as `replace_content` twice; the client
  // gets exactly one error instead.
  console.log('\nserena-relay.cjs — a broken connection is never retried, and the client gets exactly one reply');
  {
    const repo7 = tmpRepo('seven');
    const log7 = path.join(CONFIG, 'repo7.log');
    allLogs.push(log7);
    const H = new Relay(repo7, fakeCmd(log7));
    await H.handshake();
    const eH = await H.echo();
    ok('relay H is served', eH.pid);

    const executions = (id, tool) => logEvents(log7).filter((e) => e.ev === 'request' && e.id === id && e.tool === tool).length;
    const responses = (id) => H.messages.filter((m) => m.id === id && !m.method);
    const kinds = (id) => responses(id).map((m) => (m.error ? 'error' : m.result ? 'result' : 'neither'));

    // One tool call. A reply that never comes is a named failed check rather
    // than a suite abort, so every later check still runs and reports.
    const call = async (name, args = {}) => {
      const reply = await H.request('tools/call', { name, arguments: args }, 4000).catch(() => null);
      const id = H.seq;
      ok(`${name}: the client gets a reply for id ${id} (MUST-NOT leave it waiting)`, reply);
      // A wrong retry reconnects and re-runs the tool within milliseconds; this
      // window is for it to show up, not for the relay to finish.
      await sleep(1000);
      return { reply, id };
    };

    const dropped = await call('reply_then_drop');
    ok('the result written before the connection broke reaches the client', dropped.reply && dropped.reply.result);
    check('exactly one response line for that id (MUST-NOT duplicate the result or add an error)',
      kinds(dropped.id), ['result']);
    check('the server ran the tool once (MUST-NOT retry after the reply began)',
      executions(dropped.id, 'reply_then_drop'), 1);

    // Each of these runs the tool, then breaks the connection before the
    // response: without headers, after the headers, after a notification,
    // and after a server-to-client request that reuses the client's id.
    const drops = {};
    for (const mode of ['nohdr_drop', 'headers_then_drop', 'progress_then_drop', 'request_then_drop']) {
      const { id } = await call(mode);
      drops[mode] = id;
      check(`${mode}: exactly one response line for the id, and it is an error`, kinds(id), ['error']);
      check(`${mode}: the server ran the tool once (MUST-NOT retry)`, executions(id, mode), 1);
    }
    check('progress_then_drop: the progress notification is delivered too',
      H.messages.filter((m) => m.method === 'notifications/progress' && m.params.progressToken === drops.progress_then_drop).length, 1);
    check('request_then_drop: the server\'s request with the same id is delivered, as a request',
      H.messages.filter((m) => m.id === drops.request_then_drop && m.method === 'roots/list').length, 1);

    // The server destroys the next connection before reading it. That is
    // what a stale keep-alive socket looks like, and also exactly what
    // `nohdr_drop` looks like, whose tool did run: so it is not retried either.
    await call('drop_next');
    const stale = await call('echo', { after: 'dropped connection' });
    check('the server dropped the next request before handling it', logEvents(log7).filter((e) => e.ev === 'dropped').length, 1);
    check('a request whose connection broke before any reply gets exactly one error (MUST-NOT retry)',
      kinds(stale.id), ['error']);
    check('the dropped call was not sent again: the server never ran it', executions(stale.id, 'echo'), 0);
    // A reused keep-alive socket the server has closed fails with the same
    // reset as a server dying mid-tool, and would now get an error instead of
    // a retry; the relay avoids it by never reusing a socket.
    check('every request reached the server on a fresh connection (MUST-NOT reuse sockets)',
      logEvents(log7).filter((e) => e.ev === 'request' && e.reused).length, 0);
    check('every stdout line is one complete JSON message', H.rawLines.length, H.messages.length);

    H.close();
    await H.waitExit();
    await until(() => !reg.isAlive(eH.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Serena answers initialize over SSE. Its result event and the stream's end
  // arrive in separate reads, and the session id is in the headers before
  // either. A client writes notifications/initialized and tools/list as soon
  // as it reads the result, so if the relay forwards the result before it has
  // recorded the session, both go out without Mcp-Session-Id: the session's
  // tool list fails, and the edit gate then refuses every edit in it. The fake
  // holds the stream open 100 ms after the result, and this client answers the
  // moment the result line is read, so it lands inside that window.
  console.log('\nserena-relay.cjs — an SSE initialize: the session is recorded before the client sees the reply');
  {
    const repo8 = tmpRepo('eight');
    const log8 = path.join(CONFIG, 'repo8.log');
    allLogs.push(log8);
    const I = new Relay(repo8, fakeCmd(log8, ['--sse-init-end', '100']));
    const initId = ++I.seq;
    const listId = ++I.seq;
    I.initId = initId;
    const initReply = new Promise((resolve) => {
      I.watchers.push((m) => {
        if (m.id !== initId || m.method) return;
        I.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        I.send({ jsonrpc: '2.0', id: listId, method: 'tools/list' });
        resolve(m);
      });
    });
    I.send({ jsonrpc: '2.0', id: initId, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    } });
    const init = await Promise.race([initReply, sleep(10_000).then(() => null)]);
    ok('the SSE initialize is answered', init && init.result && init.result.serverInfo);
    const list = await until(() => I.messages.find((m) => m.id === listId && !m.method), 10_000, 'the tools/list reply')
      .catch(() => null);
    ok('tools/list sent straight after the initialize reply is answered with the tools, not an error',
      list && list.result && Array.isArray(list.result.tools) && list.result.tools.some((t) => t.name === 'echo'));
    const events = logEvents(log8);
    const issued = events.filter((e) => e.ev === 'session').map((e) => e.session);
    const firstEnd = events.findIndex((e) => e.ev === 'init-end');
    const firstNote = events.findIndex((e) => e.ev === 'request' && e.method === 'notifications/initialized');
    // Without this the test could pass on a slow run in which the client's
    // answer only reached the server after the stream had ended anyway.
    ok('notifications/initialized reached the server while the initialize stream was still open',
      firstNote >= 0 && (firstEnd < 0 || firstNote < firstEnd));
    const sent = events.filter((e) => e.ev === 'request' && e.method !== 'initialize')
      .map((e) => `${e.method}:${e.session && e.session === issued[0] ? 'issued session' : `session ${e.session}`}`);
    check('notifications/initialized and tools/list each reached the server once, with the issued session',
      sent, ['notifications/initialized:issued session', 'tools/list:issued session']);

    // The replay after a lost session answers over SSE too. getConn records
    // its session before it hands the connection to the retried request.
    await I.request('tools/call', { name: 'forget_sessions', arguments: {} });
    const mark = logEvents(log8).length;
    const e = await I.echo({ after: 'forget, SSE initialize' });
    ok('the call after the server forgot the session is answered', e.pid);
    const replayed = logEvents(log8).slice(mark);
    const newSession = replayed.filter((x) => x.ev === 'session').map((x) => x.session)[0];
    ok('it ran on the session the replayed initialize opened', newSession && e.session === newSession);
    check('the replayed initialize\'s session was recorded before notifications/initialized and the retried call',
      replayed.filter((x) => x.ev === 'request').map((x) => `${x.method}:${x.known ? 'known' : 'unknown'}`),
      ['tools/call:unknown', 'initialize:unknown', 'notifications/initialized:known', 'tools/call:known']);
    check('the replayed initialize\'s reply is not written to stdout (MUST-NOT)',
      I.messages.filter((m) => m.id === initId && !m.method).length, 1);

    I.close();
    await I.waitExit();
    await until(() => !reg.isAlive(e.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // A relay that respawns a dead server carries the other live clients into
  // the new record. Relay Q has not reconnected yet when P respawns and then
  // exits; were P the record's only client, its exit would stop the server Q
  // is about to use.
  console.log('\nserena-relay.cjs — the live clients are carried over when a relay respawns the server');
  {
    const repo9 = tmpRepo('nine');
    const log9 = path.join(CONFIG, 'repo9.log');
    allLogs.push(log9);
    const key9 = reg.repoKey(repo9).key;
    const cmd9 = fakeCmd(log9);
    const P = new Relay(repo9, cmd9);
    await P.handshake();
    const Q = new Relay(repo9, cmd9);
    await Q.handshake();
    const firstServer = (await P.echo()).pid;
    ok('relays P and Q share one server', firstServer && (await Q.echo()).pid === firstServer);
    const recBefore = reg.read(key9);
    reg.killRecordServer(recBefore);
    await until(() => !reg.isAlive(recBefore.pid), 5000, 'the killed server to exit');
    const eP = await P.echo({ after: 'kill' });
    ok('P\'s next call is answered by a respawned server', eP.pid && eP.pid !== firstServer);
    const recAfter = reg.read(key9);
    check('the new record lists Q, which has not reconnected yet', recAfter && [...recAfter.clients].sort(), [P.pid, Q.pid].sort());
    P.close();
    check('relay P exits on stdin end', (await P.waitExit()).code, 0);
    await sleep(300);
    ok('P, the respawner, exiting first did not stop the server Q is a client of (MUST-NOT)', reg.isAlive(eP.pid));
    const eQ = await Q.echo({ after: 'P closed' });
    check('Q reconnects to the respawned server', eQ.pid, eP.pid);
    check('... without a third server being started (MUST-NOT)', serverPids(log9).length, 2);
    Q.close();
    await Q.waitExit();
    await until(() => !reg.isAlive(eP.pid), 8000, 'the server to stop').catch(() => {});
    check('the last relay closing stopped the respawned server', reg.isAlive(eP.pid), false);
  }

  // ---------------------------------------------------------------------------
  // The fake takes 300 ms to accept notifications/initialized and refuses a
  // request that reaches the session before it, so a relay that lets the
  // client's next request overtake the notification is caught every time.
  console.log('\nserena-relay.cjs — notifications: requests queue behind them, and they never produce a stdout line');
  {
    const repo10 = tmpRepo('ten');
    const log10 = path.join(CONFIG, 'repo10.log');
    allLogs.push(log10);
    const J = new Relay(repo10, fakeCmd(log10, ['--slow-initialized', '300']));
    // A version the server does not support: it answers with its own latest,
    // and every later request must carry what the server chose.
    const init = await J.request('initialize', {
      protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    check('the server answered initialize with the version it chose', init.result && init.result.protocolVersion, '2025-06-18');
    // Back to back, as a client writes them.
    J.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await J.request('tools/list', {});
    ok('tools/list written straight after notifications/initialized is answered with the tools, not refused',
      list.result && Array.isArray(list.result.tools));
    const ev10 = logEvents(log10);
    const accepted = ev10.findIndex((x) => x.ev === 'initialized');
    const listed = ev10.findIndex((x) => x.ev === 'request' && x.method === 'tools/list');
    ok('tools/list reached the server only after it had accepted notifications/initialized', accepted >= 0 && listed > accepted);

    const mark = J.rawLines.length;
    const notes = ['notifications/cancelled', 'notifications/fake_fail', 'notifications/fake_drop'];
    J.send({ jsonrpc: '2.0', method: notes[0], params: { requestId: 999, reason: 'test' } });
    J.send({ jsonrpc: '2.0', method: notes[1] });
    J.send({ jsonrpc: '2.0', method: notes[2] });
    const e = await J.echo({ after: 'notifications' });
    ok('a call written after them is answered', e.pid);
    check('each notification reached the server',
      logEvents(log10).filter((x) => x.ev === 'request' && notes.includes(x.method)).map((x) => x.method), notes);
    check('none produced a stdout line, whether accepted (202), answered HTTP 500, or cut off (MUST-NOT)',
      J.rawLines.slice(mark).filter((l) => { try { return JSON.parse(l).id !== J.seq; } catch { return true; } }), []);
    check('every request after initialize carried the version the server chose, not the one the client asked for',
      logEvents(log10).filter((x) => x.ev === 'request' && x.method !== 'initialize' && x.protocol !== '2025-06-18')
        .map((x) => `${x.method}:${x.protocol}`), []);

    // An HTTP error other than 404 proves nothing about whether the server
    // ran the request, so it is answered, once, and not retried.
    const r500 = await J.request('tools/call', { name: 'http_500', arguments: {} }, 4000).catch(() => null);
    const id500 = J.seq;
    ok('a tool call answered HTTP 500 gets an error reply (MUST-NOT leave the client waiting)',
      r500 && r500.error && /HTTP 500/.test(r500.error.message));
    await sleep(500);
    check('exactly one response line for it', J.messages.filter((m) => m.id === id500 && !m.method).length, 1);
    check('the server got it once (MUST-NOT retry)',
      logEvents(log10).filter((x) => x.ev === 'request' && x.id === id500).length, 1);

    // stdout to a pipe is asynchronous on macOS: whatever the pipe has not
    // taken when the process exits is lost, here most of a 1 MB line. stdin
    // ends while the call is in flight, so the relay exits as soon as it has
    // written the reply.
    const bigId = J.seq + 1;
    J.request('tools/call', { name: 'big', arguments: { size: 1_000_000 } }).catch(() => {});
    J.close();
    const jExit = await J.waitExit();
    check('relay J exits 0 on stdin end, after the call in flight', jExit.code, 0);
    const big = await until(() => J.messages.find((m) => m.id === bigId && !m.method), 3000, 'the big reply').catch(() => null);
    check('the reply written just before exiting reached the client whole',
      big && big.result && big.result.content[0].text.length, 1_000_000);
    check('every stdout line is one complete JSON message', J.rawLines.length, J.messages.length);
    await until(() => !reg.isAlive(e.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // The fake answers initialize over SSE and holds the stream 300 ms, so a
  // replayed initialize is slow; the relay's control timeout is 1.5 s.
  console.log('\nserena-relay.cjs — the replayed initialize: calls wait for it, a failed one is closed, a hung one times out');
  {
    const repo11 = tmpRepo('eleven');
    const log11 = path.join(CONFIG, 'repo11.log');
    allLogs.push(log11);
    const cmd11 = fakeCmd(log11, ['--sse-init-end', '300']);
    const K = new Relay(repo11, cmd11, { SERENA_RELAY_CONTROL_TIMEOUT_MS: '1500' });
    await K.handshake();
    const eK = await K.echo();
    ok('relay K is served', eK.pid);
    const since = (mark) => logEvents(log11).slice(mark);
    const responseLines = (id) => K.messages.filter((m) => m.id === id && !m.method).length;

    // A call written while the replay is under way must wait for it, and go
    // out on the new session, not on the connection being set up.
    await K.request('tools/call', { name: 'forget_sessions', arguments: {} });
    let mark = logEvents(log11).length;
    const first = K.echo({ n: 1 });
    await until(() => since(mark).some((x) => x.ev === 'request' && x.method === 'initialize'), 5000,
      'the replayed initialize to reach the server');
    const second = K.echo({ n: 2 });
    const id2 = K.seq;
    const [r1, r2] = await Promise.all([first, second]);
    ok('the call that found the session lost is answered', r1.pid);
    ok('a call written while the replayed initialize was still streaming is answered too', r2.pid);
    check('one initialize was replayed, not two', since(mark).filter((x) => x.ev === 'request' && x.method === 'initialize').length, 1);
    check('the call written during the replay went out once, on the replayed session (MUST-NOT go out before it)',
      since(mark).filter((x) => x.ev === 'request' && x.id === id2).map((x) => (x.known ? 'known' : x.session ? 'unknown' : 'no session')),
      ['known']);

    // The replay opens a session and then fails: that session is abandoned
    // and must be closed, not left open on the shared server.
    await K.request('tools/call', { name: 'fail_next_initialized', arguments: {} });
    await K.request('tools/call', { name: 'forget_sessions', arguments: {} });
    mark = logEvents(log11).length;
    const failed = await K.request('tools/call', { name: 'echo', arguments: {} }, 5000).catch(() => null);
    const failedId = K.seq;
    ok('a call whose replayed notifications/initialized failed gets an error', failed && failed.error);
    const opened = since(mark).filter((x) => x.ev === 'session').map((x) => x.session);
    check('the replay opened one session', opened.length, 1);
    const deleted = await until(() => since(mark).find((x) => x.ev === 'delete'), 3000, 'a DELETE').catch(() => null);
    ok('the relay closed that session with DELETE rather than leave it open on the server',
      deleted && deleted.session === opened[0] && deleted.known);
    await sleep(300);
    check('exactly one response line for the failed call', responseLines(failedId), 1);
    const next = await K.echo({ after: 'failed replay' });
    ok('the next call reconnects on a fresh session', next.pid && next.session && next.session !== opened[0]);

    // A server that accepts the replayed initialize and never answers.
    await K.request('tools/call', { name: 'hang_next_initialize', arguments: {} });
    await K.request('tools/call', { name: 'forget_sessions', arguments: {} });
    const hung = await K.request('tools/call', { name: 'echo', arguments: {} }, 8000).catch(() => null);
    const hungId = K.seq;
    ok('a call whose replayed initialize is never answered gets an error, not an endless wait',
      hung && hung.error && /timed out/.test(hung.error.message));
    await sleep(300);
    check('exactly one response line for it', responseLines(hungId), 1);
    const again = await K.echo({ after: 'hung replay' }).catch(() => ({}));
    ok('the next call reconnects', again.pid);

    // A notification the server never answers must not hold back every
    // message after it.
    const markLines = K.rawLines.length;
    K.send({ jsonrpc: '2.0', method: 'notifications/fake_hang' });
    const behind = await K.request('tools/call', { name: 'echo', arguments: { after: 'hung notification' } }, 8000).catch(() => null);
    ok('a call queued behind a notification the server never answers is still sent and answered', behind && behind.result);
    check('the hung notification produced no stdout line (MUST-NOT)',
      K.rawLines.slice(markLines).filter((l) => { try { return JSON.parse(l).id !== K.seq; } catch { return true; } }), []);

    // A client request is never timed out, however long its tool runs. The
    // relay cannot tell a tool still running from a wedged server, and an
    // error sent while the tool runs reports as failed a call the server then
    // completes; the at-most-once rule would then forbid the retry the client
    // needs to see its result. Here the tool runs twice the control timeout.
    const long = await K.request('tools/call', { name: 'block', arguments: { ms: 3000 } }, 10_000).catch(() => null);
    ok('a tool call running longer than the control timeout gets its result (MUST-NOT time out a client request)',
      long && long.result);
    check('... exactly once', responseLines(K.seq), 1);

    // An initialize answered 200 with a session id, and then an error, no
    // reply at all, or a stream that breaks after the headers: the session
    // exists on the server, and nothing will ever use it. The relay closes it,
    // and never sends on it. A broken stream is the case that reaches the
    // relay as a failed exchange rather than a finished one, with the session
    // id known only from the headers.
    for (const kind of ['error', 'noreply', 'drop']) {
      await K.request('tools/call', { name: `${kind}_next_initialize`, arguments: {} });
      await K.request('tools/call', { name: 'forget_sessions', arguments: {} });
      mark = logEvents(log11).length;
      const r = await K.request('tools/call', { name: 'echo', arguments: {} }, 5000).catch(() => null);
      ok(`replay, ${kind}: a call whose replayed initialize got no result gets an error`, r && r.error);
      const opened = since(mark).filter((x) => x.ev === 'init-noresult').map((x) => x.session);
      check(`replay, ${kind}: the replayed initialize opened a session with no result`, opened.length, 1);
      const del = await until(() => since(mark).find((x) => x.ev === 'delete'), 3000, 'a DELETE').catch(() => null);
      ok(`replay, ${kind}: the relay closed that session with DELETE`, del && del.session === opened[0] && del.known);
      const next = await K.echo({ after: `replay ${kind}` }).catch(() => ({}));
      ok(`replay, ${kind}: the next call reconnects on a fresh session (MUST-NOT use the one with no result)`,
        next.pid && next.session && next.session !== opened[0]);
    }
    // The same, for the client's own initialize: a new relay joining K's server.
    for (const kind of ['error', 'noreply', 'drop']) {
      await K.request('tools/call', { name: `${kind}_next_initialize`, arguments: {} });
      mark = logEvents(log11).length;
      const Y = new Relay(repo11, cmd11, { SERENA_RELAY_CONTROL_TIMEOUT_MS: '1500' });
      const bad = await Y.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
      }, 5000).catch(() => null);
      ok(`client, ${kind}: an initialize answered with no result gets an error reply`, bad && bad.error);
      const opened = since(mark).filter((x) => x.ev === 'init-noresult').map((x) => x.session);
      check(`client, ${kind}: that initialize opened a session with no result`, opened.length, 1);
      const del = await until(() => since(mark).find((x) => x.ev === 'delete'), 3000, 'a DELETE').catch(() => null);
      ok(`client, ${kind}: the relay closed that session with DELETE`, del && del.session === opened[0] && del.known);
      const good = await Y.handshake().catch(() => null);
      ok(`client, ${kind}: the client's next initialize succeeds`, good && good.result);
      check(`client, ${kind}: the next initialize went out with no session (MUST-NOT record the one with no result)`,
        since(mark).filter((x) => x.ev === 'request' && x.method === 'initialize').map((x) => x.session), [null, null]);
      const eY = await Y.echo().catch(() => ({}));
      ok(`client, ${kind}: calls then run on the new session`, eY.pid === eK.pid && eY.session && eY.session !== opened[0]);
      Y.close();
      await Y.waitExit();
    }

    K.close();
    await K.waitExit();
    await until(() => !reg.isAlive(eK.pid), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Serena's tools block its event loop, so while one session's tool runs the
  // shared server answers no HTTP at all, a readiness probe included. A relay
  // starting in another session at that moment must wait, however long its
  // own ready timeout, and must never stop the server: it is serving L. Its
  // connection is accepted into the listen backlog, which is how it can tell
  // "listening but busy" from "not listening".
  console.log('\nserena-relay.cjs — a server busy in a tool call is waited on, never stopped');
  {
    const repo12 = tmpRepo('twelve');
    const log12 = path.join(CONFIG, 'repo12.log');
    allLogs.push(log12);
    const cmd12 = fakeCmd(log12);
    const events = (ev) => logEvents(log12).filter((x) => x.ev === ev);
    const L = new Relay(repo12, cmd12);
    await L.handshake();
    const server = (await L.echo()).pid;
    ok('relay L is served', server);

    const blocked = L.request('tools/call', { name: 'block', arguments: { ms: 4500 } }, 20_000).catch(() => null);
    await until(() => events('block-start').length === 1, 5000, 'the block to start');
    // A third of the block: long enough to see the server accept its probe,
    // far too short for the server to answer it.
    const markM = logEvents(log12).length;
    const M = new Relay(repo12, cmd12, { SERENA_RELAY_READY_TIMEOUT_MS: '1500' });
    const eM = await M.handshake().then(() => M.echo({ after: 'block' })).catch(() => ({}));
    const lBlock = await blocked;
    ok('L\'s tool call ran to its end and got its result', lBlock && lBlock.result);
    check('the block ran to its end, once', events('block-end').length, 1);
    ok('the busy server was not stopped (MUST-NOT)', reg.isAlive(server));
    check('M, started during the block with a shorter ready timeout, is answered by that same server', eM.pid, server);
    check('exactly one server listened for the repository (MUST-NOT start a second)', serverPids(log12).length, 1);
    // M waited on the busy server for most of the block, ~30 probe ticks. One
    // probe stays open across all of them: a relay that opened another every
    // tick would put ten a second into the listen backlog, and fill Serena's
    // 128 slots in about 13 s. Every probe it left open is answered once the
    // block ends, before M's initialize, which queued behind them.
    check('M sent one readiness probe for its whole wait, not one per tick (MUST-NOT pile them into the backlog)',
      logEvents(log12).slice(markM).filter((x) => x.ev === 'bodiless' && x.session === 'serena-relay-readiness-probe').length, 1);

    // Silent for longer than the control timeout, the server is given up on
    // for now: the relay answers the client with an error, and neither stops
    // the server nor starts another. The client's next message tries again.
    // The block lasts until the marker is written, not for a fixed time: N's
    // error comes one control timeout after N has started, and a node startup
    // slowed by load would otherwise let a fixed block end first. `ms` only
    // bounds it, should the test abort before writing the marker.
    const release2 = path.join(CONFIG, 'block2.release');
    const blocked2 = L.request('tools/call', { name: 'block', arguments: { ms: 30_000, until: release2 } }, 40_000).catch(() => null);
    await until(() => events('block-start').length === 2, 5000, 'the second block to start');
    const N = new Relay(repo12, cmd12, { SERENA_RELAY_READY_TIMEOUT_MS: '1000', SERENA_RELAY_CONTROL_TIMEOUT_MS: '1500' });
    const early = await N.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }, 15_000).catch(() => null);
    ok('N\'s initialize, while the server stays silent past N\'s control timeout, gets an error', early && early.error);
    check('... while the block is still running', events('block-end').length, 1);
    ok('the silent server was left running (MUST-NOT stop it)', reg.isAlive(server));
    fs.writeFileSync(release2, '');
    ok('L\'s second tool call ran to its end and got its result', (await blocked2) && events('block-end').length === 2);
    const late = await N.handshake().catch(() => null);
    ok('N\'s next initialize, once the server is free, succeeds', late && late.result);
    const eN = await N.echo().catch(() => ({}));
    check('N is answered by the same server', eN.pid, server);
    check('still exactly one server for the repository (MUST-NOT)', serverPids(log12).length, 1);

    // A relay ended by a signal closes its own session too, as the server
    // stays up for L and N.
    const markTerm = logEvents(log12).length;
    M.child.kill('SIGTERM');
    check('relay M exits on SIGTERM', (await M.waitExit()).code, 0);
    check('relay M closed its own session with DELETE before it exited, and no other',
      logEvents(log12).slice(markTerm).filter((x) => x.ev === 'delete').map((x) => x.session === eM.session && x.known), [true]);
    N.close();
    await N.waitExit();
    L.close();
    await L.waitExit();
    await until(() => !reg.isAlive(server), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // The same, once the busy server's listen backlog is full. On loopback a
  // port nobody listens on refuses a connect at once; a connect that is left
  // pending instead has had its SYN dropped by a full accept queue, which only
  // a listening socket has. Serena's fills once 128 connects (macOS's
  // kern.ipc.somaxconn) queue behind a long tool call. The fake listens with a
  // backlog of 1 here, and the fillers are this suite's own sockets.
  console.log('\nserena-relay.cjs — a busy server with a full listen backlog is waited on, never stopped');
  {
    const repo14 = tmpRepo('fourteen');
    const log14 = path.join(CONFIG, 'repo14.log');
    allLogs.push(log14);
    const cmd14 = fakeCmd(log14, ['--backlog', '1']);
    const events = (ev) => logEvents(log14).filter((x) => x.ev === ev);
    const L = new Relay(repo14, cmd14);
    await L.handshake();
    const server = (await L.echo()).pid;
    ok('relay L is served', server);
    const { port } = reg.read(reg.repoKey(repo14).key);

    const fillers = [];
    const connectTo = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('error', () => { /* reset when the server is stopped; reported by the checks */ });
      fillers.push(s);
      return s;
    };
    try {
      const blocked = L.request('tools/call', { name: 'block', arguments: { ms: 5000 } }, 30_000).catch(() => null);
      await until(() => events('block-start').length === 1, 5000, 'the block to start');
      for (let i = 0; i < 8; i++) connectTo();
      await sleep(300);
      // The premise: were this connect to complete, the relay's probe would
      // too, and the test would only repeat the one above.
      const extra = connectTo();
      let extraConnected = false;
      extra.once('connect', () => { extraConnected = true; });
      await sleep(300);
      ok('the backlog is full: a further connect is left pending, neither connected nor refused',
        !extraConnected && !extra.destroyed);
      extra.destroy();

      const M = new Relay(repo14, cmd14, { SERENA_RELAY_READY_TIMEOUT_MS: '1500' });
      const mInit = M.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
      }, 30_000).catch(() => null);
      // Twice M's ready timeout, and still inside the block.
      await sleep(3000);
      check('... the block is still running', events('block-end').length, 0);
      ok('the busy server, its backlog full, was not stopped past M\'s ready timeout (MUST-NOT)', reg.isAlive(server));
      check('no second server was started meanwhile (MUST-NOT)', serverPids(log14).length, 1);

      const lBlock = await blocked;
      ok('L\'s tool call ran to its end and got its result', lBlock && lBlock.result);
      const init = await mInit;
      ok('M\'s initialize, sent while the backlog was full, succeeds once the block ends', init && init.result);
      M.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const eM = await M.echo().catch(() => ({}));
      check('M is answered by that same server', eM.pid, server);
      check('exactly one server listened for the repository (MUST-NOT start a second)', serverPids(log14).length, 1);
      M.close();
      await M.waitExit();
    } finally {
      for (const s of fillers) s.destroy();
    }
    L.close();
    await L.waitExit();
    await until(() => !reg.isAlive(server), 8000, 'the server to stop').catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Once a relay has started to shut down it has left the record, and it
  // stops the server if it was the last client. A request still in flight
  // then finds the server gone; were it to reconnect, it would start a new
  // server and register a relay that is about to exit, leaking both. The
  // client stops reading, so the flush on stdin end lasts all of FLUSH_MS; a
  // notification the server never answers holds an echo back until the
  // server is stopped under it.
  console.log('\nserena-relay.cjs — a relay shutting down never reconnects or starts a server');
  {
    const repo13 = tmpRepo('thirteen');
    const log13 = path.join(CONFIG, 'repo13.log');
    allLogs.push(log13);
    const key13 = reg.repoKey(repo13).key;
    const Z = new Relay(repo13, fakeCmd(log13));
    await Z.handshake();
    const eZ = await Z.echo();
    ok('relay Z is served', eZ.pid);
    Z.child.stdout.pause();
    Z.send({ jsonrpc: '2.0', id: ++Z.seq, method: 'tools/call', params: { name: 'big', arguments: { size: 4_000_000 } } });
    Z.send({ jsonrpc: '2.0', method: 'notifications/fake_hang' });
    Z.send({ jsonrpc: '2.0', id: ++Z.seq, method: 'tools/call', params: { name: 'echo', arguments: { after: 'hang' } } });
    await until(() => logEvents(log13).some((x) => x.ev === 'request' && x.method === 'notifications/fake_hang'), 5000,
      'the hanging notification to reach the server');
    Z.close();
    const zExit = await Z.waitExit(20_000);
    check('relay Z exits 0', zExit.code, 0);
    check('exactly one server was ever started for the repository (MUST-NOT start one while shutting down)',
      serverPids(log13).length, 1);
    const rec = reg.read(key13);
    ok('relay Z\'s pid is not in the record (MUST-NOT register while shutting down)', !rec || !rec.clients.includes(Z.pid));
    ok('Z, the last client, stopped the server', !reg.isAlive(eZ.pid));
    Z.child.stdout.resume();
  }

  // ---------------------------------------------------------------------------
  // A signal that arrives while stdin end's flush is still under way exits at
  // once: the cleanup is already done, and a client that signals is not
  // reading what is left. Here the client stops reading, so the flush of a
  // 4 MB reply would otherwise hold the relay for the rest of FLUSH_MS (5 s).
  console.log('\nserena-relay.cjs — a signal during the flush on stdin end exits at once');
  {
    const repo15 = tmpRepo('fifteen');
    const log15 = path.join(CONFIG, 'repo15.log');
    allLogs.push(log15);
    const W = new Relay(repo15, fakeCmd(log15));
    await W.handshake();
    const eW = await W.echo();
    ok('relay W is served', eW.pid);
    W.child.stdout.pause();
    const bigId = ++W.seq;
    W.send({ jsonrpc: '2.0', id: bigId, method: 'tools/call', params: { name: 'big', arguments: { size: 4_000_000 } } });
    await until(() => logEvents(log15).some((x) => x.ev === 'request' && x.id === bigId), 5000, 'the big call to reach the server');
    W.close();
    // W is the last client, so its shutdown stops the server first and then
    // waits on the flush.
    const stopped = await until(() => !reg.isAlive(eW.pid), 5000, 'W to stop its server').catch(() => false);
    ok('W began shutting down: as the last client it stopped the server', stopped);
    await sleep(300);
    ok('... and it is still running, held by the flush of a reply nobody reads',
      W.child.exitCode === null && W.child.signalCode === null);
    const t0 = Date.now();
    W.child.kill('SIGTERM');
    const wExit = await W.waitExit(8000);
    const took = Date.now() - t0;
    check('relay W exits 0 on SIGTERM during the flush', wExit.code, 0);
    ok(`... at once, not after the rest of the flush window (MUST-NOT wait it out; took ${took} ms)`,
      !wExit.timeout && took < 1500);
    W.child.stdout.resume();
  }

  // ---------------------------------------------------------------------------
  // A session belongs to one repository, A, and A's Serena cannot look at a
  // file anywhere else. A call whose relative_path is absolute, or escapes A's
  // root, goes to the shared server of the repository that path is in, opened
  // on first use, with the path made relative to that repository's root.
  // Every server here comes from one command; `--root {root}` makes each log
  // line and each echo name the repository its server was started for. Roots
  // are compared as realpaths: os.tmpdir() lies under /var, a symlink to
  // /private/var on macOS, and repoKey resolves it.
  console.log('\nserena-relay.cjs — a call is routed by its path to the repository it names');
  {
    const repoA = tmpRepo('route-a');
    const repoB = tmpRepo('route-b');
    // A /ship worktree sits beside its repository as `<repo>-<name>`: its
    // path starts with A's, as a string, and it is not inside A.
    const sibling = `${repoA}-wt`;
    fs.mkdirSync(sibling);
    trash.push(sibling);
    execFileSync('git', ['init', '-q', sibling]);
    const [realA, realB, realSib] = [repoA, repoB, sibling].map((d) => fs.realpathSync(d));
    ok('the fixture repositories are three different directories, B and the sibling outside A',
      new Set([realA, realB, realSib]).size === 3 && !realB.startsWith(`${realA}${path.sep}`) && realSib.startsWith(realA));
    const logR = path.join(CONFIG, 'route.log');
    allLogs.push(logR);
    const cmdR = fakeCmd(logR, ['--root', '{root}']);
    const at = (root, ev) => logEvents(logR).filter((x) => x.root === root && (!ev || x.ev === ev));
    const keyB = reg.repoKey(repoB).key;
    const keySib = reg.repoKey(sibling).key;
    const responses = (r, id) => r.messages.filter((m) => m.id === id && !m.method);

    const P = new Relay(repoA, cmdR);
    await P.handshake();
    const rel = await P.echo({ relative_path: 'src/x.cjs' });
    check('a relative path inside A is answered by A\'s server', rel.root, realA);
    check('... with the path unchanged', rel.args, { relative_path: 'src/x.cjs' });
    const none = await P.echo({ n: 1 });
    check('a call with no path is answered by A\'s server', none.root, realA);
    check('... with its arguments unchanged', none.args, { n: 1 });
    check('no server was started for B yet: secondary targets open on first use (MUST-NOT)', reg.read(keyB), null);

    // repoB as os.tmpdir() gave it, not its realpath: the relay must resolve it.
    const abs = await P.echo({ relative_path: path.join(repoB, 'src', 'y.cjs'), n: 2 });
    check('an absolute path into B is answered by B\'s server', abs.root, realB);
    check('... with the path rewritten relative to B\'s root, other arguments unchanged',
      abs.args, { relative_path: path.join('src', 'y.cjs'), n: 2 });
    ok('B\'s server is not A\'s', abs.pid && abs.pid !== rel.pid);
    check('B\'s record names that server', reg.read(keyB) && reg.read(keyB).pid, abs.pid);
    ok('the relay registered as a client of B', reg.read(keyB) && reg.read(keyB).clients.includes(P.pid));
    ok('B\'s session is B\'s own, not A\'s (MUST-NOT share it)', abs.session && abs.session !== rel.session);
    const up = await P.echo({ relative_path: path.join('..', path.basename(repoB), 'z.cjs') });
    check('a relative path that escapes A into B is answered by B\'s server', up.root, realB);
    check('... with the path rewritten relative to B\'s root', up.args, { relative_path: 'z.cjs' });
    check('... on the same session as before', up.session, abs.session);
    const dir = await P.echo({ relative_path: repoB });
    check('B\'s root itself, a directory, is answered by B\'s server, not its parent\'s', dir.root, realB);
    check('... as "." (the project root)', dir.args, { relative_path: '.' });
    const inside = await P.echo({ relative_path: path.join(repoA, 'src', 'a.cjs') });
    check('an absolute path inside A is answered by A\'s server', inside.root, realA);
    check('... made relative to A\'s root', inside.args, { relative_path: path.join('src', 'a.cjs') });

    check('B got exactly one initialize for the whole session',
      at(realB, 'request').filter((x) => x.method === 'initialize').length, 1);
    check('B got the handshake replayed, then the calls, all on the session it issued',
      at(realB, 'request').map((x) => `${x.method}:${x.known ? 'known' : 'unknown'}`),
      ['initialize:unknown', 'notifications/initialized:known', 'tools/call:known', 'tools/call:known', 'tools/call:known']);
    check('B\'s replayed initialize carried the client\'s own id',
      at(realB, 'request').filter((x) => x.method === 'initialize').map((x) => x.id), [P.initId]);
    ok('the relay logs B\'s first connection as an open, not a reconnect',
      P.stderr.includes(`opened a session on server ${abs.pid} for ${realB}`) && !/reconnected/.test(P.stderr));
    check('B\'s handshake reply did not reach stdout: one initialize reply, A\'s (MUST-NOT)',
      responses(P, P.initId).length, 1);
    check('every reply on stdout answers a request the client sent, once',
      P.messages.filter((m) => !m.method).map((m) => m.id), Array.from({ length: P.seq }, (_, i) => i + 1));
    check('every stdout line is one complete JSON message', P.rawLines.length, P.messages.length);
    check('A saw none of the calls routed to B (MUST-NOT)',
      at(realA, 'request').filter((x) => x.tool === 'echo').length, 3);

    // The note tells agents they may pass an absolute path: on the tools
    // that take relative_path, and on no other.
    const list = await P.request('tools/list', {});
    const tool = (n) => list.result && list.result.tools.find((x) => x.name === n);
    ok('tools/list is answered by A\'s server', at(realA, 'request').some((x) => x.id === list.id && x.method === 'tools/list'));
    ok('a tool that takes relative_path has the routing sentence appended to its description',
      tool('echo') && /^Echoes its arguments\. \S.*absolute path/.test(tool('echo').description));
    check('a tool without relative_path keeps its description (MUST-NOT)', tool('forget_sessions') && tool('forget_sessions').description, undefined);

    // At most once, on B as on A: a reply broken mid-stream is not retried.
    const markDrop = logEvents(logR).length;
    const drop = await P.request('tools/call',
      { name: 'progress_then_drop', arguments: { relative_path: path.join(repoB, 'd.cjs') } }, 4000).catch(() => null);
    const dropId = P.seq;
    await sleep(1000);
    ok('a call to B whose reply broke mid-stream gets a reply (MUST-NOT leave it waiting)', drop);
    check('... exactly one, and it is an error', responses(P, dropId).map((m) => (m.error ? 'error' : 'result')), ['error']);
    check('B ran the tool once (MUST-NOT retry)',
      logEvents(logR).slice(markDrop).filter((x) => x.ev === 'request' && x.id === dropId && x.tool === 'progress_then_drop').map((x) => x.root), [realB]);
    check('every request reached B on a fresh connection (MUST-NOT reuse sockets)',
      at(realB, 'request').filter((x) => x.reused).length, 0);

    // A second session in A that also routes to B joins B's server.
    const Q = new Relay(repoA, cmdR);
    await Q.handshake();
    const qB = await Q.echo({ relative_path: path.join(repoB, 'q.cjs') });
    check('a second relay in A that routes to B is answered by the same B server', [qB.root, qB.pid], [realB, abs.pid]);
    ok('... on a session of its own', qB.session && qB.session !== abs.session);
    check('one server listened for B (MUST-NOT start a second)', at(realB, 'listen').length, 1);
    check('both relays are clients of B', reg.read(keyB) && [...reg.read(keyB).clients].sort(), [P.pid, Q.pid].sort());
    check('both relays are clients of A too', [...reg.read(reg.repoKey(repoA).key).clients].sort(), [P.pid, Q.pid].sort());

    // A busy B is waited on, never stopped: a relay opening it while a tool
    // call blocks it, with a ready timeout shorter than the block.
    const blocked = P.request('tools/call', { name: 'block', arguments: { ms: 4500, relative_path: path.join(repoB, 'b.cjs') } }, 20_000).catch(() => null);
    ok('the block started on B', await until(() => at(realB, 'block-start').length === 1, 5000, 'the block on B to start').catch(() => false));
    const R = new Relay(repoA, cmdR, { SERENA_RELAY_READY_TIMEOUT_MS: '1500' });
    await R.handshake();
    const rB = await R.echo({ relative_path: path.join(repoB, 'r.cjs') }).catch(() => ({}));
    ok('the blocked call on B ran to its end and got its result', (await blocked) && at(realB, 'block-end').length === 1);
    check('a relay that opened B during the block is answered by that same B server', [rB.root, rB.pid], [realB, abs.pid]);
    ok('the busy B server was not stopped (MUST-NOT)', reg.isAlive(abs.pid));
    check('still one server for B (MUST-NOT start a second)', at(realB, 'listen').length, 1);

    // The sibling `<A>-wt` is its own repository, absolute or relative.
    const sibAbs = await P.echo({ relative_path: path.join(sibling, 'w.cjs') });
    check('an absolute path into the sibling <A>-wt is answered by the sibling\'s own server', sibAbs.root, realSib);
    check('... with the path rewritten relative to the sibling\'s root', sibAbs.args, { relative_path: 'w.cjs' });
    const sibRel = await P.echo({ relative_path: path.join('..', path.basename(sibling), 'v.cjs') });
    check('a relative path into the sibling <A>-wt is outside A: answered by the sibling\'s server (MUST-NOT A\'s)', sibRel.root, realSib);
    check('... with the path rewritten relative to the sibling\'s root', sibRel.args, { relative_path: 'v.cjs' });
    check('one server listened for the sibling', at(realSib, 'listen').length, 1);
    check('A\'s server listened once and ran no call meant for B or the sibling (MUST-NOT)',
      [at(realA, 'listen').length, at(realA, 'request').filter((x) => x.tool === 'echo').length], [1, 3]);

    for (const r of [P, Q, R]) r.close();
    for (const r of [P, Q, R]) check(`relay ${r === P ? 'P' : r === Q ? 'Q' : 'R'} exits 0 on stdin end`, (await r.waitExit()).code, 0);
    // The last relay to leave each secondary repository stops its server. A
    // server still running is stopped here all the same, through the record a
    // relay of this suite wrote, so a failure does not leave it to the sweep.
    for (const [name, key] of [['B', keyB], ['the sibling <A>-wt', keySib]]) {
      const rec = reg.read(key);
      const stopped = !!rec && await until(() => !reg.isAlive(rec.pid), 8000, `${name}'s server to stop`).catch(() => false);
      ok(`the last relay to leave ${name} stopped its server`, stopped);
      if (rec && reg.isAlive(rec.pid)) reg.killRecordServer(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // A root with no .serena/project.yml gets one written, with every language
  // it actually has, before its server is ever spawned -- whether it is a
  // routed secondary target (a /ship worktree: no session ever starts there,
  // so no SessionStart hook ever writes its config) or the session's own
  // root. Left alone once the file exists at all, whatever it contains.
  console.log('\nserena-relay.cjs — a root with no .serena/project.yml gets the full language list before its server starts');
  {
    const files = { 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' };

    // A routed secondary target: repoA is the session's own root, mixed is
    // reached only through an absolute relative_path, the way a /ship
    // worktree is -- no session ever starts in it.
    const repoA = tmpRepo('config-a');
    const mixed = tmpRepo('config-mixed', files);
    const realMixed = fs.realpathSync(mixed);
    const ymlMixed = path.join(mixed, '.serena', 'project.yml');
    check('the routed repository starts with no Serena config', fs.existsSync(ymlMixed), false);

    const logM = path.join(CONFIG, 'config-mixed.log');
    allLogs.push(logM);
    const cmdM = fakeCmd(logM, ['--root', '{root}']);
    const keyMixed = reg.repoKey(mixed).key;

    const P = new Relay(repoA, cmdM);
    await P.handshake();
    const routed = await P.echo({ relative_path: path.join(mixed, 'x.cjs') });
    check('the routed call reaches the mixed repository\'s own server', routed.root, realMixed);
    check('its config was written before that server was ever spawned', fs.existsSync(ymlMixed), true);
    check('...listing every language actually present, not only the dominant one',
      serversIn(ymlMixed), ['python', 'typescript']);
    P.close();
    check('relay P exits 0', (await P.waitExit()).code, 0);
    const recMixed = reg.read(keyMixed);
    if (recMixed && reg.isAlive(recMixed.pid)) reg.killRecordServer(recMixed);

    // The session's own root, the same way: nothing about this is specific
    // to a routed target.
    const own = tmpRepo('config-own', files);
    const ymlOwn = path.join(own, '.serena', 'project.yml');
    check('the session\'s own repository starts with no Serena config', fs.existsSync(ymlOwn), false);
    const logO = path.join(CONFIG, 'config-own.log');
    allLogs.push(logO);
    const Q = new Relay(own, fakeCmd(logO, ['--root', '{root}']));
    await Q.handshake();
    check('its own config is also written before its server starts', fs.existsSync(ymlOwn), true);
    check('...listing every language actually present', serversIn(ymlOwn), ['python', 'typescript']);
    Q.close();
    check('relay Q exits 0', (await Q.waitExit()).code, 0);

    // MUST NOT overwrite a config that already exists, whatever it lists --
    // matching repo-setup.cjs's own rule, which this reuses rather than
    // duplicates.
    const already = tmpRepo('config-existing', files);
    fs.mkdirSync(path.join(already, '.serena'), { recursive: true });
    const ymlAlready = path.join(already, '.serena', 'project.yml');
    const before = 'project_name: "x"\nlanguage_servers:\n- python\n';
    fs.writeFileSync(ymlAlready, before);
    const logE = path.join(CONFIG, 'config-existing.log');
    allLogs.push(logE);
    const R = new Relay(already, fakeCmd(logE, ['--root', '{root}']));
    await R.handshake();
    check('an existing config is left exactly as it was (MUST-NOT overwrite)',
      fs.readFileSync(ymlAlready, 'utf8'), before);
    R.close();
    check('relay R exits 0', (await R.waitExit()).code, 0);

    // Proves the ORDERING, not just the eventual outcome: the server's own
    // command sees the config on disk the moment it is exec'd, before it has
    // answered anything. A relay that wrote the config only after spawning
    // (or only after recording the server) would still pass every check
    // above, because those all read the filesystem after the handshake
    // completes.
    const ordered = tmpRepo('config-ordering', files);
    const ymlOrdered = path.join(ordered, '.serena', 'project.yml');
    const markerOrdered = path.join(CONFIG, 'config-ordering.marker');
    const logOrdered = path.join(CONFIG, 'config-ordering.log');
    allLogs.push(logOrdered);
    const N = new Relay(ordered, fakeCmdRecordingConfig(logOrdered, markerOrdered));
    await N.handshake();
    check('the config exists once the handshake is done', fs.existsSync(ymlOrdered), true);
    ok('the marker file was written by the server\'s own exec',
      fs.existsSync(markerOrdered));
    check('...and it saw the config already there at the moment it was exec\'d',
      fs.readFileSync(markerOrdered, 'utf8').trim(), 'present');
    N.close();
    check('relay N exits 0', (await N.waitExit()).code, 0);
  }

  // ---------------------------------------------------------------------------
  // ensureProjectConfig applies the SessionStart hook's own preconditions for
  // writing a config, not only its detection and writing: an
  // opt-out, and a command that will not even start. Writing the config
  // regardless would gate a repository with no way to satisfy the gate.
  console.log('\nserena-relay.cjs — a config is not written when the hook would not have written one either');
  {
    const files = { 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' };

    // The chosen command cannot start at all: the relay's own precondition
    // ("will the command it is about to spawn resolve") must fail closed
    // here exactly as repo-setup.cjs's uvxOnPath does for a missing uvx --
    // whether or not SERENA_RELAY_SERVER_CMD is in play.
    const noCmd = tmpRepo('config-no-cmd', files);
    const ymlNoCmd = path.join(noCmd, '.serena', 'project.yml');
    const logNoCmd = path.join(CONFIG, 'config-no-cmd.log');
    allLogs.push(logNoCmd);
    const badCmd = JSON.stringify(['/definitely/does/not/exist/on/this/machine']);
    const K = new Relay(noCmd, badCmd);
    const initK = await K.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }, 8000).catch(() => null);
    ok('the client\'s initialize gets an error: the server command could not start',
      initK && initK.error && /could not start the server command/.test(initK.error.message));
    check('no config was written for a command that cannot start (MUST-NOT)',
      fs.existsSync(ymlNoCmd), false);
    K.close();
    check('relay K exits 0', (await K.waitExit()).code, 0);

    // CLAUDE_NO_AUTO_REPO_SETUP=1 opts a repository out of the SessionStart
    // hook's writes (SETUP.md); the relay must honour the same opt-out
    // rather than writing anyway. Uses a command that DOES start, so the
    // only thing that could stop the write is the opt-out itself.
    const optOut = tmpRepo('config-opt-out', files);
    const ymlOptOut = path.join(optOut, '.serena', 'project.yml');
    const logOptOut = path.join(CONFIG, 'config-opt-out.log');
    allLogs.push(logOptOut);
    const L = new Relay(optOut, fakeCmd(logOptOut, ['--root', '{root}']), { CLAUDE_NO_AUTO_REPO_SETUP: '1' });
    await L.handshake();
    const echoL = await L.echo();
    check('the opted-out repository\'s own server still starts', echoL.root, fs.realpathSync(optOut));
    check('...but no config was written for it (MUST-NOT)', fs.existsSync(ymlOptOut), false);
    L.close();
    check('relay L exits 0', (await L.waitExit()).code, 0);

    // ensureProjectConfig only writes for a root hasProjectMarker calls a
    // repository. A session's own root with neither `.git` nor an existing
    // `.serena/project.yml` is still opened, with no --project flag at all
    // (route's "own" case for exactly this root; see hasProjectMarker's own
    // comment), and must get no config written for it, however many
    // supported-language files it has.
    const noMarker = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-nomarker-'));
    trash.push(noMarker);
    fs.writeFileSync(path.join(noMarker, 'main.py'), 'x = 1\n');
    const ymlNoMarker = path.join(noMarker, '.serena', 'project.yml');
    const logNoMarker = path.join(CONFIG, 'config-no-marker.log');
    allLogs.push(logNoMarker);
    const Q = new Relay(noMarker, fakeCmd(logNoMarker, ['--root', '{root}']));
    await Q.handshake();
    const echoQ = await Q.echo();
    check('a root with neither .git nor .serena/project.yml still gets its own server',
      echoQ.root, fs.realpathSync(noMarker));
    check('...but no config was written for the root with no marker (MUST-NOT)', fs.existsSync(ymlNoMarker), false);
    Q.close();
    check('relay Q (no marker) exits 0', (await Q.waitExit()).code, 0);
  }

  // ---------------------------------------------------------------------------
  // A .serena/project.yml the relay writes where .serena/ is not git-ignored shows
  // as untracked. The first successful tools/call result from that target afterward
  // carries one extra {type: "text"} notice; an ignored .serena/, a pre-existing
  // config, or an error result get none.
  //
  // Isolated from the operator's own git configuration -- a global
  // excludesFile, an XDG ~/.config/git/ignore entry for `.serena/` (this
  // repository's own SETUP.md has colleagues add exactly that), or the system
  // gitconfig (`git config --system`) -- any of which would make every root
  // look ignored regardless of the fixture, hiding the case under test entirely.
  console.log('\nserena-relay.cjs — a config written where .serena/ is not git-ignored gets a notice');
  {
    const files = { 'app/main.py': 'x = 1\n' };
    const xdgEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-empty-'));
    trash.push(xdgEmpty);
    const gitIsolation = { GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: xdgEmpty, GIT_CONFIG_NOSYSTEM: '1' };

    const notIgnored = tmpRepo('notice-not-ignored', files);
    const ymlNI = path.join(notIgnored, '.serena', 'project.yml');
    const logNI = path.join(CONFIG, 'notice-not-ignored.log');
    allLogs.push(logNI);
    const M = new Relay(notIgnored, fakeCmd(logNI, ['--root', '{root}']), gitIsolation);
    await M.handshake();
    const first = await M.request('tools/call', { name: 'echo', arguments: {} });
    ok('the config was written', fs.existsSync(ymlNI));
    check('the first successful result carries the echo content plus the notice',
      first.result && first.result.content.length, 2);
    const notice = first.result && first.result.content && first.result.content[1];
    ok('the notice names the file the relay wrote and says why it is untracked',
      notice && notice.type === 'text' && notice.text.includes(ymlNI) && /not git-ignored/.test(notice.text));
    const second = await M.request('tools/call', { name: 'echo', arguments: {} });
    check('the second call gets no notice: it appeared exactly once',
      second.result && second.result.content.length, 1);
    M.close();
    check('relay M exits 0', (await M.waitExit()).code, 0);

    // .serena/ is git-ignored in this repository's own .gitignore: no
    // notice, ever.
    const ignored = tmpRepo('notice-ignored', files);
    fs.writeFileSync(path.join(ignored, '.gitignore'), '.serena/\n');
    const ymlIgn = path.join(ignored, '.serena', 'project.yml');
    const logIgn = path.join(CONFIG, 'notice-ignored.log');
    allLogs.push(logIgn);
    const N = new Relay(ignored, fakeCmd(logIgn, ['--root', '{root}']), gitIsolation);
    await N.handshake();
    ok('the config was written', fs.existsSync(ymlIgn));
    const ignEcho = await N.request('tools/call', { name: 'echo', arguments: {} });
    check('a git-ignored .serena/ gets no notice (MUST-NOT)', ignEcho.result && ignEcho.result.content.length, 1);
    N.close();
    check('relay N exits 0', (await N.waitExit()).code, 0);

    // A pre-existing project.yml: ensureProjectConfig writes nothing, so
    // there is nothing to notice about.
    const already = tmpRepo('notice-existing', files);
    fs.mkdirSync(path.join(already, '.serena'), { recursive: true });
    fs.writeFileSync(path.join(already, '.serena', 'project.yml'), 'project_name: "x"\nlanguage_servers:\n- python\n');
    const logAl = path.join(CONFIG, 'notice-existing.log');
    allLogs.push(logAl);
    const O = new Relay(already, fakeCmd(logAl, ['--root', '{root}']), gitIsolation);
    await O.handshake();
    const alEcho = await O.request('tools/call', { name: 'echo', arguments: {} });
    check('an already-configured repository gets no notice (MUST-NOT)', alEcho.result && alEcho.result.content.length, 1);
    O.close();
    check('relay O exits 0', (await O.waitExit()).code, 0);

    // An error result -- isError: true, or a JSON-RPC error -- gets no
    // notice, and the notice waits for the next successful result.
    const errFirst = tmpRepo('notice-error-first', files);
    const logErr = path.join(CONFIG, 'notice-error-first.log');
    allLogs.push(logErr);
    const P = new Relay(errFirst, fakeCmd(logErr, ['--root', '{root}']), gitIsolation);
    await P.handshake();
    const isErrorResult = await P.request('tools/call', { name: 'iserror', arguments: {} });
    check('a result with isError: true gets no notice (MUST-NOT)',
      isErrorResult.result && isErrorResult.result.content.length, 1);
    const rpcErrResult = await P.request('tools/call', { name: 'rpc_error', arguments: {} });
    ok('a JSON-RPC error result carries no notice (there is no result to attach it to)',
      rpcErrResult.error && !rpcErrResult.result);
    const success = await P.request('tools/call', { name: 'echo', arguments: {} });
    check('the notice reaches the next successful result instead',
      success.result && success.result.content.length, 2);
    P.close();
    check('relay P exits 0', (await P.waitExit()).code, 0);

    // A tools/list reply lists tool schemas; the notice is a
    // {type: "text"} content item, which only a tools/call result has
    // anywhere to hold it (see forwardTo's isCall guard). The pending
    // notice must still be there afterward, for the session's first
    // tools/call.
    const listTarget = tmpRepo('notice-not-list', files);
    const ymlList = path.join(listTarget, '.serena', 'project.yml');
    const logList = path.join(CONFIG, 'notice-not-list.log');
    allLogs.push(logList);
    const Q = new Relay(listTarget, fakeCmd(logList, ['--root', '{root}']), gitIsolation);
    await Q.handshake();
    const list = await Q.request('tools/list', {});
    ok('the config was written before this first request answered', fs.existsSync(ymlList));
    check('tools/list carries none of the notice text (MUST-NOT)',
      JSON.stringify(list.result).includes(ymlList), false);
    const echoQ = await Q.request('tools/call', { name: 'echo', arguments: {} });
    check('the notice was still pending: the first tools/call carries it',
      echoQ.result && echoQ.result.content.length, 2);
    Q.close();
    check('relay Q (tools/list) exits 0', (await Q.waitExit()).code, 0);

    // Two tools/call requests sent without waiting on either reply first,
    // so both are in flight together. The check below asserts that exactly
    // one of the two replies carries the notice content, never both and
    // never neither, on this one run of the race -- evidence that emit's
    // read-then-clear of pendingNotice (forwardTo) resolved cleanly here,
    // not a proof that every interleaving of the read and the clear must.
    const concTarget = tmpRepo('notice-concurrent', files);
    const ymlConc = path.join(concTarget, '.serena', 'project.yml');
    const logConc = path.join(CONFIG, 'notice-concurrent.log');
    allLogs.push(logConc);
    const R = new Relay(concTarget, fakeCmd(logConc, ['--root', '{root}']), gitIsolation);
    await R.handshake();
    const [concFirst, concSecond] = await Promise.all([
      R.request('tools/call', { name: 'echo', arguments: {} }),
      R.request('tools/call', { name: 'echo', arguments: {} }),
    ]);
    ok('the config was written for the concurrent-calls target', fs.existsSync(ymlConc));
    const concLengths = [concFirst, concSecond]
      .map((r) => (r.result && r.result.content ? r.result.content.length : null)).sort();
    check('exactly one of the two concurrent replies carries the notice, never both or neither',
      concLengths, [1, 2]);
    R.close();
    check('relay R (concurrent calls) exits 0', (await R.waitExit()).code, 0);

    // A call whose relative_path names a second repository is routed to that
    // repository's server and carries that repository's own notice; the
    // session's root, with no supported-language file, has none to give.
    const routeOwn = tmpRepo('notice-route-own');
    const routeTarget = tmpRepo('notice-route-target', files);
    const ymlRouteTarget = path.join(routeTarget, '.serena', 'project.yml');
    const logRoute = path.join(CONFIG, 'notice-route.log');
    allLogs.push(logRoute);
    const S = new Relay(routeOwn, fakeCmd(logRoute, ['--root', '{root}']), gitIsolation);
    await S.handshake();
    const ownCall = await S.request('tools/call', { name: 'echo', arguments: {} });
    check('the session\'s own root, where nothing was written, gets no notice',
      ownCall.result && ownCall.result.content.length, 1);
    const routedCall = await S.request('tools/call',
      { name: 'echo', arguments: { relative_path: path.join(routeTarget, 'x.cjs') } });
    ok('the config was written for the routed target', fs.existsSync(ymlRouteTarget));
    check('the call routed to the second target carries that target\'s own notice',
      routedCall.result && routedCall.result.content.length, 2);
    const routedNotice = routedCall.result.content[1];
    ok('the notice names the routed target\'s own file, not the session\'s own root',
      routedNotice.type === 'text' && routedNotice.text.includes(ymlRouteTarget));
    S.close();
    check('relay S exits 0', (await S.waitExit()).code, 0);

    // serenaDirIgnored answers true, false, or null when git could not tell
    // (a timeout, or any exit status other than 0 or 1 from `check-ignore`).
    // The notice fires only on a definite false (spawnServer); a target
    // where git could not answer must get none, because treating null as
    // false would tell the operator a config is untracked when it might in
    // fact be ignored.
    const unknown = tmpRepo('notice-unknown', files);
    const ymlUnknown = path.join(unknown, '.serena', 'project.yml');
    const logUnknown = path.join(CONFIG, 'notice-unknown.log');
    allLogs.push(logUnknown);
    const shimDir = gitCheckIgnoreShim(128);
    const T = new Relay(unknown, fakeCmd(logUnknown, ['--root', '{root}']), {
      ...gitIsolation, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    });
    await T.handshake();
    const echoT = await T.request('tools/call', { name: 'echo', arguments: {} });
    ok('the config was written even though git could not answer check-ignore', fs.existsSync(ymlUnknown));
    check('no notice when git could not tell whether .serena/ is ignored (MUST-NOT)',
      echoT.result && echoT.result.content.length, 1);
    T.close();
    check('relay T exits 0', (await T.waitExit()).code, 0);
  }

  // ---------------------------------------------------------------------------
  // A relay registers as a client of every repository it opens, and on exit
  // leaves each one by the rules it leaves its own by: the last live client
  // stops the server; otherwise the relay closes its session there (DELETE)
  // and the server keeps running for the others.
  console.log('\nserena-relay.cjs — on exit a relay leaves every repository it opened');
  {
    const repoA = tmpRepo('leave-a');
    const repoB = tmpRepo('leave-b');
    const [realA, realB] = [repoA, repoB].map((d) => fs.realpathSync(d));
    const logL = path.join(CONFIG, 'leave.log');
    allLogs.push(logL);
    const cmdL = fakeCmd(logL, ['--root', '{root}']);
    const keyA = reg.repoKey(repoA).key;
    const keyB = reg.repoKey(repoB).key;
    const inB = (f) => path.join(repoB, f);

    // X and Y are both sessions in A, and both route to B.
    const X = new Relay(repoA, cmdL);
    const Y = new Relay(repoA, cmdL);
    await X.handshake();
    await Y.handshake();
    const xA = await X.echo();
    const xB = await X.echo({ relative_path: inB('x.cjs') });
    const yA = await Y.echo();
    const yB = await Y.echo({ relative_path: inB('y.cjs') });
    ok('X and Y share A\'s server and B\'s server', xA.root === realA && xB.root === realB
      && xA.pid === yA.pid && xB.pid === yB.pid && xA.pid !== xB.pid);
    check('both are clients of B', [...reg.read(keyB).clients].sort(), [X.pid, Y.pid].sort());

    const markX = logEvents(logL).length;
    X.close();
    check('relay X exits 0 on stdin end', (await X.waitExit()).code, 0);
    // Checked the moment X has exited: the fake logs a DELETE before it
    // answers it, so a relay that waits for every answer has them logged.
    const names = { [xA.session]: 'X@A', [xB.session]: 'X@B', [yA.session]: 'Y@A', [yB.session]: 'Y@B' };
    check('X closed its session on A and its session on B with DELETE before it exited, and no other',
      logEvents(logL).slice(markX).filter((x) => x.ev === 'delete').map((x) => `${names[x.session] || x.session}:${x.known}`).sort(),
      ['X@A:true', 'X@B:true']);
    check('X removed itself from A\'s record', reg.read(keyA).clients, [Y.pid]);
    check('X removed itself from B\'s record', reg.read(keyB).clients, [Y.pid]);
    await sleep(300);
    ok('B\'s server keeps running while Y is still a client of it (MUST-NOT)', reg.isAlive(xB.pid));
    ok('A\'s server keeps running while Y is still a client of it (MUST-NOT)', reg.isAlive(xA.pid));
    const yB2 = await Y.echo({ relative_path: inB('y2.cjs') });
    check('Y is still served on B, on its own session, which X\'s DELETE left alone (MUST-NOT)',
      [yB2.pid, yB2.session], [yB.pid, yB.session]);

    // Y, one relay that used A and B, is now the last client of both.
    Y.close();
    check('relay Y exits 0 on stdin end', (await Y.waitExit()).code, 0);
    const stoppedA = await until(() => !reg.isAlive(xA.pid), 8000, 'A\'s server to stop').catch(() => false);
    const stoppedB = await until(() => !reg.isAlive(xB.pid), 8000, 'B\'s server to stop').catch(() => false);
    ok('Y, the last client of A, stopped A\'s server', stoppedA);
    ok('Y, the last client of B, stopped B\'s server too', stoppedB);
    check('Y removed itself from B\'s record', reg.read(keyB).clients, []);
    for (const key of [keyA, keyB]) {
      const rec = reg.read(key);
      if (rec && reg.isAlive(rec.pid)) reg.killRecordServer(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // A relay that never registered in a repository's record owes it nothing
  // on exit: it does not stop that server, even when the server has no live
  // client left. Here X's open of B fails before it registers -- X's server
  // command is `{root}/.node`, a link to node that exists in A and not in B,
  // so the spawn fails with no pid -- and only later does Y, a session in B,
  // start B's server. Y is SIGKILLed (it is this suite's own child), so B's
  // server outlives it with no live client, as it would after a crash, until
  // the SessionStart reaper sweeps it.
  console.log('\nserena-relay.cjs — on exit a relay does not stop a server it never registered with');
  {
    const repoA = tmpRepo('unreg-a');
    const repoB = tmpRepo('unreg-b');
    const [realA, realB] = [repoA, repoB].map((d) => fs.realpathSync(d));
    fs.symlinkSync(process.execPath, path.join(repoA, '.node'));
    const logU = path.join(CONFIG, 'unreg.log');
    allLogs.push(logU);
    const keyA = reg.repoKey(repoA).key;
    const keyB = reg.repoKey(repoB).key;
    const X = new Relay(repoA, JSON.stringify(['{root}/.node', FAKE, '--port', '{port}', '--log', logU, '--root', '{root}']));
    await X.handshake();
    const xA = await X.echo();
    check('X is served by A\'s server, started through A\'s link to node', xA.root, realA);
    const failed = await X.echo({ relative_path: path.join(repoB, 'x.cjs') });
    ok('X\'s call routed to B fails: B\'s server command could not start',
      failed.error && /could not start the server command/.test(failed.error.message));
    check('... and nothing was recorded for B', reg.read(keyB), null);

    const Y = new Relay(repoB, fakeCmd(logU, ['--root', '{root}']));
    await Y.handshake();
    const yB = await Y.echo();
    check('Y, a session in B, is served by B\'s server', yB.root, realB);
    check('B\'s record lists Y alone (MUST-NOT list X, which never registered)', reg.read(keyB).clients, [Y.pid]);
    Y.child.kill('SIGKILL');
    await Y.waitExit();
    ok('B\'s server outlives Y, with no live client', reg.isAlive(yB.pid) && reg.liveClients(reg.read(keyB)).length === 0);

    X.close();
    check('relay X exits 0 on stdin end', (await X.waitExit()).code, 0);
    const stoppedA = await until(() => !reg.isAlive(xA.pid), 8000, 'A\'s server to stop').catch(() => false);
    ok('X, the last client of A, stopped A\'s server', stoppedA);
    await sleep(300);
    ok('X did not stop B\'s server, which it never registered with (MUST-NOT)', reg.isAlive(yB.pid));
    for (const key of [keyA, keyB]) {
      const rec = reg.read(key);
      if (rec && reg.isAlive(rec.pid)) reg.killRecordServer(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // What routing refuses, and what it must get right beyond the plain case:
  // - a path with no repository marker (.git or .serena/project.yml) at or
  //   above it is refused. repoKey falls back to the directory itself there,
  //   so /, /tmp or ~/Downloads would each get a Serena, idle for the rest of
  //   the session. A path inside the session's own root is not routed at all,
  //   marker or not;
  // - before the client's initialize there is no handshake to replay, so a
  //   secondary target could open only a connection with no session, and
  //   would keep it: every later call there would be refused;
  // - macOS is case-insensitive, and fs.realpathSync keeps the case it is
  //   given, so a path spelt in another case would key a second server;
  // - a notifications/cancelled goes to the server running what it cancels;
  // - a 404 on a secondary target reconnects it, as on the session's own.
  console.log('\nserena-relay.cjs — routing refuses a path in no repository, waits for initialize, and folds case');
  {
    const repoA = tmpRepo('harden-a');
    const repoB = tmpRepo('harden-b');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plain-'));
    trash.push(plain);
    const [realA, realB, realPlain] = [repoA, repoB, plain].map((d) => fs.realpathSync(d));
    ok('the plain directory has no repository marker, in it or above it',
      reg.repoKey(plain).root === realPlain && !fs.existsSync(path.join(plain, '.git'))
      && !fs.existsSync(path.join(plain, '.serena', 'project.yml')));
    const logH = path.join(CONFIG, 'harden.log');
    allLogs.push(logH);
    const cmdH = fakeCmd(logH, ['--root', '{root}']);
    const at = (root, ev) => logEvents(logH).filter((x) => x.root === root && (!ev || x.ev === ev));
    const keyB = reg.repoKey(repoB).key;
    const inB = (...f) => path.join(repoB, ...f);
    const seq = (events) => events.filter((x) => x.ev === 'request').map((x) => `${x.method}:${x.known ? 'known' : 'unknown'}`);

    const H = new Relay(repoA, cmdH);
    // Written before initialize, as a client may.
    const early = await H.request('tools/call', { name: 'echo', arguments: { relative_path: inB('early.cjs') } });
    ok('a call routed to another repository before initialize gets an error saying so',
      early.error && /before the client's initialize/.test(early.error.message));
    check('... and opened nothing there: no record, no server (MUST-NOT)', [reg.read(keyB), at(realB, 'listen').length], [null, 0]);
    await H.handshake();
    const hB = await H.echo({ relative_path: inB('late.cjs') });
    check('once the client has initialized, a call routed to B reaches B', hB.root, realB);
    check('B got the client\'s handshake replayed, then the call, on the session it issued',
      seq(at(realB)), ['initialize:unknown', 'notifications/initialized:known', 'tools/call:known']);

    const stray = path.join(plain, 'notes.txt');
    const refused = await H.request('tools/call', { name: 'echo', arguments: { relative_path: stray } });
    ok('a path with no .git or .serena/project.yml above it gets an error naming the path',
      refused.error && refused.error.message.includes(stray) && /no \.git or \.serena\/project\.yml/.test(refused.error.message));
    const escaping = path.join(path.relative(realA, realPlain), 'x.cjs');
    const refusedRel = await H.request('tools/call', { name: 'echo', arguments: { relative_path: escaping } });
    ok('... and so does a relative path that escapes the session\'s root into it',
      refusedRel.error && refusedRel.error.message.includes(escaping));
    check('no server was started for it, and nothing recorded (MUST-NOT)',
      [reg.read(reg.repoKey(plain).key), at(realPlain, 'listen').length], [null, 0]);

    // The same repository in another case: its basename upper-cased, which
    // on a case-insensitive filesystem names the same directory.
    const upperB = path.join(path.dirname(repoB), path.basename(repoB).toUpperCase());
    if (fs.existsSync(upperB) && reg.repoKey(upperB).key !== keyB) {
      const folded = await H.echo({ relative_path: path.join(upperB, 'src', 'c.cjs') });
      check('a path into B spelt in another case reaches B\'s own server', [folded.root, folded.pid], [realB, hB.pid]);
      check('... with the path made relative to B\'s root', folded.args, { relative_path: path.join('src', 'c.cjs') });
      check('one server listened for B, and no record was keyed on the other spelling (MUST-NOT)',
        [at(realB, 'listen').length, reg.read(reg.repoKey(upperB).key)], [1, null]);
    } else {
      console.log('  skip (a case-sensitive filesystem: the other spelling names no directory)');
    }
    // The session's own directory spelt in another case, as a shell's $PWD
    // may give it. Paths inside it, in either spelling, stay on its own
    // server. (That server is keyed on the spelling it was given, apart from
    // H's: repoKey keeps the case it is given, and the registry is not
    // changed here.)
    const upperA = path.join(path.dirname(repoA), path.basename(repoA).toUpperCase());
    let G = null;
    if (fs.existsSync(upperA) && reg.repoKey(upperA).key !== reg.repoKey(repoA).key) {
      const gRoot = reg.repoKey(upperA).root;
      G = new Relay(upperA, cmdH);
      await G.handshake();
      const gRel = await G.echo({ relative_path: path.join('src', 'g.cjs') });
      check('a session whose directory is spelt in another case keeps a relative path inside it on its own server, unchanged',
        [gRel.root, gRel.args], [gRoot, { relative_path: path.join('src', 'g.cjs') }]);
      const gAbs = await G.echo({ relative_path: path.join(realA, 'src', 'h.cjs') });
      check('... and an absolute path inside it in the on-disk spelling, made relative to its root',
        [gAbs.root, gAbs.args], [gRoot, { relative_path: path.join('src', 'h.cjs') }]);
      check('... and started no server for the on-disk spelling beside H\'s (MUST-NOT)', at(realA, 'listen').length, 1);
    } else {
      console.log('  skip (a case-sensitive filesystem: the other spelling names no directory)');
    }

    // Sent while the call it cancels is still running on B.
    const markC = logEvents(logH).length;
    const waitId = H.seq + 1;
    const waiting = H.request('tools/call', { name: 'wait', arguments: { ms: 1500, relative_path: inB('w.cjs') } });
    await until(() => at(realB, 'request').some((x) => x.id === waitId && x.tool === 'wait'), 5000, 'the wait call to reach B');
    H.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: waitId, reason: 'test' } });
    const cancelled = () => logEvents(logH).slice(markC).filter((x) => x.ev === 'request' && x.method === 'notifications/cancelled');
    await until(() => cancelled().length, 5000, 'the cancellation to reach a server').catch(() => {});
    await waiting;
    const cancels = cancelled();
    check('a cancellation reaches B, which runs the request it cancels, on H\'s session there, and not A (MUST-NOT)',
      cancels.map((x) => `${x.root === realB ? 'B' : x.root === realA ? 'A' : x.root}:${x.cancels}:${x.known}`), [`B:${waitId}:true`]);

    // A 404 on B: B forgot the session, as a restarted server would.
    await H.request('tools/call', { name: 'forget_sessions', arguments: { relative_path: inB('f.cjs') } });
    const mark404 = logEvents(logH).length;
    const re = await H.echo({ relative_path: inB('after-forget.cjs') });
    check('after B forgot the session, the next call to B is answered by B\'s same server', [re.root, re.pid], [realB, hB.pid]);
    ok('... on a new session', re.session && re.session !== hB.session);
    check('B got exactly one new initialize, then notifications/initialized, then the retried call',
      seq(logEvents(logH).slice(mark404).filter((x) => x.root === realB)),
      ['tools/call:unknown', 'initialize:unknown', 'notifications/initialized:known', 'tools/call:known']);
    check('A was not re-initialized (MUST-NOT)',
      logEvents(logH).slice(mark404).filter((x) => x.root === realA && x.method === 'initialize').length, 0);
    ok('the relay logs it as a reconnect to B\'s server', H.stderr.includes(`reconnected to server ${hB.pid} with a new session`));
    check('the retried call has exactly one response line', H.messages.filter((m) => m.id === H.seq && !m.method).length, 1);
    check('the replayed initialize\'s reply is not written to stdout (MUST-NOT)',
      H.messages.filter((m) => m.id === H.initId && !m.method).length, 1);
    check('every stdout line is one complete JSON message', H.rawLines.length, H.messages.length);

    // A session whose own root has no marker: a path inside it is its own.
    const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plainroot-'));
    trash.push(plainRoot);
    fs.mkdirSync(path.join(plainRoot, 'sub'));
    const realPlainRoot = fs.realpathSync(plainRoot);
    const U = new Relay(plainRoot, cmdH);
    await U.handshake();
    const mine = await U.echo({ relative_path: path.join(plainRoot, 'sub', 'f.cjs') });
    check('in a session whose own root has no marker, an absolute path inside it goes to its own server, rewritten',
      [mine.root, mine.args], [realPlainRoot, { relative_path: path.join('sub', 'f.cjs') }]);
    check('... and no server was started for the subdirectory (MUST-NOT)', at(path.join(realPlainRoot, 'sub'), 'listen').length, 0);

    const named = [[H, 'H'], [U, 'U'], [G, 'G']].filter(([r]) => r);
    for (const [r] of named) r.close();
    for (const [r, name] of named) check(`relay ${name} exits 0 on stdin end`, (await r.waitExit()).code, 0);
    for (const key of [reg.repoKey(repoA).key, reg.repoKey(upperA).key, keyB, reg.repoKey(plainRoot).key]) {
      const rec = reg.read(key);
      if (rec && reg.isAlive(rec.pid)) reg.killRecordServer(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // A session can outlive its directory: a /ship worktree removed while a
  // session started in it is still open. The spawn then fails for the missing
  // working directory, and the error must say so, not blame the command.
  console.log('\nserena-relay.cjs — a repository root that does not exist is named in the error');
  {
    const missing = path.join(CONFIG, 'removed-worktree');
    const logV = path.join(CONFIG, 'missing-root.log');
    allLogs.push(logV);
    ok('the session\'s directory does not exist', !fs.existsSync(missing));
    const V = new Relay(CONFIG, fakeCmd(logV), { CLAUDE_PROJECT_DIR: missing });
    const init = await V.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }, 8000).catch(() => null);
    ok('the client\'s initialize gets an error naming the missing directory',
      init && init.error && init.error.message.includes(missing) && /does not exist/.test(init.error.message));
    ok('... not one blaming the server command (MUST-NOT)',
      init && init.error && !/could not start the server command/.test(init.error.message));
    check('no server listened', serverPids(logV).length, 0);
    V.close();
    check('relay V exits 0 on stdin end', (await V.waitExit()).code, 0);
  }

  // ---------------------------------------------------------------------------
  // On exit a relay takes each repository's lock in turn. A lock whose holder
  // hangs would hold it for withLock's default 30 s per repository; at
  // shutdown each gets a short wait instead, and a repository skipped is left
  // to the SessionStart reaper. The holder is this suite's own child, stopped
  // through its own handle.
  console.log('\nserena-relay.cjs — on exit a held lock costs the relay a short wait, not 30 s');
  {
    const repoA = tmpRepo('lock-a');
    const repoB = tmpRepo('lock-b');
    const [realA, realB] = [repoA, repoB].map((d) => fs.realpathSync(d));
    const logT = path.join(CONFIG, 'lock.log');
    allLogs.push(logT);
    const keyA = reg.repoKey(repoA).key;
    const keyB = reg.repoKey(repoB).key;
    const T = new Relay(repoA, fakeCmd(logT, ['--root', '{root}']));
    await T.handshake();
    const tA = await T.echo();
    const tB = await T.echo({ relative_path: path.join(repoB, 't.cjs') });
    ok('relay T is served on A and on B', tA.root === realA && tB.root === realB && tA.pid !== tB.pid);
    const holder = spawn(process.execPath, ['-e', `
const reg = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
reg.withLock(${JSON.stringify(keyB)}, () => {
  require('fs').writeSync(1, 'held\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});`], { env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG }, stdio: ['ignore', 'pipe', 'ignore'] });
    const holderExited = new Promise((resolve) => holder.once('exit', resolve));
    try {
      let held = false;
      holder.stdout.on('data', (b) => { if (String(b).includes('held')) held = true; });
      ok('another process holds B\'s lock', await until(() => held, 5000, 'the holder to take B\'s lock').catch(() => false));
      const t0 = Date.now();
      T.close();
      const tExit = await T.waitExit(45_000);
      const took = Date.now() - t0;
      check('relay T exits 0 on stdin end', tExit.code, 0);
      ok(`... after a short wait on B's lock, not withLock's default 30 s (took ${took} ms)`, !tExit.timeout && took < 15_000);
      ok('T logged that leaving B failed on the lock', /cleanup on stdin end failed: .*timed out/.test(T.stderr));
      const stoppedA = await until(() => !reg.isAlive(tA.pid), 8000, 'A\'s server to stop').catch(() => false);
      ok('T still left A, whose lock was free: as its last client it stopped A\'s server', stoppedA);
      ok('B\'s server, which T could not leave, is left running for the reaper (MUST-NOT stop it without the lock)',
        reg.isAlive(tB.pid));
    } finally {
      holder.kill('SIGKILL');
      await holderExited;
    }
    for (const key of [keyA, keyB]) {
      const rec = reg.read(key);
      if (rec && reg.isAlive(rec.pid)) reg.killRecordServer(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // A server that is not listening is stopped before a replacement starts,
  // and if the stop fails, nothing starts: a second server beside the first
  // would run a second set of language servers for the repository.
  // killRecordServer fails for real when the recorded pid no longer names the
  // recorded process, which the real registry could only be made to do with a
  // real kill. So this relay runs with the registry swapped out instead:
  // `node -r` preloads a stub into require.cache under the registry's path,
  // and the relay's require gets the stub. The stub's record names a server
  // that is "alive" (isAlive, captureIdentity) on a port that refuses
  // connections, and its killRecordServer throws without touching any process.
  // The record's pid is this suite's own idle child all the same, so nothing
  // outside this run is ever named.
  console.log('\nserena-relay.cjs — a server that cannot be stopped is not replaced beside itself');
  {
    const repo16 = tmpRepo('sixteen');
    const log16 = path.join(CONFIG, 'repo16.log');
    allLogs.push(log16);
    const stubRecord = path.join(CONFIG, 'stub-record.json');
    const stubLog = path.join(CONFIG, 'stub-registry.log');
    const preload = path.join(CONFIG, 'stub-registry.cjs');
    const realRegistry = require.resolve(path.join(HOOKS, 'serena-registry.cjs'));
    fs.writeFileSync(preload, `'use strict';
// Written by hooks/test/test-serena-relay.cjs and preloaded ahead of the relay.
// Every registry function the relay calls, none of which touches a process.
const fs = require('fs');
const Module = require('module');
const REAL = ${JSON.stringify(realRegistry)};
const note = (ev, extra = {}) => fs.appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify({ ev, ...extra }) + '\\n');
const stub = {
  repoKey: (dir) => ({ root: dir, key: 'stubbed' }),
  withLock: (key, fn) => fn(),
  read: () => JSON.parse(fs.readFileSync(${JSON.stringify(stubRecord)}, 'utf8')),
  write: (key, rec) => note('write', { pid: rec.pid }),
  addClient: (key, pid) => note('addClient', { pid }),
  removeClient: (key, pid) => { note('removeClient', { pid }); return 0; },
  liveClients: () => [],
  isAlive: () => true,
  captureIdentity: () => 'stub-identity',
  killRecordServer: (rec) => {
    note('kill', { pid: rec.pid });
    throw new Error('stub: the pid no longer names the recorded server');
  },
};
const m = new Module(REAL, null);
m.filename = REAL;
m.loaded = true;
m.exports = stub;
require.cache[REAL] = m;
note('loaded');
`);
    const stubEvents = (ev) => logEvents(stubLog).filter((x) => x.ev === ev);
    const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(stubRecord, JSON.stringify({
        root: repo16, pid: idle.pid, port: await freePort(), startedAt: 1, identity: 'stub-identity', clients: [],
      }));
      const S = new Relay(repo16, fakeCmd(log16), { SERENA_RELAY_READY_TIMEOUT_MS: '300' }, ['-r', preload]);
      const init = await S.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
      }, 8000).catch(() => null);
      check('the relay ran against the stubbed registry', stubEvents('loaded').length, 1);
      ok('it joined the recorded server and waited on it', stubEvents('addClient').some((x) => x.pid === S.pid));
      ok('once the port had refused for the ready timeout, it tried to stop that server',
        stubEvents('kill').some((x) => x.pid === idle.pid));
      ok('the client\'s initialize gets an error naming the failed stop',
        init && init.error && /could not stop server \d+.*not starting a second one/.test(init.error.message));
      // A relay that went on to spawn would have done so within milliseconds.
      await sleep(500);
      check('no server was started beside the one it could not stop (MUST-NOT)', stubEvents('write').length, 0);
      check('... and none listened', serverPids(log16).length, 0);
      S.close();
      check('relay S exits 0 on stdin end', (await S.waitExit()).code, 0);
    } finally {
      idle.kill('SIGKILL');
    }
  }
}

(async () => {
  const started = Date.now();
  try {
    await main();
  } catch (e) {
    fail++;
    failures.push(`suite aborted: ${e.message}`);
    console.log(`  FAIL suite aborted: ${e.stack || e.message}`);
  } finally {
    // Relays first, so none of them respawns a server after the sweep below.
    for (const r of relays) {
      if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL');
    }
    await Promise.all(relays.map((r) => r.waitExit(3000)));
    const leftovers = [];
    for (const rec of Object.values(reg.listRecords())) {
      if (reg.isAlive(rec.pid)) {
        leftovers.push(rec.pid);
        try { reg.killRecordServer(rec); } catch (e) { console.log(`  note: ${e.message}`); }
      }
    }
    for (const log of allLogs) {
      for (const pid of new Set(logEvents(log).map((e) => e.pid))) {
        if (ownFakeAlive(pid)) {
          leftovers.push(pid);
          try { process.kill(pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
        }
      }
    }
    if (leftovers.length) console.log(`  (cleanup stopped leftover servers: ${[...new Set(leftovers)].join(', ')})`);
    console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
    for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(fail ? 1 : 0);
  }
})();
