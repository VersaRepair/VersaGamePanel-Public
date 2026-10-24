"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectFile, report } = require("./mod-inspector");
const { collectMultipart } = require("./file-upload");
const { resolveSafePath, assertNoSymlinksInTree } = require("./filesystem-safety");
const { replaceDirectory } = require("./directory-transaction");
const { saveJson } = require("./json-store");

const LIMITS = { maxFiles: 256, maxFileBytes: 128 * 1024 ** 2, maxTotalBytes: 512 * 1024 ** 2, rejectDuplicates: true };
let catalogCache;
async function versionCatalog() {
  if (process.env.GAMEPANEL_OFFLINE_METADATA === "1") return [];
  if (catalogCache && Date.now() - catalogCache.at < 600000) return catalogCache.versions;
  try {
    const response = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return [];
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error("Catalog too large"); chunks.push(chunk); }
    const manifest = JSON.parse(Buffer.concat(chunks).toString());
    const versions = manifest.versions.filter((entry) => entry.type === "release" && /^\d+(\.\d+){1,2}$/.test(entry.id)).slice(0, 600).map((entry) => entry.id);
    catalogCache = { at: Date.now(), versions }; return versions;
  } catch (_) { return []; }
}
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function modPlans({ server, stageRoot, dataRoot, backupRoot, runtime, save, beforeApply = async () => {} }) {
  const selected = () => ({ type: server.env?.TYPE || "", version: server.env?.VERSION || "", loaderVersion: server.env?.FABRIC_LOADER_VERSION || server.env?.FORGE_VERSION || server.env?.NEOFORGE_VERSION || server.env?.QUILT_LOADER_VERSION || "" });
  async function ensure() { await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 }); await resolveSafePath(stageRoot); }
  async function planRoot(id) { if (!/^[a-f0-9-]{36}$/.test(id)) fail("Choose an inspection plan."); await ensure(); return resolveSafePath(stageRoot, id); }
  async function read(id) { return JSON.parse(await fs.readFile(await resolveSafePath(await planRoot(id), "plan.json"), "utf8")); }
  async function list() {
    await ensure(); const plans = [];
    for (const id of await fs.readdir(stageRoot)) if (/^[a-f0-9-]{36}$/.test(id)) {
      try { plans.push(await read(id)); } catch (_) { /* incomplete uploads are not plans */ }
    }
    return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function inspect(req) {
    if (server.templateId !== "minecraft-paper") fail("Custom JAR uploads use a Minecraft Java server, not an automatically downloaded pack or Bedrock.");
    await ensure();
    if ((await fs.readdir(stageRoot)).length >= 4) fail("Discard an older inspection before uploading another (maximum four staged packs).", 409);
    const id = crypto.randomUUID(); const root = path.join(stageRoot, id);
    await fs.mkdir(root, { mode: 0o700 });
    try {
      const uploads = await collectMultipart(req, path.join(root, "files"), LIMITS);
      if (!uploads.length) fail("Choose mod JARs, a mods folder, or a supported pack archive.");
      const files = [];
      const names = new Set();
      for (const upload of uploads) {
        if (!/\.(jar|zip|mrpack)$/i.test(upload.rel)) fail("This step accepts mod JARs or pack ZIP/MRPACK files. Config-folder import is separate.");
        if (names.has(upload.filename)) fail("Two uploaded files have the same basename; rename or remove the duplicate.");
        names.add(upload.filename);
        try { files.push({ ...await inspectFile(upload.path, upload.rel), relative: upload.rel }); }
        catch (error) { files.push({ name: upload.rel, relative: upload.rel, mods: [], packs: [], warnings: [], error: String(error.message).slice(0, 500) }); }
      }
      const analysis = report(files, selected(), await versionCatalog());
      for (const file of files) if (file.error) { analysis.issues.push({ severity: "error", code: "invalid-file", message: file.error, file: file.name }); analysis.safeToApply = false; }
      const plan = { id, createdAt: new Date().toISOString(), ...analysis };
      await saveJson(path.join(root, "plan.json"), plan); return plan;
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); if (!error.code && !error.statusCode) error.statusCode = 400; throw error; }
  }
  async function apply(id, input) {
    if (server.templateId !== "minecraft-paper") fail("Use a Minecraft Java custom-mod server.");
    if (input.confirm !== true) fail("Please confirm the reviewed plan before applying it.");
    if (server.env?.EULA !== "TRUE") fail("Accept the Minecraft EULA in Options before applying or starting a modded server.");
    if ((await runtime()).running) fail("Please stop the game before applying mods.", 409);
    const plan = await read(id);
    const type = String(input.type || "").toUpperCase(); const version = String(input.version || "");
    if (!["FABRIC", "QUILT", "FORGE", "NEOFORGE"].includes(type) || !/^\d+(\.\d+){1,2}$/.test(version)) fail("Choose a supported loader and an explicit Minecraft release version.");
    const fresh = [];
    for (const file of plan.files) {
      let actual;
      try { actual = await inspectFile(await resolveSafePath(path.join(await planRoot(id), "files"), file.relative), file.name); }
      catch (_) { fail("Staged files changed or became invalid; inspect them again.", 409); }
      if (actual.sha256 !== file.sha256) fail("Staged files changed; inspect them again.", 409);
      fresh.push(actual);
    }
    const checked = report(fresh, { ...selected(), type, version }, [version]);
    if (!checked.safeToApply) fail("Resolve the inspection errors or pack references before applying.");
    if (checked.issues.some((item) => item.severity === "warning") && input.acceptWarnings !== true) fail("Review and explicitly acknowledge the inspection warnings.");
    await fs.mkdir(dataRoot, { recursive: true });
    await resolveSafePath(dataRoot);
    const changeRuntime = type !== server.env.TYPE || version !== server.env.VERSION;
    if (changeRuntime) {
      const entries = await fs.readdir(dataRoot, { recursive: true });
      if (entries.some((entry) => path.basename(entry) === "level.dat")) fail("An existing world was found. Loader/version changes require a separate fresh server or a reviewed world migration; this plan will not change that world.", 409);
    }
    const target = await resolveSafePath(dataRoot, "mods", { allowMissing: true });
    const backup = path.join(backupRoot, "mod-changes", crypto.randomUUID());
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    const originalEnv = { ...server.env };
    try { await assertNoSymlinksInTree(target); await fs.cp(target, path.join(backup, "mods"), { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(path.join(backup, "mods")); }
    await saveJson(path.join(backup, "settings.json"), Object.fromEntries(["TYPE", "VERSION", "MODS", "MODRINTH_PROJECTS", "REMOVE_OLD_MODS"].map((key) => [key, server.env[key] ?? ""])));
    await beforeApply();
    const incoming = path.join(await planRoot(id), "incoming");
    await fs.mkdir(incoming);
    let promoted = false;
    try {
      for (const file of plan.files) {
        if (!/\.jar$/i.test(file.name)) fail("Only inspected JAR folders can be applied here; use the pack-specific software workflow for remote manifests.");
        await fs.copyFile(await resolveSafePath(path.join(await planRoot(id), "files"), file.relative), path.join(incoming, path.basename(file.name)));
      }
      await replaceDirectory(incoming, target); promoted = true;
      server.env = { ...server.env, TYPE: type, VERSION: version, MODS: "", MODRINTH_PROJECTS: "", REMOVE_OLD_MODS: "FALSE" };
      await save();
      // Cleanup failure after a committed state write must not roll back only
      // the files while leaving the newly persisted settings behind.
      await fs.rm(await planRoot(id), { recursive: true, force: true }).catch(() => {});
      return { ok: true, message: "Inspected mod set and selected loader/version applied. Game remains stopped. Read its loader logs on first start.", backup: path.basename(backup) };
    } catch (error) {
      server.env = originalEnv;
      if (promoted) await replaceDirectory(path.join(backup, "mods"), target);
      throw error;
    } finally { await fs.rm(incoming, { recursive: true, force: true }); }
  }
  async function discard(id) { await fs.rm(await planRoot(id), { recursive: true, force: true }); }
  async function backupDirectory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail("Choose a prior mod backup.");
    return resolveSafePath(backupRoot, `mod-changes/${id}`);
  }
  async function backups() {
    try {
      const root = await resolveSafePath(backupRoot, "mod-changes"); const result = [];
      for (const id of await fs.readdir(root)) if (/^[a-f0-9-]{36}$/.test(id)) { const file = await backupDirectory(id); const stat = await fs.lstat(file); if (stat.isDirectory()) result.push({ id, createdAt: stat.mtime.toISOString() }); }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  return { list, inspect, apply, discard, backups, backupDirectory };
}
module.exports = { modPlans, versionCatalog, LIMITS };
