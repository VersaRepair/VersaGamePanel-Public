"use strict";

const crypto = require("crypto");

function createConsoleTickets({ now = Date.now, ttlMs = 30000, maxTickets = 1000 } = {}) {
  const tickets = new Map();
  function prune() {
    const time = now();
    for (const [key, value] of tickets) if (value.expiresAt <= time) tickets.delete(key);
  }
  return {
    issue({ serverId, mode, authorization }) {
      if (!["console", "logs"].includes(mode)) throw new Error("Choose console or logs.");
      prune();
      if (tickets.size >= maxTickets) {
        const error = new Error("Too many pending console connections. Try again shortly.");
        error.statusCode = 429;
        throw error;
      }
      const ticket = crypto.randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      tickets.set(ticket, { serverId, mode, authorization, expiresAt });
      return { ticket, expiresAt };
    },
    consume(ticket, serverId, mode) {
      prune();
      const record = tickets.get(ticket);
      tickets.delete(ticket);
      if (!record || record.serverId !== serverId || record.mode !== mode) return null;
      return record;
    }
  };
}

module.exports = { createConsoleTickets };
