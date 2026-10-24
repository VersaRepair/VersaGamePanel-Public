"use strict";

const fsp = require("fs/promises");
const path = require("path");

function safeRel(value = "") {
  const raw = String(value).replace(/\\/g, "/");
  if (raw.includes("\0")) throw new Error("Invalid path.");
  if (!raw || raw === ".") return "";
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new Error("Invalid path.");
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid path.");
  return parts.join("/");
}

function safeJoin(root, rel = "") {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(path.join(resolvedRoot, safeRel(rel)));
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Invalid path.");
  }
  return resolvedTarget;
}

async function resolveSafePath(root, rel = "", options = {}) {
  const allowMissing = Boolean(options.allowMissing);
  const allowLeafSymlink = Boolean(options.allowLeafSymlink);
  const resolvedRoot = path.resolve(root);
  const relative = safeRel(rel);
  const target = safeJoin(resolvedRoot, relative);

  const rootStats = await fsp.lstat(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Unsafe server root.");

  const parts = relative ? relative.split("/") : [];
  let current = resolvedRoot;
  let encounteredMissing = false;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (encounteredMissing) continue;

    let stats;
    try {
      stats = await fsp.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) {
        encounteredMissing = true;
        continue;
      }
      throw error;
    }

    const isLeaf = index === parts.length - 1;
    if (stats.isSymbolicLink() && !(isLeaf && allowLeafSymlink)) {
      throw new Error("Symbolic links are not allowed in managed paths.");
    }
    if (!stats.isDirectory() && !stats.isFile() && !(isLeaf && allowLeafSymlink && stats.isSymbolicLink())) {
      throw new Error("Special files are not allowed in managed paths.");
    }
    if (!isLeaf && !stats.isDirectory()) throw new Error("Invalid path component.");
  }

  return target;
}

async function assertNoSymlinksInTree(root) {
  const resolvedRoot = path.resolve(root);
  const stats = await fsp.lstat(resolvedRoot);
  if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed in managed paths.");
  if (!stats.isDirectory()) {
    if (!stats.isFile()) throw new Error("Special files are not allowed in managed paths.");
    return resolvedRoot;
  }

  const pending = [resolvedRoot];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in managed paths.");
      if (!entry.isDirectory() && !entry.isFile()) throw new Error("Special files are not allowed in managed paths.");
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return resolvedRoot;
}

module.exports = {
  assertNoSymlinksInTree,
  resolveSafePath,
  safeJoin,
  safeRel
};
