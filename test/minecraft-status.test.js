"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), net = require("node:net"), { once } = require("node:events");
const { gameStatus } = require("../test-support/minecraft-status");
test("Minecraft startup status rejects clean early disconnects instead of waiting forever", { timeout: 3000 }, async () => {
  const server = net.createServer((socket) => { socket.resume(); socket.end(); }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await assert.rejects(gameStatus(server.address().port), /ended|closed/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
