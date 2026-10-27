"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createDockerAdapter } = require("../agent/docker-adapter");
const { MINECRAFT, configuredMinecraft } = require("../agent/minecraft-profile");
const { provisioningEngine } = require("../test-support/provisioning-engine");
const { allowedLine } = require("../lib/agent-commands");
function fixture(t, memoryBudgetGiB = 6) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vgp-game-unit-"))), root = path.join(base, "games"), state = path.join(base, "state");
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const engine = provisioningEngine();
  const open = () => createDockerAdapter({ dataRoot: root, stateRoot: state, execute: engine.execute, createRuntime: engine.createConsole, memoryBudgetGiB, minecraftImage: engine.imageId, terrariaImage: engine.imageId, unturnedImage: engine.imageId });
  const adapter = open(); t.after(async () => { await adapter.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { adapter, engine, root, open, input: (port = 25565) => ({ profile: MINECRAFT.id, serverId: randomUUID(), name: "Brother Minecraft", port, eula: true }) };
}
test("real-game profile fixes image/resources/private port and isolates storage/network; identities persist", async (t) => {
  const f = fixture(t), input = f.input(), server = await f.adapter.provision(input), obj = f.engine.records.get(server.id);
  assert.equal(server.disposable, false); assert.equal(server.connection.address, "127.0.0.1"); assert.equal(server.connection.port, 25565);
  assert.equal(obj.Config.Image, f.engine.imageId); assert.equal(obj.HostConfig.Memory, 3 * 1024 ** 3); assert.equal(obj.Config.StdinOnce, false);
  assert.equal(f.engine.networks.size, 1); assert.equal(obj.HostConfig.Privileged, false); assert.equal(fs.statSync(path.join(f.root, input.serverId)).mode & 0o777, 0o700);
  await f.adapter.lifecycle(server.id, "start"); await f.adapter.lifecycle(server.id, "stop");
  assert.ok(f.engine.calls.some((a) => a[1] === "stop" && a.includes("60")));
  await f.adapter.close(); const reopened = f.open();
  try { assert.equal((await reopened.list())[0].id, server.id); await reopened.remove(server.id, { confirm: server.id }); }
  finally { await reopened.close(); }
  assert.equal(f.engine.networks.size, 0); assert.equal(f.engine.records.size, 0); assert.equal(fs.existsSync(path.join(f.root, input.serverId)), false);
});
test("game configuration requires explicit EULA and bounded unique ports; rejects flags/images/paths", async (t) => {
  const f = fixture(t);
  for (const patch of [{ eula: false }, { port: 0 }, { port: 65536 }, { port: "25565" }, { image: "unsafe" }, { path: "../data" }, { cpu: 99 }, { network: "host" }]) await assert.rejects(f.adapter.provision({ ...f.input(), ...patch }), { code: "BAD_REQUEST" });
  assert.equal(f.engine.records.size, 0); assert.deepEqual(fs.readdirSync(f.root), []);
  await f.adapter.provision(f.input()); await assert.rejects(f.adapter.provision(f.input()), { code: "CONFLICT" });
  await f.adapter.provision(f.input(25566)); await assert.rejects(f.adapter.provision(f.input(25567)), { code: "TOO_MANY" });
});
test("foreign endpoints or extra networks block game lifecycle and deletion without touching them", async (t) => {
  const f = fixture(t), s = await f.adapter.provision(f.input()), obj = f.engine.records.get(s.id), network = f.engine.networks.get(obj.HostConfig.NetworkMode);
  network.Containers["f".repeat(64)] = {};
  await assert.rejects(f.adapter.lifecycle(s.id, "start"), { code: "UNSAFE" }); await assert.rejects(f.adapter.remove(s.id, { confirm: s.id }));
  assert.equal(f.engine.networks.size, 1); assert.equal(f.engine.records.size, 1);
  delete network.Containers["f".repeat(64)]; obj.NetworkSettings.Networks.foreign = { NetworkID: "f".repeat(64) };
  await assert.rejects(f.adapter.lifecycle(s.id, "start"), { code: "UNSAFE" });
});
test("game commands remain line-oriented and profile-specific; public/wildcard images/bindings fail", () => {
  for (const line of ["list", "seed", "save-all flush", "say Hello brother!"]) assert.equal(allowedLine(line, "minecraft"), true);
  for (const line of ["op player", "stop", "say hello\nstop", "say $(id)", "ping", "execute run stop"]) assert.equal(allowedLine(line, "minecraft"), false);
  assert.throws(() => configuredMinecraft("latest")); for (const ip of ["0.0.0.0", "8.8.8.8", "::"]) assert.throws(() => configuredMinecraft("sha256:" + "a".repeat(64), ip));
});
test("dedicated profiles preserve reviewed entrypoints, port protocols and running-memory admission", async (t) => {
  const f = fixture(t, 9);
  const create = (profile, port) => f.adapter.provision({ profile, port, eula: true, name: "Dedicated game", serverId: randomUUID() });
  const terraria = await create("terraria-vanilla", 7777), secondTerraria = await create("terraria-vanilla", 7778), unturned = await create("unturned-dedicated", 27015);
  const vanilla = f.engine.records.get(terraria.id);
  assert.equal(vanilla.HostConfig.Tmpfs["/tmp"], "rw,nosuid,nodev,noexec,size=256m");
  const u = f.engine.records.get(unturned.id);
  assert.deepEqual(u.Config.Entrypoint, ["node", "/opt/vgp/game-runner.js", "unturned"]);
  assert.deepEqual(Object.keys(u.HostConfig.PortBindings), ["27015/udp", "27016/udp"]); assert.equal(u.HostConfig.Memory, 6 * 1024 ** 3);
  await assert.rejects(create("unturned-dedicated", 27016), { code: "BAD_REQUEST" });
  await f.adapter.lifecycle(unturned.id, "start"); await f.adapter.lifecycle(terraria.id, "start");
  await assert.rejects(f.adapter.lifecycle(secondTerraria.id, "restart"), { code: "RESOURCE_LIMIT" });
  await f.adapter.lifecycle(unturned.id, "stop"); await f.adapter.lifecycle(secondTerraria.id, "restart");
  assert.equal(f.engine.records.get(secondTerraria.id).State.Running, true);
  for (const line of ["save", "playing", "version"]) assert.equal(allowedLine(line, "terraria"), true);
  for (const line of ["Save", "Players"]) assert.equal(allowedLine(line, "unturned"), true);
  assert.equal(allowedLine("Shutdown", "unturned"), false); assert.equal(allowedLine("save\nexit", "terraria"), false);
});
