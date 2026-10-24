"use strict";

// Private password arrives through stdin, never argv, source, or output.
const fs = require("node:fs");
const assert = require("node:assert/strict");
async function main() {
  const origin = "http://127.0.0.1:8788";
  const password = fs.readFileSync(0, "utf8").trim();
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ username: "admin", password }) });
  assert.equal(login.status, 200, "existing lab login failed");
  const { token } = await login.json();
  assert.ok(token);
  const headers = { authorization: `Bearer ${token}`, origin };
  try {
    const servers = await (await fetch(`${origin}/api/servers`, { headers })).json();
    const templates = await (await fetch(`${origin}/api/templates`, { headers })).json();
    const ids = ["unturned-dedicated", "terraria-vanilla", "terraria-tmodloader-reviewed"];
    for (const id of ids) assert.ok(templates.templates.some((template) => template.id === id));
    assert.equal(servers.servers.length, 0, "no test records should be deployed");
    console.log(JSON.stringify({ authenticated: true, records: servers.servers.length, reviewedProfiles: ids }));
  } finally {
    await fetch(`${origin}/api/auth/logout`, { method: "POST", headers });
  }
}
main().catch(() => { console.error("Lab login/profile smoke check failed (credentials withheld)."); process.exitCode = 1; });
