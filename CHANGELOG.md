# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [1.0.3] - 2026-09-16

### Fixed
- **Codex → OpenCode injection.** `opencode import` rejected the generated file in several
  ways; the OpenCode generator now matches its schema:
  - only `user` / `assistant` messages are emitted (Codex `developer`/`system` messages are
    dropped; `tool_result` is merged into the matching `tool` part of the preceding
    assistant message instead of becoming its own message);
  - every assistant message carries a `parentID`; if the transcript would start with an
    assistant turn a placeholder user message is synthesized so the import stays valid;
  - tool `state.input` is always an object (Codex `custom_tool_call` carries JS source as a
    string, wrapped as `{ raw: ... }`) and `state.title` / `metadata` / `time` are always set;
  - `info.directory` is normalized to forward slashes.
- **Codex reader**: the synthetic `<environment_context>` user message is filtered out, so
  imported transcripts start with the real user turn.
- **Docs / UX**: `opencode import` must be run **from the session's directory**. OpenCode
  assigns the project/directory from the command's cwd (not from `info.directory`), so
  running it elsewhere files the session under the wrong project and it will not show up.
  The injector's hint/note now says this explicitly.

## [1.0.2] - 2026-09-15

### Fixed
- **Codex injection: drop the `response_item` reasoning record.** Codex replays
  `response_item` entries as Responses API input items. A reasoning item has no portable
  text (only `id` + `encrypted_content`), so the server tries to look it up by id and
  returns `404 Item with id 'rs_...' not found. Items are not persisted when 'store' is
  set to false.` on resume. We cannot fabricate valid `encrypted_content`, so the
  generator now omits `response_item` reasoning entirely and keeps only the typed
  `event_msg.item_completed` `Reasoning` item (UI/history placeholder).
- Verified on the Pi `tmp-issac` session (`01a096ef`): generated rollout has
  `response_item_reasoning = 0`, 289 typed `Reasoning` items, 312/311 tool call/output
  with max `call_id` 29, 0 invalid, 0 unmatched.

## [1.0.1] - 2026-09-15

### Fixed
- **Codex injection: tool `call_id` length/charset.** Pi stores composite tool-call ids
  (`call_xxx|fc_yyy`, ~83 chars). They were written verbatim into Codex's
  `function_call.call_id` / `function_call_output.call_id`, which made Codex reject the
  resumed request with HTTP 400:
  `[StringParam] [input[7].call_id] [string_above_max_length] ... maximum length 64`.
  Call ids are now normalized deterministically (`U.sanitizeCallId`: split on `|`, keep
  `[A-Za-z0-9_-]`, cap at 64) and call/output stay paired. Also applied to the Claude and
  OpenCode generators.
- Verified against the Pi `tmp-issac` session (`01a096ef`, 773 messages / 312 tool calls):
  the generated rollout now has max `call_id` length 29, 0 invalid ids, 0 unmatched outputs.

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
