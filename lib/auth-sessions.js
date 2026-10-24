"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const COOKIE = "gp_session";

function credential(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7, 1031);
  const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return cookie ? cookie.slice(COOKIE.length + 1, COOKIE.length + 129) : "";
}

function sameOrigin(req, publicOrigin = "") {
  try {
    const expected = publicOrigin || `${req.socket?.encrypted ? "https" : "http"}://${req.headers.host}`;
    return req.headers.origin === expected && req.headers["sec-fetch-site"] !== "cross-site";
  } catch (_) { return false; }
}

function sessionCookie(token, secure = false) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${secure ? "; Secure" : ""}`;
}

function sessions({ now = Date.now, ttlMs = 8 * 3600000, idleMs = 30 * 60000, maxSessions = 1000, onRevoke = () => {} } = {}) {
  const records = new Map();
  const key = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
  function prune() {
    for (const [id, record] of records) if (now() >= record.expiresAt || now() - record.lastSeen >= idleMs) records.delete(id);
  }
  return {
    issue(username) {
      prune();
      const own = [...records].filter(([, record]) => record.username === username);
      if (own.length >= 10) { records.delete(own[0][0]); onRevoke(); }
      if (records.size >= maxSessions) throw Object.assign(new Error("Too many active sessions. Try again shortly."), { statusCode: 429 });
      const token = crypto.randomBytes(32).toString("base64url");
      records.set(key(token), { username, lastSeen: now(), expiresAt: now() + ttlMs });
      return token;
    },
    resolve(token, touch = true) {
      if (!token || token.length !== 43) return null;
      const id = key(token);
      const record = records.get(id);
      if (!record) return null;
      if (now() >= record.expiresAt || now() - record.lastSeen >= idleMs) { records.delete(id); return null; }
      if (touch) record.lastSeen = now();
      return record.username;
    },
    revoke(token) { records.delete(key(token)); onRevoke(); },
    revokeUser(username) {
      for (const [id, record] of records) if (record.username === username) records.delete(id);
      onRevoke();
    }
  };
}

function loginLimiter({ now = Date.now, windowMs = 5 * 60000, maxFailures = 10, maxEntries = 2000 } = {}) {
  const failures = new Map();
  function clean() { for (const [id, value] of failures) if (value.until <= now()) failures.delete(id); }
  return {
    blocked(ip) { clean(); return (failures.get(ip)?.count || 0) >= maxFailures || (!failures.has(ip) && failures.size >= maxEntries); },
    fail(ip) { clean(); const previous = failures.get(ip); if (previous) previous.count += 1; else if (failures.size < maxEntries) failures.set(ip, { count: 1, until: now() + windowMs }); }
  };
}

async function verifyPassword(password, encoded) {
  const [scheme, salt, expected] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected || password.length > 256) return false;
  const actual = await scrypt(password, salt, 64);
  const target = Buffer.from(expected, "base64url");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function validNewPassword(password) { return typeof password === "string" && password.length >= 12 && password.length <= 256; }

module.exports = { credential, sameOrigin, sessionCookie, sessions, loginLimiter, verifyPassword, validNewPassword };
