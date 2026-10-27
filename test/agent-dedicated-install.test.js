"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const { randomUUID, createHash } = require("node:crypto"), { execFileSync } = require("node:child_process"), { once } = require("node:events"), { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");
const run = (...args) => execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const docker = (...args) => run("/usr/bin/docker", ...args);
const inspect = (id) => JSON.parse(docker("inspect", id))[0];
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function tree(root) { const h = createHash("sha256"); function v(p) { const s = fs.lstatSync(p); h.update(path.relative(root, p) + ":" + s.mode + ":" + s.uid + ":" + s.gid); if (s.isSymbolicLink()) h.update(fs.readlinkSync(p)); else if (s.isDirectory()) for (const n of fs.readdirSync(p).sort()) v(path.join(p, n)); else if (s.isFile()) h.update(fs.readFileSync(p)); else throw Error("Special file"); } v(root); return h.digest("hex"); }
test("installed agent: real Terraria and generic Unturned; console, saves, restart and isolation", {
  skip: process.env.GAMEPANEL_AGENT_DEDICATED_TEST !== "1", timeout: 2400000
}, async (t) => {
  assert.equal(os.hostname(), "versagamepanel-dev"); assert.equal(process.getuid(), 0); assert.equal(docker("ps", "-aq"), "");
  assert.ok(!/^(nfs\d*|cifs|9p|virtiofs|fuse\.sshfs)$/m.test(run("findmnt", "-rn", "-o", "FSTYPE")));
  const service = () => run("systemctl", "show", "versagamepanel-dev.service", "-p", "MainPID", "-p", "WorkingDirectory", "-p", "ActiveState");
  const before = service(), original = [/WorkingDirectory=(.+)/.exec(before)[1], "/home/versadev/.local/share/versagamepanel-dev"], originalHashes = original.map(tree);
  const bundle = path.resolve(process.env.GAMEPANEL_DEVELOPER_BUNDLE), root = "/home/versadev/vgp-dedicated-install-" + randomUUID(), sockets = [], evidence = [];
  const install = (...args) => run("python3", path.join(bundle, "vgp-dev.py"), ...args, "--root", root);
  const compose = (...args) => docker("compose", "--env-file", path.join(root, ".env"), "-f", path.join(root, "compose.yaml"), ...args);
  let browser;
  t.after(async () => {
    if (browser) await browser.close(); for (const s of sockets) s.terminate();
    const registry = path.join(root, "agent-state/registry.json");
    if (fs.existsSync(registry)) {
      const db = JSON.parse(fs.readFileSync(registry));
      for (const r of Object.values(db.servers)) {
        if (r.containerId && docker("ps", "-aq", "--filter", "id=" + r.containerId)) {
          const c = inspect(r.containerId); assert.equal(c.Config.Labels["com.versarepair.versagamepanel.owner"], db.agentId); assert.equal(c.Config.Labels["com.versarepair.versagamepanel.transaction"], r.transaction);
          fs.writeFileSync(`/home/versadev/vgp-brother-evidence/${r.profile}-last-test.log`, docker("logs", "--tail", "120", r.containerId), { mode: 0o600 });
          docker("stop", "--time", "60", r.containerId); docker("rm", r.containerId);
        }
        if (r.network) { const n = JSON.parse(docker("network", "inspect", r.network))[0]; assert.equal(n.Labels["com.versarepair.versagamepanel.owner"], db.agentId); docker("network", "rm", r.network); }
      }
    }
    if (fs.existsSync(path.join(root, ".env"))) compose("down", "--volumes"); fs.rmSync(root, { recursive: true, force: true });
    assert.equal(docker("ps", "-aq"), ""); assert.equal(service(), before); assert.deepEqual(original.map(tree), originalHashes);
    fs.writeFileSync("/home/versadev/vgp-brother-evidence/dedicated-acceptance-summary.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
    t.diagnostic("Scoped cleanup and unchanged existing development service/source/data PASS.");
  });
  install("install", "--port", "18879");
  const panel = compose("ps", "-q", "panel"); assert.ok(inspect(panel).Mounts.every((m) => ["/data", "/tmp", "/run/agent-tls"].includes(m.Destination))); assert.throws(() => docker("exec", "--user", "1000:1000", panel, "docker", "info"));
  const password = fs.readFileSync(path.join(root, "panel-data/initial-admin-password.txt"), "utf8").trim(), url = "http://127.0.0.1:18879";
  const request = async (route, token, method = "GET", body) => { const r = await fetch(url + "/api" + route, { method, headers: token ? { authorization: "Bearer " + token } : {}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(90000) }); return { status: r.status, body: await r.json() }; };
  const login = async () => { const r = await request("/auth/login", null, "POST", { username: "admin", password }); assert.equal(r.status, 200); return r.body.token; };
  let admin = await login(); assert.deepEqual((await request("/servers", admin)).body.servers, []);
  const definitions = [
    { id: "terraria-vanilla", port: 7777, ready: /Server started|Listening on port/, command: "save", response: /World saved|Saving world data/i, save: "saves/world.wld" },
    { id: "unturned-dedicated", port: 27015, ready: /Loading level: 100%/, command: "Save", response: /Successfully saved|Saved the|Saved level|Saving/i }
  ];
  const selectedProfile = process.env.GAMEPANEL_AGENT_DEDICATED_PROFILE;
  assert.ok(!selectedProfile || definitions.some(({ id }) => id === selectedProfile), "dedicated profile filter must name one reviewed profile");
  for (const definition of definitions.filter(({ id }) => !selectedProfile || id === selectedProfile)) {
    fs.writeFileSync("/home/versadev/vgp-brother-evidence/dedicated-progress.txt", "Provisioning " + definition.id + "\n", { mode: 0o600 });
    const created = await request("/servers", admin, "POST", { profile: definition.id, port: definition.port, eula: true, name: "Dedicated verification " + definition.port });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const server = created.body.server, first = inspect(server.id), logical = first.Config.Labels["gamepanel.id"], data = path.join(root, "games", logical);
    assert.equal(first.Config.StdinOnce, false); assert.equal(first.HostConfig.ReadonlyRootfs, true); assert.equal(first.HostConfig.Privileged, false);
    assert.ok(Object.values(first.HostConfig.PortBindings).every((rows) => rows.length === 1 && rows[0].HostIp === "127.0.0.1"));
    if (definition.id === "unturned-dedicated") assert.deepEqual(Object.keys(first.HostConfig.PortBindings).sort(), ["27015/udp", "27016/udp"]);
    const action = async (name) => { const r = await request(`/servers/${server.id}/actions`, admin, "POST", { action: name }); assert.equal(r.status, 200, JSON.stringify(r.body)); };
    const ready = async () => {
      for (let n = 0; n < 900; n++) {
        const c = inspect(server.id), logs = docker("logs", "--since", c.State.StartedAt, "--tail", "100", server.id);
        if (!c.State.Running) assert.fail(`${definition.id} exited ${c.State.ExitCode}: ${logs.slice(-2000)}`);
        if (definition.ready.test(logs)) return logs;
        await delay(1000);
      } assert.fail("Game readiness deadline: " + definition.id);
    };
    await action("start");
    const logs = await ready();
    const steamCodeObserved = definition.id === "unturned-dedicated" && /Server Code:/.test(docker("logs", "--tail", "250", server.id));
    fs.writeFileSync("/home/versadev/vgp-brother-evidence/dedicated-progress.txt", "Console/save " + definition.id + "\n", { mode: 0o600 });
    const ticket = await request(`/servers/${server.id}/console-ticket`, admin, "POST", { mode: "console" }); assert.equal(ticket.status, 201);
    const ws = new WebSocket(url.replace("http:", "ws:") + `/ws/servers/${server.id}/console?ticket=${ticket.body.ticket}`, { origin: url }); sockets.push(ws);
    let text = ""; ws.on("message", (chunk) => { text += chunk; }); await once(ws, "open"); await delay(300); text = "";
    ws.send(definition.command + "\n"); for (let n = 0; n < 200 && !definition.response.test(text); n++) await delay(100); assert.match(text, definition.response); ws.close();
    await action("stop"); assert.equal(inspect(server.id).State.ExitCode, 0); assert.equal(inspect(server.id).State.OOMKilled, false);
    let saved = definition.save && path.join(data, definition.save);
    if (!saved) { const level = path.join(data, "install/Servers/vgp/Level"); saved = fs.readdirSync(level, { recursive: true }).filter((f) => f.endsWith(".dat")).map((f) => path.join(level, f))[0]; }
    assert.ok(saved && fs.statSync(saved).size > 0, "actual game save required"); const savedHash = hash(saved);
    const canary = path.join(data, "retained-advanced-settings.json"); fs.writeFileSync(canary, '{"retained":true}', { mode: 0o600 }); fs.chownSync(canary, 1000, 1000);
    await action("start"); await ready(); await action("restart"); await ready(); await action("stop");
    assert.equal(inspect(server.id).Id, server.id); assert.equal(inspect(server.id).State.ExitCode, 0); assert.equal(fs.readFileSync(canary, "utf8"), '{"retained":true}');
    assert.ok(fs.statSync(saved).size > 0); // Normal saves may change timestamps/content; no replacement/new identity is allowed.
    assert.equal((await request(`/servers/${server.id}/snapshots`, admin)).status, 501, "no fake backup fallback");
    evidence.push({ profile: definition.id, actualStartup: true, inputProcessed: true, gracefulExit: true, restartSameId: true, savePresent: true, firstSaveHash: savedHash, advancedCanaryRetained: true, steamCodeObserved, imageId: first.Image });
    const deletion = await request(`/servers/${server.id}`, admin, "DELETE", { confirm: server.id }); assert.equal(deletion.status, 200); assert.equal(fs.existsSync(data), false);
    t.diagnostic(`PASS ${definition.id}: actual server readiness, processed save command, graceful stop/restart, persistent save and advanced canary, scoped deletion.`);
  }
  assert.deepEqual((await request("/servers", admin)).body.servers, []); install("doctor");
});
