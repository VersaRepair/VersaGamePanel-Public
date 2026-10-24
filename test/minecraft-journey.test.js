"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { panelFixture } = require("../test-support/panel");
const { IMAGE, VERSION, docker, json, createMinecraft, action, ready, command, upload, download } = require("../test-support/minecraft");

function varint(value) {
  const bytes = [];
  do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}

async function gameStatus(port) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.setTimeout(10000, () => socket.destroy(new Error("Game status timeout")));
  try {
    await once(socket, "connect");
    const address = Buffer.from("localhost");
    const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
    const handshake = Buffer.concat([varint(0), varint(767), varint(address.length), address, portBytes, varint(1)]);
    const response = new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      const read = (offset) => {
        let value = 0;
        for (let count = 0; count < 5; count += 1) {
          if (offset + count >= data.length) return null;
          const byte = data[offset + count]; value |= (byte & 127) << (7 * count);
          if (!(byte & 128)) return { value, next: offset + count + 1 };
        }
        throw new Error("Invalid status length");
      };
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        try {
          data = Buffer.concat([data, chunk]);
          if (data.length > 1048576) throw new Error("Oversized game status");
          const packet = read(0); if (!packet || data.length < packet.next + packet.value) return;
          const type = read(packet.next); assert.equal(type.value, 0);
          const length = read(type.next); assert.ok(length && length.next + length.value <= data.length);
          resolve(JSON.parse(data.subarray(length.next, length.next + length.value).toString()));
        } catch (error) { reject(error); }
      });
    });
    socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])]));
    return await response;
  } finally { socket.destroy(); }
}

test("real Minecraft Java create/install/console/files/restart/backup/restore/remove journey", {
  skip: process.env.GAMEPANEL_MINECRAFT_TEST !== "1", timeout: 600000
}, async (t) => {
  assert.equal(process.env.GAMEPANEL_ACCEPT_MINECRAFT_EULA, "1");
  await docker(["image", "inspect", IMAGE]); // Images must be deliberately pulled before this opt-in test.
  const f = await panelFixture(t);
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = await createMinecraft(f, `LAB Minecraft ${crypto.randomUUID()}`, port);
  const name = `gp_${server.id}`;
  // Register cleanup immediately. It stops/removes only this UUID-named fixture.
  t.after(async () => { await docker(["rm", "--force", name]).catch(() => {}); });
  const id = server.id;
  t.diagnostic(`Version ${VERSION}; pinned image ${IMAGE}; localhost:${port}; disposable data only.`);
  await action(f, id, "start");
  let info = await ready(id);
  assert.equal(info.Config.Tty, true);
  assert.equal(info.Config.User, `${process.getuid()}:${process.getgid()}`);
  assert.equal(info.HostConfig.NetworkMode, "bridge");
  assert.equal(info.HostConfig.PortBindings["25565/tcp"][0].HostIp, "127.0.0.1");
  assert.equal(info.HostConfig.Memory, 3072 * 1024 * 1024);
  const status = await gameStatus(port);
  assert.equal(status.version.name, VERSION);
  assert.equal(status.players.max, 2);
  await command(f, id, "seed", /Seed: \[123456\]/);
  await command(f, id, "list", /There are 0 of a max of 2 players online/);
  await command(f, id, "forceload add 0 0", /Marked chunk|No chunks were marked/);
  await command(f, id, "setblock 0 64 0 minecraft:diamond_block", /Changed the block at 0, 64, 0/);
  const properties = await download(f, id, "server.properties");
  assert.ok(properties.includes("motd=VGP disposable verification"), "saved MOTD is applied to the actual game");

  const runningBackup = await f.request(`/servers/${id}/backups`, { method: "POST", body: { action: "create" } });
  assert.equal(runningBackup.status, 400, "inconsistent live backup is rejected");
  await action(f, id, "stop");
  info = JSON.parse(await docker(["inspect", name]))[0];
  assert.equal(info.State.ExitCode, 0, "game shut down gracefully rather than being killed");
  await upload(f, id, "world/vgp-evidence.txt", "original disposable world evidence\n");
  const backup = await json(f, `/servers/${id}/backups`, { method: "POST", body: { action: "create" } });
  const archive = await f.request(`/servers/${id}/backups/download?name=${encodeURIComponent(backup.name)}`);
  assert.equal(archive.status, 200);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  t.diagnostic(`World backup bytes=${bytes.length} sha256=${crypto.createHash("sha256").update(bytes).digest("hex")}`);
  await action(f, id, "start");
  await ready(id);
  await command(f, id, "setblock 0 64 0 minecraft:emerald_block", /Changed the block at 0, 64, 0/);
  await action(f, id, "stop");
  await upload(f, id, "world/vgp-evidence.txt", "changed after backup\n");
  await upload(f, id, "world/post-backup.txt", "must disappear after restore\n");
  await json(f, `/servers/${id}/backups`, { method: "POST", body: { action: "restore", name: backup.name } });
  assert.equal(await download(f, id, "world/vgp-evidence.txt"), "original disposable world evidence\n");
  assert.equal((await f.request(`/servers/${id}/files/download?path=world/post-backup.txt`)).status, 400);
  await action(f, id, "start");
  info = await ready(id);
  await command(f, id, "seed", /Seed: \[123456\]/);
  await command(f, id, "execute if block 0 64 0 minecraft:diamond_block run say VGP_RESTORE_PROVED", /\[Server\] VGP_RESTORE_PROVED/);

  const containerId = info.Id;
  await f.stop(); await f.start();
  assert.equal((await json(f, `/servers/${id}`)).server.id, id);
  assert.equal(JSON.parse(await docker(["inspect", name]))[0].Id, containerId, "app restart must not recreate the game");
  await command(f, id, "list", /There are 0 of a max of 2 players online/);
  await action(f, id, "restart");
  info = await ready(id);
  assert.notEqual(info.Id, containerId, "runtime recreation is independent of persistent server identity");
  assert.equal(await download(f, id, "world/vgp-evidence.txt"), "original disposable world evidence\n");
  await command(f, id, "seed", /Seed: \[123456\]/);
  await action(f, id, "stop");
  assert.equal(JSON.parse(await docker(["inspect", name]))[0].State.ExitCode, 0);
  await json(f, `/servers/${id}?data=1&backups=1`, { method: "DELETE" });
  assert.deepEqual((await json(f, "/servers")).servers, []);
  await assert.rejects(fs.stat(path.join(f.data, "servers", id)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.data, "backups", id)), { code: "ENOENT" });
  await assert.rejects(docker(["inspect", name]));
});
