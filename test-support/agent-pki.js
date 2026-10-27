"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { X509Certificate, randomBytes } = require("node:crypto");

// Ephemeral test identities only. No private key or complete credential is logged.
function testPKI() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgp-agent-pki-"));
  const openssl = (args) => execFileSync("openssl", args, { stdio: "ignore", timeout: 15000 });
  const file = (name) => path.join(dir, name);
  function ca(name) {
    openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-days", "2", "-subj", `/CN=Disposable ${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", file(`${name}.key`), "-out", file(`${name}.crt`)]);
    fs.chmodSync(file(`${name}.key`), 0o600); fs.chmodSync(file(`${name}.crt`), 0o600);
  }
  ca("ca"); ca("rogue-ca");
  function issue(name, role, { issuer = "ca", days = "1", dns = role === "server" ? "agent.test" : "panel.test" } = {}) {
    const key = file(`${name}.key`), cert = file(`${name}.crt`), csr = file(`${name}.csr`), ext = file(`${name}.ext`);
    fs.writeFileSync(ext, `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${role === "server" ? "serverAuth" : "clientAuth"}\nsubjectAltName=DNS:${dns}\n`, { mode: 0o600 });
    openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", `/CN=${dns}`, "-keyout", key, "-out", csr]);
    if (days === "-1") {
      fs.mkdirSync(file(`${name}-issued`), { mode: 0o700 });
      fs.writeFileSync(file(`${name}.index`), "", { mode: 0o600 });
      fs.writeFileSync(file(`${name}.serial`), randomBytes(12).toString("hex") + "\n", { mode: 0o600 });
      const config = file(`${name}.cnf`);
      fs.writeFileSync(config, `[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${file(`${name}.index`)}\nserial=${file(`${name}.serial`)}\nnew_certs_dir=${file(`${name}-issued`)}\ncertificate=${file(`${issuer}.crt`)}\nprivate_key=${file(`${issuer}.key`)}\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n`, { mode: 0o600 });
      openssl(["ca", "-batch", "-notext", "-config", config, "-in", csr, "-out", cert, "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-extfile", ext, "-extensions", "leaf"]);
    } else openssl(["x509", "-req", "-in", csr, "-CA", file(`${issuer}.crt`), "-CAkey", file(`${issuer}.key`), "-set_serial", `0x${randomBytes(12).toString("hex")}`, "-days", days, "-sha256", "-extfile", ext, "-extensions", "leaf", "-out", cert]);
    fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
    return { key, cert, pin: new X509Certificate(fs.readFileSync(cert)).fingerprint256.replace(/:/g, "").toLowerCase() };
  }
  function policy(name, allowed, revoked = [], provisioners, consoleWriters) {
    const target = file(`${name}.json`);
    fs.writeFileSync(target, JSON.stringify({ allowed, revoked, ...(provisioners === undefined ? {} : { provisioners }), ...(consoleWriters === undefined ? {} : { consoleWriters }) }), { mode: 0o600 });
    return target;
  }
  const agent = issue("agent", "server"), panel = issue("panel", "client");
  const server = { ...agent, ca: file("ca.crt"), peerName: "panel.test", policy: policy("server-peers", [panel.pin]) };
  const client = { ...panel, ca: file("ca.crt"), peerName: "agent.test", policy: policy("client-peers", [agent.pin]) };
  return { dir, file, issue, policy, agent, panel, server, client, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
module.exports = { testPKI };
