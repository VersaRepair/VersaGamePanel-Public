"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { panelFixture } = require("../test-support/panel");
const { docker, json, createMinecraft, action, ready, command } = require("../test-support/minecraft");
const { uploadPlan } = require("../test-support/mod-fixtures");

test("real Fabric custom-mod upload corrects a misselected version and boots FerriteCore", {
  skip: process.env.GAMEPANEL_MINECRAFT_MOD_TEST !== "1", timeout: 600000
}, async (t) => {
  assert.equal(process.env.GAMEPANEL_ACCEPT_MINECRAFT_EULA, "1");
  const f = await panelFixture(t);
  const server = await createMinecraft(f, `Modded Minecraft ${crypto.randomUUID()}`, 25589);
  const name = `gp_${server.id}`;
  t.after(async () => { await docker(["rm", "-f", name]).catch(() => {}); });
  await json(f, `/servers/${server.id}`, { method: "PUT", body: { ports: [], env: { VERSION: "1.20.1", FABRIC_LOADER_VERSION: "0.16.9" } } });
  const response = await fetch("https://cdn.modrinth.com/data/uXXizFIs/versions/sOzRw3CG/ferritecore-7.0.3-fabric.jar", { signal: AbortSignal.timeout(60000) });
  assert.equal(response.ok, true);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 123450);
  assert.equal(crypto.createHash("sha512").update(bytes).digest("hex"), "3ad31620fac4ff44327dc7dedbe162b2d978f3f246dc16255a6e400ce9592a0d326fe36a626f3c1bf30a11f813093cbb4dcc107af039cff724d0cdf648541fdf");
  const file = path.join(f.base, "ferritecore.jar"); await fs.writeFile(file, bytes);
  const plan = await uploadPlan(f, server.id, [["mods/ferritecore.jar", file]]);
  assert.ok(plan.issues.some((issue) => issue.code === "wrong-minecraft"));
  assert.deepEqual(plan.compatibleLoaders, ["FABRIC"]);
  await json(f, `/servers/${server.id}/mods/plans/${plan.id}/apply`, { method: "POST", body: { type: "FABRIC", version: "1.21.1", confirm: true, acceptWarnings: true } });
  await action(f, server.id, "start"); await ready(server.id);
  assert.match(await docker(["logs", name]), /ferritecore 7\.0\.3/, "real mod and selected loader were loaded");
  await command(f, server.id, "list", /There are 0 of a max of 2 players online/);
  await command(f, server.id, "forceload add 0 0", /Marked chunk|No chunks were marked/);
  await command(f, server.id, "setblock 0 64 0 minecraft:diamond_block", /Changed the block at 0, 64, 0/);
  await action(f, server.id, "stop");
  const backup = await json(f, `/servers/${server.id}/backups`, { method: "POST", body: { action: "create" } });
  await action(f, server.id, "start"); await ready(server.id);
  await command(f, server.id, "setblock 0 64 0 minecraft:emerald_block", /Changed the block at 0, 64, 0/);
  await action(f, server.id, "stop");
  await json(f, `/servers/${server.id}/backups`, { method: "POST", body: { action: "restore", name: backup.name } });
  await action(f, server.id, "start"); await ready(server.id);
  await command(f, server.id, "execute if block 0 64 0 minecraft:diamond_block run say MODDED_RESTORE_VERIFIED", /\[Server\] MODDED_RESTORE_VERIFIED/);
  await action(f, server.id, "stop");
  assert.equal(JSON.parse(await docker(["inspect", name]))[0].State.ExitCode, 0);
  await json(f, `/servers/${server.id}?data=1&backups=1`, { method: "DELETE" });
  assert.equal((await json(f, "/servers")).servers.length, 0);
});
