"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

async function panelFixture(t, records, { legacyToken = true, env = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "vgp-journey-"));
  const data = path.join(base, "data");
  await fs.mkdir(data);
  if (records) await fs.writeFile(path.join(data, "state.json"), JSON.stringify({ servers: records }));
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const token = crypto.randomBytes(24).toString("hex");
  let child;
  const url = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child && child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const exited = await Promise.race([closed.then(() => true), delay(10000).then(() => false)]);
      if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  }
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, GAMEPANEL_OFFLINE_METADATA: "1", GAMEPANEL_DATA_DIR: data, GAMEPANEL_TOKEN: token, GAMEPANEL_ALLOW_LEGACY_TOKEN: legacyToken ? "1" : "0", GAMEPANEL_AUTH_DISABLED: "0", HOST: "127.0.0.1", PORT: String(port), ...env },
      stdio: "ignore"
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${url}/api/auth/state`)).ok) return; } catch (_) { /* starting */ }
      if (child.exitCode !== null) break;
      await delay(40);
    }
    assert.fail("isolated panel did not start");
  }
  t.after(async () => { await stop(); await fs.rm(base, { recursive: true, force: true }); });
  await start();
  async function request(route, { method = "GET", body, ...options } = {}) {
    return fetch(`${url}/api${route}`, { method, ...options,
      signal: options.signal || AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      body: body == null ? undefined : JSON.stringify(body) });
  }
  return { data, base, url, token, request, start, stop };
}

module.exports = { panelFixture };
