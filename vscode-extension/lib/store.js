'use strict';

// The local database: one SQLite file on this machine (~/.paws/paws.db),
// using the SQLite built into Node, so nothing extra is installed and nothing is
// hosted anywhere.
//
//  - vault:   real value <-> stand-in. Real values are encrypted (AES-256-GCM)
//             with a key kept on this machine; lookups use a keyed hash, so the
//             file never holds a readable real value.
//  - events:  what Paws did (counts, file names, sessions), never values.
//
// Several processes (Claude Code hooks, the local agent, the pop-up) share it
// safely: writes happen inside transactions and readers pick up new rows.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sqliteModule;
function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite prints an "experimental" notice; keep hooks quiet
  try {
    sqliteModule = require('node:sqlite');
  } catch (e) {
    sqliteModule = null;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

function available() {
  return Boolean(sqlite());
}

const open = new Map();

function homeDir(env) {
  const os = require('os');
  return (env && env.PAWS_HOME) || process.env.PAWS_HOME || path.join(os.homedir(), '.paws');
}

function loadKey(home, env) {
  const fromEnv = (env && env.PAWS_KEY) || process.env.PAWS_KEY;
  if (fromEnv) return Buffer.from(fromEnv, 'hex');
  const file = path.join(home, 'key');
  try {
    return fs.readFileSync(file);
  } catch (e) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    return fs.readFileSync(file);
  }
}

function db(env) {
  const home = homeDir(env);
  if (open.has(home)) return open.get(home);
  const mod = sqlite();
  if (!mod) return null;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'paws.db');
  const isNew = !fs.existsSync(file);
  const conn = new mod.DatabaseSync(file);
  if (isNew) fs.chmodSync(file, 0o600);
  conn.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS vault (
      id INTEGER PRIMARY KEY, root_id TEXT NOT NULL, key_hash TEXT NOT NULL, label TEXT NOT NULL,
      style TEXT NOT NULL, standin TEXT NOT NULL, secret TEXT NOT NULL, created TEXT NOT NULL,
      UNIQUE (root_id, key_hash), UNIQUE (root_id, standin));
    CREATE TABLE IF NOT EXISTS counters (root_id TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (root_id, name));
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, ts TEXT NOT NULL, root TEXT NOT NULL, session TEXT, agent TEXT, tool TEXT,
      event TEXT NOT NULL, path TEXT, found TEXT, count INTEGER);
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
  `);
  const handle = { conn, file, key: loadKey(home, env), home };
  open.set(home, handle);
  return handle;
}

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(key, blob) {
  const raw = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

function keyHash(key, s) {
  return crypto.createHmac('sha256', key).update(s).digest('hex');
}

// Record what happened (no values) so the pop-up can show activity across repos.
function recordEvent(root, e, env) {
  const h = db(env);
  if (!h) return;
  h.conn
    .prepare('INSERT INTO events (ts, root, session, agent, tool, event, path, found, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.ts || new Date().toISOString(), root, e.session || null, e.agent || null, e.tool || null, e.event, e.path || null, e.found ? JSON.stringify(e.found) : null, e.count || null);
}

function recentEvents({ sinceId = 0, limit = 200 } = {}, env) {
  const h = db(env);
  if (!h) return [];
  return h.conn
    .prepare('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?')
    .all(sinceId, limit)
    .map((r) => ({ ...r, found: r.found ? JSON.parse(r.found) : null }));
}

function clearSession(sessionId, env) {
  const h = db(env);
  if (!h) return 0;
  const info = h.conn.prepare('DELETE FROM events WHERE session = ?').run(sessionId);
  return info.changes;
}

function clearOlderThan(days, env) {
  const h = db(env);
  if (!h) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const info = h.conn.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  return info.changes;
}

function clearVault(rootId, env) {
  const h = db(env);
  if (!h) return 0;
  const v = h.conn.prepare('DELETE FROM vault WHERE root_id = ?').run(rootId);
  const c = h.conn.prepare('DELETE FROM counters WHERE root_id = ?').run(rootId);
  return v.changes + c.changes;
}

function listSessions(env) {
  const h = db(env);
  if (!h) return [];
  return h.conn.prepare(`
    SELECT session, root, MIN(ts) as started, MAX(ts) as last_active, COUNT(*) as events
    FROM events WHERE session IS NOT NULL
    GROUP BY session ORDER BY last_active DESC LIMIT 50
  `).all();
}

module.exports = { available, db, encrypt, decrypt, keyHash, recordEvent, recentEvents, homeDir, clearSession, clearOlderThan, clearVault, listSessions };
