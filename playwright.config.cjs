"use strict";
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e", workers: 1, fullyParallel: false, timeout: 30000,
  reporter: "line", retries: 0,
  use: { browserName: "chromium", trace: "off", video: "off", screenshot: "off" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
  ]
});
