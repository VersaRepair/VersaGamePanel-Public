# VersaGamePanel

**Self-hosted game-server management, with control over your games and data.**

VersaGamePanel is a browser-based panel for creating and managing dedicated game servers on a Linux Docker host. It brings server installation, configuration, lifecycle controls, interactive consoles, files and save backups into one interface—while keeping the underlying server data on infrastructure you control.

> [!WARNING]
> **Early tester alpha, not production-ready.** The tested package targets **Linux amd64** with Docker on a **dedicated VM or host**, for **trusted administrators only**. Access to the Docker socket grants effectively host-root privileges. Do **not** expose the panel's administration port to the public internet, deploy alongside irreplaceable data, or use it for untrusted multi-tenant hosting.

## Quick start: run the panel

**Prerequisites:** A disposable Linux amd64 Docker machine (tested on Debian 13), Docker Engine 26+ and Docker Compose v2. Read the [installation and security guide](docs/CONTAINERS.md) before using the package.

On the Docker host:

~~~sh
curl -fL https://raw.githubusercontent.com/VersaRepair/VersaGamePanel-Public/main/compose.yaml -o compose.yaml
docker compose up -d
docker compose ps
~~~

The default interface is available **on the Docker host** at [http://127.0.0.1:8788](http://127.0.0.1:8788). For a remote host, use an SSH tunnel from your own computer rather than publishing the panel port:

~~~sh
ssh -L 8788:127.0.0.1:8788 your-user@your-docker-host
~~~

Then open the same localhost URL in your computer's browser.

**First login:** Username `admin`. Retrieve the one-time generated password **locally** from the Docker host:

~~~sh
docker exec --user 1000:1000 versagamepanel cat /data/initial-admin-password.txt
~~~

Change that password after logging in. Never post passwords or unredacted logs in GitHub issues. A fresh installation starts with **zero configured game servers** and installs no game binaries until explicitly requested.

## First game-server test

For the simplest initial exercise, create a disposable **Minecraft Java Vanilla 1.21.1** server from the panel. Review and accept the Minecraft EULA only if you agree to it. Start the game, confirm actual readiness, send a console command and verify a game-generated response; then stop and restart it.

For reviewed **Unturned**, **Terraria Vanilla** or **tModLoader** profiles, prepare only the runtime you intend to test first:

~~~sh
docker exec versagamepanel /app/deploy/container/entrypoint.sh prepare-runtime unturned
# Or replace unturned with terraria or tmodloader.
~~~

This explicitly builds the game runtime on the Docker host and downloads publisher files. It does not create a game server, import existing saves or bundle third-party game binaries. Game ports default to localhost; remote players **cannot** automatically join until networking is deliberately configured.

Follow the [tester checklist](docs/TESTING.md) for the complete install → console → backup/restore → persistence journey.

## Supported scenarios in this alpha

| Game / feature | Verified scenario | Limit |
| --- | --- | --- |
| Minecraft Java Vanilla 1.21.1 | Real server start, console, settings, world backup/restore, persistence | Other versions and client combinations are not guaranteed |
| Minecraft Fabric 1.21.1 | Real FerriteCore 7.0.3 modded startup and world restore | One verified mod/loader combination |
| Unturned Dedicated | Fresh installation, console, save/restore, Hawaii Workshop example | Other Workshop content and versions can change |
| Terraria Vanilla 1.4.5.8 | Real startup, console, graceful stop and save restore | Other releases unverified |
| Terraria tModLoader 2026.08.3.0 | ExampleMod, console and `.wld`/`.twld` save restore | No automatic Workshop mod downloads |
| Other recovered templates | Available as experimental definitions | Not verified end-to-end |

This table summarizes **specific lab-tested scenarios**, not full support certification. See the [compatibility matrix](docs/COMPATIBILITY.md) for evidence, host requirements and important caveats.

## What the panel provides

- Create, start, stop and restart supported Docker-backed game servers.
- View logs and send commands through the interactive console.
- Manage server settings and scoped game files.
- Back up and restore supported worlds/saves; these are **not** full-host backups.
- Use per-server operator permissions, browser sign-in and session revocation.
- Inspect some local Minecraft mods and apply reviewed changes with backups.
- Configure **Direct** networking with explicit port bindings.

**Not implemented or not certified yet:** integrated Playit.gg or VersaRelay tunnels, TrueNAS catalog installation, ARM builds, universal game/mod support, automatic full-system backups, safe multi-tenant isolation, and multiple independent panels sharing a Docker daemon. The current software is a tester build, not a production game-hosting service.

## Help test and improve it

The most useful next milestone is a **fresh installation by someone following the documentation without developer assistance**. Successful tests and failures are equally valuable.

- [Start a first-time test](docs/TESTING.md) and follow the [Docker install guide](docs/CONTAINERS.md).
- [Report a bug](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=bug_report.yml) with reproducible steps and redacted logs.
- [Submit a compatibility result](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=compatibility_report.yml), including a successful one.
- [Report security vulnerabilities privately](SECURITY.md), not in public issues.

GitHub Actions runs regression tests, browser tests, dependency/static/secret checks, packaged-container tests and image vulnerability checks before publishing a commit-specific candidate image. Moving release tags, including `alpha`, change **only after an explicit approved promotion**. Commit-specific image tags remain available for reproducible testing. **Passing CI or a scanner is not a security certification.**

## Source, releases and project history

The currently tested public image is `ghcr.io/versarepair/versagamepanel:alpha`. See the [release channels and promotion policy](docs/RELEASE_CHANNELS.md) for the proposed Dev, Alpha, Beta and Stable tracks and the explicit approval process. The source in this repository is a **clean public tester export**; the original recovered history and archived server/plugin bundles are retained separately and are not part of the distributed image.

VersaGamePanel continues the original GamePanel project. Its identity, preservation approach and motivation are described in [project history](docs/HISTORY.md). Original GamePanel visual assets remain part of the application.

Third-party games, container images and mods retain their respective licensing terms. **No general software license has been selected for this repository**; source visibility is not permission to redistribute or relicense it.

Maintained by **VersaRepair LLC**.
