"use strict";

const { spawn: spawnProcess } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { WebSocket, WebSocketServer } = require("ws");
const { attachDockerConsole } = require("./docker-console");

const DEFAULT_LIMITS = Object.freeze({
  maxPayload: 16 * 1024,
  maxQueuedInput: 64 * 1024,
  maxBufferedOutput: 1024 * 1024,
  heartbeatMs: 30000,
  maxConnections: 64
});

function originAllowed(req, publicOrigin) {
  if (!req.headers.origin) return Boolean(req.headers.authorization?.startsWith("Bearer "));
  try {
    const origin = new URL(req.headers.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== req.headers.origin) return false;
    return publicOrigin ? origin.origin === publicOrigin : origin.host === req.headers.host;
  } catch (_) {
    return false;
  }
}

function attachConsoleTransport(httpServer, options) {
  const {
    authorize, runtimeFor, isNativeServer, nativeFor, sendNativeConsole,
    spawn = spawnProcess, dockerAttach = attachDockerConsole, canContinue = () => true,
    publicOrigin = "", limits: configuredLimits = {}
  } = options;
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: limits.maxPayload,
    maxFragments: 128, maxBufferedChunks: 256, closeTimeout: 5000
  });

  function reject(socket, status) {
    const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 503: "Service Unavailable" }[status] || "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function connect(ws, server, mode, req) {
    let child;
    let closed = false;
    let queuedBytes = 0;
    let pendingCommands = 0;
    let alive = true;
    let inputQueue = Promise.resolve();
    let runtimeReady;
    ws.checkAuthorization = (touch = false) => {
      try { if (canContinue(server, req, touch)) return true; } catch (_) { /* revoked or blocked */ }
      ws.close(1008, "Access expired. Please sign in again.");
      cleanup();
      return false;
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      if (child) {
        child.stdin?.destroy();
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1000);
        forceKill.unref();
        child.once("close", () => clearTimeout(forceKill));
      }
    }

    function send(text) {
      if (closed || ws.readyState !== WebSocket.OPEN || !ws.checkAuthorization()) return;
      const output = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (ws.bufferedAmount + Buffer.byteLength(output) > limits.maxBufferedOutput) {
        ws.close(1013, "Console output is too slow. Reconnect.");
        cleanup();
        return;
      }
      ws.send(output, (error) => { if (error) ws.terminate(); });
    }

    ws.on("error", cleanup);
    ws.on("close", cleanup);
    ws.on("pong", () => { alive = true; });
    ws.checkAlive = () => {
      if (!ws.checkAuthorization()) return;
      if (!alive) return ws.terminate();
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    };
    ws.on("message", (data, binary) => {
      if (closed || !ws.checkAuthorization(true)) return;
      if (binary) return ws.close(1003, "Console input must be text.");
      if (mode !== "console") return ws.close(1008, "Logs are read-only.");
      if (queuedBytes + data.length > limits.maxQueuedInput || pendingCommands >= 32) {
        ws.close(1008, "Too much pending console input.");
        cleanup();
        return;
      }
      queuedBytes += data.length;
      pendingCommands += 1;
      const command = data.toString("utf8");
      inputQueue = inputQueue.then(async () => {
        await runtimeReady;
        if (closed || ws.readyState !== WebSocket.OPEN || !ws.checkAuthorization()) return;
        if (isNativeServer(server)) {
          send(`\n[${await sendNativeConsole(server, command)}]\n`);
        } else if (child?.stdin?.writable) {
          await new Promise((resolve, rejectWrite) => child.stdin.write(command, (error) => error ? rejectWrite(error) : resolve()));
        }
      }).catch(() => {
        send("\n[console input failed]\n");
        ws.close(1011, "Console input failed.");
        cleanup();
      }).finally(() => {
        queuedBytes -= data.length;
        pendingCommands -= 1;
      });
    });

    runtimeReady = (async () => {
      const runtime = await runtimeFor(server);
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      const native = isNativeServer(server);
      if (!runtime.running && (!native || mode === "console")) {
        send(`${native ? "Service" : "Container"} ${runtime.name} is not running.\n`);
        ws.close(1000, "Server is not running.");
        return;
      }
      const command = native ? "tail" : "docker";
      const args = native
        ? ["-n", "240", "-F", nativeFor(server).logFile || "/var/log/syslog"]
        : mode === "logs" ? ["logs", "-f", "--tail", "240", runtime.name] : ["attach", "--sig-proxy=false", runtime.name];
      child = !native && mode === "console" ? dockerAttach(runtime)
        : spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const outputDecoder = new StringDecoder("utf8");
      const errorDecoder = new StringDecoder("utf8");
      child.stdout.on("data", (chunk) => send(outputDecoder.write(chunk)));
      child.stderr.on("data", (chunk) => send(errorDecoder.write(chunk)));
      child.stdin?.on("error", () => {
        if (!closed) ws.close(1011, "Console input unavailable.");
      });
      child.on("error", () => {
        send("\n[console process could not start]\n");
        ws.close(1011, "Console unavailable.");
      });
      child.on("close", (code) => {
        send(outputDecoder.end());
        send(errorDecoder.end());
        send(`\n[connection closed: ${code}]\n`);
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Console process ended.");
      });
    })();
    runtimeReady.catch(() => {
      send("\n[console unavailable]\n");
      ws.close(1011, "Console unavailable.");
      cleanup();
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) ws.checkAlive?.();
  }, limits.heartbeatMs);
  heartbeat.unref();

  function upgrade(req, socket, head) {
    socket.on("error", () => {});
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const match = url.pathname.match(/^\/ws\/servers\/([^/]+)\/(console|logs)$/);
      if (!match) return reject(socket, 404);
      if (!originAllowed(req, publicOrigin)) return reject(socket, 403);
      if (wss.clients.size >= limits.maxConnections) return reject(socket, 503);
      const server = authorize(req, url, match[1], match[2]);
      if (!server) return reject(socket, 401);
      wss.handleUpgrade(req, socket, head, (ws) => connect(ws, server, match[2], req));
    } catch (error) {
      reject(socket, [401, 403, 404].includes(error.statusCode) ? error.statusCode : 400);
    }
  }
  httpServer.on("upgrade", upgrade);
  function close() {
    clearInterval(heartbeat);
    httpServer.removeListener("upgrade", upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }
  httpServer.once("close", close);
  return { close, clients: wss.clients, revalidate() { for (const ws of wss.clients) ws.checkAuthorization?.(); } };
}

module.exports = { DEFAULT_LIMITS, attachConsoleTransport, originAllowed };
