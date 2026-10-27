"use strict";
const http = require("node:http");
const { EventEmitter } = require("node:events");

// One fixed Docker operation on one already-authorized full ID. No proxy or exec API.
function openDockerLogs(id, follow, tty, { get = http.get } = {}) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid container identity");
  const handle = new EventEmitter();
  let response, closed = false, header = Buffer.alloc(0), remaining = 0;
  const req = get({ socketPath: "/var/run/docker.sock",
    path: `/containers/${id}/logs?stdout=1&stderr=1&tail=200&follow=${follow ? 1 : 0}`,
    agent: false, maxHeaderSize: 4096 }, (res) => {
    response = res;
    clearTimeout(timer);
    if (closed) return res.destroy();
    if (res.statusCode !== 200) { finish(true); return; }
    res.on("data", (chunk) => {
      if (closed) return;
      if (tty) return handle.emit("data", chunk);
      // Docker multiplex frames: retain at most the eight-byte header, never a full frame.
      let offset = 0;
      while (offset < chunk.length && !closed) {
        if (!remaining) {
          const n = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + n)]); offset += n;
          if (header.length !== 8) continue;
          if (![1, 2].includes(header[0]) || header[1] || header[2] || header[3]) return finish(true);
          remaining = header.readUInt32BE(4); header = Buffer.alloc(0);
          if (remaining > 16 * 1024 * 1024) return finish(true);
          if (!remaining) continue;
        }
        const n = Math.min(remaining, chunk.length - offset);
        handle.emit("data", chunk.subarray(offset, offset + n)); offset += n; remaining -= n;
      }
    });
    res.on("end", () => finish(!!remaining || !!header.length));
    res.on("error", () => finish(true));
    res.on("aborted", () => finish(true));
  });
  const timer = setTimeout(() => finish(true), 3000);
  req.on("error", () => finish(true));
  function finish(error) {
    if (closed) return; closed = true; clearTimeout(timer); req.destroy(); response?.destroy();
    handle.emit("close", error ? 1 : 0);
  }
  handle.kill = () => finish(false);
  return handle;
}
module.exports = { openDockerLogs };
