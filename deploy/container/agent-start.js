"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
// Used only under the installer's kernel flock, on its dedicated private state.
// Kernel locking outlives the child and is released on crash/container death.
const root = process.env.VGP_AGENT_STATE_DIR;
try {
  const kernelLock = fs.lstatSync("/run/agent-lock/writer.flock");
  if (!kernelLock.isFile() || kernelLock.isSymbolicLink() || kernelLock.uid !== 1000 || (kernelLock.mode & 0o777) !== 0o600 ||
    !fs.readFileSync("/proc/locks", "utf8").split("\n").some((line) => new RegExp(`FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+[^ ]+:${kernelLock.ino}\\s`).test(line))) throw Error();
  const st = fs.lstatSync(root);
  if (process.getuid() !== 1000 || !st.isDirectory() || st.isSymbolicLink() || st.uid !== 1000 || (st.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) throw Error();
  const lock = path.join(root, "agent.lock");
  try { const old = fs.lstatSync(lock); if (!old.isFile() || old.isSymbolicLink() || old.uid !== 1000 || (old.mode & 0o777) !== 0o600) throw Error(); fs.unlinkSync(lock); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const child = spawn(process.execPath, ["/app/agent/daemon.js"], { stdio: "inherit" });
  process.on("SIGTERM", () => child.kill("SIGTERM")); process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("error", () => process.exit(1)); child.on("close", (code) => process.exit(code || 0));
} catch { console.error("Private agent state/lock recovery rejected. Preserve data and inspect installation status."); process.exitCode = 1; }
