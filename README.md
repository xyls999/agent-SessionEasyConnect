# Agent Session Easy Connect (asec)

**Session and skill interchange for coding agents.**

`asec` reads the on-disk sessions of **Codex, OpenCode, Claude Code and Pi**, normalizes
them into one canonical format, and **injects** a session from any one of them into
another agent's *native* store — so the target agent can open it with its own tooling
(`codex resume`, `opencode import`, `claude --resume`, `pi --session`). It also does the
same thing for **skills** (`SKILL.md` folders), listing and syncing them across agents.

> 中文速览：`asec` 统一读取 Codex / OpenCode / Claude Code / Pi 的会话，归一化后**互相注入**
> 到对方的原生存储，让目标 Agent 用自己的命令就能读出来；同时支持把 skill（`SKILL.md`）
> 在几家 Agent 之间列出 / 安装 / 同步。

- Zero dependencies — pure Node.js (>= 22), uses the built-in `node:sqlite` for OpenCode.
- CLI + interactive TUI + local web UI.
- Read-only adapters; writes only when you explicitly inject.

---

## Supported agents (v1)

| Agent | Sessions (read + inject) | Skills (list + install/sync) |
|---|---|---|
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` + `state_5.sqlite` | `~/.codex/skills/` |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite) | `~/.config/opencode/skills/` |
| **Claude Code** | `~/.claude/projects/<cwd>/<uuid>.jsonl` | `~/.claude/skills/` |
| **Pi** | `~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl` | `~/.pi/agent/skills/` |
| cross-runtime alias | — | `~/.agents/skills/` |

---

## Requirements

- Node.js **>= 22** (tested on v24; `node:sqlite` is built in).
- Windows / macOS / Linux.
- Optional: the target agent's own CLI on `PATH` (`codex`, `pi`, `claude`, `opencode`)
  if you want to verify that the target can read an injected session.

## Install

```powershell
git clone https://github.com/xyls999/agent-SessionEasyConnect.git
cd agent-SessionEasyConnect

# run directly
node src/cli.js --help

# or install the `asec` command globally
npm link
asec --help
```

---

## Quick start

```powershell
asec list                            # all sessions from all agents
asec list --agent codex --json
asec show opencode ses_xxxx --format markdown     # text | markdown | canonical
asec roots                           # resolved session/skill directories

asec tui                             # interactive terminal UI
asec web --port 8787                 # local web UI -> http://127.0.0.1:8787/
```

---

## Session injection

```powershell
# native: write a real session file into the target agent's own store
asec inject --from claude:<uuid>  --to codex    --mode native
asec inject --from codex:<uuid>   --to pi       --mode native
asec inject --from pi:<uuid>      --to claude   --mode native
asec inject --from pi:<uuid>      --to opencode            # auto-runs `opencode import` in the session dir

# opencode extras: --no-import (JSON only), --keep-file / --out FILE (keep the JSON backup)
# (the JSON goes to the OS temp dir by default and is removed after a successful import)
# --model provider/id binds the session's continue-chat model; by default asec auto-detects
# the newest real provider/model from your local opencode store (never the phantom 'imported')

# context: archive the full transcript and add a short reference to AGENTS.md / CLAUDE.md
asec inject --from codex:<uuid> --to claude --mode context --cwd E:\myproject

# migrate previously appended histories (makes a backup before rewriting)
asec repair-context --cwd E:\myproject --dry-run
asec repair-context --cwd E:\myproject

