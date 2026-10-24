"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const { profiles, settings, configuration, validateProfileRuntime, workshopIds, workshopConfiguration, enabledMods } = require("../lib/game-profiles");
const { gameSnapshots } = require("../lib/game-snapshots");
const { panelFixture } = require("../test-support/panel");
const { json } = require("../test-support/minecraft");
const execute = promisify(execFile);

test("reviewed fresh game settings reject injection and preserve advanced configuration", () => {
  for (const id of Object.keys(profiles)) {
    assert.throws(() => settings(id, { SERVERNAME: "Name\nShutdown" }));
    assert.throws(() => settings(id, { MAXPLAYERS: "NaN" }));
    assert.throws(() => settings(id, { PORT: "22" }));
    assert.throws(() => settings(id, { DIFFICULTY: "arbitrary" }));
  }
  const unturned = configuration("unturned-dedicated", {}, "Name Old\nCheats\nPerspective First\n");
  assert.ok(unturned.includes("Cheats\n"));
  assert.ok(!unturned.includes("Name Old"));
  assert.ok(unturned.includes("Perspective Both"));
  const terraria = configuration("terraria-vanilla", {}, "motd=Keep advanced setting\nport=1\n");
  assert.ok(terraria.includes("motd=Keep advanced setting"));
  assert.ok(terraria.includes("upnp=0"));
  assert.ok(!terraria.includes("port=1\n"));
  assert.throws(() => validateProfileRuntime({ templateId: "unturned-dedicated", image: "arbitrary", dataMount: "/data", networkMode: "bridge" }), /reviewed profile/);
  assert.throws(() => validateProfileRuntime({ templateId: "terraria-vanilla", image: profiles["terraria-vanilla"].image, dataMount: "/data", networkMode: "bridge", ports: [{ container: 22, protocol: "tcp" }] }), /ports must match/);
});

test("Unturned Workshop controls validate IDs, preserve advanced options and require explicit management", () => {
  assert.deepEqual(workshopIds("123,456\n123"), [123, 456]);
  for (const input of ["not-an-id", "-1", "0", "9007199254740992", "123;command"]) assert.throws(() => workshopIds(input));
  assert.equal(workshopConfiguration({}, "unchanged uploaded file"), null);
  const result = JSON.parse(workshopConfiguration({ WORKSHOP_MANAGED: "TRUE", WORKSHOP_ITEMS: "123,456" }, '{"File_IDs":[99],"Timeout":60}'));
  assert.deepEqual(result.File_IDs, [123, 456]);
  assert.equal(result.Timeout, 60);
  assert.deepEqual(JSON.parse(workshopConfiguration({ WORKSHOP_MANAGED: "TRUE" })).File_IDs, [], "empty managed list explicitly clears IDs");
  assert.throws(() => workshopConfiguration({ WORKSHOP_MANAGED: "TRUE" }, "{broken"));
});

test("new game definitions create nothing automatically and validate edits before mutation", async (t) => {
  const f = await panelFixture(t);
  assert.equal((await json(f, "/servers")).servers.length, 0);
  for (const templateId of Object.keys(profiles)) {
    const { server } = await json(f, "/servers", { method: "POST", body: { templateId, autoStart: false } }, 201);
    assert.equal(server.runtime.exists, false);
    assert.equal(server.definition.capabilities.saveSnapshots, true);
    assert.equal(server.networkMode, "bridge");
    assert.ok(server.ports.every((port) => port.bindAddress === "127.0.0.1"));
    await json(f, `/servers/${server.id}`, { method: "PUT", body: { name: "must not mutate", env: { MAXPLAYERS: "bad" } } }, 400);
    assert.equal((await json(f, `/servers/${server.id}`)).server.name, server.name);
  }
});

test("reviewed tModLoader validates enabled names and keeps modded save paths separate from vanilla", () => {
  assert.deepEqual(enabledMods("ExampleMod,OtherMod\nExampleMod"), ["ExampleMod", "OtherMod"]);
  for (const value of ["../world", "bad-name", "mod;command", "1invalid"]) assert.throws(() => enabledMods(value));
  const modded = configuration("terraria-tmodloader-reviewed", {});
  assert.match(modded, /world=\/data\/tmodloader\/Worlds\/world\.wld/);
  assert.match(modded, /modpath=\/data\/tmodloader\/Mods/);
  assert.ok(!modded.includes("world=/data/saves"));
});

test("save snapshots restore exact data/settings, exclude binaries, reject cross-game and traversal", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "vgp-snapshots-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const backupRoot = path.join(base, "backups");
  await fs.mkdir(backupRoot);
  const server = { templateId: "unturned-dedicated", env: { SERVERNAME: "Original" } };
  const scope = path.join(dataRoot, profiles[server.templateId].scope);
  await fs.mkdir(scope, { recursive: true });
  await fs.writeFile(path.join(scope, "save.dat"), "original save");
  await fs.writeFile(path.join(dataRoot, "install", "binary"), "do not include");
  const zip = async (source, destination) => execute("zip", ["-qr", destination, path.basename(source)], { cwd: path.dirname(source) });
  const snapshots = gameSnapshots({ server, dataRoot, backupRoot, zip });
  const name = await snapshots.create();
  const archive = await snapshots.file(name);
  const listing = (await execute("unzip", ["-Z1", archive])).stdout;
  assert.ok(!listing.includes("binary"));
  assert.ok(listing.includes("save.dat"));
  await fs.writeFile(path.join(scope, "save.dat"), "damaged");
  server.env.SERVERNAME = "Changed";
  const restored = await snapshots.restore(name);
  assert.equal(restored.settings.SERVERNAME, "Original");
  assert.equal(await fs.readFile(path.join(scope, "save.dat"), "utf8"), "original save");
  assert.equal((await snapshots.list()).length, 2, "pre-restore backup retained");
  await assert.rejects(snapshots.file("../../outside.zip"));
  const other = gameSnapshots({ server: { templateId: "terraria-vanilla" }, dataRoot, backupRoot, zip });
  await assert.rejects(other.restore(name), /different game/);
  await fs.symlink("/outside", path.join(scope, "link"));
  await assert.rejects(snapshots.create(), /[Ss]ymlink|[Ss]ymbolic/);
});
