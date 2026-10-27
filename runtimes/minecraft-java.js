"use strict";
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
// Publisher metadata for Minecraft Java 1.21.1. No game binaries are redistributed.
const URL = "https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar";
const SHA1 = "59353fb40c36d304f2035d51e7d6e6baa98dc05c", SIZE = 51627615;
async function digest(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== SIZE) throw Error("Server download integrity failed");
  const hash = createHash("sha1"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== SHA1) throw Error("Server download integrity failed");
}
async function main() {
  if (!process.getuid() || process.env.VGP_EULA !== "true" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(process.env.VGP_SERVER_NAME || "")) throw Error("Explicit EULA acceptance and approved configuration required");
  if (!fs.existsSync("server.jar")) {
    if (fs.existsSync("server.jar.download")) { const old = fs.lstatSync("server.jar.download"); if (!old.isFile() || old.isSymbolicLink() || old.uid !== process.getuid() || old.size > SIZE) throw Error("Unsafe partial download"); fs.unlinkSync("server.jar.download"); }
    console.log("Downloading the verified Minecraft Java 1.21.1 server from Mojang.");
    const response = await fetch(URL, { redirect: "error", signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error("Publisher download unavailable");
    let count = 0;
    const limit = new Transform({ transform(chunk, _enc, done) { count += chunk.length; done(count > SIZE ? Error("Download size limit") : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream("server.jar.download", { flags: "wx", mode: 0o600 }));
    await digest("server.jar.download"); fs.renameSync("server.jar.download", "server.jar");
  }
  await digest("server.jar");
  for (const [file, text] of Object.entries({ "eula.txt": "eula=true\n", "server.properties": `motd=${process.env.VGP_SERVER_NAME}\nserver-port=25565\nonline-mode=true\nenable-rcon=false\nmax-players=8\nview-distance=6\nsimulation-distance=4\nlevel-name=world\n` })) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw Error("Unsafe game configuration");
  }
  if (!fs.existsSync("tmp")) fs.mkdirSync("tmp", { mode: 0o700 });
  const st = fs.lstatSync("tmp"); if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Unsafe temporary storage");
  const java = spawn("/usr/bin/java", ["-Xms512M", "-Xmx2048M", "-Duser.home=/data", "-Djava.io.tmpdir=/data/tmp", "-jar", "server.jar", "nogui"], { stdio: ["pipe", "inherit", "inherit"] });
  process.stdin.pipe(java.stdin); java.stdin.on("error", () => {});
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; java.stdin.write("stop\n"); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  java.on("error", () => { console.error("Java runtime unavailable"); process.exitCode = 1; });
  java.on("close", (code) => { process.stdin.unpipe(java.stdin); process.stdin.destroy(); process.exit(Number.isInteger(code) ? code : 1); });
}
if (require.main === module) main().catch(() => { console.error("Minecraft startup failed. Check configuration, available storage and publisher connectivity; no download is trusted without its publisher checksum."); process.exitCode = 1; });
module.exports = { digest, SIZE, SHA1, URL };
