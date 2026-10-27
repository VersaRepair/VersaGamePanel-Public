"use strict";
const net = require("node:net"), { once } = require("node:events");
function varint(value) { const out = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; out.push(b); } while (value); return Buffer.from(out); }
async function gameStatus(port) {
  const socket = net.connect(port, "127.0.0.1"); socket.on("error", () => {}); socket.setTimeout(1000, () => socket.destroy(Error("Status timeout")));
  try {
    await once(socket, "connect"); const address = Buffer.from("localhost"), p = Buffer.alloc(2); p.writeUInt16BE(port);
    const handshake = Buffer.concat([varint(0), varint(767), varint(address.length), address, p, varint(1)]);
    const response = new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      function read(offset) { let value = 0; for (let n = 0; n < 5; n++) { if (offset + n >= data.length) return null; const b = data[offset + n]; value |= (b & 127) << (7 * n); if (!(b & 128)) return { value, next: offset + n + 1 }; } throw Error("Invalid status"); }
      socket.on("error", reject); socket.on("data", (c) => { try { data = Buffer.concat([data, c]); if (data.length > 65536) throw Error("Status too large"); const packet = read(0); if (!packet || data.length < packet.next + packet.value) return; const type = read(packet.next), length = read(type.next); if (type.value !== 0 || !length || length.next + length.value > data.length) throw Error("Invalid status"); resolve(JSON.parse(data.subarray(length.next, length.next + length.value))); } catch (e) { reject(e); } });
      socket.once("end", () => reject(Error("Status connection ended before readiness")));
      socket.once("close", () => reject(Error("Status connection closed before readiness")));
    }); socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])])); return await response;
  } finally { socket.destroy(); }
}
module.exports = { gameStatus };
