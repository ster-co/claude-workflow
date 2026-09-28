#!/usr/bin/env node
// A minimal streamable-HTTP MCP server, standing in for Serena in
// hooks/test/test-serena-relay.cjs. It serves http://127.0.0.1:<port>/mcp
// with exactly the behaviour of Serena 1.7.0 (MCP SDK 1.28.1) that the relay
// depends on, checked in the order the SDK checks it:
//
//   - a request naming an `Mcp-Session-Id` the server does not know gets 404
//     at once, and nothing is created (streamable_http_manager.py:336). This
//     is the check that gives the suite its teeth: a fake that answered
//     regardless would pass a relay that sends a stale or made-up session,
//     while real Serena would reject every call that relay makes;
//   - a request with NO session id makes the SDK create a new session
//     transport before it looks at anything else (streamable_http_manager.py
//     :264-281, "Created new transport"). Only an `initialize` keeps it; any
//     other session-less request leaves it behind unused and is answered 400,
//     "Missing session ID" (streamable_http.py:847). The fake logs a
//     `transport` event for every such request, so a test can see a client
//     (the relay's readiness probe, say) littering the server with them;
//   - a POST without `Content-Type: application/json` gets 400
//     (transport_security.py:111), one without
//     `Accept: application/json, text/event-stream` gets 406;
//   - `initialize` issues a fresh session id in the `Mcp-Session-Id` response
//     header, one per client, and answers the requested protocol version if
//     it supports it, else its latest;
//   - an `MCP-Protocol-Version` header naming a version it does not support
//     gets 400;
//   - a request that reaches a session before its `notifications/initialized`
//     is refused with a JSON-RPC error. Here the fake is stricter than
//     Serena: SDK 1.28.1 marks a session initialized as soon as it has
//     answered `initialize` (session.py:199). The strictness is what makes
//     the relay's ordering testable;
//   - notifications get 202 with no body;
//   - DELETE with a known session id ends that session (streamable_http.py
//     :754-775), and the id then gets 404.
//
// Tools: `echo` answers with this server's pid, the root it serves (`--root`),
// the caller's session id and its arguments, so a test can tell WHICH server
// and WHICH session answered. In `tools/list` it is the one tool with a
// description and a `relative_path` argument, as Serena's file and symbol
// tools have.
// `arguments.reply` picks the response form: "json" (the default) answers
// with one application/json body, "sse" answers as text/event-stream with a
// progress notification first and the result second, the result's JSON split
// over two `data:` lines (SSE joins them with "\n"), so the relay has to
// reassemble an event and re-emit it as one line. The SSE lines end in CRLF,
// and the stream is written in two parts ~30 ms apart, cut between the CR and
// the LF that end the first data line: a parser that takes the CR for a line
// end and the LF, in the next read, for a second one ends the event after
// half the JSON. `forget_sessions` drops
// every known session, as a restarted server would, so the next call on the
// old id gets 404. `no_reply` answers 200 with an SSE stream that ends after
// a notification and never carries the response. `reply_then_drop` writes
// its result as an SSE event and then destroys the connection without ending
// the stream: a server that dies just after answering, where the tool has
// already run and must not be run again. The other `*_drop` tools also break
// the connection without ending the reply, each at a different point, and
// each after the tool has run:
//   - `nohdr_drop` sends nothing at all and drops the connection ~50 ms
//     later: a server that died in the middle of a tool call;
//   - `headers_then_drop` sends the 200 SSE headers and a comment, then drops;
//   - `progress_then_drop` sends a progress notification, then drops;
//   - `request_then_drop` sends a server-to-client request (`roots/list`)
//     whose id equals the client's request id, then drops. A relay that
//     takes any message with that id for the response would think the
//     request answered.
// `drop_next` makes the server destroy the connection of the next request it
// receives before reading it. The relay sees the same reset as for
// `nohdr_drop`, and cannot tell which of the two happened.
// `http_500` answers HTTP 500 with a JSON-RPC error body, as the SDK does for
// an internal error. `big` answers with a result whose text is
// `arguments.size` characters, more than a pipe holds. `iserror` answers 200
// with a normal JSON-RPC `result`, but `result.isError` is `true`: a tool that
// ran and reported its own failure in-band, the shape Serena uses for a tool
// exception (as opposed to `http_500`'s transport-level failure). `rpc_error`
// answers 200 with a JSON-RPC `error` in place of a `result`: the transport
// succeeded, the request just was not one the server could run. Both are for
// serena-relay's write-a-config notice, which must never attach to either.
// `fail_next_initialized` makes the next `notifications/initialized` get
// HTTP 500; `hang_next_initialize` makes the next `initialize` get no answer
// at all, the connection held open: a server that accepts and never replies.
// `error_next_initialize` and `noreply_next_initialize` make the next
// `initialize` open a session, send its id in the `Mcp-Session-Id` header
// with a 200, and then answer with a JSON-RPC error, or with an SSE stream
// that ends without any reply: a session exists on the server that the
// client has no result for. `drop_next_initialize` does the same, but sends
// the 200 SSE headers with the session id and a comment, then destroys the
// connection: the client learns the session id and gets no reply, and sees a
// broken stream rather than an ended one. All three log `init-noresult`.
// `block` runs a synchronous busy loop for `arguments.ms` before it answers,
// as Serena's tools do: the whole server answers nothing meanwhile, a
// readiness probe included, though the kernel still accepts connections into
// the listen backlog. It logs `block-start` and `block-end`. With
// `arguments.until`, a file path, it ends as soon as that file exists, or
// after `ms`, whichever is first: a test can keep the server busy for exactly
// as long as it needs, rather than race a fixed duration.
// `wait` answers after `arguments.ms` without blocking: the server serves
// everything else meanwhile, so a request can still be in flight when the
// client's next message arrives.
// Three notification methods fail on purpose: `notifications/fake_fail` gets
// HTTP 500, `notifications/fake_drop` has its connection destroyed, and
// `notifications/fake_hang` is never answered.
// Each request's log line names the tool it called, so a test can count how
// many times a tool actually ran, says whether it arrived on a connection
// that had already carried a request (`reused`), and records the
// `MCP-Protocol-Version` header it carried (`protocol`). A
// `notifications/cancelled` also logs the request id it cancels (`cancels`),
// so a test can see which server was told. A POST with no JSON
// body -- the relay's readiness probe is one -- logs `bodiless` with the
// session id it named, so a test can count the probes that reached the server.
//
// Arguments:
//   --port <n>              required; listens on 127.0.0.1:<n>
//   --log <file>            appends one JSON line per event (listen, request)
//   --root <dir>            the repository this server stands in for; named in every
//                           log line and every echo, so servers started from one
//                           command for several repositories can share a log
//   --delay-listen <ms>     wait before listening: a server that is "still starting"
//   --fail-first <marker>   if <marker> does not exist, create it and exit 1 before
//                           listening: a server that failed to start (a port clash)
//   --hang-first <marker>   if <marker> does not exist, create it and never listen:
//                           a server that is alive but never becomes ready
//   --sse-init-end <ms>     answer `initialize` over SSE, as Serena does (FastMCP's
//                           default json_response=False), and end that stream <ms>
//                           after its result event. The session id is in the headers
//                           from the start, but the stream's end comes later, in a
//                           separate read; a client that answers the result at once
//                           lands in between. Logs `init-end` when the stream ends.
//   --slow-initialized <ms> take <ms> to accept `notifications/initialized`: the
//                           session counts as initialized, and the 202 goes out,
//                           only then. A request the client wrote straight after
//                           the notification reaches the server inside that
//                           window unless something holds it back.
//   --backlog <n>           listen with a backlog of <n> (Node's default is 511). With
//                           a small one, a test can fill the kernel's accept queue
//                           while `block` runs: a further connect is then left
//                           pending, as it is on a busy Serena once 128 connects
//                           (macOS's kern.ipc.somaxconn) have queued.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(arg('--port'));
const logFile = arg('--log');
const root = arg('--root') || null;
const delayListen = Number(arg('--delay-listen') || 0);
const failFirst = arg('--fail-first');
const hangFirst = arg('--hang-first');
const sseInitEnd = arg('--sse-init-end') === undefined ? null : Number(arg('--sse-init-end'));
const slowInitialized = Number(arg('--slow-initialized') || 0);
const backlog = arg('--backlog') === undefined ? undefined : Number(arg('--backlog'));
// The versions SDK 1.28.1 accepts, newest last.
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

