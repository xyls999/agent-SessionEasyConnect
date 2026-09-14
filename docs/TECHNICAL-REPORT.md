# 跨 Agent 会话注入 —— 技术汇报

> 工具：`agent-session-bus`（`E:\session\agent-session-bus`）
> 范围：把 A 家（opencode / pi / claude / codex）的会话，转成 B 家自己的原生存储格式，让 B 用自己的命令（`codex resume` / `pi --session` / `claude --resume` / `opencode import`）能读出来。
> 环境：Windows / PowerShell 5.1，Node v24（内置 `node:sqlite`）。

---

## 0. 结论先行（四家注入"要加什么、处理什么"速查）

| 目标 | 写入位置 | 必须补的"外壳" | 必须做的"处理" |
|---|---|---|---|
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<本地ts>-<uuidv7>.jsonl` | ① `session_meta` ② 每 turn 的 `turn_context`+`task_started`/`task_complete` ③ **两类记录：Responses 层 + Typed 层** | ① cwd 归一成 `\\?\E:\...`（反斜杠+前缀，resume 选择器按它过滤）② 写 `state_5.sqlite.threads` 元数据行（否则报 *missing its SQLite metadata*）③ 投影是**异步**的，需重启/首次 resume |
| **Pi** | `~/.pi/agent/sessions/<cwd编码>/<ts>_<uuidv7>.jsonl` | `session` 头（version 3）+ `model_change` + 消息记录 | ① cwd 目录编码 ② 文件名时间戳转义 ③ `toolResult` 是**独立消息**、用 `toolCallId` 配对 ④ 8-hex 会话内 id + `parentId` 链 |
| **Claude Code** | `~/.claude/projects/<cwd净化名>/<uuidv4>.jsonl` | 每条记录都要带 `sessionId/cwd/version/userType` | ① 目录名净化（非字母数字→`-`，超长截断+base36）② `uuid`+`parentUuid` 链 ③ `tool_use` 在 assistant 的 `content[]`，`tool_result` 塞在 **role:user** 记录里 |
| **OpenCode** | 不写库；生成 import JSON 后 `opencode import` | `{info, messages:[{info, parts}]}` | ① **每条 message.info 必须有 `agent` 字段**（否则 `Missing key at ["agent"]`）② assistant 需 `parentID/mode/path/cost/tokens/modelID/providerID/finish` ③ user 需 `model/summary` |

---

## 1. 四家存储与标识对照

| | opencode | codex | claude | pi |
|---|---|---|---|---|
| 存储 | `~/.local/share/opencode/opencode.db`（SQLite） | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `~/.claude/projects/<净化cwd>/*.jsonl` | `~/.pi/agent/sessions/<编码cwd>/*.jsonl` |
| 载体 | 表 `session`/`message`/`part` | JSONL，每行 `{timestamp,ordinal,type,payload}` | JSONL，一行一条记录 | JSONL，line1 是 session 头 |
| Session ID | `ses_<12hex><14base62>`（时间反序编码） | UUIDv7（`session_meta.payload.id` = 文件名） | UUIDv4（= 文件名） | UUIDv7（= 文件名后缀） |
| Message ID | `msg_...` | Responses 层 `msg_/rs_/fc_/fco_/call_`；Typed 层 `item-N`/`exec-<uuid>` | 记录级 `uuid`+`parentUuid` | 8-hex 会话内唯一 |
| 顺序键 | `message.time_created`；part 按 `part.id` | 行内 `ordinal`（单调） | `parentUuid` 链 | `parentId` 链 |
| 工具调用 | 单个 `tool` part 的 `state` 状态机 | Responses 层 call/output 分离；Typed 层 `CommandExecution`/`FileChange`/`McpToolCall` | assistant `tool_use` ↔ user `tool_result` | assistant `toolCall` ↔ 独立 `toolResult` 消息 |
| 压缩 | `part.type=compaction` | `compacted.replacement_history` | `summary`/`compact_boundary` | `compaction` 记录 |

---

## 2. 统一中间格式（IR）

所有读取适配器都归一到同一个 IR，再由各家 renderer 写回：

```jsonc
{
  "schema": "agent-session-bus/v1",
  "agent": "opencode",
  "session_id": "...",
  "cwd": "...",
  "created_at": 1789... , "updated_at": ...,
  "title": "...", "model": "...", "source": "<原文件路径>",
  "messages": [
    { "id": "...", "parent_id": "...", "role": "user|assistant|system|tool",
      "ts": 1789..., "model": "...",
      "parts": [
        {"type":"text","text":"..."},
        {"type":"reasoning","text":"...","opaque":true},
        {"type":"tool_call","id":"...","name":"...","input":{...}},
        {"type":"tool_result","id":"...","name":"...","output":"...","is_error":false},
        {"type":"image","mime":"...","data":"..."}
      ] }
  ]
}
```

对应代码：`src/util.js`（IR 工厂/路径编码）、`src/adapters.js`（读取）、`src/render.js`（回写）、`src/inject.js`（注入编排）、`src/codex-register.js`（Codex 元数据）。

---

## 3. 各阶段调整记录（这次真正改了什么）

### 阶段 1：读取适配（已完成，稳定）
- opencode：读 SQLite 三表，message 按 `time_created,id`，part 按 `(message_id,id)`；`tool` part 的 `state.input/state.output` 拆成 `tool_call`+`tool_result`。
- pi：line1 session 头；`message.content[]` 映射 text/thinking/toolCall/image；`toolResult` 角色单独处理。
- claude：`uuid/parentUuid` 链；assistant `content[]` 里 `tool_use`；`tool_result` 在 role=user 记录里，识别后归到 `role:"tool"`。
- codex：**只读 Responses 层**（`response_item`），因为读取时它是全量的。

### 阶段 2：注入框架
- `injectNative`：把 IR 渲染成目标原生文件，写进目标存储。
- `injectContext`：另一种保守模式——把 Markdown 转录追加到 `AGENTS.md`/`CLAUDE.md`，不做原生注入。

### 阶段 3：Codex —— Typed 层修复（**第一个真 bug**）
- **现象**：注入后 `codex resume` 只有新提问、没有历史。
- **定位**：Codex 恢复历史读的是 `thread_history_1.sqlite.thread_items`，其来源是 rollout 里的 **`event_msg.item_completed`（typed 层）**，不是 `response_item`。我们的 rollout 只有 Responses 层 → 投影为空。
- **修复**：`genCodex` 现在每个 turn 同时产出两层：
  - Responses 层：`response_item.message` / `function_call` / `function_call_output`（喂模型）
  - Typed 层：`event_msg.item_completed` → `UserMessage` / `AgentMessage` / `Reasoning` / `CommandExecution`（供投影）
  - 补 `turn_context`、`task_started`、`task_complete`

### 阶段 4：Codex —— 元数据 + cwd（**第二个真 bug，也是"resume 里找不到"的直接原因**）
- **现象 A**：裸 rollout 文件 Codex 不认，`migrate-rollouts --apply` 报 `thread ... is missing its SQLite metadata`。
  → 修复：新增 `src/codex-register.js`，注入时向 `state_5.sqlite.threads` 写一行（幂等，已存在则跳过）。可用 `--no-register` 关闭。
- **现象 B**：即使写了元数据，`codex resume` 列表里**仍然看不到**。
  真实库对比发现：正常 Codex 会话的 `cwd` 存的是 `\\?\E:\session`（反斜杠 + Win32 扩展前缀），而我们注入写的是 `E:/session`（正斜杠，来自 opencode）。`codex resume` 选择器**按 cwd 过滤** → 不匹配就不列出。
  → 修复：新增 `U.winCwd()`，把 cwd 归一为 `\\?\` + 反斜杠；rollout 的 `session_meta.cwd` 和 `threads.cwd` 都用它。
- **现象 C**：投影是**异步**的，`codex resume`/启动之后要过几秒 `thread_items` 才写进去。

### 阶段 5：OpenCode import 结构修复
- **现象**：`opencode import` 报 `Missing key at ["agent"]`（而且会先建出一个空 session）。
- **修复**：`genOpenCodeImport` 里每条 `message.info` 都补 `agent`；assistant 补 `parentID/mode/path/cost/tokens/modelID/providerID/finish`；user 补 `model/summary`。重导入成功。

### 阶段 6：验证方法（这次补上的真实验证）
- Codex 读：`codex exec resume <id> --json` 会出现 `{"type":"thread.started","thread_id":"<id>"}`；随后查 `thread_history_1.sqlite.thread_items` 能看到导入内容。
- Pi 读：`pi --export <file> out.html`（只读，源文件 SHA256 不变）。
- OpenCode 读：`opencode export <id>`。
- Claude：写 `projects/<净化cwd>/<uuid>.jsonl`，本机无 claude 登录态，未做 picker 验证。

---

## 4. 各目标注入的详细"要加什么 / 处理什么"

### 4.1 Codex（最复杂）

**文件**：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<本地时间 YYYY-MM-DDTHH-mm-ss>-<uuidv7>.jsonl`
（目录/文件名用**本地时间**；行内 `timestamp` 用 **UTC ISO**）

**必须记录（按顺序）**
```jsonc
// 1) 会话头
{"timestamp":"<ISO UTC>","ordinal":0,"type":"session_meta","payload":{
  "session_id":"<uuidv7>","id":"<同一个uuidv7>","timestamp":"<ISO UTC>",
  "cwd":"\\\\?\\E:\\session",              // ★ 必须是 \\?\ + 反斜杠
  "originator":"codex-tui","cli_version":"0.154.0","source":"cli","thread_source":"user",
  "model_provider":"OpenAI","base_instructions":{"text":"..."},
  "history_mode":"paginated","context_window":{"window_id":"<uuid>"}}}

// 2) 每个 turn：turn_context + task_started
{"...","type":"turn_context","payload":{"turn_id":"<uuid>","root_turn_id":"<uuid>","cwd":"...",
  "workspace_roots":["..."],"current_date":"YYYY-MM-DD","timezone":"UTC",
  "approval_policy":"never","approvals_reviewer":"user",
  "sandbox_policy":{"type":"danger-full-access"},"permission_profile":{"type":"disabled"},
  "model":"gpt-5","personality":"pragmatic","collaboration_mode":{"mode":"default"},
  "realtime_active":false,"effort":"medium"}}
{"...","type":"event_msg","payload":{"type":"task_started","turn_id":"<uuid>",
  "started_at":<epoch秒>,"model_context_window":258400,"collaboration_mode_kind":"default"}}

// 3) 用户文本 —— 两层都要写
{"...","type":"response_item","payload":{"type":"message","id":"msg_<40hex>","role":"user",
  "content":[{"type":"input_text","text":"..."}],
  "internal_chat_message_metadata_passthrough":{"turn_id":"<uuid>"}}}
{"...","type":"event_msg","payload":{"type":"item_completed","thread_id":"<sid>","turn_id":"<uuid>",
  "item":{"type":"UserMessage","id":"<uuid>","content":[{"type":"text","text":"...","text_elements":[]}]},
  "completed_at_ms":<epoch毫秒>}}

// 4) 助手文本 —— 两层都要写
{"...","type":"response_item","payload":{"type":"message","id":"msg_<40hex>","role":"assistant",
  "content":[{"type":"output_text","text":"..."}],"phase":"final_answer",
  "internal_chat_message_metadata_passthrough":{"turn_id":"<uuid>"}}}
{"...","type":"event_msg","payload":{"type":"item_completed","thread_id":"<sid>","turn_id":"<uuid>",
  "item":{"type":"AgentMessage","id":"msg_<40hex>","content":[{"type":"Text","text":"..."}],
          "phase":"final_answer"},"completed_at_ms":<ms>}}

// 5) 推理（可选，加密内容通常为空）
{"...","type":"response_item","payload":{"type":"reasoning","id":"rs_<40hex>","summary":[],
  "content":null,"encrypted_content":""}}
{"...","type":"event_msg","payload":{"type":"item_completed","...","item":{"type":"Reasoning",
  "id":"rs_<40hex>","summary_text":[],"raw_content":[]},"completed_at_ms":<ms>}}

// 6) 工具调用 / 结果（Responses 层）+ 可选 Typed CommandExecution
{"...","type":"response_item","payload":{"type":"function_call","id":"fc_<40hex>","name":"bash",
  "arguments":"{\"command\":\"...\"}","call_id":"call_<...>","internal...":{"turn_id":"<uuid>"}}}
{"...","type":"event_msg","payload":{"type":"item_completed","...","item":{"type":"CommandExecution",
  "id":"exec-<uuid>","process_id":"0","command":["..."],"cwd":"file:///E:/session","parsed_cmd":[],
  "source":"unified_exec_startup","status":"completed","stdout":"","stderr":"","aggregated_output":"",
  "exit_code":0,"duration":{"secs":0,"nanos":0},"formatted_output":""}}}
{"...","type":"response_item","payload":{"type":"function_call_output","id":"fco_<40hex>",
  "call_id":"call_<...>","output":"<字符串>"}}

// 7) 每个 turn 收尾
{"...","type":"event_msg","payload":{"type":"task_complete","turn_id":"<uuid>",
  "last_agent_message":null,"started_at":<s>,"completed_at":<s>,"duration_ms":<n>}}
```

**额外必须做的处理**
1. `cwd` 归一化：`U.winCwd()` → `\\?\E:\session`。（`E:/session` 会导致 resume 列表里看不到）
2. **写 `state_5.sqlite.threads` 一行**（关键列）：
   `id, rollout_path, created_at, updated_at, source='cli', model_provider='openai', cwd(\\?\形式), title, sandbox_policy, approval_mode='never', tokens_used=0, has_user_event=0, archived=0, cli_version, first_user_message, memory_mode='enabled', model, reasoning_effort, created_at_ms, updated_at_ms, thread_source='user', preview, recency_at, recency_at_ms, history_mode='paginated', is_pinned=0, originator='codex-tui'`
3. 必须**重启 Codex**它才重扫；`thread_history` 投影在 resume/启动时**异步**完成。
4. 幂等：`INSERT OR IGNORE`，已存在不覆盖。

---

### 4.2 Pi

**文件**：`~/.pi/agent/sessions/<cwd编码>/<ts转义>_<uuidv7>.jsonl`
- cwd 编码：`"--" + cwd.replace(/[:\\/]/g,"-") + "--"`（如 `E:\session` → `--E--session--`）
- 文件名时间戳：ISO 里的 `:` 和 `.` → `-`（如 `2026-09-14T08-27-32-805Z`）

**必须记录**
```jsonc
// line 1：会话头
{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<ISO>","cwd":"E:\\session"}
// 模型
{"type":"model_change","id":"<8hex>","parentId":null,"timestamp":"<ISO>","provider":"openai","modelId":"gpt-5.6-sol"}
{"type":"thinking_level_change","id":"<8hex>","parentId":"<8hex>","timestamp":"<ISO>","thinkingLevel":"medium"}
// 用户消息
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"<ISO>",
 "message":{"role":"user","content":[{"type":"text","text":"..."}],"timestamp":<epoch毫秒>}}
// 助手消息（含 content parts）
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"<ISO>",
 "message":{"role":"assistant","content":[
    {"type":"thinking","thinking":"..."},
    {"type":"text","text":"..."},
    {"type":"toolCall","id":"call_<...>|fc_<...>","name":"bash","arguments":{...}},
    {"type":"image","data":"<base64>","mimeType":"image/png"}],
  "api":"openai-responses","provider":"openai","model":"gpt-5.6-sol",
  "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
           "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "stopReason":"stop","timestamp":<ms>}}
// 工具结果：独立消息，用 toolCallId 配对
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"<ISO>",
 "message":{"role":"toolResult","toolCallId":"call_<...>","toolName":"bash",
  "content":[{"type":"text","text":"<输出>"}],"isError":false,"timestamp":<ms>}}
```

**额外处理**
1. 每个非 session 记录都要有 **8-hex `id` + `parentId`**（第一条 `parentId:null`），构成链。
2. `toolResult` 不是 content block，是**独立 role 的消息**。
3. `message.timestamp` 是 **epoch 毫秒**，记录级 `timestamp` 是 ISO —— 两种都要写。
4. 读取/导出用 `pi --export <file> out.html`（只读）；resume 用 `pi --session <部分uuid>`（会写文件）。

---

### 4.3 Claude Code

**文件**：`~/.claude/projects/<净化cwd>/<uuidv4>.jsonl`
- 净化规则：`cwd.replace(/[^a-zA-Z0-9]/g,"-")`；长度 > 200 时取前 200 + `-` + `base36(abs(hash(cwd)))`。
  例：`E:\session` → `E--session`。

**必须记录（每条都带公共信封）**
```jsonc
{"parentUuid":<上一条uuid或null>,"isSidechain":false,"userType":"external",
 "cwd":"E:\\session","sessionId":"<uuidv4>","version":"2.1.270","gitBranch":"",
 "type":"user","uuid":"<uuid>","timestamp":"<ISO>"}   // ← 公共字段
```

```jsonc
// 用户
{"...公共...","type":"user","message":{"role":"user","content":"..."}}
// 助手（tool_use 在 content[] 里）
{"...公共...","type":"assistant","requestId":"req_<...>",
 "message":{"id":"msg_<...>","type":"message","role":"assistant","model":"<model>",
   "content":[{"type":"text","text":"..."},
              {"type":"tool_use","id":"toolu_<...>","name":"Read","input":{...}}],
   "stop_reason":"end_turn"}}
// 工具结果：塞进 role=user 的记录
{"...公共...","type":"user","message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_<...>",
    "content":[{"type":"text","text":"<输出>"}],"is_error":false}]}}
// 系统/摘要（可选）
{"...公共...","type":"system","subtype":"injected","content":"..."}
{"type":"summary","summary":"...","leafUuid":"<uuid>"}
```

**额外处理**
1. `uuid` + `parentUuid` 链，首条 `parentUuid:null`。
2. `tool_use` ↔ `tool_result` 用 `tool_use.id` / `tool_use_id` 配对。
3. 目录名**不可逆**，真实 cwd 存在每条记录的 `cwd` 字段里。
4. 读取/续用：`claude --resume <uuid>`、`--session-id <uuid>`、`--fork-session`。
5. 本机无 claude 登录态，未做它自己的 picker 验证。

---

### 4.4 OpenCode

**不直接写 SQLite**（避免锁/损坏），而是生成 import JSON 再 `opencode import <file>`：

```jsonc
{
  "info": {"id":"ses_<...>","slug":"imported-session","projectID":"global",
           "directory":"E:\\session","path":"session","title":"...","agent":"build",
           "model":{"id":"<model>","providerID":"imported"},"version":"1.18.30",
           "time":{"created":<ms>,"updated":<ms>}},
  "messages": [
    { "info": {"id":"msg_<...>","sessionID":"ses_<...>","role":"user",
               "agent":"build",                       // ★ 必须有，否则报 Missing key at ["agent"]
               "time":{"created":<ms>},"model":{"providerID":"imported","modelID":"..."},
               "summary":{"diffs":[]}},
      "parts": [ {"id":"prt_<...>","sessionID":"ses_<...>","messageID":"msg_<...>",
                  "type":"text","text":"..."} ] },
    { "info": {"id":"msg_<...>","sessionID":"ses_<...>","role":"assistant",
               "parentID":"msg_<...>",                 // ★ assistant 指回触发的 user
               "mode":"build","agent":"build",
               "path":{"cwd":"E:\\session","root":"/"},
               "cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
               "modelID":"...","providerID":"imported","finish":"stop",
               "time":{"created":<ms>}},
      "parts":[
        {"id":"prt_<...>","sessionID":"ses_<...>","messageID":"msg_<...>","type":"reasoning","text":"..."},
        {"id":"prt_<...>","sessionID":"ses_<...>","messageID":"msg_<...>","type":"text","text":"..."},
        {"id":"prt_<...>","sessionID":"ses_<...>","messageID":"msg_<...>","type":"tool","tool":"bash",
         "callID":"call_<...>","state":{"status":"completed","input":{...},"output":"..."}}
      ] }
  ]
}
```

**额外处理**
1. 每条 `message.info.agent` 必填（这是踩过的坑）。
2. 顶层 `info` 也需要 `agent`；assistant 消息要 `parentID`。
3. 导入命令：`opencode import <file>`；导出：`opencode export <id>`。
4. opencode 的 id 是 `ses_/msg_/prt_` + 12hex + 14 base62；时间反序，有 ~795 天回绕，**排序要用 `time_created` 不要用 id**。

---

## 5. 调试/验证命令清单

```powershell
# ---- 统一读取 ----
node src/cli.js list
node src/cli.js show <agent> <id> --format text|markdown|canonical

# ---- 注入 ----
node src/cli.js inject --from opencode:<id> --to codex  --mode native [--dry-run] [--no-register]
node src/cli.js inject --from codex:<id>    --to pi     --mode native
node src/cli.js inject --from pi:<id>       --to claude --mode native
node src/cli.js inject --from pi:<id>       --to opencode --out .\import.json
opencode import .\import.json

# ---- Codex 侧验证 ----
codex migrate-rollouts --json --thread <codex-id>          # 期望 status:"already_paginated"
codex exec resume <codex-id> "hi" --skip-git-repo-check --json   # 期望 {"type":"thread.started",...}
# 直接看 Codex 自己的历史投影（node:sqlite）
node -e "const{DatabaseSync}=require('node:sqlite');const os=require('os'),p=require('path');const d=new DatabaseSync(p.join(os.homedir(),'.codex','thread_history_1.sqlite'),{readOnly:true});for(const r of d.prepare('SELECT rollout_ordinal,item_type FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal').all('<codex-id>'))console.log(r)"
# 看 cwd 是否规范
node -e "const{DatabaseSync}=require('node:sqlite');const os=require('os'),p=require('path');const d=new DatabaseSync(p.join(os.homedir(),'.codex','state_5.sqlite'),{readOnly:true});console.log(d.prepare('SELECT cwd FROM threads WHERE id=?').get('<codex-id>'))"

# ---- Pi / OpenCode 侧验证 ----
pi --export "<pi-session.jsonl>" out.html
opencode export <ses_id>

# ---- 网页 / TUI ----
node src/cli.js web --port 8787     # http://127.0.0.1:8787/
node src/cli.js tui
```

---

## 6. 关键坑位（务必记住）

1. **Codex 历史 = typed 层**：`event_msg.item_completed`（UserMessage/AgentMessage/Reasoning/CommandExecution）+ `turn_context`/`task_started`/`task_complete` 缺一不可。只有 `response_item` 会 resume 出空对话。
2. **Codex cwd 必须 `\\?\E:\...`**：`codex resume` 选择器按 cwd 过滤，`E:/session` 会被过滤掉 → "列表里没有"。
3. **Codex 必须写 `state_5.threads`**：裸 rollout 文件会被忽略（`missing its SQLite metadata`）。
4. **Codex 投影异步 + 需重启**：注入完成后要重启 Codex，或首次 resume 后等几秒，`thread_history.thread_items` 才写进去。
5. **OpenCode import 必须带 `agent`**，否则 `Missing key at ["agent"]` 且会留下半成品 session（需 `opencode session delete` 清）。
6. **Pi 目录/文件名编码**：目录 `--..--`、文件名时间戳 `:`/`.`→`-`；`toolResult` 是独立消息。
7. **Claude 目录名不可逆**，cwd 必须从记录里读；`tool_result` 藏在 role=user 记录。
8. **时间戳三种单位**：Codex 文件名本地时间、payload UTC ISO；Pi 记录 ISO + message epoch 毫秒；opencode epoch 毫秒。别混用。
9. **加密 reasoning 不可移植**（Codex `encrypted_content`、Pi `thinkingSignature`），跨模型丢弃即可。
10. **有损**：单向可读可做，双向高保真 round-trip 不现实。

---

## 7. 代码索引

| 文件 | 作用 |
|---|---|
| `src/util.js` | 路径/ID/时间工具；`winCwd()`、`claudeProjectKey()`、`piSessionDirName()`、`piFileStamp()` |
| `src/adapters.js` | 四家读取 → IR |
| `src/render.js` | IR → text/markdown；`genCodex`/`genPi`/`genClaude`/`genOpenCodeImport` |
| `src/codex-register.js` | 写 `state_5.sqlite.threads` 元数据（幂等） |
| `src/inject.js` | native / context 两种注入模式，dry-run |
| `src/cli.js` | `list` / `show` / `roots` / `inject` / `tui` / `web` |
| `src/server.js` + `web/index.html` | 网页浏览 + 注入 + Verify |
| `src/tui.js` | 终端交互界面 |
