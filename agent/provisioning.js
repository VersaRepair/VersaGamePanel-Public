"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { saveJson } = require("../lib/json-store");
const { configuredGames } = require("./minecraft-profile");
const { GAME_PROFILES, isGame, validGamePort, portBindings, runtimeEnvironment } = require("../lib/agent-game-catalog");

const PROFILE = Object.freeze({
  id: "alpine-smoke-v1",
  image: "alpine@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a",
  command: ["/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"],
  memory: 128 * 1024 * 1024, nanoCPUs: 500000000, pids: 32
});
const CONSOLE_PROFILE = Object.freeze({ ...PROFILE, id: "alpine-console-v1", tty: true,
  command: ["/bin/sh", "-c", "trap 'exit 0' TERM INT; printf 'console fixture ready\\n'; while IFS= read -r line; do case \"$line\" in ping) printf 'pong\\n';; status) printf 'status: ready\\n';; help) printf 'commands: ping status help\\n';; *) printf 'rejected\\n';; esac; done"] });
const profiles = { [PROFILE.id]: PROFILE, [CONSOLE_PROFILE.id]: CONSOLE_PROFILE };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FULL = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const OWNER = "com.versarepair.versagamepanel.owner";
const TX = "com.versarepair.versagamepanel.transaction";
const LABEL = "com.versarepair.versagamepanel.agent";
const PROFILE_LABEL = "com.versarepair.versagamepanel.profile";
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
const fail = (code) => Object.assign(new Error(code), { code });

