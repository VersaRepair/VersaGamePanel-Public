"use strict";

const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const Modem = require("docker-modem");

// A child-like stream handle, not an exec or a second process in the container.
// Destroying it disconnects this attachment; it never signals the game process.
function attachDockerConsole(runtime, { modem, timeoutMs = 10000 } = {}) {
  const handle = new EventEmitter();
  handle.stdin = new PassThrough();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.exitCode = null;
  handle.signalCode = null;
  const abort = new AbortController();
  let socket;
  let closed = false;
  let timer;

  function finish(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    abort.abort();
    handle.stdin.destroy();
    socket?.destroy();
    handle.stdout.end();
    handle.stderr.end();
    handle.exitCode = error ? 1 : 0;
    if (error) handle.emit("error", error);
    handle.emit("close", handle.exitCode);
  }
  handle.kill = () => { finish(); return true; };
  // Deferred initialization lets the caller install error/output listeners first.
  queueMicrotask(() => {
    if (closed) return;
    try {
      if (!modem && process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== "default") {
        throw new Error("Console requires the default Docker context or an explicit DOCKER_HOST.");
      }
      const client = modem || new Modem();
      timer = setTimeout(() => finish(new Error("Docker console connection timed out.")), timeoutMs);
      timer.unref();
      client.dial({
        path: `/containers/${encodeURIComponent(runtime.name)}/attach?`, method: "POST",
        isStream: true, hijack: true, openStdin: true, abortSignal: abort.signal,
        statusCodes: { 200: true, 404: "no such container", 500: "server error" },
        options: { stream: true, stdin: true, stdout: true, stderr: true }
      }, (error, stream) => {
        clearTimeout(timer);
        if (closed) { stream?.destroy(); return; }
        if (error) { finish(error); return; }
        socket = stream;
        socket.on("error", finish);
        socket.once("end", () => finish());
        socket.once("close", () => finish());
        if (runtime.tty) socket.pipe(handle.stdout);
        else client.demuxStream(socket, handle.stdout, handle.stderr);
        handle.stdin.pipe(socket);
      });
    } catch (error) { finish(error); }
  });
  return handle;
}

module.exports = { attachDockerConsole };
