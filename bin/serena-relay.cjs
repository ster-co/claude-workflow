#!/usr/bin/env node
// stdio MCP relay in front of ONE shared Serena per repository.
//
// Claude Code starts one stdio MCP server per session. When that server was
// Serena itself, every session got its own Serena and its own language
// servers: 12 process trees and 6.3 GB on one snapshot of the operator's Mac
// (docs/plans/2026-09-24-serena-shared-server.md). This relay is what Claude
// Code starts instead. It finds the repository's shared Serena through
// hooks/serena-registry.cjs, or starts one listening on 127.0.0.1 over
// streamable HTTP, and forwards each JSON-RPC line from stdin to it. A tool
// call about a file in another repository or worktree goes to that
// repository's shared Serena instead (see route). The tool names the session
// sees are Serena's own, unchanged, so the edit gate and every
// `mcp__…serena__…` matcher keep working.
//
// Dependency-free on purpose: Node is already required by every hook, and a
// colleague must not need `npm install`. Only the part of the streamable-HTTP
// client this needs is implemented: POST, a JSON or SSE reply, the
// `Mcp-Session-Id` header, and DELETE for a session it abandons (see
// closeSession). There is no GET stream for unsolicited server
// messages; Serena's tools answer on the POST that asked.
//
// Lifetime. The relay registers its own pid as a client of the record of
// every repository it opens. On stdin end, SIGINT, SIGTERM or SIGHUP it
// removes itself from each, and where no live client is left it stops that
// server through killRecordServer, which refuses when the pid no longer
// names the process that was recorded; otherwise it closes its own session
// on that server. A relay that is SIGKILLed cannot do this; the SessionStart
// reaper sweeps its records instead.
//
// Environment:
//   CLAUDE_PROJECT_DIR               the session's project (falls back to cwd)
//   SERENA_RELAY_SERVER_CMD          tests only: a JSON array of argv to run instead
//                                    of Serena; "{port}" and "{root}" are substituted
//   SERENA_RELAY_READY_TIMEOUT_MS    how long a server may refuse connections on its port
//                                    before it is treated as not listening, and
//                                    replaced (default 60000; see waitReady)
//   SERENA_RELAY_CONTROL_TIMEOUT_MS  how long the server may stay silent on an exchange
//                                    no client request waits on, or while it is
//                                    listening but answers nothing (default 600000; see
//                                    CONTROL_TIMEOUT_MS)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const readline = require('readline');

const HOOKS = path.join(__dirname, '..', 'hooks');
const registry = require(path.join(HOOKS, 'serena-registry.cjs'));
const { STATE_DIR } = require(path.join(HOOKS, 'gates', 'gate-lib.cjs'));
// The same language detection and .serena/project.yml writer the SessionStart
// hook uses (see ensureProjectConfig below), required rather than duplicated.
// serenaDirIgnored is the same "is `.serena/` actually hidden from git
// status" check the hook's own SessionStart message uses (see the notice
// logic in spawnServer and forwardTo).
const {
  detectServers, writeProjectYml, commandOnPath, serenaDirIgnored,
} = require(path.join(HOOKS, 'repo-setup.cjs'));

// uvx resolving serena-agent plus Serena loading its project takes seconds,
// longer on a cold uv cache; a server not listening on its port by then is
// hung. A server that is listening is not held to it (waitReady).
const READY_TIMEOUT_MS = Number(process.env.SERENA_RELAY_READY_TIMEOUT_MS) || 60_000;
const PROBE_INTERVAL_MS = 100;
// The plan's "retry once on a fresh port": one spawn, plus one more if the
// first exited or never became ready.
const MAX_SPAWNS = 2;
// Rounds of find-or-spawn in one ensureServer call. More than MAX_SPAWNS,
// because a round may instead wait on a server another relay is starting.
const MAX_ROUNDS = 4;
// On stdin end, replies still in flight get this long to reach stdout.
const DRAIN_MS = 5000;
// On stdin end, what is already written gets this long to leave stdout.
const FLUSH_MS = 5000;
// How long the server may send nothing on an exchange that no client request
// is waiting on: the replayed initialize and notifications/initialized, and
// the client's notifications, which every later message queues behind. Also
// how long waitReady waits on a server that is listening but answers
// nothing, before ensureServer reports it busy -- and leaves it running.
// Without a limit, a server that accepts connections and never answers would
// hold those, and everything after them, forever.
//
// Long on purpose, because a healthy shared Serena can be silent for minutes.
// Its tools are synchronous functions called on its event loop (serena/mcp.py
// :63 `is_async = False`, called directly at mcp/server/fastmcp/utilities/
// func_metadata.py:96), and each blocks that loop until it finishes or hits
// Serena's tool_timeout (serena/tools/tools_base.py:424-427; 240 s by
// default, serena/config/serena_config.py:51). While any session's tool
// runs, the server answers nothing else, and a notification from another
// session waits for every tool call queued ahead of it. Ten minutes covers a
// couple of those at the default timeout; a server silent for longer is
// wedged, and it was failing every session already.
//
// Client requests get no limit. A tool call's own length is bounded by
// Serena's tool_timeout, and the client can give up on it; an error from the
// relay while the call is still queued behind other sessions' tools would
// report as failed an edit that is still going to run.
const CONTROL_TIMEOUT_MS = Number(process.env.SERENA_RELAY_CONTROL_TIMEOUT_MS) || 600_000;
// How long shutdown waits for each target's registry lock (Target.release).
// Other holders keep it for milliseconds, or for killTree's 3 s grace while
// they stop a server. withLock's default of 30 s is meant for a hung holder,
// and at shutdown it would hold the exit that long for each repository this
// relay opened. A target skipped for it keeps this relay's pid in its record,
// dead once the relay exits, and the SessionStart reaper sweeps it.
const RELEASE_LOCK_TIMEOUT_MS = 5000;

