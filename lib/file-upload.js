"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const Busboy = require("busboy");
const { resolveSafePath, safeRel } = require("./filesystem-safety");

async function collectMultipart(req, destination, { maxFiles = 20000, maxFileBytes = 12 * 1024 ** 3, maxTotalBytes = Infinity, rejectDuplicates = false } = {}) {
  await fsp.mkdir(destination, { recursive: true });
  await resolveSafePath(destination);

  return new Promise((resolve, reject) => {
    const uploads = [];
    const writes = [];
    let failure;
    let totalBytes = 0;
    const names = new Set();
    const fail = (error) => { failure ||= error; };
    const busboy = Busboy({
      headers: req.headers,
      preservePath: true,
      limits: { files: maxFiles, fileSize: maxFileBytes, fields: 0 }
    });

    busboy.on("file", (_field, file, info) => {
      file.on("error", fail);
      // Attach the rejection handler immediately; malformed names must not throw
      // out of an EventEmitter callback or become unhandled promise rejections.
      const write = (async () => {
        const rel = safeRel(info.filename || `upload-${uploads.length + 1}`);
        if (!rel) throw new Error("A filename is required.");
        if (rejectDuplicates && names.has(rel)) throw new Error("Duplicate uploaded path.");
        names.add(rel);
        const target = await resolveSafePath(destination, rel, { allowMissing: true });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await resolveSafePath(destination, rel, { allowMissing: true });
        const temporary = path.join(path.dirname(target), `.gp-upload-${crypto.randomUUID()}`);
        try {
          const out = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
          const budget = new Transform({ transform(chunk, _encoding, callback) {
            totalBytes += chunk.length;
            callback(totalBytes > maxTotalBytes ? new Error("Upload exceeds the combined size limit.") : null, chunk);
          } });
          await pipeline(file, budget, out);
          if (file.truncated) throw new Error("Uploaded file exceeds the configured size limit.");
          await resolveSafePath(destination, rel, { allowMissing: true });
          await fsp.rename(temporary, target);
          uploads.push({ path: target, rel, filename: path.basename(rel), mimeType: info.mimeType });
        } finally {
          await fsp.rm(temporary, { force: true });
        }
      })().catch((error) => {
        fail(error);
        file.resume();
      });
      writes.push(write);
    });
    busboy.on("filesLimit", () => fail(new Error("Too many uploaded files.")));
    busboy.on("error", fail);
    req.once("aborted", () => busboy.destroy(new Error("Upload interrupted.")));
    req.once("error", (error) => busboy.destroy(error));
    busboy.on("close", () => {
      Promise.all(writes).then(() => failure ? reject(failure) : resolve(uploads)).catch(reject);
    });
    req.pipe(busboy);
  });
}

module.exports = { collectMultipart };
