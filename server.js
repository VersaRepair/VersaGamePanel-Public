"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");
const {
  assertNoSymlinksInTree,
  resolveSafePath,
  safeRel
} = require("./lib/filesystem-safety");
const { extractZipSafely } = require("./lib/safe-zip");
const { collectMultipart } = require("./lib/file-upload");
const { attachConsoleTransport } = require("./lib/console-transport");
const { createConsoleTickets } = require("./lib/console-tickets");
const { gameDefinition, blockedReason } = require("./lib/game-registry");
const { directConnectivity, directEndpoints } = require("./lib/direct-connectivity");
const { dockerRunArgs, validatePorts, resources } = require("./lib/docker-runtime");
const { hostStoragePath } = require("./lib/host-storage");
const { replaceDirectory } = require("./lib/directory-transaction");
const { serverOperations } = require("./lib/server-operations");
const { saveJson } = require("./lib/json-store");
const { profiles: gameProfiles, settings: gameSettings, dedicatedTemplates, validateProfileRuntime } = require("./lib/game-profiles");
const { gameSnapshots } = require("./lib/game-snapshots");
const { modPlans } = require("./lib/mod-plans");
const { credential, sameOrigin, sessionCookie, sessions, loginLimiter, verifyPassword, validNewPassword } = require("./lib/auth-sessions");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.GAMEPANEL_DATA_DIR || path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TOKEN_FILE = process.env.GAMEPANEL_TOKEN_FILE || path.join(DATA_DIR, "admin-token.txt");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PORT = Number(process.env.PORT || process.env.GAMEPANEL_PORT || 8788);
const HOST = process.env.HOST || process.env.GAMEPANEL_HOST || "0.0.0.0";
const AUTH_DISABLED = process.env.GAMEPANEL_AUTH_DISABLED === "1";
const SERVER_DATA_DIR = path.join(DATA_DIR, "servers");
const BACKUP_DATA_DIR = path.join(DATA_DIR, "backups");

const CONTAINER_PREFIX = "gp_";
const consoleTickets = createConsoleTickets();
const PUBLIC_ORIGIN = process.env.GAMEPANEL_PUBLIC_URL ? new URL(process.env.GAMEPANEL_PUBLIC_URL).origin : "";
const runServerOperation = serverOperations();
let consoleTransport;
const authSessions = sessions({ onRevoke: () => consoleTransport?.revalidate() });
const loginFailures = loginLimiter();
const LEGACY_TOKEN_ENABLED = process.env.GAMEPANEL_ALLOW_LEGACY_TOKEN === "1";
let loginsInFlight = 0;
const dummyPasswordHash = hashPassword(crypto.randomBytes(32).toString("base64url"));