// Loaded by hooks/test/test-serena-relay.cjs for its SSE parser alone. Nothing
// below this line may run then: it would find or start a server.
if (require.main !== module) {
  module.exports = { sseParser };
  return;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// The session's own repository, as repoKey names it.
const sessionRepo = registry.repoKey(projectDir);

function log(msg) {
  process.stderr.write(`serena-relay: ${msg}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// repoKey falls back to the directory itself when no ancestor has a marker.
// Serena is then started without --project, as the plan decides for a
// directory that is not a repository. That holds for the session's own
// directory only: route refuses to open such a directory for another path.
function hasProjectMarker(dir) {
  return fs.existsSync(path.join(dir, '.serena', 'project.yml')) || fs.existsSync(path.join(dir, '.git'));
}

// Writes .serena/project.yml, with every language this repository actually
// has, before a server is ever spawned for a root with none. Without this,
// Serena writes its own on first use and enables only the dominant language
// (serena_config.py's ProjectConfig.autogenerate, interactive=False when
// called from its server startup path, called only `if not
// os.path.exists(yaml_path)` -- so once any file is there, ours or anyone
// else's, Serena loads it rather than autogenerating, and this never runs
// again for that root). That silent gap is exactly the one a /ship worktree
// falls into: nothing ever runs a SessionStart hook in it, only routed calls
// that reach its shared Serena on first use, so a lookup on a minority
// language there returns nothing and reads as "no callers" -- which the edit
// gate takes as proof, not absence of evidence. Reusing detectServers and
// writeProjectYml here, rather than a copy of them, is what keeps this in
// step with whatever the hook does.
//
// Best-effort and silent on any failure -- a read-only directory, or a race
// with another relay or the SessionStart hook writing the same file at once
// -- because a server is about to start for this root either way, and Serena
// autogenerating its own narrower config is a smaller failure than the spawn
// never happening. Not written when the file already exists, whatever it
// contains: an operator's or a colleague's own choice there, including one
// that lists fewer servers than the counts would suggest, is exactly what
// the hook itself never overwrites, and neither does this.
//
// This applies the SessionStart hook's own preconditions for writing a
// config, not just its detection and writing: `CLAUDE_NO_AUTO_REPO_SETUP=1`
// opts a repository out here exactly as it does there (SETUP.md), and a
// config must not be written pointing the gates at a server this call can
// never start. The hook's own check is "is uvx on PATH"; the relay's
// question is narrower and more exact -- "will the command this spawnServer
// call is about to run resolve at all" -- because SERENA_RELAY_SERVER_CMD
// lets a test (or an operator) replace the real `uv` with anything, and a
// check hardcoded to 'uvx' would either wrongly refuse to write for a
// working test command, or wrongly write ahead of a real command that will
// still fail to start. `cmd` is `serverArgv(port)[0]`, resolved (including
// any {port}/{root} substitution) but not yet spawned, so this reuses
// commandOnPath rather than re-deriving the same resolution twice.
//
// Only for a root with a `.git`: repo-setup.cjs itself only ever runs where
// `git rev-parse --show-toplevel` succeeds, and quits without writing
// anything otherwise. A directory with neither marker is the one case route()
// still opens as `own` (the session's own directory, never a routed target),
// and it reaches Serena with no --project flag and no config; this must not
// give it one.
//
// Returns `{ yml, servers }` when it wrote the file, `null` otherwise -- so
// spawnServer knows whether there is anything worth telling a client about
// (see the notice logic there), without re-deriving "did this call write a
// file" from the filesystem a second time.
function ensureProjectConfig(root, cmd) {
  const yml = path.join(root, '.serena', 'project.yml');
  if (fs.existsSync(yml) || !hasProjectMarker(root)) return null;
  if (process.env.CLAUDE_NO_AUTO_REPO_SETUP === '1') return null;
  if (!commandOnPath(cmd)) return null;
  let servers;
  try {
    servers = detectServers(root);
  } catch (e) {
    log(`could not detect languages for ${root}: ${e.message}`);
    return null;
  }
  if (!servers.length) return null;
  try {
    if (writeProjectYml(yml, path.basename(root), servers)) {
      log(`wrote ${yml} with language servers: ${servers.join(', ')}`);
      return { yml, servers };
    }
  } catch (e) {
    log(`could not write ${yml}: ${e.message}`);
  }
  return null;
}

// Binds port 0, reads the port the OS gave, and releases it for the server.
// Another process can take it in between; the server then fails to bind,
// exits, and ensureServer spawns again on a fresh port.
function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A record's server is alive only if its pid is alive AND is still the
// process recorded at spawn: a pid reused after the server died must read as
// dead, or the relay would wait out READY_TIMEOUT_MS on a stranger's pid.
function serverAlive(rec) {
  if (!rec || !Number.isSafeInteger(rec.pid) || rec.pid <= 1 || !rec.identity) return false;
  if (!registry.isAlive(rec.pid)) return false;
  return registry.captureIdentity(rec.pid) === rec.identity;
}

function sameServer(a, b) {
  return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
}

// Set when shutdown starts, which removes this relay from the record. From
// then on nothing may reconnect, register this pid again or start a server:
// the relay is about to exit, and would leave both behind (getConn,
// ensureServer, waitReady).
let shuttingDown = false;

// Any HTTP answer at all proves the server is listening. The probe names a
// session id no server issued, which the MCP SDK (1.28.1, in Serena 1.7.0)
// answers 404 before it creates anything (mcp/server/streamable_http_manager
// .py:336). A POST with no session id is not harmless: the SDK first creates
// a session transport for it (streamable_http_manager.py:264-281), then
// answers a bare POST 400 for its missing Content-Type (mcp/server/
// transport_security.py:111), and that transport is never used or freed.
// Serena issues uuid4().hex ids, so this one can never be a real session.
const PROBE_SESSION_ID = 'serena-relay-readiness-probe';

// One probe, and what it has learnt so far: `refused` once the connect was
// refused (ECONNREFUSED); `done` resolves 'answered' on any HTTP answer, or
// 'failed' when the connection is refused, reset or destroyed. It has no
// timeout of its own: waitReady decides how long to wait, and destroys it.
function probe(port) {
  const p = { refused: false, req: null, done: null };
  p.done = new Promise((resolve) => {
    p.req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'mcp-session-id': PROBE_SESSION_ID }, agent: false,
    }, (res) => {
      res.resume();
      resolve('answered');
    });
    p.req.on('error', (e) => {
      if (e && e.code === 'ECONNREFUSED') p.refused = true;
      resolve('failed');
    });
    p.req.end();
  });
  return p;
}

// What waitReady found. READY: the server answered. DEAD: it exited. NOT_LISTENING:
// it has refused connections for READY_TIMEOUT_MS: it never bound its port (or
// stopped listening), so it serves nobody. BUSY: it is listening but has
// answered nothing for CONTROL_TIMEOUT_MS. ABANDONED: this relay began
// shutting down meanwhile.
const READY = 'ready', DEAD = 'dead', NOT_LISTENING = 'not listening', BUSY = 'busy', ABANDONED = 'abandoned';

/**
 * Waits until the record's server answers on its port, and says why it
 * stopped waiting otherwise. `child` is set only when this relay spawned it.
 *
 * A server that is listening is never given up on for being slow. Serena's
 * tools block its event loop (see CONTROL_TIMEOUT_MS), so while one
 * session's tool call runs, the shared server answers nothing, this probe
 * included, for up to its tool_timeout; the kernel still accepts the
 * connection into the listen backlog.
 *
 * READY_TIMEOUT_MS is for a server that is not listening at all, and applies
 * only while connections are refused. On loopback, a port nobody listens on
 * refuses a connect at once (ECONNREFUSED): that, or the pid being gone, is
 * the only evidence of "not listening" there is. Anything else counts as
 * listening: a connect that succeeded; one still pending, which on loopback
 * means the kernel dropped its SYN because the accept queue is full, as it
 * is once enough connects (128 on macOS, kern.ipc.somaxconn) have queued
 * behind a long tool call; and any other connection error, such as a reset,
 * which a refusing port does not produce. While the server counts as
 * listening, the relay waits as long as the pid lives, up to
 * CONTROL_TIMEOUT_MS, and then reports BUSY, which ensureServer turns into an
 * error without stopping anything. A server this relay spawned itself is no
 * exception: until it binds its port, connects to it are refused, and it is
 * given up on after READY_TIMEOUT_MS like any other.
 *
 * A probe stays open until the server answers it or the connection fails,
 * raced against a PROBE_INTERVAL_MS tick for the liveness checks: a busy
 * server has one request from this relay waiting in its backlog, not a new
 * one every interval. Whether the server is listening is what the most recent
 * connect attempt found: a probe refused after an earlier one was not means
 * it has stopped listening.
 */
