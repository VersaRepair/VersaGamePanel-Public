"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { configuration, workshopConfiguration, enabledMods } = require("./game-profiles");
const game = process.argv[2];
if (!["unturned", "terraria", "tmodloader"].includes(game)) throw new Error("Unknown reviewed game runtime");
let child;
let stopping = false;
let playing = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!child) return;
  if (playing) child.stdin.write(game === "unturned" ? "Shutdown\n" : "exit\n");
  else child.kill("SIGTERM");
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
async function run(command, args, cwd, isGame = false) {
  if (stopping) throw new Error("Install cancelled before game launch");
  playing = isGame;
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd, env: { ...process.env, HOME: "/data/.home" }, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.on("error", () => {});
    if (isGame) {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.pipe(child.stdin);
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (isGame) { process.stdin.unpipe(child.stdin); process.stdin.pause(); }
      child = null;
      if (code === 0) resolve(); else reject(new Error(`${path.basename(command)} exited ${code ?? signal}`));
    });
  });
}
async function exists(file) { try { await fs.access(file); return true; } catch (_) { return false; } }
async function config(file, id) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const old = await fs.readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  await fs.writeFile(file, configuration(id, process.env, old), { mode: 0o600 });
}
async function main() {
  await fs.mkdir("/data/.home", { recursive: true });
  if (game === "unturned") {
    await fs.mkdir("/data/install", { recursive: true });
    // The panel's non-root UID is not necessarily the image's UID1000 (Actions
    // runners commonly use UID1001). Copy the anonymous bootstrap to owned
    // persistent storage rather than granting write access to /opt or root.
    const steam = "/data/steamcmd";
    if (!(await exists(`${steam}/steamcmd.sh`))) await fs.cp("/opt/steamcmd", steam, { recursive: true });
    if (!(await exists("/data/install/.vgp-install-complete")) || !(await exists("/data/install/Unturned_Headless.x86_64"))) {
      console.log("[VGP] Installing fresh anonymous Unturned Dedicated Server (1110390). No personal account or server import.");
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await run(`${steam}/steamcmd.sh`, ["+force_install_dir", "/data/install", "+login", "anonymous", "+app_info_update", "1", "+app_update", "1110390", "validate", "+quit"], steam);
          break;
        } catch (error) {
          if (stopping || attempt === 3) throw error;
          console.log(`[VGP] SteamCMD install attempt ${attempt} failed; retrying after refreshing its cache. Game will not start until validation succeeds.`);
          await delay(3000);
        }
      }
      await fs.writeFile("/data/install/.vgp-install-complete", "1110390 validated\n", { mode: 0o600 });
    }
    const sdk = "/data/.home/.steam/sdk64";
    await fs.mkdir(sdk, { recursive: true });
    try {
      const link = await fs.lstat(`${sdk}/steamclient.so`);
      if (link.isSymbolicLink() && (await fs.readlink(`${sdk}/steamclient.so`)) === "/opt/steamcmd/linux64/steamclient.so") await fs.unlink(`${sdk}/steamclient.so`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!(await exists(`${sdk}/steamclient.so`))) await fs.symlink(`${steam}/linux64/steamclient.so`, `${sdk}/steamclient.so`);
    await config("/data/install/Servers/vgp/Server/Commands.dat", "unturned-dedicated");
    const workshopFile = "/data/install/Servers/vgp/WorkshopDownloadConfig.json";
    const previousWorkshop = await fs.readFile(workshopFile, "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; });
    const workshop = workshopConfiguration(process.env, previousWorkshop);
    if (workshop !== null) await fs.writeFile(workshopFile, workshop, { mode: 0o600 });
    // Unturned's ThreadedConsole uses Console.KeyAvailable: a pipe is not a
    // terminal. util-linux supplies a PTY *inside* this unprivileged container.
    // The command is fixed, never assembled from user settings. Echo is disabled
    // so the console test must observe a game response, not reflected input.
    await run("/usr/bin/script", ["--quiet", "--return", "--flush", "--echo", "never", "--command", "exec /bin/bash ./ServerHelper.sh -ThreadedConsole +LanServer/vgp", "/dev/null"], "/data/install", true);
  } else if (game === "tmodloader") {
    await config("/data/tmodloader/serverconfig.txt", "terraria-tmodloader-reviewed");
    await fs.mkdir("/data/tmodloader/Mods", { recursive: true });
    await fs.mkdir("/data/tmodloader/Logs", { recursive: true });
    await fs.mkdir("/data/tmodloader/Worlds", { recursive: true });
    if (process.env.MANAGE_MODS === "TRUE") {
      const enabled = enabledMods(process.env.ENABLED_MODS);
      for (const mod of enabled) if (!(await exists(`/data/tmodloader/Mods/${mod}.tmod`))) throw new Error(`Enabled mod ${mod} has no matching uploaded .tmod file; game not started.`);
      await fs.writeFile("/data/tmodloader/Mods/enabled.json", JSON.stringify(enabled), { mode: 0o600 });
    }
    await run("/usr/share/dotnet/dotnet", ["/opt/tmodloader/tModLoader.dll", "-server", "-nosteam", "-tmlsavedirectory", "/data/tmodloader", "-config", "/data/tmodloader/serverconfig.txt"], "/opt/tmodloader", true);
  } else {
    await config("/data/saves/serverconfig.txt", "terraria-vanilla");
    await run("/opt/terraria/TerrariaServer.bin.x86_64", ["-config", "/data/saves/serverconfig.txt"], "/opt/terraria", true);
  }
}
main().catch((error) => { console.error(`[VGP] ${error.message}`); process.exitCode = 1; });
