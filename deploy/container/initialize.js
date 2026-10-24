"use strict";
const fs = require("node:fs");
try {
  const socket = fs.statSync("/var/run/docker.sock");
  if (!socket.isSocket()) throw new Error("Mount the host Docker socket at /var/run/docker.sock.");
  const data = fs.lstatSync("/data");
  if (!data.isDirectory() || data.isSymbolicLink()) throw new Error("/data must be a real persistent directory.");
  // Never recursively chown customer storage. Only initialize an empty root-owned bind.
  if (data.uid === 0 && fs.readdirSync("/data").length === 0) fs.chownSync("/data", 1000, 1000);
  process.stdout.write(String(socket.gid));
} catch (error) {
  console.error(`Container setup failed: ${error.message}`);
  process.exit(1);
}
