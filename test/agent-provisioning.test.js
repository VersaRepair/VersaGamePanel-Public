"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const { createDockerAdapter } = require("../agent/docker-adapter");
const { PROFILE } = require("../agent/provisioning");
const { provisioningEngine } = require("../test-support/provisioning-engine");
const { createAgentServer } = require("../agent/daemon");
const { createAgentClient } = require("../lib/agent-client");
const { testPKI } = require("../test-support/agent-pki");

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vgp-provision-unit-")));
  const root = path.join(base, "games"), state = path.join(base, "state");
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const engine = provisioningEngine();
  const open = () => createDockerAdapter({ dataRoot: root, stateRoot: state, execute: engine.execute });
  const adapter = open();
  t.after(async () => { await adapter.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, state, engine, adapter, open, input: (serverId = randomUUID()) => ({ serverId, name: "Disposable smoke", profile: PROFILE.id }) };
}

test("approved creation is pinned, bounded, private, persistent and never adopts foreign identities", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.adapter.list(), []);
  assert.throws(f.open, /EEXIST/, "one process owns a provisioning registry");
  const input = f.input(), created = await f.adapter.provision(input);
  assert.equal(created.running, false);
  assert.equal(fs.statSync(path.join(f.root, input.serverId)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.state, "registry.json")).mode & 0o777, 0o600);
  const command = f.engine.calls.find((c) => c[1] === "create");
  for (const arg of [PROFILE.image, "--pull=never", "--network", "none", "--read-only", "--cap-drop=ALL", "--memory=128m", "--memory-swap=128m", "--cpus=0.5", "--pids-limit=32"]) assert.ok(command.includes(arg));
  for (const action of ["start", "restart", "stop"]) await f.adapter.lifecycle(created.id, action);
  await assert.rejects(f.adapter.provision(input), { code: "CONFLICT" });
  f.engine.records.set("f".repeat(64), { ...structuredClone(f.engine.records.get(created.id)), Id: "f".repeat(64), Name: "/foreign-with-copied-labels" });
  await assert.rejects(f.adapter.lifecycle("f".repeat(64), "start"), { code: "NOT_MANAGED" });
  await assert.rejects(f.adapter.remove("f".repeat(64), { confirm: "f".repeat(64) }), { code: "NOT_MANAGED" });
  await f.adapter.close();
  const reopened = f.open();
  try {
    assert.equal((await reopened.list())[0].id, created.id);
    await reopened.lifecycle(created.id, "start");
    await assert.rejects(reopened.remove(created.id, { confirm: created.id }), { code: "CONFLICT" });
    await reopened.lifecycle(created.id, "stop");
    const canary = path.join(f.base, "canary"); fs.writeFileSync(canary, "outside");
    fs.symlinkSync(canary, path.join(f.root, input.serverId, "link"));
    await reopened.remove(created.id, { confirm: created.id });
    assert.equal(fs.readFileSync(canary, "utf8"), "outside");
    assert.equal(fs.existsSync(path.join(f.root, input.serverId)), false);
    assert.deepEqual(await reopened.list(), []);
    await assert.rejects(reopened.provision(input), { code: "CONFLICT" }, "deleted IDs are never reused");
  } finally { await reopened.close(); }
});

test("schema, traversal, preexisting folders/symlinks and Docker-name collisions are rejected without adoption", async (t) => {
  const f = fixture(t), valid = f.input();
  for (const body of [null, [], {}, { ...valid, serverId: "../escape" }, { ...valid, profile: "arbitrary-image" }, { ...valid, name: "../escape" },
    ...["image", "command", "path", "mounts", "devices", "privileged", "networkMode", "cpus", "owner"].map((key) => ({ ...valid, [key]: "unsafe" }))]) await assert.rejects(f.adapter.provision(body), { code: "BAD_REQUEST" });
  const id = randomUUID(), outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, id));
  await assert.rejects(f.adapter.provision(f.input(id)), { code: "CONFLICT" });
  assert.equal(f.engine.records.size, 0);
  const occupied = randomUUID(); fs.mkdirSync(path.join(f.root, occupied)); fs.writeFileSync(path.join(f.root, occupied, "canary"), "preserve");
  await assert.rejects(f.adapter.provision(f.input(occupied)), { code: "CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.root, occupied, "canary"), "utf8"), "preserve");
  const agentId = JSON.parse(fs.readFileSync(path.join(f.state, "registry.json"))).agentId;
  const collision = f.input();
  f.engine.records.set("f".repeat(64), { Id: "f".repeat(64), Name: `/vgpa_${agentId}_${collision.serverId}`, foreign: true });
  await assert.rejects(f.adapter.provision(collision), { code: "CONFLICT" });
  assert.equal(f.engine.records.get("f".repeat(64)).foreign, true);
  assert.equal(fs.existsSync(path.join(f.root, collision.serverId)), false);
});

