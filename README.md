# VersaGamePanel — public tester alpha

A self-hosted game-server management panel, continuing Zackary Nortley's original GamePanel. Recovered in October 2026 and modernized without replacing its identity.

**Early alpha, not production-ready. Linux amd64 / trusted administrators only.** Use a dedicated Docker VM. Docker socket access gives this application host-root-equivalent authority; do not expose its administration UI publicly or use it for untrusted multi-tenant hosting.

## Try it

```sh
curl -fL https://raw.githubusercontent.com/VersaRepair/VersaGamePanel-Public/main/compose.yaml -o compose.yaml && docker compose up -d
```

Open http://127.0.0.1:8788 and read the [installation guide](docs/CONTAINERS.md) for the private first-login password, docker run alternative, game runtime preparation, networking, backups and updates. Do not paste passwords into issues. Installation creates zero game servers and accepts no game EULAs.

## Help test the alpha

Start with the [tester checklist](docs/TESTING.md) and [compatibility matrix](docs/COMPATIBILITY.md). Please use disposable worlds, not your only copy of a real server.

- [Report a reproducible bug](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=bug_report.yml).
- [Share a game/loader compatibility result](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=compatibility_report.yml), including successful tests.
- [Report a security vulnerability privately](SECURITY.md), never through a public bug report.

Your feedback helps determine what is actually reliable. A selectable template is not a promise that its game, launcher or mod combination has been verified.

## What testers can exercise

- Create/start/stop/restart Docker-backed servers; live interactive console and logs.
- Per-server files/settings and scoped world/save backup and restore.
- Minecraft Java Vanilla and Fabric/custom-mod inspection paths with real-game lab verification; not every listed loader/provider is certified.
- Reviewed fresh Unturned, Terraria Vanilla and tModLoader profiles; explicit runtime preparation downloads publisher software on your host.
- Local mod inspection checks declared metadata, not malware or universal compatibility. Full remote pack resolution is unfinished.
- Browser authentication, per-server operator permissions and session revocation. Admins are fully trusted; this is not hostile tenant isolation.

Networking is currently Direct with explicit host bindings. Integrated Playit/VersaRelay, universal game support, ARM/TrueNAS catalog packaging, automatic full-host backups and safe multi-panel daemon sharing are future work. Recovered LinuxGSM alternatives remain unverified.

GitHub Actions performs regression/browser tests, secret/static/dependency checks, an actual packaged-panel/sibling-container journey and an image vulnerability gate. Heavy real-game jobs are opt-in. The moving alpha image is published only after required checks pass; immutable SHA tags are available. A passing scanner is not a security certification.

## History and attribution

This is a clean public source export. The untouched recovery snapshot, original Git tag and old server/plugin bundles remain preserved in the owner's **private** recovery repository; they are not installed or distributed here. Original GamePanel logos remain in public/assets/brand and continue to represent this alpha. The owner reports early AI assistance including ChatGPT and Codex; authorship of individual recovered assets has not been independently verified, so no asset-specific credits are invented.

No personal Unturned installation, family world, account, token or tunnel is a prerequisite or default. A fresh install is empty. Third-party game software, images and optional mods remain subject to their publishers' terms. A general open-source license has not yet been selected; public availability is not a claim of unrestricted redistribution rights. The owner has authorized public tester distribution of this application image.

## Why VersaGamePanel Exists

VersaGamePanel didn't start as a business idea, a commercial product, or an attempt to compete with other game-server management platforms.

**It started because I wanted to make something for my brother.**

We were trying to get game servers running, and the existing management software made something that should have been simple feel unnecessarily complicated.

Installing servers was frustrating. Managing them was confusing. Even accessing something as basic as the server console could turn into an entire troubleshooting session.

I found myself walking my brother through Linux commands, SSH connections, services, and terminal sessions just so he could manage a game server and enjoy playing with friends.

And eventually, I thought:

*Why does this have to be so difficult? Why can't there just be a simple panel that does what we actually need?*

So I decided to build one.

I wasn't a big development company. I didn't have a team of engineers or an unlimited budget. I was just someone who enjoyed working with computers, learning new things, and trying to make life a little easier for someone I cared about.

I spent countless hours experimenting, troubleshooting, breaking things, fixing them, and figuring out how to turn an idea into something real.

That became **GamePanel**.

Over time, it grew into something much bigger than I originally imagined, supporting multiple games, live consoles, server management, backups, and recovery tools.

Eventually, the project was set aside, and for a while, I thought I'd lost it entirely.

But in October 2026, I found the surviving source code and decided it deserved another chance.

Today, that project continues as **VersaGamePanel**, part of the VersaRepair family.

### What matters most

I don't need VersaGamePanel to become the biggest game-server management platform.

I don't need it to beat anyone else's software.

I just want to finish what I started: something straightforward, reliable, and genuinely useful that gives people control over their own game servers without making them fight the software meant to help them.

If it makes hosting a game server easier for another person, another group of friends, or another family, then that's something worth sharing.

**But no matter how far this project goes, I'll always remember why I started building it.**

*I made it for my brother.*

— **Zackary Nortley**\
Founder, VersaRepair
