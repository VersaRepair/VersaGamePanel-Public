"use strict";

const { isIP } = require("node:net");

function directConnectivity(input = {}) {
  if (input.schemaVersion != null && input.schemaVersion !== 1) throw new Error("Unsupported connectivity version.");
  if (input.provider && input.provider !== "direct") throw new Error("Only Direct Connection is implemented. No tunnel was created or changed.");
  const advertisedHost = String(input.advertisedHost || "").trim();
  if (advertisedHost && !isIP(advertisedHost) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(advertisedHost)) {
    throw new Error("Enter an IP address or hostname, without a URL or port.");
  }
  return { schemaVersion: 1, provider: "direct", advertisedHost };
}

function directEndpoints(server) {
  const connectivity = directConnectivity(server.connectivity);
  return (server.ports || []).map((port, index) => ({
    id: `endpoint-${index + 1}`, label: port.label || "Game", protocol: port.protocol || "tcp",
    containerPort: port.container, hostPort: port.host,
    bindAddress: server.networkMode === "host" ? "host-network" : port.bindAddress || "127.0.0.1",
    advertisedHost: connectivity.advertisedHost,
    joinAddress: connectivity.advertisedHost ? `${isIP(connectivity.advertisedHost) === 6 ? `[${connectivity.advertisedHost}]` : connectivity.advertisedHost}:${port.host}` : "",
    reachability: "not-verified"
  }));
}

module.exports = { directConnectivity, directEndpoints };
