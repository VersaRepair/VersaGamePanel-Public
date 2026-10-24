"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");
const { safeJoin, safeRel } = require("./filesystem-safety");

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryBytes: 12 * 1024 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1000
});

function archivePath(entryName) {
  const raw = String(entryName || "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("Zip contains an unsafe path.");
  }
  const withoutSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!withoutSlash || withoutSlash.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Zip contains an unsafe path.");
  }
  const relative = safeRel(withoutSlash);
  if (relative !== withoutSlash) throw new Error("Zip contains a non-canonical path.");
  return relative;
}

function entryKind(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  const dosDirectory = Boolean(entry.externalFileAttributes & 0x10);
  const directory = entry.fileName.endsWith("/") || unixType === 0o040000 || dosDirectory;
  if (unixType === 0o120000) throw new Error("Zip contains a symbolic link.");
  if (unixType && unixType !== 0o100000 && unixType !== 0o040000) {
    throw new Error("Zip contains an unsupported special file.");
  }
  return directory ? "directory" : "file";
}

async function openZip(zipPath) {
  return yauzl.openPromise(zipPath, {
    autoClose: false,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true
  });
}

async function readManifest(zipfile, limits) {
  const entries = [];
  const rawEntries = [];
  const seen = new Set();
  let totalBytes = 0;

  for await (const entry of zipfile.eachEntry()) {
    if (entry.generalPurposeBitFlag & 0x1) throw new Error("Encrypted zip entries are not supported.");
    const relative = archivePath(entry.fileName);
    const kind = entryKind(entry);
    if (seen.has(relative)) throw new Error("Zip contains duplicate paths.");
    seen.add(relative);

    if (entries.length + 1 > limits.maxEntries) throw new Error("Zip contains too many entries.");
    if (entry.uncompressedSize > limits.maxEntryBytes) throw new Error("A zip entry is too large.");
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) throw new Error("Zip expands beyond the configured limit.");
    const ratio = entry.compressedSize === 0
      ? (entry.uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
      : entry.uncompressedSize / entry.compressedSize;
    if (ratio > limits.maxCompressionRatio) throw new Error("Zip has a suspicious compression ratio.");

    entries.push({
      compressedSize: entry.compressedSize,
      fileName: entry.fileName,
      kind,
      relative,
      uncompressedSize: entry.uncompressedSize
    });
    rawEntries.push(entry);
  }

  if (!entries.length) throw new Error("Zip file is empty.");
  return { manifest: { entries, totalBytes }, rawEntries };
}

async function inspectZip(zipPath, options = {}) {
  const zipfile = await openZip(zipPath);
  try {
    return (await readManifest(zipfile, { ...DEFAULT_LIMITS, ...options })).manifest;
  } finally {
    zipfile.close();
  }
}

async function extractZipSafely(zipPath, destination, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const resolvedDestination = path.resolve(destination);
  const zipfile = await openZip(zipPath);
  let createdDestination = false;
  let actualTotal = 0;

  try {
    const { manifest, rawEntries } = await readManifest(zipfile, limits);
    await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents extracting through an existing symlink or tree.
    await fsp.mkdir(resolvedDestination, { mode: 0o700 });
    createdDestination = true;

    for (let index = 0; index < manifest.entries.length; index += 1) {
      const planned = manifest.entries[index];
      const entry = rawEntries[index];
      const target = safeJoin(resolvedDestination, planned.relative);

      if (planned.kind === "directory") {
        await fsp.mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }

      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      let entryBytes = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          entryBytes += chunk.length;
          actualTotal += chunk.length;
          if (entryBytes > limits.maxEntryBytes || actualTotal > limits.maxTotalBytes) {
            callback(new Error("Zip expanded beyond the configured limit."));
            return;
          }
          callback(null, chunk);
        }
      });
      const input = await zipfile.openReadStreamPromise(entry);
      const output = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
      await pipeline(input, limiter, output);
      if (entryBytes !== planned.uncompressedSize) throw new Error("Zip entry size did not match its manifest.");
    }
    return manifest;
  } catch (error) {
    if (createdDestination) await fsp.rm(resolvedDestination, { recursive: true, force: true });
    throw error;
  } finally {
    zipfile.close();
  }
}

module.exports = {
  DEFAULT_LIMITS,
  extractZipSafely,
  inspectZip,
  validateArchivePath: archivePath
};
