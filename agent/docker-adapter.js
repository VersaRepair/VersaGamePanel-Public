"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createProvisioningAdapter } = require("./provisioning");

const execFileAsync = promisify(execFile);
const LABEL = "com.versarepair.versagamepanel.agent";
const LABEL_VALUE = "managed-v1";
const FULL_ID = /^[a-f0-9]{64}$/;
const SERVER_ID = /^[a-zA-Z0-9_-]{1,80}$/;

function rejection(code) {
  return Object.assign(new Error(code), { code });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function scopedContainer(info, root) {
  if (!info || !FULL_ID.test(info.Id || "")) throw rejection("NOT_FOUND");
  const labels = info.Config?.Labels || {};
  if (labels[LABEL] !== LABEL_VALUE || !SERVER_ID.test(labels["gamepanel.id"] || "")) throw rejection("NOT_MANAGED");
  const host = info.HostConfig || {};
  if (host.Privileged || !["bridge", "none"].includes(host.NetworkMode) ||
      host.PidMode === "host" || host.IpcMode === "host" ||
      (host.CapAdd || []).length || (host.Devices || []).length) throw rejection("UNSAFE");
  const mounts = info.Mounts;
  // No anonymous volumes, host daemon socket, nested containers or arbitrary host binds.
  if (!Array.isArray(mounts) || mounts.length !== 1 || mounts[0].Type !== "bind" ||
      !["/data", "/config"].includes(mounts[0].Destination) || !mounts[0].RW ||
      !path.isAbsolute(mounts[0].Source)) throw rejection("UNSAFE");
  let actual;
  try { actual = fs.realpathSync(mounts[0].Source); } catch { throw rejection("UNSAFE"); }
  if (!inside(root, actual)) throw rejection("UNSAFE");
  return {
    id: info.Id,
    serverId: labels["gamepanel.id"],
    running: !!info.State?.Running,
    state: ["created", "running", "exited", "paused", "restarting", "dead"].includes(info.State?.Status) ? info.State.Status : "unknown"
  };
}

function createDockerAdapter({ dataRoot, stateRoot, execute, minecraftImage, terrariaImage, unturnedImage, gameBindAddress, memoryBudgetGiB, createRuntime } = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new Error("Use an absolute dedicated game data root.");
  const stat = fs.lstatSync(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Dedicated game storage must be a real directory.");
  const root = fs.realpathSync(dataRoot);
  if (root === "/" || root === "/var" || root === "/home" || root === "/srv" || root === "/tmp" ||
      (stat.mode & 0o002) !== 0) throw new Error("Unsafe dedicated game data root.");
  const run = execute || (async (args) => {
    // Never inherit DOCKER_HOST/DOCKER_CONTEXT from a caller or environment.
    // This can manage only the dedicated game's VM-local Docker daemon.
    const { stdout } = await execFileAsync("/usr/bin/docker", args, {
      encoding: "utf8", timeout: args.includes("60") && ["stop", "restart"].includes(args[1]) ? 70000 : 20000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "default" }
    });
    return stdout;
  });

  if (stateRoot) return createProvisioningAdapter({ root, stateRoot, run,
    minecraftImage, terrariaImage, unturnedImage, gameBindAddress, memoryBudgetGiB,
    createConsole: createRuntime || (execute ? undefined : require("./console-fixture").createConsoleFixture) });

  async function inspectManaged(id) {
    if (!FULL_ID.test(id)) throw rejection("NOT_FOUND");
    let list;
    try { list = JSON.parse(await run(["container", "inspect", id])); } catch { throw rejection("NOT_FOUND"); }
    if (!Array.isArray(list) || list.length !== 1 || list[0].Id !== id) throw rejection("NOT_FOUND");
    return scopedContainer(list[0], root);
  }

  async function list() {
    const raw = await run(["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", "label=" + LABEL + "=" + LABEL_VALUE]);
    const ids = raw.split(/\r?\n/).filter(Boolean);
    if (ids.length > 128) throw rejection("TOO_MANY");
    if (new Set(ids).size !== ids.length || ids.some(id => !FULL_ID.test(id))) throw rejection("UNSAFE");
    const result = [];
    for (const id of ids) {
      try { result.push(await inspectManaged(id)); }
      catch (error) { if (!["NOT_MANAGED", "NOT_FOUND", "UNSAFE"].includes(error.code)) throw error; }
    }
    return result;
  }

  async function lifecycle(id, action) {
    // Defense in depth: even internal adapter callers must re-authorize ownership.
    await inspectManaged(id);
    if (!["start", "stop", "restart"].includes(action)) throw rejection("NOT_FOUND");
    const args = action === "start" ? ["container", "start", id]
      : action === "stop" ? ["container", "stop", "--time", "10", id]
      : ["container", "restart", "--time", "10", id];
    await run(args);
  }

  return { list, inspectManaged, lifecycle };
}

module.exports = { createDockerAdapter, scopedContainer, LABEL, LABEL_VALUE };