async function waitReady(rec, child) {
  const started = Date.now();
  let exited = !!child && (child.exitCode !== null || child.signalCode !== null);
  if (child) child.once('exit', () => { exited = true; });
  let nextAliveCheck = 0;
  let open = null;
  let listeningSince = null;
  try {
    for (;;) {
      if (!open) open = probe(rec.port);
      const outcome = await Promise.race([open.done, sleep(PROBE_INTERVAL_MS).then(() => 'pending')]);
      if (outcome === 'answered') return READY;
      if (open.refused) listeningSince = null;
      else if (listeningSince === null) listeningSince = Date.now();
      if (outcome === 'failed') open = null;
      if (shuttingDown) return ABANDONED;
      if (exited) return DEAD;
      if (Date.now() >= nextAliveCheck) {
        if (!registry.isAlive(rec.pid)) return DEAD;
        nextAliveCheck = Date.now() + 500;
      }
      if (listeningSince !== null) {
        if (Date.now() - listeningSince >= CONTROL_TIMEOUT_MS) return BUSY;
      } else if (Date.now() - started >= READY_TIMEOUT_MS) {
        return NOT_LISTENING;
      }
      // A refused connect fails at once; without this the next would follow
      // immediately.
      if (outcome === 'failed') await sleep(PROBE_INTERVAL_MS);
    }
  } finally {
    if (open) open.req.destroy();
  }
}

// --- targets ------------------------------------------------------------------

/**
 * One repository's shared server, as this relay uses it: the record it finds
 * or starts under the repository's key, whether this relay has registered in
 * that record, and the connection and session it holds on the server. Each
 * target has its own, so what happens on one repository's server -- a
 * reconnect, a replayed initialize, a stop -- never touches another's. What
 * belongs to the client rather than to a server stays outside: the stored
 * initialize and notifications/initialized, the stdin order, and shutdown.
 * Obtained through target(), never constructed directly.
 */
class Target {
  constructor(root, key) {
    this.root = root;
    this.key = key;
    this.serverLog = path.join(STATE_DIR, 'serena', `${key}.log`);
    // Whether this relay has put its pid in this target's record, and so owes
    // the removeClient (and, if last, the stop) at shutdown.
    this.registered = false;
    this.conn = null; // { rec, sessionId, protocolVersion }
    this.connecting = null;
    // Whether a connection has been set up before, so a later one is a
    // reconnect. A secondary target's first connection is its open.
    this.opened = false;
    // Set by spawnServer when it wrote .serena/project.yml for this target's
    // root and that root's `.serena/` is not git-ignored: the text a later
    // successful tools/call result carries once, then clears (see forwardTo).
    // null otherwise -- including once the notice has been delivered.
    this.pendingNotice = null;
  }

