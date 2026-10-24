"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { docker, json, action, command, upload, download, createMinecraft, ready } = require("../test-support/minecraft");

test("packaged panel: non-root bootstrap, sibling console/files, backups and replacement persistence", {
  skip: process.env.GAMEPANEL_CONTAINER_TEST !== "1", timeout: 600000
}, async (t) => {
  const name = `vgp-package-${crypto.randomUUID()}`;
  const volume = `${name}-data`;
  const image = process.env.GAMEPANEL_TEST_PANEL_IMAGE || "versagamepanel/panel:container-test";
  let id;
  t.after(async () => {
    if (id) await docker(["rm", "-f", `gp_${id}`]).catch(() => {});
    await docker(["rm", "-f", name]).catch(() => {});
    await docker(["volume", "rm", volume]).catch(() => {});
    await docker(["image", "rm", `${name}-sibling`]).catch(() => {});
  });
  await docker(["volume", "create", volume]);
  await assert.rejects(docker(["run", "--rm", image]), /Container setup failed/, "missing Docker socket fails closed");
  await assert.rejects(docker(["run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock", image]), /explicitly named Docker volume/, "anonymous data storage is rejected");
  async function start() {
    await docker(["run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
      "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--security-opt=no-new-privileges",
      "--pids-limit=256", "--memory=1g", "-e", "GAMEPANEL_AUTH_DISABLED=1", "-e", "GAMEPANEL_ALLOW_LEGACY_TOKEN=1", "-p", "127.0.0.1::8788", "-v", `${volume}:/data`, "-v", "/var/run/docker.sock:/var/run/docker.sock", image]);
    const [info] = JSON.parse(await docker(["inspect", name]));
    const url = `http://127.0.0.1:${info.NetworkSettings.Ports["8788/tcp"][0].HostPort}`;
    for (let n = 0; n < 150; n += 1) {
      try { if ((await fetch(`${url}/api/auth/state`)).ok) return url; } catch (_) { /* starting */ }
      await delay(100);
    }
    // Container logs intentionally contain no generated credentials.
    assert.fail(`Packaged panel did not start: ${await docker(["logs", name])}`);
  }
  let url = await start();
  const password = (await docker(["exec", "--user", "1000:1000", name, "cat", "/data/initial-admin-password.txt"])).trim();
  assert.ok(password.length >= 24);
  assert.ok(!(await docker(["logs", name])).includes(password), "password never reaches container logs");
  const status = await docker(["exec", name, "cat", "/proc/1/status"]);
  assert.match(status, /Uid:\s+1000\s+1000/);
  assert.match(status, /CapEff:\s+0000000000000000/);
  assert.match(status, /CapBnd:\s+0000000000000000/);
  assert.equal((await fetch(`${url}/api/servers`)).status, 401);
  let token;
  async function login() {
    const response = await fetch(`${url}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password }) });
    assert.equal(response.status, 200);
    token = (await response.json()).token;
  }
  await login();
  const f = { get url() { return url; }, get token() { return token; },
    request(route, { method = "GET", body, ...options } = {}) {
      return fetch(`${url}/api${route}`, { method, ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, body: body == null ? undefined : JSON.stringify(body) });
    }
  };
  assert.deepEqual((await json(f, "/servers")).servers, []);
  let server;
  if (process.env.GAMEPANEL_CONTAINER_MINECRAFT_TEST === "1") {
    server = await createMinecraft(f, name, 25596);
  } else {
    // Exercise management plumbing without installing a game or accepting its EULA.
    execFileSync("docker", ["build", "-t", `${name}-sibling`, "-"], { input: "FROM alpine:latest\nUSER 1000:1000\n", stdio: ["pipe", "pipe", "pipe"] });
    server = (await json(f, "/servers", { method: "POST", body: {
      templateId: "unturned-linuxgsm", name, image: `${name}-sibling`, ports: [], autoStart: false,
      resources: { cpus: 0.5, memoryMiB: 128, pids: 32 },
      command: "mkdir -p /data/world; printf 'from-game' > /data/world/probe.txt; trap 'exit 0' TERM; while IFS= read -r line; do printf 'processed:%s\\n' \"$line\"; done"
    } }, 201)).server;
  }
  id = server.id;
  await action(f, id, "start");
  if (process.env.GAMEPANEL_CONTAINER_MINECRAFT_TEST === "1") {
    await ready(id);
    await command(f, id, "seed", /Seed: \[123456\]/);
  } else {
    await command(f, id, "package-proof", /processed:package-proof/);
    assert.equal(await download(f, id, "world/probe.txt"), "from-game", "panel and sibling game see identical storage");
  }
  const [game] = JSON.parse(await docker(["inspect", `gp_${id}`]));
  const [panel] = JSON.parse(await docker(["inspect", name]));
  assert.equal(game.Mounts.find((m) => m.Destination === "/data").Source, `${panel.Mounts.find((m) => m.Destination === "/data").Source}/servers/${id}`);
  await action(f, id, "stop");
  if (process.env.GAMEPANEL_CONTAINER_MINECRAFT_TEST !== "1") await upload(f, id, "world/level.dat", "synthetic fixture marker, not a real Minecraft world");
  await upload(f, id, "world/evidence.txt", "before backup");
  const backup = await json(f, `/servers/${id}/backups`, { method: "POST", body: { action: "create" } });
  await upload(f, id, "world/evidence.txt", "after backup");
  await json(f, `/servers/${id}/backups`, { method: "POST", body: { action: "restore", name: backup.name } });
  assert.equal(await download(f, id, "world/evidence.txt"), "before backup");
  await docker(["rm", "-f", name]);
  url = await start();
  assert.equal((await f.request("/servers")).status, 401, "old browser session does not survive replacement");
  await login();
  assert.equal((await json(f, "/servers")).servers[0].id, id);
  assert.equal(await download(f, id, "world/evidence.txt"), "before backup");
  assert.ok((await json(f, `/servers/${id}/backups`)).backups.length >= 1);
  assert.equal((await docker(["exec", "--user", "1000:1000", name, "cat", "/data/initial-admin-password.txt"])).trim(), password, "replacement does not reset credentials");
  await json(f, `/servers/${id}?data=1&backups=1`, { method: "DELETE" });
});
