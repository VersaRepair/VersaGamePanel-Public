"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const yauzl = require("yauzl");
const { parse: toml } = require("smol-toml");
const semver = require("semver");
const { inspectZip } = require("./safe-zip");

const METADATA = new Set(["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "META-INF/MANIFEST.MF", "META-INF/jarjar/metadata.json", "modrinth.index.json", "manifest.json"]);
async function metadata(file) {
  await inspectZip(file, { maxEntries: 30000, maxEntryBytes: 256 * 1024 ** 2, maxTotalBytes: 512 * 1024 ** 2, maxCompressionRatio: 1000 });
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const result = {};
  try {
    for await (const entry of zip.eachEntry()) {
      if (!METADATA.has(entry.fileName)) continue;
      if (entry.uncompressedSize > 1024 * 1024) throw new Error("Mod metadata is too large.");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of stream) { bytes += chunk.length; if (bytes > 1024 * 1024) { stream.destroy(); throw new Error("Mod metadata is too large."); } chunks.push(chunk); }
      result[entry.fileName] = Buffer.concat(chunks).toString("utf8");
    }
    return result;
  } finally { zip.close(); }
}
function safeText(value, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 500) : fallback;
}
function dependencies(value, type = "required", syntax = "fabric") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).slice(0, 512).map(([id, range]) => ({ id, range, type, syntax }));
}
function parseMetadata(meta, file) {
  const mods = [];
  const packs = [];
  const warnings = [];
  const add = (loader, value) => {
    if (!value.id || !value.version) throw new Error("Mod metadata is missing its ID or version.");
    mods.push({ file, loader, ...value, id: safeText(value.id), version: safeText(value.version), name: safeText(value.name, safeText(value.id)) });
  };
  if (meta["fabric.mod.json"]) {
    const m = JSON.parse(meta["fabric.mod.json"]);
    if (m.schemaVersion !== 1) throw new Error("Unsupported Fabric metadata version.");
    add("FABRIC", { id: m.id, version: m.version, name: m.name, environment: m.environment || "*", provides: Array.isArray(m.provides) ? m.provides.slice(0, 512).filter((id) => typeof id === "string") : [], dependencies: [...dependencies(m.depends), ...dependencies(m.breaks, "incompatible")], nested: Array.isArray(m.jars) && m.jars.length > 0 });
  }
  if (meta["quilt.mod.json"]) {
    const document = JSON.parse(meta["quilt.mod.json"]);
    if (document.schema_version !== 1 || !document.quilt_loader) throw new Error("Unsupported Quilt metadata version.");
    const m = document.quilt_loader;
    const deps = (values, type) => (Array.isArray(values) ? values.slice(0, 512) : []).map((dep) => typeof dep === "string" ? { id: dep, range: "*", type, syntax: "quilt" } : { id: dep.id, range: dep.versions || "*", type: dep.optional ? "optional" : type, syntax: "quilt", complex: Boolean(dep.any || dep.all || dep.unless || !dep.id) });
    add("QUILT", { id: m.id, version: m.version, name: m.metadata?.name, provides: (m.provides || []).slice(0, 512).filter((alias) => typeof alias === "string" || alias && typeof alias.id === "string"), environment: document.minecraft?.environment || "*", dependencies: [...deps(m.depends, "required"), ...deps(m.breaks, "incompatible")], nested: Array.isArray(m.jars) && m.jars.length > 0 });
  }
  for (const [key, loader] of [["META-INF/mods.toml", "FORGE"], ["META-INF/neoforge.mods.toml", "NEOFORGE"]]) {
    if (!meta[key]) continue;
    const m = toml(meta[key]);
    if (!Array.isArray(m.mods) || !m.mods.length) throw new Error("TOML mod metadata has no mod records.");
    for (const mod of m.mods.slice(0, 256)) {
      const manifestVersion = meta["META-INF/MANIFEST.MF"]?.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
      const deps = (m.dependencies?.[mod.modId] || []).slice(0, 512).filter((dep) => dep.side !== "CLIENT").map((dep) => ({ id: dep.modId, range: dep.versionRange || "*", type: dep.type || (dep.mandatory === false ? "optional" : "required"), syntax: "maven" }));
      if (m.loaderVersion) deps.push({ id: m.modLoader || "javafml", range: m.loaderVersion, type: "required", syntax: "maven" });
      const java = mod.features?.javaVersion || m.features?.[mod.modId]?.javaVersion;
      if (java) deps.push({ id: "java", range: java, type: "required", syntax: "maven" });
      add(loader === "FORGE" && deps.some((dep) => dep.id === "neoforge") ? "NEOFORGE" : loader, { id: mod.modId, version: mod.version === "${file.jarVersion}" ? manifestVersion || mod.version : mod.version, name: mod.displayName, environment: "unknown", provides: [], dependencies: deps, nested: Boolean(meta["META-INF/jarjar/metadata.json"]) });
    }
  }
  if (meta["modrinth.index.json"]) {
    const m = JSON.parse(meta["modrinth.index.json"]);
    if (m.formatVersion !== 1 || m.game !== "minecraft") throw new Error("Unsupported Modrinth pack format.");
    packs.push({ format: "modrinth", name: safeText(m.name), minecraft: safeText(m.dependencies?.minecraft), loaders: Object.entries(m.dependencies || {}).filter(([key]) => key !== "minecraft").map(([key, version]) => ({ id: key, version: safeText(version) })), referencedFiles: Array.isArray(m.files) ? m.files.length : 0 });
    warnings.push("Pack manifest only: referenced downloads and override files have not been resolved or installed.");
  }
  if (meta["manifest.json"]) {
    const m = JSON.parse(meta["manifest.json"]);
    if (m.manifestType === "minecraftModpack") {
      if (m.manifestVersion !== 1) throw new Error("Unsupported CurseForge pack format.");
      packs.push({ format: "curseforge", name: safeText(m.name), minecraft: safeText(m.minecraft?.version), loaders: (m.minecraft?.modLoaders || []).map((loader) => ({ id: safeText(loader.id) })), referencedFiles: Array.isArray(m.files) ? m.files.length : 0 });
      warnings.push("CurseForge manifest only: referenced files require a separate, explicitly authorized download workflow.");
    }
  }
  if (!mods.length && !packs.length) warnings.push("No supported mod or pack metadata found. Filename-based guessing is not used.");
  if (mods.some((mod) => mod.nested)) warnings.push("Nested bundled JARs are present; their metadata is not recursively inspected in this checkpoint.");
  return { mods, packs, warnings };
}