  serverArgv(port) {
    const override = process.env.SERENA_RELAY_SERVER_CMD;
    if (override) {
      let argv;
      try { argv = JSON.parse(override); } catch { argv = null; }
      if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) {
        throw new Error('SERENA_RELAY_SERVER_CMD must be a JSON array of strings');
      }
      return argv.map((a) => a.replace(/\{port\}/g, String(port)).replace(/\{root\}/g, this.root));
    }
    // `uv tool run` is what `uvx` runs: the `uvx` binary execs `uv tool uvx`
    // just after it starts. Starting uv directly means the recorded pid keeps
    // the command line it was spawned with, so the identity captured at spawn
    // is the one killRecordServer will see (recaptureIdentity covers any other
    // exec, but only from the moment the server answers).
    //
    // The Python is pinned. Unpinned, uv picks the newest Python it manages,
    // and serena-agent's pyyaml publishes Windows wheels only up to cp313: on
    // a newer Python uv compiles pyyaml from source, which needs MSVC, so on a
    // stock Windows machine Serena never starts. 3.13 has wheels everywhere
    // this runs (on Windows ARM64, uv's x86_64 build runs under emulation).
    const argv = ['uv', 'tool', 'run', '--python', '3.13', '--from', 'serena-agent', 'serena', 'start-mcp-server', '--context', 'claude-code',
      '--transport', 'streamable-http', '--port', String(port), '--open-web-dashboard', 'False'];
    if (hasProjectMarker(this.root)) argv.push('--project', this.root);
    return argv;
  }

  /**
   * Spawns the server and records it. Runs inside withLock and is entirely
   * synchronous, as withLock requires: write .serena/project.yml if this root
   * has none (ensureProjectConfig), spawn, capture identity, write the
   * record. Waiting for the server to answer happens after the lock is
   * released (waitReady).
   *
   * The server is detached, so it outlives this relay when other sessions
   * still use it, and it writes to a log file rather than to this relay's
   * stderr: that stderr is a pipe owned by one session, and once the session
   * ended, the shared server's next write to it would fail.
   *
   * The live clients of the record being replaced are carried over. They are
   * still sessions of this repository, and they reconnect to this server on
   * their next request; dropping them would let this relay, exiting first,
   * stop the server under them.
   *
   * The log is started afresh on this call's first attempt, and appended to on
   * a later one: the attempt that failed is what explains the failure, and the
   * error ensureServer throws points at this file. Each attempt begins with a
   * separator line naming it.
   *
   * When ensureProjectConfig wrote a file here and serenaDirIgnored answers
   * false (`.serena/` is not git-ignored), this sets pendingNotice: the
   * config it just wrote will otherwise show as untracked with nothing but
   * the log line above saying so. On true there is nothing to report, and on
   * null (git could not answer: a timeout or a fatal error) the relay cannot
   * tell whether the file shows as untracked, so it sends no notice.
   * serenaDirIgnored runs
   * `git check-ignore`, bounded by its own 5 s timeout, and is called only on
   * that write -- never on every spawn -- so it costs nothing on the far more
   * common path of a root that already has a config.
   */
  spawnServer(port, previous, attempt) {
    // A session can outlive its directory: a /ship worktree removed while a
    // session started in it is still open. spawn would then fail on its
    // working directory with the same ENOENT as a missing command.
    if (!fs.existsSync(this.root)) {
      throw new Error(`the repository directory ${this.root} does not exist; not starting a server for it`);
    }
    const [cmd, ...args] = this.serverArgv(port);
    // The command is resolved (argv[0], after any {port}/{root}
    // substitution) but not yet spawned, so ensureProjectConfig can ask
    // whether it will even start before deciding whether to write a config
    // for the gates to key on -- and still write it before spawn(), so the
    // config is on disk before Serena reads it (see ensureProjectConfig).
    const wrote = ensureProjectConfig(this.root, cmd);
    if (wrote && serenaDirIgnored(this.root) === false) {
      this.pendingNotice = `serena-relay wrote ${wrote.yml} (languages: ${wrote.servers.join(', ')}). `
        + `.serena/ is not git-ignored in ${this.root}, so it shows as untracked; add `
        + '`.serena/` to that repository\'s .gitignore or to your global excludes.';
    }
    fs.mkdirSync(path.dirname(this.serverLog), { recursive: true });
    const out = fs.openSync(this.serverLog, attempt > 1 ? 'a' : 'w');
    let child;
    try {
      fs.writeSync(out, `--- serena-relay ${process.pid}: spawn attempt ${attempt} on port ${port} at ${new Date().toISOString()} ---\n`);
      child = spawn(cmd, args, { cwd: this.root, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    } finally {
      fs.closeSync(out);
    }
    // A command that cannot be started reports ENOENT as an 'error' event on
    // the next tick, with no pid; without a listener that event kills the relay.
    child.on('error', (e) => log(`server command failed: ${e.message}`));
    if (!child.pid) throw new Error(`could not start the server command '${cmd}'`);
    child.unref();
    const clients = [...new Set([...registry.liveClients(previous), process.pid])];
    const rec = {
      root: this.root,
      pid: child.pid,
      port,
      startedAt: Date.now(),
      identity: registry.captureIdentity(child.pid),
      clients,
    };
    registry.write(this.key, rec);
    this.registered = true;
    log(`started server ${rec.pid} on port ${port} for ${this.root} (log: ${this.serverLog})`);
    return { rec, child };
  }

  /**
   * Records the identity of a server this relay spawned again, now that it
   * answers on its port. The identity captured at spawn can predate an exec:
   * `uvx` execs into `uv tool uvx` moments after it starts, keeping its pid and
   * start time but changing its command line, and whether spawnServer's `ps`
   * ran before or after that is a race. An identity from before it would make
   * killRecordServer refuse this server for good, and it would outlive every
   * session. Once the server is listening, its startup execs are over.
   * Before that moment, a second relay comparing identities reads such a
   * server as dead and starts another, which is why the default command
   * avoids the exec instead of relying on this.
   *
   * Done only while this relay's own child handle shows the process has not
   * exited, so the pid cannot have been reused, and only if the record still
   * names this server.
   */
  recaptureIdentity(rec, child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    registry.withLock(this.key, () => {
      const cur = registry.read(this.key);
      if (!sameServer(cur, rec)) return;
      const identity = registry.captureIdentity(rec.pid);
      if (!identity || identity === cur.identity) return;
      log(`server ${rec.pid} changed its command line during startup; recording its identity again`);
      cur.identity = identity;
      registry.write(this.key, cur);
      rec.identity = identity;
    });
  }

  /**
   * Finds the repository's live server and joins it as a client, or spawns
   * one, then waits until it answers on its port (waitReady).
   *
   * A server that exits first is replaced. One that is not listening -- it
   * refused connections for READY_TIMEOUT_MS: it never bound its port, or is
   * wedged before doing so -- is given up on: the next round, under the lock,
   * stops it if it is still the recorded one and still alive (not listening,
   * it serves nobody), and spawns a replacement. That covers a relay finding a
   * record whose server another relay is still starting: it waits on that
   * server rather than spawning a second, and gives up on it only as its
   * spawner would.
   *
   * A server that is listening is never stopped here, however long it is
   * silent: it is busy serving another session. A connect it leaves pending, or
   * fails in any way other than refusing, counts as listening (waitReady).
   * Silent for CONTROL_TIMEOUT_MS,
   * it is left running and this call throws; the client's request gets that
   * error, and its next message tries again.
   *
   * Never two servers for one repository: a server is spawned only under the
   * lock, and only when the record names none that is alive, or names the one
   * this call gave up on and that one has just been stopped. If it cannot be
   * stopped, this throws rather than start a second beside it.
   *
   * One race remains. "Not listening" is what the last probe saw, and the stop
   * comes later, under the lock: a server that binds its port in between --
   * one that took just over READY_TIMEOUT_MS to start -- is stopped while it
   * may already have answered another relay. That relay's next request is
   * refused and reconnects to the replacement, replaying its initialize; a
   * request of its that was in flight at the stop fails once. Closing the
   * window would need a network check inside the lock, which withLock (it
   * requires a synchronous fn) cannot give. The window runs from that last
   * refused connect through pickPort and the wait for the lock, at the end of
   * a startup that already took READY_TIMEOUT_MS.
   */
  async ensureServer() {
    let givenUp = null;
    let spawns = 0;
    const stopping = () => new Error('the relay is shutting down; not connecting to a server');
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const port = await pickPort();
      let child = null;
      const rec = registry.withLock(this.key, () => {
        if (shuttingDown) throw stopping();
        const cur = registry.read(this.key);
        const alive = serverAlive(cur);
        if (alive && !sameServer(cur, givenUp)) {
          registry.addClient(this.key, process.pid);
          this.registered = true;
          return registry.read(this.key);
        }
        if (alive) {
          log(`stopping server ${cur.pid}: it is not listening on port ${cur.port}`);
          try {
            registry.killRecordServer(cur);
          } catch (e) {
            throw new Error(`could not stop server ${cur.pid}, which is not listening (${e.message}); not starting a second one`);
          }
        }
        if (spawns >= MAX_SPAWNS) {
          throw new Error(`the server did not start after ${spawns} attempts; see ${this.serverLog}`);
        }
        spawns++;
        const spawned = this.spawnServer(port, cur, spawns);
        child = spawned.child;
        return spawned.rec;
      });
      const state = await waitReady(rec, child);
      if (state === READY) {
        if (child) this.recaptureIdentity(rec, child);
        return rec;
      }
      if (state === ABANDONED) throw stopping();
      if (state === BUSY) {
        throw new Error(`server ${rec.pid} on port ${rec.port} is listening but has not answered for `
          + `${CONTROL_TIMEOUT_MS / 1000} s; it is busy or wedged, and is left running`);
      }
      log(`server ${rec.pid} on port ${rec.port} ${state === DEAD ? 'exited' : 'is not listening'}; replacing it`);
      givenUp = rec;
    }
    throw new Error(`no server became ready for ${this.root}; see ${this.serverLog}`);
  }

  /**
   * The current upstream connection. Passing the connection that just failed
   * drops it and starts one reconnect; every request that failed on the same
   * connection, or arrives meanwhile, waits on that same reconnect rather than
   * starting its own. A failed connect is not cached: the next caller tries
   * again.
   *
   * Once the client has initialized, every new connection opens its own
   * session by replaying the client's initialize and
   * notifications/initialized: a reconnect, and the first connection to a
   * secondary target alike. The replayed replies never reach stdout.
   */
  getConn(failed) {
    if (failed && this.conn === failed) this.conn = null;
    if (this.conn) return Promise.resolve(this.conn);
    if (shuttingDown) return Promise.reject(new Error('the relay is shutting down; not reconnecting'));
    if (!this.connecting) {
      this.connecting = (async () => {
        const rec = await this.ensureServer();
        const c = { rec, sessionId: null, protocolVersion: null };
        // Nothing is sent on `c` until the replayed initialize's reply has
        // ended and its session is recorded: `c` reaches no other request
        // before this function returns it, so the note below and the retried
        // request both carry the new session, however late the stream ends.
        if (initRequest) {
          // No client request waits on these two exchanges themselves, only on
          // the connection they set up, so they get CONTROL_TIMEOUT_MS.
          const replay = (m, what) => {
            if (shuttingDown) throw new Error(`the relay is shutting down; not replaying ${what}`);
            return exchange(c, m, () => {}, CONTROL_TIMEOUT_MS).catch((e) => {
              throw Object.assign(new Error(`replaying ${what} on server ${rec.pid} failed: ${e.message}`),
                { sessionId: e.sessionId || null });
            });
          };
          // Whatever session the replayed initialize opened, recorded or not:
          // the server holds it either way, and a failure closes it. A replayed
          // initialize whose stream broke after its headers names it only on
          // the error.
          let opened = null;
          try {
            const r = await replay(initRequest, 'initialize');
            opened = r.sessionId;
            const reply = r.messages.find((m) => m && m.id === initRequest.id);
            if (r.status !== 200 || !r.sessionId || !reply || !reply.result) {
              throw new Error(`replaying initialize on server ${rec.pid} failed (HTTP ${r.status}${
                reply && reply.error ? `: ${reply.error.message}` : reply ? '' : ', no reply'})`);
            }
            recordSession(c, r.sessionId, reply);
            if (initializedNote) {
              const n = await replay(initializedNote, 'notifications/initialized');
              if (n.status >= 300) throw new Error(`replaying notifications/initialized failed (HTTP ${n.status})`);
            }
            if (shuttingDown) throw new Error('the relay is shutting down; dropping the replayed session');
          } catch (e) {
            const abandoned = opened || e.sessionId;
            if (abandoned) closeSession(rec.port, abandoned, c.protocolVersion);
            throw e;
          }
          log(this.opened ? `reconnected to server ${rec.pid} with a new session`
            : `opened a session on server ${rec.pid} for ${this.root}`);
        }
        this.conn = c;
        this.opened = true;
        return c;
      })().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  /**
   * Removes this relay from the target's record and, if no live client is
   * left, stops the server. Both happen under one lock, so no relay can join
   * the server between the count and the stop. Synchronous, so it completes
   * inside a signal handler before the process exits.
   *
   * When other clients remain, the server stays up, and this relay's session
   * on it is closed (closeSession) rather than left for the life of the
   * server; the returned promise settles when that DELETE is done, and is null
   * when there is none to send. A server that is stopped takes its sessions
   * with it.
   *
   * The lock is waited on for RELEASE_LOCK_TIMEOUT_MS only; a target whose
   * lock stays held is skipped, and left to the reaper.
   */
  release(reason) {
    let othersRemain = false;
    try {
      registry.withLock(this.key, () => {
        const live = registry.removeClient(this.key, process.pid);
        othersRemain = live > 0;
        if (!this.registered || live > 0) return;
        const rec = registry.read(this.key);
        if (rec && registry.isAlive(rec.pid)) {
          log(`last client gone (${reason}); stopping server ${rec.pid}`);
          registry.killRecordServer(rec);
        }
      }, { timeoutMs: RELEASE_LOCK_TIMEOUT_MS });
    } catch (e) {
      log(`cleanup on ${reason} failed: ${e.message}`);
    }
    const c = this.conn;
    if (othersRemain && c && c.sessionId) return closeSession(c.rec.port, c.sessionId, c.protocolVersion);
    return null;
  }
}

// One Target per repository, memoised by repoKey, so every use of a
// repository's server shares one registration, connection and session.
const targets = new Map();

// The Target for a repository as registry.repoKey names it. It takes
// repoKey's result rather than a directory, because repoKey is not
// idempotent: run again on a root it returned, it can resolve a different
// repository (a directory with no marker, reached through a symlink, whose
// real path lies inside a repository).
function target({ root, key }) {
  let t = targets.get(key);
  if (!t) {
    t = new Target(root, key);
    targets.set(key, t);
  }
  return t;
}

// The session's own repository's target.
const own = target(sessionRepo);

// --- forwarding ---------------------------------------------------------------

function writeMessage(m) {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

function isRequest(msg) {
  return !!msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id !== undefined && typeof msg.method === 'string';
}

function replyError(msg, text) {
  if (isRequest(msg)) writeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `serena-relay: ${text}` } });
  else log(text);
}