function validateCreate(body, allowMinecraft = false) {
  const game = allowMinecraft && isGame(body?.profile);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== (game ? "eula,name,port,profile,serverId" : "name,profile,serverId") ||
    typeof body.profile !== "string" || !game && !Object.hasOwn(profiles, body.profile) || typeof body.serverId !== "string" || !UUID.test(body.serverId) || typeof body.name !== "string" || !NAME.test(body.name) || body.name !== body.name.trim() ||
    game && (body.eula !== true || !validGamePort(body.profile, body.port))) throw fail("BAD_REQUEST");
  return { serverId: body.serverId, name: body.name, profile: body.profile, ...(game ? { port: body.port, eula: true } : {}) };
}
function directory(dir) {
  const st = fs.lstatSync(dir);
  if (!path.isAbsolute(dir) || /[,:\r\n\x00]/.test(dir) || path.resolve(dir) !== fs.realpathSync(dir) || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw fail("UNSAFE");
  return { dev: st.dev, ino: st.ino };
}
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

function createProvisioningAdapter({ root, stateRoot, run, createConsole, minecraftImage, terrariaImage, unturnedImage, gameBindAddress, memoryBudgetGiB = 6 }) {
  if (!Number.isInteger(memoryBudgetGiB) || memoryBudgetGiB < 6 || memoryBudgetGiB > 12) throw fail("UNSAFE");
  const games = configuredGames({ "minecraft-java-1.21.1": minecraftImage, "terraria-vanilla": terrariaImage, "unturned-dedicated": unturnedImage }, gameBindAddress);
  const approved = { ...profiles, ...games };
  if (!process.getuid() || !path.isAbsolute(stateRoot) || path.relative(root, stateRoot) === "" ||
    !path.relative(root, stateRoot).startsWith(".." + path.sep) || !path.relative(stateRoot, root).startsWith(".." + path.sep)) throw fail("UNSAFE");
  const roots = { games: directory(root), state: directory(stateRoot) };
  const file = path.join(stateRoot, "registry.json"), lock = path.join(stateRoot, "agent.lock"), identityFile = path.join(stateRoot, "agent-id");
  let fd, lockStat, db, current = null, closing = false, closed;
  function release() {
    if (fd === undefined) return;
    fs.closeSync(fd); fd = undefined;
    try { if (same(fs.lstatSync(lock), lockStat)) fs.unlinkSync(lock); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  try {
    fd = fs.openSync(lock, "wx", 0o600); lockStat = fs.fstatSync(fd);
    if (!fs.existsSync(file)) {
      if (fs.readdirSync(stateRoot).some((name) => name !== "agent.lock")) throw fail("UNSAFE");
      const initial = { version: 1, agentId: randomBytes(16).toString("hex"), servers: {} };
      fs.writeFileSync(identityFile, initial.agentId, { flag: "wx", mode: 0o600 });
      const initialFd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(initialFd, JSON.stringify(initial)); fs.fsyncSync(initialFd); } finally { fs.closeSync(initialFd); }
    }
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 262144) throw fail("UNSAFE");
    db = JSON.parse(fs.readFileSync(file, "utf8"));
    const identityStat = fs.lstatSync(identityFile);
    if (!identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.uid !== process.getuid() || identityStat.mode & 0o077 || fs.readFileSync(identityFile, "utf8") !== db.agentId) throw fail("UNSAFE");
    if (db.version !== 1 || !/^[a-f0-9]{32}$/.test(db.agentId) || !db.servers || Array.isArray(db.servers) || Object.keys(db.servers).length > 128) throw fail("UNSAFE");
    for (const [id, r] of Object.entries(db.servers)) {
      validateCreate({ serverId: id, name: r.name, profile: r.profile, ...(isGame(r.profile) ? { port: r.port, eula: r.eula } : {}) }, !!games[r.profile]);
      if (isGame(r.profile) && r.network !== null && !FULL.test(r.network || "")) throw fail("UNSAFE");
      if (!UUID.test(r.transaction) || !IMAGE_ID.test(r.imageId) || !["preparing", "active", "deleting", "deleted", "review"].includes(r.phase) || r.containerId !== null && !FULL.test(r.containerId) || r.storage !== null && (!Number.isSafeInteger(r.storage.dev) || !Number.isSafeInteger(r.storage.ino)) || r.phase === "active" && (!r.containerId || !r.storage)) throw fail("UNSAFE");
    }
  } catch (error) { release(); throw error; }

  function guard() {
    if (!same(directory(root), roots.games) || !same(directory(stateRoot), roots.state)) throw fail("UNSAFE");
    if (!same(fs.lstatSync(lock), lockStat)) throw fail("UNSAFE");
    const identityStat = fs.lstatSync(identityFile);
    if (!identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.uid !== process.getuid() || identityStat.mode & 0o077 || identityStat.size !== 32 || fs.readFileSync(identityFile, "utf8") !== db.agentId) throw fail("UNSAFE");
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077) throw fail("UNSAFE");
  }
  async function persist() { guard(); await saveJson(file, db); }
  async function exclusive(fn) {
    if (closing || current) throw fail("BUSY");
    let finish; current = new Promise((resolve) => { finish = resolve; });
    try { guard(); return await fn(); } finally { finish(); current = null; }
  }
  function storage(id, r) {
    guard();
    const location = path.join(root, id);
    if (!UUID.test(id) || !same(directory(location), r.storage)) throw fail("UNSAFE");
    return location;
  }
  const containerName = (id) => `vgpa_${db.agentId}_${id}`;
  const networkName = (id) => `vgpn_${db.agentId}_${id}`;
  async function ownedNetwork(id, r, network = r.network) {
    const list = JSON.parse(await run(["network", "inspect", network]));
    const n = list[0], labels = n?.Labels || {};
    if (list.length !== 1 || !FULL.test(n?.Id || "") || n.Id !== network || n.Name !== networkName(id) || n.Driver !== "bridge" || n.Internal || n.EnableIPv6 ||
      n.Options?.["com.docker.network.bridge.enable_icc"] !== "false" || labels[OWNER] !== db.agentId || labels[TX] !== r.transaction ||
      Object.keys(n.Containers || {}).some((cid) => cid !== r.containerId)) throw fail("UNSAFE");
    return n;
  }
  async function namedNetwork(id) {
    const ids = (await run(["network", "ls", "--no-trunc", "--quiet", "--filter", `name=^${networkName(id)}$`])).trim();
    if (!ids) return null;
    if (!FULL.test(ids)) throw fail("UNSAFE");
    return ids;
  }
  function record(id, transitional = false) {
    if (!FULL.test(id)) throw fail("NOT_MANAGED");
    const found = Object.entries(db.servers).find(([, r]) => r.containerId === id && (r.phase === "active" || transitional && r.phase === "deleting"));
    if (!found) throw fail("NOT_MANAGED");
    return found;
  }
  async function inspect(query) {
    const data = JSON.parse(await run(["container", "inspect", query]));
    if (!Array.isArray(data) || data.length !== 1 || !FULL.test(data[0].Id)) throw fail("UNSAFE");
    return data[0];
  }
  async function named(id) {
    const ids = (await run(["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", `name=^/${containerName(id)}$`])).trim();
    if (!ids) return null;
    if (!FULL.test(ids)) throw fail("UNSAFE");
    return inspect(ids);
  }
  async function absent(id) {
    return !(await run(["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", `id=${id}`])).trim();
  }
  function verify(info, id, r, expected) {
    const profile = approved[r.profile], game = isGame(r.profile);
    const h = info.HostConfig || {}, c = info.Config || {}, labels = c.Labels || {};
    if (info.Id !== expected || info.Name !== "/" + containerName(id) || info.Image !== r.imageId || c.Image !== profile.image ||
      labels[LABEL] !== "managed-v2" || labels[OWNER] !== db.agentId || labels[TX] !== r.transaction || labels[PROFILE_LABEL] !== r.profile || labels["gamepanel.id"] !== id ||
      c.User !== `${process.getuid()}:${process.getgid()}` || JSON.stringify(c.Cmd || []) !== JSON.stringify(profile.command) || JSON.stringify(c.Entrypoint || []) !== JSON.stringify(profile.entrypoint || []) ||
      !!c.Tty !== !!profile.tty || !!c.OpenStdin !== !!profile.tty || c.StdinOnce === true ||
      h.Privileged || h.NetworkMode !== (game ? r.network : "none") || !h.ReadonlyRootfs || h.Memory !== profile.memory || h.MemorySwap !== profile.memory || h.NanoCpus !== profile.nanoCPUs || h.PidsLimit !== profile.pids ||
      (h.CapAdd || []).length || !(h.CapDrop || []).includes("ALL") || !(h.SecurityOpt || []).includes("no-new-privileges") ||
      (h.Devices || []).length || (h.DeviceRequests || []).length || (h.VolumesFrom || []).length || (h.GroupAdd || []).length || JSON.stringify(h.PortBindings || {}) !== JSON.stringify(game ? portBindings(profile, r.port, profile.bindAddress) : {}) || JSON.stringify(h.Tmpfs || {}) !== JSON.stringify(profile.tmpfs || {}) ||
      !["", "private"].includes(h.IpcMode || "") || (h.PidMode || "") || (h.UTSMode || "") || (h.UsernsMode || "") || (h.RestartPolicy?.Name && h.RestartPolicy.Name !== "no") ||
      info.Mounts?.filter((m) => m.Type !== "tmpfs").length !== 1 || info.Mounts.some((m) => m.Type === "tmpfs" && !Object.hasOwn(profile.tmpfs || {}, m.Destination)) ||
      info.Mounts.find((m) => m.Type !== "tmpfs").Type !== "bind" || !info.Mounts.find((m) => m.Type !== "tmpfs").RW || info.Mounts.find((m) => m.Type !== "tmpfs").Destination !== "/data" || info.Mounts.find((m) => m.Type !== "tmpfs").Source !== storage(id, r)) throw fail("UNSAFE");
    if (game && runtimeEnvironment(profile, r.name).some((value) => !c.Env?.includes(value))) throw fail("UNSAFE");
    if (game) { const networks = Object.values(info.NetworkSettings?.Networks || {}); if (networks.length !== 1 || networks[0].NetworkID && networks[0].NetworkID !== r.network) throw fail("UNSAFE"); }
    return { id: info.Id, serverId: id, displayName: r.name, profile: r.profile, console: !!profile.tty, disposable: !game, managed: true,
      ...(game ? { connection: { provider: "direct", address: profile.bindAddress, port: r.port, protocol: profile.consoleKind === "unturned" ? "udp" : "tcp" } } : {}), running: !!info.State?.Running,
      state: ["created", "running", "exited", "paused", "restarting", "dead"].includes(info.State?.Status) ? info.State.Status : "unknown" };
  }
  async function inspectManaged(containerId) {
    guard(); const [id, r] = record(containerId);
    if (isGame(r.profile)) await ownedNetwork(id, r);
    return verify(await inspect(containerId), id, r, containerId);
  }
  async function removeOwned(id, r) {
    if (r.containerId && !await absent(r.containerId)) {
      if (r.network) await ownedNetwork(id, r);
      const checked = verify(await inspect(r.containerId), id, r, r.containerId);
      if (checked.running) throw fail("CONFLICT");
      await run(["container", "rm", r.containerId]);
      if (!await absent(r.containerId)) throw fail("UNSAFE");
    }
    if (r.network) { await ownedNetwork(id, r); await run(["network", "rm", r.network]); r.network = null; await persist(); }
    if (r.storage) fs.rmSync(storage(id, r), { recursive: true }); // Descendant links are unlinked, never followed.
    r.phase = "deleted"; await persist(); // Tombstones prevent reusing an old identity.
  }
  async function provision(body) {
    const input = validateCreate(body, !!games[body?.profile]);
    return exclusive(async () => {
      const id = input.serverId, profile = approved[input.profile], game = isGame(input.profile);
      if (db.servers[id]) throw fail("CONFLICT");
      if (game && Object.values(db.servers).some((r) => r.phase !== "deleted" && r.port === input.port)) throw fail("CONFLICT");
      if (game && Object.values(db.servers).filter((r) => r.phase !== "deleted" && r.profile === input.profile).length >= 2) throw fail("TOO_MANY");
      if (Object.keys(db.servers).length >= 128 || Object.values(db.servers).filter((r) => r.phase !== "deleted").length >= 8) throw fail("TOO_MANY");
      try { fs.lstatSync(path.join(root, id)); throw fail("CONFLICT"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (await named(id)) throw fail("CONFLICT");
      if (game && await namedNetwork(id)) throw fail("CONFLICT");
      const images = JSON.parse(await run(["image", "inspect", profile.image]));
      if (!Array.isArray(images) || images.length !== 1 || !IMAGE_ID.test(images[0].Id)) throw fail("UNSAFE");
      const r = { name: input.name, profile: input.profile, transaction: randomUUID(), imageId: images[0].Id, containerId: null, storage: null, phase: "preparing",
        ...(game ? { port: input.port, eula: true, network: null } : {}) };
      db.servers[id] = r;
      await persist();
      let attempted = false, networkAttempted = false;
      try {
        const location = path.join(root, id);
        fs.mkdirSync(location, { mode: 0o700 }); r.storage = directory(location); await persist();
        if (game) {
          networkAttempted = true;
          r.network = (await run(["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--label", `${OWNER}=${db.agentId}`, "--label", `${TX}=${r.transaction}`, networkName(id)])).trim();
          if (!FULL.test(r.network)) throw fail("UNSAFE");
          await persist(); await ownedNetwork(id, r);
        }
        const args = ["container", "create", "--pull=never", "--name", containerName(id), "--label", `${LABEL}=managed-v2`, "--label", `${OWNER}=${db.agentId}`,
          "--label", `${TX}=${r.transaction}`, "--label", `${PROFILE_LABEL}=${r.profile}`, "--label", `gamepanel.id=${id}`,
          "--user", `${process.getuid()}:${process.getgid()}`, "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--cpus=0.5", "--memory=128m", "--memory-swap=128m", "--pids-limit=32", "--restart=no", "--log-driver=json-file", "--log-opt=max-size=1m", "--log-opt=max-file=1",
          "--mount", `type=bind,src=${location},dst=/data`, ...(profile.tty ? ["--interactive", "--tty"] : []), profile.image, ...profile.command];
        attempted = true;
        const created = (profile.tty && createConsole ? await createConsole({ name: containerName(id),
          labels: { [LABEL]: "managed-v2", [OWNER]: db.agentId, [TX]: r.transaction, [PROFILE_LABEL]: r.profile, "gamepanel.id": id },
          user: `${process.getuid()}:${process.getgid()}`, storage: location, ...(game ? { runtime: profile, network: r.network, port: r.port, bind: profile.bindAddress, displayName: r.name } : {}) }) : await run(args)).trim();
        if (!FULL.test(created)) throw fail("UNSAFE");
        r.containerId = created;
        const result = verify(await inspect(created), id, r, created);
        r.phase = "active"; await persist();
        return result;
      } catch (error) {
        try {
          if (game && !r.network && networkAttempted) { r.network = await namedNetwork(id); if (!r.network) throw fail("CLEANUP_PENDING"); await ownedNetwork(id, r); }
          // A timed-out Docker create may still have succeeded. Resolve only this
          // transaction's exact name and verify all ownership/configuration before cleanup.
          if (!r.containerId) {
            const candidate = await named(id);
            if (candidate) { verify(candidate, id, r, candidate.Id); r.containerId = candidate.Id; }
            else if (attempted) throw fail("CLEANUP_PENDING"); // A lost reply may precede a late daemon commit.
          }
          await removeOwned(id, r);
        } catch { r.phase = "review"; try { await persist(); } catch {} throw fail("CLEANUP_PENDING"); }
        throw error;
      }
    });
  }
  return {
    provision,
    profiles: Object.keys(approved),
    memoryBudgetGiB,
    inspectManaged,
    async inspectIO(id) {
      guard(); const [logicalId, r] = record(id), info = await inspect(id);
      if (r.network) await ownedNetwork(logicalId, r);
      return { ...verify(info, logicalId, r, id), generation: info.State?.StartedAt || "" };
    },
    async consoleInput(id, body) {
      const { validCommand, sendCommand } = require("./log-console");
      validCommand(body, "any");
      return exclusive(async () => {
        const checked = await inspectManaged(id);
        const kind = GAME_PROFILES[checked.profile]?.consoleKind || "fixture";
        validCommand(body, kind);
        if (!checked.console) throw fail("UNSUPPORTED");
        if (!checked.running) throw fail("CONFLICT");
        await sendCommand(id, body.line, kind);
        return { status: "sent" };
      });
    },
    async list() {
      guard(); const result = [];
      for (const r of Object.values(db.servers)) if (r.phase === "active") {
        try { result.push(await inspectManaged(r.containerId)); } catch (e) { if (!["NOT_MANAGED", "UNSAFE"].includes(e.code)) throw e; }
      }
      return result;
    },
    async lifecycle(id, action) {
      if (!["start", "stop", "restart"].includes(action)) throw fail("BAD_REQUEST");
      return exclusive(async () => {
        const checked = await inspectManaged(id);
        if (action !== "stop" && !checked.running) {
          let used = 0;
          for (const r of Object.values(db.servers)) if (r.phase === "active" && r.containerId !== id) { const other = await inspectManaged(r.containerId); if (other.running) used += approved[r.profile].memory; }
          if (used + approved[checked.profile].memory > memoryBudgetGiB * 1024 ** 3) throw fail("RESOURCE_LIMIT");
        }
        await run(action === "start" ? ["container", "start", id] : ["container", action, "--time", isGame(checked.profile) ? "60" : "10", id]);
      });
    },
    async remove(id, body) {
      if (!body || Array.isArray(body) || Object.keys(body).join(",") !== "confirm" || body.confirm !== id) throw fail("BAD_REQUEST");
      return exclusive(async () => {
        const [serverId, r] = record(id, true);
        if (r.network) await ownedNetwork(serverId, r);
        if (!await absent(id) && verify(await inspect(id), serverId, r, id).running) throw fail("CONFLICT");
        r.phase = "deleting"; await persist();
        try { await removeOwned(serverId, r); } catch { throw fail("CLEANUP_PENDING"); }
        return { ok: true };
      });
    },
    close() {
      if (!closed) closed = (async () => { closing = true; if (current) await current; release(); })();
      return closed;
    }
  };
}
module.exports = { createProvisioningAdapter, validateCreate, PROFILE, CONSOLE_PROFILE, UUID };
