"use strict";

const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const WebSocket = require("ws");
const { attachConsoleTransport } = require("../lib/console-transport");
const { attachDockerConsole } = require("../lib/docker-console");

const execute = promisify(execFile);

// Opt in only on the isolated development VM. This creates one resource-limited,
// network-disabled disposable container and never pulls an image or exposes a port.
for (const tty of [true, false]) test(`real Docker ${tty ? "TTY" : "non-TTY"} console survives fragmentation, disconnect, reconnect, and log viewing`, {
  skip: process.env.GAMEPANEL_DOCKER_TEST !== "1", timeout: 30000
}, async (t) => {
  const id = `console-test-${crypto.randomUUID()}`;
  const name = `gp_${id}`;
  const token = crypto.randomBytes(24).toString("hex");
  const children = [];
  let created = false;
  const server = http.createServer((_req, res) => res.end("test"));
  const docker = async (args) => (await execute("docker", args, { timeout: 10000 })).stdout;
  const transport = attachConsoleTransport(server, {
    authorize: (req, _url, serverId) => req.headers.authorization === `Bearer ${token}` && serverId === id ? { id } : null,
    runtimeFor: async () => ({ name, tty, running: JSON.parse(await docker(["inspect", "--format", "{{json .State.Running}}", name])) }),
    isNativeServer: () => false,
    nativeFor: () => ({}),
    sendNativeConsole: async () => "unused",
    dockerAttach(runtime) {
      const attachment = attachDockerConsole(runtime);
      children.push(attachment);
      return attachment;
    },
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    }
  });
  t.after(async () => {
    transport.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (created) await docker(["rm", "--force", name]);
  });
  await docker([
    "run", "--detach", "--interactive", ...(tty ? ["--tty"] : []), "--pull=never", "--name", name,
    "--network", "none", "--read-only", "--cap-drop=ALL",
    "--security-opt", "no-new-privileges", "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32",
    "alpine:latest", "sh", "-c", "printf 'gamepanel-console-ready\\n'; while IFS= read -r line; do printf 'processed:%s\\n' \"$line\"; done"
  ]);
  created = true;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `ws://127.0.0.1:${server.address().port}/ws/servers/${id}`;
  async function connect(mode) {
    const ws = new WebSocket(`${address}/${mode}`, { headers: { authorization: `Bearer ${token}` } });
    ws.on("error", () => {});
    ws.output = "";
    ws.on("message", (data) => { ws.output += data.toString(); });
    await once(ws, "open");
    return ws;
  }
  async function outputIncludes(ws, text) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (ws.output.replace(/\r\n/g, "\n").includes(text)) return;
      await delay(20);
    }
    assert.fail(`console output did not include expected marker ${JSON.stringify(text)}; received ${JSON.stringify(ws.output)}`);
  }
  async function disconnect(ws) {
    const closed = once(ws, "close");
    ws.close(1000);
    assert.equal((await closed)[0], 1000);
  }

  const first = await connect("console");
  first.send("connected-marker\n");
  await outputIncludes(first, "processed:connected-marker\n");
  first.send("fragmented ", { fin: false });
  first.send("command 🌍\n", { fin: true });
  await outputIncludes(first, "processed:fragmented command 🌍\n");
  await disconnect(first);
  assert.equal(JSON.parse(await docker(["inspect", "--format", "{{json .State.Running}}", name])), true);

  const second = await connect("console");
  second.send("reconnected\n");
  await outputIncludes(second, "processed:reconnected\n");
  await disconnect(second);

  const logs = await connect("logs");
  await outputIncludes(logs, "processed:fragmented command 🌍\n");
  const closed = once(logs, "close");
  logs.send("must-not-reach-server\n");
  assert.equal((await closed)[0], 1008);
  for (let attempt = 0; attempt < 100 && children.some((child) => child.exitCode === null && child.signalCode === null); attempt += 1) await delay(20);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  assert.equal(JSON.parse(await docker(["inspect", "--format", "{{json .State.Running}}", name])), true);
  assert.doesNotMatch(await docker(["logs", name]), /must-not-reach-server/);
});
