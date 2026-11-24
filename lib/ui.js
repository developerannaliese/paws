'use strict';

// Session view data, shared by the editor pop-up and `pawsoff ui`.
// Everything is read on this machine, on demand (the edit log in the repo and the local database),
// the edit log in the repo (.pawsoff/ledger.jsonl) and the private vault in
// ~/.pawsoff. Activity is grouped by AI session.

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { loadPolicy } = require('./policy');
const ledger = require('./ledger');
const redact = require('./redact');
const { page } = require('./ui-page');

function mask(value) {
  const v = String(value);
  if (v.length <= 2) return '••';
  return v[0] + '•'.repeat(Math.min(8, Math.max(2, v.length - 2))) + v[v.length - 1];
}

function emptyStats() {
  return { replaced: 0, readsBlocked: 0, editsBlocked: 0, asked: 0, restored: 0, flagged: 0 };
}

function addEvent(stats, e) {
  if (e.event === 'redacted' || e.event === 'gateway_redacted') {
    for (const n of Object.values(e.found || {})) stats.replaced += n;
  }
  if (e.event === 'read_blocked') stats.readsBlocked++;
  if (e.event === 'blocked') stats.editsBlocked++;
  if (e.event === 'asked') stats.asked++;
  if (e.event === 'warned') stats.flagged++;
  if (e.event === 'restored' || e.event === 'gateway_restored') stats.restored += e.count || 0;
}

function buildState(root, env) {
  let policy = null;
  let policyError = null;
  try {
    policy = loadPolicy(root);
  } catch (e) {
    policyError = e.message;
  }
  const base = policy ? policy.root : path.resolve(root);
  const entries = ledger.readLedger(base);
  const integrity = ledger.verifyEntries(entries);

  // Stand-in -> what it replaced, from the private vault. Real values stay masked.
  const vault = new redact.Vault(base, env);
  const lookup = new Map();
  for (const [key, standIn] of Object.entries(vault.data.byKey || {})) {
    const [label, value, fake] = key.split('\u0000');
    lookup.set(standIn, {
      label,
      standIn,
      style: fake === 'fake' ? 'fake' : 'placeholder',
      masked: label === 'PRIVATE_KEY' || label === 'SECRET' ? '••••••••' : mask(value),
    });
  }

  const sessions = new Map();
  const totals = emptyStats();
  for (const e of entries) {
    const id = e.session || 'none';
    if (!sessions.has(id)) {
      sessions.set(id, { id, start: e.ts, end: e.ts, stats: emptyStats(), files: new Set(), viaAgent: false, events: [], standins: new Map() });
    }
    const s = sessions.get(id);
    s.end = e.ts;
    addEvent(s.stats, e);
    addEvent(totals, e);
    if (e.path && !e.path.startsWith('/v1/')) s.files.add(e.path);
    if (e.agent === 'gateway') s.viaAgent = true;
    for (const st of e.standins || []) {
      if (!s.standins.has(st)) s.standins.set(st, new Set());
      if (e.path && !e.path.startsWith('/v1/')) s.standins.get(st).add(e.path);
    }
    s.events.push({ ts: e.ts, event: e.event, path: e.path && !e.path.startsWith('/v1/') ? e.path : null, tool: e.tool || null, found: e.found || null, count: e.count || null, rules: e.rules || null });
  }

  const list = [...sessions.values()]
    .sort((a, b) => String(b.end).localeCompare(String(a.end)))
    .map((s) => ({
      id: s.id,
      short: s.id === 'none' ? 'Outside a session' : s.id.slice(0, 8),
      start: s.start,
      end: s.end,
      viaAgent: s.viaAgent,
      stats: s.stats,
      files: [...s.files],
      events: s.events.slice(-300).reverse(),
      mapping: [...s.standins.entries()].map(([st, files]) => ({ ...(lookup.get(st) || { label: 'UNKNOWN', standIn: st, masked: '?' }), seenIn: [...files] })),
    }));

  return {
    repo: path.basename(base),
    root: base,
    generatedAt: new Date().toISOString(),
    policy: policy
      ? {
          file: path.basename(policy.file),
          redact: policy.redact,
          rules: policy.rules.filter((r) => !r.builtIn).map((r) => ({ path: r.path, ai_read: r.ai_read, ai_edit: r.ai_edit, reviewers: r.reviewers, reason: r.reason })),
        }
      : null,
    policyError,
    log: { intact: integrity.ok, entries: entries.length, reason: integrity.reason || null, head: integrity.head || null },
    totals,
    sessions: list,
  };
}

// Look up one real value, only when someone asks for it.
function reveal(root, standIn, env) {
  const policy = loadPolicy(root);
  const vault = new redact.Vault(policy ? policy.root : root, env);
  return vault.valueOf(standIn);
}

function startServer({ root, port = 4477, env = process.env } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const okHost = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(h || ''));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const given = req.headers['x-pawsoff-token'] || url.searchParams.get('t');
    // Refuse other hosts (DNS rebinding) and anyone without this launch's token.
    if (!okHost(req.headers.host) || given !== token) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('PawsOff: open the link printed in your terminal.');
      return;
    }
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.method === 'GET' && url.pathname === '/') return send(200, page({ token }), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') {
      try {
        return send(200, buildState(root, env));
      } catch (e) {
        return send(500, { error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { standIn } = JSON.parse(body || '{}');
          const value = reveal(root, standIn, env);
          if (value === undefined) return send(404, { error: 'Not in the vault' });
          return send(200, { standIn, value });
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
      return;
    }
    send(404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, token, url: `http://127.0.0.1:${actual}/?t=${token}` });
    });
  });
}

module.exports = { startServer, buildState, reveal, mask };
