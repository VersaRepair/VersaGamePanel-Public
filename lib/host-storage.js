"use strict";

const path = require("node:path");

// Docker bind sources are interpreted by the daemon, not by the panel container.
function hostStoragePath(directory, localRoot, hostRoot) {
  if (!hostRoot) return directory; // Existing native installations are unchanged.
  for (const root of [localRoot, hostRoot]) {
    if (!path.isAbsolute(root) || /[,:\r\n\x00]/.test(root) || path.resolve(root) === "/") throw new Error("Unsafe Docker data mount path.");
  }
  const relative = path.relative(path.resolve(localRoot), path.resolve(directory));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Docker data must be inside the persistent panel data mount.");
  return path.join(hostRoot, relative);
}

function mountedDataRoot(info) {
  const mounts = info.Mounts?.filter((entry) => entry.Destination === "/data");
  if (mounts?.length !== 1 || !mounts[0].RW || !["bind", "volume"].includes(mounts[0].Type)) throw new Error("Mount writable persistent storage at /data before starting the panel.");
  const mount = mounts[0];
  if (mount.Type === "volume" && mount.Driver !== "local") throw new Error("Only local Docker volumes or local bind mounts are supported by this alpha.");
  hostStoragePath("/data/servers/probe", "/data", mount.Source);
  return mount.Source;
}

module.exports = { hostStoragePath, mountedDataRoot };
