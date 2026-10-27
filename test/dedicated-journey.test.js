"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { panelFixture } = require("../test-support/panel");
const { docker, json, action, command, upload, download } = require("../test-support/minecraft");
const { profiles } = require("../lib/game-profiles");

for (const [id, profile] of Object.entries(profiles)) {
  test(`${profile.game}: fresh install, real console, graceful save, snapshots and persistence`, {
    skip: process.env[`GAMEPANEL_${profile.game.toUpperCase()}_TEST`] !== "1", timeout: 1200000
  }, async (t) => {
    const f = await panelFixture(t);
    assert.equal((await json(f, "/servers")).servers.length, 0);
    const server = (await json(f, "/servers", { method: "POST", body: {
      templateId: id, name: `Disposable ${profile.game}`, ports: [], autoStart: false,
      resources: { cpus: 3, memoryMiB: profile.game === "unturned" ? 5120 : 2048, pids: 512 },
      env: { SERVERNAME: "VGP disposable verification", MAXPLAYERS: "2", SEED: "vgp-verification",
        ...(profile.game === "unturned" && process.env.GAMEPANEL_UNTURNED_WORKSHOP_TEST === "1" ? { WORKSHOP_MANAGED: "TRUE", WORKSHOP_ITEMS: "1753134636", MAP: "Hawaii" } : {}) }
    } }, 201)).server;
    const name = `gp_${server.id}`;
    // Emergency cleanup is restricted to this generated fixture container only.
    t.after(async () => { await docker(["rm", "-f", name]).catch(() => {}); });
    async function ready() {
      for (let i = 0; i < 900; i += 1) {
        const [info] = JSON.parse(await docker(["inspect", name]));
        const logs = await docker(["logs", "--tail", "150", name]);
        if (!info.State.Running) throw new Error(`Disposable ${profile.game} exited ${info.State.ExitCode}: ${logs.slice(-6000)}`);
        if ((profile.game === "unturned" ? /Loading level: 100%/ : /Server started|Listening on port/).test(logs)) return;
        await delay(1000);
      }
      throw new Error(`Game readiness timed out: ${profile.game}`);
    }
    await action(f, server.id, "start");
    await ready();
    await command(f, server.id, profile.game === "unturned" ? "Save" : "save", profile.game === "unturned" ? /Successfully saved|Saved the|Saved level|Saving/ : /World saved|Saving world data/i);
    await action(f, server.id, "stop");
    let [info] = JSON.parse(await docker(["inspect", name]));
    assert.equal(info.State.ExitCode, 0, "game must exit gracefully, not be killed");
    assert.equal(info.State.OOMKilled, false);
    const scope = path.join(f.data, "servers", server.id, profile.scope);
    const files = await fs.readdir(scope, { recursive: true });
    assert.ok(files.length > 0, "actual game-generated save/config files exist");
    if (profile.game === "unturned" && process.env.GAMEPANEL_UNTURNED_WORKSHOP_TEST === "1") {
      const workshop = JSON.parse(await fs.readFile(path.join(scope, "WorkshopDownloadConfig.json"), "utf8"));
      assert.deepEqual(workshop.File_IDs, [1753134636]);
      assert.ok(files.some((file) => file.includes("1753134636")), "the public Workshop item was actually downloaded");
    }
    const save = profile.game === "unturned" ? path.join(scope, "Server", "Commands.dat") : path.join(scope, "world.wld");
    const original = await fs.readFile(save);
    const unturnedSave = profile.game === "unturned" ? files.find((file) => file.startsWith("Level/") && file.endsWith(".dat")) : null;
    const worldOriginal = unturnedSave ? await fs.readFile(path.join(scope, unturnedSave)) : null;
    if (profile.game === "unturned") assert.ok(unturnedSave, `actual survival level save exists, not just configuration: ${files.filter((file) => !file.startsWith("Workshop")).slice(0, 30).join(", ")}`);
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const snapshot = await json(f, `/servers/${server.id}/snapshots`, { method: "POST", body: { action: "create" } }, 201);
    await fs.writeFile(save, "deliberately damaged disposable save");
    if (unturnedSave) await fs.writeFile(path.join(scope, unturnedSave), "damaged level save");
    await json(f, `/servers/${server.id}/snapshots`, { method: "POST", body: { action: "restore", name: snapshot.name } });
    assert.equal(hash(await fs.readFile(save)), hash(original), "snapshot restored exact original game data");
    if (unturnedSave) assert.equal(hash(await fs.readFile(path.join(scope, unturnedSave))), hash(worldOriginal), "Unturned level data restored alongside configuration");
    await upload(f, server.id, "verification.txt", "retained after restart");
    assert.equal(await download(f, server.id, "verification.txt"), "retained after restart");
    await action(f, server.id, "start");
    await ready();
    await json(f, `/servers/${server.id}/snapshots`, { method: "POST", body: { action: "create" } }, 409);
    await f.stop(); await f.start();
    const retained = (await json(f, `/servers/${server.id}`)).server;
    assert.equal(retained.runtime.running, true);
    assert.equal(retained.env.SERVERNAME, server.env.SERVERNAME);
    await action(f, server.id, "restart"); await ready();
    await action(f, server.id, "stop");
    [info] = JSON.parse(await docker(["inspect", name]));
    assert.equal(info.State.ExitCode, 0);
    await json(f, `/servers/${server.id}?data=1&backups=1`, { method: "DELETE" });
    assert.equal((await json(f, "/servers")).servers.length, 0);
    await assert.rejects(fs.stat(scope), { code: "ENOENT" });
  });
}
