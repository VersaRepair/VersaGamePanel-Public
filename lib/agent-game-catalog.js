"use strict";
const game = (id, title, kind, memoryGiB, pids, portMin, portMax, internalPort, extra = {}) => Object.freeze({
  id, title, consoleKind: kind, memory: memoryGiB * 1024 ** 3, nanoCPUs: 2000000000, pids, tty: true,
  portMin, portMax, internalPort, step: kind === "unturned" ? 2 : 1, ...extra
});
const GAME_PROFILES = Object.freeze({
  "minecraft-java-1.21.1": game("minecraft-java-1.21.1", "Minecraft Java 1.21.1", "minecraft", 3, 256, 25565, 25572, 25565, { command: ["node", "/opt/vgp/minecraft-java.js"], endpoints: { "25565/tcp": 0 } }),
  "terraria-vanilla": game("terraria-vanilla", "Terraria Vanilla 1.4.5.8", "terraria", 2, 256, 7777, 7784, 7777, { command: [], entrypoint: ["node", "/opt/vgp/game-runner.js", "terraria"], endpoints: { "7777/tcp": 0 }, tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=256m" } }),
  "unturned-dedicated": game("unturned-dedicated", "Unturned Dedicated (fresh generic)", "unturned", 6, 512, 27015, 27029, 27015, { nanoCPUs: 3000000000, command: [], entrypoint: ["node", "/opt/vgp/game-runner.js", "unturned"], endpoints: { "27015/udp": 0, "27016/udp": 1 }, tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=256m" } })
});
const isGame = (id) => typeof id === "string" && Object.hasOwn(GAME_PROFILES, id);
const validGamePort = (id, port) => isGame(id) && Number.isInteger(port) && port >= GAME_PROFILES[id].portMin && port <= GAME_PROFILES[id].portMax && (port - GAME_PROFILES[id].portMin) % GAME_PROFILES[id].step === 0;
function portBindings(profile, port, bind) { return Object.fromEntries(Object.entries(profile.endpoints).map(([key, offset]) => [key, [{ HostIp: bind, HostPort: String(port + offset) }]])); }
function runtimeEnvironment(profile, name) {
  if (profile.consoleKind === "minecraft") return ["VGP_EULA=true", `VGP_SERVER_NAME=${name}`];
  return [`SERVERNAME=${name}`, `PORT=${profile.internalPort}`, "MAXPLAYERS=8", ...(profile.consoleKind === "unturned" ? ["MAP=PEI", "DIFFICULTY=Normal", "PERSPECTIVE=Both", "WORKSHOP_MANAGED=FALSE"] : ["WORLDSIZE=1", "DIFFICULTY=0"] )];
}
module.exports = { GAME_PROFILES, isGame, validGamePort, portBindings, runtimeEnvironment };