// The one transport failure after which the server cannot have run the
// request: the connection was refused, so it never opened and not a byte of
// the request was sent. It means the server is gone or restarting, and
// forward reconnects and retries. Every other failure (ECONNRESET, "socket
// hang up", EPIPE, a reply cut off mid-stream) can come after the server read
// the request, and a client cannot tell which: a server that dies mid-tool
// before sending headers resets the connection exactly as a stale socket
// would, differing only in timing. Those are never retried, so a tool call
// reaches the server at most once. There are no stale sockets to recover from
// in any case: exchange opens a fresh connection per request.
function neverSent(e) {
  return !!e && e.code === 'ECONNREFUSED';
}

// Feeds SSE text in, calls `onData` with each complete event's data. Lines
// may end in \r\n, \n or \r; an event ends at a blank line; its `data:`
// lines are joined with "\n" (the SSE spec), which is what lets one JSON
// message span several data lines.
//
// A CR that ends a read is taken as a line end at once, so a LF opening the
// next read may be the second half of that CRLF rather than a blank line of
// its own. Read as a blank line, it would end the event in the middle.
function sseParser(onData) {
  let buf = '';
  let data = [];
  let endedOnCR = false;
  return (chunk) => {
    if (!chunk) return;
    if (endedOnCR && chunk[0] === '\n') chunk = chunk.slice(1);
    endedOnCR = chunk.endsWith('\r');
    buf += chunk;
    const lines = buf.split(/\r\n|\n|\r/);
    buf = lines.pop();
    for (const line of lines) {
      if (line === '') {
        if (data.length) onData(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
      // event:, id:, retry: and ":" comments carry nothing the client needs.
    }
  };
}

/**
 * POSTs one JSON-RPC message to the connection's server and resolves with
 * `{status, sessionId, messages}`. On a 2xx answer every message in it --
 * one JSON body, or each SSE event as it arrives -- goes to `emit`, so a
 * long tool call's progress notifications reach the client before its result.
 * `emit` also gets the reply's Mcp-Session-Id, which is in the headers and so
 * known before the first message: an initialize answered over SSE has its
 * result emitted before the stream ends and this promise resolves.
 * On any other status nothing is emitted: the body is Serena's transport
 * error, not an answer to the client's request, and the caller decides.
 * Rejects on a transport failure (connection refused, reset before or during
 * the reply); see neverSent for which of those the caller may retry. An error
 * after the headers carries their Mcp-Session-Id as `sessionId`: an
 * initialize whose stream broke there has opened a session on the server all
 * the same, and the caller closes it (closeSession).
 *
 * `agent: false` gives every request its own connection, closed after it.
 * A kept-alive socket the server has since closed would fail the next
 * request with the same reset as a server dying mid-tool, and that reset is
 * not retried; without reuse there is no such socket. A localhost connect per
 * request costs next to nothing beside a tool call.
 *
 * `idleMs`, when given, rejects with ETIMEDOUT once the server has sent
 * nothing for that long, from connect to the reply's last byte; it is reset by
 * every byte, so a stream that keeps sending is never cut. Callers pass
 * CONTROL_TIMEOUT_MS or nothing (see there for which).
 */
function exchange(conn, msg, emit, idleMs = 0) {
  return new Promise((resolve, settleError) => {
    let sessionId = null;
    const reject = (e) => {
      if (sessionId && e && typeof e === 'object') e.sessionId = sessionId;
      settleError(e);
    };
    const body = JSON.stringify(msg);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': Buffer.byteLength(body),
    };
    if (conn.sessionId) headers['mcp-session-id'] = conn.sessionId;
    if (conn.protocolVersion) headers['mcp-protocol-version'] = conn.protocolVersion;
    const req = http.request({
      host: '127.0.0.1', port: conn.rec.port, path: '/mcp', method: 'POST', headers, agent: false,
    }, (res) => {
      const out = { status: res.statusCode, sessionId: res.headers['mcp-session-id'] || null, messages: [] };
      sessionId = out.sessionId;
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const deliver = (text) => {
        if (!text.trim()) return;
        let m;
        try { m = JSON.parse(text); } catch {
          log(`dropped an unparseable message from the server: ${text.slice(0, 200)}`);
          return;
        }
        out.messages.push(m);
        if (ok) emit(m, out.sessionId);
      };
      let ended = false;
      res.setEncoding('utf8');
      if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
        res.on('data', sseParser(deliver));
      } else {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => deliver(text));
      }
      res.on('end', () => { ended = true; resolve(out); });
      res.on('error', reject);
      res.on('close', () => {
        if (!ended) reject(Object.assign(new Error('the server closed the reply early'), { code: 'ECONNRESET' }));
      });
    });
    // The timeout's own error is settled first, so it, and not the reset the
    // destroy causes, is what the caller reports.
    if (idleMs) {
      req.setTimeout(idleMs, () => {
        reject(Object.assign(new Error(`timed out: the server sent nothing for ${idleMs / 1000} s`), { code: 'ETIMEDOUT' }));
        req.destroy();
      });
    }
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Ends a session this relay opened and will not use, with the DELETE the
 * streamable-HTTP transport provides (mcp/server/streamable_http.py:754-775):
 * Serena closes the session's streams and ends its task, where an abandoned
 * session would otherwise last as long as the server.
 *
 * Three things leave such a session: an initialize answered 200 with a
 * session id but no result (an error, no reply at all, or a stream that broke
 * after the headers), whether the client's own or a replayed one; a replay
 * that fails after its initialize was answered; and this relay exiting while
 * the server stays up for other clients (shutdown). The session a reconnect
 * replaces needs no DELETE: a reconnect follows only a refused connection,
 * whose server is gone, or a 404, which the server sends for a session it no
 * longer has (mcp/server/streamable_http_manager.py:336, or streamable_http.py
 * :417 for one already ended). Best effort: a failure is logged. The returned
 * promise settles when the DELETE is done either way; only shutdown waits on
 * it.
 */
function closeSession(port, sessionId, protocolVersion) {
  return new Promise((resolve) => {
    const headers = { 'mcp-session-id': sessionId };
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'DELETE', headers, agent: false,
    }, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', resolve);
      if (res.statusCode >= 300) log(`closing an abandoned session got HTTP ${res.statusCode}`);
    });
    req.setTimeout(CONTROL_TIMEOUT_MS, () => req.destroy());
    req.on('error', (e) => {
      log(`could not close an abandoned session: ${e.message}`);
      resolve();
    });
    req.end();
  });
}