# preview without writing
asec inject --from codex:<uuid> --to pi --mode native --dry-run
```

`--from` accepts `<agent>:<id>` or `--from <agent> --id <id>`; the id may be a full id
or any unique substring.

### Safe context mode

Full transcripts are saved under `<cwd>/.agent-session-bus/context/`. Only a small
reference is written to `AGENTS.md` (or `CLAUDE.md`). The target can read that archive
with file tools when needed; the entire history is **not** automatically loaded as
system instructions. Tool inputs and outputs are retained without preview truncation.
Reimporting a session replaces its reference instead of appending duplicates; older
snapshots remain in the archive.

`asec repair-context --cwd DIR` moves legacy imported blocks into the same archive,
deduplicates their references and preserves ordinary project instructions. Changed
existing context files are backed up byte-for-byte under `.agent-session-bus/backups/`.
Use `--to claude` to repair `CLAUDE.md`; the other targets share `AGENTS.md`.
`--dry-run` never writes files. Malformed/unclosed blocks are rejected by default;
`--recover` explicitly permits archiving them up to the next import marker or EOF.
Review the backup when using recovery, since unmarked trailing text may belong to the
unfinished transcript. New injections also migrate well-formed legacy blocks.

**Restart the target agent** after repair (or `/reload` in Pi) to rebuild the system
prompt. `/compact` cannot shrink an oversized `AGENTS.md`: conversation compaction
and project instructions are different inputs. Do not load an archive as a system
prompt. Archives may contain sensitive history; exclude `.agent-session-bus/` from
version control unless you have reviewed its contents.

### Enable flow (per target)

Each target needs different handling to actually read the injected session.

**→ Codex** (most involved)
1. `asec inject --from <agent>:<id> --to codex --mode native`
   - writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
   - emits **both** the Responses layer (`response_item`) **and** the typed layer
     (`event_msg.item_completed`: `UserMessage`/`AgentMessage`/`Reasoning`/`CommandExecution`)
     plus `turn_context`/`task_started`/`task_complete`
   - normalizes `cwd` to `\\?\E:\path` (Codex's `resume` picker filters on cwd)
   - registers a row in `~/.codex/state_5.sqlite` (`threads`); `--no-register` to skip
2. **Restart Codex** so it rescans, then:
   ```powershell
   codex resume <sid>          # or: codex resume --all
   ```
3. History projection into `thread_history_1.sqlite` is **asynchronous** — it lands a few
   seconds after the first resume/startup.
   Verify: `codex migrate-rollouts --json --thread <sid>` → `"status":"already_paginated"`.

**→ Pi**
- Writes `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<uuid>.jsonl` (session header + messages
  + `toolResult` messages, 8-hex ids, `parentId` chain).
- Tool results are emitted separately even when OpenCode stores them inline in an
  assistant message. Call IDs are paired and made portable; missing source tool names
  are recovered from the call. Orphan results are preserved as historical text.
- Source model metadata is kept in a `custom` entry, **not** a fake `imported` model
  selection. Resume uses your configured Pi model.
- Successful OpenCode compaction summaries become real Pi `compaction` checkpoints;
  earlier messages/tool outputs remain on disk, but only the newest summary and
  its following context are replayed. Pi-source checkpoints and retained tails also
  survive reinjection. Failed/pending summaries are not used as checkpoints.
- Before writing, Pi native injection checks the **actual target cwd**, its loaded
  ancestors and the Pi agent directory. Legacy marked histories in loaded instruction
  files are archived/backed up as in context mode. File precedence and nested-worktree
  shadow exclusions follow Pi; unrelated/unmarked rules are never truncated.
- Native injection refuses an estimated active context above 8,000,000 characters or
  loaded project instructions above 800,000 characters. Compact the source first or
  use context mode; these conservative guards do not replace provider token limits.
  `--dry-run` previews repairs without writing. Already-created sessions must be
  reimported to gain the checkpoints; restart Pi to clear cached instructions.
- Read it from the session's cwd with `pi --session <sid>`, or pass the full JSONL path.
  `pi --export <file> out.html` is read-only.

**→ Claude Code**
- Writes `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` (records with `uuid`/`parentUuid`,
  `tool_use` in assistant `content[]`, `tool_result` inside `role:"user"` records).
- Read it with: `claude --resume <uuid>` (or `--session-id <uuid>`).

**→ OpenCode**
- Generates an import JSON (`{info, messages:[{info,parts}]}`) **and then automatically runs
  `opencode import` from the session's own directory**, so the session is immediately readable
  in OpenCode (result: `Imported session: ses_...`). The JSON is written to the OS temp dir and
  deleted after success; use `--out FILE` or `--keep-file` to keep it, `--no-import` to skip
  the automatic import. If the `opencode` CLI is missing or import fails, the JSON is kept and
  the output falls back to the manual command.
- **Import must run in the session's directory** (the automatic step does this). OpenCode files
  the session under the project/directory of the *command's cwd* (not from `info.directory`);
  running it elsewhere puts the session in the wrong project and it will not appear where you
  expect.
- Untitled sources (e.g. most Pi sessions) get a session title derived from the first user
  message, so imports are findable instead of a pile of identical "Imported from pi" entries.
- The generator only emits `user`/`assistant` messages (system/developer dropped, tool results
  merged into the assistant's `tool` part), guarantees `parentID` on assistant messages, wraps
  non-object tool inputs, and sets `state.title`/`metadata`/`time` to satisfy OpenCode's schema.

### What each injection adds / processes

| Target | Must add | Must process |
|---|---|---|
| **Codex** | `session_meta`; per-turn `turn_context`+`task_started`/`task_complete`; **Responses + typed layers**; `state_5.threads` row | cwd → `\\?\E:\...`; register metadata; restart Codex; async projection |
| **Pi** | `session` header (version 3), source metadata `custom` entry, message records | cwd dir encoding, filename timestamp escaping, standalone `toolResult`, 8-hex id chain |
| **Claude Code** | per-record envelope (`sessionId`/`cwd`/`version`/`userType`) | cwd sanitize (non-alnum→`-`, >200 → truncate+hash), `uuid`/`parentUuid` chain, tool_result inside user record |
| **OpenCode** | import JSON `{info, messages:[{info,parts}]}` + auto `opencode import` in the session cwd | `agent` on every message.info; assistant needs `parentID/mode/path/cost/tokens/modelID/providerID/finish`; only user/assistant roles; tool `state.input` must be an object with `title`; the import **must run inside the session cwd** (done automatically) |

Full field-level details: [`docs/TECHNICAL-REPORT.md`](docs/TECHNICAL-REPORT.md).

---

## Skill interchange

All four agents discover skills as folders containing a `SKILL.md` (frontmatter `name` +
`description`), so a skill directory is portable as-is.

```powershell
asec skills list                                   # which skills each agent has
asec skills roots                                  # resolved skill directories
asec skills sync brainstorming --to all            # copy an existing skill to the others
asec skills install .\my-skill --to codex,pi       # install a skill folder
asec skills install ~/.config/opencode/node_modules/superpowers/skills --to all
asec skills sync pi-delegate --from opencode --to codex,claude,pi
```

`install` accepts either a single skill folder (contains `SKILL.md`) or a container folder
holding many skills; `--force` overwrites an existing skill.

---

## CLI reference

```
asec list   [--agent codex|pi|claude|opencode] [--json]
asec show   <agent> <sessionId> [--format text|markdown|canonical]
asec roots
asec repair-context [--cwd DIR] [--to pi|codex|claude|opencode] [--dry-run] [--recover]
asec inject --from <agent>:<id> --to <agent> [--mode native|context]
            [--out FILE] [--cwd DIR] [--dry-run] [--no-register]
