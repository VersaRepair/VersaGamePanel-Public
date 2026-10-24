# Project history and provenance

VersaGamePanel is the continuing development of **GamePanel**, a self-hosted game-server management project recovered in October 2026.

## Origins

The original project grew out of a practical problem: making a game server easy enough for a family member to install and manage without repeated help with SSH, Linux services and terminal commands. The goal was never to build a single-game launcher or require a particular hosting provider. It was to place everyday server controls in a comprehensible browser interface while retaining advanced management capabilities.

The recovered software already included a multi-game interface, Docker management, interactive consoles, Minecraft configuration and world recovery tools. Development now focuses on safely validating and extending those capabilities across supported games.

## Preservation

The original source snapshot, history, personal game-server artifacts and recovery evidence are retained in a **separate private archival repository**. This public tester repository contains only the reviewed application export and the assets needed by the alpha. It does not contain any archived family server, player world, account credentials or private tunnel configuration.

Original GamePanel branding remains in `public/assets/brand/`; those visual assets are kept as part of the project's identity instead of being replaced as a side effect of technical modernization. The original archival history and tag are not rewritten for the public alpha.

## Development direction

The project's guiding idea is **simple workflows without loss of ownership or control**:

- A fresh installation has no preconfigured game servers.
- Supported games are created by an explicit user action.
- Game-specific configuration and runtime/network choices remain separate.
- Self-hosting does not require a VersaRepair account or hosted relay.
- Experimental and verified capabilities are clearly distinguished.

Early development included assistance from AI tools such as ChatGPT and Codex. Available records do not support reliable per-asset authorship attribution, so none is inferred.

Current software capabilities and installation steps are described in the [README](../README.md), [compatibility matrix](COMPATIBILITY.md), and [tester guide](TESTING.md). This document records project context, **not** a promise of present-day feature support.
