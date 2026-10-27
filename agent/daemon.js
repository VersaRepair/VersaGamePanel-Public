"use strict";

// Scoped game-host boundary. Remote operations use the existing pinned mutual-TLS
// listener; the panel never receives a Docker socket or generic daemon API.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { createDockerAdapter } = require("./docker-adapter");
const { serverTLS, verifyPeer, privateAddress, configFromEnv } = require("../lib/agent-security");
const { createLogTransport, LIMITS } = require("./log-console");

function problem(res, status, message) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message }));
}

function respond(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function restrictedBody(req) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers["content-length"]);
    if (req.headers["transfer-encoding"] || !Number.isInteger(length) || length < 2 || length > 1024 || req.headers["content-type"] !== "application/json") return reject(Object.assign(new Error("Invalid body"), { code: "BAD_REQUEST" }));
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body) > 1024) req.destroy(); });
    req.on("aborted", () => reject(Object.assign(new Error("Aborted body"), { code: "BAD_REQUEST" })));
    req.on("error", reject);
    req.on("end", () => { try { if (Buffer.byteLength(body) !== length) throw new Error(); resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error("Invalid body"), { code: "BAD_REQUEST" })); } });
  });
}

function createAgentServer(adapter, { tls: credentials, logStart } = {}) {
  if (!adapter || typeof adapter.list !== "function" || typeof adapter.inspectManaged !== "function" || typeof adapter.lifecycle !== "function") {
    throw new TypeError("Agent requires a scoped runtime adapter.");
  }
  const busy = new Set();
  const logs = createLogTransport(adapter, { start: logStart }), commandRates = new Map();
  const handler = async (req, res) => {
    try {
      if (credentials) {
        try {
          if (!req.socket.authorized) throw new Error("Unauthenticated peer.");
          verifyPeer(req.socket.getPeerCertificate().raw, credentials);
        } catch { return problem(res, 403, "Peer identity rejected."); }
      }
      // This boundary accepts no user-supplied image, command, path, env, or Docker flags.
      if (!["GET", "POST"].includes(req.method)) return problem(res, 405, "Method not allowed.");
      const url = new URL(req.url, "http://agent.invalid");
      if (url.search || url.hash) return problem(res, 400, "Query parameters are not accepted.");
      const io = /^\/v1\/servers\/([a-f0-9]{64})\/(logs|logs\/stream|console)$/.exec(url.pathname);
      if (io) {
        if (!credentials || !adapter.inspectIO) return problem(res, 501, "Managed log/console transport is not enabled.");
        const authorize = () => verifyPeer(req.socket.getPeerCertificate().raw, credentials);
        if (io[2] === "console" && req.method === "POST") {
          try { verifyPeer(req.socket.getPeerCertificate().raw, credentials, "console"); }
          catch { return problem(res, 403, "Console permission required."); }
          const body = await restrictedBody(req);
          await adapter.inspectIO(io[1]);
          try { verifyPeer(req.socket.getPeerCertificate().raw, credentials, "console"); }
          catch { return problem(res, 403, "Console permission expired."); }
          const now = Date.now(), rate = commandRates.get(io[1]);
          if (rate && now - rate.at < 10000 && rate.count >= 10) return problem(res, 429, "Console input rate exceeded.");
          if (!rate || now - rate.at >= 10000) commandRates.set(io[1], { at: now, count: 1 }); else rate.count++;
          if (commandRates.size > 128) for (const [id, entry] of commandRates) if (now - entry.at >= 10000) commandRates.delete(id);
          return respond(res, 200, await adapter.consoleInput(io[1], body));
        }
        if (req.method !== "GET" || io[2] === "console") return problem(res, 405, "Method not allowed.");
        if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) !== 0) return problem(res, 400, "Request bodies are not accepted.");
        let stream, disconnected = false, opened = false, ended = false;
        res.once("close", () => { disconnected = true; stream?.close(); });
        res.setHeader("content-type", "application/x-ndjson"); res.setHeader("cache-control", "no-store"); res.setHeader("x-accel-buffering", "no");
        stream = await logs.open(io[1], io[2].endsWith("/stream"), (event) => {
          if (disconnected || res.writableLength > LIMITS.buffered) { res.destroy(); return false; }
          res.write(JSON.stringify(event) + "\n"); return true;
        }, authorize, () => { ended = true; if (opened) res.end(); });
        opened = true;
        if (disconnected) stream.close(); else if (ended) res.end(); else res.flushHeaders();
        return;
      }
      const deletion = /^\/v1\/servers\/([a-f0-9]{64})\/delete$/.exec(url.pathname);
      if (req.method === "POST" && (url.pathname === "/v1/servers" || deletion)) {
        try { if (!credentials) throw new Error(); verifyPeer(req.socket.getPeerCertificate().raw, credentials, "provision"); }
        catch { return problem(res, 403, "Provisioning permission required."); }
        if (!adapter.provision) return problem(res, 501, "Provisioning is not enabled on this agent.");
        const body = await restrictedBody(req);
        return deletion ? respond(res, 200, await adapter.remove(deletion[1], body)) : respond(res, 201, { server: await adapter.provision(body) });
      }
      if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) !== 0) {
        return problem(res, 400, "Request bodies are not accepted.");
      }
      if (req.method === "GET" && url.pathname === "/v1/health") return respond(res, 200, { status: "ok", api: 1, ...(adapter.provision ? { provisioning: true, profiles: adapter.profiles || [], memoryBudgetGiB: adapter.memoryBudgetGiB || 6 } : {}), ...(adapter.inspectIO ? { logs: true } : {}) });
      if (req.method === "GET" && url.pathname === "/v1/servers") return respond(res, 200, { servers: await adapter.list() });

      const match = /^\/v1\/servers\/([a-f0-9]{64})\/(start|stop|restart)$/.exec(url.pathname);
      if (!match || req.method !== "POST") return problem(res, 404, "Unknown operation.");
      const [, id, action] = match;
      if (busy.size >= 4 || busy.has(id)) return problem(res, 429, "A server operation is already running.");
      busy.add(id);
      try {
        // Re-authorize against the Docker daemon for every operation.
        await adapter.inspectManaged(id);
        await adapter.lifecycle(id, action);
        return respond(res, 200, { id, action, status: "requested" });
      } finally {
        busy.delete(id);
      }
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error.code === "NOT_MANAGED" || error.code === "NOT_FOUND") return problem(res, 404, "Managed server not found.");
      if (error.code === "UNSAFE") return problem(res, 403, "Managed server fails agent safety policy.");
      if (error.code === "TOO_MANY") return problem(res, 503, "Agent inventory limit reached.");
      if (error.code === "RESOURCE_LIMIT") return respond(res, 409, { code: "RESOURCE_LIMIT", limitGiB: adapter.memoryBudgetGiB || 6, error: "Stop another server before starting this preset; the managed running-memory budget is full." });
      if (error.code === "BAD_REQUEST") return problem(res, 400, "Only the approved smoke-test profile and its exact fields are accepted.");
      if (error.code === "CONFLICT") return problem(res, 409, "Identity/storage collision or server must be stopped.");
      if (error.code === "BUSY") return problem(res, 429, "Another agent mutation is running; try again shortly.");
      if (error.code === "UNSUPPORTED") return problem(res, 501, "Console input is unsupported for this profile.");
      if (error.code === "CLEANUP_PENDING") return problem(res, 503, "Operation incomplete; resources retained for maintainer review.");
      // Avoid exposing Docker errors or host filesystem paths in responses.
      return problem(res, 503, "Agent operation unavailable.");
    }
  };
  const server = credentials ? https.createServer(serverTLS(credentials), handler) : http.createServer(handler);
  server.closeLogStreams = () => logs.close();
  server.maxRequestsPerSocket = 1;
  server.on("tlsClientError", () => {}); // Do not log certificates, peer names or OpenSSL buffers.
  server.maxConnections = 24;
  server.maxHeadersCount = 24;
  server.requestTimeout = 10_000;
  server.headersTimeout = 8_000;
  server.once("close", () => { logs.close(); adapter.close?.().catch(() => {}); });
  return server;
}