asec skills list|roots|install|sync ...
asec tui
asec web    [--port 8787]
```

## Web UI

`asec web --port 8787` serves a local page where you can browse every agent's sessions,
read a normalized transcript, inject a session into any target, and hit **Verify** to run
the target agent's own read command (`codex migrate-rollouts`, `opencode export`,
`pi --export`, ...) and see the result.

---

## Verified

On the author's machine (2026-09-14, Windows, Codex CLI 0.154.0):

- **Read** — Codex 74 / Pi 7 / OpenCode 8 sessions parsed; Claude reader works (no local
  Claude sessions existed to read).
- **→ Codex** — after inject + `codex exec resume <id>`, `thread_history_1.sqlite`
  `thread_items` contains the imported `userMessage`/`reasoning`/`agentMessage`.
- **→ Pi** — `pi --export <file>` renders the injected session to HTML.
- **→ OpenCode** — `opencode import <file>` → `Imported session: ses_...`, readable by
  `opencode export`.
- **→ Claude Code** — native transcript written and re-read by `asec`.
- **Skills** — `asec skills list` across the 4 agents; `install` + `sync` verified.

## Limitations

- **Lossy, not round-trip.** Encrypted reasoning (Codex `encrypted_content`, Pi
  `thinkingSignature`) is dropped; provider-specific tool ids are regenerated.
- Role vocabularies differ (Codex `developer`, Pi `toolResult`, Claude tool results inside
  `user`). These are normalized to `user|assistant|system|tool`.
- Claude/Pi branching history (`parentId` DAG) is linearized.
- Writes go to real stores — use `--dry-run` first. Formats are owned by the vendors and
  may drift between versions.

## Architecture

```
src/util.js            paths, ids, cwd encodings (winCwd / claudeProjectKey / piSessionDirName)
src/adapters.js        Codex / Pi / Claude / OpenCode readers -> canonical IR
src/render.js          IR -> text/markdown; IR -> native (codex / pi / claude / opencode-import)
src/codex-register.js  write the Codex state_5.sqlite `threads` row
src/inject.js          native / context injection, dry-run
src/context.js         transcript archives, short references, legacy repair + backups
src/skills.js          skill roots, list, install, sync
src/cli.js             list / show / roots / inject / skills / tui / web
src/server.js + web/   local web UI (browse, inject, verify)
src/tui.js             terminal UI
```

## Tests

```powershell
npm test
```

Tests use temporary session stores and context files, not your live histories. They
cover large context imports, backups/recovery/deduplication, native tool-result
conversion, source compaction boundaries/retained tails, instruction-file discovery,
Pi string-content reading and web injection error handling.

Optional integration contract (requires an installed Pi package):

```powershell
node test/pi-request-contract.cjs "<pi-coding-agent-install-dir>"
# optionally validate a real source session, without modifying it:
node test/pi-request-contract.cjs "<pi-coding-agent-install-dir>" opencode:<session-id>
```

This uses Pi's real session manager, compaction implementation and Codex request
builder against a **local mock SSE response**, checks final request-field sizes and
active tool pairing, and verifies full historical outputs remain on disk. It makes
no remote inference request and never persists the mock summaries; it is not an
authentication, network or live-model success test.

## Roadmap

- MCP server mode (expose `list_sessions` / `get_session` / `inject` as MCP tools).
- Skill interop for more harnesses (Copilot CLI, Gemini/Antigravity, Hermes).
- Safer Codex injection without requiring a Codex restart.

## License

MIT — see [LICENSE](LICENSE).
