"use strict";

function serverOperations() {
  const pending = new Map();
  return async function run(id, operation) {
    const previous = pending.get(id);
    const depth = (previous?.depth || 0) + 1;
    if (depth > 16) throw Object.assign(new Error("This server has too many pending operations. Please wait."), { statusCode: 429 });
    const task = (previous?.task || Promise.resolve()).catch(() => {}).then(operation);
    const entry = { task, depth };
    pending.set(id, entry);
    try { return await task; }
    finally { if (pending.get(id) === entry) pending.delete(id); }
  };
}

module.exports = { serverOperations };