const templates = [
  ...dedicatedTemplates,
  {
    id: "minecraft-paper",
    name: "Minecraft Java",
    subtitle: "Paper / Vanilla / Fabric / Forge",
    family: "Minecraft",
    image: "itzg/minecraft-server:latest",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 25565, container: 25565, protocol: "tcp", label: "Game" }],
    env: {
      EULA: "FALSE",
      TYPE: "PAPER",
      VERSION: "LATEST",
      MEMORY: "2G",
      MOTD: "A GamePanel Minecraft server",
      MODE: "survival",
      DIFFICULTY: "normal",
      MAX_PLAYERS: "20",
      ONLINE_MODE: "TRUE",
      ENABLE_WHITELIST: "FALSE",
      ALLOW_FLIGHT: "TRUE",
      FORCE_GAMEMODE: "FALSE",
      PVP: "TRUE",
      VIEW_DISTANCE: "10",
      LEVEL: "world",
      SEED: ""
    },
    fields: [
      { key: "EULA", label: "Accept EULA", type: "boolean", requiredTrue: true },
      { key: "TYPE", label: "Server Type", type: "select", options: ["PAPER", "VANILLA", "FABRIC", "FORGE", "NEOFORGE", "QUILT", "SPIGOT", "PURPUR", "AUTO_CURSEFORGE", "MODRINTH"] },
      { key: "VERSION", label: "Version", type: "text" },
      { key: "MEMORY", label: "Memory", type: "text" },
      { key: "MOTD", label: "MOTD", type: "text" },
      { key: "MODE", label: "Game Mode", type: "select", options: ["survival", "creative", "adventure", "spectator"] },
      { key: "DIFFICULTY", label: "Difficulty", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
      { key: "MAX_PLAYERS", label: "Max Players", type: "number", min: 1, max: 200 },
      { key: "ONLINE_MODE", label: "Online Mode", type: "boolean" },
      { key: "ENABLE_WHITELIST", label: "Whitelist", type: "boolean" },
      { key: "ALLOW_FLIGHT", label: "Allow Flight", type: "boolean" },
      { key: "FORCE_GAMEMODE", label: "Force Gamemode", type: "boolean" },
      { key: "PVP", label: "PVP", type: "boolean" },
      { key: "VIEW_DISTANCE", label: "View Distance", type: "number", min: 2, max: 32 },
      { key: "LEVEL", label: "World Name", type: "text" },
      { key: "SEED", label: "Seed", type: "text" },
      { key: "MODRINTH_PROJECTS", label: "Modrinth Mods/Plugins", type: "textarea" },
      { key: "MODS", label: "Direct Mod URLs", type: "textarea" },
      { key: "PLUGINS", label: "Direct Plugin URLs", type: "textarea" },
      { key: "REMOVE_OLD_MODS", label: "Remove Old Mods", type: "boolean" }
    ]
  },
  {
    id: "minecraft-modrinth",
    name: "Minecraft Modrinth Pack",
    subtitle: "Auto-installs Modrinth modpacks with loader/version controls",
    family: "Minecraft",
    image: "itzg/minecraft-server:latest",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 25565, container: 25565, protocol: "tcp", label: "Game" }],
    env: {
      EULA: "FALSE",
      TYPE: "MODRINTH",
      MODRINTH_MODPACK: "",
      MODRINTH_VERSION: "",
      MODRINTH_LOADER: "fabric",
      VERSION: "LATEST",
      MEMORY: "6G",
      MOTD: "A GamePanel Modrinth server",
      ONLINE_MODE: "TRUE",
      DIFFICULTY: "normal",
      MODRINTH_PROJECTS: "",
      MODRINTH_EXCLUDE_FILES: "",
      REMOVE_OLD_MODS: "TRUE"
    },
    fields: [
      { key: "EULA", label: "Accept EULA", type: "boolean", requiredTrue: true },
      { key: "MODRINTH_MODPACK", label: "Modpack Slug / ID / URL", type: "text" },
      { key: "MODRINTH_VERSION", label: "Pack Version", type: "text" },
      { key: "MODRINTH_LOADER", label: "Loader", type: "select", options: ["fabric", "forge", "neoforge", "quilt"] },
      { key: "VERSION", label: "Minecraft Version", type: "text" },
      { key: "MEMORY", label: "Memory", type: "text" },
      { key: "MOTD", label: "MOTD", type: "text" },
      { key: "ONLINE_MODE", label: "Online Mode", type: "boolean" },
      { key: "DIFFICULTY", label: "Difficulty", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
      { key: "MODRINTH_PROJECTS", label: "Extra Modrinth Projects", type: "textarea" },
      { key: "MODRINTH_EXCLUDE_FILES", label: "Exclude Files", type: "textarea" },
      { key: "REMOVE_OLD_MODS", label: "Remove Old Mods", type: "boolean" }
    ]
  },
  {
    id: "minecraft-curseforge",
    name: "Minecraft CurseForge Pack",
    subtitle: "Auto-installs CurseForge packs; API key required",
    family: "Minecraft",
    image: "itzg/minecraft-server:latest",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 25565, container: 25565, protocol: "tcp", label: "Game" }],
    env: {
      EULA: "FALSE",
      TYPE: "AUTO_CURSEFORGE",
      CF_API_KEY: "",
      CF_PAGE_URL: "",
      CF_SLUG: "",
      CF_FILE_ID: "",
      MEMORY: "8G",
      MOTD: "A GamePanel CurseForge server",
      ONLINE_MODE: "TRUE",
      CF_EXCLUDE_MODS: "",
      CF_FORCE_INCLUDE_MODS: ""
    },
    fields: [
      { key: "EULA", label: "Accept EULA", type: "boolean", requiredTrue: true },
      { key: "CF_API_KEY", label: "CurseForge API Key", type: "password" },
      { key: "CF_PAGE_URL", label: "CurseForge Page URL", type: "text" },
      { key: "CF_SLUG", label: "Pack Slug", type: "text" },
      { key: "CF_FILE_ID", label: "File ID", type: "text" },
      { key: "MEMORY", label: "Memory", type: "text" },
      { key: "MOTD", label: "MOTD", type: "text" },
      { key: "ONLINE_MODE", label: "Online Mode", type: "boolean" },
      { key: "CF_EXCLUDE_MODS", label: "Exclude Mods", type: "textarea" },
      { key: "CF_FORCE_INCLUDE_MODS", label: "Force Include Mods", type: "textarea" }
    ]
  },
  {
    id: "minecraft-bedrock",
    name: "Minecraft Bedrock",
    subtitle: "Official Bedrock dedicated server",
    family: "Minecraft",
    image: "itzg/minecraft-bedrock-server:latest",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 19132, container: 19132, protocol: "udp", label: "Game" }],
    env: {
      EULA: "FALSE",
      SERVER_NAME: "GamePanel Bedrock",
      GAMEMODE: "survival",
      DIFFICULTY: "normal",
      MAX_PLAYERS: "10",
      ONLINE_MODE: "true",
      ALLOW_CHEATS: "false",
      LEVEL_NAME: "Bedrock level"
    },
    fields: [
      { key: "EULA", label: "Accept EULA", type: "boolean", requiredTrue: true },
      { key: "SERVER_NAME", label: "Server Name", type: "text" },
      { key: "GAMEMODE", label: "Game Mode", type: "select", options: ["survival", "creative", "adventure"] },
      { key: "DIFFICULTY", label: "Difficulty", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
      { key: "MAX_PLAYERS", label: "Max Players", type: "number", min: 1, max: 100 },
      { key: "ONLINE_MODE", label: "Online Mode", type: "boolean" },
      { key: "ALLOW_CHEATS", label: "Allow Cheats", type: "boolean" },
      { key: "LEVEL_NAME", label: "World Name", type: "text" }
    ]
  },
  {
    id: "unturned-linuxgsm",
    name: "Unturned",
    subtitle: "LinuxGSM container; existing server can be imported later",
    family: "Steam",
    image: "gameservermanagers/gameserver:unt",
    networkMode: "host",
    dataMount: "/data",
    ports: [
      { host: 27015, container: 27015, protocol: "udp", label: "Game" },
      { host: 27015, container: 27015, protocol: "tcp", label: "Query" },
      { host: 27016, container: 27016, protocol: "udp", label: "Steam" }
    ],
    env: {
      SERVERNAME: "GamePanel Unturned",
      MAXPLAYERS: "24",
      MAP: "PEI",
      MODE: "normal",
      PERSPECTIVE: "both",
      OWNER: "",
      GSLT: ""
    },
    fields: [
      { key: "SERVERNAME", label: "Server Name", type: "text" },
      { key: "MAXPLAYERS", label: "Max Players", type: "number", min: 1, max: 48 },
      { key: "MAP", label: "Map", type: "text" },
      { key: "MODE", label: "Mode", type: "select", options: ["easy", "normal", "hard"] },
      { key: "PERSPECTIVE", label: "Perspective", type: "select", options: ["first", "third", "both", "vehicle"] },
      { key: "OWNER", label: "Owner Steam ID", type: "text" },
      { key: "GSLT", label: "Steam Login Token", type: "password" }
    ]
  },
  {
    id: "terraria-linuxgsm",
    name: "Terraria",
    subtitle: "Vanilla Terraria via LinuxGSM",
    family: "Steam",
    image: "gameservermanagers/gameserver:terraria",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 7777, container: 7777, protocol: "tcp", label: "Game" }],
    env: {
      WORLDNAME: "GamePanel",
      MAXPLAYERS: "8",
      PASSWORD: "",
      DIFFICULTY: "0"
    },
    fields: [
      { key: "WORLDNAME", label: "World Name", type: "text" },
      { key: "MAXPLAYERS", label: "Max Players", type: "number", min: 1, max: 32 },
      { key: "PASSWORD", label: "Password", type: "password" },
      { key: "DIFFICULTY", label: "Difficulty", type: "select", options: ["0", "1", "2", "3"] }
    ]
  },
  {
    id: "terraria-tmodloader",
    name: "tModLoader",
    subtitle: "Modded Terraria; attach console for first world setup",
    family: "Steam",
    image: "hexlo/terraria-tmodloader-server:latest",
    networkMode: "host",
    dataMount: "/root/.local/share/Terraria",
    ports: [{ host: 7777, container: 7777, protocol: "tcp", label: "Game" }],
    env: {
      world: "",
      worldpath: "/root/.local/share/Terraria/Worlds",
      autocreate: "2",
      maxplayers: "8",
      password: ""
    },
    fields: [
      { key: "world", label: "World File Path", type: "text" },
      { key: "worldpath", label: "World Folder", type: "text" },
      { key: "autocreate", label: "Auto Create Size", type: "select", options: ["1", "2", "3"] },
      { key: "maxplayers", label: "Max Players", type: "number", min: 1, max: 32 },
      { key: "password", label: "Password", type: "password" }
    ]
  },
  {
    id: "cs2-linuxgsm",
    name: "Counter-Strike 2",
    subtitle: "LinuxGSM CS2 dedicated server",
    family: "Steam",
    image: "gameservermanagers/gameserver:cs2",
    networkMode: "host",
    dataMount: "/data",
    ports: [
      { host: 27015, container: 27015, protocol: "tcp", label: "Game" },
      { host: 27015, container: 27015, protocol: "udp", label: "Game" },
      { host: 27020, container: 27020, protocol: "udp", label: "SourceTV" }
    ],
    env: {
      SERVERNAME: "GamePanel CS2",
      GSLT: "",
      MAXPLAYERS: "12"
    },
    fields: [
      { key: "SERVERNAME", label: "Server Name", type: "text" },
      { key: "GSLT", label: "Steam Login Token", type: "password" },
      { key: "MAXPLAYERS", label: "Max Players", type: "number", min: 1, max: 64 }
    ]
  },
  {
    id: "gmod-linuxgsm",
    name: "Garry's Mod",
    subtitle: "LinuxGSM Garry's Mod dedicated server",
    family: "Steam",
    image: "gameservermanagers/gameserver:gmod",
    networkMode: "host",
    dataMount: "/data",
    ports: [
      { host: 27015, container: 27015, protocol: "udp", label: "Game" },
      { host: 27015, container: 27015, protocol: "tcp", label: "Query" }
    ],
    env: {
      SERVERNAME: "GamePanel GMod",
      GSLT: "",
      MAXPLAYERS: "16",
      GAMEMODE: "sandbox",
      WORKSHOP_COLLECTION_ID: ""
    },
    fields: [
      { key: "SERVERNAME", label: "Server Name", type: "text" },
      { key: "GSLT", label: "Steam Login Token", type: "password" },
      { key: "MAXPLAYERS", label: "Max Players", type: "number", min: 1, max: 128 },
      { key: "GAMEMODE", label: "Game Mode", type: "text" },
      { key: "WORKSHOP_COLLECTION_ID", label: "Workshop Collection ID", type: "text" }
    ]
  },
  {
    id: "nmrih-linuxgsm",
    name: "No More Room in Hell",
    subtitle: "LinuxGSM Source dedicated server",
    family: "Steam",
    image: "gameservermanagers/gameserver:nmrih",
    networkMode: "host",
    dataMount: "/data",
    ports: [
      { host: 27015, container: 27015, protocol: "udp", label: "Game" },
      { host: 27015, container: 27015, protocol: "tcp", label: "Query" }
    ],
    env: {
      SERVERNAME: "GamePanel NMRiH",
      MAXPLAYERS: "8",
      MAP: "nmo_broadway"
    },
    fields: [
      { key: "SERVERNAME", label: "Server Name", type: "text" },
      { key: "MAXPLAYERS", label: "Max Players", type: "number", min: 1, max: 16 },
      { key: "MAP", label: "Map", type: "text" }
    ]
  },
  {
    id: "the-forest",
    name: "The Forest",
    subtitle: "Wine-backed Docker dedicated server",
    family: "Steam",
    image: "jammsen/the-forest-dedicated-server:latest",
    networkMode: "host",
    dataMount: "/theforest",
    ports: [
      { host: 8766, container: 8766, protocol: "udp", label: "Steam" },
      { host: 27015, container: 27015, protocol: "udp", label: "Game" },
      { host: 27016, container: 27016, protocol: "udp", label: "Query" }
    ],
    env: {
      SERVER_STEAM_ACCOUNT_TOKEN: "",
      SERVER_NAME: "GamePanel The Forest",
      SERVER_PASSWORD: "",
      SERVER_ADMIN_PASSWORD: "",
      SERVER_PLAYERS: "8"
    },
    fields: [
      { key: "SERVER_STEAM_ACCOUNT_TOKEN", label: "Steam Login Token", type: "password" },
      { key: "SERVER_NAME", label: "Server Name", type: "text" },
      { key: "SERVER_PASSWORD", label: "Server Password", type: "password" },
      { key: "SERVER_ADMIN_PASSWORD", label: "Admin Password", type: "password" },
      { key: "SERVER_PLAYERS", label: "Players", type: "number", min: 1, max: 32 }
    ]
  },
  {
    id: "dcs-world",
    name: "DCS World",
    subtitle: "Experimental Wine/WebGUI dedicated server",
    family: "Sim",
    image: "aterfax/dcs-world-dedicated-server:latest",
    networkMode: "host",
    dataMount: "/config",
    ports: [
      { host: 10308, container: 10308, protocol: "tcp", label: "Game" },
      { host: 10308, container: 10308, protocol: "udp", label: "Game" },
      { host: 8080, container: 8080, protocol: "tcp", label: "WebGUI" }
    ],
    env: {
      SERVER_NAME: "GamePanel DCS",
      TZ: "America/Detroit"
    },
    fields: [
      { key: "SERVER_NAME", label: "Server Name", type: "text" },
      { key: "TZ", label: "Timezone", type: "text" }
    ]
  },
  {
    id: "stardew-junimo",
    name: "Stardew Valley",
    subtitle: "JunimoServer alpha; Docker headless farm host",
    family: "Co-op",
    image: "sdvd/server:latest",
    networkMode: "host",
    dataMount: "/data",
    ports: [{ host: 24642, container: 24642, protocol: "udp", label: "Game" }],
    env: {
      SERVER_NAME: "GamePanel Farm",
      STEAM_USERNAME: "",
      STEAM_PASSWORD: "",
      FARM_NAME: ""
    },
    fields: [
      { key: "SERVER_NAME", label: "Server Name", type: "text" },
      { key: "STEAM_USERNAME", label: "Steam Username", type: "text" },
      { key: "STEAM_PASSWORD", label: "Steam Password", type: "password" },
      { key: "FARM_NAME", label: "Farm Name", type: "text" }
    ]
  },
  {
    id: "docker-smoke",
    name: "Docker Smoke Test",
    subtitle: "Tiny always-running test container",
    family: "Utility",
    image: "alpine:latest",
    networkMode: "host",
    dataMount: "/data",
    command: "sh -lc 'while true; do echo \"$(date -Is) GamePanel smoke test alive\"; sleep 15; done'",
    ports: [],
    env: {},
    fields: []
  },
  {
    id: "custom-docker",
    name: "Custom Docker Image",
    subtitle: "Bring your own image, ports, env, and command",
    family: "Custom",
    image: "",
    networkMode: "host",
    dataMount: "/data",
    ports: [],
    env: {},
    fields: [
      { key: "CUSTOM_NOTE", label: "Notes", type: "textarea" }
    ]
  }
];

let authToken = "";
let state = { servers: [] };
let users = [];

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role || "operator",
    serverIds: Array.isArray(user.serverIds) ? user.serverIds : [],
    createdAt: user.createdAt || ""
  };
}

function tokenInput(req, urlObject) {
  return credential(req); // Never accept credentials from a URL.
}

function issueSession(user) {
  return authSessions.issue(user.username);
}

