"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { panelFixture } = require("../test-support/panel");
const { testPKI } = require("../test-support/agent-pki");
const { createAgentServer } = require("../agent/daemon");
const ID = "a".repeat(64), FOREIGN = "b".repeat(64);

test("panel agent mode preserves user permissions and state, blocks legacy APIs, and reports disconnection", { timeout: 30000 }, async (t) => {
  const pki = testPKI(); t.after(pki.cleanup);
  let calls = 0;
  const agent = createAgentServer({
    async list() { return [{ id: ID, serverId: "authorized", running: false, state: "created" }]; },
    async inspectManaged(id) { if (id !== ID) throw Object.assign(new Error("foreign"), { code: "NOT_MANAGED" }); },
    async lifecycle() { calls++; }
  }, { tls: pki.server });
  agent.listen(0, "127.0.0.1"); await once(agent, "listening");
  t.after(() => new Promise((resolve) => agent.close(resolve)));
  const f = await panelFixture(t, undefined, { legacyToken: false, env: {
    GAMEPANEL_BACKEND: "agent", GAMEPANEL_AGENT_URL: `https://127.0.0.1:${agent.address().port}`,
    GAMEPANEL_AGENT_CA_FILE: pki.client.ca, GAMEPANEL_AGENT_CERT_FILE: pki.client.cert, GAMEPANEL_AGENT_KEY_FILE: pki.client.key,
    GAMEPANEL_AGENT_PEER_POLICY_FILE: pki.client.policy, GAMEPANEL_AGENT_PEER_NAME: pki.client.peerName
  } });
  const request = async (route, token, method = "GET", body) => {
    const response = await fetch(f.url + "/api" + route, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  async function login(username, password) {
    const r = await request("/auth/login", null, "POST", { username, password }); assert.equal(r.status, 200); return r.body.token;
  }
  const admin = await login("admin", f.token);
  assert.equal((await request("/servers", null)).status, 401);
  assert.equal((await request("/servers", admin)).body.servers[0].id, ID);
  assert.equal((await request("/users", admin, "POST", { username: "operator", password: f.token, serverIds: [ID] })).status, 201);
  assert.equal((await request("/users", admin, "POST", { username: "unassigned", password: f.token })).status, 201);
  const operator = await login("operator", f.token), unassigned = await login("unassigned", f.token);
  assert.deepEqual((await request("/servers", unassigned)).body.servers, []);
  assert.equal((await request(`/servers/${ID}/actions`, unassigned, "POST", { action: "start" })).status, 404);
  assert.equal((await request(`/servers/${FOREIGN}/actions`, operator, "POST", { action: "start" })).status, 404);
  assert.equal((await request(`/servers/${FOREIGN}/actions`, admin, "POST", { action: "start" })).status, 404);
  for (const action of ["start", "stop", "restart"]) assert.equal((await request(`/servers/${ID}/actions`, operator, "POST", { action })).status, 200);
  assert.equal(calls, 3);
  assert.equal((await request(`/servers/${ID}/actions`, operator, "POST", { action: "start", image: "arbitrary" })).status, 400);
  for (const route of ["/docker", `/servers/${ID}/files`, `/servers/${ID}/backups`, `/servers/${ID}/console-ticket`]) assert.equal((await request(route, admin)).status, 501);
  assert.equal((await request("/servers", admin, "POST", { templateId: "minecraft-paper" })).status, 400);
  assert.equal((await request("/users/operator", admin, "PUT", { serverIds: [] })).status, 200);
  assert.equal((await request(`/servers/${ID}/actions`, operator, "POST", { action: "start" })).status, 404, "permission removal takes immediate effect");
  await new Promise((resolve) => agent.close(resolve));
  const status = (await request("/status", admin)).body;
  assert.equal(status.backend, "agent"); assert.equal(status.ok, false); assert.match(status.error, /agent unavailable/);
  assert.ok(!status.error.includes(pki.dir));
  await f.stop(); await f.start();
  const renewed = await login("admin", f.token);
  assert.equal((await request("/users", renewed)).body.users.length, 3);
  assert.deepEqual((await request("/servers", renewed)).body.servers, []);
});
