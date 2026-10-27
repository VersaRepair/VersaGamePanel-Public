"use strict";

const state = {
  me: null,
  backend: "docker",
  agentError: "",
  agentProvisioning: false,
  realm: localStorage.getItem("gamepanel-realm") || "minecraft",
  page: localStorage.getItem("gamepanel-page") || "server",
  createEdition: localStorage.getItem("gamepanel-create-edition") || "java",
  selectedByRealm: JSON.parse(localStorage.getItem("gamepanel-selected") || "{}"),
  filePath: "",
  expandedHelp: "",
  creatingRealm: "",
  templates: [],
  servers: [],
  users: [],
  docker: { images: [], containers: [] },
  socket: null,
  streamRequest: 0
};
// Upgrade from the recovered browser credential scheme without retaining it.
localStorage.removeItem("gamepanel-token");

const $ = (id) => document.getElementById(id);
const els = {
  authView: $("authView"),
  appView: $("appView"),
  authForm: $("authForm"),
  usernameInput: $("usernameInput"),
  passwordInput: $("passwordInput"),
  authMessage: $("authMessage"),
  statusLine: $("statusLine"),
  realmTabs: $("realmTabs"),
  mainLayout: $("mainLayout"),
  refreshButton: $("refreshButton"),
  logoutButton: $("logoutButton"),
  themeToggle: $("themeToggle"),
  themeLabel: $("themeLabel")
};

const realms = [
  { id: "minecraft", label: "Minecraft Realm" },
  { id: "steam", label: "Steam Realm" },
  { id: "other", label: "Other Realm" },
  { id: "docker", label: "Docker", adminOnly: true },
  { id: "users", label: "Users", adminOnly: true }
];

function isAdmin() {
  return state.me?.role === "admin";
}

function visibleRealms() {
  if (state.backend === "agent") return [{ id: "agent", label: "Agent Servers" }, ...(isAdmin() ? [{ id: "users", label: "Users" }] : [])];
  return realms.filter((realm) => !realm.adminOnly || isAdmin());
}

const minecraftPages = [
  ["server", "Server"],
  ["options", "Options"],
  ["console", "Console"],
  ["log", "Log"],
  ["players", "Players"],
  ["software", "Software"],
  ["mods", "Mods"],
  ["files", "Files"],
  ["worlds", "Worlds"],
  ["backups", "Backups"],
  ["access", "Access"]
];

const minecraftCreateEditions = [
  {
    id: "java",
    label: "Minecraft: Java Edition",
    title: "new-java.local",
    description: "Choose Java software, modloaders, and packs.",
    templateIds: ["minecraft-paper", "minecraft-modrinth", "minecraft-curseforge"]
  },
  {
    id: "bedrock",
    label: "Minecraft: Bedrock Edition",
    title: "new-bedrock.local",
    description: "Create a Bedrock dedicated server.",
    templateIds: ["minecraft-bedrock"]
  },
  {
    id: "hytale",
    label: "Hytale",
    title: "hytale.local",
    description: "Reserved for Hytale once server hosting exists.",
    templateIds: []
  }
];

const helpCards = {
  server: [
    ["Connect to your server", "Copy the address from the server page, add it in Minecraft Multiplayer, and start the server before joining.", ["Start the server and wait for Online.", "Copy the address shown on the Server page.", "Use Direct Connection in Minecraft with that address and port."]],
    ["Fix server starting problems", "If a server starts then stops, open the log page first. Most modpack and version errors are obvious there.", ["Open Log and look at the last red/error lines.", "Check EULA, memory, Minecraft version, and modloader choice.", "Save Options, then use Restart after correcting the setting."]],
    ["Queue", "Local hosting skips public queues, but startup can still take a while while Docker downloads images or installs a modloader.", ["First startup may pull a Docker image or install server jars.", "Keep the Console open while it downloads.", "After the first successful boot, later starts should be much faster."]]
  ],
  options: [
    ["The options of your server explained", "Most Minecraft options are saved before startup. Some changes require a restart to affect the live server.", ["Use toggles for TRUE/FALSE server properties.", "Version, memory, MOTD, world name, and seed are written into the container env.", "Restart after changing anything that Minecraft only reads at boot."]],
    ["Reinstall your server", "Use recreate only when you want the container rebuilt. Your data directory is kept unless you delete files manually.", ["Stop the server before heavy changes.", "Change software/version first, then save.", "Restart rebuilds the runtime while keeping the mounted server data."]],
    ["Resource packs", "Upload resource packs as files, then set the resource-pack URL or prompt here when your server type supports it.", ["Upload the pack through Files or host it somewhere reachable.", "Set the resource pack URL in Options when that field is added.", "Restart, then test with one client before inviting everyone."]]
  ],
  worlds: [
    ["Upload a world", "Upload a ZIP or a folder containing level.dat. The panel backs up the old world before replacing it.", ["Stop the server if it is actively saving chunks.", "Upload a ZIP or folder that contains level.dat.", "The old world is backed up before the uploaded world replaces it."]],
    ["World option: Optimize", "Local optimization is a later feature. For now, keep world backups before major modpack or version changes.", ["Create a backup before changing Minecraft versions.", "Use the server console for vanilla optimize commands when available.", "Keep an older backup until players have tested the upgraded world."]],
    ["Download your world", "Download creates a ZIP of the current world directory from the server data folder.", ["Use Download on the Worlds page.", "The panel zips the active world folder.", "Store the ZIP somewhere outside the server before major experiments."]]
  ],
  files: [
    ["Installing Datapacks", "Open the world folder, then drop datapacks into datapacks. Restart or run /reload after changes.", ["Open the current world folder.", "Upload datapacks into the datapacks directory.", "Restart or run reload from Console."]],
    ["Installing addons", "Bedrock packs can be uploaded through Files, then activated from the relevant Bedrock config files.", ["Upload behavior/resource packs into the Bedrock data folder.", "Edit the world pack JSON files when needed.", "Restart Bedrock after changing pack activation."]],
    ["Uploading files", "This panel allows direct file uploads because it is your own host, unlike locked-down free hosts.", ["Open the target folder first.", "Use Upload for one or many files.", "Delete only after a backup if the file belongs to a live world."]]
  ],
  players: [
    ["Unban a player", "Use the console command /pardon name or edit the banned players file if the server is offline.", ["Open Console while the server is running.", "Run pardon username or pardon-ip address.", "If offline, edit the banned players file from Files carefully."]],
    ["Change your Gamemode", "Use /gamemode in Console for live changes, or set the default gamemode in Options.", ["Use gamemode creative username for a live player.", "Change the default mode in Options for future joins.", "Restart only when changing server.properties defaults."]],
    ["Delete player data", "Stop the server first, then remove the player data file from the world folder.", ["Stop the server to avoid save races.", "Find the player's UUID file under playerdata.", "Move it into a backup folder before deleting for real."]]
  ],
  backups: [
    ["Creating and restoring backups", "Manual backups are stored as ZIP files under the panel data directory.", ["Create Backup before modpack or world changes.", "Download important snapshots off the server.", "Restore backs up the current world before replacing it."]],
    ["Keep your world safe", "The panel also creates backups before world upload, world generate, and backup restore operations.", ["World uploads create a pre-replace backup.", "Fresh world generation creates a pre-generate backup.", "Backup restores create a pre-restore backup."]],
    ["Download your world", "Use Worlds for the current world, or Backups for older snapshots.", ["Use Worlds to download the active world.", "Use Backups to download a named old snapshot.", "Keep one known-good copy before risky server updates."]]
  ],
  access: [
    ["Share access", "Admins can create users and assign exactly which servers an operator can see.", ["Open Users from the top tabs.", "Create an operator account for someone who should manage game servers.", "Assign only the servers they should see, or let them create their own."]],
    ["Connect to your server", "Give friends the server address and port shown on the Server page.", ["Copy the server address from Server.", "Use playit or LAN routing for friends outside the house.", "Match the protocol and port for each game server."]],
    ["Unban a player", "Player actions still happen through Console or the Players page commands.", ["Use Players for common commands.", "Use Console for anything custom.", "Keep bans/whitelists backed up before bulk edits."]]
  ],
  console: [
    ["Send commands", "Console connects to the live server input when the server supports it.", ["Start the server first.", "Type commands without a leading slash unless the server expects it.", "Look for the Sent marker and then watch the console output."]],
    ["Watch startup", "Startup output is the fastest way to catch missing files, bad versions, or memory problems.", ["Open Console before pressing Start when testing new configs.", "Let downloads finish before restarting.", "If output stops after an error, switch to Log for the full tail."]],
    ["Safe commands", "Use save, list, whitelist, op, pardon, and stop carefully because they affect live players.", ["Run save before backups or file edits.", "Prefer restart from the panel instead of stop from the console.", "Avoid destructive commands unless the world is backed up."]]
  ],
  log: [
    ["Read the latest log", "Log tails the server output so you can diagnose crashes without SSH.", ["Open Log after a failed start.", "Scroll to the bottom for the newest error.", "Search the exact error text when a mod or plugin names itself."]],
    ["Crash loops", "Repeated starts and stops usually mean a config, mod, version, or EULA problem.", ["Check EULA first for Minecraft templates.", "Check memory and Minecraft version next.", "Remove the last added mod/plugin if the error names it."]],
    ["When to restart", "Restart after config changes, software changes, or world replacement.", ["Save options before restarting.", "Wait for the server to fully stop.", "Open Log again after restart to confirm a clean boot."]]
  ]
};

const softwareTiles = [
  { type: "VANILLA", label: "Vanilla", templateId: "minecraft-paper", hint: "Java Edition" },
  { type: "PAPER", label: "Paper/Bukkit", templateId: "minecraft-paper", hint: "For plugins" },
  { type: "SPIGOT", label: "Spigot/Bukkit", templateId: "minecraft-paper", hint: "For plugins" },
  { type: "PURPUR", label: "Purpur/Bukkit", templateId: "minecraft-paper", hint: "For plugins" },
  { type: "FABRIC", label: "Fabric", templateId: "minecraft-paper", hint: "For mods" },
  { type: "QUILT", label: "Quilt", templateId: "minecraft-paper", hint: "For mods" },
  { type: "NEOFORGE", label: "NeoForge", templateId: "minecraft-paper", hint: "For mods" },
  { type: "FORGE", label: "Forge", templateId: "minecraft-paper", hint: "For mods" },
  { type: "MODRINTH", label: "Modrinth Pack", templateId: "minecraft-modrinth", hint: "Modpacks" },
  { type: "AUTO_CURSEFORGE", label: "CurseForge Pack", templateId: "minecraft-curseforge", hint: "Modpacks" },
  { type: "BEDROCK", label: "Bedrock", templateId: "minecraft-bedrock", hint: "Bedrock Edition" }
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function bytes(value = 0) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value) || 0;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let payload = {};
  if (contentType.includes("application/json") && text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw new Error(`Server returned invalid JSON (${response.status}).`);
    }
  } else if (text) {
    payload = { message: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220) };
  }
  if (response.status === 401) {
    showAuth();
    throw new Error(payload.error || payload.message || "Unauthorized");
  }
  if (!response.ok) throw new Error(payload.error || payload.message || response.statusText);
  return payload;
}

