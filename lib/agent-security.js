"use strict";
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

function privateAddress(address) {
  if (net.isIP(address) !== 4) return address === "::1" || /^fd[0-9a-f]{2}:/i.test(address) && net.isIP(address) === 6;
  const [a, b] = address.split(".").map(Number);
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127;
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.mode & 0o077 || ![0, process.getuid()].includes(stat.uid)) throw new Error("Agent credential configuration rejected.");
  return fs.readFileSync(file);
}
function identity(config) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(config.peerName || "")) throw new Error("Agent TLS configuration rejected.");
  return { ca: privateFile(config.ca), cert: privateFile(config.cert), key: privateFile(config.key), minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true };
}
function verifyPeer(raw, config, capability) {
  const cert = new X509Certificate(raw);
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo) || !cert.checkHost(config.peerName, { subject: "never", wildcards: false })) throw new Error("Peer identity rejected.");
  const policy = JSON.parse(privateFile(config.policy));
  const validList = (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => /^[a-f0-9]{64}$/.test(item));
  if (!validList(policy.allowed) || !validList(policy.revoked)) throw new Error("Peer policy rejected.");
  const pin = cert.fingerprint256.replace(/:/g, "").toLowerCase();
  if (!policy.allowed.includes(pin) || policy.revoked.includes(pin)) throw new Error("Peer identity rejected.");
  if (capability === "provision" && (!validList(policy.provisioners) || !policy.provisioners.includes(pin))) throw new Error("Provisioning identity rejected.");
  if (capability === "console" && (!validList(policy.consoleWriters) || !policy.consoleWriters.includes(pin))) throw new Error("Console identity rejected.");
}
function serverTLS(config) {
  return { ...identity(config), requestCert: true, handshakeTimeout: 5000, sessionTimeout: 1 };
}
function clientTLS(config) {
  return { ...identity(config), servername: config.peerName, checkServerIdentity(_hostname, cert) {
    const error = tls.checkServerIdentity(config.peerName, cert);
    if (error) return error;
    try { verifyPeer(cert.raw, config); } catch { return new Error("Agent identity rejected."); }
  } };
}
function configFromEnv(env, prefix) {
  const value = (key) => env[`${prefix}_${key}`];
  return { ca: value("CA_FILE"), cert: value("CERT_FILE"), key: value("KEY_FILE"), policy: value("PEER_POLICY_FILE"), peerName: value("PEER_NAME") };
}
module.exports = { privateAddress, privateFile, identity, verifyPeer, serverTLS, clientTLS, configFromEnv };
