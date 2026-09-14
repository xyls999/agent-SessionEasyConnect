'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

// Codex only discovers sessions it knows about in <CODEX_HOME>/state_5.sqlite (table `threads`).
// A bare rollout file is ignored until Codex's own scan runs, so we register the metadata row
// ourselves (idempotent, additive) to make the injected session appear in Codex's thread list.
function registerCodex(sid, file, ir) {
  const codexHome = U.roots().codex;
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(dbPath)) return { ok: false, reason: 'state_5.sqlite not found' };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { ok: false, reason: 'node:sqlite unavailable' }; }

  const db = new DatabaseSync(dbPath);
  try {
    const existing = db.prepare('SELECT id FROM threads WHERE id=?').get(sid);
    if (existing) return { ok: true, already: true };
    const firstUser = (ir.messages || []).find((m) => m.role === 'user');
    const firstText = firstUser
      ? (firstUser.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 400)
      : '';
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    db.prepare(
      `INSERT OR IGNORE INTO threads
       (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode,
        tokens_used, has_user_event, archived, cli_version, first_user_message, memory_mode, model, reasoning_effort,
        created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode, is_pinned, originator)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      sid, file, nowS, nowS, 'cli', 'openai', U.winCwd(ir.cwd || process.cwd()), firstText.slice(0, 60),
      JSON.stringify({ type: 'danger-full-access' }), 'never', 0, 0, 0, '0.154.0', firstText, 'enabled',
      ir.model || 'gpt-5', 'high', nowMs, nowMs, 'user', firstText, nowS, nowMs, 'paginated', 0, 'codex-tui'
    );
    return { ok: true, inserted: true };
  } finally {
    db.close();
  }
}

module.exports = { registerCodex };
