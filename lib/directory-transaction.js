"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { assertNoSymlinksInTree } = require("./filesystem-safety");

// Same-parent rename swap, retaining the original until promotion succeeds.
// Caller must quiesce the game and serialize operations. Crash recovery journaling
// and protection against hostile concurrent host writers remain separate work.
async function replaceDirectory(source, target, { promote = fs.rename } = {}) {
  await assertNoSymlinksInTree(source);
  const suffix = crypto.randomUUID();
  const incoming = path.join(path.dirname(target), `.gp-incoming-${suffix}`);
  const previous = path.join(path.dirname(target), `.gp-previous-${suffix}`);
  let moved = false;
  let committed = false;
  try {
    await fs.cp(source, incoming, { recursive: true, errorOnExist: true, force: false });
    try { await fs.rename(target, previous); moved = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await promote(incoming, target); committed = true; }
    catch (error) {
      if (moved) {
        try { await fs.rename(previous, target); }
        catch (rollbackError) {
          throw new Error(`Restore failed and automatic rollback failed; original retained at ${previous}. ${rollbackError.message}`, { cause: error });
        }
      }
      throw error;
    }
  } finally {
    await fs.rm(incoming, { recursive: true, force: true });
    if (committed && moved) await fs.rm(previous, { recursive: true, force: true });
  }
}

module.exports = { replaceDirectory };
