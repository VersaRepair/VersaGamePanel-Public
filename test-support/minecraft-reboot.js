"use strict";

// Dedicated lab VM only. Never put its token, state or evidence into CI artifacts.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const { IMAGE, VERSION, docker, json, createMinecraft, action, ready, command, upload, download } = require("./minecraft");
const CONTEXT = "/home/versadev/versagamepanel-minecraft-reboot-evidence.json";

async function main() {
  assert.equal(process.env.GAMEPANEL_LAB_REBOOT_TEST, "1");
  assert.equal(os.hostname(), "versagamepanel-dev", "Only the dedicated development VM is allowed");
  const url = "http://127.0.0.1:8788";
  // Supply the private lab password on stdin, never in argv, a URL or CI secrets.
  const password = (await fs.readFile(0, "utf8")).trim();
  assert.ok(password, "Supply the private lab administrator password on stdin");
  const login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.equal(login.status, 200, "Private lab login failed");
  const { token } = await login.json();
  const f = { url, token, request(route, { method = "GET", body, ...options } = {}) {
    return fetch(`${url}/api${route}`, { method, ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, body: body == null ? undefined : JSON.stringify(body) });
  } };
  const phase = process.argv[2];
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (phase === "prepare") {
    await assert.rejects(fs.stat(CONTEXT), { code: "ENOENT" });
    assert.deepEqual((await json(f, "/servers")).servers, [], "Do not disturb any existing lab server");
    assert.equal((await docker(["ps", "-q"])).trim(), "", "Do not reboot a VM running other containers");
    const server = await createMinecraft(f, `LAB Minecraft Reboot ${crypto.randomUUID()}`, 25566);
    const context = { id: server.id, bootId, image: IMAGE, version: VERSION, createdAt: new Date().toISOString() };
    await fs.writeFile(CONTEXT, JSON.stringify(context, null, 2), { flag: "wx", mode: 0o600 });
    await action(f, server.id, "start"); await ready(server.id);
    await command(f, server.id, "forceload add 0 0", /Marked chunk|No chunks were marked/);
    await command(f, server.id, "setblock 0 64 0 minecraft:diamond_block", /Changed the block at 0, 64, 0/);
    await action(f, server.id, "stop");
    await upload(f, server.id, "world/vgp-reboot-evidence.txt", "disposable reboot evidence\n");
    await action(f, server.id, "start");
    const info = await ready(server.id);
    assert.equal(info.HostConfig.RestartPolicy.Name, "unless-stopped");
    await command(f, server.id, "save-all flush", /Saved the game/);
    context.containerId = info.Id;
    await fs.writeFile(CONTEXT, JSON.stringify(context, null, 2), { mode: 0o600 });
    console.log("Prepared one localhost-only disposable Minecraft server for lab reboot; world flushed.");
    return;
  }
  const context = JSON.parse(await fs.readFile(CONTEXT, "utf8"));
  assert.match(context.id, /^lab-minecraft-reboot-[a-z0-9-]+$/);
  const server = (await json(f, `/servers/${context.id}`)).server;
  assert.equal(server.id, context.id); assert.equal(server.image, context.image);
  if (phase === "verify") {
    assert.notEqual(bootId, context.bootId, "A process restart is not a host reboot");
    const info = await ready(context.id);
    assert.equal(info.Id, context.containerId, "Docker must preserve the same container across reboot");
    assert.equal(server.env.VERSION, VERSION);
    assert.equal(server.connectivity.advertisedHost, "127.0.0.1");
    assert.equal(await download(f, context.id, "world/vgp-reboot-evidence.txt"), "disposable reboot evidence\n");
    await command(f, context.id, "seed", /Seed: \[123456\]/);
    await command(f, context.id, "execute if block 0 64 0 minecraft:diamond_block run say VGP_REBOOT_PROVED", /\[Server\] VGP_REBOOT_PROVED/);
    context.rebootVerified = true;
    await fs.writeFile(CONTEXT, JSON.stringify(context, null, 2), { mode: 0o600 });
    console.log("PASS: changed boot ID, same server/container identity, saved world block, seed, file and configuration survived host reboot.");
  } else if (phase === "cleanup") {
    await action(f, context.id, "stop");
    const [info] = JSON.parse(await docker(["inspect", `gp_${context.id}`]));
    assert.equal(info.State.ExitCode, 0);
    await json(f, `/servers/${context.id}?data=1&backups=1`, { method: "DELETE" });
    assert.deepEqual((await json(f, "/servers")).servers, []);
    assert.equal((await docker(["ps", "-aq", "--filter", `name=^gp_${context.id}$`])).trim(), "");
    context.cleanedUp = true;
    await fs.writeFile(CONTEXT, JSON.stringify(context, null, 2), { mode: 0o600 });
    console.log("PASS: disposable reboot server stopped cleanly and removed; evidence summary retained, zero configured lab servers.");
  } else throw new Error("Choose prepare, verify or cleanup");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
