# VersaGamePanel release channels

VersaGamePanel uses separate development and distribution repositories. **The software's original recovery and working development history remain private.** The public repository contains only a reviewed source export and public tester artifacts.

## Public distribution channels

| Channel | Image | Intended audience | Gate |
| --- | --- | --- | --- |
| Dev | `ghcr.io/versarepair/versagamepanel:dev` | Voluntary testers who accept unfinished or broken features | Explicit approval of a clean public source candidate |
| Alpha | `ghcr.io/versarepair/versagamepanel:alpha` | Early testers on dedicated disposable game-host VMs | Automated checks + maintainer review |
| Beta | `ghcr.io/versarepair/versagamepanel:beta` | Broader testers after functional and security milestones | Independent tests + security review + approval |
| Stable | `ghcr.io/versarepair/versagamepanel:stable` | Future production use | Versioned migration/rollback tests, independent security and deployment review |

**Only alpha is currently available as a public channel.** The other channel names describe the intended process; a channel tag does not exist until an explicitly reviewed build is promoted. A tag called "stable" must not be used until the software actually meets that bar. Do not deploy any current alpha or dev build on the primary TrueNAS host.

The release channel labels describe maturity, **not guaranteed safety**. See [security warnings](../SECURITY.md) and [compatibility evidence](COMPATIBILITY.md).

## Internal development is not a public release

Experimental pull requests in the private `VersaRepair/VersaGamePanel` repository can generate **private CI-tested preview artifacts** and optional private GHCR `versagamepanel-dev:pr-N` previews. These are for isolated internal testing only.

A private PR image must **never be retagged directly into a public release channel**. Docker images commonly contain source code; publishing a private development image may expose private code, internal deployment information or historical assets even when the source GitHub repository stays private.

When changes are ready for public testing, review and export only the approved source and assets into this public repository. Run the public build and tests here.

## Candidate build process

Merges to this public repository's `main` branch run CI where relevant and publish a **commit-specific candidate**:

`ghcr.io/versarepair/versagamepanel:sha-<PUBLIC_COMMIT_SHA>`

The candidate is the tested public image, not a promise of stable functionality. New public source commits do **not** automatically replace any of the four release channels.

Pinning a tested digest is safer than relying on a moving tag. Record the exact image digest along with the commit and test results for each release.

## Manual approval and channel promotion

After reviewing tests and approving an appropriate public candidate, an authorized maintainer uses GitHub **Actions → Promote approved release channel → Run workflow**, on `main`.

1. Select `dev`, `alpha`, `beta`, or `stable`.
2. Enter the **full 40-character SHA** of a tested **public main** source commit for which a `sha-...` image exists.
3. Type the exact confirmation `PUBLISH-DEV`, `PUBLISH-ALPHA`, `PUBLISH-BETA`, or `PUBLISH-STABLE`.
4. Approve the channel's GitHub Environment if a required reviewer is configured.

The action verifies the source commit belongs to public `main`, pulls an existing commit-specific image, verifies its embedded revision label, and **promotes the same built image without a new build**. It moves only the selected channel tag.

A version-specific GitHub Release record is created for each promotion (`dev-<short SHA>`, `alpha-<short SHA>`, and so forth), recording its source commit and image. Non-stable channels are marked prerelease. The `stable` channel will be highlighted as the latest GitHub Release only if and when a genuinely stable version is approved.

**Set required reviewers on GitHub Environments named `release-dev`, `release-alpha`, `release-beta` and especially `release-stable` before enabling routine promotions.** Without environment protection, manual dispatch and the typed confirmation are the only approval gates. Protect `main` and require reviews/checks for changes to the release workflows as well.

## Rollbacks and compatibility

A Docker tag can move, but the original commit-specific candidate must be retained for rollback. Save the previous digest and a compatible **full data backup** before any upgrade; reverting an image tag alone does not guarantee a rollback after future data migrations.

The Docker socket still gives current alpha builds root-equivalent authority on their Docker host. The isolated VersaGameAgent is experimental and not yet wired into the public panel. A published channel is not authorization to use the primary TrueNAS app engine.

## Maintainer release checklist

- [ ] Public export reviewed for credentials, family data, private infrastructure, source licensing and third-party redistribution constraints.
- [ ] Source committed and reviewed in this public repo, with all required CI and packaged image tests passing.
- [ ] Real-game and independent installation evidence appropriate for the selected channel documented.
- [ ] Rollback procedure and schema/data migration impact reviewed.
- [ ] Exact public candidate tag, source SHA and image digest recorded.
- [ ] Channel/environment approval given; promotion performed from the default branch.
- [ ] New GitHub Release, container tag and documentation verified from an unauthenticated tester's perspective.