// The client's own `initialize` and `notifications/initialized`, kept so a
// reconnect can open a new session on its behalf. Serena's reply to the
// replayed initialize is not forwarded: the client already has one.
let initRequest = null;
let initializedNote = null;

// Puts the session an initialize opened on the connection, so every later
// request on it carries Mcp-Session-Id and MCP-Protocol-Version. Only for a
// reply that carries a `result`: a session whose initialize failed, or went
// unanswered, is closed instead (closeSession), never sent on.
function recordSession(c, sessionId, reply) {
  c.sessionId = sessionId;
  c.protocolVersion = (reply && reply.result && reply.result.protocolVersion) || null;
}

// --- routing ------------------------------------------------------------------
//
// Serena looks only inside its own project: the claude-code context disables
// activate_project, and a path outside the project root is refused
// (serena/project.py, validate_relative_path). A `tools/call` whose
// `arguments.relative_path` is absolute, or resolves against the session's
// root to a place outside it, is about another repository, so it goes to that
// repository's own shared server (a secondary target, opened on first use),
// with relative_path rewritten relative to that server's root. Every other
// message goes to the session's own server unchanged: no relative_path, one
// inside the session's root, `tools/list`, the memory tools. Results are not
// rewritten; ROUTING_NOTE tells agents their paths are relative to the
// repository the call went to. One deliberate exception: forwardTo's `emit`
// appends a pending "wrote a config that is not git-ignored" notice to a
// target's first successful tools/call result, one text item added, nothing
// existing changed (see Target.pendingNotice, spawnServer).
//
// Two calls are refused with an error rather than routed. One names a path
// with no .git or .serena/project.yml at or above it: repoKey would fall back
// to the directory itself, and /, /tmp or ~/Downloads would each get a Serena
// that idles for the rest of the session. A path inside the session's own
// root is the session's own, marker or not. The other comes before the
// client's initialize: a secondary target opens its session by replaying that
// initialize, and without it would hold a connection with no session, which
// its server refuses every call on. A `notifications/cancelled` follows the
// request it cancels, to whichever target that went to.
//
// What is routed, by Serena 1.7.0's tool signatures (serena/tools/*.py):
// every tool whose path argument is `relative_path` -- read_file,
// create_text_file, list_dir, find_file, replace_content, replace_in_files,
// delete_lines, replace_lines, insert_at_line, search_for_pattern,
// get_symbols_overview, find_symbol, find_referencing_symbols,
// find_implementations, find_declaration, get_diagnostics_for_file,
// replace_symbol_body, insert_after_symbol, insert_before_symbol,
// rename_symbol, safe_delete_symbol, and the jet_brains_* tools that take it.
// What is not routed, because the path has another name: reference_file
// (get_diagnostics_for_symbol), cwd (execute_shell_command). A routed call's
// other path arguments are carried unchanged: target_relative_path
// (jet_brains_move), and the paths_include_glob / paths_exclude_glob
// patterns, which Serena matches against the root the call went to.

