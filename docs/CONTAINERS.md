# Public tester alpha — Docker installation

This is an early **Linux amd64 tester build**, not production-certified software. Use a dedicated Debian/Ubuntu Docker host or disposable VM. Docker Engine 26+ and Compose v2 are the tested baseline. ARM, Windows hosts, Docker Desktop, rootless engines, remote Docker contexts, and TrueNAS catalog installation are not yet certified.

## Trust boundary

The Docker socket gives the panel host-root-equivalent control. Dropping Linux capabilities and running Node as UID 1000 reduce accidental privilege, but **do not sandbox a compromised panel from its Docker host**. Do not mount the socket on an untrusted shared host. Admins can select images/commands and use host Docker maintenance. This is a trusted-admin product, not safe untrusted multi-tenant hosting.

No privileged container, host networking, router changes, port forwarding, external telemetry service, game installation or EULA acceptance is enabled by installation. The web UI is bound to localhost. Game ports also default to localhost and are configured separately; Playit/VersaRelay are not implemented by this package.

## Install with Compose (recommended)

Download the versioned Compose file from the public repository and start it:

```sh
curl -fL https://raw.githubusercontent.com/VersaRepair/VersaGamePanel-Public/main/compose.yaml -o compose.yaml
docker compose up -d
```

Then open `http://127.0.0.1:8788`. From another computer, use an SSH tunnel rather than exposing HTTP publicly:

```sh
ssh -L 8788:127.0.0.1:8788 your-user@your-docker-host
```

For deliberate trusted LAN access only: `VGP_BIND_ADDRESS=YOUR_HOST_LAN_IP docker compose up -d`. Sign-in over plain HTTP is not encrypted; use a trusted private connection or a correctly configured HTTPS proxy for non-local access. Do not forward the admin port to the internet. Existing public-URL/cookie settings require correct HTTPS proxy configuration and are not automatically set up here.

The public `alpha` tag remains on its last explicitly approved version. The reviewed public release workflow will publish CI-tested `sha-COMMIT` candidate tags; an authorized maintainer must explicitly promote a candidate before `dev`, `alpha`, `beta` or `stable` moves. See [release channels](RELEASE_CHANNELS.md). Set `VGP_IMAGE=ghcr.io/versarepair/versagamepanel:sha-COMMIT` or an image digest to pin a build. `VGP_PORT` changes the host port; `VGP_DATA_VOLUME` changes the named data volume. Do not run multiple panels against the same volume or daemon: game container names and the Docker maintenance view are not namespaced between installations yet.

## Install with docker run

The image is pulled automatically if needed; no local source checkout or npm installation is required:

```sh
docker run -d --name versagamepanel --restart unless-stopped -p 127.0.0.1:8788:8788 -v versagamepanel_data:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/versarepair/versagamepanel:alpha
```

Compose adds a read-only root filesystem, bounded logs/resources, temporary `/tmp`, and capability limits. It is preferred to the shorter run example. Neither grants isolation from the mounted Docker daemon.

## First login

Username: `admin`. Retrieve the randomly generated password **on your own terminal**:

```sh
docker exec --user 1000:1000 versagamepanel cat /data/initial-admin-password.txt
```

Do not paste its output into issues, chat, or screenshots. Change it in the panel, then remove the obsolete initial-password file locally if desired. It is mode 600, not printed in logs and not baked into the image. Replacement preserves existing users and does not reset passwords. Optional `GAMEPANEL_ADMIN_PASSWORD_FILE` can point to a mounted secret readable by UID 1000 on first run; secrets need at least 12 characters. It does not override existing users. Do not put real passwords in Compose, Git, image build arguments, or support reports. Authentication and legacy-token disabling are enforced by the container bootstrap.

## Games

Installation starts with **zero servers**. Minecraft downloads its selected runtime when you explicitly create/start a server and accept its EULA. Vanilla and Fabric/FerriteCore paths have real-game lab validation; not every selectable loader or pack provider is verified.

Prepare the three reviewed dedicated runtimes with one explicit command:

```sh
docker exec versagamepanel /app/deploy/container/entrypoint.sh prepare-runtime all
```

Or replace `all` with `unturned`, `terraria`, or `tmodloader`. This builds the fixed recipes on your Docker host and downloads publisher files. It may take several minutes and several GB of space. It installs no configured game server and does not import existing data. Your game purchases/licenses and publisher terms still apply. The panel image contains recipes, **not redistributed game binaries, Workshop content, mods or family save data**. Unturned's first server start separately performs its anonymous SteamCMD installation. Prepared images are kept on the Docker host and reused.

Use the reviewed Unturned Dedicated, Terraria Vanilla or Terraria tModLoader profiles, not the recovered unverified LinuxGSM alternatives. Prepare runtimes again only for an intentional runtime upgrade; never rebuild/change a running game blindly. New panel versions do not automatically migrate old game images.

## Persistent data and backups

The named `versagamepanel_data` volume contains accounts, panel state, game files, staged mods and backups. The bootstrap inspects its own `/data` mount to map host paths for sibling games correctly. Never map `/data` to `/`, alter the container hostname, or set a remote Docker context. For bind mounts, use a dedicated empty directory or existing data owned by UID/GID 1000; startup does not recursively change ownership. Arbitrary custom UIDs and non-local volume drivers are not supported yet.

Panel replacement preserves the volume, not RAM-only sessions. Game containers are siblings, not Compose children: `docker compose down` stops the panel **but leaves games running**. Stop games gracefully in the panel before maintenance/host backup. Never assume `down` captured a consistent game save. In-app world/save snapshots are scoped backups, not full-host backups; keep an additional offline copy of the whole data volume and any other host data you care about. Private archives are not encrypted by the panel.

Update deliberately, after stopping games and saving a separate full data-volume backup:

```sh
docker compose pull
docker compose up -d
```

Keep the previous image digest and the matching data backup. Reverting an image alone does not guarantee rollback after a future data migration. Never use `docker compose down -v` unless you intentionally want to erase the panel data volume, accounts, worlds and backups.

## Troubleshooting / tester reports

`docker compose ps` shows health; `docker compose logs --tail=100 panel` shows non-secret startup errors. If Docker access, a persistent writable `/data` mount or UID permissions are wrong, startup fails instead of creating a separate ephemeral game tree. Missing runtime images are reported without an automatic external pull.

Report image tag/digest, Linux/Docker/Compose versions, game/version, reproduction steps and a redacted error. Never attach your data volume, users.json, password/token files, game-account credentials, full world backups or unredacted logs. The image health check only tests the authenticated API's readiness, not whether any game is healthy.
