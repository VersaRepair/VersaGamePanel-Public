"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createDockerAdapter, LABEL, LABEL_VALUE } = require("../agent/docker-adapter");
const { createAgentServer, listenOnSocket, socketDirectory } = require("../agent/daemon");

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgp-agent-"));
  fs.chmodSync(dir, 0o700);
  const root = path.join(dir, "games");
  const data = path.join(root, "servers", "demo");
  const sockets = path.join(dir, "socket");
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sockets, { mode: 0o700 });
  return { dir, root, data, socket: path.join(sockets, "agent.sock"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function info(data, overrides = {}) {
  return {
    Id: ID,
    Config: { Labels: { [LABEL]: LABEL_VALUE, "gamepanel.id": "demo_1" } },
    HostConfig: { Privileged: false, NetworkMode: "bridge", PidMode: "", IpcMode: "", CapAdd: [], Devices: [] },
    Mounts: [{ Type: "bind", Source: data, Destination: "/data", RW: true }],
    State: { Running: false, Status: "exited" },
    ...overrides
  };
}

function fakeDocker(obj) {
  const calls = [];
  return {
    calls,
    async execute(args) {
      calls.push(args);
      if (args[0] === "container" && args[1] === "ls") return ID + "\n";
      if (args[0] === "container" && args[1] === "inspect") return JSON.stringify([obj]);
      if (["start", "stop", "restart"].includes(args[1])) return ID + "\n";
      throw new Error("Unrecognized Docker command");
    }
  };
}

function request(socketPath, method, endpoint, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: endpoint, method, headers, agent: false }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(content) }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("agent rejects wrong labels, host network, privileges, and paths outside the game root", async () => {
  const f = fixture();
  try {
    const good = info(f.data);
    const candidates = [
      info(f.data, { Config: { Labels: { "gamepanel.id": "demo_1" } } }),
      info(f.data, { HostConfig: { ...good.HostConfig, Privileged: true } }),
      info(f.data, { HostConfig: { ...good.HostConfig, NetworkMode: "host" } }),
      info(f.data, { HostConfig: { ...good.HostConfig, Devices: [{ PathOnHost: "/dev/sda" }] } }),
      info(f.data, { Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/data", RW: true }] }),
      info(f.data, { Mounts: [{ Type: "bind", Source: f.data, Destination: "/", RW: true }] }),
      info(f.data, { Mounts: [...good.Mounts, { Type: "bind", Source: f.data, Destination: "/etc", RW: true }] })
    ];
    for (const candidate of candidates) {
      const fake = fakeDocker(candidate);
      const adapter = createDockerAdapter({ dataRoot: f.root, execute: fake.execute });
      await assert.rejects(adapter.inspectManaged(ID), /NOT_MANAGED|UNSAFE/);
      assert.equal(fake.calls.some(x => ["start", "stop", "restart"].includes(x[1])), false);
      assert.deepEqual(await adapter.list(), []);
    }
  } finally { f.cleanup(); }
});

test("agent requires exact full container ID and re-checks authorization before lifecycle operations", async () => {
  const f = fixture();
  try {
    const fake = fakeDocker(info(f.data));
    const adapter = createDockerAdapter({ dataRoot: f.root, execute: fake.execute });
    await assert.rejects(adapter.inspectManaged("not-a-docker-id"), /NOT_FOUND/);
    await assert.rejects(adapter.lifecycle(OTHER, "start"), /NOT_FOUND/);
    assert.deepEqual(await adapter.list(), [{ id: ID, serverId: "demo_1", running: false, state: "exited" }]);
    await adapter.lifecycle(ID, "start");
    await adapter.lifecycle(ID, "stop");
    await adapter.lifecycle(ID, "restart");
    assert.deepEqual(fake.calls.filter(args => ["start", "stop", "restart"].includes(args[1])), [
      ["container", "start", ID],
      ["container", "stop", "--time", "10", ID],
      ["container", "restart", "--time", "10", ID]
    ]);
    await assert.rejects(adapter.lifecycle(ID, "exec"), /NOT_FOUND/);
  } finally { f.cleanup(); }
});

test("agent rejects symlinked outside storage, hostile socket directories, and existing sockets", async () => {
  const f = fixture();
  try {
    const outside = path.join(f.dir, "outside");
    fs.mkdirSync(outside);
    const link = path.join(f.root, "servers", "outside-link");
    fs.symlinkSync(outside, link, "dir");
    const adapter = createDockerAdapter({ dataRoot: f.root, execute: fakeDocker(info(link)).execute });
    await assert.rejects(adapter.inspectManaged(ID), /UNSAFE/);
    assert.equal(socketDirectory(f.socket), f.socket);
    fs.chmodSync(path.dirname(f.socket), 0o777);
    assert.throws(() => socketDirectory(f.socket), /0700/);
    fs.chmodSync(path.dirname(f.socket), 0o700);
    fs.writeFileSync(f.socket, "occupied");
    assert.throws(() => socketDirectory(f.socket), /existing/);
  } finally { f.cleanup(); }
});

test("agent listens only on the private Unix socket and denies unknown operations", async () => {
  const f = fixture();
  const calls = [];
  const adapter = {
    async list() { return [{ id: ID, serverId: "demo_1", state: "running", running: true }]; },
    async inspectManaged(id) { calls.push(["inspect", id]); if (id !== ID) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" }); },
    async lifecycle(id, operation) { calls.push(["lifecycle", id, operation]); }
  };
  const server = createAgentServer(adapter);
  try {
    await listenOnSocket(server, f.socket);
    assert.equal(fs.statSync(f.socket).mode & 0o777, 0o600);
    assert.deepEqual((await request(f.socket, "GET", "/v1/health")).json, { status: "ok", api: 1 });
    assert.equal((await request(f.socket, "GET", "/v1/servers")).json.servers[0].serverId, "demo_1");
    assert.equal((await request(f.socket, "POST", "/v1/servers/" + ID + "/start")).status, 200);
    assert.deepEqual(calls, [["inspect", ID], ["lifecycle", ID, "start"]]);
    assert.equal((await request(f.socket, "POST", "/v1/servers/" + ID + "/exec")).status, 404);
    assert.equal((await request(f.socket, "POST", "/v1/servers/" + ID + "/start?force=true")).status, 400);
    assert.equal((await request(f.socket, "POST", "/v1/servers/" + ID + "/start", { "content-length": "1" })).status, 400);
    assert.equal((await request(f.socket, "DELETE", "/v1/servers/" + ID + "/start")).status, 405);
    assert.deepEqual(calls, [["inspect", ID], ["lifecycle", ID, "start"]]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    f.cleanup();
  }
});

test("agent refuses broad or symlinked root paths", () => {
  const f = fixture();
  try {
    assert.throws(() => createDockerAdapter({ dataRoot: "/" }), /Unsafe/);
    const link = path.join(f.dir, "games-link");
    fs.symlinkSync(f.root, link, "dir");
    assert.throws(() => createDockerAdapter({ dataRoot: link }), /real directory/);
  } finally { f.cleanup(); }
});
