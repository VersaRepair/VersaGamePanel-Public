"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function wait(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  if (process.platform !== "win32") {
    const native = spawn(process.execPath, ["--test"], { cwd: root, stdio: "inherit", env: process.env });
    const result = await wait(native);
    process.exitCode = result.code ?? 1;
    return;
  }

  console.log("Windows detected; running the Linux-targeted test suite in a disposable container.");
  const archive = spawn("tar", [
    "--exclude=.git", "--exclude=node_modules", "--exclude=test-results",
    "--exclude=playwright-report", "-cf", "-", "."
  ], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  const image = "node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
  const command = [
    "set -eu",
    "mkdir /workspace",
    "tar -xf - -C /workspace",
    "cd /workspace",
    "apt-get update -qq",
    "apt-get install -y -qq --no-install-recommends docker.io openssl zip unzip >/dev/null",
    "npm ci --ignore-scripts --no-fund --no-audit >/dev/null",
    "chown -R node:node /workspace",
    "usermod -aG 0 node",
    "su node -s /bin/bash -c 'node --test'"
  ].join(" && ");
  const container = spawn("docker", ["run", "--rm", "-i", "-v", "/var/run/docker.sock:/var/run/docker.sock", image, "bash", "-lc", command], {
    cwd: root, stdio: ["pipe", "inherit", "inherit"], env: process.env
  });
  archive.stdout.pipe(container.stdin);
  container.stdin.on("error", (error) => { if (error.code !== "EPIPE") console.error(error.message); });
  const [archiveResult, containerResult] = await Promise.all([wait(archive), wait(container)]);
  if (archiveResult.code !== 0) throw new Error(`Source archive failed (${archiveResult.code ?? archiveResult.signal}).`);
  process.exitCode = containerResult.code ?? 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
