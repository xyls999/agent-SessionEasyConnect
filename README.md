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
asec inject --from pi:<uuid>      --to opencode --out .\import.json
opencode import .\import.json

# context: append a Markdown transcript to AGENTS.md / CLAUDE.md instead
asec inject --from codex:<uuid> --to claude --mode context --cwd E:\myproject

# preview without writing
asec inject --from codex:<uuid> --to pi --mode native --dry-run
```

`--from` accepts `<agent>:<id>` or `--from <agent> --id <id>`; the id may be a full id
or any unique substring.

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
- Read it with: `pi --session <sid>` (resumes) or `pi --export <file> out.html` (read-only).

**→ Claude Code**
- Writes `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` (records with `uuid`/`parentUuid`,
  `tool_use` in assistant `content[]`, `tool_result` inside `role:"user"` records).
- Read it with: `claude --resume <uuid>` (or `--session-id <uuid>`).

**→ OpenCode**
- Generates an import JSON (`{info, messages:[{info,parts}]}`); import it with:
  ```powershell
  cd <session cwd>
  opencode import .\import.json
  ```
- **Run `opencode import` from the session's directory.** OpenCode files the session under the
  project/directory of the *command's cwd* (not from `info.directory`); running it elsewhere
  puts the session in the wrong project and it will not appear where you expect.
- The generator only emits `user`/`assistant` messages (system/developer dropped, tool results
  merged into the assistant's `tool` part), guarantees `parentID` on assistant messages, wraps
  non-object tool inputs, and sets `state.title`/`metadata`/`time` to satisfy OpenCode's schema.

### What each injection adds / processes

| Target | Must add | Must process |
|---|---|---|
| **Codex** | `session_meta`; per-turn `turn_context`+`task_started`/`task_complete`; **Responses + typed layers**; `state_5.threads` row | cwd → `\\?\E:\...`; register metadata; restart Codex; async projection |
| **Pi** | `session` header (version 3), `model_change`, message records | cwd dir encoding, filename timestamp escaping, standalone `toolResult`, 8-hex id chain |
| **Claude Code** | per-record envelope (`sessionId`/`cwd`/`version`/`userType`) | cwd sanitize (non-alnum→`-`, >200 → truncate+hash), `uuid`/`parentUuid` chain, tool_result inside user record |
| **OpenCode** | import JSON `{info, messages:[{info,parts}]}` | `agent` on every message.info; assistant needs `parentID/mode/path/cost/tokens/modelID/providerID/finish`; only user/assistant roles; tool `state.input` must be an object with `title`; **run `opencode import` inside the session cwd** |

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
src/skills.js          skill roots, list, install, sync
src/cli.js             list / show / roots / inject / skills / tui / web
src/server.js + web/   local web UI (browse, inject, verify)
src/tui.js             terminal UI
```

## Roadmap

- MCP server mode (expose `list_sessions` / `get_session` / `inject` as MCP tools).
- Skill interop for more harnesses (Copilot CLI, Gemini/Antigravity, Hermes).
- Safer Codex injection without requiring a Codex restart.

## License

MIT — see [LICENSE](LICENSE).
