"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const { once } = require("node:events");
const test = require("node:test");
const { testPKI } = require("../test-support/agent-pki");
const { createAgentServer } = require("../agent/daemon");
const { createAgentClient } = require("../lib/agent-client");
const { privateAddress, identity } = require("../lib/agent-security");
const ID = "a".repeat(64), FOREIGN = "b".repeat(64);

async function fixture(credentials) {
  const calls = [];
  const server = createAgentServer({
    async list() { return [{ id: ID, serverId: "disposable", running: false, state: "created" }]; },
    async inspectManaged(id) { if (id !== ID) throw Object.assign(new Error("foreign"), { code: "NOT_MANAGED" }); },
    async lifecycle(id, action) { calls.push({ id, action }); }
  }, { tls: credentials });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, calls, url: `https://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
test("mutual TLS authenticates both pinned SAN identities; live revocation and foreign denial fail closed", async () => {
  const pki = testPKI(); const f = await fixture(pki.server);
  try {
    const client = createAgentClient({ url: f.url, tls: pki.client });
    assert.equal((await client.health()).status, "ok");
    assert.equal((await client.list())[0].id, ID);
    for (const action of ["start", "stop", "restart"]) await client.lifecycle(ID, action);
    assert.equal(f.calls.length, 3);
    await assert.rejects(client.lifecycle(FOREIGN, "start"), { statusCode: 404 });
    const next = pki.issue("rotated-panel", "client");
    const rotated = createAgentClient({ url: f.url, tls: { ...pki.client, ...next } });
    pki.policy("server-peers", [pki.panel.pin, next.pin]);
    assert.equal((await rotated.health()).status, "ok");
    pki.policy("server-peers", [next.pin], [pki.panel.pin]);
    await assert.rejects(client.lifecycle(ID, "start"), { statusCode: 403 });
    assert.equal((await rotated.health()).status, "ok", "new credential remains usable after old credential revocation");
    pki.policy("server-peers", [pki.panel.pin]);
    pki.policy("client-peers", [pki.agent.pin], [pki.agent.pin]);
    await assert.rejects(client.lifecycle(ID, "start"), { statusCode: 503 });
    assert.equal(f.calls.length, 3, "revoked peers never reach lifecycle operations");
  } finally { await f.close(); pki.cleanup(); }
});

test("missing, untrusted, unpinned, expired and wrong-identity client credentials cannot control the agent", async () => {
  const pki = testPKI(); const f = await fixture(pki.server);
  try {
    const candidates = [
      pki.issue("untrusted-client", "client", { issuer: "rogue-ca" }),
      pki.issue("unpinned-client", "client"),
      pki.issue("expired-client", "client", { days: "-1" }),
      pki.issue("wrong-san-client", "client", { dns: "someone-else.test" }),
      pki.issue("wrong-purpose-client", "server", { dns: "panel.test" })
    ];
    for (const candidate of candidates) {
      // All except the explicit unpinned case are allowed by pin, so CA/SAN/EKU/expiry are independently exercised.
      pki.policy("server-peers", candidate === candidates[1] ? [pki.panel.pin] : [candidate.pin]);
      const client = createAgentClient({ url: f.url, tls: { ...pki.client, ...candidate } });
      await assert.rejects(client.lifecycle(ID, "start"));
    }
    await assert.rejects(new Promise((resolve, reject) => {
      const request = https.request(f.url + `/v1/servers/${ID}/start`, { method: "POST", ca: fs.readFileSync(pki.client.ca), servername: "agent.test", rejectUnauthorized: true, agent: false }, resolve);
      request.on("error", reject); request.end();
    }));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); pki.cleanup(); }
});

test("panel rejects untrusted/expired/wrong-name/unpinned agents and safely reports disconnects", async () => {
  const pki = testPKI();
  try {
    for (const agent of [pki.issue("rogue-agent", "server", { issuer: "rogue-ca" }), pki.issue("expired-agent", "server", { days: "-1" }), pki.issue("wrong-san-agent", "server", { dns: "wrong.test" }), pki.issue("unpinned-agent", "server")]) {
      const f = await fixture({ ...pki.server, ...agent });
      try {
        pki.policy("client-peers", agent.cert.endsWith("unpinned-agent.crt") ? [pki.agent.pin] : [agent.pin]);
        await assert.rejects(createAgentClient({ url: f.url, tls: pki.client }).lifecycle(ID, "start"), { statusCode: 503 });
        assert.equal(f.calls.length, 0);
      } finally { await f.close(); }
    }
    const f = await fixture(pki.server); await f.close();
    await assert.rejects(createAgentClient({ url: f.url, tls: pki.client, timeout: 500 }).health(), { statusCode: 503 });
  } finally { pki.cleanup(); }
});

test("agent transport rejects public/wildcard listeners, plaintext URLs and exposed key files", () => {
  const pki = testPKI();
  try {
    for (const host of ["0.0.0.0", "::", "8.8.8.8", "example.com"]) assert.equal(privateAddress(host), false);
    for (const host of ["127.0.0.1", "192.168.1.205", "172.17.0.2", "100.77.88.8", "::1"]) assert.equal(privateAddress(host), true);
    for (const url of ["http://127.0.0.1", "https://8.8.8.8", "https://user:password@127.0.0.1", "https://127.0.0.1/?token=bad"]) assert.throws(() => createAgentClient({ url, tls: pki.client }));
    fs.chmodSync(pki.client.key, 0o644);
    assert.throws(() => identity(pki.client), /configuration rejected/);
  } finally { pki.cleanup(); }
});
