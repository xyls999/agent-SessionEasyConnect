'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const adapters = require('./adapters');
const injector = require('./inject');
const U = require('./util');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function verify(target, sid, file) {
  try {
    if (target === 'codex') {
      const r = spawnSync('codex', ['migrate-rollouts', '--json', '--thread', sid], { shell: true, encoding: 'utf8', timeout: 60000 });
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      return { ok: out.includes(sid), cmd: `codex migrate-rollouts --json --thread ${sid}`, output: out.slice(0, 4000) };
    }
    if (target === 'pi') {
      const tmp = path.join(require('os').tmpdir(), `asb-verify-${sid}.html`);
      const r = spawnSync('pi', ['--export', file, tmp], { shell: true, encoding: 'utf8', timeout: 60000 });
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      return { ok: fs.existsSync(tmp) && fs.statSync(tmp).size > 0, cmd: `pi --export "${file}" <tmp.html>`, output: out || `html bytes=${fs.existsSync(tmp) ? fs.statSync(tmp).size : 0}` };
    }
    if (target === 'opencode') {
      const r = spawnSync('opencode', ['export', sid], { shell: true, encoding: 'utf8', timeout: 60000 });
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      return { ok: out.includes(sid), cmd: `opencode export ${sid}`, output: out.slice(0, 4000) };
    }
    return { ok: true, cmd: '(none)', output: `Wrote ${target} native session file: ${file}` };
  } catch (e) {
    return { ok: false, cmd: '', output: String(e.message || e) };
  }
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(__dirname, '..', 'web', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
      return;
    }
    if (req.method === 'GET' && p === '/api/roots') return sendJson(res, 200, U.roots());
    if (req.method === 'GET' && p === '/api/sessions') {
      return sendJson(res, 200, { roots: U.roots(), sessions: adapters.listAll(url.searchParams.get('agent') || undefined) });
    }
    if (req.method === 'GET' && p === '/api/session') {
      const agent = url.searchParams.get('agent');
      const id = url.searchParams.get('id');
      return sendJson(res, 200, adapters.read(agent, id));
    }
    if (req.method === 'POST' && p === '/api/inject') {
      return readBody(req).then((b) => {
        const r = injector.inject({ fromAgent: b.fromAgent, fromId: b.fromId, to: b.to, mode: b.mode, cwd: b.cwd, dryRun: !!b.dryRun });
        sendJson(res, 200, r);
      });
    }
    if (req.method === 'POST' && p === '/api/verify') {
      return readBody(req).then((b) => sendJson(res, 200, verify(b.to, b.sid, b.file)));
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
}

function start(port) {
  const server = http.createServer(handler);
  server.listen(port, '127.0.0.1', () => {
    console.log(`agent-session-bus web UI  ->  http://127.0.0.1:${port}/`);
    console.log('Press Ctrl+C to stop.');
  });
  return server;
}

module.exports = { start, handler };

if (require.main === module) start(Number(process.argv[2]) || 8787);
