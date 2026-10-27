"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { mountedDataRoot } = require("../../lib/host-storage");

try {
  if (process.getuid() === 0) throw new Error("The panel must not run as root.");
  if (process.env.GAMEPANEL_BACKEND === "agent") {
    if (fs.existsSync("/var/run/docker.sock")) throw new Error("Agent panel must not mount the Docker socket.");
    delete process.env.GAMEPANEL_HOST_DATA_DIR;
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
  } else {
    if (process.env.DOCKER_HOST && process.env.DOCKER_HOST !== "unix:///var/run/docker.sock" || process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== "default") throw new Error("This alpha requires the local Docker socket, not a remote Docker context.");
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    const [info] = JSON.parse(execFileSync("docker", ["inspect", process.env.HOSTNAME], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }));
    process.env.GAMEPANEL_HOST_DATA_DIR = mountedDataRoot(info);
  }
  process.env.GAMEPANEL_DATA_DIR = "/data";
  fs.accessSync("/data", fs.constants.W_OK | fs.constants.R_OK);
  // Authentication cannot be disabled accidentally in a distributed tester install.
  process.env.GAMEPANEL_AUTH_DISABLED = "0";
  process.env.GAMEPANEL_ALLOW_LEGACY_TOKEN = "0";
  const command = process.argv[2];
  if (command === "prepare-runtime") {
    if (process.env.GAMEPANEL_BACKEND === "agent") throw new Error("Runtime preparation has not migrated to the agent.");
    const recipes = { unturned: ["Unturned", "versagamepanel/unturned:2"], terraria: ["Terraria", "versagamepanel/terraria:1.4.5.8-1"] };
    const requested = process.argv[3];
    if (requested !== "all" && !recipes[requested]) throw new Error("Choose prepare-runtime unturned, terraria, or all.");
    for (const [recipe, tag] of requested === "all" ? Object.values(recipes) : [recipes[requested]]) {
      // Fixed reviewed recipes only. Publisher downloads occur on the tester's host.
      const context = execFileSync("tar", ["-cf", "-", "lib/game-profiles.js", "runtimes/game-runner.js", `runtimes/${recipe}.Dockerfile`], { cwd: "/app", maxBuffer: 1024 * 1024 });
      const result = spawnSync("docker", ["build", "-f", `runtimes/${recipe}.Dockerfile`, "-t", tag, "-"], { input: context, stdio: ["pipe", "inherit", "inherit"] });
      if (result.error || result.status !== 0) throw new Error(`Runtime preparation failed for ${tag}; existing game data is unchanged.`);
    }
  } else if (command) {
    throw new Error("Unknown container command. Use no arguments to start the panel.");
  } else {
    if (!fs.existsSync("/data/users.json")) {
      if (process.env.GAMEPANEL_ADMIN_PASSWORD_FILE) process.env.GAMEPANEL_ADMIN_PASSWORD = fs.readFileSync(process.env.GAMEPANEL_ADMIN_PASSWORD_FILE, "utf8").trim();
      if (!process.env.GAMEPANEL_ADMIN_PASSWORD) {
        const file = "/data/initial-admin-password.txt";
        try { fs.writeFileSync(file, `${crypto.randomBytes(24).toString("base64url")}\n`, { mode: 0o600, flag: "wx" }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("The initial password file must be a private regular file (mode 600).");
        process.env.GAMEPANEL_ADMIN_PASSWORD = fs.readFileSync(file, "utf8").trim();
        console.log("First login: admin. Read /data/initial-admin-password.txt locally, then change your password in the panel. The password is never printed in logs.");
      }
      if (process.env.GAMEPANEL_ADMIN_PASSWORD.length < 12 || process.env.GAMEPANEL_ADMIN_PASSWORD.length > 256) throw new Error("The initial admin password must contain 12–256 characters.");
    }
    require("../../server");
  }
} catch (error) {
  // Do not dump child-process buffers or environment variables, which may contain credentials.
  console.error(`Container startup failed: ${error.code ? `${error.code}: ` : ""}${error.message?.split("\n")[0]}`);
  process.exit(1);
}
