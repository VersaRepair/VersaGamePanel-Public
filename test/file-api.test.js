"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const WebSocket = require("ws");

test("authenticated file API contains paths and survives malformed uploads", { timeout: 30000 }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "versagamepanel-api-"));
  const data = path.join(base, "data");
  const id = `test-${crypto.randomUUID()}`;
  const root = path.join(data, "servers", id);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(data, "state.json"), JSON.stringify({ servers: [{
    id, name: "Containment test", templateId: "minecraft-paper", env: { LEVEL: "world" }
  }] }));
  const canary = path.join(base, "outside.txt");
  await fsp.writeFile(canary, "outside-canary\n");
  await fsp.symlink(canary, path.join(root, "escape"));
  await fsp.symlink(base, path.join(root, "linked-dir"));

  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const token = crypto.randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      GAMEPANEL_DATA_DIR: data,
      GAMEPANEL_TOKEN: token,
      GAMEPANEL_ALLOW_LEGACY_TOKEN: "1",
      GAMEPANEL_AUTH_DISABLED: "0",
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    await fsp.rm(base, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      ready = (await fetch(`${url}/api/auth/state`)).ok;
      if (ready) break;
    } catch (_) { /* Startup is asynchronous. */ }
    if (child.exitCode !== null) break;
    await delay(50);
  }
  assert.ok(ready, "isolated API process started");

  const request = (suffix, options = {}) => fetch(`${url}/api/servers/${id}${suffix}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers }
  });
  const upload = (filename, content, query = "", endpoint = "/files") => {
    const boundary = `gp-${crypto.randomUUID()}`;
    return request(`${endpoint}${query}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
    });
  };

  const socketUrl = (ticket, mode = "console") => `${url.replace("http:", "ws:")}/ws/servers/${id}/${mode}?ticket=${encodeURIComponent(ticket)}`;
  async function rejectedUpgrade(address, options = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(address, { origin: url, ...options });
      ws.on("error", () => {});
      ws.on("unexpected-response", (_req, response) => {
        response.resume();
        ws.terminate();
        resolve(response.statusCode);
      });
      ws.on("open", () => { ws.terminate(); reject(new Error("upgrade unexpectedly succeeded")); });
    });
  }

  await t.test("console ticket requires authorization, is one-use, and is bound to mode", async () => {
    const unauthenticated = await fetch(`${url}/api/servers/${id}/console-ticket`, { method: "POST", body: JSON.stringify({ mode: "console" }) });
    assert.equal(unauthenticated.status, 401);
    const response = await request("/console-ticket", { method: "POST", body: JSON.stringify({ mode: "console" }) });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { ticket } = await response.json();
    const ws = new WebSocket(socketUrl(ticket), { origin: url });
    ws.on("error", () => {});
    let output = "";
    ws.on("message", (data) => { output += data.toString(); });
    const closed = once(ws, "close");
    await once(ws, "open");
    assert.equal((await closed)[0], 1000);
    assert.match(output, /is not running/);
    assert.equal(await rejectedUpgrade(socketUrl(ticket)), 401);
    const wrongMode = await (await request("/console-ticket", { method: "POST", body: JSON.stringify({ mode: "console" }) })).json();
    assert.equal(await rejectedUpgrade(socketUrl(wrongMode.ticket, "logs")), 401);
    assert.equal(await rejectedUpgrade(`${socketUrl("").split("?")[0]}?token=${token}`), 401);
  });
  await t.test("cross-origin upgrades are rejected and API clients can use an authorization header", async () => {
    const address = socketUrl("").split("?")[0];
    assert.equal(await rejectedUpgrade(address, { origin: "https://untrusted.invalid", headers: { authorization: `Bearer ${token}` } }), 403);
    const ws = new WebSocket(address, { headers: { authorization: `Bearer ${token}` } });
    ws.on("error", () => {});
    const closed = once(ws, "close");
    await once(ws, "open");
    assert.equal((await closed)[0], 1000);
  });
  await t.test("operators cannot obtain tickets or console access to an unassigned server", async () => {
    const password = crypto.randomBytes(16).toString("hex");
    const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await fetch(`${url}/api/users`, { method: "POST", headers: authHeaders, body: JSON.stringify({ username: "operator", password, role: "operator", serverIds: [] }) });
    assert.equal(created.status, 201);
    const login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "operator", password }) });
    const operator = (await login.json()).token;
    assert.equal((await request("/console-ticket", { method: "POST", headers: { authorization: `Bearer ${operator}` }, body: JSON.stringify({ mode: "console" }) })).status, 404);
    assert.equal(await rejectedUpgrade(socketUrl("").split("?")[0], { headers: { authorization: `Bearer ${operator}` } }), 401);
    const assigned = await fetch(`${url}/api/users/operator`, { method: "PUT", headers: authHeaders, body: JSON.stringify({ serverIds: [id] }) });
    assert.equal(assigned.status, 200);
    const issued = await request("/console-ticket", { method: "POST", headers: { authorization: `Bearer ${operator}` }, body: JSON.stringify({ mode: "console" }) });
    assert.equal(issued.status, 201);
    const { ticket } = await issued.json();
    await fetch(`${url}/api/users/operator`, { method: "PUT", headers: authHeaders, body: JSON.stringify({ serverIds: [] }) });
    assert.equal(await rejectedUpgrade(socketUrl(ticket)), 401);
  });

  await t.test("authentication remains required", async () => {
    assert.equal((await fetch(`${url}/api/servers/${id}/files`)).status, 401);
  });
  await t.test("ordinary nested upload and download work", async () => {
    const response = await upload("config/settings.txt", "normal-data");
    assert.equal(response.status, 200, await response.text());
    const download = await request("/files/download?path=config/settings.txt");
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "normal-data");
  });
  await t.test("listing identifies links without following them", async () => {
    const response = await request("/files");
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items.find((item) => item.name === "escape").type, "symlink");
  });
  await t.test("leaf and intermediate link reads are blocked", async () => {
    for (const relative of ["escape", "linked-dir/outside.txt"]) {
      const response = await request(`/files/download?path=${encodeURIComponent(relative)}`);
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /outside-canary/);
    }
    assert.equal((await request("/files?path=linked-dir")).status, 400);
  });
  await t.test("malformed and link-targeted uploads fail without stopping the panel", async () => {
    for (const filename of ["../outside.txt", "/outside.txt", "linked-dir/outside.txt", "escape"]) {
      const response = await upload(filename, "must-not-write");
      assert.equal(response.status, 400, filename);
    }
    assert.equal(await fsp.readFile(canary, "utf8"), "outside-canary\n");
    assert.equal((await request("/files")).status, 200);
  });
  await t.test("directory download rejects links anywhere inside the tree", async () => {
    assert.equal((await request("/files/download")).status, 400);
  });
  await t.test("world download cannot follow a linked world directory", async () => {
    // The default world itself is also an untrusted game-writable entry.
    await fsp.symlink(base, path.join(root, "world"));
    assert.equal((await request("/world/download")).status, 400);
    await fsp.unlink(path.join(root, "world"));
  });
  await t.test("deleting a link removes only the link; root deletion is rejected", async () => {
    const response = await request("/files", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "escape" })
    });
    assert.equal(response.status, 200);
    assert.equal(await fsp.readFile(canary, "utf8"), "outside-canary\n");
    await assert.rejects(fsp.lstat(path.join(root, "escape")), { code: "ENOENT" });
    assert.equal((await request("/files", { method: "DELETE", body: "{}" })).status, 400);
    assert.ok((await fsp.stat(root)).isDirectory());
  });
  await t.test("ordinary world backup, download, and restore preserve data", async () => {
    await fsp.mkdir(path.join(root, "world"));
    await fsp.writeFile(path.join(root, "world", "level.dat"), "original-world\n");
    const response = await request("/backups", { method: "POST", body: "{}" });
    assert.equal(response.status, 200, await response.clone().text());
    const backup = (await response.json()).name;
    assert.equal((await request(`/backups/download?name=${encodeURIComponent(backup)}`)).status, 200);
    await fsp.writeFile(path.join(root, "world", "level.dat"), "changed-world\n");
    const restored = await request("/backups", {
      method: "POST", body: JSON.stringify({ action: "restore", name: backup })
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(await fsp.readFile(path.join(root, "world", "level.dat"), "utf8"), "original-world\n");
    const downloaded = await request("/world/download");
    assert.equal(downloaded.status, 200);
    assert.ok((await downloaded.arrayBuffer()).byteLength > 0);
  });
  await t.test("backup download and restore reject linked archives", async () => {
    await fsp.symlink(canary, path.join(data, "backups", id, "linked.zip"));
    assert.equal((await request("/backups/download?name=linked.zip")).status, 400);
    assert.equal((await request("/backups", {
      method: "POST", body: JSON.stringify({ action: "restore", name: "linked.zip" })
    })).status, 400);
  });
  await t.test("world and root restore reject a symlink ZIP before touching server data", async () => {
    const source = path.join(base, "archive-source");
    await fsp.mkdir(source);
    await fsp.symlink(canary, path.join(source, "level.dat"));
    const archive = path.join(base, "malicious.zip");
    execFileSync("zip", ["-qy", archive, "level.dat"], { cwd: source });
    for (const endpoint of ["/world/upload", "/root/restore"]) {
      const response = await upload("malicious.zip", await fsp.readFile(archive), "", endpoint);
      assert.equal(response.status, 400, await response.text());
    }
    assert.equal(await fsp.readFile(path.join(root, "world", "level.dat"), "utf8"), "original-world\n");
    assert.equal(await fsp.readFile(canary, "utf8"), "outside-canary\n");
    assert.deepEqual(await fsp.readdir(path.join(data, ".uploads")), []);
  });
  await t.test("ordinary root ZIP restore works and keeps a pre-restore archive", async () => {
    const source = path.join(base, "root-source");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "server.properties"), "motd=Recovered panel\n");
    const archive = path.join(base, "root.zip");
    execFileSync("zip", ["-q", archive, "server.properties"], { cwd: source });
    const response = await upload("root.zip", await fsp.readFile(archive), "", "/root/restore");
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(await fsp.readFile(path.join(root, "server.properties"), "utf8"), "motd=Recovered panel\n");
    assert.ok((await fsp.stat(path.join(data, "backups", id, payload.backup))).isFile());
    assert.deepEqual(await fsp.readdir(path.join(data, ".uploads")), []);
  });
});
