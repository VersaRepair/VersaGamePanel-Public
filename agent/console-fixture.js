"use strict";
const http = require("node:http");
const { portBindings, runtimeEnvironment } = require("../lib/agent-game-catalog");
// Docker CLI create -it forces StdinOnce=true. This fixed, agent-owned creation
// request explicitly leaves stdin reusable. No caller can supply Docker configuration.
function fixtureSpec({ name, labels, user, storage, runtime, network, port, bind, displayName }) {
  const profile = runtime || require("./provisioning").CONSOLE_PROFILE;
  return { Image: profile.image, Cmd: [...profile.command], Entrypoint: profile.entrypoint || [], User: user, Labels: labels,
    ...(runtime ? { Env: runtimeEnvironment(profile, displayName), ExposedPorts: Object.fromEntries(Object.keys(profile.endpoints).map((key) => [key, {}])) } : {}),
    Tty: true, OpenStdin: true, StdinOnce: false, AttachStdin: false, AttachStdout: true, AttachStderr: true,
    HostConfig: { NetworkMode: runtime ? network : "none", ReadonlyRootfs: true, Privileged: false, Memory: profile.memory,
      ...(runtime ? { PortBindings: portBindings(profile, port, bind), Tmpfs: profile.tmpfs || {} } : {}),
      MemorySwap: profile.memory, NanoCpus: profile.nanoCPUs, PidsLimit: profile.pids,
      CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], IpcMode: "private", RestartPolicy: { Name: "no" },
      Mounts: [{ Type: "bind", Source: storage, Target: "/data", ReadOnly: false }],
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } } }, name };
}
function createConsoleFixture(options, { request = http.request } = {}) {
  const { name, ...spec } = fixtureSpec(options), body = JSON.stringify(spec);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: "/var/run/docker.sock", path: `/containers/create?name=${encodeURIComponent(name)}`,
      method: "POST", agent: false, maxHeaderSize: 4096,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let bytes = "";
      res.on("data", (chunk) => { bytes += chunk; if (Buffer.byteLength(bytes) > 8192) req.destroy(Error("Create response limit")); });
      res.on("error", reject); res.on("aborted", () => reject(Error("Create response interrupted")));
      res.on("end", () => {
        try { const data = JSON.parse(bytes); if (res.statusCode !== 201 || !/^[a-f0-9]{64}$/.test(data.Id)) throw Error(); resolve(data.Id); }
        catch { reject(Error("Console fixture creation unavailable")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(Error("Console fixture creation timed out")), 20000);
    req.once("close", () => clearTimeout(deadline)); req.on("error", reject); req.end(body);
  });
}
module.exports = { fixtureSpec, createConsoleFixture };