// Three-valued matching: an unsupported predicate is unknown, never a pass.
function match(version, range, syntax = "fabric") {
  if (Array.isArray(range)) {
    const values = range.map((r) => match(version, r, syntax));
    return values.includes(true) ? true : values.every((v) => v === false) ? false : null;
  }
  if (typeof range !== "string" || range.length > 512 || typeof version !== "string" || version.includes("${")) return null;
  range = range.trim();
  if (range === "*" || !range) return true;
  if (range === version || range === `=${version}`) return true;
  const actual = semver.valid(version) || (/^\d+(\.\d+){0,2}$/.test(version) ? semver.coerce(version)?.version : null);
  if (!actual) return /^[\w.-]+$/.test(range) ? false : null;
  if (syntax === "maven" && /^[[(]/.test(range)) {
    if (/^\[[^,\[\]]+\]$/.test(range)) return match(version, range.slice(1, -1));
    const interval = range.match(/^([[(])\s*([^,]*)\s*,\s*([^\])]*)\s*([\])])$/);
    if (!interval) return null;
    const [, left, low, high, right] = interval;
    const bounds = [];
    if (low.trim()) bounds.push(`${left === "[" ? ">=" : ">"}${semver.coerce(low.trim())?.version || "invalid"}`);
    if (high.trim()) bounds.push(`${right === "]" ? "<=" : "<"}${semver.coerce(high.trim())?.version || "invalid"}`);
    range = bounds.join(" ");
  }
  if (!semver.validRange(range, { loose: true })) return null;
  return semver.satisfies(actual, range, { loose: true, includePrerelease: true });
}
async function inspectFile(file, name) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 128 * 1024 ** 2) throw new Error("Choose a mod/pack file up to 128 MiB.");
  const bytes = await fs.readFile(file);
  return { name, bytes: stat.size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...parseMetadata(await metadata(file), name) };
}
function report(files, selected = {}, candidates = []) {
  const issues = [];
  const issue = (severity, code, message, file = "") => issues.push({ severity, code, message, file });
  const mods = files.flatMap((file) => file.mods);
  const packs = files.flatMap((file) => file.packs);
  if (mods.length > 2048 || mods.reduce((sum, mod) => sum + mod.dependencies.length, 0) > 20000) throw new Error("Pack metadata is too complex for bounded inspection.");
  const loaders = [...new Set(mods.map((mod) => mod.loader))];
  const byId = new Map();
  for (const mod of mods) {
    const list = byId.get(mod.id) || [];
    // Multiple metadata formats in the same physical JAR are alternatives.
    if (!list.some((entry) => entry.file === mod.file)) list.push(mod);
    byId.set(mod.id, list);
    for (const alias of mod.provides) {
      const id = typeof alias === "string" ? alias : alias.id;
      const entries = byId.get(id) || [];
      if (!entries.some((entry) => entry.file === mod.file)) entries.push({ ...mod, version: typeof alias === "object" ? safeText(alias.version, mod.version) : mod.version });
      byId.set(id, entries);
    }
  }
  for (const [id, entries] of byId) if (entries.length > 1) issue("error", "duplicate-id", `Multiple files provide ${id}.`);
  const compatibleLoaders = ["FABRIC", "QUILT", "FORGE", "NEOFORGE"].filter((loader) => files.filter((file) => file.mods.length).every((file) => file.mods.some((mod) => mod.loader === loader)));
  if (loaders.length && !compatibleLoaders.length) issue("error", "mixed-loaders", "These files do not share a declared loader. Fabric, Quilt, Forge and NeoForge are not assumed interchangeable.");
  const chosen = safeText(selected.type).toUpperCase();
  if (loaders.length && chosen && !compatibleLoaders.includes(chosen)) issue("error", "wrong-loader", `Selected ${chosen} does not match the files' declared loader alternatives.`);
  const activeMods = mods.filter((mod) => mod.loader === chosen || (!compatibleLoaders.includes(chosen) && mod.loader === compatibleLoaders[0]));
  const minecraftRules = [];
  const builtins = { minecraft: selected.version, java: selected.java, fabricloader: selected.loaderVersion, quilt_loader: selected.loaderVersion, forge: selected.loaderVersion, neoforge: selected.loaderVersion, javafml: selected.fmlVersion };
  for (const mod of activeMods) {
    if (mod.environment === "client") issue("error", "client-only", `${mod.id} is explicitly client-only.`, mod.file);
    if (mod.nested) issue("warning", "nested-unresolved", `${mod.id} includes bundled JARs; dependency analysis is incomplete.`, mod.file);
    for (const dep of mod.dependencies) {
      if (dep.complex) { issue("warning", "unknown-predicate", `Complex dependency declaration in ${mod.id} needs loader validation.`, mod.file); continue; }
      if (dep.id === "minecraft" && dep.type === "required") minecraftRules.push(dep);
      const entries = byId.get(dep.id);
      const version = Object.hasOwn(builtins, dep.id) ? builtins[dep.id] : entries?.[0]?.version;
      if (!version) {
        if (Object.hasOwn(builtins, dep.id)) issue("warning", "runtime-version-unknown", `Version of ${dep.id} is not specified; ${mod.id} requires ${JSON.stringify(dep.range)}.`, mod.file);
        else if (dep.type === "required") issue(mod.nested || mods.some((item) => item.nested) ? "warning" : "error", "missing-dependency", `${mod.id} requires ${dep.id}; no top-level provider was found.`, mod.file);
        continue;
      }
      const result = match(version, dep.range, dep.syntax);
      if (result === null) issue("warning", "unknown-range", `Cannot confidently evaluate ${mod.id}'s ${dep.id} constraint.`, mod.file);
      else if (dep.type === "incompatible" && result) issue("error", "declared-conflict", `${mod.id} declares an incompatibility with ${dep.id} ${version}.`, mod.file);
      else if (["required", "optional"].includes(dep.type) && !result) issue("error", dep.id === "minecraft" ? "wrong-minecraft" : "dependency-version", `${mod.id} requires ${dep.id} ${JSON.stringify(dep.range)}, not ${version}.`, mod.file);
    }
  }
  for (const pack of packs) if (pack.minecraft) minecraftRules.push({ range: pack.minecraft, syntax: "fabric" });
  const catalog = [...new Set([...candidates, ...packs.map((pack) => pack.minecraft), ...minecraftRules.flatMap((rule) => typeof rule.range === "string" && /^=?\d+(\.\d+){1,2}$/.test(rule.range) ? [rule.range.replace(/^=/, "")] : [])])].filter(Boolean);
  const suggestions = minecraftRules.length ? catalog.filter((version) => minecraftRules.every((rule) => match(version, rule.range, rule.syntax) === true)) : [];
  const selectedMatches = minecraftRules.length ? minecraftRules.every((rule) => match(selected.version, rule.range, rule.syntax) === true) : false;
  for (const file of files) for (const warning of file.warnings) issue("warning", "inspection-limit", warning, file.name);
  if (!mods.length && !packs.length) issue("error", "no-metadata", "No supported mod or pack metadata was found.");
  return { schemaVersion: 1, files, selected, compatibleLoaders, minecraft: { selectedMatches, candidates: suggestions, catalogComplete: false }, issues, safeToApply: issues.every((item) => item.severity !== "error") && mods.length > 0 && packs.length === 0,
    notice: "Metadata inspection only—not a malware scan or a guarantee of runtime/gameplay compatibility. No code was executed, downloaded or installed. Version changes require explicit confirmation." };
}
module.exports = { metadata, parseMetadata, match, inspectFile, report };
