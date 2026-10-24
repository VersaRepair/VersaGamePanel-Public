# Compatibility and evidence

Evidence checkpoint: October 24, 2026. **Everything remains alpha.** "Lab verified" means the stated scenario passed, not that every platform, release, mod or multiplayer configuration is supported. Tester reports extend evidence; they do not automatically certify a game.

| Game or feature | Evidence | Boundaries |
| --- | --- | --- |
| Minecraft Java Vanilla 1.21.1 | Lab verified: install, actual console responses, settings/files, graceful stop, world backup/restore and persistence. Also verified through the published panel container. | Disposable test world; not every Minecraft version or multiplayer client combination. Users must accept the Minecraft EULA themselves. |
| Minecraft Fabric 1.21.1, loader 0.16.9, FerriteCore 7.0.3 | Lab verified: custom JAR inspection, correction of a mismatched selected version, real modded startup, console and world restoration. | One real mod combination; not a general mod compatibility guarantee. |
| Other Minecraft loaders and pack providers | Selectable or partially implemented; not end-to-end verified for this release. | Forge, NeoForge, Quilt, Paper and other selections need their own tests. Do not equate a displayed option with proven support. |
| Custom Minecraft mod inspection | Metadata, hashes, declared versions/dependencies/conflicts and safety limits have regression coverage. | Not malware scanning. Unknown metadata/ranges must be reviewed; nested JARs and full remote pack/dependency resolution are unfinished. |
| Unturned Dedicated, reviewed profile | Lab verified: fresh anonymous installation, foreground console, graceful save/stop, snapshot restoration. Public Hawaii Workshop item `1753134636` also tested. | Rolling Steam app `1110390`, not a frozen game version. Workshop content can change. No personal server, Steam account or tunnel is imported. |
| Terraria Vanilla 1.4.5.8 | Lab verified: real startup, console, graceful save/stop, save restoration and persistence. Runtime preparation also tested from the packaged panel. | Other versions and arbitrary native modifications are not certified. |
| Terraria tModLoader 2026.08.3.0 | Lab verified with the publisher's ExampleMod: startup, console, enabled mods and restoration of both `.wld` and `.twld` saves. | Local `.tmod` workflow; automatic Workshop mod downloading is not implemented. Not universal mod compatibility. |
| Recovered LinuxGSM/other templates | Preserved, unverified alternatives. | Prefer the reviewed profiles above. Image startup, permissions and console behavior vary; do not use production data. |

## Host, interface and networking

- Tested packaging host: Debian 13, Linux amd64, Docker Engine 26.1.5 and Compose 2.26.1. GitHub CI also exercises Linux amd64 container installation. Other Debian/Ubuntu releases need tester reports.
- Named local data volume: verified shared panel/game files, retained credentials/state/backups after panel replacement, and rejected anonymous storage. Local bind mounts have validation support, but do not have equivalent full end-to-end evidence yet.
- Chromium desktop and mobile-sized emulation workflows pass. This is **not physical iPhone/Android, Safari or Firefox certification**.
- Direct networking with explicit port bindings is implemented. Default admin and game bindings are localhost; remote play needs a separately planned private connection/binding. The panel does not configure your router or firewall.
- Playit integration, VersaRelay, ARM images, Docker Desktop/Windows, rootless/remote Docker, TrueNAS catalog packaging and safe multiple-panel sharing of one Docker daemon are not certified or not implemented.
- Docker socket access gives the panel host-root-equivalent authority. Operators' per-server permissions are application access controls, not hostile multi-tenant isolation. Use a dedicated host/VM and trusted administrators.

## Report a result

Use the [compatibility report](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=compatibility_report.yml) with your image **digest**, game/loader/mod versions and the exact steps you completed. Say "not tested" where appropriate. A boot screen or terminal echo alone is not evidence of a working interactive game console or successful multiplayer connection.
