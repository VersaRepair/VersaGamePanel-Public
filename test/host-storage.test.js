"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { hostStoragePath, mountedDataRoot } = require("../lib/host-storage");

test("container paths translate into daemon-side persistent storage, native paths stay unchanged", () => {
  assert.equal(hostStoragePath("/data/servers/one", "/data", "/var/lib/docker/volumes/vgp/_data"), "/var/lib/docker/volumes/vgp/_data/servers/one");
  assert.equal(hostStoragePath("/data/servers/two", "/data", "/srv/game panel"), "/srv/game panel/servers/two");
  assert.equal(hostStoragePath("/native/one", "/native"), "/native/one");
  for (const directory of ["/data", "/data/../etc", "/data-other/one"]) assert.throws(() => hostStoragePath(directory, "/data", "/srv/games"));
  for (const root of ["relative", "/", "/bad:path", "/bad,path", "/bad\npath"]) assert.throws(() => hostStoragePath("/data/servers/one", "/data", root));
});

test("container bootstrap requires a writable, exact, local persistent data mount", () => {
  const mount = { Destination: "/data", Source: "/srv/games", Type: "volume", Driver: "local", Name: "panel-data", RW: true };
  assert.equal(mountedDataRoot({ Mounts: [mount] }), "/srv/games");
  assert.equal(mountedDataRoot({ Mounts: [{ ...mount, Type: "bind" }] }), "/srv/games");
  for (const Mounts of [[], [mount, mount], [{ ...mount, RW: false }], [{ ...mount, Driver: "remote" }], [{ ...mount, Destination: "/elsewhere" }], [{ ...mount, Source: "/" }]]) assert.throws(() => mountedDataRoot({ Mounts }));
  assert.throws(() => mountedDataRoot({ Mounts: [{ ...mount, Name: "a".repeat(64) }] }), /explicitly named/);
});
