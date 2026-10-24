"use strict";

// Reviewed, opt-in fresh installs. These never reference an existing host server.
const profiles = {
  "unturned-dedicated": { game: "unturned", image: "versagamepanel/unturned:2", priorImages: ["versagamepanel/unturned:1"], scope: "install/Servers/vgp", stop: "Shutdown" },
  "terraria-vanilla": { game: "terraria", image: "versagamepanel/terraria:1.4.5.8-1", scope: "saves", stop: "exit" },
  "terraria-tmodloader-reviewed": { game: "tmodloader", image: "versagamepanel/tmodloader:2026.08.3.0-2", priorImages: ["versagamepanel/tmodloader:2026.08.3.0-1"], scope: "tmodloader", stop: "exit" }
};
function line(value, fallback, max = 120) {
  const text = String(value ?? fallback);
  if (!text.trim() || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw Object.assign(new Error("Game settings must be nonempty single lines of reasonable length."), { statusCode: 400 });
  return text;
}
function integer(value, fallback, min, max) {
  const text = String(value ?? fallback);
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) throw Object.assign(new Error(`Choose a whole number between ${min} and ${max}.`), { statusCode: 400 });
  return String(Number(text));
}
function choice(value, fallback, choices) {
  const text = String(value ?? fallback);
  if (!choices.includes(text)) throw Object.assign(new Error(`Choose one of: ${choices.join(", ")}.`), { statusCode: 400 });
  return text;
}
function workshopIds(value = "") {
  const ids = String(value).trim() ? String(value).trim().split(/[\s,]+/) : [];
  if (ids.length > 200 || ids.some((id) => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    throw Object.assign(new Error("Enter up to 200 numeric Workshop file IDs, separated by commas or new lines."), { statusCode: 400 });
  }
  return [...new Set(ids.map(Number))];
}
function enabledMods(value = "") {
  const names = String(value).trim() ? String(value).trim().split(/[\s,]+/) : [];
  if (names.length > 200 || names.some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))) throw Object.assign(new Error("Enter up to 200 mod internal names separated by commas or new lines."), { statusCode: 400 });
  return [...new Set(names)];
}
function settings(id, env = {}) {
  if (!profiles[id]) return {};
  const common = { SERVERNAME: line(env.SERVERNAME, "A VersaGamePanel server"), PORT: integer(env.PORT, id === "unturned-dedicated" ? 27015 : 7777, 1024, 65533), MAXPLAYERS: integer(env.MAXPLAYERS, 8, 1, id === "unturned-dedicated" ? 200 : 255) };
  if (id === "unturned-dedicated") return { ...common,
    MAP: line(env.MAP, "PEI", 80), DIFFICULTY: choice(env.DIFFICULTY, "Normal", ["Easy", "Normal", "Hard"]),
    WORKSHOP_MANAGED: choice(env.WORKSHOP_MANAGED, "FALSE", ["TRUE", "FALSE"]), WORKSHOP_ITEMS: workshopIds(env.WORKSHOP_ITEMS).join(","),
    PERSPECTIVE: choice(env.PERSPECTIVE, "Both", ["First", "Third", "Both", "Vehicle"]) };
  return { ...common, WORLDSIZE: choice(env.WORLDSIZE, "1", ["1", "2", "3"]),
    DIFFICULTY: choice(env.DIFFICULTY, "0", ["0", "1", "2", "3"]),
    SEED: env.SEED ? line(env.SEED, "", 80) : "", PASSWORD: env.PASSWORD ? line(env.PASSWORD, "", 80) : "",
    ...(id === "terraria-tmodloader-reviewed" ? { MANAGE_MODS: choice(env.MANAGE_MODS, "FALSE", ["TRUE", "FALSE"]), ENABLED_MODS: enabledMods(env.ENABLED_MODS).join(",") } : {}) };
}
function workshopConfiguration(env, previous = "{}") {
  const s = settings("unturned-dedicated", env);
  if (s.WORKSHOP_MANAGED !== "TRUE") return null;
  const parsed = JSON.parse(previous);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Workshop configuration must be a JSON object; original file preserved.");
  return JSON.stringify({ ...parsed, File_IDs: workshopIds(s.WORKSHOP_ITEMS) }, null, 2) + "\n";
}
// Keep advanced settings not owned by this form. Never interpret configuration as shell.
function configuration(id, env, previous = "") {
  const s = settings(id, env);
  const worldRoot = id === "terraria-tmodloader-reviewed" ? "/data/tmodloader/Worlds" : "/data/saves";
  const entries = id === "unturned-dedicated" ? {
    Name: s.SERVERNAME, Map: s.MAP, Port: s.PORT, MaxPlayers: s.MAXPLAYERS, Mode: s.DIFFICULTY, Perspective: s.PERSPECTIVE
  } : { world: `${worldRoot}/world.wld`, worldname: s.SERVERNAME, worldpath: worldRoot, autocreate: s.WORLDSIZE,
    difficulty: s.DIFFICULTY, maxplayers: s.MAXPLAYERS, port: s.PORT, password: s.PASSWORD, seed: s.SEED, secure: "1", upnp: "0",
    ...(id === "terraria-tmodloader-reviewed" ? { modpath: "/data/tmodloader/Mods" } : {}) };
  const separator = id === "unturned-dedicated" ? " " : "=";
  const owned = new Set(Object.keys(entries).map((key) => key.toLowerCase()));
  const kept = previous.split(/\r?\n/).filter((entry) => entry.trim() && !owned.has(entry.trim().split(/[\s=]/)[0].toLowerCase()));
  return [...kept, ...Object.entries(entries).map(([key, value]) => `${key}${separator}${value}`), ""].join("\n");
}
const field = (key, label, options) => ({ key, label, type: options ? "select" : key === "PASSWORD" ? "password" : "text", ...(options ? { options } : {}) });
const dedicatedTemplates = Object.entries(profiles).map(([id, p]) => ({
  id, name: p.game === "unturned" ? "Unturned Dedicated" : p.game === "tmodloader" ? "Terraria tModLoader (reviewed)" : "Terraria Vanilla",
  subtitle: "Fresh install · foreground console · save snapshots · local image build required",
  family: p.game === "unturned" ? "Steam" : "Other", image: p.image, dataMount: "/data", networkMode: "bridge",
  resources: { cpus: 2, memoryMiB: p.game === "unturned" ? 4096 : 2048, pids: 512 },
  ports: p.game === "unturned" ? [27015, 27016].map((port) => ({ host: port, container: port, protocol: "udp", label: port === 27015 ? "Game" : "Query" })) : [{ host: 7777, container: 7777, protocol: "tcp", label: "Game" }],
  env: settings(id), fields: [field("SERVERNAME", "Server / world name"), field("PORT", "Internal game port"), field("MAXPLAYERS", "Maximum players"),
    ...(p.game === "unturned" ? [field("MAP", "Map"), field("DIFFICULTY", "Difficulty", ["Easy", "Normal", "Hard"]), field("PERSPECTIVE", "Perspective", ["Both", "First", "Third", "Vehicle"]), { key: "WORKSHOP_MANAGED", label: "Manage Workshop file IDs here (off preserves uploaded configuration)", type: "boolean" }, { key: "WORKSHOP_ITEMS", label: "Workshop map/mod file IDs (comma or newline separated)", type: "textarea" }] :
      [field("WORLDSIZE", "New world size (1 small, 2 medium, 3 large)", ["1", "2", "3"]), field("DIFFICULTY", "New world difficulty (0 classic, 1 expert, 2 master, 3 journey)", ["0", "1", "2", "3"]), field("SEED", "New world seed"), field("PASSWORD", "Join password"),
        ...(p.game === "tmodloader" ? [{ key: "MANAGE_MODS", label: "Manage enabled mod names here (off preserves uploaded enabled.json)", type: "boolean" }, { key: "ENABLED_MODS", label: "Enabled internal mod names (upload .tmod files into tmodloader/Mods first)", type: "textarea" }] : [])])]
}));
function validateProfileRuntime(server) {
  const p = profiles[server.templateId];
  if (!p) return;
  if (![p.image, ...(p.priorImages || [])].includes(server.image) || server.command || server.dataMount !== "/data" || server.networkMode !== "bridge") {
    throw Object.assign(new Error("This reviewed profile requires its built-in image, bridge network, /data mount and foreground launcher."), { statusCode: 400 });
  }
  const port = Number(settings(server.templateId, server.env).PORT);
  for (const endpoint of server.ports || []) {
    const allowed = p.game === "unturned" ? endpoint.protocol === "udp" && [port, port + 1].includes(endpoint.container) : endpoint.protocol === "tcp" && endpoint.container === port;
    if (!allowed) throw Object.assign(new Error("Internal game port and published container ports must match. Change host ports independently for multiple servers."), { statusCode: 400 });
  }
}
module.exports = { profiles, settings, configuration, dedicatedTemplates, validateProfileRuntime, workshopIds, workshopConfiguration, enabledMods };
