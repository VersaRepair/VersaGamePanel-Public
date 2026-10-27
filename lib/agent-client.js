"use strict";
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { allowedLine } = require("./agent-commands");
const { validGamePort } = require("./agent-game-catalog");
const { privateAddress, clientTLS, verifyPeer, configFromEnv } = require("./agent-security");

function unavailable() { return Object.assign(new Error("Game agent unavailable or its identity was rejected. No local Docker fallback was attempted."), { statusCode: 503 }); }
function createAgentClient({ url, tls, timeout = 25000 }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" || !privateAddress(endpoint.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Agent URL must use HTTPS and an explicit private IP address.");
  // Fail on broken provisioning before accepting browser requests.
  clientTLS(tls);
  async function request(route, method = "GET", payload, operationTimeout = timeout) {
    try {
      const encoded = payload === undefined ? undefined : JSON.stringify(payload);
      return await new Promise((resolve, reject) => {
        const req = https.request(endpoint, { ...clientTLS(tls), path: route, method, agent: false, headers: { connection: "close", ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }) } }, (res) => {
          try { if (!res.socket.authorized) throw unavailable(); verifyPeer(res.socket.getPeerCertificate().raw, tls); }
          catch { res.destroy(); reject(unavailable()); return; }
          let body = "";
          res.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body) > 131072) res.destroy(unavailable()); });
          res.on("error", reject);
          res.on("end", () => {
            const messages = { 400: "Approved provisioning configuration rejected.", 403: "Agent operation is not authorized.", 404: "Agent server is no longer available or is not authorized.", 409: "Server identity is already in use or the server must be stopped.", 429: "Another agent operation is running. Please try again.", 501: "Provisioning is not enabled on this agent." };
            if (messages[res.statusCode]) { let code, limit; try { const detail = JSON.parse(body); code = detail.code; limit = Number.isInteger(detail.limitGiB) && detail.limitGiB >= 6 && detail.limitGiB <= 12 ? detail.limitGiB : 6; } catch {} return reject(Object.assign(new Error(code === "RESOURCE_LIMIT" ? `Stop another server first: the developer host's ${limit} GiB running-memory budget is full.` : messages[res.statusCode]), { statusCode: res.statusCode })); }
            if (![200, 201].includes(res.statusCode)) return reject(unavailable());
            try { resolve(JSON.parse(body)); } catch { reject(unavailable()); }
          });
        });
        const deadline = setTimeout(() => req.destroy(unavailable()), method === "GET" ? Math.min(timeout, 3000) : operationTimeout);
        req.on("close", () => clearTimeout(deadline));
        req.on("error", reject);
        req.end(encoded);
      });
    } catch (error) { if ([400, 403, 404, 409, 429, 501].includes(error.statusCode)) throw error; throw unavailable(); }
  }
  function normalize(servers) {
    if (!Array.isArray(servers) || servers.length > 128 || servers.some((s) => !s || !/^[a-f0-9]{64}$/.test(s.id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.serverId) || typeof s.running !== "boolean" || !["created", "running", "exited", "paused", "restarting", "dead", "unknown"].includes(s.state)) || new Set(servers.map((s) => s.id)).size !== servers.length) throw unavailable();
    if (servers.some((s) => s.displayName !== undefined && (typeof s.displayName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(s.displayName)))) throw unavailable();
    return servers.map((s) => ({ id: s.id, name: s.displayName || s.serverId, profile: s.profile, disposable: s.disposable === true, managed: s.managed === true, console: s.console === true,
      ...(s.connection?.provider === "direct" && validGamePort(s.profile, s.connection.port) && privateAddress(s.connection.address) ? { connection: { provider: "direct", address: s.connection.address, port: s.connection.port, protocol: s.connection.protocol === "udp" ? "udp" : "tcp" } } : {}), runtime: { exists: true, running: s.running, status: s.state } }));
  }
  function openStream(id, mode = "logs", follow = true) {
    if (!/^[a-f0-9]{64}$/.test(id) || !["logs", "console"].includes(mode)) throw Object.assign(new Error("Choose an authorized log/console stream."), { statusCode: 400 });
    const handle = new EventEmitter();
    handle.stdout = new PassThrough({ highWaterMark: 8192 }); handle.stderr = new PassThrough();
    let req, response, closed = false, check, deadline, idle;
    const finish = (message) => {
      if (closed) return; closed = true;
      clearInterval(check); clearTimeout(deadline); clearTimeout(idle);
      req?.destroy(); response?.destroy(); handle.stdin.destroy();
      if (message) handle.stdout.write(`\n[${message}]\n`);
      handle.stdout.end(); handle.stderr.end(); handle.exitCode = message ? 1 : 0; handle.emit("close", handle.exitCode);
    };
    handle.stdin = new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) {
      const line = chunk.toString("utf8").replace(/\n$/, "");
      if (mode !== "console" || !allowedLine(line)) return done(new Error("Console command is outside the approved profile's allowlist."));
      request(`/v1/servers/${id}/console`, "POST", { line }).then(() => done(), () => done(new Error("Console command rejected or agent unavailable.")));
    } });
    handle.kill = () => { finish(); return true; };
    queueMicrotask(() => {
      if (closed) return;
      try {
        req = https.get(endpoint, { ...clientTLS(tls), path: `/v1/servers/${id}/logs${follow ? "/stream" : ""}`, agent: false, maxHeaderSize: 4096 }, (res) => {
          response = res;
          try { if (!res.socket.authorized) throw unavailable(); verifyPeer(res.socket.getPeerCertificate().raw, tls); }
          catch { return finish("Agent identity rejected."); }
          if (res.statusCode !== 200 || res.headers["content-type"] !== "application/x-ndjson") return finish(res.statusCode === 404 ? "Server logs are not authorized or available." : "Logs unavailable or stream limit reached.");
          let buffer = "", total = 0, frames = 0;
          const decoder = new StringDecoder("utf8");
          function resetIdle() { clearTimeout(idle); idle = setTimeout(() => finish("Agent connection lost. Reconnect."), 5000); }
          resetIdle();
          res.on("data", (chunk) => {
            if (closed) return;
            total += chunk.length;
            if (total > 1024 * 1024) return finish("Log session limit reached. Reconnect.");
            resetIdle();
            buffer += decoder.write(chunk);
            while (buffer.includes("\n") && !closed) {
              const end = buffer.indexOf("\n");
              if (end > 8192 || ++frames > 6000) return finish("Invalid agent log stream.");
              let event; try { event = JSON.parse(buffer.slice(0, end)); } catch { return finish("Invalid agent log stream."); }
              buffer = buffer.slice(end + 1);
              if (!event || !["output", "status", "heartbeat"].includes(event.type) || typeof event.text !== "string" || Buffer.byteLength(event.text) > 4096) return finish("Invalid agent log stream.");
              if (event.type !== "heartbeat" && !handle.stdout.write(event.type === "status" ? `\n[${event.text}]\n` : event.text)) return finish("Log consumer too slow. Reconnect.");
            }
            if (Buffer.byteLength(buffer) > 8192) finish("Invalid agent log stream.");
          });
          res.on("end", () => finish(buffer ? "Agent log stream interrupted." : undefined));
          res.on("error", () => finish("Agent connection lost. Reconnect."));
          res.on("aborted", () => finish("Agent connection lost. Reconnect."));
          check = setInterval(() => { try { verifyPeer(res.socket.getPeerCertificate().raw, tls); } catch { finish("Agent identity expired or revoked."); } }, 1000);
        });
        req.on("error", () => finish("Agent unavailable. Reconnect."));
        deadline = setTimeout(() => finish("Log session expired. Reconnect."), 65000);
        req.setTimeout(5000, () => finish("Agent connection timed out. Reconnect."));
      } catch { finish("Agent identity or connection unavailable."); }
    });
    return handle;
  }
  const list = async () => normalize((await request("/v1/servers"))?.servers);
  return { list, openStream, health: () => request("/v1/health"), async provision(body) {
    return { server: normalize([(await request("/v1/servers", "POST", body))?.server])[0] };
  }, async remove(id, body) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Object.assign(new Error("Choose an authorized server."), { statusCode: 400 });
    return request(`/v1/servers/${id}/delete`, "POST", body);
  }, async lifecycle(id, action) {
    if (!/^[a-f0-9]{64}$/.test(id) || !["start", "stop", "restart"].includes(action)) throw Object.assign(new Error("Choose an authorized lifecycle operation."), { statusCode: 400 });
    await request(`/v1/servers/${id}/${action}`, "POST", undefined, 75000);
    return { ok: true, message: `Agent ${action} completed.` };
  } };
}
function agentClientFromEnv(env) { return createAgentClient({ url: env.GAMEPANEL_AGENT_URL, tls: configFromEnv(env, "GAMEPANEL_AGENT") }); }
module.exports = { createAgentClient, agentClientFromEnv, unavailable };