function authedUrl(path) {
  return path; // Same-origin HttpOnly cookie; no credentials in URLs.
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("gamepanel-theme", theme);
  els.themeToggle.checked = theme === "dark";
  els.themeLabel.textContent = theme === "dark" ? "Dark" : "Light";
}

function showAuth() {
  closeSocket();
  els.authView.hidden = false;
  els.appView.hidden = true;
}

function showApp() {
  els.authView.hidden = true;
  els.appView.hidden = false;
}

function templateById(id) {
  return state.templates.find((template) => template.id === id) || state.templates[0];
}

function realmForTemplate(template) {
  if (!template) return "other";
  if (template.family === "Minecraft") return "minecraft";
  if (["Steam", "Imported", "Co-op"].includes(template.family)) return "steam";
  return "other";
}

function realmForServer(server) {
  if (state.backend === "agent") return "agent";
  return realmForTemplate(templateById(server.templateId));
}

function selectedServer() {
  const id = state.selectedByRealm[state.realm];
  return state.servers.find((server) => server.id === id && realmForServer(server) === state.realm) || serversInRealm(state.realm)[0] || null;
}

function serversInRealm(realm) {
  return state.servers.filter((server) => realmForServer(server) === realm);
}

function templatesInRealm(realm) {
  return state.templates.filter((template) => realmForTemplate(template) === realm);
}

function canCreateTemplate(template) {
  if (isAdmin()) return true;
  if (!template || template.runtimeKind === "systemd" || template.native) return false;
  if (["Custom", "Imported"].includes(template.family)) return false;
  return true;
}

function creatableTemplatesInRealm(realm) {
  return templatesInRealm(realm).filter(canCreateTemplate);
}

function saveUiState() {
  localStorage.setItem("gamepanel-realm", state.realm);
  localStorage.setItem("gamepanel-page", state.page);
  localStorage.setItem("gamepanel-create-edition", state.createEdition);
  localStorage.setItem("gamepanel-selected", JSON.stringify(state.selectedByRealm));
}

async function refresh({ keepPage = true } = {}) {
  const [mePayload, templatesPayload, statusPayload, serversPayload] = await Promise.all([
    api("/api/auth/me"),
    api("/api/templates"),
    api("/api/status"),
    api("/api/servers")
  ]);
  state.me = mePayload.user;
  state.templates = templatesPayload.templates;
  state.servers = serversPayload.servers;
  state.backend = statusPayload.backend || "docker";
  state.agentError = serversPayload.error || statusPayload.error || "";
  state.agentProvisioning = statusPayload.provisioning === true;
  state.agentProfiles = statusPayload.profiles || [];
  state.agentGameProfiles = statusPayload.gameProfiles || {};
  state.release = statusPayload.release || "private development";
  state.docker = isAdmin() && state.backend !== "agent" ? await api("/api/docker") : { images: [], containers: [], dataDir: statusPayload.dataDir, docker: statusPayload.docker };
  state.users = isAdmin() ? (await api("/api/users")).users : [];
  if (!visibleRealms().some((realm) => realm.id === state.realm)) state.realm = state.backend === "agent" ? "agent" : "minecraft";
  for (const realm of visibleRealms()) {
    if (["docker", "users"].includes(realm.id)) continue;
    if (!state.selectedByRealm[realm.id] || !state.servers.some((server) => server.id === state.selectedByRealm[realm.id])) {
      const first = serversInRealm(realm.id)[0];
      if (first) state.selectedByRealm[realm.id] = first.id;
    }
  }
  if (!keepPage) state.page = "server";
  els.statusLine.textContent = state.backend === "agent" ? state.agentError || `Authenticated agent; ${state.servers.length} authorized servers` : statusPayload.ok ? `Docker ${statusPayload.docker}; ${state.servers.length} configured` : "Docker unavailable";
  saveUiState();
  render();
}

function renderRealmTabs() {
  els.realmTabs.innerHTML = visibleRealms().map((realm) => {
    const count = realm.id === "docker" ? (state.docker?.images || []).length : realm.id === "users" ? state.users.length : serversInRealm(realm.id).length;
    return `<button class="realm-tab ${state.realm === realm.id ? "active" : ""}" data-action="realm" data-realm="${realm.id}" type="button">${realm.label}<span>${count}</span></button>`;
  }).join("");
}

function render() {
  closeSocket();
  renderRealmTabs();
  const server = selectedServer();
  if (server && state.creatingRealm !== state.realm) state.selectedByRealm[state.realm] = server.id;
  if (state.backend === "agent" && state.realm !== "users") renderAgentDashboard();
  else if (state.realm === "docker" && isAdmin()) renderDockerMaintenance();
  else if (state.realm === "users" && isAdmin()) renderUsersAdmin();
  else if (state.realm === "minecraft") renderMinecraftRealm(server);
  else renderGenericRealm(server);
  saveUiState();
}

function renderAgentDashboard() {
  els.mainLayout.className = "main-layout generic-layout";
  els.mainLayout.innerHTML = `<section class="panel generic-editor"><h1>Agent servers</h1>
    <p><strong>Developer prerelease ${escapeHtml(state.release)}</strong> — private authenticated agent; no panel Docker access. Only installed pinned game profiles are offered. tModLoader is withheld pending a vulnerability-free supported upstream bundle. Advanced settings, mods/file management and in-app backups remain legacy-only.</p>
    ${state.agentError ? `<p role="alert">${escapeHtml(state.agentError)}</p>` : ""}
    ${isAdmin() && state.agentProvisioning ? `<form id="agentCreateForm" class="create-card"><h2>Create Server</h2><p>Fixed limits. Creating does not start it. Fixed presets: Minecraft 3 GiB, Terraria 2 GiB, Unturned 6 GiB; 8 players. Unturned first start installs Valve app 1110390 anonymously into its own storage.</p><label>Server name<input name="name" required maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9 _-]*" autocomplete="off" /></label><label>Server profile<select name="profile" aria-label="Server profile">${(state.agentProfiles.length ? state.agentProfiles : ["alpine-smoke-v1", "alpine-console-v1"]).map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(state.agentGameProfiles[p]?.title || (p === "alpine-console-v1" ? "Alpine console fixture (test only)" : "Alpine smoke (test only)"))}</option>`).join("")}</select></label><label>Game port<input name="port" type="number" value="25565" min="25565" max="25572" /></label><label><input type="checkbox" name="eula" />For the selected game, I accept its publisher terms (including the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noopener noreferrer">Minecraft EULA</a> where applicable).</label><button type="submit">Create Server</button></form>` : ""}
    ${state.servers.map((server) => `<article class="create-card"><h2>${escapeHtml(server.name)}</h2><p><span>${escapeHtml(server.runtime.status)}</span> · ${escapeHtml(server.profile || "managed server")}${server.connection ? ` · Direct: ${escapeHtml(server.connection.address)}:${server.connection.port}` : ""}</p>
      <div class="button-row">${["start", "stop", "restart"].map((action) => `<button type="button" data-action="agent-lifecycle" data-id="${server.id}" data-operation="${action}">${action[0].toUpperCase() + action.slice(1)}</button>`).join("")}<button type="button" data-action="agent-stream" data-id="${server.id}" data-mode="logs">Logs</button><button type="button" data-action="agent-stream" data-id="${server.id}" data-mode="console" ${server.console && server.runtime.running ? "" : "disabled"}>Console</button>${isAdmin() && (server.disposable || server.managed) ? `<button type="button" data-action="agent-delete" data-id="${server.id}" ${server.runtime.running ? "disabled" : ""}>Delete Server and Data</button>` : ""}</div></article>`).join("") || "<p>No authorized agent servers available.</p>"}
      <section aria-label="Agent logs and console"><h2>Logs and console</h2><p>Log sessions are bounded; reconnect for recent output. Minecraft: list, seed, save-all flush, say message. Terraria: save, playing, version. Unturned: Save, Players. Test fixture: ping, status, help. Other commands are blocked.</p><pre id="terminal" role="log" aria-live="polite" tabindex="0" style="max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">Choose Logs or Console on a server.</pre><form id="agentCommandForm"><label>Console command<input name="command" maxlength="124" autocomplete="off" /></label><button type="submit" disabled>Send command</button></form><button type="button" data-action="agent-disconnect">Disconnect stream</button></section></section>`;
}

function serverStatus(server) {
  const runtime = server?.runtime || {};
  return runtime.running ? "Online" : runtime.exists ? runtime.status || "Stopped" : "Not created";
}

function addressFor(server) {
  return server?.endpoints?.[0]?.joinAddress || "Connection address not configured";
}

