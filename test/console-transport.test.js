"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { PassThrough, Writable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const WebSocket = require("ws");
const { attachConsoleTransport, originAllowed } = require("../lib/console-transport");

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("condition did not become true");
}

async function fixture(t, overrides = {}) {
  const children = [];
  const writes = [];
  const commands = [];
  const httpServer = http.createServer((_req, res) => res.end("test"));
  const options = {
    authorize(req, _url, id) { return req.headers.authorization === "Bearer test-only" && id === "one" ? { id } : null; },
    runtimeFor: async (server) => ({ running: true, name: `gp_${server.id}` }),
    isNativeServer: () => false,
    nativeFor: () => ({ logFile: "/test-only.log" }),
    sendNativeConsole: async (_server, command) => { commands.push(command); return "Sent."; },
    dockerAttach(runtime) { return options.spawn("docker-api", [runtime.name]); },
    spawn(command, args) {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        child.stdout.write(chunk);
        callback();
      } });
      child.kill = (signal) => {
        child.signalCode = signal;
        setImmediate(() => child.emit("close", 0));
        return true;
      };
      child.invocation = { command, args };
      children.push(child);
      queueMicrotask(() => child.stdout.write("ready\n"));
      return child;
    },
    ...overrides
  };
  const transport = attachConsoleTransport(httpServer, options);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}/ws/servers/one/console`;
  t.after(async () => {
    transport.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  async function client(address = url, options = {}) {
    const ws = new WebSocket(address, { headers: { authorization: "Bearer test-only" }, ...options });
    ws.on("error", () => {});
    ws.output = "";
    ws.on("message", (data) => { ws.output += data.toString(); });
    await once(ws, "open");
    await until(() => ws.output.includes("ready\n") || ws.readyState === WebSocket.CLOSED);
    return ws;
  }
  return { children, writes, commands, port, url, client, transport };
}

test("origin policy accepts local browser use and rejects cross-origin/null origins", () => {
  const req = (origin, authorization) => ({ headers: { host: "panel.test:8788", origin, authorization } });
  assert.equal(originAllowed(req("http://panel.test:8788")), true);
  assert.equal(originAllowed(req("https://evil.test")), false);
  assert.equal(originAllowed(req("null")), false);
  assert.equal(originAllowed(req(undefined)), false);
  assert.equal(originAllowed(req(undefined, "Bearer test-only")), true);
  assert.equal(originAllowed(req("https://panel.test"), "https://panel.test"), true);
  assert.equal(originAllowed(req("http://panel.test:8788"), "https://panel.test"), false);
});

test("revocation immediately closes an active stream and cleans up its attachment", async (t) => {
  let allowed = true;
  const f = await fixture(t, { canContinue: () => allowed });
  const ws = await f.client();
  const closed = once(ws, "close");
  allowed = false;
  f.transport.revalidate();
  assert.equal((await closed)[0], 1008);
  await until(() => f.children[0].signalCode === "SIGTERM");
});

test("fragmented messages, ping/pong, Unicode output, and disconnect cleanup work", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const ws = await f.client();
  ws.send("say hel", { fin: false });
  ws.send("lo\n", { fin: true });
  await until(() => f.writes.join("") === "say hello\n");
  assert.equal(f.writes.length, 1);
  const unicode = Buffer.from("hello 🌍\n");
  f.children[0].stdout.write(unicode.subarray(0, 8));
  f.children[0].stdout.write(unicode.subarray(8));
  await until(() => ws.output.includes("hello 🌍\n"));
  const pong = once(ws, "pong");
  ws.ping("alive");
  assert.equal((await pong)[0].toString(), "alive");
  const closed = once(ws, "close");
  ws.close(1000);
  assert.equal((await closed)[0], 1000);
  await until(() => f.children[0].signalCode === "SIGTERM");
  assert.deepEqual(f.children[0].invocation, { command: "docker-api", args: ["gp_one"] });
});

test("a frame split across TCP packets and bytes sent with the upgrade are retained", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const socket = net.connect(f.port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", () => {});
  await once(socket, "connect");
  const payload = Buffer.from("status\n");
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask,
    Buffer.from(payload.map((value, index) => value ^ mask[index % 4]))]);
  const headers = Buffer.from(`GET /ws/servers/one/console HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nAuthorization: Bearer test-only\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  socket.write(Buffer.concat([headers, frame.subarray(0, 3)]));
  await delay(20);
  socket.write(frame.subarray(3, 7));
  await delay(20);
  socket.write(frame.subarray(7));
  await until(() => f.writes.join("") === "status\n");
  socket.destroy();
  await until(() => f.children[0].signalCode === "SIGTERM");
});

