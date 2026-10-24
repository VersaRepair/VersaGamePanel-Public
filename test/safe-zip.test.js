"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  extractZipSafely,
  inspectZip,
  validateArchivePath
} = require("../lib/safe-zip");

async function temporaryDirectory(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "versagamepanel-zip-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  return base;
}

function createZip(cwd, zipPath, names, preserveSymlinks = false) {
  const args = ["-qr"];
  if (preserveSymlinks) args.push("-y");
  args.push(zipPath, ...names);
  execFileSync("zip", args, { cwd });
}

test("archive paths must be relative and canonical", () => {
  assert.equal(validateArchivePath("world/level.dat"), "world/level.dat");
  assert.equal(validateArchivePath("world/"), "world");

  for (const unsafe of [
    "../outside",
    "world/../../outside",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "world//level.dat",
    "world/./level.dat",
    "world\\level.dat",
    "world/\0level.dat"
  ]) {
    assert.throws(() => validateArchivePath(unsafe), /unsafe path|non-canonical path|Invalid path/);
  }
});

test("safe ZIP extraction writes ordinary files beneath an empty staging directory", async (t) => {
  const base = await temporaryDirectory(t);
  const source = path.join(base, "source");
  const archive = path.join(base, "world.zip");
  const destination = path.join(base, "destination");
  await fsp.mkdir(path.join(source, "world", "region"), { recursive: true });
  await fsp.writeFile(path.join(source, "world", "level.dat"), "level\n");
  await fsp.writeFile(path.join(source, "world", "region", "r.0.0.mca"), "region\n");
  createZip(source, archive, ["world"]);

  const manifest = await extractZipSafely(archive, destination);
  assert.ok(manifest.entries.some((entry) => entry.relative === "world/level.dat"));
  assert.equal(await fsp.readFile(path.join(destination, "world", "level.dat"), "utf8"), "level\n");
  assert.equal(await fsp.readFile(path.join(destination, "world", "region", "r.0.0.mca"), "utf8"), "region\n");
});

test("ZIP inspection and extraction reject archived symbolic links", async (t) => {
  const base = await temporaryDirectory(t);
  const source = path.join(base, "source");
  const archive = path.join(base, "symlink.zip");
  const destination = path.join(base, "destination");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(base, "outside.txt"), "outside\n");
  await fsp.symlink(path.join(base, "outside.txt"), path.join(source, "escape"));
  createZip(source, archive, ["escape"], true);

  await assert.rejects(inspectZip(archive), /symbolic link/);
  await assert.rejects(extractZipSafely(archive, destination), /symbolic link/);
  await assert.rejects(fsp.access(destination));
});

test("ZIP limits are enforced before extraction", async (t) => {
  const base = await temporaryDirectory(t);
  const source = path.join(base, "source");
  const archive = path.join(base, "large.zip");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "large.txt"), "x".repeat(1024));
  createZip(source, archive, ["large.txt"]);

  await assert.rejects(inspectZip(archive, { maxEntryBytes: 100 }), /entry is too large/);
  await assert.rejects(inspectZip(archive, { maxTotalBytes: 100 }), /configured limit/);
  await assert.rejects(inspectZip(archive, { maxEntries: 0 }), /too many entries/);
  await assert.rejects(inspectZip(archive, { maxCompressionRatio: 1 }), /compression ratio/);
});

test("a real ZIP with parent traversal is rejected before any writes", async (t) => {
  const base = await temporaryDirectory(t);
  const source = path.join(base, "source");
  const archive = path.join(base, "traversal.zip");
  const destination = path.join(base, "destination");
  await fsp.mkdir(path.join(source, "safe0"), { recursive: true });
  await fsp.writeFile(path.join(source, "safe0", "canary.txt"), "escape\n");
  createZip(source, archive, ["safe0/canary.txt"]);
  const ordinary = await fsp.readFile(archive);
  const malicious = Buffer.from(ordinary.toString("latin1").replaceAll("safe0/canary.txt", "../../canary.txt"), "latin1");
  assert.equal(malicious.length, ordinary.length);
  await fsp.writeFile(archive, malicious);
  await assert.rejects(extractZipSafely(archive, destination), /invalid relative path|unsafe path/);
  await assert.rejects(fsp.access(destination));
  await assert.rejects(fsp.access(path.join(base, "canary.txt")));
});

test("extraction rejects an existing destination symlink without touching its target", async (t) => {
  const base = await temporaryDirectory(t);
  const archive = path.join(base, "ordinary.zip");
  const outside = path.join(base, "outside");
  const destination = path.join(base, "destination");
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(base, "file.txt"), "data\n");
  createZip(base, archive, ["file.txt"]);
  await fsp.symlink(outside, destination);
  await assert.rejects(extractZipSafely(archive, destination), { code: "EEXIST" });
  assert.deepEqual(await fsp.readdir(outside), []);
  assert.ok((await fsp.lstat(destination)).isSymbolicLink());
});

test("safe extraction refuses a non-empty destination", async (t) => {
  const base = await temporaryDirectory(t);
  const source = path.join(base, "source");
  const archive = path.join(base, "file.zip");
  const destination = path.join(base, "destination");
  await fsp.mkdir(source);
  await fsp.mkdir(destination);
  await fsp.writeFile(path.join(source, "file.txt"), "data\n");
  await fsp.writeFile(path.join(destination, "existing.txt"), "keep\n");
  createZip(source, archive, ["file.txt"]);

  await assert.rejects(extractZipSafely(archive, destination), { code: "EEXIST" });
  assert.equal(await fsp.readFile(path.join(destination, "existing.txt"), "utf8"), "keep\n");
});