function renderDirectConnection(server) {
  if (server.managementBlocked) return `<p class="notice">${escapeHtml(server.managementBlocked)}</p>`;
  return `<form id="directConnectionForm" class="create-card">
    <h2>Direct Connection</h2>
    <p>Game networking only. No router rules, tunnels, or public administration access are created. Reachability is not verified.</p>
    <label>Advertised IP address or hostname<input name="advertisedHost" value="${escapeHtml(server.connectivity?.advertisedHost || "")}" placeholder="Leave blank until configured" /></label>
    <p>${(server.endpoints || []).map((endpoint) => escapeHtml(`${endpoint.label}: ${endpoint.bindAddress}:${endpoint.hostPort}/${endpoint.protocol}`)).join("<br>") || "No game ports declared."}</p>
    ${isAdmin() ? `<details><summary>Advanced listener and resource settings</summary>
      <p>Listener and resource changes apply on the next restart. Localhost bindings are local-only; an advertised address does not make them public.</p>
      <label>Network mode<select name="networkMode"><option value="bridge" ${server.networkMode === "bridge" ? "selected" : ""}>Bridge (isolated)</option><option value="none" ${server.networkMode === "none" ? "selected" : ""}>No network</option>${server.networkMode === "host" ? '<option value="host" selected>Legacy host network (not isolated)</option>' : ""}</select></label>
      ${(server.ports || []).map((port, index) => `<fieldset><legend>${escapeHtml(port.label || "Game")} → ${escapeHtml(port.container)}/${escapeHtml(port.protocol || "tcp")}</legend><label>Bind IP<input name="bind-${index}" value="${escapeHtml(port.bindAddress || "127.0.0.1")}" required /></label><label>Host port<input name="port-${index}" type="number" min="1024" max="65535" value="${escapeHtml(port.host)}" required /></label></fieldset>`).join("")}
      <label>CPU limit<input name="cpus" type="number" min="0.25" max="64" step="0.25" value="${escapeHtml(server.resources?.cpus ?? 2)}" required /></label>
      <label>Container memory limit (MiB; leave room above Java heap)<input name="memoryMiB" type="number" min="128" max="262144" value="${escapeHtml(server.resources?.memoryMiB ?? 3072)}" required /></label>
    </details>` : ""}
    <button type="submit">Save connection address</button>
  </form>`;
}

function isDockerServer(server) {
  return server?.runtimeKind !== "systemd";
}

function dataPathFor(server) {
  if (!isDockerServer(server)) return server.dataRoot || server.native?.dataRoot || server.dataMount || server.native?.workingDirectory || "Native system path";
  const dataDir = state.docker?.dataDir || "/opt/gamepanel-data";
  return `${dataDir}/servers/${server.id}`;
}

function isManagedNativeData(server) {
  if (isDockerServer(server)) return true;
  return false;
}

function restartPolicyFor(server) {
  if (!isDockerServer(server)) return server.runtime?.enabled || (server.autoStart ? "enabled" : "disabled");
  if (server.runtime?.exists) return server.runtime.restartPolicy || "no";
  return server.autoStart ? "unless-stopped after first start" : "off";
}

function renderLifecyclePanel(server) {
  if (server.managementBlocked) return `<p class="notice">${escapeHtml(server.managementBlocked)} Original metadata and external files are preserved.</p>`;
  const docker = isDockerServer(server);
  const dataLabel = docker ? "Persistent bind mount" : "Native service files";
  const deleteFiles = isManagedNativeData(server)
    ? `<button data-action="delete-with-files" class="danger" type="button">Delete + Files</button>`
    : `<button disabled title="Native files are not managed by GamePanel." type="button">Delete + Files</button>`;
  return `
    <section class="lifecycle-panel">
      <div class="panel-heading">
        <h2>Lifecycle</h2>
        <span>${escapeHtml(docker ? "Docker managed" : "Systemd managed")}</span>
      </div>
      <div class="lifecycle-grid">
        <div><span>Autostart</span><strong>${server.autoStart ? "On" : "Off"}</strong><small>${escapeHtml(restartPolicyFor(server))}</small></div>
        <div><span>Runtime</span><strong>${escapeHtml(server.runtime?.name || server.id)}</strong><small>${escapeHtml(serverStatus(server))}</small></div>
        <div><span>${dataLabel}</span><strong>${escapeHtml(dataPathFor(server))}</strong><small>Files stay here across reboots and container recreation.</small></div>
      </div>
      <div class="button-row lifecycle-actions">
        <button data-action="toggle-autostart" type="button">${server.autoStart ? "Disable Autostart" : "Enable Autostart"}</button>
        ${docker ? `<button data-action="pull" type="button">Pull Image</button><button data-action="remove-container" type="button">Remove Container</button>` : ""}
        <button data-action="delete" class="danger" type="button">Delete Record</button>
        ${deleteFiles}
      </div>
    </section>
  `;
}

function renderMinecraftRealm(server) {
  const servers = serversInRealm("minecraft");
  const creating = state.creatingRealm === "minecraft" || !server;
  const page = minecraftPages.some(([id]) => id === state.page) ? state.page : "server";
  state.page = page;
  els.mainLayout.className = "main-layout minecraft-layout";
  els.mainLayout.innerHTML = `
    <aside class="mc-sidebar">
      <div class="mc-sidebar-head">
        <div>
          <strong>Minecraft Servers</strong>
          <small>${servers.length} configured</small>
        </div>
        <button data-action="new-server" type="button">${creating && server ? "Cancel" : "New"}</button>
      </div>
      <div class="mc-server-list">
        ${servers.map((item) => `
          <button class="mc-server-tile ${server?.id === item.id && !creating ? "active" : ""}" data-action="select" data-id="${item.id}" type="button">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(addressFor(item))}</small>
            <span class="status-pill ${item.runtime?.running ? "online" : "offline"}">${escapeHtml(serverStatus(item))}</span>
          </button>
        `).join("") || `<p class="muted pad">No Minecraft servers yet.</p>`}
      </div>
      ${creating ? "" : `
        <nav class="mc-nav">
          ${minecraftPages.map(([id, label]) => `<button class="${page === id ? "active" : ""}" data-action="mc-page" data-page="${id}" type="button">${label}</button>`).join("")}
        </nav>
      `}
    </aside>
    <section class="mc-content">
      ${creating ? renderMinecraftCreate(Boolean(server)) : renderMinecraftPage(server, page)}
    </section>
  `;
  if (!creating) afterRenderMinecraft(server, page);
}

function renderMinecraftCreate(canCancel = false) {
  const edition = minecraftCreateEditions.find((item) => item.id === state.createEdition) || minecraftCreateEditions[0];
  state.createEdition = edition.id;
  const editionTemplates = edition.templateIds
    .map((id) => templateById(id))
    .filter((template) => template && canCreateTemplate(template));
  const cancel = canCancel ? `<button data-action="cancel-create" type="button">Cancel</button>` : "";
  return `
    <section class="create-server inline-create">
      <div class="create-heading"><h1>Create a Server</h1>${cancel}</div>
      <div class="create-card">
        <div class="create-tabs" role="tablist" aria-label="Minecraft editions">
          ${minecraftCreateEditions.map((item) => `
            <button class="${edition.id === item.id ? "active" : ""}" data-action="create-edition" data-edition="${item.id}" type="button" role="tab" aria-selected="${edition.id === item.id ? "true" : "false"}">${escapeHtml(item.label)}</button>
          `).join("")}
        </div>
        <div class="minecraft-banner">
          <div class="mc-avatar">GP</div>
          <div><strong>${escapeHtml(edition.title)}</strong><span>${escapeHtml(edition.description)}</span></div>
        </div>
      </div>
      <div class="blueprints">
        <div class="section-heading">Blueprints</div>
        <div class="software-grid">
          ${editionTemplates.map((template) => `
            <button class="software-tile blueprint-tile" data-action="create-template" data-template="${template.id}" type="button">
              <span class="tile-icon">+</span>
              <strong>${escapeHtml(template.name)}</strong>
              <small>${escapeHtml(template.subtitle)}</small>
            </button>
          `).join("") || `<div class="empty-blueprints"><strong>No server template yet.</strong><span>This edition is parked here so the realm layout is ready when a real dedicated server exists.</span></div>`}
        </div>
      </div>
    </section>
  `;
}

function renderMinecraftPage(server, page) {
  if (page === "server") return renderMcServer(server);
  if (page === "options") return renderMcOptions(server);
  if (page === "software") return renderMcSoftware(server);
  if (page === "mods") return renderMcMods(server);
  if (page === "worlds") return renderMcWorlds(server);
  if (page === "files") return renderMcFiles(server);
  if (page === "backups") return renderMcBackups(server);
  if (page === "console") return renderMcTerminal(server, "console");
  if (page === "log") return renderMcTerminal(server, "logs");
  if (page === "players") return renderMcPlayers(server);
  if (page === "access") return renderMcAccess(server);
  return renderMcServer(server);
}

function renderMcServer(server) {
  const running = Boolean(server.runtime?.running);
  return `
    <div class="mc-hero">
      <h1>${escapeHtml(addressFor(server))}</h1>
      <button data-action="${running ? "stop" : "start"}" class="${running ? "danger-button" : "start-big"}" type="button">${running ? "Stop" : "Start"}</button>
    </div>
    <div class="status-bar ${running ? "online" : "offline"}">${running ? "Online" : "Offline"}</div>
    <div class="server-dashboard">
      <div class="empty-preview"></div>
      <div class="server-facts">
        <div class="fact-row"><span>Address</span><strong>${escapeHtml(addressFor(server))}</strong><button data-copy="${escapeHtml(addressFor(server))}" type="button">Copy</button></div>
        <div class="fact-row"><span>Software</span><strong>${escapeHtml(server.env?.TYPE || templateById(server.templateId)?.name || "Minecraft")}</strong><button data-action="mc-page" data-page="software" type="button">Change</button></div>
        <div class="fact-row"><span>Version</span><strong>${escapeHtml(server.env?.VERSION || "LATEST")}</strong><button data-action="mc-page" data-page="options" type="button">Change</button></div>
        <div class="fact-row"><span>Updates</span><strong>Manual; review and back up first</strong></div>
      </div>
    </div>
    ${renderLifecyclePanel(server)}
    ${renderDirectConnection(server)}
    ${renderHelpCards("server")}
  `;
}

function optionField(key, label, control, value = "") {
  return `<label class="aternos-field"><span>${escapeHtml(label)}</span>${control}<small>${escapeHtml(key.toLowerCase().replaceAll("_", "-"))}=${escapeHtml(value)}</small></label>`;
}

