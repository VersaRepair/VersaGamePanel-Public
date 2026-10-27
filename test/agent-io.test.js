"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createLogTransport, validCommand, LIMITS } = require("../agent/log-console");
const { openDockerLogs } = require("../agent/docker-logs");
const { createAgentServer } = require("../agent/daemon");
const { createAgentClient } = require("../lib/agent-client");
const { testPKI } = require("../test-support/agent-pki");
const { panelFixture } = require("../test-support/panel");
const { WebSocket } = require("ws");
const https = require("node:https");
const { clientTLS } = require("../lib/agent-security");
const { fixtureSpec } = require("../agent/console-fixture");
const { validateCreate, PROFILE } = require("../agent/provisioning");
const ID = "a".repeat(64), OTHER = "b".repeat(64);
test("command fixture creation fixes TTY stdin lifetime without allowing caller runtime flags", () => {
  const spec = fixtureSpec({ name: "approved", labels: {}, user: "1000:1000", storage: "/private/test", image: "unsafe", command: "sh", privileged: true });
  assert.equal(spec.StdinOnce, false); assert.equal(spec.OpenStdin, true); assert.equal(spec.Tty, true);
  assert.equal(spec.HostConfig.NetworkMode, "none"); assert.equal(spec.HostConfig.Privileged, false);
  assert.match(spec.Image, /^alpine@sha256:/); assert.equal(spec.HostConfig.PidsLimit, 32);
  assert.ok(!JSON.stringify(spec).includes("unsafe"));
  for (const profile of [[PROFILE.id], {}, null, 1]) assert.throws(() => validateCreate({ profile, serverId: "11111111-1111-4111-8111-111111111111", name: "Test" }), { code: "BAD_REQUEST" });
});
function fakeLogs() {
  const children = [];
  const start = () => { const c = new EventEmitter(); c.killed = false; c.kill = () => { c.killed = true; c.emit("close", 0); }; children.push(c); return c; };
  return { start, children };
}
const managed = async (id) => {
  if (id !== ID) throw Object.assign(Error("foreign"), { code: "NOT_MANAGED" });
  return { id, serverId: "test", running: true, state: "running", console: true, generation: "first" };
};
function collected(handle) {
  let text = ""; handle.stdout.on("data", (c) => { text += c; }); handle.stderr.resume();
  return { text: () => text, ended: once(handle, "close") };
}
test("logs bound historical/live bytes, subscriptions and slow consumers; revoke/restart/disconnect clean up", async () => {
  const fake = fakeLogs(), transport = createLogTransport({ inspectIO: managed }, { start: fake.start });
  const events = [];
  const one = await transport.open(ID, true, (e) => { events.push(e); return true; }, () => {});
  const two = await transport.open(ID, true, () => true, () => {});
  await assert.rejects(transport.open(ID, true, () => true, () => {}), { code: "BUSY" });
  assert.equal(transport.active, 2); one.close(); two.close(); assert.equal(transport.active, 0);
  const history = await transport.open(ID, false, (e) => { events.push(e); return true; }, () => {});
  fake.children.at(-1).emit("data", Buffer.alloc(LIMITS.historyBytes + 8192, "a"));
  assert.equal(transport.active, 0); history.close();
  assert.ok(events.filter((e) => e.type === "output").reduce((n, e) => n + Buffer.byteLength(e.text), 0) <= LIMITS.historyBytes);
  assert.ok(events.some((e) => /limit reached/.test(e.text)));
  await transport.open(ID, true, () => true, () => {});
  fake.children.at(-1).emit("data", Buffer.alloc(LIMITS.streamBytes + 8192, "a")); assert.equal(transport.active, 0);
  await transport.open(ID, true, () => true, () => {});
  fake.children.at(-1).emit("data", Buffer.from("line\n".repeat(LIMITS.streamLines + 10))); assert.equal(transport.active, 0);
  await transport.open(ID, true, () => false, () => {});
  fake.children.at(-1).emit("data", Buffer.from("slow")); assert.equal(transport.active, 0);
  let allowed = true;
  await transport.open(ID, true, () => true, () => { if (!allowed) throw Error("revoked"); });
  allowed = false; await delay(1100); assert.equal(transport.active, 0); assert.equal(fake.children.at(-1).killed, true);
  await assert.rejects(transport.open(OTHER, true, () => true, () => {}), { code: "NOT_MANAGED" }); assert.equal(transport.active, 0);
  for (const line of ["help\nstatus", "sh", "$(id)", "ping\r", "", "ping\u0000", "x".repeat(1000)]) assert.throws(() => validCommand({ line }), { code: "BAD_REQUEST" });
  assert.throws(() => validCommand({ line: "ping", command: "whoami" }), { code: "BAD_REQUEST" });
  for (const line of ["ping", "status", "help"]) validCommand({ line });
  const global = createLogTransport({ inspectIO: async () => ({ running: true, generation: "1" }) }, { start: fake.start });
  for (let i = 0; i < LIMITS.streams; i++) await global.open(String(i), true, () => true, () => {});
  await assert.rejects(global.open("ninth", true, () => true, () => {}), { code: "BUSY" }); global.close(); assert.equal(global.active, 0);
  let generation = "1";
  const restarted = createLogTransport({ inspectIO: async () => ({ running: true, generation }) }, { start: fake.start });
  await restarted.open(ID, true, () => true, () => {}); generation = "2"; await delay(1100); assert.equal(restarted.active, 0);
});
test("Docker log decoder is fixed-route, bounded and handles fragmented stdout/stderr framing", async () => {
  let response, request, opts;
  const handle = openDockerLogs(ID, true, false, { get(options, callback) {
    opts = options; request = new EventEmitter(); request.destroy = () => {};
    response = new EventEmitter(); response.statusCode = 200; response.destroy = () => {};
    queueMicrotask(() => callback(response)); return request;
  } });
  const chunks = []; handle.on("data", (chunk) => chunks.push(chunk));
  await delay(0);
  assert.equal(opts.socketPath, "/var/run/docker.sock"); assert.equal(opts.path, `/containers/${ID}/logs?stdout=1&stderr=1&tail=200&follow=1`);
  function frame(type, text) { const bytes = Buffer.from(text), head = Buffer.alloc(8); head[0] = type; head.writeUInt32BE(bytes.length, 4); return Buffer.concat([head, bytes]); }
  const bytes = Buffer.concat([frame(1, "stdout\n"), frame(2, "stderr\n")]);
  for (const byte of bytes) response.emit("data", Buffer.from([byte]));
  assert.equal(Buffer.concat(chunks).toString(), "stdout\nstderr\n");
  const ended = once(handle, "close"); response.emit("end"); assert.deepEqual(await ended, [0]);
});
test("mTLS logs and fixed console commands enforce peer revocation and explicit console capability", { timeout: 15000 }, async (t) => {
  const pki = testPKI(), fake = fakeLogs(); t.after(pki.cleanup);
  let commands = 0;
  const agent = createAgentServer({ list: async () => [await managed(ID)], inspectManaged: managed, inspectIO: managed,
    lifecycle: async () => {}, consoleInput: async (_id, body) => { validCommand(body); commands++; return { status: "sent" }; }
  }, { tls: pki.server, logStart: fake.start });
  agent.listen(0, "127.0.0.1"); await once(agent, "listening");
  t.after(() => { agent.closeLogStreams(); agent.close(); });
  const client = createAgentClient({ url: `https://127.0.0.1:${agent.address().port}`, tls: pki.client });
  const post = (payload, headers = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({ ...clientTLS(pki.client), host: "127.0.0.1", port: agent.address().port, path: `/v1/servers/${ID}/console`, method: "POST", agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end(body);
  });
  const stream = client.openStream(ID), out = collected(stream);
  for (let i = 0; i < 30 && !fake.children.length; i++) await delay(20);
  fake.children[0].emit("data", Buffer.from("authorized logs\n"));
  await delay(50); assert.match(out.text(), /authorized logs/);
  pki.policy("server-peers", [pki.panel.pin], [pki.panel.pin]);
  await out.ended; assert.equal(fake.children[0].killed, true);
  pki.policy("server-peers", [pki.panel.pin]);
  const console = client.openStream(ID, "console"), capture = collected(console);
  const rejected = new Promise((resolve) => console.stdin.write("ping\n", (error) => resolve(error)));
  console.stdin.on("error", () => {});
  assert.ok(await rejected); assert.equal(commands, 0); console.kill(); await capture.ended;
  pki.policy("server-peers", [pki.panel.pin], [], undefined, [pki.panel.pin]);
  const permitted = client.openStream(ID, "console"); collected(permitted); permitted.stdin.on("error", () => {});
  await new Promise((resolve, reject) => permitted.stdin.write("ping\n", (error) => error ? reject(error) : resolve()));
  assert.equal(commands, 1);
  await new Promise((resolve) => permitted.stdin.write("ping\nstatus\n", (error) => { assert.ok(error); resolve(); }));
  assert.equal(commands, 1); permitted.kill();
  for (const body of [{ line: "sh" }, { line: "ping\nstatus" }, { line: "$(id)" }, { line: "ping", image: "unsafe" }]) assert.equal(await post(body), 400);
  assert.equal(await post({ line: "x".repeat(1024) }), 400);
  assert.equal(await post({ line: "ping" }, { "content-type": "text/plain" }), 400);
  const statuses = []; for (let i = 0; i < 12; i++) statuses.push(await post({ line: "ping" })); assert.ok(statuses.includes(429));
  const foreign = client.openStream(OTHER), foreignOut = collected(foreign); await foreignOut.ended;
  assert.match(foreignOut.text(), /not authorized/); assert.equal(fake.children.length, 3);
  const revokedAgent = client.openStream(ID), revokedOut = collected(revokedAgent);
  for (let i = 0; i < 30 && fake.children.length < 4; i++) await delay(20);
  pki.policy("client-peers", [pki.agent.pin], [pki.agent.pin]); await revokedOut.ended;
  assert.match(revokedOut.text(), /revoked/); await delay(100); assert.equal(fake.children.at(-1).killed, true);
});
test("socketless panel log tickets and live streams enforce server assignment and session revocation", { timeout: 20000 }, async (t) => {
  const pki = testPKI(), fake = fakeLogs(); t.after(pki.cleanup);
  const agent = createAgentServer({ list: async () => [await managed(ID)], inspectManaged: managed, inspectIO: managed, lifecycle: async () => {} }, { tls: pki.server, logStart: fake.start });
  agent.listen(0, "127.0.0.1"); await once(agent, "listening"); t.after(() => { agent.closeLogStreams(); agent.close(); });
  const f = await panelFixture(t, undefined, { legacyToken: false, env: {
    GAMEPANEL_BACKEND: "agent", GAMEPANEL_AGENT_URL: `https://127.0.0.1:${agent.address().port}`,
    GAMEPANEL_AGENT_CA_FILE: pki.client.ca, GAMEPANEL_AGENT_CERT_FILE: pki.client.cert, GAMEPANEL_AGENT_KEY_FILE: pki.client.key,
    GAMEPANEL_AGENT_PEER_POLICY_FILE: pki.client.policy, GAMEPANEL_AGENT_PEER_NAME: pki.client.peerName
  } });
  async function api(route, token, method = "GET", body) { const r = await fetch(f.url + "/api" + route, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
  const admin = (await api("/auth/login", null, "POST", { username: "admin", password: f.token })).body.token;
  await api("/users", admin, "POST", { username: "operator", password: f.token, serverIds: [ID] });
  const operator = (await api("/auth/login", null, "POST", { username: "operator", password: f.token })).body.token;
  assert.equal((await api(`/servers/${OTHER}/console-ticket`, operator, "POST", { mode: "logs" })).status, 404);
  const ticket = (await api(`/servers/${ID}/console-ticket`, operator, "POST", { mode: "logs" })).body.ticket;
  const ws = new WebSocket(f.url.replace("http:", "ws:") + `/ws/servers/${ID}/logs?ticket=${ticket}`, { origin: f.url });
  await once(ws, "open"); t.after(() => ws.terminate());
  for (let i = 0; i < 30 && !fake.children.length; i++) await delay(20);
  const message = once(ws, "message"); fake.children.at(-1).emit("data", Buffer.from("visible to assigned operator\n"));
  assert.match((await message)[0].toString(), /assigned operator/);
  const closed = once(ws, "close"); await api("/users/operator", admin, "PUT", { serverIds: [] }); await closed;
  await delay(100); assert.equal(fake.children.at(-1).killed, true);
  assert.equal((await api(`/servers/${ID}/console-ticket`, operator, "POST", { mode: "logs" })).status, 404);
});
