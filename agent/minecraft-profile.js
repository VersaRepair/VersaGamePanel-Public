"use strict";
const { privateAddress } = require("../lib/agent-security");
const { GAME_PROFILES } = require("../lib/agent-game-catalog");
const MINECRAFT = GAME_PROFILES["minecraft-java-1.21.1"];
function configuredMinecraft(image, address = "127.0.0.1") {
  if (!image) return null;
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !privateAddress(address) || address.includes(":")) throw Error("Use a pinned Minecraft image ID and private IPv4 game binding.");
  return { ...MINECRAFT, image, bindAddress: address };
}
const isMinecraft = (profile) => profile === MINECRAFT.id;
function configuredGames(images, address = "127.0.0.1") {
  const result = {};
  for (const [id, image] of Object.entries(images)) if (image) { if (!Object.hasOwn(GAME_PROFILES, id)) throw Error("Unknown game policy"); const p = configuredMinecraft(image, address); result[id] = { ...GAME_PROFILES[id], image: p.image, bindAddress: p.bindAddress }; }
  return result;
}
module.exports = { MINECRAFT, configuredMinecraft, configuredGames, isMinecraft };