function log(ev) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, port, root, ...ev })}\n`);
}

// `wx` makes "first" exact even if two fakes start at once: only one create wins.
function claimFirst(marker) {
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

if (!Number.isInteger(port) || port <= 0) {
  console.error('fake-mcp-http: --port <n> is required');
  process.exit(2);
}
if (failFirst && claimFirst(failFirst)) {
  log({ ev: 'fail-first' });
  // What a real failed start leaves in the relay's server log.
  console.error('fake-mcp-http: failing this first start on purpose');
  process.exit(1);
}
if (hangFirst && claimFirst(hangFirst)) {
  log({ ev: 'hang-first' });
  setInterval(() => {}, 1000);
  return;
}

// Known session ids, each mapped to whether its notifications/initialized
// has been accepted.
const sessions = new Map();
// Sockets that have carried a request; weak, so a closed one is not kept.
const served = new WeakSet();
let dropNext = false;
let failNextInitialized = false;
let hangNextInitialize = false;
let initNoResult = null; // 'error', 'noreply' or 'drop', for the next initialize

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handle(req, res, raw) {
  const sid = req.headers['mcp-session-id'];
  let msg = null;
  try { msg = JSON.parse(raw); } catch { /* answered below, in the SDK's order */ }
  const known = sid !== undefined && sessions.has(sid);
  if (req.method === 'DELETE') {
    log({ ev: 'delete', session: sid || null, known });
  } else if (msg) {
    const tool = msg.method === 'tools/call' && msg.params ? msg.params.name || null : null;
    const reused = served.has(req.socket);
    served.add(req.socket);
    const cancels = msg.method === 'notifications/cancelled' && msg.params ? msg.params.requestId ?? null : undefined;
    log({
      ev: 'request', method: msg.method || null, id: msg.id ?? null, tool, session: sid || null, known, reused,
      protocol: req.headers['mcp-protocol-version'] || null, ...(cancels === undefined ? {} : { cancels }),
    });
  } else {
    log({ ev: 'bodiless', session: sid || null });
  }

  if (sid !== undefined && !known) {
    json(res, 404, rpcError('server-error', -32600, 'Session not found'));
    return;
  }
  if (sid === undefined) log({ ev: 'transport' });
  if (req.method === 'DELETE') {
    if (!sid) {
      json(res, 400, rpcError('server-error', -32600, 'Bad Request: Missing session ID'));
      return;
    }
    sessions.delete(sid);
    res.writeHead(200);
    res.end();
    return;
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    res.writeHead(400);
    res.end('Invalid Content-Type header');
    return;
  }
  const accept = String(req.headers.accept || '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    json(res, 406, rpcError('server-error', -32600, 'Not Acceptable: Client must accept both application/json and text/event-stream'));
    return;
  }
  if (!msg) {
    json(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }

  if (msg.method === 'initialize') {
    if (hangNextInitialize) {
      hangNextInitialize = false;
      log({ ev: 'init-hang' });
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    sessions.set(id, false);
    log({ ev: 'session', session: id });
    if (initNoResult) {
      const kind = initNoResult;
      initNoResult = null;
      log({ ev: 'init-noresult', kind, session: id });
      if (kind === 'error') {
        json(res, 200, rpcError(msg.id, -32603, 'fake: initialize failed'), { 'mcp-session-id': id });
      } else if (kind === 'drop') {
        // Destroyed in the write callback, so the headers reach the client
        // first (see dropAfter below).
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': id });
        res.write(': open\n\n', () => res.socket.destroy());
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': id });
        res.end(': no reply\n\n');
      }
      return;
    }
    const requested = msg.params && msg.params.protocolVersion;
    const reply = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1],
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-http', version: '0.0.0' },
      },
    };
    if (sseInitEnd !== null) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': id });
      res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      setTimeout(() => {
        log({ ev: 'init-end', session: id });
        res.end();
      }, sseInitEnd);
      return;
    }
    json(res, 200, reply, { 'mcp-session-id': id });
    return;
  }
  if (!sid) {
    json(res, 400, rpcError('server-error', -32600, 'Bad Request: Missing session ID'));
    return;
  }
  const protocol = req.headers['mcp-protocol-version'];
  if (protocol !== undefined && !SUPPORTED_VERSIONS.includes(protocol)) {
    json(res, 400, rpcError('server-error', -32600, `Bad Request: Unsupported protocol version: ${protocol}`));
    return;
  }
  if (msg.id === undefined) {
    // A notification, or a client's response to a server request: accepted, no body.
    if (msg.method === 'notifications/fake_fail') {
      json(res, 500, rpcError('server-error', -32603, 'Internal Server Error'));
      return;
    }
    if (msg.method === 'notifications/fake_drop') {
      res.socket.destroy();
      return;
    }
    if (msg.method === 'notifications/fake_hang') return;
    if (msg.method === 'notifications/initialized') {
      if (failNextInitialized) {
        failNextInitialized = false;
        json(res, 500, rpcError('server-error', -32603, 'Internal Server Error'));
        return;
      }
      setTimeout(() => {
        if (sessions.has(sid)) sessions.set(sid, true);
        log({ ev: 'initialized', session: sid });
        res.writeHead(202);
        res.end();
      }, slowInitialized);
      return;
    }
    res.writeHead(202);
    res.end();
    return;
  }
  if (!sessions.get(sid) && msg.method !== 'ping') {
    json(res, 200, rpcError(msg.id, -32602, 'Received request before initialization was complete'));
    return;
  }
  if (msg.method === 'tools/list') {
    json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [
      {
        name: 'echo',
        description: 'Echoes its arguments.',
        inputSchema: { type: 'object', properties: { relative_path: { type: 'string' } } },
      },
      { name: 'forget_sessions', inputSchema: { type: 'object' } },
      { name: 'no_reply', inputSchema: { type: 'object' } },
      { name: 'reply_then_drop', inputSchema: { type: 'object' } },
      { name: 'drop_next', inputSchema: { type: 'object' } },
      { name: 'nohdr_drop', inputSchema: { type: 'object' } },
      { name: 'headers_then_drop', inputSchema: { type: 'object' } },
      { name: 'progress_then_drop', inputSchema: { type: 'object' } },
      { name: 'request_then_drop', inputSchema: { type: 'object' } },
      { name: 'http_500', inputSchema: { type: 'object' } },
      { name: 'big', inputSchema: { type: 'object' } },
      { name: 'fail_next_initialized', inputSchema: { type: 'object' } },
      { name: 'hang_next_initialize', inputSchema: { type: 'object' } },
      { name: 'error_next_initialize', inputSchema: { type: 'object' } },
      { name: 'noreply_next_initialize', inputSchema: { type: 'object' } },
      { name: 'drop_next_initialize', inputSchema: { type: 'object' } },
      { name: 'block', inputSchema: { type: 'object' } },
      { name: 'wait', inputSchema: { type: 'object' } },
      { name: 'iserror', inputSchema: { type: 'object' } },
      { name: 'rpc_error', inputSchema: { type: 'object' } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'forget_sessions') sessions.clear();
    if (name === 'drop_next') dropNext = true;
    if (name === 'fail_next_initialized') failNextInitialized = true;
    if (name === 'hang_next_initialize') hangNextInitialize = true;
    if (name === 'error_next_initialize') initNoResult = 'error';
    if (name === 'noreply_next_initialize') initNoResult = 'noreply';
    if (name === 'drop_next_initialize') initNoResult = 'drop';
    if (name === 'block') {
      log({ ev: 'block-start', id: msg.id });
      const end = Date.now() + (Number(args.ms) || 0);
      const until = typeof args.until === 'string' ? args.until : null;
      while (Date.now() < end && !(until && fs.existsSync(until))) { /* busy: nothing else on this server runs */ }
      log({ ev: 'block-end', id: msg.id });
    }
    if (name === 'wait') {
      const text = JSON.stringify({ pid: process.pid, root, session: sid, tool: name, args });
      setTimeout(() => json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }),
        Number(args.ms) || 0);
      return;
    }
    if (name === 'http_500') {
      json(res, 500, rpcError('server-error', -32603, 'Internal Server Error'));
      return;
    }
    if (name === 'iserror') {
      json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'tool failed' }], isError: true } });
      return;
    }
    if (name === 'rpc_error') {
      json(res, 200, rpcError(msg.id, -32000, 'fake: tool call failed'));
      return;
    }
    const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: msg.id, progress: 1 } };
    if (name === 'no_reply') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify(progress)}\n\n`);
      return;
    }
    if (name === 'nohdr_drop') {
      // No headers are written, so there is nothing a destroy could cut short.
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    // The drops below destroy the socket only in a write callback, once the
    // bytes have reached it; a destroy right after writeHead or flushHeaders
    // can discard the headers, and the client would see `nohdr_drop` instead.
    const dropAfter = (event) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event, () => res.socket.destroy());
    };
    if (name === 'headers_then_drop') {
      dropAfter(': open\n\n');
      return;
    }
    if (name === 'progress_then_drop') {
      dropAfter(`event: message\ndata: ${JSON.stringify(progress)}\n\n`);
      return;
    }
    if (name === 'request_then_drop') {
      const serverRequest = { jsonrpc: '2.0', id: msg.id, method: 'roots/list' };
      dropAfter(`event: message\ndata: ${JSON.stringify(serverRequest)}\n\n`);
      return;
    }
    const text = name === 'big' ? 'x'.repeat(Number(args.size) || 0)
      : JSON.stringify({ pid: process.pid, root, session: sid, tool: name, args });
    const result = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
    if (name === 'reply_then_drop') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Destroy only once the event has reached the socket, so the client
      // has the whole result before the connection breaks.
      res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`, () => res.socket.destroy());
      return;
    }
    if (args.reply === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`event: message\r\ndata: ${JSON.stringify(progress)}\r\n\r\n`);
      // One event, two data lines: the relay must join them before parsing.
      // Written in two parts, cut between the CR and the LF that end the
      // first data line, far enough apart in time to arrive as two reads.
      const body = JSON.stringify(result);
      const cut = body.indexOf(',"result"') + 1;
      res.write(`event: message\r\ndata: ${body.slice(0, cut)}\r`);
      setTimeout(() => res.end(`\ndata: ${body.slice(cut)}\r\n\r\n`), 30);
      return;
    }
    json(res, 200, result);
    return;
  }
  json(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
}

const server = http.createServer((req, res) => {
  if ((req.method !== 'POST' && req.method !== 'DELETE') || req.url !== '/mcp') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (dropNext) {
    dropNext = false;
    log({ ev: 'dropped' });
    req.socket.destroy();
    return;
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; });
  req.on('end', () => handle(req, res, raw));
});

server.on('error', (e) => {
  console.error(`fake-mcp-http: ${e.message}`);
  process.exit(1);
});

setTimeout(() => {
  server.listen({ port, host: '127.0.0.1', backlog }, () => log({ ev: 'listen' }));
}, delayListen);
