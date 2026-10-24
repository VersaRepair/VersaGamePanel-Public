"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const execute = promisify(execFile);
async function jar(base, entries, name = `${crypto.randomUUID()}.jar`) {
  const directory = path.join(base, crypto.randomUUID()); await fs.mkdir(directory);
  for (const [file, content] of Object.entries(entries)) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), typeof content === "string" ? content : JSON.stringify(content)); }
  const file = path.join(base, name); await execute("zip", ["-qr", file, "."], { cwd: directory }); await fs.rm(directory, { recursive: true }); return file;
}
function fabric(id = "sample", overrides = {}) { return { schemaVersion: 1, id, version: "1.0.0", environment: "*", depends: { minecraft: "~1.21.1" }, ...overrides }; }
async function uploadPlan(f, id, files, expected = 201) {
  const form = new FormData();
  for (const [name, file] of files) form.append("files", new Blob([await fs.readFile(file)]), name);
  const response = await fetch(`${f.url}/api/servers/${id}/mods/inspect`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: form });
  const payload = await response.json();
  require("node:assert/strict").equal(response.status, expected, payload.error);
  return payload.plan;
}
module.exports = { jar, fabric, uploadPlan };