test("exact immutable identity and approved configuration are rechecked before lifecycle or deletion", async (t) => {
  const f = fixture(t), input = f.input(), created = await f.adapter.provision(input);
  const original = structuredClone(f.engine.records.get(created.id));
  for (const change of [
    (r) => { r.Image = "sha256:" + "a".repeat(64); },
    (r) => { r.Config.Labels["com.versarepair.versagamepanel.transaction"] = randomUUID(); },
    (r) => { r.HostConfig.Privileged = true; },
    (r) => { r.HostConfig.NetworkMode = "host"; },
    (r) => { r.HostConfig.Memory = 0; },
    (r) => { r.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    (r) => { r.Config.Cmd = ["arbitrary"]; },
    (r) => { r.Mounts[0].Source = f.base; }
  ]) {
    const edited = structuredClone(original); change(edited); f.engine.records.set(created.id, edited);
    await assert.rejects(f.adapter.lifecycle(created.id, "start"), { code: "UNSAFE" });
    await assert.rejects(f.adapter.remove(created.id, { confirm: created.id }));
  }
  f.engine.records.set(created.id, original);
  const location = path.join(f.root, input.serverId), held = path.join(f.root, "held");
  fs.renameSync(location, held); fs.symlinkSync(f.base, location);
  await assert.rejects(f.adapter.lifecycle(created.id, "start"), { code: "UNSAFE" });
  fs.unlinkSync(location); fs.renameSync(held, location);
  assert.equal(f.engine.calls.filter((c) => ["start", "rm"].includes(c[1])).length, 0);
});

test("mutations are bounded and verified partial creates roll back only their own resources", async (t) => {
  const f = fixture(t);
  let entered, resume;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  f.engine.beforeCreate = async () => { entered(); await gate; };
  const first = f.adapter.provision(f.input()); await started;
  await assert.rejects(f.adapter.provision(f.input()), { code: "BUSY" });
  resume(); const created = await first;
  f.engine.beforeCreate = null;
  const input = f.input(); f.engine.afterCreate = async () => { throw new Error("simulated lost create reply"); };
  await assert.rejects(f.adapter.provision(input), /lost create reply/);
  assert.equal(f.engine.records.size, 1); assert.equal(f.engine.records.has(created.id), true);
  assert.equal(fs.existsSync(path.join(f.root, input.serverId)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "registry.json"))).servers[input.serverId].phase, "deleted");
  f.engine.afterCreate = null;
  const uncertain = f.input(); f.engine.beforeCreate = async () => { throw new Error("daemon timed out before a definitive result"); };
  await assert.rejects(f.adapter.provision(uncertain), { code: "CLEANUP_PENDING" });
  assert.equal(fs.existsSync(path.join(f.root, uncertain.serverId)), true, "uncertain outcomes retain only the reserved directory for review");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "registry.json"))).servers[uncertain.serverId].phase, "review");
});

test("authenticated peers need an explicit provisioning capability; malformed and duplicate requests fail closed", async (t) => {
  const f = fixture(t), pki = testPKI();
  const server = createAgentServer(f.adapter, { tls: pki.server });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = createAgentClient({ url: `https://127.0.0.1:${server.address().port}`, tls: pki.client });
    const input = f.input();
    await assert.rejects(client.provision(input), { statusCode: 403 });
    pki.policy("server-peers", [pki.panel.pin], [], [pki.panel.pin]);
    const created = (await client.provision(input)).server;
    assert.equal(created.disposable, true);
    await assert.rejects(client.provision(input), { statusCode: 409 });
    await assert.rejects(client.provision({ ...f.input(), command: "unsafe" }), { statusCode: 400 });
    for (const malformed of [null, [], {}, { ...f.input(), name: "a".repeat(2048) }]) await assert.rejects(client.provision(malformed));
    const rogue = pki.issue("bad-provisioner", "client", { issuer: "rogue-ca" });
    const untrusted = createAgentClient({ url: `https://127.0.0.1:${server.address().port}`, tls: { ...pki.client, ...rogue } });
    await assert.rejects(untrusted.provision(f.input()));
    pki.policy("server-peers", [pki.panel.pin], [pki.panel.pin], [pki.panel.pin]);
    await assert.rejects(client.provision(f.input()), { statusCode: 403 });
    pki.policy("server-peers", [pki.panel.pin], [], [pki.panel.pin]);
    await assert.rejects(client.remove("f".repeat(64), { confirm: "f".repeat(64) }), { statusCode: 404 });
    await assert.rejects(client.remove(created.id, { confirm: "wrong" }), { statusCode: 400 });
    await client.remove(created.id, { confirm: created.id });
    assert.deepEqual(await client.list(), []);
  } finally { await new Promise((resolve) => server.close(resolve)); await f.adapter.close(); pki.cleanup(); }
});

test("capacity is agent-owned and cannot be increased through request configuration", async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 8; n++) await f.adapter.provision(f.input());
  const ninth = f.input();
  await assert.rejects(f.adapter.provision(ninth), { code: "TOO_MANY" });
  assert.equal(f.engine.records.size, 8);
  assert.equal(fs.existsSync(path.join(f.root, ninth.serverId)), false);
});

test("a missing registry is never silently reinitialized over an established agent identity", async (t) => {
  const f = fixture(t); await f.adapter.close();
  const registry = path.join(f.state, "registry.json"), held = path.join(f.state, "preserved-registry");
  const identity = fs.readFileSync(path.join(f.state, "agent-id"), "utf8");
  fs.renameSync(registry, held);
  assert.throws(f.open, { code: "UNSAFE" });
  assert.equal(fs.existsSync(registry), false);
  assert.equal(fs.readFileSync(path.join(f.state, "agent-id"), "utf8"), identity);
  fs.renameSync(held, registry);
  const reopened = f.open(); await reopened.close();
});
