# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [1.0.0] - 2026-09-14

First public release.

### Added
- **Uniform session reader** for Codex, OpenCode, Claude Code and Pi, normalized to one
  canonical IR (`agent-session-bus/v1`): `asec list`, `asec show`, `asec roots`.
- **Cross-agent session injection** (`asec inject`):
  - `native` mode writes a real session into the target's own store (Codex rollout,
    Pi session jsonl, Claude transcript, OpenCode import JSON).
  - `context` mode appends a Markdown transcript to `AGENTS.md` / `CLAUDE.md`.
  - `--dry-run` preview; `--out`, `--cwd`, `--no-register` options.
- **Codex-specific handling**: emits both the Responses layer and the typed
  `event_msg.item_completed` layer, normalizes `cwd` to `\\?\...`, and registers the
  `state_5.sqlite` `threads` row so `codex resume` can list and restore the session.
- **Skill interchange** (`asec skills`): `list`, `roots`, `install`, `sync` across the
  four agents plus the `~/.agents/skills` cross-runtime alias.
- **Interactive TUI** (`asec tui`) and **local web UI** (`asec web`) with browse, inject
  and "Verify (let the target read it)" actions.
- Documentation: `README.md` and `docs/TECHNICAL-REPORT.md` (field-level injection report).

### Notes
- Zero runtime dependencies; requires Node.js >= 22 (uses built-in `node:sqlite`).
- Conversion is intentionally lossy: encrypted reasoning is dropped and provider-specific
  tool ids are regenerated; dual-direction high-fidelity round-trip is not a goal.
