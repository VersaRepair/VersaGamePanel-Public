"use strict";
const { profiles } = require("./game-profiles");

// First versioned contract over the recovered templates. Definitions describe
// games; runtime launch arguments and connectivity are deliberately separate.
function gameDefinition(template) {
  return {
    schemaVersion: 1, id: template.id, name: template.name,
    family: template.family, verification: "experimental",
    runtimeAdapters: ["docker"],
    settings: template.fields || [],
    endpoints: (template.ports || []).map((port, index) => ({
      id: `endpoint-${index + 1}`, label: port.label || "Game", protocol: port.protocol || "tcp", port: port.container
    })),
    capabilities: { lifecycle: true, files: true, logs: true, console: profiles[template.id] ? "foreground" : "image-dependent", worldBackups: template.family === "Minecraft", saveSnapshots: Boolean(profiles[template.id]) }
  };
}

function blockedReason(server, templates) {
  if (server.runtimeKind === "systemd" || server.templateId === "unturned-imported-native") {
    return "Legacy native record preserved for review. Service and external files are not managed; an approved native runtime profile is required.";
  }
  if (!templates.some((item) => item.id === server.templateId)) return "Unknown game definition preserved for review; no fallback game will be used.";
  return "";
}

module.exports = { gameDefinition, blockedReason };
