"use strict";
function allowedLine(line, game = "any") {
  if (typeof line !== "string" || Buffer.byteLength(line) > 124) return false;
  if (game === "terraria") return ["save", "playing", "version"].includes(line) || /^say [A-Za-z0-9 .!?_-]{1,120}$/.test(line);
  if (game === "unturned") return ["Save", "Players"].includes(line);
  if (game === "any" && (["save", "playing", "version", "Save", "Players"].includes(line))) return true;
  if (game !== "minecraft" && ["ping", "status", "help"].includes(line)) return true;
  return game !== "fixture" && (["list", "seed", "save-all flush"].includes(line) || /^say [A-Za-z0-9 .!?_-]{1,120}$/.test(line));
}
module.exports = { allowedLine };
