"use strict";
// Readiness only: no login, state mutation, game restart or credential access.
fetch("http://127.0.0.1:8788/api/auth/state", { signal: AbortSignal.timeout(4000) })
  .then(async (response) => { if (!response.ok || !(await response.json()).required) process.exit(1); })
  .catch(() => process.exit(1));
