'use strict';

// A hash-chained, append-only log of AI edit decisions (.aiguard/ledger.jsonl).
// Each entry stores the hash of the one before it, so changing, removing or
// reordering any past entry breaks every hash after it.
// This makes tampering evident; it doesn't stop someone rebuilding the whole
// chain. A hosted version would anchor checkpoints with a third party.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_REL = '.aiguard/ledger.jsonl';
const GENESIS = 'genesis';

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hashEntry(entry) {
  const { hash, ...rest } = entry;
  return sha256(JSON.stringify(rest));
}

function parseLedger(text) {
  const entries = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      entries.push({ __unreadable: true, line: i + 1 });
    }
  });
  return entries;
}

function readLedger(root) {
  const file = path.join(root, LEDGER_REL);
  if (!fs.existsSync(file)) return [];
  return parseLedger(fs.readFileSync(file, 'utf8'));
}

function verifyEntries(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.__unreadable) return { ok: false, count: entries.length, brokenAt: i + 1, reason: `entry ${i + 1} isn't valid JSON` };
    if (e.prev !== prev) return { ok: false, count: entries.length, brokenAt: i + 1, reason: `entry ${i + 1} doesn't follow entry ${i}` };
    if (hashEntry(e) !== e.hash) return { ok: false, count: entries.length, brokenAt: i + 1, reason: `entry ${i + 1} was changed after it was written` };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

function appendEntry(root, fields) {
  const file = path.join(root, LEDGER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readLedger(root);
  const last = existing[existing.length - 1];
  const prev = last && last.hash ? last.hash : GENESIS;
  const entry = { v: 1, ts: new Date().toISOString(), ...fields, prev };
  entry.hash = hashEntry(entry);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

module.exports = { LEDGER_REL, GENESIS, sha256, hashEntry, parseLedger, readLedger, verifyEntries, appendEntry };