function renderMcOptions(server) {
  const env = server.env || {};
  const standard = new Set(["TYPE", "VERSION", "MEMORY", "MAX_PLAYERS", "MODE", "DIFFICULTY", "ENABLE_WHITELIST", "ONLINE_MODE", "ALLOW_FLIGHT", "FORCE_GAMEMODE", "PVP", "VIEW_DISTANCE", "LEVEL", "MOTD", "SEED", "EULA"]);
  const extra = (templateById(server.templateId)?.fields || []).filter((field) => !standard.has(field.key));
  const bool = (key) => ["TRUE", "true", "1", true].includes(env[key]);
  const property = (key) => env[key] ?? "";
  const select = (key, options) => `<select data-env="${key}">${options.map((value) => `<option value="${value}" ${String(env[key] || "").toLowerCase() === String(value).toLowerCase() ? "selected" : ""}>${value}</option>`).join("")}</select>`;
  const input = (key, type = "text", placeholder = "", fallback = "") => `<input data-env="${key}" type="${type}" value="${escapeHtml(env[key] ?? fallback)}" ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ""} />`;
  const toggle = (key) => `<button class="toggle-button ${bool(key) ? "on" : "off"}" data-toggle-env="${key}" type="button">${bool(key) ? "ON" : "OFF"}</button>`;
  return `
    <h1>Options</h1>
    <div class="minecraft-banner compact"><div class="mc-avatar">GP</div><div><strong>${escapeHtml(server.name)}</strong><span>${escapeHtml(env.MOTD || "Welcome to the server")}</span></div></div>
    <form id="mcOptionsForm" class="aternos-options">
      <div class="section-heading">runtime</div>
      <div class="option-grid">
        ${optionField("VERSION", "Version", input("VERSION", "text", "LATEST, SNAPSHOT, or exact version", "LATEST"), property("VERSION") || "LATEST")}
        ${optionField("MEMORY", "Memory", input("MEMORY"), property("MEMORY"))}
      </div>
      <div class="section-heading">server.properties</div>
      <div class="option-grid">
        ${optionField("MAX_PLAYERS", "Slots", input("MAX_PLAYERS", "number"), property("MAX_PLAYERS"))}
        ${optionField("MODE", "Gamemode", select("MODE", ["survival", "creative", "adventure", "spectator"]), property("MODE"))}
        ${optionField("DIFFICULTY", "Difficulty", select("DIFFICULTY", ["peaceful", "easy", "normal", "hard"]), property("DIFFICULTY"))}
        ${optionField("ENABLE_WHITELIST", "Whitelist", toggle("ENABLE_WHITELIST"), property("ENABLE_WHITELIST"))}
        ${optionField("ONLINE_MODE", "Online Mode", toggle("ONLINE_MODE"), property("ONLINE_MODE"))}
        ${optionField("ALLOW_FLIGHT", "Fly", toggle("ALLOW_FLIGHT"), property("ALLOW_FLIGHT"))}
        ${optionField("FORCE_GAMEMODE", "Force Gamemode", toggle("FORCE_GAMEMODE"), property("FORCE_GAMEMODE"))}
        ${optionField("PVP", "PVP", toggle("PVP"), property("PVP"))}
        ${optionField("VIEW_DISTANCE", "View Distance", input("VIEW_DISTANCE", "number"), property("VIEW_DISTANCE"))}
        ${optionField("LEVEL", "World Name", input("LEVEL"), property("LEVEL"))}
        ${optionField("MOTD", "MOTD", input("MOTD"), property("MOTD"))}
        ${optionField("SEED", "Seed", input("SEED"), property("SEED"))}
        ${optionField("EULA", "Accept EULA", toggle("EULA"), property("EULA"))}
      </div>
      ${extra.length ? `<div class="section-heading">Modpack / loader settings</div><p>Pack heap memory must fit the container limit. Download-source credentials and publisher terms still apply. Automatic pack downloads are separate from uploaded-JAR inspection.</p><div class="field-grid">${extra.map((field) => renderGenericField(field, env[field.key] ?? "")).join("")}</div>` : ""}
      <div class="button-row"><button type="submit">Save</button><button data-action="restart" type="button">Restart</button></div>
    </form>
    ${renderHelpCards("options")}
  `;
}

function renderMcSoftware(server) {
  const currentType = server.env?.TYPE || "";
  return `
    <h1>Software</h1>
    <div class="blueprints">
      <div class="section-heading">Blueprints</div>
      <div class="software-grid">
        ${softwareTiles.map((tile) => `
          <button class="software-tile ${currentType === tile.type ? "active" : ""}" data-action="software" data-type="${tile.type}" data-template="${tile.templateId}" type="button">
            <span class="tile-tag">${escapeHtml(tile.hint)}</span>
            <span class="tile-icon">${currentType === tile.type ? "OK" : tile.hint.includes("mod") ? "MOD" : "MC"}</span>
            <strong>${escapeHtml(tile.label)}</strong>
          </button>
        `).join("")}
      </div>
    </div>
    ${renderHelpCards("software")}
  `;
}

function renderMcWorlds(server) {
  return `
    <h1>Worlds</h1>
    <div class="world-panel">
      <div class="world-icon">WORLD</div>
      <div><strong>${escapeHtml(server.env?.LEVEL || server.env?.LEVEL_NAME || "world")}</strong><span>Current Minecraft world folder</span></div>
      <div class="world-actions">
        <input id="worldZipInput" type="file" accept=".zip" hidden />
        <input id="worldFolderInput" type="file" webkitdirectory multiple hidden />
        <button data-action="world-upload-zip" type="button">Upload ZIP</button>
        <button data-action="world-upload-folder" type="button">Upload Folder</button>
        <button data-action="mc-page" data-page="files" type="button">Files</button>
        <button data-action="world-generate" type="button">Generate</button>
        <a class="button-link" href="${authedUrl(`/api/servers/${server.id}/world/download`)}">Download</a>
      </div>
    </div>
    <div id="worldMessage" class="notice" hidden></div>
    ${renderHelpCards("worlds")}
  `;
}

function renderMcFiles(_server) {
  return `
    <h1>Files</h1>
    <div id="fileBrowser" class="file-browser">Loading files...</div>
    ${renderHelpCards("files")}
  `;
}

function renderMcMods(server) {
  if (server.templateId !== "minecraft-paper") return `<h1>Mods</h1><p>Direct custom JAR uploads use the Minecraft Java blueprint. For Modrinth/CurseForge packs use their existing Software settings. Bedrock addons are a separate format.</p>`;
  return `<h1>Mods and custom packs</h1><p>Inspect before installing. Reads declared loader, Minecraft and dependency metadata without executing mod code. It cannot guarantee runtime compatibility or detect malware.</p>
    <div id="modDropZone" class="mod-drop" tabindex="0" role="group" aria-label="Drop mod files or a mods folder here"><p>Drop your mods folder, JAR files, or a ZIP/MRPACK manifest here.</p><div class="button-row"><label class="button-like">Choose files<input id="modFilesInput" type="file" multiple accept=".jar,.zip,.mrpack" hidden /></label><label class="button-like">Choose mods folder<input id="modFolderInput" type="file" webkitdirectory multiple hidden /></label></div><p>Up to 256 files, 128 MiB each, 512 MiB combined. No downloads, code execution, installation or version changes during inspection.</p></div>
    <p>Custom JAR sets can be applied after review. Pack manifests are inspected only; their referenced downloads/overrides are not installed here. Existing worlds are never silently changed to another version or loader.</p><div id="modReport" aria-live="polite">Loading inspections…</div><div id="modBackups"></div>`;
}

async function loadModPlans(server) {
  const payload = await api(`/api/servers/${server.id}/mods/plans`);
  const root = $("modReport");
  if (!root) return;
  const backups = $("modBackups");
  if (backups) backups.innerHTML = `<h2>Prior mod sets and settings</h2><p>Download before making further changes. Archives are private and unencrypted. They contain prior mods/settings, not the world; world backups are separate. Restore an old set through a new inspected upload, and review its settings rather than silently downgrading a world.</p>${(payload.backups || []).map((backup) => `<p><a href="/api/servers/${server.id}/mods/backups/${backup.id}/download">Download prior set ${escapeHtml(new Date(backup.createdAt).toLocaleString())}</a></p>`).join("") || "<p>No previous mod sets yet.</p>"}`;
  root.innerHTML = payload.plans.map((plan) => `<article class="mod-plan"><h2>Inspection ${escapeHtml(new Date(plan.createdAt).toLocaleString())}</h2><p>${escapeHtml(plan.notice)}</p><p>Declared loader alternatives: ${escapeHtml(plan.compatibleLoaders.join(", ") || "unresolved / manifest only")}. Matching candidate releases: ${escapeHtml(plan.minecraft.candidates.join(", ") || "none identified; constraints may be incomplete or conflicting")}.</p><ul>${plan.files.map((file) => `<li>${escapeHtml(file.name)} <small>${escapeHtml(file.sha256 || "invalid archive")}</small></li>`).join("")}</ul><ul>${plan.issues.map((issue) => `<li>${escapeHtml(issue.severity.toUpperCase())}: ${escapeHtml(issue.file)} ${escapeHtml(issue.message)}</li>`).join("") || "<li>No declared conflicts detected in the inspected metadata. Runtime verification is still required.</li>"}</ul>
    ${plan.files.some((file) => file.mods.length) ? `<form class="mod-apply-form" data-mod-plan="${plan.id}"><label>Loader<select name="type">${["FABRIC", "QUILT", "FORGE", "NEOFORGE"].map((type) => `<option ${type === (plan.compatibleLoaders.length === 1 ? plan.compatibleLoaders[0] : plan.selected.type) ? "selected" : ""}>${type}</option>`).join("")}</select></label><label>Minecraft release<input name="version" value="${escapeHtml(!plan.minecraft.selectedMatches && plan.minecraft.candidates.length === 1 ? plan.minecraft.candidates[0] : plan.selected.version)}" required /></label><label><input name="confirm" type="checkbox" required /> Replace the entire mods set and apply this loader/version. Preserve backups and leave the server stopped.</label><label><input name="acceptWarnings" type="checkbox" /> I reviewed the warnings and understand unverified compatibility.</label><p>Stop the game and accept its EULA in Options first. Runtime changes to a populated world are blocked. Managed extra-mod downloads are disabled for this custom set.</p><button type="submit">Recheck and apply reviewed set</button></form>` : ""}<button data-action="mod-discard" data-plan="${plan.id}" type="button">Discard staged inspection</button></article>`).join("") || "<p>No staged inspections. Upload files to begin; existing servers and worlds are unchanged.</p>";
}

async function inspectMods(server, files) {
  if (!files.length || files.length > 256 || files.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 ** 2 || files.some((file) => file.size > 128 * 1024 ** 2)) throw new Error("Choose 1–256 files within the displayed size limits.");
  const form = new FormData();
  for (const file of files) form.append("files", file, file.modRelativePath || file.webkitRelativePath || file.name);
  showNotice("Inspecting metadata; game files will not be changed…");
  await api(`/api/servers/${server.id}/mods/inspect`, { method: "POST", body: form });
  await loadModPlans(server); showNotice("Inspection ready. Review the detected loader, versions, dependencies and limitations before applying.");
}

