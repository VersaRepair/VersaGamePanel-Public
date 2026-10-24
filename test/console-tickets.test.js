"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createConsoleTickets } = require("../lib/console-tickets");

test("console tickets expire, bind to one server/mode, and cannot be replayed", () => {
  let time = 1000;
  const store = createConsoleTickets({ now: () => time, ttlMs: 30, maxTickets: 2 });
  const request = { serverId: "one", mode: "console", authorization: "Bearer test-only" };
  const { ticket } = store.issue(request);
  assert.equal(store.consume(ticket, "one", "console").authorization, request.authorization);
  assert.equal(store.consume(ticket, "one", "console"), null);
  const wrongServer = store.issue(request).ticket;
  assert.equal(store.consume(wrongServer, "two", "console"), null);
  assert.equal(store.consume(wrongServer, "one", "console"), null);
  const wrongMode = store.issue(request).ticket;
  assert.equal(store.consume(wrongMode, "one", "logs"), null);
  const expired = store.issue(request).ticket;
  time += 30;
  assert.equal(store.consume(expired, "one", "console"), null);
});

test("pending console tickets have bounded capacity and expired capacity is reclaimed", () => {
  let time = 0;
  const store = createConsoleTickets({ now: () => time, ttlMs: 10, maxTickets: 1 });
  const request = { serverId: "one", mode: "logs", authorization: "Bearer test-only" };
  store.issue(request);
  assert.throws(() => store.issue(request), { statusCode: 429 });
  time = 10;
  assert.ok(store.issue(request).ticket);
  assert.throws(() => store.issue({ ...request, mode: "shell" }), /Choose console or logs/);
});