function authContext(req, urlObject, touch = true) {
  if (AUTH_DISABLED) return { admin: true, user: { username: "admin", role: "admin", serverIds: [] } };
  const token = tokenInput(req, urlObject);
  if (LEGACY_TOKEN_ENABLED && authToken && token && safeEqual(token, authToken)) {
    const admin = users.find((user) => user.username === "admin") || { username: "admin", role: "admin", serverIds: [] };
    return { admin: true, user: admin, legacy: true };
  }
  const username = authSessions.resolve(token, touch);
  if (!username) return null;
  const user = users.find((candidate) => candidate.username === username);
  if (!user) return null;
  return { admin: user.role === "admin", user, cookie: !req.headers.authorization };
}

function requireAdmin(ctx) {
  if (!ctx?.admin) {
    const error = new Error("Admin access required.");
    error.statusCode = 403;
    throw error;
  }
}

function canAccessServer(ctx, server) {
  if (!ctx || !server) return false;
  if (ctx.admin) return true;
  return Array.isArray(ctx.user?.serverIds) && ctx.user.serverIds.includes(server.id);
}

function visibleServers(ctx) {
  return state.servers.filter((server) => canAccessServer(ctx, server));
}

function accessibleServer(ctx, id) {
  const server = state.servers.find((server) => server.id === id && canAccessServer(ctx, server));
  const reason = server && blockedReason(server, templates);
  if (reason) throw Object.assign(new Error(reason), { statusCode: 409 });
  return server;
}

function canCreateTemplate(ctx, template) {
  if (ctx?.admin) return true;
  if (!ctx || !template) return false;
  if (template.runtimeKind === "systemd" || template.native) return false;
  if (["Custom", "Imported"].includes(template.family)) return false;
  return true;
}

function slugify(value) {
  const slug = String(value || "server")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `server-${Date.now()}`;
}

