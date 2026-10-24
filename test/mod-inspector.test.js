"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { inspectFile, parseMetadata, report, match } = require("../lib/mod-inspector");
const { jar, fabric, uploadPlan } = require("../test-support/mod-fixtures");
const { panelFixture } = require("../test-support/panel");
const { json } = require("../test-support/minecraft");
const { modPlans } = require("../lib/mod-plans");

test("version predicates support common Fabric/Maven ranges and fail unknown rather than guessing", () => {
  assert.equal(match("1.21.1", "~1.21.1"), true);
  assert.equal(match("1.20.1", "~1.21.1"), false);
  assert.equal(match("1.21.1", "[1.21,1.22)", "maven"), true);
  assert.equal(match("1.22", "[1.21,1.22)", "maven"), false);
  assert.equal(match("1.21.1", ["1.20.4", "1.21.1"]), true);
  assert.equal(match("24w33a", ">=1.21"), null);
  assert.equal(match("${file.jarVersion}", "*"), null);
  assert.equal(match("1.21", { any: [] }), null);
});

test("Fabric, Quilt, Forge, NeoForge and pack manifests are read without executing code", () => {
  const inputs = [
    [{ "fabric.mod.json": JSON.stringify(fabric()) }, "FABRIC"],
    [{ "quilt.mod.json": JSON.stringify({ schema_version: 1, quilt_loader: { id: "sample", version: "1.0.0", depends: [{ id: "minecraft", versions: "1.21.1" }] } }) }, "QUILT"],
    [{ "META-INF/mods.toml": 'modLoader="javafml"\nloaderVersion="[52,)"\n[[mods]]\nmodId="sample"\nversion="1.0.0"\n[[dependencies.sample]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.21,1.22)"' }, "FORGE"],
    [{ "META-INF/neoforge.mods.toml": 'modLoader="javafml"\nloaderVersion="[4,)"\n[[mods]]\nmodId="sample"\nversion="1.0.0"\n[[dependencies.sample]]\nmodId="minecraft"\ntype="required"\nversionRange="[1.21,1.22)"' }, "NEOFORGE"]
  ];
  for (const [input, loader] of inputs) assert.equal(parseMetadata(input, "mod.jar").mods[0].loader, loader);
  const modrinth = parseMetadata({ "modrinth.index.json": JSON.stringify({ formatVersion: 1, game: "minecraft", dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" }, files: [{ downloads: ["http://localhost/never-requested"] }] }) }, "pack.mrpack");
  assert.equal(modrinth.packs[0].minecraft, "1.21.1");
  assert.ok(modrinth.warnings.length);
  const curse = parseMetadata({ "manifest.json": JSON.stringify({ manifestType: "minecraftModpack", manifestVersion: 1, minecraft: { version: "1.21.1" }, files: [] }) }, "pack.zip");
  assert.equal(curse.packs[0].format, "curseforge");
});

test("reports distinguish duplicate IDs, client-only files, declared conflicts, missing dependencies and version suggestions", () => {
  const make = (name, metadata) => ({ name, ...parseMetadata({ "fabric.mod.json": JSON.stringify(metadata) }, name) });
  const good = make("sample.jar", fabric());
  const wrong = report([good], { type: "VANILLA", version: "1.20.1" }, ["1.20.1", "1.21.1", "1.22"]);
  assert.deepEqual(wrong.minecraft.candidates, ["1.21.1"]);
  assert.ok(wrong.issues.some((issue) => issue.code === "wrong-loader"));
  assert.ok(wrong.issues.some((issue) => issue.code === "wrong-minecraft"));
  assert.equal(report([good], { type: "FABRIC", version: "1.21.1" }).safeToApply, true);
  assert.equal(report([good, { ...good, name: "duplicate.jar", mods: good.mods.map((m) => ({ ...m, file: "duplicate.jar" })) }], { type: "FABRIC", version: "1.21.1" }).safeToApply, false);
  const client = make("client.jar", fabric("client", { environment: "client" }));
  assert.ok(report([client], { type: "FABRIC", version: "1.21.1" }).issues.some((issue) => issue.code === "client-only"));
  const missing = make("needs.jar", fabric("needs", { depends: { minecraft: "1.21.1", library: ">=2" }, breaks: { sample: "*" } }));
  const bad = report([good, missing], { type: "FABRIC", version: "1.21.1" });
  assert.ok(bad.issues.some((issue) => issue.code === "missing-dependency"));
  assert.ok(bad.issues.some((issue) => issue.code === "declared-conflict"));
  const nested = make("nested.jar", fabric("nested", { jars: [{ file: "META-INF/jars/library.jar" }], depends: { library: "*" } }));
  assert.ok(report([nested], { type: "FABRIC", version: "1.21.1" }).issues.some((issue) => issue.code === "nested-unresolved"));
});

test("real ZIP metadata is bounded and hashes are preserved; malformed archives never execute", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "vgp-mod-inspect-")); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = await jar(base, { "fabric.mod.json": fabric(), "never-execute.sh": "exit 99\n" });
  const result = await inspectFile(file, "mod.jar"); assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.equal(result.mods[0].id, "sample");
  const malformed = await jar(base, { "fabric.mod.json": "{broken" }); await assert.rejects(inspectFile(malformed, "bad.jar"));
  const huge = await jar(base, { "fabric.mod.json": " ".repeat(1024 * 1024 + 1) }); await assert.rejects(inspectFile(huge, "huge.jar"));
});

test("authenticated staging, hash checks, EULA, stopped apply and populated-world safeguards preserve data", async (t) => {
  const f = await panelFixture(t);
  const server = (await json(f, "/servers", { method: "POST", body: { templateId: "minecraft-paper", autoStart: false, env: { VERSION: "1.20.1", TYPE: "VANILLA" } } }, 201)).server;
  const file = await jar(f.base, { "fabric.mod.json": fabric() });
  const plan = await uploadPlan(f, server.id, [["mods/sample.jar", file]]);
  const protectedRoute = `/api/servers/${server.id}/mods/plans`;
  assert.equal((await fetch(f.url + protectedRoute)).status, 401);
  await json(f, "/users", { method: "POST", body: { username: "otheroperator", password: f.token + "another", role: "operator" } }, 201);
  const other = await json(f, "/auth/login", { method: "POST", body: { username: "otheroperator", password: f.token + "another" } });
  assert.equal((await fetch(f.url + protectedRoute, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await json(f, `/servers/${server.id}`)).server.env.TYPE, "VANILLA", "inspection cannot configure a server");
  const route = `/servers/${server.id}/mods/plans/${plan.id}/apply`;
  const apply = { type: "FABRIC", version: "1.21.1", confirm: true, acceptWarnings: true };
  await json(f, route, { method: "POST", body: apply }, 400);
  await json(f, `/servers/${server.id}`, { method: "PUT", body: { env: { EULA: "TRUE" } } });
  const root = path.join(f.data, "servers", server.id); await fs.mkdir(path.join(root, "world"), { recursive: true });
  await fs.writeFile(path.join(root, "world", "level.dat"), "populated-world");
  await json(f, route, { method: "POST", body: apply }, 409);
  assert.equal(await fs.readFile(path.join(root, "world", "level.dat"), "utf8"), "populated-world");
  await fs.rm(path.join(root, "world"), { recursive: true }); // Only this synthetic disposable fixture.
  await json(f, route, { method: "POST", body: apply });
  assert.deepEqual(await fs.readFile(path.join(root, "mods", "sample.jar")), await fs.readFile(file));
  assert.equal((await json(f, `/servers/${server.id}`)).server.env.VERSION, "1.21.1");
  assert.equal((await json(f, `/servers/${server.id}/mods/plans`)).plans.length, 0);
  const backups = (await json(f, `/servers/${server.id}/mods/plans`)).backups;
  assert.equal(backups.length, 1);
  const archive = await f.request(`/servers/${server.id}/mods/backups/${backups[0].id}/download`);
  assert.equal(archive.status, 200);
  assert.equal(Buffer.from(await archive.arrayBuffer()).subarray(0, 2).toString(), "PK");
  const tampered = await uploadPlan(f, server.id, [["sample.jar", file]]);
  await fs.appendFile(path.join(f.data, "mod-staging", server.id, tampered.id, "files", "sample.jar"), "tampered");
  await json(f, `/servers/${server.id}/mods/plans/${tampered.id}/apply`, { method: "POST", body: apply }, 409);
  await json(f, `/servers/${server.id}/mods/plans/${tampered.id}`, { method: "DELETE" });
  await uploadPlan(f, server.id, [["../escape.jar", file]], 400);
  await uploadPlan(f, server.id, [["same.jar", file], ["same.jar", file]], 400);
});

test("mod apply rolls back a failed settings commit and rejects a running server", async (t) => {
  const f = await panelFixture(t);
  const { server } = await json(f, "/servers", { method: "POST", body: { templateId: "minecraft-paper", autoStart: false, env: { EULA: "TRUE", TYPE: "FABRIC", VERSION: "1.21.1" } } }, 201);
  const root = path.join(f.data, "servers", server.id); await fs.mkdir(path.join(root, "mods"), { recursive: true });
  await fs.writeFile(path.join(root, "mods", "original.jar"), "untouched");
  const file = await jar(f.base, { "fabric.mod.json": fabric() }); const plan = await uploadPlan(f, server.id, [["sample.jar", file]]);
  let running = true;
  const manager = modPlans({ server, dataRoot: root, stageRoot: path.join(f.data, "mod-staging", server.id), backupRoot: path.join(f.data, "backups", server.id), runtime: async () => ({ running }), save: async () => { throw new Error("injected state write failure"); } });
  const input = { type: "FABRIC", version: "1.21.1", confirm: true, acceptWarnings: true };
  await assert.rejects(manager.apply(plan.id, input), /stop the game/);
  running = false; await assert.rejects(manager.apply(plan.id, input), /injected state/);
  assert.equal(await fs.readFile(path.join(root, "mods", "original.jar"), "utf8"), "untouched");
  assert.equal(server.env.TYPE, "FABRIC");
});

test("reusing a deleted server name cannot adopt retained mods or backups", async (t) => {
  const f = await panelFixture(t);
  const body = { templateId: "minecraft-paper", name: "Retained custom mods", autoStart: false };
  const first = (await json(f, "/servers", { method: "POST", body }, 201)).server;
  const root = path.join(f.data, "servers", first.id); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "retained.txt"), "belongs to the previous record");
  await json(f, `/servers/${first.id}`, { method: "DELETE" });
  const second = (await json(f, "/servers", { method: "POST", body }, 201)).server;
  assert.notEqual(second.id, first.id);
  assert.equal(await fs.readFile(path.join(root, "retained.txt"), "utf8"), "belongs to the previous record");
  assert.equal((await json(f, `/servers/${second.id}/files`)).items.length, 0);
});

test("saving redacted modpack credentials preserves them; explicit clearing still works", async (t) => {
  const f = await panelFixture(t);
  const { server } = await json(f, "/servers", { method: "POST", body: { templateId: "minecraft-curseforge", autoStart: false, env: { CF_API_KEY: f.token } } }, 201);
  assert.equal(server.env.CF_API_KEY, "********");
  await json(f, `/servers/${server.id}`, { method: "PUT", body: { name: "New name", env: { CF_API_KEY: "********" } } });
  assert.equal((await json(f, `/servers/${server.id}`)).server.env.CF_API_KEY, f.token);
  await json(f, `/servers/${server.id}`, { method: "PUT", body: { env: { CF_API_KEY: "" } } });
  assert.equal((await json(f, `/servers/${server.id}`)).server.env.CF_API_KEY, "");
});
