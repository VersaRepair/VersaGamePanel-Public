"use strict";
const { PROFILE, CONSOLE_PROFILE } = require("../agent/provisioning");

// A deterministic fake Docker daemon for negative/transaction tests; real Docker is tested separately.
function provisioningEngine() {
  const records = new Map(), calls = [];
  const networks = new Map();
  const imageId = "sha256:" + "c".repeat(64);
  let count = 0;
  const engine = { records, networks, calls, imageId, beforeCreate: null, afterCreate: null,
    async createConsole(options) {
      const { name, ...spec } = require("../agent/console-fixture").fixtureSpec(options);
      const id = (++count).toString(16).padStart(64, "0");
      records.set(id, { Id: id, Name: "/" + name, Image: imageId, Config: { ...spec, Entrypoint: spec.Entrypoint || null }, HostConfig: spec.HostConfig,
        Mounts: [{ Type: "bind", Source: options.storage, Destination: "/data", RW: true }],
        NetworkSettings: { Networks: { [options.network]: { NetworkID: options.network } } }, State: { Running: false, Status: "created" } });
      if (engine.afterCreate) await engine.afterCreate();
      return id;
    }, async execute(args) {
    calls.push([...args]);
    if (args[0] === "network") {
      const op = args[1], target = args.at(-1);
      if (op === "ls") return [...networks.values()].filter((n) => target === `name=^${n.Name}$`).map((n) => n.Id).join("\n");
      if (op === "create") {
        const id = (10000 + ++count).toString(16).padStart(64, "0"), labels = {};
        for (let i = 0; i < args.length; i++) if (args[i] === "--label") { const [k, v] = args[i + 1].split("="); labels[k] = v; }
        networks.set(id, { Id: id, Name: target, Driver: "bridge", Internal: false, EnableIPv6: false, Options: { "com.docker.network.bridge.enable_icc": "false" }, Labels: labels, Containers: {} }); return id;
      }
      const n = networks.get(target); if (!n) throw Error("missing network");
      if (op === "inspect") return JSON.stringify([n]);
      if (op === "rm") { if (Object.keys(n.Containers).length) throw Error("occupied"); networks.delete(target); return target; }
    }
    if (args[0] === "image") return JSON.stringify([{ Id: imageId }]);
    const op = args[1];
    if (op === "ls") {
      const filter = args.at(-1);
      if (filter.startsWith("id=")) return records.has(filter.slice(3)) ? filter.slice(3) : "";
      const name = filter.slice("name=^".length, -1);
      return [...records.values()].filter((r) => r.Name === name).map((r) => r.Id).join("\n");
    }
    if (op === "create") {
      const profile = args.includes("--tty") ? CONSOLE_PROFILE : PROFILE;
      if (engine.beforeCreate) await engine.beforeCreate();
      const labels = {};
      for (let n = 0; n < args.length; n++) if (args[n] === "--label") { const [key, ...value] = args[n + 1].split("="); labels[key] = value.join("="); }
      const value = (key) => args[args.indexOf(key) + 1];
      const source = value("--mount").split(",").find((part) => part.startsWith("src=")).slice(4);
      const id = (++count).toString(16).padStart(64, "0");
      const obj = { Id: id, Name: "/" + value("--name"), Image: imageId,
        Config: { Image: profile.image, User: value("--user"), Labels: labels, Cmd: [...profile.command], Entrypoint: null, Tty: !!profile.tty, OpenStdin: !!profile.tty, StdinOnce: false },
        HostConfig: { Privileged: false, NetworkMode: "none", ReadonlyRootfs: true, Memory: PROFILE.memory, MemorySwap: PROFILE.memory, NanoCpus: PROFILE.nanoCPUs, PidsLimit: PROFILE.pids, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
        Mounts: [{ Type: "bind", Source: source, Destination: "/data", RW: true }], State: { Running: false, Status: "created" } };
      records.set(id, obj);
      if (engine.afterCreate) await engine.afterCreate();
      return id;
    }
    const id = args.at(-1), obj = records.get(id);
    if (!obj) throw Object.assign(new Error("missing fixture"), { code: "NOT_FOUND" });
    if (op === "inspect") return JSON.stringify([obj]);
    if (op === "rm") { if (obj.State.Running) throw Error("running"); records.delete(id); return id; }
    if (["start", "stop", "restart"].includes(op)) { obj.State = { Running: op !== "stop", Status: op === "stop" ? "exited" : "running" }; return id; }
    throw new Error("Unexpected fake Docker operation");
  } };
  return engine;
}
module.exports = { provisioningEngine };
