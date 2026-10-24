"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");

const IMAGE = "itzg/minecraft-server@sha256:627e5d0163f76428c48cc09b0994651474870e90653715376884be5239b88f78";
const VERSION = "1.21.1";
const execute = promisify(execFile);
const docker = async (args) => (await execute("docker", args, { timeout: 150000, maxBuffer: 2 * 1024 * 1024 })).stdout;

async function json(f, route, options, expected = 200) {
  const response = await f.request(route, options);
  const payload = await response.json();
  assert.equal(response.status, expected, payload.error || payload.message || `Unexpected API response for ${route}`);
  return payload;
}

async function createMinecraft(f, name, port) {
  assert.equal(process.env.GAMEPANEL_ACCEPT_MINECRAFT_EULA, "1", "Explicit disposable-test EULA approval is required");
  return (await json(f, "/servers", { method: "POST", body: {
    templateId: "minecraft-paper", name, image: IMAGE, autoStart: true,
    networkMode: "bridge", ports: [{ host: port, container: 25565, protocol: "tcp", bindAddress: "127.0.0.1", label: "Game" }],
    resources: { cpus: 2, memoryMiB: 3072, pids: 512 },
    connectivity: { schemaVersion: 1, provider: "direct", advertisedHost: "127.0.0.1" },
    env: { EULA: "TRUE", TYPE: "VANILLA", VERSION, MEMORY: "1G", MOTD: "VGP disposable verification", SEED: "123456",
      LEVEL_TYPE: "minecraft:flat", VIEW_DISTANCE: "2", SIMULATION_DISTANCE: "2", GENERATE_STRUCTURES: "FALSE", MAX_PLAYERS: "2" }
  } }, 201)).server;
}

async function action(f, id, actionName) {
  const result = await json(f, `/servers/${id}/actions`, { method: "POST", body: { action: actionName } });
  assert.equal(result.ok, true);
  return result;
}

async function ready(id) {
  const name = `gp_${id}`;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const [info] = JSON.parse(await docker(["inspect", name]));
    if (!info.State.Running) {
      const logs = await docker(["logs", "--tail", "35", name]);
      throw new Error(`Disposable Minecraft exited (${info.State.ExitCode}). ${logs.replace(/(password|token|secret)[^\r\n]*/gi, "$1=[redacted]")}`);
    }
    const logs = await docker(["logs", "--tail", "100", name]);
    if (/Done \([\d.]+s\)! For help/.test(logs)) return info;
    await delay(1000);
  }
  throw new Error("Minecraft did not reach game readiness within 180 seconds.");
}

async function command(f, id, input, expected) {
  const { ticket } = await json(f, `/servers/${id}/console-ticket`, { method: "POST", body: { mode: "console" } }, 201);
  const ws = new WebSocket(`${f.url.replace("http:", "ws:")}/ws/servers/${id}/console?ticket=${encodeURIComponent(ticket)}`, { origin: f.url });
  ws.on("error", () => {});
  let output = "";
  ws.on("message", (data) => { output = (output + data.toString()).slice(-131072); });
  try {
    await once(ws, "open");
    ws.send(`${input}\n`);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (expected.test(output)) return;
      if (ws.readyState === WebSocket.CLOSED) break;
      await delay(100);
    }
    throw new Error(`No process-generated response to ${input}; terminal echo is not success. Output: ${output.slice(-3000)}`);
  } finally { ws.terminate(); }
}

async function upload(f, id, relative, content) {
  const form = new FormData();
  form.append("files", new Blob([content]), relative);
  const response = await fetch(`${f.url}/api/servers/${id}/files`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: form });
  assert.equal(response.status, 200, "test file upload failed");
  await response.arrayBuffer();
}

async function download(f, id, relative) {
  const response = await f.request(`/servers/${id}/files/download?path=${encodeURIComponent(relative)}`);
  assert.equal(response.status, 200, `test file download failed: ${relative}: ${response.ok ? "" : await response.clone().text()}`);
  return response.text();
}

module.exports = { IMAGE, VERSION, docker, json, createMinecraft, action, ready, command, upload, download };