// Appended to the description of each tool in `tools/list` that takes
// `relative_path`, the argument routing reads.
const ROUTING_NOTE = 'Through serena-relay, relative_path may also be an absolute path, or one outside this '
  + 'project: the call then goes to the Serena of the repository that contains it, and paths in its result '
  + 'are relative to that repository\'s root.';

function noteRouting(reply) {
  const tools = reply && reply.result && Array.isArray(reply.result.tools) ? reply.result.tools : [];
  for (const tool of tools) {
    const props = tool && tool.inputSchema && tool.inputSchema.properties;
    if (!props || typeof props !== 'object' || !Object.prototype.hasOwnProperty.call(props, 'relative_path')) continue;
    tool.description = typeof tool.description === 'string' && tool.description.trim()
      ? `${tool.description.trimEnd()} ${ROUTING_NOTE}` : ROUTING_NOTE;
  }
}

// The realpath of `p`, which need not exist (create_text_file names a file
// that does not yet): its deepest existing ancestor is resolved, and the rest
// appended as given. Roots from repoKey are realpaths, and a path is compared
// with them only once resolved the same way: os.tmpdir() on macOS lies under
// /var, a symlink to /private/var.
//
// The native realpath, because it also gives each existing component the case
// it has on disk; fs.realpathSync keeps the case it is given. macOS is
// case-insensitive, so home/x/Repo and home/x/repo name one repository,
// and repoKey, which keys on the text of the path it walks, would give the
// second spelling its own key and its own Serena. Walked from the on-disk
// spelling, it lands on the key a session started in that repository has.
function realpathOf(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch { /* does not exist (yet): try its parent */ }
    const parent = path.dirname(head);
    if (parent === head) return path.resolve(p);
    rest.unshift(path.basename(head));
    head = parent;
  }
}

// The target each client request still in flight went to, by its id (see
// forward), so that a notifications/cancelled naming it reaches the server
// running it. Keyed on the id's JSON, so 1 and "1" stay apart.
const inFlight = new Map();
const requestKey = (id) => JSON.stringify(id);

// Whether `p` lies inside `root`, both realpaths, compared by whole path
// segments. A /ship worktree sits beside its repository as `<root>-<name>`,
// which shares a string prefix with the root and is outside it.
function isInside(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The target a client message goes to, and the message to send it: `msg`
 * itself for the session's own target, or a copy with relative_path made
 * relative to the other target's root. The repository is repoKey's for the
 * directory the path names, or for the one containing it when the path names
 * a file or does not exist: the root of another repository passed as a
 * directory (list_dir) is that repository, not the folder around it.
 *
 * Throws, and so opens and caches no target, for a path in no repository and
 * for another repository before the client's initialize (see the routing
 * notes above); forward's caller answers the client with the error.
 */
function route(msg) {
  if (msg && msg.method === 'notifications/cancelled') {
    const held = inFlight.get(requestKey(msg.params && msg.params.requestId));
    return { t: held ? held.t : own, sent: msg };
  }
  const args = msg && msg.method === 'tools/call' && msg.params && msg.params.arguments;
  const given = args && typeof args === 'object' ? args.relative_path : undefined;
  if (typeof given !== 'string' || !given.trim()) return { t: own, sent: msg };
  const absolute = path.isAbsolute(given);
  const real = realpathOf(absolute ? given : path.resolve(own.root, given));
  // `real` has the on-disk case (realpathOf); own.root has the case the
  // session's directory was given in, which can differ. Compared, and made
  // relative, in the on-disk spelling of both.
  const ownRoot = realpathOf(own.root);
  if (!absolute && isInside(real, ownRoot)) return { t: own, sent: msg };
  let dir;
  try {
    dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
  } catch {
    dir = path.dirname(real);
  }
  const repo = registry.repoKey(dir);
  let t;
  if (repo.key === own.key || repo.root === ownRoot) {
    t = own;
  } else if (!hasProjectMarker(repo.root)) {
    if (!isInside(real, ownRoot)) {
      throw new Error(`${given} is not in a repository: there is no .git or .serena/project.yml in ${dir} or above it, `
        + 'so no Serena is started for it');
    }
    t = own;
  } else if (!initRequest) {
    throw new Error(`${given} is in another repository, ${repo.root}, whose Serena cannot be opened before the client's initialize`);
  } else {
    t = target(repo);
  }
  const relativePath = path.relative(t === own ? ownRoot : t.root, real) || '.';
  return { t, sent: { ...msg, params: { ...msg.params, arguments: { ...args, relative_path: relativePath } } } };
}

/**
 * Forwards one client message to its target. The target, and what is sent
 * there, come from route: the client's message, or a copy with relative_path
 * rewritten for another repository. A request is recorded in inFlight until
 * it is done. The sending itself -- at most once, with its retry rules --
 * is forwardTo's.
 */
async function forward(msg) {
  const { t, sent } = route(msg);
  if (!isRequest(msg)) return forwardTo(t, msg, sent);
  const k = requestKey(msg.id);
  const entry = { t };
  inFlight.set(k, entry);
  try {
    return await forwardTo(t, msg, sent);
  } finally {
    // A client that reused the id meanwhile owns the entry now.
    if (inFlight.get(k) === entry) inFlight.delete(k);
  }
}

/**
 * Sends one message to one target, at most once. Two failures prove the
 * server did not run it, and only those reconnect -- re-finding or
 * respawning the server and replaying initialize -- and retry once: a refused
 * connection (neverSent), and a 404 (the server no longer knows the session:
 * it was restarted, or is not the one the session was opened on), which the
 * server sends instead of running the request. Any other broken connection,
 * before the reply's headers or after them, is not retried: the server may
 * have read the request and run the tool, and running an edit twice is worse
 * than reporting a failure. Anything still failing is answered with exactly
 * one JSON-RPC error, so the client is never left waiting on a request id
 * that no reply will come for -- unless a response for that id already
 * reached the client, which must not get a second one. Everything here
 * applies per target alike.
 */
