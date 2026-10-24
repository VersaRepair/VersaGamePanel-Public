"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const writes = new Map();

function saveJson(file, value) {
  const snapshot = `${JSON.stringify(value, null, 2)}\n`;
  const previous = writes.get(file) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(snapshot);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, file);
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
  });
  writes.set(file, task);
  const cleanup = () => { if (writes.get(file) === task) writes.delete(file); };
  task.then(cleanup, cleanup);
  return task;
}

module.exports = { saveJson };
