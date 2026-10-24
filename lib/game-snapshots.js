"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { profiles, settings } = require("./game-profiles");
const { resolveSafePath, assertNoSymlinksInTree } = require("./filesystem-safety");
const { extractZipSafely } = require("./safe-zip");
const { replaceDirectory } = require("./directory-transaction");

function gameSnapshots({ server, dataRoot, backupRoot, zip }) {
  const profile = profiles[server.templateId];
  if (!profile) throw new Error("Save snapshots require a reviewed game profile.");
  const root = path.join(backupRoot, "snapshots");
  const scope = async () => resolveSafePath(dataRoot, profile.scope, { allowMissing: true });
  async function ensureRoot() {
    await resolveSafePath(backupRoot, "snapshots", { allowMissing: true });
    await fs.mkdir(root, { recursive: true });
  }
  async function list() {
    await ensureRoot();
    const result = [];
    for (const name of await fs.readdir(root)) {
      if (!/^save-[a-f0-9-]+\.zip$/.test(name)) continue;
      const file = await resolveSafePath(root, name);
      const stat = await fs.lstat(file);
      if (stat.isFile()) result.push({ name, size: stat.size, createdAt: stat.mtime.toISOString() });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function file(name) {
    if (!/^save-[a-f0-9-]+\.zip$/.test(name)) throw new Error("Choose a saved snapshot.");
    return resolveSafePath(root, name);
  }
  async function create() {
    await ensureRoot();
    const source = await scope();
    await assertNoSymlinksInTree(source);
    const stage = await fs.mkdtemp(path.join(backupRoot, ".snapshot-"));
    const name = `save-${crypto.randomUUID()}.zip`;
    const output = await resolveSafePath(root, name, { allowMissing: true });
    try {
      const payload = path.join(stage, "snapshot");
      await fs.mkdir(payload);
      await fs.cp(source, path.join(payload, "files"), { recursive: true, force: false, errorOnExist: true });
      await fs.writeFile(path.join(payload, "manifest.json"), JSON.stringify({ schemaVersion: 1, gameId: server.templateId, settings: settings(server.templateId, server.env) }), { mode: 0o600 });
      await zip(payload, output);
      await fs.chmod(output, 0o600);
      return name;
    } catch (error) { await fs.rm(output, { force: true }); throw error; }
    finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async function restore(name) {
    const archive = await file(name);
    const stage = await fs.mkdtemp(path.join(backupRoot, ".restore-"));
    try {
      await extractZipSafely(archive, path.join(stage, "extract"));
      const payload = path.join(stage, "extract", "snapshot");
      const manifest = JSON.parse(await fs.readFile(path.join(payload, "manifest.json"), "utf8"));
      if (manifest.schemaVersion !== 1 || manifest.gameId !== server.templateId) throw new Error("Snapshot belongs to a different game or unsupported format.");
      const restoredSettings = settings(server.templateId, manifest.settings);
      const source = path.join(payload, "files");
      await assertNoSymlinksInTree(source);
      if (!(await fs.stat(source)).isDirectory()) throw new Error("Snapshot save directory missing.");
      const target = await scope();
      // A validated snapshot cannot choose a host path. Preserve current saves first.
      const before = await create();
      await replaceDirectory(source, target);
      return { before, settings: restoredSettings };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  return { list, file, create, restore };
}
module.exports = { gameSnapshots };
