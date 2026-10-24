"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertNoSymlinksInTree,
  resolveSafePath,
  safeJoin,
  safeRel
} = require("../lib/filesystem-safety");

async function temporaryTree(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "versagamepanel-paths-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  await fsp.mkdir(root);
  return { base, root };
}

test("safeRel accepts canonical relative paths only", () => {
  assert.equal(safeRel(""), "");
  assert.equal(safeRel("world/region/r.0.0.mca"), "world/region/r.0.0.mca");

  for (const unsafe of [
    "/etc/passwd",
    "../outside",
    "world/../outside",
    "world//level.dat",
    "./world",
    "C:/Windows/system.ini",
    "world/\0level.dat"
  ]) {
    assert.throws(() => safeRel(unsafe), /Invalid path/);
  }
});

test("safeJoin cannot escape its configured root", () => {
  const root = path.resolve("/tmp/versagamepanel-root");
  assert.equal(safeJoin(root, "world/level.dat"), path.join(root, "world", "level.dat"));
  assert.throws(() => safeJoin(root, "../../etc/passwd"), /Invalid path/);
});

test("resolveSafePath rejects intermediate and leaf symbolic links", async (t) => {
  const { base, root } = await temporaryTree(t);
  const outside = path.join(base, "outside");
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "canary.txt"), "outside\n");
  await fsp.symlink(outside, path.join(root, "linked-dir"));
  await fsp.symlink(path.join(outside, "canary.txt"), path.join(root, "linked-file"));

  await assert.rejects(
    resolveSafePath(root, "linked-dir/canary.txt"),
    /Symbolic links are not allowed/
  );
  await assert.rejects(
    resolveSafePath(root, "linked-file"),
    /Symbolic links are not allowed/
  );

  assert.equal(
    await resolveSafePath(root, "linked-file", { allowLeafSymlink: true }),
    path.join(root, "linked-file")
  );
});

test("resolveSafePath permits missing descendants without skipping existing-link checks", async (t) => {
  const { base, root } = await temporaryTree(t);
  const outside = path.join(base, "outside");
  await fsp.mkdir(outside);
  await fsp.symlink(outside, path.join(root, "linked-dir"));

  assert.equal(
    await resolveSafePath(root, "new/nested/file.txt", { allowMissing: true }),
    path.join(root, "new", "nested", "file.txt")
  );
  await assert.rejects(
    resolveSafePath(root, "linked-dir/new.txt", { allowMissing: true }),
    /Symbolic links are not allowed/
  );
});

test("assertNoSymlinksInTree rejects a symlink anywhere below the root", async (t) => {
  const { base, root } = await temporaryTree(t);
  await fsp.mkdir(path.join(root, "world", "region"), { recursive: true });
  await fsp.writeFile(path.join(root, "world", "level.dat"), "ok\n");
  await assertNoSymlinksInTree(root);

  const outside = path.join(base, "outside.txt");
  await fsp.writeFile(outside, "outside\n");
  await fsp.symlink(outside, path.join(root, "world", "region", "escape"));
  await assert.rejects(assertNoSymlinksInTree(root), /Symbolic links are not allowed/);
});
