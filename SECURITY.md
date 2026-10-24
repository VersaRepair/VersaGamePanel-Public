# Security reporting

This is early alpha software for trusted administrators on a dedicated Docker host/VM. The mounted Docker socket gives it host-root-equivalent authority. Do not expose its administration UI publicly or treat application operator permissions as hostile multi-tenant isolation.

Please report suspected authentication/authorization bypasses, unintended host access, secret disclosure, unsafe file handling or other security vulnerabilities **privately**:

[Report a vulnerability through GitHub's private reporting form](https://github.com/VersaRepair/VersaGamePanel-Public/security/advisories/new).

Include the image digest/commit, affected component, expected versus actual behavior and minimal reproduction using disposable data. Do not include real passwords, tokens, private keys, personal worlds, customer/player information or production exploit results. Do not test against someone else's deployment without their permission.

If private reporting is unavailable, do not post exploit details publicly. A detail-free public issue requesting a private reporting channel is sufficient.

Maintainer availability varies; no guaranteed response time or security-support period is promised. Public tester availability, passing CI and vulnerability scans are not a security certification. Keep independent backups, review update notes and avoid production deployment during the alpha.
