"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Duplex } = require("node:stream");
const test = require("node:test");
const { attachDockerConsole } = require("../lib/docker-console");

function socketDouble() {
  const input = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { input.push(chunk.toString()); done(); } });
  return { socket, input };
}

test("Docker API attachment passes raw TTY bytes and disconnects without container signals", async () => {
  const { socket, input } = socketDouble();
  let request;
  const handle = attachDockerConsole({ name: "gp_test", tty: true }, {
    modem: { dial(options, done) { request = options; done(null, socket); } }
  });
  handle.on("error", assert.fail);
  const output = once(handle.stdout, "data");
  await new Promise(setImmediate);
  socket.push("process reply\n");
  assert.equal((await output)[0].toString(), "process reply\n");
  handle.stdin.write("status\n");
  assert.deepEqual(input, ["status\n"]);
  assert.equal(request.path, "/containers/gp_test/attach?");
  assert.equal(request.hijack, true);
  const closed = once(handle, "close");
  handle.kill("SIGTERM");
  await closed;
  assert.equal(socket.destroyed, true);
  assert.equal(request.abortSignal.aborted, true);
  assert.equal(handle.exitCode, 0);
});

test("disconnect during Docker handshake destroys late attachments", async () => {
  const { socket } = socketDouble();
  let respond;
  const handle = attachDockerConsole({ name: "gp_test" }, { modem: { dial(_opts, done) { respond = done; } } });
  await new Promise(setImmediate);
  handle.kill();
  respond(null, socket);
  assert.equal(socket.destroyed, true);
});

test("Docker handshake failure and timeout close streams exactly once", async () => {
  for (const failure of ["reject", "timeout"]) {
    const handle = attachDockerConsole({ name: "gp_test" }, {
      timeoutMs: 10,
      modem: { dial(_opts, done) { if (failure === "reject") done(new Error("test rejection")); } }
    });
    let errors = 0;
    let closes = 0;
    handle.on("error", () => { errors += 1; });
    handle.on("close", () => { closes += 1; });
    // Keep the test event loop alive while the adapter's unref'ed deadline runs.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(errors, 1);
    assert.equal(closes, 1);
    assert.equal(handle.stdin.destroyed, true);
    handle.kill();
    assert.equal(closes, 1);
  }
});
