"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { jar, fabric } = require("../test-support/mod-fixtures");
const { test: base, expect } = require("@playwright/test");
const { panelFixture } = require("../test-support/panel");

const test = base.extend({
  panel: async ({}, use) => {
    const cleanup = [];
    const fixture = await panelFixture({ after(fn) { cleanup.push(fn); } }, undefined, { legacyToken: false });
    try { await use(fixture); } finally { for (const fn of cleanup.reverse()) await fn(); }
  }
});

async function login(page, panel, password = panel.token) {
  await page.goto(panel.url);
  await expect(page.locator("#authView")).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.locator("#appView")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a Server", exact: true })).toBeVisible();
}

test("cookie login, create/configure, upload/download and logout without URL/storage credentials", async ({ page, context, panel }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const urls = [];
  page.on("request", (request) => urls.push(request.url()));
  await login(page, panel);
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((element) => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
  expect(await page.evaluate(() => localStorage.getItem("gamepanel-token"))).toBeNull();
  expect(await page.evaluate(() => document.cookie)).not.toContain("gp_session");
  expect((await context.cookies()).find((cookie) => cookie.name === "gp_session").httpOnly).toBe(true);
  await page.locator('[data-action="create-template"][data-template="minecraft-paper"]').click();
  await expect(page.getByRole("heading", { name: "Connection address not configured", exact: true })).toBeVisible();
  await page.getByLabel("Advertised IP address or hostname").fill("games.example.test");
  await page.getByText("Advanced listener and resource settings", { exact: true }).click();
  await page.getByLabel("CPU limit", { exact: true }).fill("1");
  await page.locator('[name="port-0"]').fill("25567");
  await page.getByRole("button", { name: "Save connection address", exact: true }).click();
  await expect(page.getByRole("heading", { name: "games.example.test:25567", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.locator('[data-env="MOTD"]').fill("Browser-tested configuration");
  await page.locator('#mcOptionsForm button[type="submit"]').click();
  await expect(page.locator('[data-env="MOTD"]')).toHaveValue("Browser-tested configuration");
  await page.locator('[data-action="mc-page"][data-page="files"]').click();
  await page.locator("#fileUploadInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("browser upload evidence\n") });
  await expect(page.getByRole("button", { name: "File notes.txt", exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "File notes.txt", exact: true }).click();
  const download = await downloadEvent;
  expect(await fs.readFile(await download.path(), "utf8")).toBe("browser upload evidence\n");
  expect(download.url()).not.toContain("token=");
  await page.getByRole("button", { name: "Server", exact: true }).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete + Files", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a Server", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("#appView")).toBeVisible();
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await expect(page.locator("#authView")).toBeVisible();
  await page.reload();
  await expect(page.locator("#authView")).toBeVisible();
  expect(urls.some((url) => /[?&]token=/.test(url))).toBe(false);
  expect(errors).toEqual([]);
});

test("accessible password change revokes browser session and preserves the new login", async ({ page, panel }) => {
  await login(page, panel);
  const password = crypto.randomBytes(24).toString("base64url");
  await page.getByRole("button", { name: "Change Password", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change your password" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await dialog.getByLabel("Current password", { exact: true }).fill(panel.token);
  await dialog.getByLabel("New password", { exact: true }).fill(password);
  await dialog.getByLabel("Confirm new password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Change Password", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#authView")).toBeVisible();
  await login(page, panel, password);
});

test("fresh Unturned and Terraria editors expose files and private save snapshots without installing games", async ({ page, panel }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, panel);
  for (const [realm, templateId] of [["steam", "unturned-dedicated"], ["other", "terraria-vanilla"]]) {
    await page.locator(`[data-realm="${realm}"]`).click();
    await page.locator(`[data-template="${templateId}"]`).click();
    await expect(page.locator("#genericForm")).toBeVisible();
    await page.locator('[data-env="SERVERNAME"]').fill("Browser verified fresh server");
    if (templateId === "unturned-dedicated") {
      await page.locator('[data-env="WORKSHOP_ITEMS"]').fill("123\n456");
      await page.locator('[data-env="MAP"]').fill("A custom Workshop map");
    }
    await page.locator('#genericForm button[type="submit"]').click();
    await expect(page.locator('[data-env="SERVERNAME"]')).toHaveValue("Browser verified fresh server");
    if (templateId === "unturned-dedicated") {
      await expect(page.locator('[data-env="WORKSHOP_ITEMS"]')).toHaveValue("123\n456");
      await expect(page.locator('[data-env="MAP"]')).toHaveValue("A custom Workshop map");
    }
    await expect(page.getByRole("heading", { name: "Save snapshots", exact: true })).toBeVisible();
    await page.locator("#fileUploadInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("fresh generic file") });
    await expect(page.getByRole("button", { name: "File notes.txt", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("custom mod file/folder inspection suggests the version and applies only after confirmation", async ({ page, panel }) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await login(page, panel);
  await page.locator('[data-template="minecraft-paper"]').click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.locator('[data-env="VERSION"]').fill("1.20.1");
  await page.locator('[data-toggle-env="EULA"]').click();
  await page.locator('#mcOptionsForm button[type="submit"]').click();
  await page.getByRole("button", { name: "Mods", exact: true }).click();
  const directory = path.join(panel.base, "mods-upload"); await fs.mkdir(directory);
  const file = await jar(directory, { "fabric.mod.json": fabric("browsermod", { depends: { minecraft: "1.21.1" } }) }, "sample.jar");
  await page.locator("#modFilesInput").setInputFiles(file);
  await expect(page.locator(".mod-plan")).toHaveCount(1);
  await expect(page.locator('.mod-apply-form [name="version"]')).toHaveValue("1.21.1");
  await page.getByRole("button", { name: "Discard staged inspection", exact: true }).click();
  await expect(page.locator(".mod-plan")).toHaveCount(0);
  const transfer = await page.evaluateHandle((bytes) => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "dropped.jar", { type: "application/java-archive" })); return data; }, [...await fs.readFile(file)]);
  await page.locator("#modDropZone").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator(".mod-plan")).toHaveCount(1);
  await page.getByRole("button", { name: "Discard staged inspection", exact: true }).click();
  await expect(page.locator(".mod-plan")).toHaveCount(0);
  await transfer.dispose();
  await page.locator("#modFolderInput").setInputFiles(directory);
  await expect(page.locator(".mod-plan")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.mod-apply-form [name="confirm"]').check();
  await page.locator('.mod-apply-form [name="acceptWarnings"]').check();
  await page.getByRole("button", { name: "Recheck and apply reviewed set", exact: true }).click();
  await expect(page.locator(".mod-plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await expect(page.locator('[data-env="VERSION"]')).toHaveValue("1.21.1");
  expect(errors).toEqual([]);
});

test("existing pack-specific settings are reachable in Minecraft Options", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator('[data-template="minecraft-modrinth"]').click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.locator('[data-env="MODRINTH_MODPACK"]').fill("pack-for-configuration-test");
  await page.locator('#mcOptionsForm button[type="submit"]').click();
  await expect(page.locator('[data-env="MODRINTH_MODPACK"]')).toHaveValue("pack-for-configuration-test");
});
