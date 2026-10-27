"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const { createHash, randomUUID, randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process"), { once } = require("node:events"), { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { gameStatus } = require("../test-support/minecraft-status");
const run = (args) => execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const docker = (...args) => run(["/usr/bin/docker", ...args]);
const inspect = (id) => JSON.parse(docker("inspect", id))[0];
function digest(root) { const h = createHash("sha256"); function visit(p) { const st = fs.lstatSync(p); h.update(path.relative(root, p) + ":" + st.mode + ":" + st.uid + ":" + st.gid); if (st.isSymbolicLink()) h.update(fs.readlinkSync(p)); else if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) visit(path.join(p, n)); else if (st.isFile()) h.update(fs.readFileSync(p)); else throw Error("Special file"); } visit(root); return h.digest("hex"); }
test("private developer bundle: actual install, socketless Minecraft, permissions, persistence, failure, revocation and cleanup", {
  skip: process.env.GAMEPANEL_DEVELOPER_TEST !== "1", timeout: 600000
}, async (t) => {
  assert.equal(os.hostname(), "versagamepanel-dev"); assert.equal(process.getuid(), 0, "Installer acceptance requires root only inside the disposable VM");
  assert.equal(process.env.GAMEPANEL_ACCEPT_MINECRAFT_EULA, "1"); assert.equal(docker("ps", "-aq"), "", "Occupied daemon: refuse test");
  assert.ok(!/^(nfs\d*|cifs|9p|virtiofs|fuse\.sshfs)$/m.test(run(["findmnt", "-rn", "-o", "FSTYPE"])));
  const service = () => run(["systemctl", "show", "versagamepanel-dev.service", "-p", "MainPID", "-p", "WorkingDirectory", "-p", "ActiveState"]);
  const before = service(); assert.match(before, /ActiveState=active/);
  const original = [/WorkingDirectory=(.+)/.exec(before)[1], "/home/versadev/.local/share/versagamepanel-dev"], hashes = original.map(digest);
  const bundle = path.resolve(process.env.GAMEPANEL_DEVELOPER_BUNDLE), script = path.join(bundle, "vgp-dev.py"), manifest = JSON.parse(fs.readFileSync(path.join(bundle, "bundle.json")));
  const root = "/home/versadev/vgp-brother-install-" + randomUUID(), ids = [], networkIds = [], sockets = [];
  const install = (...args) => run(["python3", script, ...args, "--root", root]);
  const compose = (...args) => docker("compose", "--env-file", path.join(root, ".env"), "-f", path.join(root, "compose.yaml"), ...args);
  let browser;
  t.after(async () => {
    if (browser) await browser.close(); for (const ws of sockets) ws.terminate();
    if (fs.existsSync(path.join(root, ".env"))) { const a = compose("ps", "-aq", "agent"); if (a) fs.writeFileSync("/tmp/vgp-brother-agent-diagnostic.log", docker("logs", "--tail", "12", a), { mode: 0o600 }); }
    const registry = path.join(root, "agent-state/registry.json");
    if (fs.existsSync(registry)) {
      const db = JSON.parse(fs.readFileSync(registry));
      for (const record of Object.values(db.servers)) {
        if (record.containerId && docker("ps", "-aq", "--filter", "id=" + record.containerId)) {
          const labels = inspect(record.containerId).Config.Labels;
          assert.equal(labels["com.versarepair.versagamepanel.owner"], db.agentId); assert.equal(labels["com.versarepair.versagamepanel.transaction"], record.transaction);
          docker("stop", "--time", "60", record.containerId); docker("rm", record.containerId);
        }
        if (record.network && docker("network", "ls", "-q", "--filter", "id=" + record.network)) { assert.equal(JSON.parse(docker("network", "inspect", record.network))[0].Labels["com.versarepair.versagamepanel.owner"], db.agentId); docker("network", "rm", record.network); }
      }
    }
    for (const id of ids) if (docker("ps", "-aq", "--filter", "id=" + id)) docker("rm", "-fv", id);
    if (fs.existsSync(path.join(root, ".env"))) compose("down", "--volumes");
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(docker("ps", "-aq"), ""); assert.equal(service(), before); assert.deepEqual(original.map(digest), hashes);
    t.diagnostic("Cleanup PASS: only fixture resources removed; existing development service PID/state and monitored source/data unchanged.");
  });
  assert.equal(JSON.parse(install("verify")).sourceCommit, manifest.sourceCommit);
  install("install", "--port", "18878");
  assert.throws(() => install("install", "--port", "18878"), "duplicate installation rejected without resetting users/data");
  const panel = compose("ps", "-q", "panel"), agent = compose("ps", "-q", "agent"), panelInfo = inspect(panel);
  assert.ok(panelInfo.Mounts.every((m) => ["/data", "/run/agent-tls", "/tmp"].includes(m.Destination)));
  assert.throws(() => docker("exec", "--user", "1000:1000", panel, "docker", "info"));
  assert.equal(docker("exec", "--user", "1000:1000", panel, "node", "-e", "console.log(require('fs').existsSync('/var/run/docker.sock'))"), "false");
  assert.equal(Object.keys(inspect(agent).NetworkSettings.Ports || {}).filter((p) => inspect(agent).NetworkSettings.Ports[p]).length, 0);
  const url = "http://127.0.0.1:18878", password = fs.readFileSync(path.join(root, "panel-data/initial-admin-password.txt"), "utf8").trim();
  const request = async (route, token, method = "GET", body) => { const r = await fetch(url + "/api" + route, { method, headers: token ? { authorization: "Bearer " + token } : {}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(90000) }); return { status: r.status, body: await r.json() }; };
  const login = async (name, secret) => { const r = await request("/auth/login", null, "POST", { username: name, password: secret }); assert.equal(r.status, 200); return r.body.token; };
  let admin = await login("admin", password); assert.equal((await request("/servers", null)).status, 401);
  assert.deepEqual((await request("/servers", admin)).body.servers, []); assert.ok((await request("/status", admin)).body.profiles.includes("minecraft-java-1.21.1"));
  let gamePort;
  for (let port = 25565; port <= 25572; port++) { const s = net.createServer(); try { s.listen(port, "127.0.0.1"); await once(s, "listening"); await new Promise((r) => s.close(r)); gamePort = port; break; } catch { s.close(); } }
  assert.ok(gamePort, "No safe game port available");
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= "/home/versadev/.cache/ms-playwright";
  const { chromium, expect } = require("@playwright/test");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await page.goto(url);
  await page.getByLabel("Username", { exact: true }).fill("admin"); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByText(/Developer prerelease 0.2.0-dev.2/)).toBeVisible();
  await page.getByLabel("Server name", { exact: true }).fill("Brother acceptance Minecraft");
  await page.getByLabel("Server profile", { exact: true }).selectOption("minecraft-java-1.21.1");
  await page.getByLabel("Game port", { exact: true }).fill(String(gamePort)); await page.locator('input[name="eula"]').check();
  await page.getByRole("button", { name: "Create Server", exact: true }).click(); await expect(page.getByRole("heading", { name: "Brother acceptance Minecraft", exact: true })).toBeVisible();
  const game = (await request("/servers", admin)).body.servers[0], fullId = game.id;
  const checked = inspect(fullId); networkIds.push(checked.HostConfig.NetworkMode);
  assert.equal(checked.Config.Image, manifest.images.minecraft); assert.equal(checked.HostConfig.Memory, 3 * 1024 ** 3); assert.equal(checked.Config.StdinOnce, false); assert.equal(checked.HostConfig.ReadonlyRootfs, true);
  assert.equal(checked.HostConfig.PortBindings["25565/tcp"][0].HostIp, "127.0.0.1");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  let status;
  for (let n = 0; n < 150; n++) { try { status = await gameStatus(gamePort); break; } catch {} await delay(1000); }
  assert.equal(status?.version?.name, "1.21.1", "real game did not become ready"); assert.equal(status.players.max, 8);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.locator("#terminal")).toContainText("For help, type", { timeout: 180000 });
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await page.getByLabel("Console command", { exact: true }).fill("say VGP_BROTHER_GAME_PROVED"); await page.getByRole("button", { name: "Send command", exact: true }).click();
  await expect(page.locator("#terminal")).toContainText("[Server] VGP_BROTHER_GAME_PROVED");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Disconnect stream", exact: true }).click(); await browser.close(); browser = null;
  const operatorSecret = randomBytes(24).toString("base64url");
  await request("/users", admin, "POST", { username: "brother", password: operatorSecret, serverIds: [fullId] });
  const brother = await login("brother", operatorSecret);
  const b = (await request("/servers", admin, "POST", { profile: "alpine-smoke-v1", name: "Unassigned fixture" })).body.server;
  assert.equal((await request(`/servers/${b.id}/console-ticket`, brother, "POST", { mode: "logs" })).status, 404);
  assert.equal((await request(`/servers/${fullId}/backups`, brother)).status, 501, "backup/restore must be honestly blocked in agent mode");
  const ticket = async (mode) => { const r = await request(`/servers/${fullId}/console-ticket`, brother, "POST", { mode }); assert.equal(r.status, 201); return r.body.ticket; };
  const open = async (mode = "logs") => {
    const ws = new WebSocket(url.replace("http:", "ws:") + `/ws/servers/${fullId}/${mode}?ticket=${await ticket(mode)}`, { origin: url }); sockets.push(ws);
    let text = ""; ws.on("message", (m) => { text += m; }); await once(ws, "open"); return { ws, text: () => text };
  };
  const console = await open("console");
  console.ws.send("list\n"); for (let i = 0; i < 100 && !/There are 0 of a max of 8 players online/.test(console.text()); i++) await delay(50);
  assert.match(console.text(), /There are 0 of a max of 8 players online/); console.ws.close(); await delay(100);
  const bad = await open("console"), badClosed = once(bad.ws, "close"); bad.ws.send("op intruder\n"); await badClosed;
  assert.equal(inspect(fullId).State.Running, true);
  const oldPID = inspect(fullId).State.Pid;
  docker("kill", "--signal", "KILL", agent); docker("start", agent);
  for (let n = 0; n < 30 && !(await request("/status", admin)).body.ok; n++) await delay(500);
  assert.equal((await request("/status", admin)).body.ok, true, "kernel lock permits safe recovery of an orphaned state lock");
  assert.equal(inspect(fullId).State.Pid, oldPID);
  docker("restart", panel); await delay(1500); admin = await login("admin", password);
  assert.equal((await request("/servers", admin)).body.servers.find((s) => s.id === fullId).id, fullId);
  assert.equal((await request(`/servers/${fullId}/actions`, admin, "POST", { action: "stop" })).status, 200);
  assert.equal(inspect(fullId).State.ExitCode, 0, "real Java server exited gracefully");
  const db = JSON.parse(fs.readFileSync(path.join(root, "agent-state/registry.json"))), logicalId = checked.Config.Labels["gamepanel.id"], world = path.join(root, "games", logicalId, "world");
  assert.ok(fs.statSync(path.join(world, "level.dat")).size > 0);
  const worldHash = createHash("sha256").update(fs.readFileSync(path.join(world, "level.dat"))).digest("hex");
  install("upgrade", "--bundle", bundle); install("rollback", "--bundle", bundle);
  assert.equal(createHash("sha256").update(fs.readFileSync(path.join(world, "level.dat"))).digest("hex"), worldHash);
  assert.equal((await request("/servers", admin)).body.servers.some((s) => s.id === fullId), true);
  const badBundle = root + "_corrupt"; fs.mkdirSync(badBundle);
  try { for (const name of fs.readdirSync(bundle)) fs.copyFileSync(path.join(bundle, name), path.join(badBundle, name)); fs.appendFileSync(path.join(badBundle, "INSTALL.md"), "corrupt"); assert.throws(() => install("upgrade", "--bundle", badBundle)); }
  finally { fs.rmSync(badBundle, { recursive: true, force: true }); }
  const policy = path.join(root, "tls/agent/peers.json"), saved = fs.readFileSync(policy);
  install("revoke-panel"); assert.equal((await request("/status", admin)).body.ok, false);
  fs.writeFileSync(policy, saved); assert.equal((await request("/status", admin)).body.ok, true);
  assert.equal((await request(`/servers/${fullId}`, admin, "DELETE", { confirm: fullId })).status, 200);
  assert.equal((await request(`/servers/${b.id}`, admin, "DELETE", { confirm: b.id })).status, 200);
  assert.equal(fs.existsSync(world), false); assert.equal(docker("network", "ls", "-q", "--filter", "id=" + networkIds[0]), "");
  const diagnostic = install("doctor"); assert.ok(!diagnostic.includes(password)); assert.ok(!diagnostic.includes("PRIVATE KEY"));
  t.diagnostic(`PASS actual Minecraft Java ${status.version.name}: fresh offline-bundle deployment, mobile Chromium create/console, real protocol and stdin, private ports/resources/network, cross-server denial, graceful world save, control crash/restarts, update/rollback, corrupt-bundle rejection and certificate revocation. Source ${manifest.sourceCommit}.`);
  t.diagnostic("NOT IMPLEMENTED in agent mode: in-app files/settings, mod installation and backup/restore; dedicated game profiles are tested separately. No fallback attempted.");
});
