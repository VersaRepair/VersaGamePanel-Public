# Tester checklist

Thanks for helping recover and improve VersaGamePanel. A useful report can be small: one reproducible failure or one accurately described success is enough. You do not need to test everything.

## Before starting

- [ ] Read the [installation guide](CONTAINERS.md) and [compatibility matrix](COMPATIBILITY.md).
- [ ] Use a dedicated Linux amd64 Docker host/VM, trusted administrators and disposable game data. Do not import the only copy of a family server or production world.
- [ ] Keep the UI local or use the documented SSH tunnel. Do not publish its admin port to the internet. This checklist requires no router port forwarding.
- [ ] Check available RAM/disk before installing games. Prepare only the dedicated runtime you intend to test; preparation downloads publisher files. No purchase, game installation, mod download or EULA acceptance is automatic permission from this checklist.
- [ ] Note image digest, host OS, Docker/Compose version and intended game/version. Do not send the entire environment, Docker inspect output or data volume.

## 1. Installation and sign-in

- [ ] Install using one method in the guide: Compose **or** docker run, not both simultaneously.
- [ ] Confirm the panel becomes healthy and the UI loads.
- [ ] Read the generated password locally, sign in as `admin`, and change it. Never include either password in feedback.
- [ ] Confirm a fresh installation has **zero configured game servers**.
- [ ] Sign out and confirm protected actions require signing back in.

If setup fails, report the exact failed step and a small, manually redacted error. Do not disable authentication or loosen filesystem permissions to get past it.

## 2. One disposable server

- [ ] Select one reviewed profile from the matrix. For Minecraft, choose an explicit game version and loader; accept its EULA only if you agree to it.
- [ ] Choose unused ports and reasonable resource limits. Keep localhost bindings unless you deliberately understand and need another binding. A remote game client cannot reach the Docker host's localhost just because the UI is reachable through an SSH tunnel.
- [ ] Create and start the server; allow time for the first download/install.
- [ ] Look for actual game readiness, not just a running container.
- [ ] Send a harmless, game-appropriate console query. Verify a **game-generated response**, not just your typed command appearing on screen.
- [ ] Disconnect/reconnect the console and confirm the game keeps running.
- [ ] If practical, join with the matching game client. Record "not tested" if you only tested server startup.
- [ ] Stop gracefully, restart and verify settings/world persistence. Keep a failed server's data until you understand the failure.

Test mods separately after the unmodified game works. Record exact versions and public mod IDs/names where appropriate, but redact private download URLs/API keys. Do not upload executable mods or world archives to a public issue.

## 3. Files and backup/restore

- [ ] Stop the game before editing its files or taking a consistent save backup.
- [ ] Upload a harmless text marker in a disposable world/save location; confirm it can be downloaded unchanged. Do not modify an actual world database by hand.
- [ ] Create the appropriate backup: Minecraft **world backup**, or reviewed Unturned/Terraria/tModLoader **save snapshot**. Download an independent copy to a safe location you control.
- [ ] Change only the disposable marker, then restore the earlier backup/snapshot. Confirm the original marker returns and the game remains stopped until you start it.
- [ ] Start the game again and verify actual world behavior. For a modded Terraria test, check the corresponding `.wld` and `.twld` state, not just one file.

These are scoped game backups, **not full-host or full-panel backups**. Do not attach them to issues. Do not delete an old save or original backup to prove restore works.

## 4. Panel replacement (optional, Compose)

Stop games gracefully and make a separate full data-volume backup before maintenance. From the same Compose folder, keeping the same volume configuration:

```sh
docker compose up -d --force-recreate
```

- [ ] Sign in again; losing the old session is expected.
- [ ] Confirm the changed admin password still works and accounts, server records, files and backups remain.
- [ ] Start the disposable game again and check its saved state.

This tests replacement of the same image, not a guaranteed upgrade/migration or rollback between releases. `docker compose down` does **not** stop sibling game containers. Do not use `down -v`, Docker prune or volume deletion as a troubleshooting step.

## 5. Send a useful result

- [ ] Search existing issues, then use [bug report](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=bug_report.yml) or [compatibility result](https://github.com/VersaRepair/VersaGamePanel-Public/issues/new?template=compatibility_report.yml).
- [ ] Include what you expected, what actually happened, exact steps and versions, and whether you could reproduce it.
- [ ] State which checklist steps were **passed / failed / not tested**. Reporting a successful limited test is welcome.
- [ ] Manually redact screenshots and small log excerpts. Never include passwords, bearer/session tokens, cookies, Steam credentials, private URLs, customer/player records, `users.json`, Compose secrets, whole volumes or unredacted diagnostic bundles.
- [ ] For security flaws, use [private reporting](../SECURITY.md), not public issue forms.

When finished, stop the disposable game through the panel. Remove only test records/data you intentionally created and no longer need; leave original servers, shared Docker resources and other applications untouched.