test("read-only logs, binary input, and oversized messages close without sending commands", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const [address, input, expected] of [
    [f.url.replace("/console", "/logs"), "stop\n", 1008],
    [f.url, Buffer.from("stop\n"), 1003],
    [f.url, "x".repeat(16385), 1009]
  ]) {
    const ws = await f.client(address);
    const closed = once(ws, "close");
    ws.send(input);
    assert.equal((await closed)[0], expected);
  }
  assert.deepEqual(f.writes, []);
});

test("native console commands stay ordered and logs use the recovered native mapping", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { isNativeServer: () => true });
  const ws = await f.client();
  ws.send("one\n");
  ws.send("two\n");
  await until(() => f.commands.length === 2);
  assert.deepEqual(f.commands, ["one\n", "two\n"]);
  assert.deepEqual(f.children[0].invocation, { command: "tail", args: ["-n", "240", "-F", "/test-only.log"] });
  ws.close();
});

test("unmasked and invalid UTF-8 frames are rejected by the protocol implementation", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const [input, options, code] of [
    ["must-not-run", { mask: false }, 1002],
    [Buffer.from([0xff]), { binary: false }, 1007]
  ]) {
    const ws = await f.client();
    const closed = once(ws, "close");
    ws.send(input, options);
    assert.equal((await closed)[0], code);
  }
  assert.deepEqual(f.writes, []);
});

test("invalid handshakes and connection-capacity overflow do not spawn console processes", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { limits: { maxConnections: 1 } });
  const badHandshake = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/ws/servers/one/console", headers: {
      authorization: "Bearer test-only", connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "bad-key", "sec-websocket-version": "13"
    } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHandshake, 400);
  assert.equal(f.children.length, 0);
  const first = await f.client();
  const status = await new Promise((resolve, reject) => {
    const second = new WebSocket(f.url, { headers: { authorization: "Bearer test-only" } });
    second.on("error", () => {});
    second.on("unexpected-response", (_req, res) => { res.resume(); second.terminate(); resolve(res.statusCode); });
    second.on("open", () => { second.terminate(); reject(new Error("capacity was not enforced")); });
  });
  assert.equal(status, 503);
  assert.equal(f.children.length, 1);
  first.close();
});

test("disconnect while checking runtime never leaves a late console child", { timeout: 10000 }, async (t) => {
  let releaseRuntime;
  const f = await fixture(t, { runtimeFor: () => new Promise((resolve) => { releaseRuntime = resolve; }) });
  const ws = new WebSocket(f.url, { headers: { authorization: "Bearer test-only" } });
  ws.on("error", () => {});
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.close();
  await closed;
  releaseRuntime({ name: "gp_one", running: true });
  await delay(20);
  assert.equal(f.children.length, 0);
});

test("slow output, excessive queued input, and lost heartbeats have bounded lifetimes", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { limits: { maxBufferedOutput: 64 } });
  const output = await f.client();
  let closed = once(output, "close");
  f.children[0].stdout.write("x".repeat(65));
  assert.equal((await closed)[0], 1013);
  const queue = await f.client();
  let releaseInput;
  f.children[f.children.length - 1].stdin._write = (_chunk, _encoding, callback) => { releaseInput = callback; };
  closed = once(queue, "close");
  for (let index = 0; index < 40; index += 1) queue.send("a");
  assert.equal((await closed)[0], 1008);
  releaseInput?.(new Error("test input released after disconnect"));
  const heartbeat = await f.client();
  closed = once(heartbeat, "close");
  const serverWs = [...f.transport.clients].find((candidate) => candidate.readyState === WebSocket.OPEN);
  serverWs.checkAlive();
  serverWs.checkAlive();
  assert.equal((await closed)[0], 1006);
});