async function droppedMods(items) {
  const files = [];
  const entries = [...items].map((item) => item.webkitGetAsEntry?.() || item.getAsFile()).filter(Boolean);
  let visited = 0;
  async function walk(entry, prefix = "", depth = 0) {
    if (++visited > 2000 || depth > 16 || files.length >= 256) throw new Error("Choose a shallow folder containing at most 256 mod files.");
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      file.modRelativePath = prefix + file.name; files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`, depth + 1);
      }
    }
  }
  for (const entry of entries) { if (entry instanceof File) files.push(entry); else await walk(entry); }
  return files;
}

function renderMcBackups(_server) {
  return `
    <h1>Backups</h1>
    <div class="backup-panel">
      <div><strong>Backup your server</strong><p>Manual backups are ZIP snapshots of the current world folder.</p></div>
      <button data-action="backup-create" type="button">Create Backup</button>
    </div>
    <div id="backupList" class="backup-list">Loading backups...</div>
    ${renderHelpCards("backups")}
  `;
}

function renderMcTerminal(server, mode) {
  return `
    <h1>${mode === "logs" ? "Log" : "Console"}</h1>
    <div class="terminal-shell">
      <div class="terminal-head"><strong>${escapeHtml(server.name)}</strong><button data-action="open-${mode}" type="button">${mode === "logs" ? "Open Log" : "Connect Console"}</button></div>
      <pre id="terminal" class="terminal">Opening ${mode}...</pre>
      <form id="terminalForm" class="terminal-input">
        <span>&gt;</span>
        <input id="terminalInput" autocomplete="off" spellcheck="false" placeholder="command" />
        <button type="submit">Send</button>
      </form>
    </div>
    ${renderHelpCards(mode === "logs" ? "log" : "console")}
  `;
}

function renderMcPlayers() {
  return `
    <h1>Players</h1>
    <div class="player-actions">
      ${playerCommandCard("Whitelist", "whitelist add", "Minecraft username")}
      ${playerCommandCard("OPs", "op", "Minecraft username")}
      ${playerCommandCard("Banned players", "ban", "Minecraft username")}
      ${playerCommandCard("Banned IPs", "ban-ip", "IP address")}
    </div>
    <div id="playerMessage" class="notice" hidden></div>
    ${renderHelpCards("players")}
  `;
}

function playerCommandCard(title, command, placeholder) {
  return `<form class="player-card" data-player-command="${command}"><strong>${escapeHtml(title)}</strong><input placeholder="${escapeHtml(placeholder)}" /><button type="submit">Send</button></form>`;
}

function renderMcAccess(server) {
  if (!isAdmin()) {
    return `
      <h1>Access</h1>
      <div class="access-panel">
        <strong>${escapeHtml(state.me?.username || "Current user")}</strong>
        <p>You can see and manage this server because it is assigned to your account.</p>
      </div>
      ${renderHelpCards("access")}
    `;
  }
  const assigned = state.users.filter((user) => user.role === "admin" || (user.serverIds || []).includes(server.id));
  return `
    <h1>Access</h1>
    <div class="access-panel">
      <strong>Server access</strong>
      <p>Use the Users tab to add accounts and assign exactly which servers each operator can see.</p>
      <div class="access-list">
        ${assigned.map((user) => `<div class="access-row"><span>${escapeHtml(user.username)}</span><span>${escapeHtml(user.role)}</span></div>`).join("") || `<p class="muted">No users assigned yet.</p>`}
      </div>
      <button data-action="open-users" type="button">Open Users</button>
    </div>
    ${renderHelpCards("access")}
  `;
}

function renderHelpCards(page) {
  const cards = helpCards[page] || helpCards.server;
  return `<div class="help-grid">${cards.map(([title, body, details = []], index) => {
    const key = `${page}:${index}`;
    const expanded = state.expandedHelp === key;
    return `
      <article class="help-card ${expanded ? "expanded" : ""}">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        ${expanded ? `<ol class="help-detail">${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ol>` : ""}
        <button data-action="help-toggle" data-help-key="${escapeHtml(key)}" aria-expanded="${expanded ? "true" : "false"}" type="button">${expanded ? "Less" : "Read more"}</button>
      </article>
    `;
  }).join("")}</div>`;
}

function renderGenericRealm(server) {
  const templates = creatableTemplatesInRealm(state.realm);
  const creating = state.creatingRealm === state.realm || !server;
  const canCreate = templates.length > 0;
  els.mainLayout.className = "main-layout generic-layout";
  els.mainLayout.innerHTML = `
    <section class="panel generic-sidebar">
      <div class="panel-heading"><h2>${state.realm === "steam" ? "Steam Servers" : "Other Servers"}</h2>${canCreate ? `<button data-action="new-server" type="button">${creating && server ? "Cancel" : "New"}</button>` : ""}</div>
      <div class="server-list">
        ${serversInRealm(state.realm).map((item) => `
          <button class="server-card ${server?.id === item.id && !creating ? "active" : ""}" data-action="select" data-id="${item.id}" type="button">
            <h3>${escapeHtml(item.name)}</h3>
            <p class="muted">${escapeHtml(templateById(item.templateId)?.name || item.templateId)}</p>
            <div class="server-meta"><span class="chip ${item.runtime?.running ? "ok" : ""}">${escapeHtml(item.runtime?.running ? "running" : item.runtime?.status || "stopped")}</span></div>
          </button>
        `).join("") || `<p class="muted pad">No servers yet.</p>`}
      </div>
    </section>
    <section class="panel generic-editor">
      ${creating ? renderGenericCreate(templates, Boolean(server)) : renderGenericEditor(server)}
      ${!creating && server ? `<h2>Files</h2><p class="muted">Stop the game before changing its files. Changes to game settings apply on next start.</p><div id="fileBrowser"></div>${server.definition?.capabilities?.saveSnapshots ? `<h2>Save snapshots</h2><p class="muted">Stop first. Includes game saves and settings, not downloaded game binaries. Downloads may contain join passwords; keep them private.</p><button data-action="snapshot-create" type="button">Create save snapshot</button><div id="snapshotList"></div>` : ""}` : ""}
    </section>
    <section class="panel generic-console">
      ${!creating && server ? renderGenericConsole(server) : `<div class="panel-heading"><h2>Console</h2></div><pre class="terminal">Select or create a server.</pre>`}
    </section>
  `;
  if (!creating && server) {
    loadFiles(server).catch(showNotice);
    if (server.definition?.capabilities?.saveSnapshots) loadSnapshots(server).catch(showNotice);
  }
}

function renderGenericCreate(templates, canCancel = false) {
  return `
    <div class="panel-heading"><h2>New Server</h2>${canCancel ? `<button data-action="cancel-create" type="button">Cancel</button>` : ""}</div>
    <div class="template-cards">
      ${templates.map((template) => `<button class="template-card" data-action="create-template" data-template="${template.id}" type="button"><strong>${escapeHtml(template.name)}</strong><span>${escapeHtml(template.subtitle)}</span></button>`).join("") || `<div class="empty-blueprints"><strong>No templates here yet.</strong><span>This realm has no createable server templates for your account.</span></div>`}
    </div>
  `;
}

function renderGenericEditor(server) {
  const template = templateById(server.templateId);
  const fieldOptions = server.fieldOptions || {};
  return `
    <div class="panel-heading"><h2>Edit Server</h2><span>${escapeHtml(serverStatus(server))}</span></div>
    <form id="genericForm" class="form-grid">
      <label>Name<input name="name" value="${escapeHtml(server.name)}" /></label>
      <label>Image / Service<input name="image" value="${escapeHtml(server.image || "")}" ${server.runtimeKind === "systemd" || server.definition?.capabilities?.saveSnapshots ? "readonly" : ""} /></label>
      <div class="field-grid">${(template.fields || []).map((field) => renderGenericField(field, server.env?.[field.key] ?? template.env?.[field.key] ?? "", fieldOptions[field.key])).join("")}</div>
      <div class="button-row"><button type="submit">Save</button><button data-action="start" type="button">Start</button><button data-action="stop" type="button">Stop</button><button data-action="restart" type="button">Restart</button></div>
    </form>
    ${renderLifecyclePanel(server)}
    ${renderDirectConnection(server)}
  `;
}

function renderGenericField(field, value, dynamicOptions = null) {
  if (field.type === "boolean") {
    const checked = ["TRUE", "true", "1", true].includes(value) ? "checked" : "";
    return `<label class="checkbox-label"><input data-env="${field.key}" type="checkbox" ${checked} /> ${escapeHtml(field.label)}</label>`;
  }
  if (field.type === "textarea") return `<label>${escapeHtml(field.label)}<textarea data-env="${field.key}" rows="4">${escapeHtml(value)}</textarea></label>`;
  if (field.type === "text" && Array.isArray(dynamicOptions) && dynamicOptions.length) return `<label>${escapeHtml(field.label)}<input data-env="${field.key}" list="options-${field.key}" value="${escapeHtml(value)}" /><datalist id="options-${field.key}">${dynamicOptions.map((option) => `<option value="${escapeHtml(option)}"></option>`).join("")}</datalist></label>`;
  const options = Array.isArray(dynamicOptions) && dynamicOptions.length ? dynamicOptions : field.options || [];
  if (field.type === "select" || options.length) {
    const visibleOptions = [...options];
    if (value && !visibleOptions.some((option) => String(option).toLowerCase() === String(value).toLowerCase())) visibleOptions.unshift(value);
    return `<label>${escapeHtml(field.label)}<select data-env="${field.key}">${visibleOptions.map((option) => `<option value="${escapeHtml(option)}" ${String(option) === String(value) ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select></label>`;
  }
  return `<label>${escapeHtml(field.label)}<input data-env="${field.key}" type="${field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}" value="${escapeHtml(value)}" /></label>`;
}

function dockerImageRef(image) {
  if (!image) return "";
  const repo = image.Repository || "";
  const tag = image.Tag || "";
  if (!repo || repo === "<none>") return image.ID || "";
  if (!tag || tag === "<none>") return repo;
  return `${repo}:${tag}`;
}

function renderDockerMaintenance() {
  const images = state.docker?.images || [];
  const containers = state.docker?.containers || [];
  els.mainLayout.className = "main-layout docker-layout";
  els.mainLayout.innerHTML = `
    <section class="docker-page">
      <div class="docker-hero">
        <div>
          <h1>Docker</h1>
          <p>${escapeHtml(state.docker?.docker ? `Engine ${state.docker.docker}` : "Docker maintenance")}</p>
        </div>
        <button data-action="docker-refresh" type="button">Refresh</button>
      </div>
      <div class="docker-actions">
        <form id="dockerPullForm" class="docker-pull">
          <label>Pull image<input name="image" placeholder="itzg/minecraft-server:latest" /></label>
          <button type="submit">Pull</button>
        </form>
        <div class="button-row">
          <button data-action="docker-prune-containers" type="button">Prune Stopped Containers</button>
          <button data-action="docker-prune-images" type="button">Prune Dangling Images</button>
          <button data-action="docker-prune-unused-images" class="danger" type="button">Prune Unused Images</button>
        </div>
      </div>
      <div class="docker-columns">
        <section class="docker-section">
          <div class="panel-heading"><h2>Containers</h2><span>${containers.length}</span></div>
          <div class="docker-list">
            ${containers.map((container) => `
              <div class="docker-row">
                <div>
                  <strong>${escapeHtml(container.Names || container.ID)}</strong>
                  <span>${escapeHtml(container.Image || "")}</span>
                  <small>${escapeHtml([container.State, container.Status, container.Ports].filter(Boolean).join(" | "))}</small>
                </div>
              </div>
            `).join("") || `<p class="muted pad">No Docker containers yet.</p>`}
          </div>
        </section>
        <section class="docker-section">
          <div class="panel-heading"><h2>Images</h2><span>${images.length}</span></div>
          <div class="docker-list">
            ${images.map((image) => {
              const ref = dockerImageRef(image);
              return `
                <div class="docker-row">
                  <div>
                    <strong>${escapeHtml(ref || image.ID || "unnamed image")}</strong>
                    <span>${escapeHtml([image.ID, image.Size, image.CreatedSince].filter(Boolean).join(" | "))}</span>
                  </div>
                  <button data-action="docker-remove-image" data-image="${escapeHtml(ref || image.ID)}" class="danger mini" type="button">Remove</button>
                </div>
              `;
            }).join("") || `<p class="muted pad">No Docker images yet.</p>`}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderServerAccessChecks(selectedIds = []) {
  return `
    <div class="access-checks">
      ${state.servers.map((server) => `
        <label class="checkbox-label"><input data-user-server="${server.id}" type="checkbox" ${selectedIds.includes(server.id) ? "checked" : ""} /> ${escapeHtml(server.name)}</label>
      `).join("") || `<p class="muted">No servers exist yet.</p>`}
    </div>
  `;
}

function renderUsersAdmin() {
  els.mainLayout.className = "main-layout users-layout";
  els.mainLayout.innerHTML = `
    <section class="users-page">
      <div class="users-hero">
        <div>
          <h1>Users</h1>
          <p>Operators can create game servers and manage only assigned servers. Admins can manage everything.</p>
        </div>
      </div>
      <section class="users-panel">
        <div class="panel-heading"><h2>Users</h2><span>${state.users.length}</span></div>
        <div class="user-list">
          ${state.users.map((user) => `
            <form class="user-row" data-user-form="${user.username}">
              <div>
                <strong>${escapeHtml(user.username)}</strong>
                <span>${user.username === state.me?.username ? "current user" : `created ${new Date(user.createdAt || Date.now()).toLocaleString()}`}</span>
              </div>
              <label>Role<select name="role"><option value="operator" ${user.role === "operator" ? "selected" : ""}>Operator</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option></select></label>
              <label>New password<input name="password" type="password" autocomplete="new-password" placeholder="Leave blank" /></label>
              ${renderServerAccessChecks(user.serverIds || [])}
              <div class="button-row">
                <button type="submit">Save</button>
                <button data-action="user-delete" data-user="${escapeHtml(user.username)}" class="danger" ${user.username === state.me?.username ? "disabled" : ""} type="button">Delete</button>
              </div>
            </form>
          `).join("") || `<p class="muted pad">No users yet.</p>`}
        </div>
      </section>
      <section class="users-panel">
        <div class="panel-heading"><h2>Add User</h2></div>
        <form id="userAddForm" class="user-add-form">
          <label>Username<input name="username" autocomplete="username" /></label>
          <label>Password<input name="password" type="password" autocomplete="new-password" /></label>
          <label>Role<select name="role"><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
          ${renderServerAccessChecks([])}
          <button type="submit">Add User</button>
        </form>
      </section>
    </section>
  `;
}

function renderGenericConsole(server) {
  return `
    <div class="panel-heading"><h2>Console</h2><span>${escapeHtml(server.runtime?.name || server.id)}</span></div>
    <div class="console-toolbar"><button data-action="open-logs" type="button">Logs</button><button data-action="open-console" type="button">Console</button><button data-action="clear-terminal" type="button">Clear</button></div>
    <pre id="terminal" class="terminal">Select Logs or Console.</pre>
    <form id="terminalForm" class="terminal-input"><span>&gt;</span><input id="terminalInput" autocomplete="off" spellcheck="false" placeholder="command" /><button type="submit">Send</button></form>
  `;
}

function afterRenderMinecraft(server, page) {
  if (page === "mods" && server.templateId === "minecraft-paper") loadModPlans(server).catch(showNotice);
  if (page === "files") loadFiles(server).catch(showNotice);
  if (page === "backups") loadBackups(server).catch(showNotice);
  if (page === "console") openStream("console");
  if (page === "log") openStream("logs");
}

function collectEnvFrom(root) {
  const env = {};
  root.querySelectorAll("[data-env]").forEach((input) => {
    env[input.dataset.env] = input.type === "checkbox" ? (input.checked ? "TRUE" : "FALSE") : input.value;
  });
  root.querySelectorAll("[data-toggle-env]").forEach((button) => {
    env[button.dataset.toggleEnv] = button.classList.contains("on") ? "TRUE" : "FALSE";
  });
  return env;
}

async function saveServer(server, patch) {
  const payload = await api(`/api/servers/${server.id}`, { method: "PUT", body: JSON.stringify({ ...server, ...patch }) });
  state.selectedByRealm[state.realm] = payload.server.id;
  await refresh();
  return payload;
}

async function doAction(action) {
  const server = selectedServer();
  if (!server) return;
  const payload = await api(`/api/servers/${server.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
  showNotice(payload.message || "Done.");
  await refresh();
}

async function deleteServer(server, { files = false } = {}) {
  if (!server) return;
  if (files) {
    const target = dataPathFor(server);
    if (!confirm(`Delete ${server.name}, its container, and files under ${target}?`)) return;
    const backups = confirm(`Also delete backups for ${server.name}?`);
    const payload = await api(`/api/servers/${server.id}?data=1&backups=${backups ? "1" : "0"}`, { method: "DELETE" });
    showNotice(payload.message || "Deleted server and files.");
  } else {
    if (!confirm(`Delete ${server.name}? The container is removed, but files and backups stay on disk.`)) return;
    const payload = await api(`/api/servers/${server.id}`, { method: "DELETE" });
    showNotice(payload.message || "Deleted server.");
  }
  await refresh({ keepPage: false });
}

async function runDockerUiAction(action, target) {
  if (action === "docker-refresh") {
    await refresh();
    return;
  }
  const map = {
    "docker-prune-containers": ["prune-containers", "Prune stopped containers? Running containers and data volumes are left alone."],
    "docker-prune-images": ["prune-images", "Prune dangling images? Images still referenced by containers are left alone."],
    "docker-prune-unused-images": ["prune-unused-images", "Prune all unused images? Docker keeps images used by containers, but it may remove images you would otherwise reuse later."]
  };
  let body;
  if (action === "docker-remove-image") {
    const image = target.dataset.image || "";
    if (!confirm(`Remove Docker image ${image}? Docker will refuse if a container still needs it.`)) return;
    body = { action: "remove-image", image };
  } else if (map[action]) {
    const [dockerAction, prompt] = map[action];
    if (!confirm(prompt)) return;
    body = { action: dockerAction };
  } else {
    return;
  }
  const payload = await api("/api/docker/actions", { method: "POST", body: JSON.stringify(body) });
  showNotice(payload.message || "Docker action complete.");
  await refresh();
}

function collectAssignedServers(root) {
  return [...root.querySelectorAll("[data-user-server]:checked")].map((input) => input.dataset.userServer);
}

async function saveUser(username, form) {
  const payload = {
    role: form.elements.role.value,
    serverIds: collectAssignedServers(form)
  };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  await api(`/api/users/${encodeURIComponent(username)}`, { method: "PUT", body: JSON.stringify(payload) });
  showNotice(`Saved ${username}.`);
  await refresh();
}

async function addUser(form) {
  const payload = {
    username: form.elements.username.value.trim(),
    password: form.elements.password.value,
    role: form.elements.role.value,
    serverIds: collectAssignedServers(form)
  };
  await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
  form.reset();
  showNotice(`Added ${payload.username}.`);
  await refresh();
}

async function deleteUser(username) {
  if (!confirm(`Delete user ${username}?`)) return;
  await api(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
  showNotice(`Deleted ${username}.`);
  await refresh();
}

function showNotice(message) {
  const target = document.querySelector(".notice") || document.createElement("div");
  target.className = "notice";
  target.hidden = false;
  target.textContent = message.message || String(message);
  if (!target.parentElement) els.mainLayout.prepend(target);
}

async function createFromTemplate(templateId) {
  const template = templateById(templateId);
  const name = template.family === "Minecraft" ? template.name : `${template.name} Server`;
  const payload = await api("/api/servers", { method: "POST", body: JSON.stringify({ templateId, name }) });
  state.realm = realmForServer(payload.server);
  state.selectedByRealm[state.realm] = payload.server.id;
  state.creatingRealm = "";
  state.page = "server";
  await refresh({ keepPage: false });
}

async function changeSoftware(server, templateId, type) {
  const template = templateById(templateId);
  const env = { ...(server.env || {}), ...(template.env || {}), TYPE: type };
  await saveServer(server, {
    templateId,
    image: template.image,
    dataMount: template.dataMount,
    ports: template.ports,
    env
  });
}

function closeSocket() {
  state.streamRequest += 1;
  if (state.socket) state.socket.close();
  state.socket = null;
  const send = document.querySelector('#agentCommandForm button[type="submit"]');
  if (send) send.disabled = true;
}

function appendTerminal(text) {
  const terminal = $("terminal");
  if (!terminal) return;
  const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 16;
  terminal.textContent += text;
  if (terminal.textContent.length > 140000) terminal.textContent = terminal.textContent.slice(-100000);
  if (atBottom) terminal.scrollTop = terminal.scrollHeight;
}

async function openStream(mode) {
  const server = selectedServer();
  const terminal = $("terminal");
  if (!server || !terminal) return;
  closeSocket();
  const request = state.streamRequest;
  terminal.textContent = `[opening ${mode} for ${server.name}]\n`;
  try {
    const { ticket } = await api(`/api/servers/${server.id}/console-ticket`, {
      method: "POST", body: JSON.stringify({ mode })
    });
    if (request !== state.streamRequest || terminal !== $("terminal")) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws/servers/${server.id}/${mode}?ticket=${encodeURIComponent(ticket)}`);
    state.socket = socket;
    socket.addEventListener("open", () => { if (state.socket === socket) { const send = document.querySelector('#agentCommandForm button[type="submit"]'); if (send) send.disabled = mode !== "console"; } });
    socket.addEventListener("message", (event) => { if (state.socket === socket) appendTerminal(event.data); });
    socket.addEventListener("close", (event) => { if (state.socket === socket) { const send = document.querySelector('#agentCommandForm button[type="submit"]'); if (send) send.disabled = true; appendTerminal(`\n[${event.reason || "Connection closed. Reconnect to continue."}]\n`); } });
    socket.addEventListener("error", () => { if (state.socket === socket) appendTerminal("\n[websocket error]\n"); });
  } catch (error) {
    if (request === state.streamRequest && terminal === $("terminal")) appendTerminal(`\n[${error.message || "Console unavailable"}]\n`);
  }
}

async function loadFiles(server, rel = state.filePath) {
  const payload = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(rel || "")}`);
  state.filePath = payload.path || "";
  const root = $("fileBrowser");
  if (!root) return;
  const up = state.filePath ? `<button data-action="files-up" type="button">Home</button>` : "";
  const rootRestore = !state.filePath && realmForServer(server) === "minecraft" ? `<label class="button-like">Restore Root ZIP<input id="rootZipInput" type="file" accept=".zip,application/zip" hidden /></label>` : "";
  root.innerHTML = `
    <div class="file-toolbar">
      <button data-action="files-home" type="button">Home</button>${up}
      <label class="button-like">Upload<input id="fileUploadInput" type="file" multiple hidden /></label>
      ${rootRestore}
      <span>${escapeHtml(state.filePath || "/")}</span>
    </div>
    <div class="file-list">
      ${payload.items.map((item) => {
        const canRestoreRoot = !state.filePath && realmForServer(server) === "minecraft" && item.type === "file" && item.name.toLowerCase().endsWith(".zip");
        return `
        <div class="file-row">
          ${item.type === "symlink" ? `<span>Link ${escapeHtml(item.name)} (access blocked)</span>` : `<button data-action="${item.type === "dir" ? "files-open" : "files-download"}" data-path="${escapeHtml(item.path)}" type="button">${item.type === "dir" ? "Folder" : "File"} ${escapeHtml(item.name)}</button>`}
          <span>${item.type === "file" ? bytes(item.size) : ""}</span>
          ${canRestoreRoot ? `<button data-action="root-restore-file" data-path="${escapeHtml(item.path)}" class="mini" type="button">Restore Root</button>` : ""}
          <button data-action="files-delete" data-path="${escapeHtml(item.path)}" class="danger mini" type="button">Delete</button>
        </div>
      `;
      }).join("") || `<p class="muted pad">Empty</p>`}
    </div>
  `;
}

async function uploadFiles(server, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file, file.webkitRelativePath || file.name);
  showNotice(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}...`);
  const payload = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(state.filePath || "")}`, { method: "POST", body: form });
  showNotice(payload.uploaded?.length ? `Uploaded ${payload.uploaded.join(", ")}.` : "Upload complete.");
  await loadFiles(server);
}

async function uploadRootZip(server, files) {
  const file = files.find((item) => item.name.toLowerCase().endsWith(".zip"));
  if (!file) {
    showNotice("Choose a .zip file to restore.");
    return;
  }
  if (!confirm(`Restore ${file.name} as the server root? This stops the server, backs up the current root, replaces matching files/folders, and restarts it if it was running.`)) return;
  const form = new FormData();
  form.append("rootZip", file, file.webkitRelativePath || file.name);
  showNotice(`Restoring ${file.name}...`);
  const payload = await api(`/api/servers/${server.id}/root/restore`, { method: "POST", body: form });
  showNotice(payload.message || "Restored server root zip.");
  await loadFiles(server, "");
  await refresh();
}

async function restoreRootZipFromFile(server, rel) {
  if (!confirm(`Restore ${rel} as the server root? This stops the server, backs up the current root, replaces matching files/folders, and restarts it if it was running.`)) return;
  showNotice(`Restoring ${rel}...`);
  const payload = await api(`/api/servers/${server.id}/root/restore`, { method: "POST", body: JSON.stringify({ path: rel }) });
  showNotice(payload.message || "Restored server root zip.");
  await loadFiles(server, "");
  await refresh();
}

async function uploadWorld(server, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("world", file, file.webkitRelativePath || file.name);
  showNotice("Uploading world...");
  const payload = await api(`/api/servers/${server.id}/world/upload`, { method: "POST", body: form });
  showNotice(payload.message || "World uploaded.");
  await refresh();
}

async function loadBackups(server) {
  const payload = await api(`/api/servers/${server.id}/backups`);
  const root = $("backupList");
  if (!root) return;
  root.innerHTML = `
    <div class="backup-rows">
      ${(payload.backups || []).map((backup) => {
        const restorable = backup.restorable !== false && backup.name.toLowerCase().endsWith(".zip");
        return `
        <div class="backup-row">
          <strong>${escapeHtml(backup.name)}</strong>
          <span>${bytes(backup.size)}</span>
          <a class="button-link" href="${authedUrl(`/api/servers/${server.id}/backups/download?name=${encodeURIComponent(backup.name)}`)}">Download</a>
          ${restorable
            ? `<button data-action="backup-restore" data-name="${escapeHtml(backup.name)}" type="button">Restore</button>`
            : `<button disabled title="Full server-root backup. Download to inspect or roll back manually." type="button">Root Backup</button>`}
        </div>
      `;
      }).join("") || `<p class="muted pad">No backups yet.</p>`}
    </div>
  `;
}

async function loadSnapshots(server) {
  const payload = await api(`/api/servers/${server.id}/snapshots`);
  const root = $("snapshotList");
  if (!root) return;
  root.innerHTML = payload.snapshots.map((snapshot) => `<div class="backup-row"><strong>${escapeHtml(snapshot.name)}</strong><span>${bytes(snapshot.size)}</span><a class="button-link" href="/api/servers/${server.id}/snapshots/download?name=${encodeURIComponent(snapshot.name)}">Download</a><button data-action="snapshot-restore" data-name="${escapeHtml(snapshot.name)}" type="button">Restore</button></div>`).join("") || `<p class="muted">No save snapshots yet.</p>`;
}

function renderAccessList(server) {
  const key = `gamepanel-access-${server.id}`;
  const names = JSON.parse(localStorage.getItem(key) || "[]");
  const root = $("accessList");
  if (!root) return;
  root.innerHTML = names.map((name) => `<div class="access-row"><span>${escapeHtml(name)}</span><button data-action="access-remove" data-name="${escapeHtml(name)}" type="button">Remove</button></div>`).join("") || `<p class="muted">No shared users yet.</p>`;
}

function sendConsoleCommand(command) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    showNotice("Console is not connected.");
    return;
  }
  state.socket.send(`${command}\n`);
}

function wireEvents() {
  els.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.authMessage.textContent = "";
    try {
      const payload = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: els.usernameInput.value.trim(),
          password: els.passwordInput.value,
          sessionMode: "cookie"
        })
      });
      if (!payload.ok) throw new Error("Bad login");
      state.me = payload.user;
      els.passwordInput.value = "";
      showApp();
      await refresh();
    } catch (error) {
      els.authMessage.textContent = error.message;
    }
  });

  els.realmTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='realm']");
    if (!button) return;
    state.realm = button.dataset.realm;
    state.page = "server";
    state.filePath = "";
    state.creatingRealm = "";
    render();
  });

  els.mainLayout.addEventListener("click", async (event) => {
    const target = event.target.closest("button,a");
    if (!target || target.tagName === "A") return;
    const server = selectedServer();
    const action = target.dataset.action;
    try {
      if (action === "agent-stream") {
        state.selectedByRealm.agent = target.dataset.id;
        await openStream(target.dataset.mode);
      } else if (action === "agent-disconnect") { closeSocket(); appendTerminal("\n[Disconnected]\n");
      } else if (action === "agent-delete") {
        if (!confirm("Delete this stopped owned server and all of its game data? This cannot be undone. Keep a host backup first.")) return;
        target.disabled = true;
        try { await api(`/api/servers/${target.dataset.id}`, { method: "DELETE", body: JSON.stringify({ confirm: target.dataset.id }) }); }
        finally { await refresh(); }
      } else if (action === "agent-lifecycle") {
        target.disabled = true;
        try { await api(`/api/servers/${target.dataset.id}/actions`, { method: "POST", body: JSON.stringify({ action: target.dataset.operation }) }); }
        finally { await refresh(); }
      } else if (action && action.startsWith("docker-")) {
        await runDockerUiAction(action, target);
      } else if (action === "open-users") {
        state.realm = "users";
        render();
      } else if (action === "user-delete") {
        await deleteUser(target.dataset.user);
      } else if (action === "mc-page") {
        state.page = target.dataset.page;
        state.filePath = "";
        render();
      } else if (action === "help-toggle") {
        state.expandedHelp = state.expandedHelp === target.dataset.helpKey ? "" : target.dataset.helpKey;
        render();
      } else if (action === "new-server") {
        state.creatingRealm = state.creatingRealm === state.realm ? "" : state.realm;
        state.page = "server";
        state.filePath = "";
        render();
      } else if (action === "cancel-create") {
        state.creatingRealm = "";
        state.page = "server";
        state.filePath = "";
        render();
      } else if (action === "create-edition") {
        state.createEdition = target.dataset.edition;
        render();
      } else if (action === "select") {
        state.selectedByRealm[state.realm] = target.dataset.id;
        state.creatingRealm = "";
        state.page = "server";
        render();
      } else if (action === "create-template") {
        await createFromTemplate(target.dataset.template);
      } else if (action === "delete") {
        await deleteServer(server);
      } else if (action === "delete-with-files") {
        await deleteServer(server, { files: true });
      } else if (action === "toggle-autostart") {
        const payload = await saveServer(server, { autoStart: !server.autoStart });
        showNotice(payload.message || `Autostart ${server.autoStart ? "disabled" : "enabled"}.`);
      } else if (["start", "stop", "restart", "pull", "remove-container"].includes(action)) {
        await doAction(action);
      } else if (action === "software") {
        await changeSoftware(server, target.dataset.template, target.dataset.type);
      } else if (action === "world-upload-zip") {
        $("worldZipInput").click();
      } else if (action === "world-upload-folder") {
        $("worldFolderInput").click();
      } else if (action === "world-generate") {
        if (confirm("Generate a fresh world? The current world will be backed up first.")) {
          const payload = await api(`/api/servers/${server.id}/world/generate`, { method: "POST", body: JSON.stringify({}) });
          showNotice(payload.message);
          await refresh();
        }
      } else if (action === "files-home") {
        await loadFiles(server, "");
      } else if (action === "files-up") {
        await loadFiles(server, "");
      } else if (action === "files-open") {
        await loadFiles(server, target.dataset.path);
      } else if (action === "files-download") {
        location.href = authedUrl(`/api/servers/${server.id}/files/download?path=${encodeURIComponent(target.dataset.path)}`);
      } else if (action === "root-restore-file") {
        await restoreRootZipFromFile(server, target.dataset.path);
      } else if (action === "files-delete") {
        if (confirm(`Delete ${target.dataset.path}?`)) {
          await api(`/api/servers/${server.id}/files`, { method: "DELETE", body: JSON.stringify({ path: target.dataset.path }) });
          await loadFiles(server);
        }
      } else if (action === "mod-discard") {
        await api(`/api/servers/${server.id}/mods/plans/${target.dataset.plan}`, { method: "DELETE" });
        await loadModPlans(server);
      } else if (action === "snapshot-create") {
        const payload = await api(`/api/servers/${server.id}/snapshots`, { method: "POST", body: JSON.stringify({ action: "create" }) });
        showNotice(`Created ${payload.name}.`);
        await loadSnapshots(server);
      } else if (action === "snapshot-restore") {
        if (confirm("Restore saves and settings? Current saves will be backed up first. The game must be stopped.")) {
          const payload = await api(`/api/servers/${server.id}/snapshots`, { method: "POST", body: JSON.stringify({ action: "restore", name: target.dataset.name }) });
          showNotice(payload.message);
          await refresh();
        }
      } else if (action === "backup-create") {
        const payload = await api(`/api/servers/${server.id}/backups`, { method: "POST", body: JSON.stringify({ action: "create" }) });
        showNotice(`Created ${payload.name}.`);
        await loadBackups(server);
      } else if (action === "backup-restore") {
        if (confirm(`Restore ${target.dataset.name}? Current world will be backed up first.`)) {
          const payload = await api(`/api/servers/${server.id}/backups`, { method: "POST", body: JSON.stringify({ action: "restore", name: target.dataset.name }) });
          showNotice(payload.message);
          await refresh();
        }
      } else if (action === "open-console") {
        openStream("console");
      } else if (action === "open-logs") {
        openStream("logs");
      } else if (action === "clear-terminal") {
        const terminal = $("terminal");
        if (terminal) terminal.textContent = "";
      }
      if (target.dataset.copy) navigator.clipboard?.writeText(target.dataset.copy);
    } catch (error) {
      showNotice(error);
    }
  });

  els.mainLayout.addEventListener("submit", async (event) => {
    event.preventDefault();
    const server = selectedServer();
    try {
      if (event.target.id === "agentCreateForm") {
        const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
        try { const form = new FormData(event.target), profile = form.get("profile"); await api("/api/servers", { method: "POST", body: JSON.stringify({ profile, name: form.get("name"), ...(state.agentGameProfiles[profile] ? { port: Number(form.get("port")), eula: form.get("eula") === "on" } : {}) }) }); }
        finally { await refresh(); }
        return;
      }
      if (event.target.id === "agentCommandForm") {
        sendConsoleCommand(new FormData(event.target).get("command")); event.target.reset(); return;
      }
      if (event.target.id === "userAddForm") {
        await addUser(event.target);
      } else if (event.target.dataset.userForm) {
        await saveUser(event.target.dataset.userForm, event.target);
      } else if (event.target.id === "dockerPullForm") {
        const image = event.target.elements.image.value.trim();
        if (!image) return;
        const payload = await api("/api/docker/actions", { method: "POST", body: JSON.stringify({ action: "pull-image", image }) });
        showNotice(payload.message || `Pulled ${image}.`);
        event.target.reset();
        await refresh();
      } else if (!server) {
        return;
      } else if (event.target.id === "mcOptionsForm") {
        await saveServer(server, { env: { ...(server.env || {}), ...collectEnvFrom(event.target) } });
        showNotice("Saved options.");
      } else if (event.target.id === "directConnectionForm") {
        const fields = event.target.elements;
        const update = { connectivity: { schemaVersion: 1, provider: "direct", advertisedHost: fields.advertisedHost.value.trim() } };
        if (isAdmin()) Object.assign(update, {
          networkMode: fields.networkMode.value,
          ports: (server.ports || []).map((port, index) => ({ ...port, host: Number(fields[`port-${index}`].value), bindAddress: fields[`bind-${index}`].value.trim() })),
          resources: { ...(server.resources || {}), cpus: Number(fields.cpus.value), memoryMiB: Number(fields.memoryMiB.value) }
        });
        await saveServer(server, update);
        showNotice("Saved connection address. No networking rules were changed.");
      } else if (event.target.dataset.modPlan) {
        const fields = event.target.elements;
        const payload = await api(`/api/servers/${server.id}/mods/plans/${event.target.dataset.modPlan}/apply`, { method: "POST", body: JSON.stringify({ type: fields.type.value, version: fields.version.value.trim(), confirm: fields.confirm.checked, acceptWarnings: fields.acceptWarnings.checked }) });
        showNotice(payload.message); await refresh();
      } else if (event.target.id === "genericForm") {
        const payload = await saveServer(server, { name: event.target.elements.name.value, image: event.target.elements.image?.value || server.image, env: { ...(server.env || {}), ...collectEnvFrom(event.target) } });
        showNotice(payload.message || "Saved server.");
      } else if (event.target.id === "terminalForm") {
        sendConsoleCommand($("terminalInput").value);
        $("terminalInput").value = "";
      } else if (event.target.dataset.playerCommand) {
        const value = event.target.querySelector("input").value.trim();
        if (value) sendConsoleCommand(`${event.target.dataset.playerCommand} ${value}`);
        event.target.querySelector("input").value = "";
      }
    } catch (error) {
      showNotice(error);
    }
  });

  els.mainLayout.addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-env]");
    if (!button) return;
    button.classList.toggle("on");
    button.classList.toggle("off");
    button.textContent = button.classList.contains("on") ? "ON" : "OFF";
  });

  els.mainLayout.addEventListener("change", async (event) => {
    if (event.target.name === "profile" && event.target.closest("#agentCreateForm")) {
      const preset = state.agentGameProfiles[event.target.value], port = event.target.form.elements.port;
      if (preset) { port.min = preset.portMin; port.max = preset.portMax; port.step = preset.step; port.value = preset.portMin; event.target.form.elements.eula.checked = false; }
      return;
    }
    const server = selectedServer();
    if (!server) return;
    try {
      if (event.target.id === "modFilesInput" || event.target.id === "modFolderInput") {
        await inspectMods(server, [...event.target.files]); event.target.value = "";
      }
      if (event.target.id === "worldZipInput" || event.target.id === "worldFolderInput") {
        await uploadWorld(server, [...event.target.files]);
        event.target.value = "";
      }
      if (event.target.id === "fileUploadInput") {
        await uploadFiles(server, [...event.target.files]);
        event.target.value = "";
      }
      if (event.target.id === "rootZipInput") {
        await uploadRootZip(server, [...event.target.files]);
        event.target.value = "";
      }
    } catch (error) {
      event.target.value = "";
      showNotice(error);
    }
  });

  els.mainLayout.addEventListener("dragover", (event) => { if (event.target.closest("#modDropZone")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
  els.mainLayout.addEventListener("drop", async (event) => {
    if (!event.target.closest("#modDropZone")) return;
    event.preventDefault();
    const server = selectedServer();
    try { await inspectMods(server, await droppedMods(event.dataTransfer.items)); } catch (error) { showNotice(error); }
  });

  els.refreshButton.addEventListener("click", () => refresh().catch((error) => (els.statusLine.textContent = error.message)));
  els.logoutButton.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
      closeSocket();
      state.me = null;
      showAuth();
    } catch (error) { showNotice(error); }
  });
  $("passwordButton").addEventListener("click", () => { $("passwordMessage").textContent = ""; $("passwordDialog").showModal(); });
  $("passwordCancel").addEventListener("click", () => { $("passwordForm").reset(); $("passwordDialog").close(); });
  $("passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = event.target.elements;
    if (fields.newPassword.value !== fields.confirmPassword.value) { $("passwordMessage").textContent = "New passwords must match."; return; }
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: fields.currentPassword.value, newPassword: fields.newPassword.value }) });
      event.target.reset();
      $("passwordDialog").close();
      closeSocket(); state.me = null; showAuth();
      els.authMessage.textContent = "Password changed. Please sign in again.";
    } catch (error) { $("passwordMessage").textContent = error.message; }
  });
  els.themeToggle.addEventListener("change", () => setTheme(els.themeToggle.checked ? "dark" : "light"));
}

async function boot() {
  setTheme(document.documentElement.dataset.theme || "light");
  wireEvents();
  showApp();
  try {
    await refresh();
  } catch (_error) {
    state.me = null;
    showAuth();
  }
}

boot();