function uniqueId(name) {
  const base = slugify(name);
  let candidate = base;
  let i = 2;
  const reserved = (id) => {
    if (state.servers.some((server) => server.id === id)) return true;
    for (const root of [SERVER_DATA_DIR, BACKUP_DATA_DIR, path.join(DATA_DIR, "mod-staging")]) {
      try { fs.lstatSync(path.join(root, id)); return true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return false;
  };
  // Record-only deletion deliberately retains files. A new same-name server
  // must never inherit that previous owner's data, backups or staging area.
  while (reserved(candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function containerName(id) {
  return `${CONTAINER_PREFIX}${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function templateFor(id) {
  return templates.find((template) => template.id === id) || {
    id, name: "Preserved legacy record", family: "Legacy", fields: [], env: {}, ports: []
  };
}

function serverDir(server) {
  if (server && isNativeServer(server)) {
    const native = nativeFor(server);
    const candidates = [server.dataRoot, native.dataRoot, server.dataMount, native.workingDirectory];
    const root = candidates.find((candidate) => candidate && path.isAbsolute(String(candidate)));
    if (root) return path.resolve(root);
  }
  return managedServerDir(server);
}

function isManagedNativeData(server) {
  return false; // A record-supplied ownership flag is not deletion authority.
}

function managedServerDir(server) {
  return path.join(SERVER_DATA_DIR, server.id);
}

function managedBackupDir(server) {
  return path.join(BACKUP_DATA_DIR, server.id);
}

function normalizeBool(value) {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value == null) return "FALSE";
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase()) ? "TRUE" : "FALSE";
}

function redactEnv(env) {
  const hidden = {};
  for (const [key, value] of Object.entries(env || {})) {
    hidden[key] = /token|password|secret|key/i.test(key) && value ? "********" : value;
  }
  return hidden;
}

async function ensureData() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(SERVER_DATA_DIR, { recursive: true });

  if (!AUTH_DISABLED && !process.env.GAMEPANEL_TOKEN) {
    try {
      authToken = (await fsp.readFile(TOKEN_FILE, "utf8")).trim();
    } catch (_error) {
      authToken = crypto.randomBytes(18).toString("base64url");
      await fsp.writeFile(TOKEN_FILE, `${authToken}\n`, { mode: 0o600 });
    }
  } else {
    authToken = process.env.GAMEPANEL_TOKEN || "";
  }

  try {
    state = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    if (!Array.isArray(state.servers)) throw new Error("Invalid state file; preserved without overwriting.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { servers: [] };
    await saveState();
  }

  await ensureUsers();
}

async function saveState() {
  await saveJson(STATE_FILE, state);
}

async function saveUsers() {
  await saveJson(USERS_FILE, { users });
}

async function ensureUsers() {
  try {
    const payload = JSON.parse(await fsp.readFile(USERS_FILE, "utf8"));
    if (!Array.isArray(payload.users)) throw new Error("Invalid users file; preserved without overwriting.");
    users = payload.users;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    users = [];
  }

  users = users
    .map((user) => ({
      username: normalizeUsername(user.username),
      role: user.role === "admin" ? "admin" : "operator",
      passwordHash: user.passwordHash || "",
      serverIds: Array.isArray(user.serverIds) ? user.serverIds.filter(Boolean) : [],
      createdAt: user.createdAt || new Date().toISOString()
    }))
    .filter((user) => user.username && user.passwordHash);

  if (!users.some((user) => user.role === "admin")) {
    users.unshift({
      username: "admin",
      role: "admin",
      passwordHash: hashPassword(process.env.GAMEPANEL_ADMIN_PASSWORD || authToken || crypto.randomBytes(18).toString("base64url")),
      serverIds: [],
      createdAt: new Date().toISOString()
    });
  }
  await saveUsers();
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      body += chunk;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function docker(args, options = {}) {
  return runProcess("docker", args, options);
}

async function dockerJson(args) {
  const result = await docker(args);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (_error) {
    return null;
  }
}

function parseDockerLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function dockerInventory() {
  const [imagesResult, containersResult, versionResult] = await Promise.all([
    docker(["images", "--format", "{{json .}}"]),
    docker(["ps", "-a", "--format", "{{json .}}"]),
    docker(["version", "--format", "{{.Server.Version}}"])
  ]);
  return {
    ok: imagesResult.code === 0 && containersResult.code === 0,
    docker: versionResult.stdout.trim() || versionResult.stderr.trim(),
    dataDir: DATA_DIR,
    images: parseDockerLines(imagesResult.stdout),
    containers: parseDockerLines(containersResult.stdout)
  };
}

async function dockerMaintenanceAction(body) {
  const action = String(body.action || "");
  if (action === "pull-image") {
    const image = String(body.image || "").trim();
    if (!image) return { ok: false, message: "Image is required." };
    const result = await docker(["pull", image]);
    return { ok: result.code === 0, message: result.stderr || result.stdout };
  }
  if (action === "remove-image") {
    const image = String(body.image || "").trim();
    if (!image) return { ok: false, message: "Image is required." };
    const result = await docker(["image", "rm", image]);
    return { ok: result.code === 0, message: result.stderr || result.stdout };
  }
  if (action === "prune-containers") {
    const result = await docker(["container", "prune", "-f"]);
    return { ok: result.code === 0, message: result.stderr || result.stdout };
  }
  if (action === "prune-images") {
    const result = await docker(["image", "prune", "-f"]);
    return { ok: result.code === 0, message: result.stderr || result.stdout };
  }
  if (action === "prune-unused-images") {
    const result = await docker(["image", "prune", "-a", "-f"]);
    return { ok: result.code === 0, message: result.stderr || result.stdout };
  }
  return { ok: false, message: "Unknown Docker action." };
}

function isNativeServer(server) {
  return server.runtimeKind === "systemd";
}

function nativeFor(server) {
  const template = templateFor(server.templateId);
  return { ...(template.native || {}), ...(server.native || {}) };
}

function isUnturnedServer(server) {
  const template = templateFor(server.templateId);
  return !blockedReason(server, templates) && template.id.startsWith("unturned");
}

function unturnedRoot(server) {
  if (server.templateId === "unturned-dedicated") return path.join(serverDir(server), "install");
  const native = nativeFor(server);
  return native.workingDirectory || path.join(serverDir(server), "U3DS");
}

function unturnedServerName(server) {
  if (server.templateId === "unturned-dedicated") return "vgp";
  return nativeFor(server).serverName || server.native?.serverName || "Default";
}

function unturnedCommandsPath(server) {
  return path.join(unturnedRoot(server), "Servers", unturnedServerName(server), "Server", "Commands.dat");
}

function unturnedWorkshopConfigPath(server) {
  return path.join(unturnedRoot(server), "Servers", unturnedServerName(server), "WorkshopDownloadConfig.json");
}

function unturnedEnvFromCommands(commands) {
  const env = {};
  const keyMap = {
    Name: "SERVERNAME",
    Map: "MAP",
    MaxPlayers: "MAXPLAYERS",
    Mode: "MODE",
    Perspective: "PERSPECTIVE"
  };
  for (const rawLine of String(commands || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.indexOf(" ");
    const command = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1).trim();
    if (keyMap[command] && value) env[keyMap[command]] = value;
  }
  return env;
}

async function readUnturnedEnv(server) {
  // Reviewed container settings are applied on next start, not overwritten by
  // the previous run's Commands.dat while the operator edits them.
  if (server.templateId === "unturned-dedicated") return {};
  if (!isUnturnedServer(server)) return {};
  try {
    return unturnedEnvFromCommands(await fsp.readFile(unturnedCommandsPath(server), "utf8"));
  } catch (_error) {
    return {};
  }
}

async function listUnturnedMaps(server) {
  if (!isUnturnedServer(server)) return [];
  const root = unturnedRoot(server);
  const roots = [
    path.join(root, "Maps"),
    path.join(root, "Servers", unturnedServerName(server), "Workshop", "Maps"),
    path.join(root, "Servers", unturnedServerName(server), "Workshop", "Steam", "content", "304930")
  ];
  const seen = new Set();
  const maps = [];

  const addMap = (name) => {
    const clean = String(name || "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    maps.push(clean);
  };

  for (const rootDir of roots) {
    let entries = [];
    try {
      entries = await fsp.readdir(rootDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(rootDir, entry.name);
      if (!/^\d+$/.test(entry.name) && await pathExists(path.join(entryPath, "Level.dat"))) {
        addMap(entry.name);
        continue;
      }

      let children = [];
      try {
        children = await fsp.readdir(entryPath, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (await pathExists(path.join(entryPath, child.name, "Level.dat"))) addMap(child.name);
      }
    }
  }

  maps.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return maps;
}

async function dynamicFieldOptions(server) {
  const options = {};
  if (isUnturnedServer(server)) {
    const maps = await listUnturnedMaps(server);
    const current = server.env?.MAP || "";
    if (current && !maps.some((map) => map.toLowerCase() === current.toLowerCase())) maps.unshift(current);
    if (maps.length) options.MAP = maps;
  }
  return options;
}

async function syncUnturnedCommands(server) {
  if (!isNativeServer(server) || !isUnturnedServer(server)) return "";
  const commandsPath = unturnedCommandsPath(server);
  const env = server.env || {};
  const updates = new Map([
    ["Name", env.SERVERNAME],
    ["Map", env.MAP],
    ["MaxPlayers", env.MAXPLAYERS],
    ["Mode", env.MODE],
    ["Perspective", env.PERSPECTIVE]
  ].filter(([, value]) => value != null && String(value).trim() !== ""));
  if (!updates.size) return "";

  let content = "";
  try {
    content = await fsp.readFile(commandsPath, "utf8");
  } catch (_error) {
    await fsp.mkdir(path.dirname(commandsPath), { recursive: true });
  }

  const used = new Set();
  const lines = String(content || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const trimmed = line.trim();
      const command = trimmed.split(/\s+/, 1)[0];
      if (!updates.has(command)) return line;
      used.add(command);
      return `${command} ${updates.get(command)}`;
    });
  for (const [command, value] of updates) {
    if (!used.has(command)) lines.push(`${command} ${value}`);
  }
  const nextContent = `${lines.join("\n")}\n`;
  if (nextContent === String(content || "")) return "Unturned settings already match Commands.dat.";

  const runtime = await runtimeFor(server);
  const wasRunning = Boolean(runtime.running);
  const native = nativeFor(server);
  if (wasRunning) await runProcess("systemctl", ["stop", native.service]);
  await fsp.writeFile(commandsPath, nextContent);
  if (wasRunning) await runProcess("systemctl", ["start", native.service]);
  return wasRunning ? "Saved Unturned settings and restarted the server." : "Saved Unturned settings.";
}

async function systemdRuntimeFor(server) {
  const native = nativeFor(server);
  const service = native.service || server.id;
  const cat = await runProcess("systemctl", ["cat", service]);
  if (cat.code !== 0) {
    return { type: "systemd", exists: false, running: false, status: "not installed", name: service };
  }

  const active = await runProcess("systemctl", ["is-active", service]);
  const enabled = await runProcess("systemctl", ["is-enabled", service]);

  const status = active.stdout.trim() || active.stderr.trim() || "inactive";
  return {
    type: "systemd",
    exists: true,
    running: status === "active",
    status,
    enabled: enabled.stdout.trim() || enabled.stderr.trim() || "unknown",
    name: service,
    logFile: native.logFile || ""
  };
}

async function runtimeFor(server) {
  const reason = blockedReason(server, templates);
  if (reason) return { exists: false, running: false, status: "review required", name: server.id, blockedReason: reason };
  if (isNativeServer(server)) return systemdRuntimeFor(server);
  const name = containerName(server.id);
  const result = await docker(["inspect", name]);
  if (result.code !== 0 && !/No such (?:object|container)/i.test(result.stderr)) throw new Error("Docker runtime unavailable; no server data was changed.");
  const inspect = result.code === 0 ? JSON.parse(result.stdout) : null;
  if (!Array.isArray(inspect) || !inspect[0]) {
    return { exists: false, running: false, status: "not created", name };
  }
  const info = inspect[0];
  return {
    exists: true,
    running: Boolean(info.State?.Running),
    tty: Boolean(info.Config?.Tty),
    status: info.State?.Status || "unknown",
    startedAt: info.State?.StartedAt,
    finishedAt: info.State?.FinishedAt,
    restartCount: info.RestartCount || 0,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || "",
    image: info.Config?.Image || server.image,
    name
  };
}

async function decoratedServer(server, includeSecretEnv = false) {
  const blocked = blockedReason(server, templates);
  const env = { ...(server.env || {}), ...(!blocked ? await readUnturnedEnv(server) : {}) };
  return {
    ...server,
    env: includeSecretEnv ? env : redactEnv(env),
    managementBlocked: blocked,
    definition: !blocked ? gameDefinition(templateFor(server.templateId)) : null,
    connectivity: !blocked ? directConnectivity(server.connectivity) : server.connectivity,
    endpoints: !blocked ? directEndpoints(server) : [],
    fieldOptions: !blocked ? await dynamicFieldOptions({ ...server, env }) : {},
    runtime: await runtimeFor(server)
  };
}

function buildServer(input) {
  const template = templateFor(input.templateId);
  if (!templates.includes(template) || input.runtimeKind && input.runtimeKind !== "docker" || input.native) {
    throw Object.assign(new Error("Choose a registered Docker game definition. Native imports require a reviewed runtime profile."), { statusCode: 400 });
  }
  const name = String(input.name || template.name || "Game Server").trim();
  const id = uniqueId(name);
  const env = { ...(template.env || {}), ...(input.env || {}) };
  for (const field of template.fields || []) {
    if (field.type === "boolean") env[field.key] = normalizeBool(env[field.key]);
  }
  gameSettings(template.id, env);
  const built = {
    id,
    name,
    templateId: template.id,
    schemaVersion: 1,
    gameId: template.id,
    runtimeKind: "docker",
    native: template.native || input.native ? { ...(template.native || {}), ...(input.native || {}) } : undefined,
    image: String(input.image || template.image || "").trim(),
    command: input.command == null ? template.command || "" : String(input.command),
    networkMode: input.networkMode || "bridge",
    dataMount: input.dataMount || template.dataMount || "/data",
    ports: validatePorts(input.ports || template.ports || []),
    resources: resources(input.resources || template.resources),
    connectivity: directConnectivity(input.connectivity),
    env,
    autoStart: Boolean(input.autoStart ?? true),
    createdBy: input.createdBy || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  validateProfileRuntime(built);
  return built;
}

function updateServer(server, input) {
  const template = templateFor(input.templateId || server.templateId);
  if (!templates.includes(template) || input.runtimeKind && input.runtimeKind !== "docker" || input.native) throw Object.assign(new Error("Choose a registered Docker game definition."), { statusCode: 400 });
  // Validate before mutating the live record.
  const ports = validatePorts(input.ports || server.ports || []);
  const limits = resources(input.resources || server.resources);
  const connectivity = directConnectivity(input.connectivity || server.connectivity);
  const env = { ...(server.env || {}), ...Object.fromEntries(Object.entries(input.env || {}).filter(([key, value]) => !(value === "********" && /token|password|secret|key/i.test(key) && server.env?.[key]))) };
  gameSettings(template.id, env);
  validateProfileRuntime({ ...server, ...input, templateId: template.id, ports, env });
  server.name = String(input.name ?? server.name).trim();
  server.templateId = template.id;
  server.runtimeKind = input.runtimeKind || server.runtimeKind || template.runtimeKind || "docker";
  if (server.runtimeKind === "systemd") server.native = { ...(template.native || {}), ...(server.native || {}), ...(input.native || {}) };
  server.image = String(input.image ?? server.image ?? template.image ?? "").trim();
  server.command = input.command == null ? server.command || "" : String(input.command);
  server.networkMode = input.networkMode || server.networkMode || "host";
  server.dataMount = input.dataMount || server.dataMount || template.dataMount || "/data";
  server.ports = ports;
  server.resources = limits;
  server.connectivity = connectivity;
  server.gameId = template.id;
  server.schemaVersion = 1;
  server.env = env;
  for (const field of template.fields || []) {
    if (field.type === "boolean" && field.key in server.env) server.env[field.key] = normalizeBool(server.env[field.key]);
  }
  server.autoStart = Boolean(input.autoStart ?? server.autoStart);
  server.updatedAt = new Date().toISOString();
  return server;
}

function validateStart(server) {
  if (!isNativeServer(server) && !server.image) return "Docker image is required.";
  const template = templateFor(server.templateId);
  try { gameSettings(template.id, server.env); validateProfileRuntime(server); } catch (error) { return error.message; }
  for (const field of template.fields || []) {
    if (field.requiredTrue && normalizeBool(server.env?.[field.key]) !== "TRUE") {
      return `${field.label} must be enabled before starting this server.`;
    }
  }
  return "";
}

async function startNativeServer(server) {
  const native = nativeFor(server);
  await syncUnturnedCommands(server);
  await syncNativeAutostart(server);
  const result = await runProcess("systemctl", ["start", native.service]);
  return { ok: result.code === 0, message: result.stderr || result.stdout || `Started ${native.service}.` };
}

async function stopNativeServer(server) {
  const native = nativeFor(server);
  const serverStop = await runProcess("systemctl", ["stop", native.service]);
  let message = serverStop.stderr || serverStop.stdout || `Stopped ${native.service}.`;
  return { ok: serverStop.code === 0, message };
}

async function sendNativeConsole(server, text) {
  const native = nativeFor(server);
  const command = String(text || "").replace(/\r?\n/g, "").trim();
  if (!command) return "No command sent.";
  if (command.length > 200) return "Command rejected: keep it to one short line.";
  if (!native.screenSession || !native.screenUser) return "This native server has no screen console mapping.";
  const result = await runProcess("runuser", [
    "-u",
    native.screenUser,
    "--",
    "screen",
    "-S",
    native.screenSession,
    "-p",
    "0",
    "-X",
    "stuff",
    `${command}\r`
  ]);
  return result.stderr || result.stdout || (result.code === 0 ? "Sent." : `screen returned ${result.code}`);
}

async function syncNativeAutostart(server) {
  const native = nativeFor(server);
  const action = server.autoStart ? "enable" : "disable";
  const results = [];
  if (native.service) results.push(await runProcess("systemctl", [action, native.service]));
  return results;
}

async function startServer(server) {
  const blocked = blockedReason(server, templates);
  if (blocked) throw new Error(blocked);
  const validation = validateStart(server);
  if (validation) return { ok: false, message: validation };
  if (isNativeServer(server)) return startNativeServer(server);
  if (gameProfiles[server.templateId]) {
    const installed = await docker(["image", "inspect", server.image]);
    if (installed.code !== 0) return { ok: false, message: "Prepare this reviewed runtime first: docker exec versagamepanel /app/deploy/container/entrypoint.sh prepare-runtime all (container install), or see docs/DEDICATED_GAMES.md for native builds. No external image was pulled." };
  }

  const name = containerName(server.id);
  const args = dockerRunArgs(server, { name, dataDirectory: hostStoragePath(serverDir(server), DATA_DIR, process.env.GAMEPANEL_HOST_DATA_DIR),
    runAs: templateFor(server.templateId).family === "Minecraft" || gameProfiles[server.templateId] ? `${process.getuid()}:${process.getgid()}` : "" });
  const runtime = await runtimeFor(server);
  if (runtime.exists && runtime.running) return { ok: true, message: "Already running." };
  if (runtime.exists) {
    const removed = await removeContainer(server);
    if (!removed.ok) return removed;
  }

  await fsp.mkdir(serverDir(server), { recursive: true });
  const result = await docker(args);
  return { ok: result.code === 0, message: result.stderr || result.stdout };
}

async function stopServer(server) {
  if (isNativeServer(server)) return stopNativeServer(server);
  const runtime = await runtimeFor(server);
  if (!runtime.exists) return { ok: true, message: "Container does not exist." };
  const result = await docker(["stop", "--time", "120", containerName(server.id)]);
  if (result.code === 0 && gameProfiles[server.templateId]) {
    const checked = await docker(["inspect", "--format", "{{.State.ExitCode}}", containerName(server.id)]);
    if (checked.code !== 0 || checked.stdout.trim() !== "0") return { ok: false, message: "Game did not exit cleanly. Data and container retained; inspect logs before restarting or removing it." };
  }
  return { ok: result.code === 0, message: result.stderr || result.stdout };
}

async function removeContainer(server) {
  if (isNativeServer(server)) return { ok: true, message: "Native service left installed; only the panel record will be removed." };
  const runtime = await runtimeFor(server);
  if (!runtime.exists) return { ok: true, message: "Container does not exist." };
  if (runtime.running) {
    const stopped = await stopServer(server);
    if (!stopped.ok) return stopped;
  }
  const result = await docker(["rm", containerName(server.id)]);
  return { ok: result.code === 0, message: result.stderr || result.stdout };
}

async function removeServerManagedFiles(server, { data = false, backups = false } = {}) {
  const removed = [];
  const kept = [];
  await removePath(path.join(DATA_DIR, "mod-staging", server.id));
  if (data) {
    if (isNativeServer(server) && !isManagedNativeData(server)) {
      kept.push(`${serverDir(server)} (native data is not removed by panel delete)`);
    } else {
      await removePath(serverDir(server));
      removed.push(serverDir(server));
    }
  }
  if (backups) {
    await removePath(managedBackupDir(server));
    removed.push(managedBackupDir(server));
  }
  return { removed, kept };
}

function isMinecraftServer(server) {
  const template = templateFor(server.templateId);
  return template.family === "Minecraft";
}

function worldNameFor(server) {
  return safeRel(server.env?.LEVEL || server.env?.LEVEL_NAME || "world") || "world";
}

async function worldDir(server) {
  const root = serverDir(server);
  await fsp.mkdir(root, { recursive: true });
  return resolveSafePath(root, worldNameFor(server), { allowMissing: true });
}

async function listServerFiles(server, rel = "") {
  const root = serverDir(server);
  await fsp.mkdir(root, { recursive: true });
  const dir = await resolveSafePath(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name === ".uploads" || entry.name === ".backups") continue;
    const fullPath = path.join(dir, entry.name);
    const stats = await fsp.lstat(fullPath);
    items.push({
      name: entry.name,
      path: safeRel(path.posix.join(safeRel(rel), entry.name)),
      type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString()
    });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: safeRel(rel), items };
}

async function removePath(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

async function copyPath(source, target) {
  await removePath(target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function contentTypeFor(filePath) {
  const lower = filePath.toLowerCase();
  const ext = path.extname(lower);
  if (ext === ".zip") return "application/zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip";
  if (ext === ".json") return "application/json";
  if (ext === ".txt" || ext === ".properties" || ext === ".log") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function zipPath(source, zipFile) {
  await assertNoSymlinksInTree(source);
  await fsp.mkdir(path.dirname(zipFile), { recursive: true });
  const sourceName = path.basename(source);
  const cwd = path.dirname(source);
  const result = await runProcess("zip", ["-qr", zipFile, sourceName], { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "zip failed");
  return zipFile;
}

async function streamFile(res, filePath, downloadName = path.basename(filePath), temporary = false) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Choose a regular file to download.");
    if (temporary) res.once("close", () => removePath(filePath).catch(() => {}));
    const fallbackName = String(downloadName).replace(/[^\x20-\x7e]|["\\]/g, "_");
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "content-length": stats.size,
      "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    });
    const input = handle.createReadStream();
    input.on("error", (error) => res.destroy(error));
    res.once("close", () => input.destroy());
    input.pipe(res);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function findWorldRoot(root) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    const levelDat = path.join(current.dir, "level.dat");
    if (await pathExists(levelDat)) return current.dir;
    if (current.depth >= 4) continue;
    let entries = [];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("__MACOSX")) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return "";
}

async function createWorldBackup(server, reason = "manual") {
  if ((await runtimeFor(server)).running) throw Object.assign(new Error("Please stop the server before backing up its world so all saves are consistent."), { statusCode: 409 });
  const source = await worldDir(server);
  if (!(await pathExists(source))) return null;
  const backupsDir = path.join(DATA_DIR, "backups", server.id);
  const file = path.join(backupsDir, `${reason}-${stamp()}.zip`);
  return zipPath(source, file);
}

async function listBackups(server) {
  const backupsDir = path.join(DATA_DIR, "backups", server.id);
  await fsp.mkdir(backupsDir, { recursive: true });
  const entries = await fsp.readdir(backupsDir, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const isWorldBackup = lower.endsWith(".zip");
    const isRootBackup = lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
    if (!isWorldBackup && !isRootBackup) continue;
    const fullPath = path.join(backupsDir, entry.name);
    const stats = await fsp.stat(fullPath);
    backups.push({
      name: entry.name,
      size: stats.size,
      createdAt: stats.mtime.toISOString(),
      kind: isRootBackup ? "server-root" : "world",
      restorable: isWorldBackup
    });
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return backups;
}

async function uploadWorld(req, server) {
  if (!isMinecraftServer(server)) throw new Error("World uploads are only available for Minecraft servers.");
  const uploadRoot = path.join(DATA_DIR, ".uploads", `${server.id}-${crypto.randomUUID()}`);
  const extractRoot = path.join(uploadRoot, "extract");
  await fsp.mkdir(uploadRoot, { recursive: true });
  try {
    const uploads = await collectMultipart(req, path.join(uploadRoot, "in"));
    if (!uploads.length) throw new Error("No world files were uploaded.");

    let searchRoot = path.join(uploadRoot, "in");
    const zip = uploads.length === 1 && uploads[0].filename.toLowerCase().endsWith(".zip") ? uploads[0].path : "";
    if (zip) {
      await extractZipSafely(zip, extractRoot);
      searchRoot = extractRoot;
    }

    const foundRoot = await findWorldRoot(searchRoot);
    if (!foundRoot) throw new Error("No Minecraft world found. Upload a folder or ZIP containing level.dat.");

    const runtime = await runtimeFor(server);
    const wasRunning = runtime.running;
    if (wasRunning) await stopServer(server);
    await createWorldBackup(server, "before-world-upload");
    await copyPath(foundRoot, await worldDir(server));
    if (wasRunning) await startServer(server);
    return { ok: true, message: `Uploaded world to ${worldNameFor(server)}.`, restarted: wasRunning };
  } finally {
    await removePath(uploadRoot);
  }
}

async function generateWorld(server) {
  if (!isMinecraftServer(server)) throw new Error("World generation is only available for Minecraft servers.");
  const runtime = await runtimeFor(server);
  const wasRunning = runtime.running;
  if (wasRunning) await stopServer(server);
  await createWorldBackup(server, "before-world-generate");
  await removePath(await worldDir(server));
  if (wasRunning) await startServer(server);
  return { ok: true, message: wasRunning ? "Removed the old world and restarted the server to generate a new one." : "Removed the old world. It will generate on next start." };
}

async function restoreBackup(server, name) {
  const backupsDir = path.join(DATA_DIR, "backups", server.id);
  const zip = await resolveSafePath(backupsDir, name);
  if (!(await pathExists(zip)) || !zip.endsWith(".zip")) throw new Error("Backup not found.");
  const extractRoot = path.join(DATA_DIR, ".uploads", `restore-${server.id}-${crypto.randomUUID()}`);
  try {
    await extractZipSafely(zip, extractRoot);
    const foundRoot = await findWorldRoot(extractRoot);
    if (!foundRoot) throw new Error("Backup did not contain a Minecraft world.");
    const runtime = await runtimeFor(server);
    const wasRunning = runtime.running;
    if (wasRunning) {
      const stopped = await stopServer(server);
      if (!stopped.ok || (await runtimeFor(server)).running) throw new Error("Could not stop server safely; restore was not applied.");
    }
    await createWorldBackup(server, "before-backup-restore");
    await replaceDirectory(foundRoot, await worldDir(server));
    if (wasRunning) {
      const started = await startServer(server);
      if (!started.ok) return { ok: false, message: "World restored but server could not restart. Files are preserved; inspect logs.", restarted: false };
    }
    return { ok: true, message: `Restored ${name}.`, restarted: wasRunning };
  } finally {
    await removePath(extractRoot);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minecraftLogPath(server) {
  return path.join(serverDir(server), "logs", "latest.log");
}

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (_error) {
    return 0;
  }
}

async function fileTail(filePath, maxBytes = 200000, startOffset = 0) {
  let handle = null;
  try {
    const stats = await fsp.stat(filePath);
    const fromOffset = stats.size < startOffset ? 0 : startOffset;
    const begin = Math.max(fromOffset, stats.size - maxBytes);
    const length = stats.size - begin;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    handle = await fsp.open(filePath, "r");
    await handle.read(buffer, 0, length, begin);
    return buffer.toString("utf8");
  } catch (_error) {
    return "";
  } finally {
    await handle?.close();
  }
}

function minecraftStartupSignals(logText = "") {
  const text = String(logText || "");
  const failedDatapacks = /Failed to load datapacks/i.test(text);
  const brokenLevelData = /Unknown registry key|worldgen\/biome_source|getLevelDataAndDimensions|Failed to load registries|Failed to load level/i.test(text);
  return {
    done: /Done \([^)]+\)! For help, type "help"/.test(text),
    badWorldLevelDat: failedDatapacks && brokenLevelData,
    failedDatapacks,
    unsupportedClassMajor: /Unsupported class file major version/i.test(text),
    pluginLoadErrors: /Could not load ['"].*plugins|Error occurred while enabling/i.test(text)
  };
}

function startupSummary(result) {
  if (!result) return null;
  return {
    done: Boolean(result.done),
    running: Boolean(result.running),
    status: result.status || "unknown",
    badWorldLevelDat: Boolean(result.badWorldLevelDat),
    unsupportedClassMajor: Boolean(result.unsupportedClassMajor),
    pluginLoadErrors: Boolean(result.pluginLoadErrors),
    timedOut: Boolean(result.timedOut),
    elapsedMs: result.elapsedMs || 0
  };
}

async function waitForMinecraftStartup(server, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90000;
  const intervalMs = options.intervalMs ?? 5000;
  const logOffset = options.logOffset ?? 0;
  const started = Date.now();
  let lastLog = "";
  let runtime = await runtimeFor(server);

  while (Date.now() - started <= timeoutMs) {
    lastLog = await fileTail(minecraftLogPath(server), 220000, logOffset);
    const signals = minecraftStartupSignals(lastLog);
    runtime = await runtimeFor(server);
    const elapsedMs = Date.now() - started;
    const payload = {
      ...signals,
      running: Boolean(runtime.running),
      status: runtime.status || "unknown",
      elapsedMs
    };
    if (signals.done || signals.badWorldLevelDat) return payload;
    if (runtime.exists && !runtime.running && elapsedMs > 3000) return payload;
    await sleep(intervalMs);
  }

  const signals = minecraftStartupSignals(lastLog);
  return {
    ...signals,
    running: Boolean(runtime.running),
    status: runtime.status || "unknown",
    timedOut: true,
    elapsedMs: Date.now() - started
  };
}

async function resumeStoppedServer(server, previousRuntime) {
  if (isDockerServerRecord(server) && previousRuntime?.exists) {
    const result = await docker(["start", containerName(server.id)]);
    if (result.code === 0) return { ok: true, message: result.stderr || result.stdout || "Started existing container." };
  }
  return startServer(server);
}

async function quarantineWorldLevelDat(server) {
  const world = await worldDir(server);
  const candidates = [path.join(world, "level.dat"), path.join(world, "Level.dat")];
  let levelDat = "";
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      levelDat = candidate;
      break;
    }
  }
  if (!levelDat) return null;

  const target = path.join(path.dirname(levelDat), `${path.basename(levelDat)}.bad-${stamp()}`);
  await fsp.rename(levelDat, target);
  await removePath(path.join(path.dirname(levelDat), "session.lock"));
  await runProcess("chown", ["-R", "1000:1000", path.dirname(levelDat)]);
  return path.basename(target);
}

async function recoverMinecraftAfterRestore(server, previousRuntime) {
  const recovery = { notes: [], warnings: [] };
  const firstOffset = await fileSize(minecraftLogPath(server));
  const start = await resumeStoppedServer(server, previousRuntime);
  recovery.started = Boolean(start.ok);
  recovery.startMessage = start.message || "";
  if (!start.ok) {
    recovery.warnings.push(`Minecraft could not be restarted after restore: ${start.message || "unknown error"}`);
    return recovery;
  }

  const first = await waitForMinecraftStartup(server, { logOffset: firstOffset });
  recovery.startup = startupSummary(first);

  if (first.badWorldLevelDat) {
    const quarantined = await quarantineWorldLevelDat(server);
    if (quarantined) {
      recovery.notes.push(`Quarantined ${quarantined} so Minecraft can regenerate ${worldNameFor(server)}.`);
      await stopServer(server);
      const retryOffset = await fileSize(minecraftLogPath(server));
      const retryStart = await resumeStoppedServer(server, previousRuntime);
      recovery.restarted = Boolean(retryStart.ok);
      recovery.retryStartMessage = retryStart.message || "";
      if (retryStart.ok) {
        recovery.retry = startupSummary(await waitForMinecraftStartup(server, { logOffset: retryOffset }));
      } else {
        recovery.warnings.push(`Minecraft could not restart after quarantining level.dat: ${retryStart.message || "unknown error"}`);
      }
    } else {
      recovery.warnings.push("Minecraft reported bad world data, but no level.dat file was found to quarantine.");
    }
  }

  const finalStartup = recovery.retry || recovery.startup;
  if (finalStartup?.unsupportedClassMajor) {
    recovery.warnings.push("Some plugins still report unsupported Java/class-file errors; check Log and use compatible plugin builds or a compatible Java image.");
  }
  if (finalStartup?.timedOut) {
    recovery.warnings.push("Minecraft did not print Done before the startup check timed out; check Log for the next blocker.");
  }
  if (finalStartup && !finalStartup.done && !finalStartup.running) {
    recovery.warnings.push("Minecraft stopped during startup; check Log for the latest error.");
  }
  return recovery;
}

async function restoreServerRootZip(server, zipPath) {
  if (!isMinecraftServer(server)) throw new Error("Server-root restore is only available for Minecraft servers.");
  if (!String(zipPath || "").toLowerCase().endsWith(".zip")) throw new Error("Choose a .zip file to restore.");
  if (!(await pathExists(zipPath))) throw new Error("Zip file not found.");

  const restoreStage = path.join(DATA_DIR, ".uploads", `root-restore-stage-${server.id}-${crypto.randomUUID()}`);
  const topLevels = new Set();
  const root = serverDir(server);
  const backupDir = path.join(BACKUP_DATA_DIR, server.id);
  const backup = path.join(backupDir, `server-root-before-restore-${stamp()}.tar.gz`);
  let runtime;
  let wasRunning = false;
  try {
    // Validate and fully stage the same archive before stopping or changing the server.
    const manifest = await extractZipSafely(zipPath, restoreStage);
    for (const entry of manifest.entries) topLevels.add(entry.relative.split("/")[0]);
    if (!["server.properties", "plugins", "config", "world", "minigame_hub"].some((name) => topLevels.has(name))) {
      throw new Error("Zip does not look like a Minecraft server root.");
    }
    await resolveSafePath(root);
    await fsp.mkdir(backupDir, { recursive: true });
    runtime = await runtimeFor(server);
    wasRunning = Boolean(runtime.running);
    if (wasRunning) await stopServer(server);

    const tar = await runProcess("tar", ["-C", root, "--exclude=./logs", "-czf", backup, "."]);
    if (tar.code !== 0) throw new Error(tar.stderr || tar.stdout || "Could not create pre-restore backup.");

    const sourceBase = path.basename(zipPath);
    for (const top of topLevels) {
      if (top === sourceBase) continue;
      const destination = await resolveSafePath(root, top, { allowMissing: true, allowLeafSymlink: true });
      await removePath(destination);
      await copyPath(path.join(restoreStage, top), destination);
    }
  } catch (error) {
    if (wasRunning) await resumeStoppedServer(server, runtime);
    throw error;
  } finally {
    await removePath(restoreStage);
  }

  await runProcess("chown", ["-R", "1000:1000", root]);
  const recovery = wasRunning ? await recoverMinecraftAfterRestore(server, runtime) : null;

  const recoveryNotes = recovery ? [...(recovery.notes || []), ...(recovery.warnings || [])] : [];
  return {
    ok: true,
    message: [
      wasRunning ? "Restored server root zip, backed up the old root, and restarted the server." : "Restored server root zip and backed up the old root.",
      ...recoveryNotes
    ].join(" "),
    backup: path.basename(backup),
    restored: [...topLevels],
    recovery
  };
}

function isDockerServerRecord(server) {
  return !isNativeServer(server);
}

async function handleApi(req, res, urlObject) {
  if (urlObject.pathname === "/api/auth/state") {
    return json(res, 200, { required: !AUTH_DISABLED, users: true });
  }

  if (urlObject.pathname === "/api/auth/login" && req.method === "POST") {
    if (req.headers.origin && !sameOrigin(req, PUBLIC_ORIGIN) || req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "Please sign in from the panel itself." });
    const ip = req.socket.remoteAddress; // Never trust arbitrary forwarded-IP headers.
    if (loginFailures.blocked(ip) || loginsInFlight >= 2) {
      res.setHeader("retry-after", "300");
      return json(res, 429, { error: "Too many sign-in attempts. Please wait a few minutes and try again." });
    }
    loginsInFlight += 1;
    try {
      const body = await readBody(req, 8192);
      if (body.sessionMode === "cookie" && !sameOrigin(req, PUBLIC_ORIGIN)) return json(res, 403, { error: "Please sign in from the panel itself." });
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const user = users.find((candidate) => candidate.username === username);
      const passwordMatches = await verifyPassword(password, user?.passwordHash || dummyPasswordHash);
      const legacyMatches = LEGACY_TOKEN_ENABLED && body.token && authToken && safeEqual(String(body.token), authToken);
      const authenticated = AUTH_DISABLED ? users.find((candidate) => candidate.username === "admin") : passwordMatches && user || legacyMatches && users.find((candidate) => candidate.username === "admin");
      if (!authenticated) {
        loginFailures.fail(ip);
        return json(res, 401, { error: "Invalid username or password." });
      }
      const token = issueSession(authenticated);
      if (body.sessionMode === "cookie") {
        res.setHeader("set-cookie", sessionCookie(token, Boolean(req.socket.encrypted) || PUBLIC_ORIGIN.startsWith("https:")));
        return json(res, 200, { ok: true, user: publicUser(authenticated) });
      }
      return json(res, 200, { ok: true, token, user: publicUser(authenticated) });
    } finally { loginsInFlight -= 1; }
  }

  const ctx = authContext(req, urlObject);
  if (!ctx) return json(res, 401, { error: "Unauthorized" });
  if (ctx.cookie && !["GET", "HEAD"].includes(req.method) && !sameOrigin(req, PUBLIC_ORIGIN)) return json(res, 403, { error: "Please submit this action from the panel itself." });

  if (urlObject.pathname === "/api/auth/logout" && req.method === "POST") {
    authSessions.revoke(tokenInput(req, urlObject));
    res.setHeader("set-cookie", sessionCookie("", Boolean(req.socket.encrypted) || PUBLIC_ORIGIN.startsWith("https:")));
    return json(res, 200, { ok: true });
  }

  if (urlObject.pathname === "/api/auth/password" && req.method === "POST") {
    const body = await readBody(req, 8192);
    if (!validNewPassword(body.newPassword)) return json(res, 400, { error: "Choose a password between 12 and 256 characters." });
    if (!await verifyPassword(String(body.currentPassword || ""), ctx.user.passwordHash)) return json(res, 400, { error: "Your current password did not match." });
    ctx.user.passwordHash = hashPassword(body.newPassword);
    await saveUsers();
    authSessions.revokeUser(ctx.user.username);
    res.setHeader("set-cookie", sessionCookie("", Boolean(req.socket.encrypted) || PUBLIC_ORIGIN.startsWith("https:")));
    return json(res, 200, { ok: true, message: "Password changed. Please sign in again." });
  }

  if (urlObject.pathname === "/api/auth/me" && req.method === "GET") {
    return json(res, 200, { user: publicUser(ctx.user), admin: Boolean(ctx.admin) });
  }

  const userMatch = urlObject.pathname.match(/^\/api\/users(?:\/([^/]+))?$/);
  if (userMatch) {
    requireAdmin(ctx);
    if (req.method === "GET" && !userMatch[1]) return json(res, 200, { users: users.map(publicUser) });
    if (req.method === "POST" && !userMatch[1]) {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      if (!username || !validNewPassword(password)) return json(res, 400, { error: "Provide a username and a password between 12 and 256 characters." });
      if (users.some((user) => user.username === username)) return json(res, 409, { error: "User already exists." });
      users.push({
        username,
        role: body.role === "admin" ? "admin" : "operator",
        passwordHash: hashPassword(password),
        serverIds: Array.isArray(body.serverIds) ? body.serverIds.filter((id) => state.servers.some((server) => server.id === id)) : [],
        createdAt: new Date().toISOString()
      });
      await saveUsers();
      return json(res, 201, { users: users.map(publicUser) });
    }
    if (userMatch[1] && req.method === "PUT") {
      const username = normalizeUsername(decodeURIComponent(userMatch[1]));
      const user = users.find((candidate) => candidate.username === username);
      if (!user) return json(res, 404, { error: "User not found." });
      const body = await readBody(req);
      const nextRole = body.role == null ? user.role : body.role === "admin" ? "admin" : "operator";
      if (body.password && !validNewPassword(body.password)) return json(res, 400, { error: "Choose a password between 12 and 256 characters." });
      if (!users.some((candidate) => candidate.username !== username && candidate.role === "admin") && nextRole !== "admin") {
        return json(res, 400, { error: "At least one admin user is required." });
      }
      const revoke = Boolean(body.password) || user.role !== nextRole;
      user.role = nextRole;
      if (Array.isArray(body.serverIds)) user.serverIds = body.serverIds.filter((id) => state.servers.some((server) => server.id === id));
      if (body.password) user.passwordHash = hashPassword(String(body.password));
      await saveUsers();
      if (revoke) authSessions.revokeUser(user.username);
      consoleTransport?.revalidate();
      return json(res, 200, { users: users.map(publicUser) });
    }
    if (userMatch[1] && req.method === "DELETE") {
      const username = normalizeUsername(decodeURIComponent(userMatch[1]));
      const user = users.find((candidate) => candidate.username === username);
      if (!user) return json(res, 404, { error: "User not found." });
      if (user.username === ctx.user.username) return json(res, 400, { error: "You cannot delete your current user." });
      if (user.role === "admin" && !users.some((candidate) => candidate.username !== username && candidate.role === "admin")) {
        return json(res, 400, { error: "At least one admin user is required." });
      }
      users = users.filter((candidate) => candidate.username !== username);
      await saveUsers();
      authSessions.revokeUser(username);
      return json(res, 200, { users: users.map(publicUser) });
    }
    return json(res, 405, { error: "Method not allowed" });
  }

  if (urlObject.pathname === "/api/templates") {
    const visibleTemplateIds = new Set(visibleServers(ctx).map((server) => server.templateId));
    const visibleTemplates = ctx.admin ? templates : templates.filter((template) => canCreateTemplate(ctx, template) || visibleTemplateIds.has(template.id));
    return json(res, 200, { templates: visibleTemplates.map((template) => ({ ...template, networkMode: "bridge", definition: gameDefinition(template) })) });
  }

  if (urlObject.pathname === "/api/status") {
    const dockerVersion = await docker(["version", "--format", "{{.Server.Version}}"]);
    const dockerPs = await docker(["ps", "--format", "{{json .}}"]);
    return json(res, 200, {
      ok: dockerVersion.code === 0,
      docker: dockerVersion.stdout.trim() || dockerVersion.stderr.trim(),
      dataDir: DATA_DIR,
      containers: parseDockerLines(dockerPs.stdout)
    });
  }

  if (urlObject.pathname === "/api/docker" && req.method === "GET") {
    requireAdmin(ctx);
    return json(res, 200, await dockerInventory());
  }

  if (urlObject.pathname === "/api/docker/actions" && req.method === "POST") {
    requireAdmin(ctx);
    const payload = await dockerMaintenanceAction(await readBody(req));
    return json(res, payload.ok ? 200 : 400, payload);
  }

  if (urlObject.pathname === "/api/servers" && req.method === "GET") {
    const servers = [];
    for (const server of visibleServers(ctx)) servers.push(await decoratedServer(server));
    return json(res, 200, { servers });
  }

  if (urlObject.pathname === "/api/servers" && req.method === "POST") {
    const body = await readBody(req);
    const template = templateFor(body.templateId);
    if (!canCreateTemplate(ctx, template)) return json(res, 403, { error: "This user cannot create that server type." });
    body.templateId = template.id;
    if (!ctx.admin) {
      body.image = template.image;
      body.command = template.command || "";
      body.networkMode = "bridge";
      body.dataMount = template.dataMount || "/data";
      body.ports = template.ports || [];
      body.runtimeKind = template.runtimeKind || "docker";
      body.native = undefined;
      body.createdBy = ctx.user.username;
    }
    const server = buildServer(body);
    state.servers.push(server);
    await saveState();
    if (!ctx.admin && !ctx.user.serverIds.includes(server.id)) {
      ctx.user.serverIds.push(server.id);
      await saveUsers();
    }
    if (isNativeServer(server)) await syncNativeAutostart(server);
    return json(res, 201, { server: await decoratedServer(server) });
  }

  const consoleTicketMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/console-ticket$/);
  if (consoleTicketMatch && req.method === "POST") {
    const server = accessibleServer(ctx, consoleTicketMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    const { mode } = await readBody(req);
    if (!["console", "logs"].includes(mode)) return json(res, 400, { error: "Choose console or logs." });
    res.setHeader("cache-control", "no-store");
    return json(res, 201, consoleTickets.issue({
      serverId: server.id, mode, authorization: req.headers.authorization || `Bearer ${tokenInput(req, urlObject)}`
    }));
  }

  const modsMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/mods(?:\/(inspect|plans|backups)(?:\/([a-f0-9-]+)(?:\/(apply|download))?)?)?$/);
  if (modsMatch) {
    const server = accessibleServer(ctx, modsMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    if (server.templateId !== "minecraft-paper") return json(res, 400, { error: "Custom mod inspection uses Minecraft Java, not Bedrock or auto-downloaded packs." });
    const plans = modPlans({ server, stageRoot: path.join(DATA_DIR, "mod-staging", server.id), dataRoot: serverDir(server), backupRoot: managedBackupDir(server), runtime: () => runtimeFor(server), save: saveState, beforeApply: async () => { if (await pathExists(await worldDir(server))) await createWorldBackup(server, "before-mods"); } });
    if (req.method === "GET" && modsMatch[2] === "backups" && modsMatch[4] === "download") {
      const temporary = path.join(DATA_DIR, ".uploads", `mods-${server.id}-${crypto.randomUUID()}.zip`);
      await zipPath(await plans.backupDirectory(modsMatch[3]), temporary);
      return streamFile(res, temporary, `prior-mods-${modsMatch[3]}.zip`, true);
    }
    if (req.method === "GET" && modsMatch[2] === "plans") return json(res, 200, { plans: await plans.list(), backups: await plans.backups() });
    if (req.method === "POST" && modsMatch[2] === "inspect") return json(res, 201, { plan: await plans.inspect(req) });
    if (req.method === "POST" && modsMatch[2] === "plans" && modsMatch[4] === "apply") return json(res, 200, await plans.apply(modsMatch[3], await readBody(req)));
    if (req.method === "DELETE" && modsMatch[2] === "plans" && modsMatch[3]) { await plans.discard(modsMatch[3]); return json(res, 200, { ok: true }); }
    return json(res, 405, { error: "Method not allowed" });
  }

  const rootRestoreMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/root\/restore$/);
  if (rootRestoreMatch) {
    const server = accessibleServer(ctx, rootRestoreMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    try {
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("multipart/form-data")) {
        const uploadRoot = path.join(DATA_DIR, ".uploads", `root-restore-${server.id}-${crypto.randomUUID()}`);
        let payload;
        try {
          const uploads = await collectMultipart(req, uploadRoot);
          const zip = uploads.find((file) => file.filename.toLowerCase().endsWith(".zip"));
          if (!zip) throw new Error("No .zip file was uploaded.");
          payload = await restoreServerRootZip(server, zip.path);
        } finally {
          await removePath(uploadRoot);
        }
        return json(res, 200, payload);
      }
      const body = await readBody(req);
      const rel = safeRel(body.path || "");
      if (!rel) throw new Error("Zip path is required.");
      return json(res, 200, await restoreServerRootZip(server, await resolveSafePath(serverDir(server), rel)));
    } catch (error) {
      return json(res, 400, { error: error.message || String(error) });
    }
  }

  const filesMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/files(?:\/download)?$/);
  if (filesMatch) {
    const server = accessibleServer(ctx, filesMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    const rel = urlObject.searchParams.get("path") || "";
    try {
      if (req.method === "GET" && urlObject.pathname.endsWith("/download")) {
        const root = serverDir(server);
        const target = await resolveSafePath(root, rel);
        const stats = await fsp.lstat(target);
        if (stats.isDirectory()) {
          const tempZip = path.join(DATA_DIR, ".uploads", `${server.id}-${stamp()}-${path.basename(target) || "files"}.zip`);
          await zipPath(target, tempZip);
          return await streamFile(res, tempZip, `${path.basename(target) || server.id}.zip`, true);
        }
        return await streamFile(res, target);
      }
      if (req.method === "GET") return json(res, 200, await listServerFiles(server, rel));
      if (gameProfiles[server.templateId] && ["POST", "DELETE"].includes(req.method) && (await runtimeFor(server)).running) {
        return json(res, 409, { error: "Please stop the game before changing its files." });
      }
      if (req.method === "POST") {
        const root = serverDir(server);
        await fsp.mkdir(root, { recursive: true });
        const destination = await resolveSafePath(root, rel, { allowMissing: true });
        const uploads = await collectMultipart(req, destination);
        return json(res, 200, { ok: true, uploaded: uploads.map((file) => file.rel) });
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        const relative = safeRel(body.path || rel);
        if (!relative) throw new Error("Choose a file or folder to delete.");
        const target = await resolveSafePath(serverDir(server), relative, { allowLeafSymlink: true });
        await removePath(target);
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, 400, { error: error.message || String(error) });
    }
  }

  const worldMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/world\/(upload|generate|download)$/);
  if (worldMatch) {
    const server = accessibleServer(ctx, worldMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    try {
      if (worldMatch[2] === "upload" && req.method === "POST") return json(res, 200, await uploadWorld(req, server));
      if (worldMatch[2] === "generate" && req.method === "POST") return json(res, 200, await generateWorld(server));
      if (worldMatch[2] === "download" && req.method === "GET") {
        const source = await worldDir(server);
        if (!(await pathExists(source))) return json(res, 404, { error: "World not found" });
        const tempZip = path.join(DATA_DIR, ".uploads", `${server.id}-${worldNameFor(server)}-${stamp()}.zip`);
        await zipPath(source, tempZip);
        return await streamFile(res, tempZip, `${server.id}-${worldNameFor(server)}.zip`, true);
      }
    } catch (error) {
      return json(res, 400, { error: error.message || String(error) });
    }
  }

  const snapshotMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/snapshots(?:\/download)?$/);
  if (snapshotMatch) {
    const server = accessibleServer(ctx, snapshotMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    const backupRoot = managedBackupDir(server);
    await fsp.mkdir(backupRoot, { recursive: true });
    await fsp.mkdir(serverDir(server), { recursive: true });
    const snapshots = gameSnapshots({ server, dataRoot: serverDir(server), backupRoot, zip: zipPath });
    if (req.method === "GET" && urlObject.pathname.endsWith("/download")) return streamFile(res, await snapshots.file(urlObject.searchParams.get("name") || ""));
    if (req.method === "GET") return json(res, 200, { snapshots: await snapshots.list() });
    if (req.method === "POST") {
      if ((await runtimeFor(server)).running) return json(res, 409, { error: "Please stop the game before creating or restoring a consistent save snapshot." });
      const body = await readBody(req);
      if (body.action === "create") return json(res, 201, { ok: true, name: await snapshots.create() });
      if (body.action === "restore") {
        const restored = await snapshots.restore(body.name || "");
        server.env = { ...server.env, ...restored.settings };
        await saveState();
        return json(res, 200, { ok: true, message: "Save snapshot restored. The game remains stopped.", before: restored.before });
      }
      return json(res, 400, { error: "Choose create or restore." });
    }
    return json(res, 405, { error: "Method not allowed" });
  }

  const backupsMatch = urlObject.pathname.match(/^\/api\/servers\/([^/]+)\/backups(?:\/download)?$/);
  if (backupsMatch) {
    const server = accessibleServer(ctx, backupsMatch[1]);
    if (!server) return json(res, 404, { error: "Server not found" });
    try {
      if (req.method === "GET" && urlObject.pathname.endsWith("/download")) {
        const name = urlObject.searchParams.get("name") || "";
        const backupRoot = path.join(DATA_DIR, "backups", server.id);
        const file = await resolveSafePath(backupRoot, name);
        return await streamFile(res, file, name);
      }
      if (req.method === "GET") return json(res, 200, { backups: await listBackups(server) });
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "restore") return json(res, 200, await restoreBackup(server, body.name || ""));
        const backup = await createWorldBackup(server, "manual");
        if (!backup) return json(res, 404, { error: "World not found" });
        return json(res, 200, { ok: true, name: path.basename(backup), backups: await listBackups(server) });
      }
    } catch (error) {
      return json(res, 400, { error: error.message || String(error) });
    }
  }

  const match = urlObject.pathname.match(/^\/api\/servers\/([^/]+)(?:\/actions)?$/);
  if (!match) return json(res, 404, { error: "Not found" });

  const server = accessibleServer(ctx, match[1]);
  if (!server) return json(res, 404, { error: "Server not found" });

  const isAction = urlObject.pathname.endsWith("/actions");
  if (!isAction && req.method === "GET") return json(res, 200, { server: await decoratedServer(server, true) });

  if (!isAction && req.method === "PUT") {
    const body = await readBody(req);
    if (!ctx.admin && isNativeServer(server)) return json(res, 403, { error: "Native service management is admin-only." });
    if (ctx.admin) {
      updateServer(server, body);
    } else {
      const template = templateFor(body.templateId || server.templateId);
      if (!canCreateTemplate(ctx, template)) return json(res, 403, { error: "This user cannot switch to that server type." });
      updateServer(server, {
        name: body.name,
        templateId: template.id,
        runtimeKind: template.runtimeKind || "docker",
        image: template.image,
        command: template.command || "",
        networkMode: server.networkMode || "bridge",
        dataMount: template.dataMount || "/data",
        ports: server.ports || [],
        connectivity: body.connectivity,
        env: body.env,
        autoStart: body.autoStart
      });
    }
    const syncMessage = await syncUnturnedCommands(server);
    await saveState();
    if (isNativeServer(server)) await syncNativeAutostart(server);
    return json(res, 200, { message: syncMessage || "Saved server.", server: await decoratedServer(server, true) });
  }

  if (!isAction && req.method === "DELETE") {
    if (!ctx.admin && isNativeServer(server)) return json(res, 403, { error: "Native service deletion is admin-only." });
    const removeData = ["1", "true", "yes"].includes(String(urlObject.searchParams.get("data") || "").toLowerCase());
    const removeBackups = ["1", "true", "yes"].includes(String(urlObject.searchParams.get("backups") || "").toLowerCase());
    const containerResult = await removeContainer(server);
    if (!containerResult.ok) throw new Error("Container removal failed; server record, files and backups were preserved.");
    const fileResult = await removeServerManagedFiles(server, { data: removeData, backups: removeBackups });
    state.servers = state.servers.filter((candidate) => candidate.id !== server.id);
    for (const user of users) user.serverIds = (user.serverIds || []).filter((id) => id !== server.id);
    await saveState();
    await saveUsers();
    return json(res, 200, {
      ok: true,
      message: [
        containerResult.message,
        fileResult.removed.length ? `Removed ${fileResult.removed.join(", ")}.` : "",
        fileResult.kept.length ? `Kept ${fileResult.kept.join(", ")}.` : ""
      ].filter(Boolean).join(" ")
    });
  }

  if (isAction && req.method === "POST") {
    const body = await readBody(req);
    if (!ctx.admin && isNativeServer(server)) return json(res, 403, { error: "Native service actions are admin-only." });
    let result;
    if (body.action === "start") result = await startServer(server);
    else if (body.action === "stop") result = await stopServer(server);
    else if (body.action === "restart") {
      result = await stopServer(server);
      if (result.ok) result = await startServer(server);
    } else if (body.action === "recreate") {
      result = await removeContainer(server);
      if (result.ok) result = await startServer(server);
    } else if (body.action === "remove-container") {
      result = await removeContainer(server);
    } else if (body.action === "pull") {
      if (isNativeServer(server)) {
        result = { ok: true, message: "Native services do not use Docker image pulls." };
      } else {
        const pull = await docker(["pull", server.image]);
        result = { ok: pull.code === 0, message: pull.stderr || pull.stdout };
      }
    } else {
      return json(res, 400, { error: "Unknown action" });
    }
    return json(res, result.ok ? 200 : 500, { ...result, server: await decoratedServer(server) });
  }

  return json(res, 405, { error: "Method not allowed" });
}

async function serveStatic(req, res, urlObject) {
  let filePath = urlObject.pathname === "/" ? "/index.html" : urlObject.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.join(PUBLIC_DIR, filePath);
  if (!absolute.startsWith(PUBLIC_DIR)) return text(res, 403, "Forbidden");
  try {
    const data = await fsp.readFile(absolute);
    const ext = path.extname(absolute).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".png" ? "image/png" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".webp" ? "image/webp" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".json" ? "application/json; charset=utf-8" :
      ext === ".webmanifest" ? "application/manifest+json; charset=utf-8" :
      "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch (_error) {
    text(res, 404, "Not found");
  }
}

async function main() {
  await ensureData();
  const server = http.createServer(async (req, res) => {
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    const urlObject = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (urlObject.pathname.startsWith("/api/")) {
        res.setHeader("cache-control", "no-store");
        const match = urlObject.pathname.match(/^\/api\/servers\/([^/]+)/);
        if (match && !["GET", "HEAD"].includes(req.method)) return await runServerOperation(match[1], () => handleApi(req, res, urlObject));
        return await handleApi(req, res, urlObject);
      }
      return await serveStatic(req, res, urlObject);
    } catch (error) {
      json(res, error.statusCode || 500, { error: error.message || String(error) });
    }
  });
  consoleTransport = attachConsoleTransport(server, {
    runtimeFor, isNativeServer, nativeFor, sendNativeConsole, publicOrigin: PUBLIC_ORIGIN,
    canContinue(record, req, touch) {
      const ctx = authContext({ headers: { authorization: req.consoleAuthorization || "" } }, new URL("http://localhost/"), touch);
      return Boolean(ctx && accessibleServer(ctx, record.id));
    },
    authorize(req, url, serverId, mode) {
      const record = url.searchParams.has("ticket") ? consoleTickets.consume(url.searchParams.get("ticket"), serverId, mode) : null;
      const authorization = url.searchParams.has("ticket") ? record?.authorization : req.headers.authorization;
      if (url.searchParams.has("ticket") && !record) return null;
      // Query-string bearer tokens are deliberately excluded from this path.
      const ctx = authContext({ headers: { authorization: authorization || "" } }, new URL("http://localhost/"));
      if (!ctx) return null;
      req.consoleAuthorization = authorization;
      return accessibleServer(ctx, serverId);
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`GamePanel listening on http://${HOST}:${PORT}`);
    if (!AUTH_DISABLED && authToken) console.log(`Auth token file: ${TOKEN_FILE}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
