"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { panelFixture } = require("../test-support/panel");
const { gameDefinition, blockedReason } = require("../lib/game-registry");
const { directConnectivity, directEndpoints } = require("../lib/direct-connectivity");
const { dockerRunArgs, validatePorts } = require("../lib/docker-runtime");
const { replaceDirectory } = require("../lib/directory-transaction");
const { serverOperations } = require("../lib/server-operations");
const { saveJson } = require("../lib/json-store");

test("fresh panel stays empty; definitions, Direct settings and identity survive restart", { timeout: 20000 }, async (t) => {
  const f = await panelFixture(t);
  assert.deepEqual((await (await f.request("/servers")).json()).servers, []);
  const templates = (await (await f.request("/templates")).json()).templates;
  assert.ok(!templates.some((item) => item.id === "unturned-imported-native"));
  assert.ok(!templates.some((item) => item.id === "terraria-tmodloader"));
  assert.ok(!templates.some((item) => item.id === "terraria-tmodloader-reviewed"));
  assert.ok(templates.some((item) => item.id === "unturned-linuxgsm"));
  assert.equal(templates[0].definition.schemaVersion, 1);
  for (const body of [{ templateId: "not-a-game" }, { templateId: "unturned-imported-native" }, { templateId: "minecraft-paper", runtimeKind: "systemd", native: { service: "arbitrary" } }]) {
    assert.equal((await f.request("/servers", { method: "POST", body })).status, 400);
  }
  const created = await f.request("/servers", { method: "POST", body: { templateId: "minecraft-paper", name: "Disposable journey" } });
  assert.equal(created.status, 201);
  const server = (await created.json()).server;
  assert.equal(server.networkMode, "bridge");
  assert.equal(server.ports[0].bindAddress, "127.0.0.1");
  assert.equal(server.endpoints[0].joinAddress, "");
  assert.equal(server.env.EULA, "FALSE");
  assert.equal(server.resources.memoryMiB, 3072);
  const saved = await f.request(`/servers/${server.id}`, { method: "PUT", body: { connectivity: { provider: "direct", advertisedHost: "games.example.test" } } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).server.endpoints[0].joinAddress, "games.example.test:25565");
  assert.equal((await f.request(`/servers/${server.id}/actions`, { method: "POST", body: { action: "start" } })).status, 500, "EULA remains required");
  await f.stop();
  await f.start();
  const restored = (await (await f.request("/servers")).json()).servers;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, server.id);
  assert.equal(restored[0].connectivity.advertisedHost, "games.example.test");
  assert.equal(restored[0].env.EULA, "FALSE");
});

test("legacy native and unknown records are preserved, never probed or managed", async (t) => {
  const records = [
    { id: "family", templateId: "unturned-imported-native", runtimeKind: "systemd", native: { service: "do-not-touch", dataRoot: "/outside/personal", managedData: true } },
    { id: "unknown", templateId: "missing-definition", env: { PRIVATE: "kept" } }
  ];
  const f = await panelFixture(t, records);
  const listed = (await (await f.request("/servers")).json()).servers;
  assert.equal(listed.length, 2);
  assert.ok(listed.every((server) => server.managementBlocked && server.runtime.status === "review required"));
  for (const server of listed) {
    for (const [route, method, body] of [["/actions", "POST", { action: "start" }], ["/files", "GET"], ["", "DELETE"], ["/console-ticket", "POST", { mode: "console" }]]) {
      assert.equal((await f.request(`/servers/${server.id}${route}`, { method, body })).status, 409);
    }
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.data, "state.json"), "utf8")).servers, records);
});

test("malformed persistent state is not replaced with an empty installation", async (t) => {
  const f = await panelFixture(t);
  await f.stop();
  const file = path.join(f.data, "state.json");
  await fs.writeFile(file, "{broken-but-preserved");
  await assert.rejects(f.start(), /did not start/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken-but-preserved");
});

test("Direct and Docker contracts validate addresses, ports and resource limits", () => {
  assert.throws(() => directConnectivity({ provider: "playit" }));
  assert.throws(() => directConnectivity({ advertisedHost: "https://example.test:123" }));
  assert.throws(() => validatePorts([{ host: "22;cmd", container: 25565 }]));
  assert.throws(() => validatePorts([{ host: 25565, container: 25565, bindAddress: "bad" }]));
  assert.equal(directEndpoints({ ports: [{ host: 25565 }], connectivity: { advertisedHost: "::1" } })[0].joinAddress, "[::1]:25565");
  const record = { id: "one", name: "one", image: "example:test", env: {}, networkMode: "bridge", ports: [{ host: 25565, container: 25565 }], autoStart: true };
  const args = dockerRunArgs(record, { name: "gp_one", dataDirectory: "/isolated/one", runAs: "1000:1000" });
  assert.ok(args.includes("127.0.0.1:25565:25565/tcp"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("3072m"));
  assert.ok(args.includes("1000:1000"));
  assert.ok(!args.includes("--privileged"));
  assert.equal(blockedReason({ templateId: "unturned-imported-native" }, []), blockedReason({ runtimeKind: "systemd" }, []));
  assert.equal(gameDefinition({ id: "test" }).verification, "experimental");
});

test("world directory promotion rolls back failure and replaces cleanly on success", async (t) => {
  const f = await panelFixture(t);
  const old = path.join(f.base, "world");
  const incoming = path.join(f.base, "new-world");
  await fs.mkdir(old); await fs.mkdir(incoming);
  await fs.writeFile(path.join(old, "old.txt"), "original");
  await fs.writeFile(path.join(incoming, "new.txt"), "restored");
  await assert.rejects(replaceDirectory(incoming, old, { promote: async () => { throw new Error("injected failure"); } }), /injected failure/);
  assert.equal(await fs.readFile(path.join(old, "old.txt"), "utf8"), "original");
  await replaceDirectory(incoming, old);
  assert.equal(await fs.readFile(path.join(old, "new.txt"), "utf8"), "restored");
  await assert.rejects(fs.stat(path.join(old, "old.txt")), { code: "ENOENT" });
  assert.ok(!(await fs.readdir(f.base)).some((name) => name.startsWith(".gp-")));
});

test("concurrent JSON snapshots serialize and persist privately without temp files", async (t) => {
  const f = await panelFixture(t);
  const file = path.join(f.base, "snapshots.json");
  await Promise.all(Array.from({ length: 20 }, (_, value) => saveJson(file, { value })));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { value: 19 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await fs.readdir(f.base)).some((name) => name.includes(".tmp-")));
});

test("server mutations serialize, recover after failure, and do not block other servers", async () => {
  const run = serverOperations();
  let release;
  const order = [];
  const first = run("one", () => new Promise((resolve) => { release = resolve; order.push("first"); }));
  const second = run("one", () => { order.push("second"); throw new Error("expected"); });
  const rejected = assert.rejects(second, /expected/);
  const third = run("one", () => order.push("third"));
  await run("other", () => order.push("other"));
  assert.deepEqual(order, ["first", "other"]);
  release();
  await Promise.all([first, rejected, third]);
  assert.deepEqual(order, ["first", "other", "second", "third"]);
});