async function forwardTo(t, msg, sent) {
  const isInit = !!msg && msg.method === 'initialize';
  const isList = isRequest(msg) && msg.method === 'tools/list';
  const isCall = isRequest(msg) && msg.method === 'tools/call';
  let answered = false;
  let c;
  const emit = (m, sessionId) => {
    if (isRequest(msg) && m && m.id === msg.id && !m.method) {
      answered = true;
      if (isList) noteRouting(m);
      // Attached to the first successful tools/call result after this
      // target wrote a config that is not git-ignored (spawnServer sets
      // pendingNotice), an explicit exception to "results are not
      // rewritten": one item is appended, nothing existing changes. An
      // error result -- isError: true, or a JSON-RPC error, so m.result is
      // absent or carries it -- gets no notice and leaves pendingNotice for
      // the next successful one. Read and cleared here, both in one
      // synchronous step with no `await` between them, so two tools/call
      // replies racing through their own `emit` can never both see it set.
      if (isCall && t.pendingNotice && m.result && m.result.isError !== true) {
        const notice = t.pendingNotice;
        t.pendingNotice = null;
        const content = Array.isArray(m.result.content) ? m.result.content : [];
        m.result.content = [...content, { type: 'text', text: notice }];
      }
      // The session is recorded before the client sees the initialize
      // reply. Serena answers initialize over SSE, and the stream ends in a
      // later read than its result; a client that writes
      // notifications/initialized the moment it reads the result would
      // otherwise have it, and its first tools/list, sent with no session.
      if (isInit && sessionId && m.result) {
        initRequest = msg;
        recordSession(c, sessionId, m);
      }
    }
    writeMessage(m);
  };
  // An initialize the server opened a session for without answering it with
  // a result -- an error, no reply, or a stream that broke after the headers:
  // emit did not record that session, and nothing will use it. One whose
  // result reached the client was recorded, and is the session in use.
  const closeUnrecorded = (sessionId) => {
    if (isInit && sessionId && c.sessionId !== sessionId) closeSession(c.rec.port, sessionId, null);
  };
  let failed;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      c = await t.getConn(failed);
    } catch (e) {
      lastErr = e;
      break;
    }
    let r;
    try {
      // A client request is never timed out here; everything else it
      // sends, which later messages queue behind, is (CONTROL_TIMEOUT_MS).
      r = await exchange(c, sent, emit, isRequest(msg) ? 0 : CONTROL_TIMEOUT_MS);
    } catch (e) {
      closeUnrecorded(e.sessionId);
      if (!neverSent(e)) {
        const what = e.code === 'ETIMEDOUT' ? e.message
          : `the connection to the server broke before its reply was complete (${e.message})`;
        lastErr = new Error(`${what}; not retried, because the server may already have run the request`);
        break;
      }
      lastErr = e;
      failed = c;
      continue;
    }
    closeUnrecorded(r.sessionId);
    if (r.status === 404) {
      lastErr = new Error('the server does not know this session (HTTP 404)');
      failed = c;
      continue;
    }
    if (msg && msg.method === 'notifications/initialized' && r.status < 300) initializedNote = msg;
    if (r.status >= 300) {
      const err = r.messages.find((m) => m && m.error);
      replyError(msg, `the server answered HTTP ${r.status}${err ? `: ${err.error.message}` : ''}`);
    } else if (isRequest(msg) && !r.messages.some((m) => m && m.id === msg.id && !m.method)) {
      // A stream that ended without the reply (or whose reply did not
      // parse) would otherwise leave the client waiting on this id forever.
      replyError(msg, `the server's HTTP ${r.status} reply carried no response to this request`);
    }
    return;
  }
  const text = lastErr ? lastErr.message : 'no reply from the server';
  if (answered) log(`the connection broke after the reply to ${JSON.stringify(msg.id)} was sent: ${text}`);
  else replyError(msg, text);
}

// --- shutdown -----------------------------------------------------------------

/**
 * Leaves every repository this relay opened, its own and each secondary
 * target alike (Target.release): removes this relay from the target's record
 * and, if no live client is left, stops that server, or else closes this
 * relay's session on it. A target this relay never registered with -- its
 * open failed first -- is left running. That part is synchronous, so it
 * completes inside a signal handler before the process exits.
 *
 * With `flush`, on stdin end, stdout must also take everything already
 * written to it. stdout to a pipe can be asynchronous (it is on macOS), and
 * process.exit drops whatever the pipe has not taken yet: the last reply,
 * when it is larger than the pipe's buffer. A write's callback runs after
 * every write before it has gone out. On a signal there is nobody left to
 * read the rest, and there is no flush.
 *
 * The process exits once the flush and every DELETE, whichever apply, are
 * done, or after FLUSH_MS; at once when none applies. The DELETEs run side by
 * side, so FLUSH_MS bounds them all together. Setting shuttingDown first is
 * what keeps a request still in flight from reconnecting meanwhile (getConn).
 */
function shutdown(reason, flush = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  const pending = [];
  for (const t of targets.values()) {
    const closing = t.release(reason);
    if (closing) pending.push(closing);
  }
  if (flush) pending.push(new Promise((resolve) => process.stdout.write('', resolve)));
  if (!pending.length) process.exit(0);
  setTimeout(() => process.exit(0), FLUSH_MS);
  Promise.all(pending).then(() => process.exit(0));
}

// A signal arriving while stdin end's flush is still under way exits at once:
// the cleanup is already done.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => (shuttingDown ? process.exit(0) : shutdown(sig)));
}
process.stdout.on('error', () => shutdown('stdout closed'));

// --- stdin --------------------------------------------------------------------

let inflight = 0;
let stdinClosed = false;
function maybeFinish() {
  if (stdinClosed && inflight === 0) shutdown('stdin end', true);
}

// Start (or find) the server now, so Serena's startup overlaps the client's
// own; the first message waits on it. A failure here is retried by the first
// message's getConn.
own.getConn().catch((e) => log(e.message));

// Requests are forwarded concurrently, so a slow tool call does not hold up
// the next one. A notification (or a response to the server) is different:
// nothing after it is sent until the server has accepted it, because a
// server may reject a request that reaches it before
// `notifications/initialized`, and the client may write the two back to
// back. (Serena's MCP SDK, 1.28.1, happens not to: it counts a session
// initialized once it has answered initialize, mcp/server/session.py:199.
// The order is kept for any server that does.) CONTROL_TIMEOUT_MS bounds how
// long a notification the server never answers holds the rest back.
let barrier = Promise.resolve();
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'serena-relay: parse error' } });
    return;
  }
  inflight++;
  const task = barrier
    .then(() => forward(msg))
    .catch((e) => replyError(msg, e.message))
    .finally(() => { inflight--; maybeFinish(); });
  if (!isRequest(msg)) barrier = task;
}).on('close', () => {
  stdinClosed = true;
  setTimeout(() => shutdown('stdin end, replies still pending', true), DRAIN_MS).unref();
  maybeFinish();
});
