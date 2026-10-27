"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { testPKI } = require("../test-support/agent-pki");
const { createAgentClient } = require("../lib/agent-client");
const { PROFILE, CONSOLE_PROFILE } = require("../agent/provisioning");
const provisioning = process.env.GAMEPANEL_AGENT_PROVISION_TEST === "1";
const ioTest = process.env.GAMEPANEL_AGENT_IO_TEST === "1";

const docker = (args) => execFileSync("/usr/bin/docker", args, { encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024,
  env: { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "default" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const info = (id) => JSON.parse(docker(["inspect", id]))[0];

function digestTree(root) {
  const hash = createHash("sha256");
  function visit(file) {
    const stat = fs.lstatSync(file);
    hash.update(path.relative(root, file) + ":" + stat.mode + ":" + stat.uid + ":" + stat.gid);
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else if (stat.isFile()) hash.update(fs.readFileSync(file));
    else throw new Error("Unexpected special file in existing application storage.");
  }
  visit(root); return hash.digest("hex");
}

test(`real mTLS socketless panel: ${provisioning ? "restricted provisioning, deletion and" : ""} lifecycle, denial, disconnect and persistence`, {
  skip: process.env.GAMEPANEL_AGENT_DOCKER_TEST !== "1", timeout: 180000
}, async (t) => {
  assert.equal(os.hostname(), "versagamepanel-dev", "This acceptance test is restricted to the isolated development VM.");
  if (ioTest) assert.equal(provisioning, true, "Log/TTY acceptance requires registry-backed provisioning.");
  assert.equal(docker(["ps", "-aq"]), "", "Existing Docker workloads: do not force this test.");
  const mounts = execFileSync("findmnt", ["-rn", "-o", "FSTYPE"], { encoding: "utf8" });
  assert.ok(!/^(nfs\d*|cifs|9p|virtiofs|fuse\.sshfs)$/m.test(mounts), "Sensitive/network share isolation requires review.");
  const service = () => execFileSync("systemctl", ["show", "versagamepanel-dev.service", "-p", "MainPID", "-p", "WorkingDirectory", "-p", "ActiveState"], { encoding: "utf8" });
  const beforeService = service(); assert.match(beforeService, /ActiveState=active/);
  const working = /^WorkingDirectory=(.+)$/m.exec(beforeService)[1];
  assert.match(working, /^\/home\/versadev\/VersaGamePanel-/);
  const monitored = [working, "/home/versadev/.local/share/versagamepanel-dev"];
  const beforeFiles = monitored.map(digestTree);
  const image = process.env.GAMEPANEL_AGENT_TEST_IMAGE || "versagamepanel/panel:secure-agent-test";
  docker(["image", "inspect", image]); docker(["image", "inspect", "alpine:latest"]);
  const pki = testPKI(), base = fs.mkdtempSync(path.join(os.tmpdir(), "vgp-agent-slice-"));
  const stateRoot = path.join(base, "state");
  if (provisioning) { fs.mkdirSync(stateRoot, { mode: 0o700 }); pki.policy("server-peers", [pki.panel.pin], [], [pki.panel.pin], ioTest ? [pki.panel.pin] : undefined); }
  const prefix = "vgp-secure-" + randomUUID();
  const network = prefix + "-net", volume = prefix + "-panel-data";
  const containers = [];
  let networkCreated = false, volumeCreated = false, browser;
  t.after(async () => {
    if (browser) await browser.close();
    if (provisioning && fs.existsSync(path.join(stateRoot, "registry.json"))) {
      const db = JSON.parse(fs.readFileSync(path.join(stateRoot, "registry.json")));
      for (const record of Object.values(db.servers)) if (record.containerId && !containers.includes(record.containerId) && docker(["ps", "-aq", "--no-trunc", "--filter", `id=${record.containerId}`])) {
        const own = info(record.containerId).Config.Labels;
        assert.equal(own["com.versarepair.versagamepanel.owner"], db.agentId);
        assert.equal(own["com.versarepair.versagamepanel.transaction"], record.transaction);
        containers.push(record.containerId);
      }
    }
    for (const id of containers.reverse()) if (docker(["ps", "-aq", "--filter", `id=${id}`])) docker(["rm", "-fv", id]);
    if (volumeCreated) docker(["volume", "rm", volume]);
    if (networkCreated) docker(["network", "rm", network]);
    pki.cleanup(); fs.rmSync(base, { recursive: true, force: true });
    assert.equal(docker(["ps", "-aq"]), "");
    assert.equal(service(), beforeService);
    assert.deepEqual(monitored.map(digestTree), beforeFiles);
    t.diagnostic("Cleanup verified: no fixture containers/network/volume/credentials remain; existing panel PID/state and monitored files unchanged.");
  });
  const games = path.join(base, "games");
  fs.mkdirSync(games, { mode: 0o700 });
  for (const name of ["authorized", "foreign"]) fs.mkdirSync(path.join(games, name), { mode: 0o700 });
  function fixture(name, authorized) {
    const args = ["create", "--name", prefix + "-" + name, "--pull=never", "--network", "none", "--user", "1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=32m", "--pids-limit=16", "--mount", `type=bind,src=${games}/${name},dst=/data`];
    if (authorized) args.push("--label", "com.versarepair.versagamepanel.agent=managed-v1", "--label", "gamepanel.id=authorized-disposable");
    args.push("alpine:latest", "sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done");
    const id = docker(args); containers.push(id); return id;
  }
  let authorized = provisioning ? null : fixture("authorized", true);
  const foreign = fixture("foreign", false);
  docker(["start", foreign]); const foreignBefore = JSON.stringify(info(foreign));
  // Docker refuses an overlapping subnet; never alter another network to force this fixture.
  docker(["network", "create", "--internal", "--subnet", "172.30.231.0/24", network]); networkCreated = true;
  const subnet = JSON.parse(docker(["network", "inspect", network]))[0].IPAM.Config[0].Subnet;
  const agentIP = subnet.split("/")[0].split(".").slice(0, 3).concat("2").join(".");
  docker(["volume", "create", volume]); volumeCreated = true;
  function credentials(config) {
    return ["ca", "cert", "key", "policy"].flatMap((name) => ["--mount", `type=bind,src=${config[name]},dst=/run/agent-tls/${name},readonly`]);
  }
  const agentName = prefix + "-agent";
  const agent = docker(["run", "-d", "--name", agentName, "--network", network, "--ip", agentIP, "--user", "1000:1000", "--group-add", String(fs.statSync("/var/run/docker.sock").gid), "--read-only", "--tmpfs", "/data:rw,nosuid,nodev,noexec,size=1m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=256m",
    "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock", "--mount", `type=bind,src=${games},dst=${games}`, ...credentials(pki.server),
    ...(provisioning ? ["--mount", `type=bind,src=${stateRoot},dst=${stateRoot}`, "-e", `VGP_AGENT_STATE_DIR=${stateRoot}`] : []),
    "-e", "VGP_AGENT_TRANSPORT=mtls", "-e", `VGP_AGENT_BIND_ADDRESS=${agentIP}`, "-e", `VGP_AGENT_DATA_ROOT=${games}`,
    "-e", "VGP_AGENT_CA_FILE=/run/agent-tls/ca", "-e", "VGP_AGENT_CERT_FILE=/run/agent-tls/cert", "-e", "VGP_AGENT_KEY_FILE=/run/agent-tls/key", "-e", "VGP_AGENT_PEER_POLICY_FILE=/run/agent-tls/policy", "-e", "VGP_AGENT_PEER_NAME=panel.test", "--entrypoint", "node", image, "/app/agent/daemon.js"]);
  containers.push(agent);
  const panelName = prefix + "-panel";
  const panelIP = agentIP.split(".").slice(0, 3).concat("3").join(".");
  const panel = docker(["run", "-d", "--name", panelName, "--network", network, "--ip", panelIP, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m", "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--security-opt=no-new-privileges", "--memory=512m", "--pids-limit=128", "-v", `${volume}:/data`, ...credentials(pki.client),
    "-e", "GAMEPANEL_BACKEND=agent", "-e", `GAMEPANEL_AGENT_URL=https://${agentIP}:9443`, "-e", "GAMEPANEL_AGENT_CA_FILE=/run/agent-tls/ca", "-e", "GAMEPANEL_AGENT_CERT_FILE=/run/agent-tls/cert", "-e", "GAMEPANEL_AGENT_KEY_FILE=/run/agent-tls/key", "-e", "GAMEPANEL_AGENT_PEER_POLICY_FILE=/run/agent-tls/policy", "-e", "GAMEPANEL_AGENT_PEER_NAME=agent.test", image]);
  containers.push(panel);
  const createdPanel = info(panel);
  assert.equal(createdPanel.State.Running, true, `Temporary panel startup failed: ${docker(["logs", panel]).split("\n").slice(-3).join(" ")}`);
  const url = `http://${createdPanel.NetworkSettings.Networks[network].IPAddress}:8788`;
  async function ready() {
    for (let n = 0; n < 30; n++) { assert.equal(t.signal.aborted, false, "Test was cancelled"); try { if ((await fetch(url + "/api/auth/state", { signal: AbortSignal.timeout(1000) })).ok) return; } catch {} await delay(100); }
    throw new Error("Isolated panel did not become ready; inspect only its redacted startup status.");
  }
  await ready();
  const panelInfo = info(panel);
  assert.ok(panelInfo.Mounts.every((m) => m.Destination === "/data" || m.Destination.startsWith("/run/agent-tls/") || m.Destination === "/tmp"));
  assert.equal(panelInfo.HostConfig.Privileged, false);
  assert.equal(docker(["exec", "--user", "1000:1000", panel, "node", "-e", "process.stdout.write(String(require('fs').existsSync('/var/run/docker.sock')))"]), "false");
  assert.throws(() => docker(["exec", "--user", "1000:1000", panel, "docker", "info"]));
  t.diagnostic("Panel: no Docker socket mount, docker info denied; private internal bridge, no published agent port.");
  const password = docker(["exec", "--user", "1000:1000", panel, "cat", "/data/initial-admin-password.txt"]);
  async function request(route, token, method = "GET", body) {
    const response = await fetch(url + "/api" + route, { method, signal: AbortSignal.timeout(35000), headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function login(name, secret) { const r = await request("/auth/login", null, "POST", { username: name, password: secret }); assert.equal(r.status, 200); return r.body.token; }
  let admin = await login("admin", password);
  assert.equal((await request("/servers", null)).status, 401);
  assert.equal((await request("/status", admin)).body.ok, true);
  let logicalId, ownedPath;
  const direct = createAgentClient({ url: `https://${agentIP}:9443`, tls: pki.client, timeout: 3000 });
  if (provisioning) {
    assert.deepEqual((await request("/servers", admin)).body.servers, [], "fresh registry never adopts preexisting labelled/foreign containers");
    if (process.env.GAMEPANEL_AGENT_BROWSER_TEST === "1") {
      const { chromium, expect } = require("@playwright/test");
      browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
      const page = await browser.newPage(); await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin"); await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign In", exact: true }).click();
      await expect(page.getByText("No authorized agent servers available.", { exact: true })).toBeVisible();
      await page.getByLabel("Server name", { exact: true }).fill("Provisioned smoke");
      await page.getByRole("button", { name: "Create Server", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Provisioned smoke", exact: true })).toBeVisible();
      await browser.close(); browser = null;
    } else assert.equal((await request("/servers", admin, "POST", { profile: PROFILE.id, name: "Provisioned smoke" })).status, 201);
    const entries = (await request("/servers", admin)).body.servers;
    assert.equal(entries.length, 1); authorized = entries[0].id; containers.push(authorized);
    const checked = info(authorized); logicalId = checked.Config.Labels["gamepanel.id"]; ownedPath = path.join(games, logicalId);
    assert.equal(checked.Config.Image, PROFILE.image); assert.equal(checked.HostConfig.NetworkMode, "none");
    assert.equal(checked.HostConfig.Memory, PROFILE.memory); assert.equal(checked.HostConfig.PidsLimit, PROFILE.pids); assert.equal(checked.HostConfig.NanoCpus, PROFILE.nanoCPUs);
    assert.equal(checked.HostConfig.ReadonlyRootfs, true); assert.equal(checked.State.Status, "created");
    assert.equal(fs.statSync(ownedPath).mode & 0o777, 0o700);
    const input = { profile: PROFILE.id, serverId: logicalId, name: "Duplicate" };
    await assert.rejects(direct.provision(input), { statusCode: 409 });
    for (const bad of [{ ...input, serverId: "../escape" }, { ...input, image: "unsafe" }, { ...input, command: "unsafe" }, { ...input, networkMode: "host" }, { ...input, profile: "arbitrary" }]) await assert.rejects(direct.provision(bad), { statusCode: 400 });
    const linkId = randomUUID(), outside = path.join(base, "outside-canary"); fs.mkdirSync(outside, { mode: 0o700 }); fs.writeFileSync(path.join(outside, "marker"), "untouched");
    fs.symlinkSync(outside, path.join(games, linkId));
    await assert.rejects(direct.provision({ ...input, serverId: linkId }), { statusCode: 409 });
    const concurrent = await Promise.all(Array.from({ length: 4 }, async () => {
      try { const r = await direct.provision({ ...input, serverId: randomUUID(), name: "Concurrent fixture" }); containers.push(r.server.id); return { status: 201, id: r.server.id }; }
      catch (error) { return { status: error.statusCode }; }
    }));
    assert.ok(concurrent.some((r) => r.status === 429), "overlapping requests are rejected, not queued without a bound");
    assert.ok(concurrent.some((r) => r.status === 201));
    for (const r of concurrent) if (r.id) await direct.remove(r.id, { confirm: r.id });
    assert.equal(fs.readFileSync(path.join(outside, "marker"), "utf8"), "untouched");
    t.diagnostic("Provisioning: empty inventory, Chromium Create Server, pinned profile/limits/private storage, duplicate/traversal/unsafe/symlink rejection and concurrent 429 PASS.");
  }
  assert.deepEqual((await request("/servers", admin)).body.servers.map((s) => s.id), [authorized]);
  const operatorSecret = randomBytes(24).toString("base64url");
  assert.equal((await request("/users", admin, "POST", { username: "operator", password: operatorSecret, serverIds: [authorized] })).status, 201);
  assert.equal((await request("/users", admin, "POST", { username: "denied", password: operatorSecret })).status, 201);
  let operator = await login("operator", operatorSecret);
  const denied = await login("denied", operatorSecret);
  if (provisioning) {
    assert.equal((await request("/servers", operator, "POST", { profile: PROFILE.id, name: "Forbidden" })).status, 403);
    assert.equal((await request(`/servers/${authorized}`, operator, "DELETE", { confirm: authorized })).status, 403);
    assert.equal((await request(`/servers/${foreign}`, admin, "DELETE", { confirm: foreign })).status, 404);
  }
  assert.deepEqual((await request("/servers", denied)).body.servers, []);
  assert.equal((await request(`/servers/${authorized}/actions`, denied, "POST", { action: "start" })).status, 404);
  for (const action of ["start", "stop", "restart"]) assert.equal((await request(`/servers/${foreign}/actions`, admin, "POST", { action })).status, 404);
  async function control(action) { assert.equal((await request(`/servers/${authorized}/actions`, operator, "POST", { action })).status, 200); }
  await control("start"); assert.equal(info(authorized).State.Running, true);
  const firstPID = info(authorized).State.Pid;
  await control("restart"); assert.equal(info(authorized).State.Running, true); assert.notEqual(info(authorized).State.Pid, firstPID);
  await control("stop"); assert.equal(info(authorized).State.ExitCode, 0);
  if (ioTest) {
    const { WebSocket } = require("ws");
    const fixture = (await request("/servers", admin, "POST", { profile: CONSOLE_PROFILE.id, name: "TTY console fixture" })).body.server;
    assert.ok(fixture?.id); containers.push(fixture.id);
    const tty = info(fixture.id); assert.equal(tty.Config.Tty, true); assert.equal(tty.Config.OpenStdin, true); assert.equal(tty.Config.StdinOnce, false);
    assert.equal(tty.Config.Image, PROFILE.image); assert.equal(tty.HostConfig.NetworkMode, "none");
    await request("/users/operator", admin, "PUT", { serverIds: [fixture.id] });
    let ioOperator = await login("operator", operatorSecret);
    const ticketFor = (id, token = ioOperator, mode = "logs") => request(`/servers/${id}/console-ticket`, token, "POST", { mode });
    assert.equal((await ticketFor(authorized)).status, 404, "operator assigned A cannot request B's logs");
    assert.equal((await ticketFor(fixture.id, denied)).status, 404);
    assert.equal((await ticketFor(foreign, admin)).status, 404);
    assert.equal((await ticketFor(authorized, admin, "console")).status, 501, "smoke profile is not command capable");
    assert.equal((await ticketFor(fixture.id, admin, "console")).status, 409, "stopped console has friendly status");
    assert.equal((await request(`/servers/${fixture.id}/actions`, admin, "POST", { action: "start" })).status, 200);
    const open = async (mode = "logs") => {
      const ticket = await ticketFor(fixture.id, ioOperator, mode); assert.equal(ticket.status, 201);
      const ws = new WebSocket(url.replace("http:", "ws:") + `/ws/servers/${fixture.id}/${mode}?ticket=${ticket.body.ticket}`, { origin: url });
      let text = ""; ws.on("message", (chunk) => { text += chunk.toString(); });
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      return { ws, text: () => text };
    };
    const waitText = async (stream, match) => { for (let i = 0; i < 100; i++) { if (match.test(stream.text())) return; await delay(30); } assert.match(stream.text(), match); };
    const logs = await open(); await waitText(logs, /console fixture ready/); logs.ws.close();
    await delay(100);
    const subscriptionOne = await open(), subscriptionTwo = await open();
    await waitText(subscriptionOne, /console fixture ready/); await waitText(subscriptionTwo, /console fixture ready/);
    const excess = direct.openStream(fixture.id); let excessText = ""; excess.stdout.on("data", (c) => { excessText += c; }); excess.stderr.resume();
    await new Promise((resolve) => excess.once("close", resolve)); assert.match(excessText, /stream limit/);
    subscriptionOne.ws.close(); subscriptionTwo.ws.close(); await delay(100);
    const console = await open("console"); await waitText(console, /console fixture ready/);
    console.ws.send("ping\n"); await waitText(console, /pong/);
    console.ws.send("status\n"); await waitText(console, /status: ready/);
    assert.equal(info(fixture.id).State.Running, true, "TTY detach did not stop PID 1");
    console.ws.close(); await delay(100);
    const history = direct.openStream(fixture.id, "logs", false); let historical = "";
    history.stdout.on("data", (c) => { historical += c; }); history.stderr.resume();
    await new Promise((resolve) => history.once("close", resolve)); assert.match(historical, /pong/);
    const rejected = await open("console"); await waitText(rejected, /console fixture ready/);
    const rejectClosed = new Promise((resolve) => rejected.ws.once("close", resolve)); rejected.ws.send("ping\nstatus\n"); await rejectClosed;
    assert.equal(info(fixture.id).State.Running, true);
    const revoked = await open(); await waitText(revoked, /console fixture ready/);
    const revokedClosed = new Promise((resolve) => revoked.ws.once("close", resolve));
    await request("/users/operator", admin, "PUT", { serverIds: [] }); await revokedClosed;
    assert.equal((await ticketFor(fixture.id)).status, 404);
    await request("/users/operator", admin, "PUT", { serverIds: [fixture.id] });
    ioOperator = await login("operator", operatorSecret);
    const restarted = await open(); await waitText(restarted, /console fixture ready/);
    const restartClosed = new Promise((resolve) => restarted.ws.once("close", resolve));
    assert.equal((await request(`/servers/${fixture.id}/actions`, admin, "POST", { action: "restart" })).status, 200);
    await restartClosed;
    const reconnected = await open(); await waitText(reconnected, /console fixture ready/); reconnected.ws.close(); await delay(100);
    if (process.env.GAMEPANEL_AGENT_BROWSER_TEST === "1") {
      const { chromium, expect } = require("@playwright/test");
      browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin"); await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign In", exact: true }).click();
      const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "TTY console fixture", exact: true }) });
      await card.getByRole("button", { name: "Logs", exact: true }).click(); await expect(page.locator("#terminal")).toContainText("console fixture ready");
      await card.getByRole("button", { name: "Console", exact: true }).click(); await expect(page.locator("#terminal")).toContainText("console fixture ready");
      await page.getByLabel("Console command", { exact: true }).fill("help"); await page.getByRole("button", { name: "Send command", exact: true }).click();
      await expect(page.locator("#terminal")).toContainText("commands: ping status help");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole("button", { name: "Disconnect stream", exact: true }).click();
      await browser.close(); browser = null;
    }
    const disconnect = await open(); await waitText(disconnect, /console fixture ready/);
    const disconnectClosed = new Promise((resolve) => disconnect.ws.once("close", resolve));
    docker(["stop", "--time", "3", agent]); await disconnectClosed; docker(["start", agent]);
    for (let n = 0; n < 30; n++) { if ((await request("/status", admin)).body.ok) break; await delay(100); }
    const unknown = direct.openStream(foreign); let deniedText = ""; unknown.stdout.on("data", (c) => { deniedText += c; }); unknown.stderr.resume();
    await new Promise((resolve) => unknown.once("close", resolve)); assert.match(deniedText, /not authorized/);
    await request(`/servers/${fixture.id}/actions`, admin, "POST", { action: "stop" });
    const stopped = direct.openStream(fixture.id); let stoppedText = ""; stopped.stdout.on("data", (c) => { stoppedText += c; }); stopped.stderr.resume();
    await new Promise((resolve) => stopped.once("close", resolve)); assert.match(stoppedText, /Server stopped/);
    assert.equal((await request(`/servers/${fixture.id}`, admin, "DELETE", { confirm: fixture.id })).status, 200);
    await request("/users/operator", admin, "PUT", { serverIds: [authorized] });
    operator = await login("operator", operatorSecret);
    t.diagnostic("IO PASS: real Docker TTY ping/status/help, bounded history and live logs through socketless panel; cross-server/foreign/unassigned/malformed denial, assignment revocation, reconnect, stopped logs and agent disconnect cleanup; Chromium mobile logs/console.");
  }
  for (const route of ["/docker", `/servers/${authorized}/files`, `/servers/${authorized}/backups`, `/servers/${authorized}/console-ticket`]) assert.equal((await request(route, admin)).status, 501);
  const untrusted = pki.issue("rejected-panel", "client", { issuer: "rogue-ca" });
  await assert.rejects(createAgentClient({ url: `https://${agentIP}:9443`, tls: { ...pki.client, ...untrusted }, timeout: 3000 }).lifecycle(authorized, "start"));
  if (provisioning) await assert.rejects(createAgentClient({ url: `https://${agentIP}:9443`, tls: { ...pki.client, ...untrusted }, timeout: 3000 }).provision({ profile: PROFILE.id, serverId: randomUUID(), name: "Invalid credentials" }));
  pki.policy("server-peers", [pki.panel.pin], [pki.panel.pin]);
  assert.equal((await request(`/servers/${authorized}/actions`, operator, "POST", { action: "start" })).status, 403);
  pki.policy("server-peers", [pki.panel.pin], [], provisioning ? [pki.panel.pin] : undefined);
  pki.policy("client-peers", [pki.agent.pin], [pki.agent.pin]);
  assert.equal((await request(`/servers/${authorized}/actions`, operator, "POST", { action: "start" })).status, 503);
  pki.policy("client-peers", [pki.agent.pin]);
  assert.equal(info(authorized).State.Running, false);
  t.diagnostic("Real Docker: authorized list/start/restart/stop PASS; foreign start/stop/restart 404; unassigned operator 404; bad/revoked client and revoked agent credentials rejected; legacy APIs 501.");
  if (process.env.GAMEPANEL_AGENT_BROWSER_TEST === "1") {
    const { chromium, expect } = require("@playwright/test");
    browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator("#authView"), `Temporary browser navigation failed: ${(await page.locator("body").innerText()).slice(0, 240)}`).toBeVisible({ timeout: 3000 });
    await page.getByLabel("Username", { exact: true }).fill("admin"); await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agent servers", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator("article").getByText("running", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator("article").getByText("exited", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (provisioning) {
      await page.getByLabel("Server name", { exact: true }).fill("Delete UI fixture");
      await page.getByRole("button", { name: "Create Server", exact: true }).click();
      const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Delete UI fixture", exact: true }) });
      await expect(card).toBeVisible();
      const second = (await request("/servers", admin)).body.servers.find((s) => s.name === "Delete UI fixture"); containers.push(second.id);
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Delete Server and Data", exact: true }).click();
      await expect(card).toHaveCount(0);
      assert.equal((await request("/servers", admin)).body.servers.length, 1);
    }
    docker(["stop", "--time", "2", agent]);
    await page.locator("#refreshButton").click();
    await expect(page.getByRole("alert")).toContainText("Game agent unavailable", { timeout: 7500 });
    assert.deepEqual(errors, []);
    await browser.close(); browser = null;
    t.diagnostic("Chromium: cookie login, dashboard lifecycle, mobile-sized layout and friendly disconnected-agent error PASS.");
  } else docker(["stop", "--time", "2", agent]);
  const stateBefore = docker(["exec", "--user", "1000:1000", panel, "cat", "/data/state.json"]);
  const disconnected = (await request("/status", admin)).body;
  assert.equal(disconnected.ok, false); assert.match(disconnected.error, /agent unavailable/); assert.ok(!disconnected.error.includes(pki.dir));
  if (provisioning) assert.equal((await request("/servers", admin, "POST", { profile: PROFILE.id, name: "Disconnected" })).status, 503);
  docker(["restart", panel]); await ready();
  assert.equal((await request("/servers", admin)).status, 401);
  admin = await login("admin", password);
  assert.equal((await request("/users", admin)).body.users.length, 3);
  assert.equal(docker(["exec", "--user", "1000:1000", panel, "cat", "/data/state.json"]), stateBefore);
  if (provisioning) {
    docker(["start", agent]);
    for (let n = 0; n < 30; n++) { if ((await request("/status", admin)).body.ok) break; await delay(100); }
    assert.equal((await request("/servers", admin)).body.servers[0].id, authorized, "agent and panel restarts preserve exact identity");
    assert.equal((await request(`/servers/${authorized}`, admin, "DELETE", { confirm: "wrong" })).status, 400);
    fs.writeFileSync(path.join(ownedPath, "disposable-marker"), "owned test data");
    assert.equal((await request(`/servers/${authorized}`, admin, "DELETE", { confirm: authorized })).status, 200);
    assert.equal(fs.existsSync(ownedPath), false);
    assert.deepEqual((await request("/servers", admin)).body.servers, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, "registry.json"))).servers[logicalId].phase, "deleted");
    t.diagnostic("Create/delete permission checks, confirmed UI deletion, disconnected create denial, exact identity after agent/panel restarts and explicit scoped data deletion PASS.");
  }
  assert.equal(JSON.stringify(info(foreign)), foreignBefore);
  assert.equal(service(), beforeService); assert.deepEqual(monitored.map(digestTree), beforeFiles);
  t.diagnostic("Disconnected panel restart: accounts and state retained; old session revoked; unrelated fixture and existing development service unchanged.");
});