function socketDirectory(socketPath) {
  if (!path.isAbsolute(socketPath) || path.basename(socketPath) !== "agent.sock") {
    throw new Error("Agent socket must be an absolute path ending in agent.sock.");
  }
  const directory = path.dirname(socketPath);
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid()) {
    throw new Error("Agent socket directory must be owned by this user, be a real directory, and have mode 0700.");
  }
  if (fs.existsSync(socketPath)) throw new Error("Refusing to replace an existing agent socket.");
  return socketPath;
}

async function listenOnSocket(server, socketPath) {
  socketDirectory(socketPath);
  const oldMask = process.umask(0o077);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
  } finally {
    process.umask(oldMask);
  }
  return server;
}

if (require.main === module) {
  // The process is intentionally not daemonized or auto-deployed. Run only in a
  // dedicated disposable game-host VM with a pre-created private socket directory.
  if (!process.getuid || process.getuid() === 0) {
    console.error("VersaGameAgent must run as a non-root account.");
    process.exitCode = 1;
  } else {
    const socketPath = process.env.VGP_AGENT_SOCKET_PATH || "";
    const dataRoot = process.env.VGP_AGENT_DATA_ROOT || "";
    let adapter;
    try {
      if (!dataRoot) throw new Error("VGP_AGENT_DATA_ROOT must point to the dedicated game storage root.");
      adapter = createDockerAdapter({ dataRoot, stateRoot: process.env.VGP_AGENT_STATE_DIR,
        minecraftImage: process.env.VGP_AGENT_MINECRAFT_IMAGE, terrariaImage: process.env.VGP_AGENT_TERRARIA_IMAGE,
        unturnedImage: process.env.VGP_AGENT_UNTURNED_IMAGE, gameBindAddress: process.env.VGP_AGENT_GAME_BIND_ADDRESS,
        memoryBudgetGiB: Number(process.env.VGP_AGENT_MEMORY_BUDGET_GIB || 6) });
      const transport = process.env.VGP_AGENT_TRANSPORT || "unix";
      if (!["unix", "mtls"].includes(transport)) throw new Error("Unsupported agent transport.");
      const server = createAgentServer(adapter, transport === "mtls" ? { tls: configFromEnv(process.env, "VGP_AGENT") } : {});
      let ready;
      if (transport === "mtls") {
        const address = process.env.VGP_AGENT_BIND_ADDRESS;
        const port = Number(process.env.VGP_AGENT_PORT || 9443);
        if (!privateAddress(address || "") || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a private agent listener.");
        ready = new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, address, resolve); });
      } else ready = listenOnSocket(server, socketPath);
      ready.then(() => {
        console.log(transport === "unix" ? "VersaGameAgent local socket ready (no TCP listener)." : "VersaGameAgent private mutual-TLS listener ready.");
      }).catch(async () => {
        await adapter.close?.();
        console.error("VersaGameAgent could not create its private socket.");
        process.exitCode = 1;
      });
      const shutdown = () => { server.closeLogStreams(); server.close(async () => { await adapter.close?.(); process.exit(0); }); };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    } catch {
      adapter?.close?.().catch(() => {});
      console.error("VersaGameAgent configuration rejected.");
      process.exitCode = 1;
    }
  }
}

module.exports = { createAgentServer, listenOnSocket, socketDirectory };
