"use strict";

const { isIP } = require("node:net");

function validatePorts(ports) {
  if (!Array.isArray(ports) || ports.length > 32) throw new Error("Choose up to 32 game ports.");
  const seen = new Set();
  return ports.map((port) => {
    for (const key of ["host", "container"]) {
      if (!Number.isInteger(Number(port[key])) || Number(port[key]) < 1024 || Number(port[key]) > 65535) throw new Error("Game ports must be between 1024 and 65535.");
    }
    if (!["tcp", "udp"].includes(port.protocol || "tcp")) throw new Error("Choose TCP or UDP.");
    const bindAddress = port.bindAddress || "127.0.0.1";
    if (!isIP(bindAddress)) throw new Error("Port bind address must be an IP address.");
    const protocol = port.protocol || "tcp";
    const key = `${bindAddress}:${Number(port.host)}/${protocol}`;
    if (seen.has(key)) throw new Error("Duplicate game port.");
    seen.add(key);
    return { ...port, host: Number(port.host), container: Number(port.container), protocol, bindAddress };
  });
}

function resources(input = {}) {
  const cpu = Number(input.cpus ?? 2);
  const memoryMiB = Number(input.memoryMiB ?? 3072);
  const pids = Number(input.pids ?? 512);
  if (!Number.isFinite(cpu) || cpu < 0.25 || cpu > 64 || !Number.isInteger(memoryMiB) || memoryMiB < 128 || memoryMiB > 262144 || !Number.isInteger(pids) || pids < 32 || pids > 8192) {
    throw new Error("Choose valid CPU, memory and process limits.");
  }
  return { cpus: cpu, memoryMiB, pids };
}

function dockerRunArgs(server, { name, dataDirectory, runAs = "" }) {
  if (!["bridge", "host", "none"].includes(server.networkMode)) throw new Error("Unsupported network mode.");
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(server.dataMount || "/data")) throw new Error("Invalid container data mount.");
  if (!server.image || server.image.startsWith("-") || /\s/.test(server.image)) throw new Error("Invalid Docker image.");
  const limits = resources(server.resources);
  const args = ["run", "-d", "--name", name, "--label", `gamepanel.id=${server.id}`, "--label", `gamepanel.name=${server.name}`,
    "--cpus", String(limits.cpus), "--memory", `${limits.memoryMiB}m`, "--pids-limit", String(limits.pids),
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network", server.networkMode];
  if (server.autoStart) args.push("--restart", "unless-stopped");
  if (runAs) args.push("--user", runAs);
  args.push("-i", "--tty");
  for (const port of validatePorts(server.ports || [])) {
    if (server.networkMode !== "bridge") continue;
    const bind = isIP(port.bindAddress) === 6 ? `[${port.bindAddress}]` : port.bindAddress;
    args.push("-p", `${bind}:${port.host}:${port.container}/${port.protocol}`);
  }
  args.push("-v", `${dataDirectory}:${server.dataMount || "/data"}`);
  for (const [key, value] of Object.entries(server.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment setting name.");
    if (value !== "" && value != null) args.push("-e", `${key}=${value}`);
  }
  args.push(server.image);
  if (server.command) args.push("sh", "-lc", server.command);
  return args;
}

module.exports = { dockerRunArgs, validatePorts, resources };
