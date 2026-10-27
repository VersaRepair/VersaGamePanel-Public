"use strict";
const { openDockerLogs } = require("./docker-logs");
const { StringDecoder } = require("node:string_decoder");
const { attachDockerConsole } = require("../lib/docker-console");
const Modem = require("docker-modem");
const { allowedLine } = require("../lib/agent-commands");
const LIMITS = Object.freeze({ historyBytes: 65536, historyLines: 200, streamBytes: 524288,
  streamLines: 4000, seconds: 60, streams: 8, perServer: 2, chunk: 4096, buffered: 32768 });
const fail = (code) => Object.assign(new Error(code), { code });
function validCommand(body, game = "fixture") {
  if (!body || Array.isArray(body) || Object.keys(body).join(",") !== "line" ||
    !allowedLine(body.line, game)) throw fail("BAD_REQUEST");
}
// Attach to PID 1's explicitly approved TTY; never exec a process or signal it on detach.
function sendCommand(id, line, game = "fixture") {
  validCommand({ line }, game);
  return new Promise((resolve, reject) => {
    const handle = attachDockerConsole({ name: id, tty: true }, {
      modem: new Modem({ socketPath: "/var/run/docker.sock" }), timeoutMs: 1500
    });
    let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); handle.kill(); error ? reject(fail("UNAVAILABLE")) : resolve(); };
    const timer = setTimeout(() => finish(fail("UNAVAILABLE")), game !== "fixture" ? 10000 : 2000);
    const expected = game === "minecraft" ? line === "list" ? /There are \d+ of a max of 8 players online/ : line === "seed" ? /Seed: \[/ : line === "save-all flush" ? /Saved the game/ : new RegExp("\\[Server\\] " + line.slice(4).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) :
      game === "terraria" ? line === "save" ? /World saved|Saving world data/i : line === "playing" ? /No players connected|players connected|Player list/i : line === "version" ? /Terraria Server|1\.4\./i : /<Server>/i :
        game === "unturned" ? line === "Save" ? /Successfully saved|Saved the|Saved level|Saving/i : /Players:|players online|Players online|No players/i : null;
    let output = "";
    handle.stdout.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-4096); if (expected ? expected.test(output) : output.includes({ ping: "pong", status: "status: ready", help: "commands: ping status help" }[line])) finish(); });
    handle.stderr.resume();
    handle.on("error", finish); handle.on("close", () => finish(fail("UNAVAILABLE")));
    handle.stdin.write(line + "\n");
  });
}

function createLogTransport(adapter, { start = openDockerLogs } = {}) {
  const active = new Map();
  const closers = new Set();
  let count = 0;
  async function open(id, follow, emit, authorize, ended) {
    if (!adapter.inspectIO) throw fail("UNSUPPORTED");
    if (count >= LIMITS.streams || (active.get(id) || 0) >= LIMITS.perServer) throw fail("BUSY");
    count++; active.set(id, (active.get(id) || 0) + 1);
    let child, closed = false, verifyTimer, deadline, checking = false;
    const close = () => {
      if (closed) return; closed = true;
      clearInterval(verifyTimer); clearTimeout(deadline);
      child?.kill();
      count--; if (active.get(id) === 1) active.delete(id); else active.set(id, active.get(id) - 1);
      closers.delete(close);
      ended?.();
    };
    closers.add(close);
    try {
      authorize(); const initial = await adapter.inspectIO(id);
      if (closed) return { close };
      authorize(); // A peer may have been revoked while Docker inspection was pending.
      let bytes = 0, lines = 0;
      const maxBytes = follow ? LIMITS.streamBytes : LIMITS.historyBytes;
      const maxLines = follow ? LIMITS.streamLines : LIMITS.historyLines;
      function event(type, text) { if (!closed && !emit({ type, text })) close(); }
      function output(chunk, decoder) {
        if (closed) return;
        const text = decoder.write(chunk).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
        for (let i = 0; i < text.length && !closed; i += 1024) {
          const part = text.slice(i, i + 1024), size = Buffer.byteLength(part);
          const n = (part.match(/\n/g) || []).length;
          if (bytes + size > maxBytes || lines + n > maxLines) { event("status", "Log limit reached. Reconnect for recent output."); close(); return; }
          bytes += size; lines += n; event("output", part);
        }
      }
      child = start(id, follow && initial.running, initial.console);
      const decoder = new StringDecoder("utf8");
      child.on("data", (chunk) => output(chunk, decoder));
      child.on("error", () => { event("status", "Logs unavailable."); close(); });
      child.on("close", (code) => { event("status", code ? "Logs unavailable." : initial.running ? "Log stream ended. Reconnect for recent output." : "Server stopped. Showing recent logs."); close(); });
      verifyTimer = setInterval(async () => {
        if (closed) return;
        try { authorize(); } catch { event("status", "Log access expired or agent unavailable."); close(); return; }
        if (checking) return; checking = true;
        try {
          const now = await adapter.inspectIO(id);
          if (closed) return;
          if (now.generation !== initial.generation || now.running !== initial.running) { event("status", "Server restarted or stopped. Reconnect for recent logs."); close(); }
          else event("heartbeat", "");
        } catch { event("status", "Log access expired or agent unavailable."); close(); }
        finally { checking = false; }
      }, 1000);
      deadline = setTimeout(() => { event("status", "Log session expired. Reconnect for recent output."); close(); }, (follow ? LIMITS.seconds : 5) * 1000);
      return { close };
    } catch (error) { close(); throw error; }
  }
  return { open, close() { for (const close of closers) close(); }, get active() { return count; } };
}
module.exports = { LIMITS, validCommand, sendCommand, createLogTransport };
