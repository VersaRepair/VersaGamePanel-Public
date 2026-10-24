"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { credential, sameOrigin, sessionCookie, sessions, loginLimiter, validNewPassword } = require("../lib/auth-sessions");
const { panelFixture } = require("../test-support/panel");

test("opaque sessions expire, revoke, bound capacity and do not survive process restart", () => {
  let time = 0;
  const store = sessions({ now: () => time, ttlMs: 100, idleMs: 30, maxSessions: 2 });
  const token = store.issue("admin");
  assert.equal(token.length, 43);
  assert.equal(store.resolve(token), "admin");
  time = 20; assert.equal(store.resolve(token), "admin");
  time = 49; assert.equal(store.resolve(token, false), "admin");
  time = 50; assert.equal(store.resolve(token), null, "background checks do not extend idle timeout");
  const second = store.issue("admin");
  store.revokeUser("admin"); assert.equal(store.resolve(second), null);
  const third = store.issue("admin");
  assert.equal(sessions().resolve(third), null);
  store.issue("other"); assert.throws(() => store.issue("third"), /Too many/);
  time = 151; assert.equal(store.resolve(third), null);
});

test("cookie/origin transport has no query credential fallback and rejects cross-site input", () => {
  assert.equal(credential({ headers: { cookie: "other=x; gp_session=opaque; another=y" } }), "opaque");
  assert.equal(credential({ headers: {} }), "");
  assert.equal(credential({ headers: { authorization: "Bearer api", cookie: "gp_session=cookie" } }), "api");
  assert.match(sessionCookie("test", true), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.match(sessionCookie(""), /Max-Age=0/);
  assert.equal(sameOrigin({ headers: { host: "panel:8788", origin: "http://panel:8788" } }), true);
  assert.equal(sameOrigin({ headers: { host: "panel", origin: "https://panel" } }), false);
  assert.equal(sameOrigin({ headers: { host: "internal", origin: "https://public.test" } }, "https://public.test"), true);
  assert.equal(validNewPassword("short"), false);
  assert.equal(validNewPassword("long-enough-passphrase"), true);
});

test("login failure limiter expires and bounds its identifier map", () => {
  let time = 0;
  const limiter = loginLimiter({ now: () => time, maxFailures: 2, maxEntries: 1, windowMs: 100 });
  assert.equal(limiter.blocked("one"), false);
  limiter.fail("one"); limiter.fail("one");
  assert.equal(limiter.blocked("one"), true);
  assert.equal(limiter.blocked("new"), true);
  time = 100; assert.equal(limiter.blocked("one"), false);
});

test("real auth API preserves accounts, rejects legacy/URL tokens, checks cookie origins and revokes sessions", { timeout: 20000 }, async (t) => {
  const f = await panelFixture(t, undefined, { legacyToken: false });
  const newPassword = crypto.randomBytes(24).toString("base64url");
  const raw = async (route, body, headers = {}) => fetch(`${f.url}/api${route}`, { method: body == null ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, body: body == null ? undefined : JSON.stringify(body) });
  const login = (password, extra = {}, headers = {}) => raw("/auth/login", { username: "admin", password, ...extra }, headers);
  assert.equal((await f.request("/auth/me")).status, 401, "bootstrap file is not a default API credential");
  assert.equal((await raw(`/auth/me?token=${f.token}`)).status, 401);
  assert.equal((await login(f.token, {}, { origin: "https://evil.test" })).status, 403);
  const cookieLogin = await login(f.token, { sessionMode: "cookie" }, { origin: f.url });
  assert.equal(cookieLogin.status, 200);
  assert.equal((await cookieLogin.json()).token, undefined, "browser does not receive its session in JavaScript");
  const cookie = cookieLogin.headers.get("set-cookie").split(";")[0];
  assert.match(cookieLogin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await raw("/auth/me", null, { cookie })).status, 200);
  assert.equal((await raw("/auth/logout", {}, { cookie })).status, 403);
  assert.equal((await raw("/auth/logout", {}, { cookie, origin: "https://evil.test" })).status, 403);
  const bearer = (await (await login(f.token)).json()).token;
  const auth = { authorization: `Bearer ${bearer}` };
  assert.equal((await raw(`/auth/me?token=${bearer}`)).status, 401);
  assert.equal((await raw("/users", { username: "weak", password: "tiny" }, auth)).status, 400);
  const changed = await raw("/auth/password", { currentPassword: f.token, newPassword }, { cookie, origin: f.url });
  assert.equal(changed.status, 200);
  assert.equal((await raw("/auth/me", null, auth)).status, 401);
  assert.equal((await raw("/auth/me", null, { cookie })).status, 401);
  assert.equal((await login(f.token)).status, 401);
  const fresh = await login(newPassword);
  assert.equal(fresh.status, 200);
  const second = (await fresh.json()).token;
  assert.equal((await raw("/auth/logout", {}, { authorization: `Bearer ${second}` })).status, 200);
  assert.equal((await raw("/auth/me", null, { authorization: `Bearer ${second}` })).status, 401);
  const restartToken = (await (await login(newPassword)).json()).token;
  await f.stop(); await f.start();
  assert.equal((await raw("/auth/me", null, { authorization: `Bearer ${restartToken}` })).status, 401);
  const adminLogin = await login(newPassword);
  assert.equal(adminLogin.status, 200, "password and account survive restart");
  const adminToken = (await adminLogin.json()).token;
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const operatorPassword = crypto.randomBytes(20).toString("base64url");
  assert.equal((await raw("/users", { username: "operator", password: operatorPassword }, adminHeaders)).status, 201);
  const operatorLogin = await raw("/auth/login", { username: "operator", password: operatorPassword });
  const operatorToken = (await operatorLogin.json()).token;
  const update = await f.request("/users/operator", { method: "PUT", headers: adminHeaders, body: { role: "admin" } });
  assert.equal(update.status, 200);
  assert.equal((await raw("/auth/me", null, { authorization: `Bearer ${operatorToken}` })).status, 401, "role changes revoke existing sessions");
  const freshCookie = await login(newPassword, { sessionMode: "cookie" }, { origin: f.url });
  const lastCookie = freshCookie.headers.get("set-cookie").split(";")[0];
  const loggedOut = await raw("/auth/logout", {}, { cookie: lastCookie, origin: f.url });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await raw("/auth/me", null, { cookie: lastCookie })).status, 401);
});

test("real API throttles failed logins despite spoofed forwarded addresses", { timeout: 20000 }, async (t) => {
  const f = await panelFixture(t);
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${f.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${index}` }, body: JSON.stringify({ username: "unknown", password: "wrong" }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Invalid username or password.");
  }
  const blocked = await fetch(`${f.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: f.token }) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "300");
});
