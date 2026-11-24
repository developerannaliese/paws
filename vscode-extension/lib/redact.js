'use strict';

// Local redaction: find personal and confidential data and swap it for
// placeholders like [EMAIL_1] before an AI tool sees it. Real values are kept
// in a vault on this machine (outside the repo) so AI edits that use the
// placeholders can be turned back into real values locally.
//
// Detectors are deterministic and run offline. Australian identifiers are
// checked with their official checksums to cut false positives. An optional
// local model (see local-model.js) can add names and addresses the patterns miss.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ALL_TYPES = ['secret', 'card', 'medicare', 'tfn', 'abn', 'bank', 'email', 'phone', 'address', 'dob', 'name'];

// ---------- checksums ----------

const digitsOf = (s) => String(s).replace(/\D/g, '');

function luhn(num) {
  const d = digitsOf(num);
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return d.length >= 13 && d.length <= 19 && sum % 10 === 0 && !/^(\d)\1+$/.test(d);
}

function validTfn(num) {
  const d = digitsOf(num);
  const w = d.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : d.length === 8 ? [10, 7, 8, 4, 6, 3, 5, 1] : null;
  if (!w || /^(\d)\1+$/.test(d)) return false;
  return w.reduce((s, wt, i) => s + wt * Number(d[i]), 0) % 11 === 0;
}

function validAbn(num) {
  const d = digitsOf(num);
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = w.reduce((s, wt, i) => s + wt * (Number(d[i]) - (i === 0 ? 1 : 0)), 0);
  return sum % 89 === 0;
}

function validMedicare(num) {
  const d = digitsOf(num);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[2-6]/.test(d)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9];
  const sum = w.reduce((s, wt, i) => s + wt * Number(d[i]), 0);
  return sum % 10 === Number(d[8]);
}

// ---------- detectors ----------

function near(text, index, words, window = 40) {
  const before = text.slice(Math.max(0, index - window), index).toLowerCase();
  return words.some((w) => before.includes(w));
}

const STREET = '(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Lane|Ln|Crescent|Cres|Parade|Pde|Highway|Hwy|Terrace|Tce|Boulevard|Blvd|Way|Close|Cl|Circuit|Cct|Grove|Gr)';
const STATES = '(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)';

// Each detector yields { start, end, type, label }.
const DETECTORS = [
  {
    type: 'secret', label: 'PRIVATE_KEY',
    find(text) {
      const marker = (k) => `-----${k} [A-Z ]*${'PRIVATE'} KEY-----`;
      return matches(text, new RegExp(`${marker('BEGIN')}[\\s\\S]*?${marker('END')}`, 'g'));
    },
  },
  {
    type: 'secret', label: 'SECRET',
    find(text) {
      const out = [];
      const tokens = [
        /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
        /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
        /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
        /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
        /\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}\b/g,
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      ];
      for (const re of tokens) out.push(...matches(text, re));
      // key = value assignments: redact only the value
      const assign = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|db[_-]?pass(?:word)?)\b["']?\s*[:=]\s*(["']?)([^\s"'`,;{}()<>]{6,})\1/dgi;
      let m;
      while ((m = assign.exec(text))) {
        const [s, e] = m.indices[2];
        if (/^(true|false|null|none|undefined|process\.env.*|\$\{.*|<.*>|\*+|x+|changeme)$/i.test(m[2])) continue;
        out.push({ start: s, end: e });
      }
      return out;
    },
  },
  {
    type: 'card', label: 'CARD',
    find(text) {
      return matches(text, /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g).filter((r) => {
        const raw = text.slice(r.start, r.end);
        const d = digitsOf(raw);
        if (!luhn(d)) return false;
        const formatted = /^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$/.test(raw);
        return formatted || near(text, r.start, ['card', 'visa', 'mastercard', 'amex', 'pan']) || (/^[3-6]/.test(d) && (d.length === 15 || d.length === 16) && !/[ -]/.test(raw));
      });
    },
  },
  {
    type: 'medicare', label: 'MEDICARE',
    find(text) {
      return matches(text, /(?<!\d)[2-6]\d{3}[ ]?\d{5}[ ]?\d(?:[ /-]?\d)?(?!\d)/g).filter((r) => {
        const raw = text.slice(r.start, r.end);
        return validMedicare(raw) && (/^\d{4} \d{5} \d/.test(raw) || near(text, r.start, ['medicare']));
      });
    },
  },
  {
    type: 'tfn', label: 'TFN',
    find(text) {
      return matches(text, /(?<![\d-])\d{3}[ -]?\d{3}[ -]?\d{2,3}(?![\d-])/g).filter((r) => {
        const raw = text.slice(r.start, r.end);
        return validTfn(raw) && (/^\d{3}([ -])\d{3}\1\d{3}$/.test(raw) || near(text, r.start, ['tfn', 'tax file', 'tax_file', 'taxfile']));
      });
    },
  },
  {
    type: 'abn', label: 'ABN',
    find(text) {
      return matches(text, /(?<!\d)\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}(?!\d)/g).filter((r) => {
        const raw = text.slice(r.start, r.end);
        return validAbn(raw) && (/^\d{2} \d{3} \d{3} \d{3}$/.test(raw) || near(text, r.start, ['abn']));
      });
    },
  },
  {
    type: 'bank', label: 'BSB',
    find(text) {
      return matches(text, /(?<![\d-])\d{3}-?\d{3}(?![\d-])/g).filter((r) => {
        const after = text.slice(r.end, r.end + 4);
        return near(text, r.start, ['bsb'], 25) || (/-/.test(text.slice(r.start, r.end)) && /^[ ,/]{1,3}\d{6,10}/.test(after + text.slice(r.end + 4, r.end + 14)));
      });
    },
  },
  {
    type: 'bank', label: 'ACCOUNT',
    find(text) {
      const out = [];
      const re = /\b(?:acc(?:ount)?|acct)[ _-]?(?:no|num(?:ber)?|#)?\b["']?\s*[:=#]?\s*["']?(\d{6,10})\b/dgi;
      let m;
      while ((m = re.exec(text))) out.push({ start: m.indices[1][0], end: m.indices[1][1] });
      // An account number written straight after a BSB: 062-000 12345678
      const pair = /(?<![\d-])\d{3}-\d{3}[ ,/]{1,3}(\d{6,10})(?!\d)/dg;
      while ((m = pair.exec(text))) out.push({ start: m.indices[1][0], end: m.indices[1][1] });
      return out;
    },
  },
  {
    type: 'email', label: 'EMAIL',
    find(text, opts) {
      const allow = (opts.allowEmails || []).map((s) => s.toLowerCase());
      return matches(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g).filter((r) => {
        const e = text.slice(r.start, r.end).toLowerCase();
        if (/@(example\.(com|org|net)|localhost|test\.com)$/.test(e)) return false;
        if (/^(noreply|no-reply)@/.test(e)) return false;
        return !allow.some((a) => e === a || e.endsWith('@' + a.replace(/^@/, '')));
      });
    },
  },
  {
    type: 'phone', label: 'PHONE',
    find(text) {
      return [
        ...matches(text, /(?<![\d+])(?:\+61[ -]?|0)4\d{2}[ -]?\d{3}[ -]?\d{3}(?!\d)/g),
        ...matches(text, /(?<![\d+])(?:\+61[ -]?|0)[2378][ -]?\d{4}[ -]?\d{4}(?!\d)/g),
        ...matches(text, /\(0[2378]\)[ ]?\d{4}[ -]?\d{4}(?!\d)/g),
      ];
    },
  },
  {
    type: 'address', label: 'ADDRESS',
    find(text) {
      const re = new RegExp(`\\b\\d{1,5}[A-Za-z]?(?:/\\d{1,5})?\\s+(?:[A-Z][a-z]+\\s){1,3}${STREET}\\b\\.?(?:,?\\s+[A-Z][A-Za-z]+(?:\\s[A-Z][A-Za-z]+)?)?(?:,?\\s+${STATES})?(?:,?\\s+\\d{4})?`, 'g');
      return matches(text, re);
    },
  },
  {
    type: 'dob', label: 'DOB',
    find(text) {
      const out = [];
      const re = /\b(?:dob|d\.o\.b\.?|date[ _]of[ _]birth|birth[ _]?date|birthday)\b["']?\s*[:=]?\s*["']?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/dgi;
      let m;
      while ((m = re.exec(text))) out.push({ start: m.indices[1][0], end: m.indices[1][1] });
      return out;
    },
  },
  {
    type: 'name', label: 'NAME',
    find(text) {
      const out = [];
      // Labels match in any case; the name itself must look like a capitalised name.
      const labels = ['full name', 'first name', 'last name', 'surname', 'given name', 'customer name', 'customer', 'client name', 'client', 'account holder', 'cardholder', 'patient', 'employee name']
        .map((l) => l.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`).replace(/ /g, '[ _]?'));
      const re = new RegExp(`\\b(?:${labels.join('|')})\\b["']?\\s*[:=]\\s*["']?([A-Z][a-z]+(?:[ '-][A-Z][a-z]+){0,3})`, 'dg');
      let m;
      while ((m = re.exec(text))) out.push({ start: m.indices[1][0], end: m.indices[1][1] });
      return out;
    },
  },
];

function matches(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Columns in CSV/TSV files whose header names say they hold personal data.
const SENSITIVE_COLUMNS = [
  [/^full[ _]?name$|^(first|last|given|middle|sur|customer|client|contact|patient|employee|member|person)[ _]?name$|^surname$|^customer$|^client$|^account[ _]?holder$|^cardholder$|^patient$/i, 'NAME', 'name'],
  [/e-?mail/i, 'EMAIL', 'email'],
  [/phone|mobile|^tel/i, 'PHONE', 'phone'],
  [/address|street|suburb/i, 'ADDRESS', 'address'],
  [/^dob$|birth/i, 'DOB', 'dob'],
  [/tfn|tax[ _]?file/i, 'TFN', 'tfn'],
  [/medicare/i, 'MEDICARE', 'medicare'],
  [/^bsb$/i, 'BSB', 'bank'],
  [/account[ _]?(no|num|number)$|^acc(t)?[ _]?(no|num)$/i, 'ACCOUNT', 'bank'],
  [/card[ _]?(no|num|number)?$|^pan$/i, 'CARD', 'card'],
];

function splitCsvLine(line, delim) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    let start = i;
    let end;
    if (line[i] === '"') {
      i++;
      while (i < line.length && !(line[i] === '"' && line[i + 1] !== '"')) i += line[i] === '"' ? 2 : 1;
      end = i + 1;
      i += 2;
      cells.push({ start: start + 1, end: end - 1 });
    } else {
      while (i < line.length && line[i] !== delim) i++;
      end = i;
      i++;
      cells.push({ start, end });
    }
  }
  return cells;
}

// Tables with a header row: any column whose header says it holds personal data is
// redacted in every row below it. Works on .csv/.tsv files and on tables inside
// any text (such as a file an AI tool read, with line numbers in front).
const LINE_PREFIX = /^(\s*\d+(?:\t|→|:\s|\|\s?))/;

function tableFindings(text, types, delimHint) {
  const out = [];
  const lines = text.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const cellsOf = (i, delim) => {
    const raw = lines[i].replace(/\r$/, '');
    const m = raw.match(LINE_PREFIX);
    const pre = m ? m[1].length : 0;
    const body = raw.slice(pre);
    return { pre, body, cells: splitCsvLine(body, delim) };
  };
  for (let i = 0; i < lines.length; i++) {
    for (const delim of delimHint ? [delimHint] : [',', '\t']) {
      const head = cellsOf(i, delim);
      if (head.cells.length < 2) continue;
      const names = head.cells.map((c) => head.body.slice(c.start, c.end).trim().replace(/^"|"$/g, '').toLowerCase());
      const cols = names.map((h) => SENSITIVE_COLUMNS.find(([re]) => re.test(h)) || null);
      if (!cols.some(Boolean)) continue;
      // Headers are short labels, not sentences.
      if (names.some((n) => n.length > 40 || /\s{2,}/.test(n))) continue;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const row = cellsOf(j, delim);
        if (row.cells.length !== head.cells.length) break;
        row.cells.forEach((c, ci) => {
          const col = cols[ci];
          if (!col || !types.includes(col[2])) return;
          const value = row.body.slice(c.start, c.end);
          if (!value.trim()) return;
          out.push({ start: starts[j] + row.pre + c.start, end: starts[j] + row.pre + c.end, type: col[2], label: col[1] });
        });
      }
      if (j > i + 1) {
        i = j - 1;
        break;
      }
    }
  }
  return out;
}

function csvFindings(text, filePath, types) {
  if (filePath && /\.tsv$/i.test(filePath)) return tableFindings(text, types, '\t');
  if (filePath && /\.csv$/i.test(filePath)) return tableFindings(text, types, ',');
  return tableFindings(text, types, null);
}

// ---------- vault ----------

function pawsHome(env = process.env) {
  return env.PAWS_HOME || process.env.PAWS_HOME || path.join(os.homedir(), '.paws');
}

function rootId(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

// ---------- realistic stand-ins ("fake" mode) ----------
// Stand-ins look real but are chosen so they aren't real people's details:
// identifiers fail their checksums, emails use example.com, card numbers fail
// the Luhn check, and phone numbers come from the ranges the regulator
// (ACMA) sets aside for fiction. Check the phone list against ACMA's current one.

const FIRST = ['Olivia', 'Liam', 'Charlotte', 'Noah', 'Amelia', 'Oliver', 'Isla', 'Jack', 'Mia', 'William', 'Ava', 'Henry', 'Grace', 'Leo', 'Chloe', 'Lucas', 'Zoe', 'Thomas', 'Ruby', 'James', 'Sophie', 'Ethan', 'Harper', 'Hugo'];
const LAST = ['Walker', 'Bennett', 'Hayes', 'Fletcher', 'Morgan', 'Sullivan', 'Reid', 'Carter', 'Brooks', 'Lawson', 'Pearce', 'Doyle', 'Hartley', 'Nolan', 'Whitford', 'Ashby', 'Kendall', 'Marsh', 'Rowe', 'Tanner', 'Ellison', 'Burke', 'Quinn'];
const FICTION_MOBILES = ['0491 570 006', '0491 570 156', '0491 570 157', '0491 570 158', '0491 570 159', '0491 570 110', '0491 570 313', '0491 570 737', '0491 571 266', '0491 571 491', '0491 571 804', '0491 572 549', '0491 572 665', '0491 572 983', '0491 573 770', '0491 573 087', '0491 574 118', '0491 574 632', '0491 575 254', '0491 575 789'];
const STREETS = ['Example Street', 'Sample Road', 'Placeholder Avenue', 'Fictional Lane', 'Demo Crescent', 'Test Parade'];

const pad = (n, w) => String(n).padStart(w, '0');
function spaced(d, groups) {
  const out = [];
  let i = 0;
  for (const g of groups) {
    out.push(d.slice(i, i + g));
    i += g;
  }
  return out.join(' ');
}

function failing(digits, isValid) {
  // Nudge the last digit until the number fails its checksum, so it can't be real.
  let d = digits;
  for (let k = 0; k < 10 && isValid(d); k++) d = d.slice(0, -1) + String((Number(d.slice(-1)) + 1) % 10);
  return d;
}

function fakeValue(label, n, original) {
  const name = `${FIRST[(n - 1) % FIRST.length]} ${LAST[((n - 1) * 7 + Math.floor((n - 1) / FIRST.length)) % LAST.length]}`;
  switch (label) {
    case 'NAME': return name;
    case 'EMAIL': return `${name.toLowerCase().replace(' ', '.')}${n > FIRST.length ? n : ''}@example.com`;
    case 'PHONE': {
      const mobile = /^(\+?61[ -]?)?0?4/.test(String(original).replace(/[()\s]/g, '')) || /^\+?61[ -]?4/.test(original) || /^04/.test(original);
      if (mobile && n <= FICTION_MOBILES.length) return FICTION_MOBILES[n - 1];
      return `(02) 5550 ${pad(4000 + n, 4)}`;
    }
    case 'TFN': return spaced(failing(`999${pad(n, 6)}`, validTfn), [3, 3, 3]);
    case 'ABN': return spaced(failing(`99${pad(n, 9)}`, validAbn), [2, 3, 3, 3]);
    case 'MEDICARE': return spaced(`1${pad(n, 9)}`, [4, 5, 1]);
    case 'CARD': return spaced(failing(`400000000000${pad(n, 4)}`, luhn), [4, 4, 4, 4]);
    case 'BSB': return `000-${pad(n, 3)}`;
    case 'ACCOUNT': return `000${pad(n, 5)}`;
    case 'ADDRESS': return `${n} ${STREETS[(n - 1) % STREETS.length]}, Sampleton NSW 2000`;
    case 'DOB': return `01/01/${1970 + (n % 30)}`;
    default: return null; // secrets, keys and confidential terms always get a placeholder
  }
}

// The vault: real value <-> stand-in for one repo. Kept in the encrypted local
// database (store.js) when Node has SQLite built in (Node 22.5+); otherwise in a
// private JSON file. Either way it lives on this machine only, outside the repo.

function assignStandIn(data, label, value, fake) {
  const counterKey = fake ? `fake:${label}` : label;
  let n = (data.counters[counterKey] || 0) + 1;
  let ph = fake ? fakeValue(label, n, value) : `[${label}_${n}]`;
  if (fake && ph === null) return null;
  while (Object.prototype.hasOwnProperty.call(data.byPlaceholder, ph)) {
    n++;
    ph = fake ? fakeValue(label, n, value) : `[${label}_${n}]`;
  }
  return { ph, n, counterKey };
}

function remember(data, key, ph, value, fake) {
  data.byKey[key] = ph;
  data.byPlaceholder[ph] = value;
  if (fake && !(data.fakes = data.fakes || []).includes(ph)) data.fakes.push(ph);
}

class FileVault {
  constructor(root, env) {
    this.root = path.resolve(root);
    this.file = path.join(pawsHome(env), 'vault', `${rootId(root)}.json`);
    this.data = { root: this.root, counters: {}, byKey: {}, byPlaceholder: {}, fakes: [] };
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      /* new vault */
    }
    this.dirty = false;
  }

  placeholderFor(label, value, mode = 'placeholder') {
    const fake = mode === 'fake';
    const key = `${label}\u0000${value}${fake ? '\u0000fake' : ''}`;
    if (this.data.byKey[key]) return this.data.byKey[key];
    const a = assignStandIn(this.data, label, value, fake);
    if (!a) return this.placeholderFor(label, value, 'placeholder');
    this.data.counters[a.counterKey] = a.n;
    remember(this.data, key, a.ph, value, fake);
    this.dirty = true;
    return a.ph;
  }

  valueOf(placeholder) {
    return Object.prototype.hasOwnProperty.call(this.data.byPlaceholder, placeholder) ? this.data.byPlaceholder[placeholder] : undefined;
  }

  refresh() {}

  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    this.dirty = false;
  }
}

class DbVault {
  constructor(root, env) {
    const store = require('./store');
    this.store = store;
    this.h = store.db(env);
    this.root = path.resolve(root);
    this.rid = rootId(root);
    this.file = this.h.file;
    this.data = { root: this.root, counters: {}, byKey: {}, byPlaceholder: {}, fakes: [] };
    this.lastId = 0;
    this.migrate(env);
    this.refresh();
  }

  // Load rows other processes added since we last looked.
  refresh() {
    const rows = this.h.conn.prepare('SELECT id, label, style, standin, secret FROM vault WHERE root_id = ? AND id > ? ORDER BY id').all(this.rid, this.lastId);
    for (const r of rows) {
      const value = this.store.decrypt(this.h.key, r.secret);
      const fake = r.style === 'fake';
      remember(this.data, `${r.label}\u0000${value}${fake ? '\u0000fake' : ''}`, r.standin, value, fake);
      this.lastId = r.id;
    }
    for (const c of this.h.conn.prepare('SELECT name, n FROM counters WHERE root_id = ?').all(this.rid)) this.data.counters[c.name] = c.n;
  }

  placeholderFor(label, value, mode = 'placeholder') {
    const fake = mode === 'fake';
    const key = `${label}\u0000${value}${fake ? '\u0000fake' : ''}`;
    if (this.data.byKey[key]) return this.data.byKey[key];
    const conn = this.h.conn;
    conn.exec('BEGIN IMMEDIATE');
    try {
      this.refresh();
      if (this.data.byKey[key]) {
        conn.exec('COMMIT');
        return this.data.byKey[key];
      }
      const a = assignStandIn(this.data, label, value, fake);
      if (!a) {
        conn.exec('COMMIT');
        return this.placeholderFor(label, value, 'placeholder');
      }
      conn
        .prepare('INSERT INTO vault (root_id, key_hash, label, style, standin, secret, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(this.rid, this.store.keyHash(this.h.key, key), label, fake ? 'fake' : 'placeholder', a.ph, this.store.encrypt(this.h.key, value), new Date().toISOString());
      conn.prepare('INSERT INTO counters (root_id, name, n) VALUES (?, ?, ?) ON CONFLICT (root_id, name) DO UPDATE SET n = excluded.n').run(this.rid, a.counterKey, a.n);
      conn.exec('COMMIT');
      this.refresh();
      return a.ph;
    } catch (e) {
      try {
        conn.exec('ROLLBACK');
      } catch (_) {
        /* already rolled back */
      }
      throw e;
    }
  }

  valueOf(placeholder) {
    if (!Object.prototype.hasOwnProperty.call(this.data.byPlaceholder, placeholder)) this.refresh();
    return Object.prototype.hasOwnProperty.call(this.data.byPlaceholder, placeholder) ? this.data.byPlaceholder[placeholder] : undefined;
  }

  save() {} // every new stand-in is written straight away

  // Move an older plain JSON vault into the encrypted database, then delete it.
  migrate(env) {
    const old = path.join(pawsHome(env), 'vault', `${this.rid}.json`);
    if (!fs.existsSync(old)) return;
    try {
      const data = JSON.parse(fs.readFileSync(old, 'utf8'));
      const conn = this.h.conn;
      conn.exec('BEGIN IMMEDIATE');
      for (const [key, ph] of Object.entries(data.byKey || {})) {
        const [label, value, fake] = key.split('\u0000');
        conn
          .prepare('INSERT OR IGNORE INTO vault (root_id, key_hash, label, style, standin, secret, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(this.rid, this.store.keyHash(this.h.key, key), label, fake === 'fake' ? 'fake' : 'placeholder', ph, this.store.encrypt(this.h.key, value), new Date().toISOString());
      }
      for (const [name, n] of Object.entries(data.counters || {})) {
        conn.prepare('INSERT INTO counters (root_id, name, n) VALUES (?, ?, ?) ON CONFLICT (root_id, name) DO UPDATE SET n = MAX(n, excluded.n)').run(this.rid, name, n);
      }
      conn.exec('COMMIT');
      fs.unlinkSync(old);
    } catch (e) {
      /* leave the old file; it will be tried again */
    }
  }
}

function Vault(root, env) {
  return require('./store').available() && !(env && env.PAWS_STORE === 'files') ? new DbVault(root, env) : new FileVault(root, env);
}

// ---------- redact and restore ----------

function findAll(text, opts = {}) {
  const types = opts.types || ALL_TYPES;
  let found = [];
  DETECTORS.forEach((det, priority) => {
    if (!types.includes(det.type)) return;
    for (const r of det.find(text, opts)) found.push({ ...r, type: det.type, label: det.label, priority });
  });
  for (const r of csvFindings(text, opts.filePath, types)) found.push({ ...r, priority: 50 });
  // Custom labels from .paws.yml redact.custom
  for (const custom of opts.custom || []) {
    if (custom.pattern) {
      try {
        const re = new RegExp(custom.pattern, 'g');
        for (const r of matches(text, re)) {
          if (custom.near && !near(text, r.start, custom.near, 60)) continue;
          found.push({ ...r, type: 'custom', label: custom.label, priority: 45 });
        }
      } catch (e) { /* invalid regex, skip */ }
    }
    // Custom CSV columns
    if (custom.columns) {
      for (const col of custom.columns) {
        SENSITIVE_COLUMNS.push([new RegExp(`^${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), custom.label, 'custom']);
      }
    }
  }
  for (const extra of opts.extraFindings || []) found.push({ priority: 60, ...extra });
  // Anything already in the vault is sensitive wherever it turns up again, even in
  // a plain sentence no detector would flag (for example the AI's own earlier reply).
  if (opts.vault) {
    for (const key of Object.keys(opts.vault.data.byKey || {})) {
      const [label, value] = key.split('\u0000');
      if (!value || value.length < 3) continue;
      let i = text.indexOf(value);
      while (i !== -1) {
        found.push({ start: i, end: i + value.length, type: label.toLowerCase(), label, priority: -1 });
        i = text.indexOf(value, i + value.length);
      }
    }
  }
  // Resolve overlaps: earlier detectors win, then longer matches.
  found.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
  const kept = [];
  for (const f of found) {
    if (f.end <= f.start) continue;
    const last = kept[kept.length - 1];
    if (last && f.start < last.end) {
      if (f.priority < last.priority || (f.priority === last.priority && f.end - f.start > last.end - last.start)) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }
  return kept;
}

// Confidence: how sure Paws is that this is real personal data.
//  - "high": checksum-validated (TFN, ABN, Medicare, card) or structured (CSV column, vault match)
//  - "medium": pattern-matched without checksum (email, phone, address, secret, labelled name)
//  - "low": from local model only (names in free text, loose addresses)
const HIGH_CONFIDENCE = new Set(['card', 'medicare', 'tfn', 'abn']);
function confidence(f) {
  if (f.priority === -1) return 'high'; // vault match: we've seen this value before
  if (f.priority === 50) return 'high'; // CSV column: header says it's PII
  if (f.priority === 60) return 'low';  // local model finding
  if (HIGH_CONFIDENCE.has(f.type)) return 'high';
  if (f.type === 'secret') return 'high';
  return 'medium';
}

function redactText(text, opts = {}) {
  const vault = opts.vault;
  const confirm = opts.confirm;
  // Never redact a stand-in again: text the AI already saw may pass through twice.
  const allFindings = findAll(text, opts).filter((f) => !(vault && vault.valueOf(text.slice(f.start, f.end)) !== undefined));

  // When confirm mode is on, split findings into auto-redact (high/medium) and needs-confirm (low).
  const findings = [];
  const uncertain = [];
  for (const f of allFindings) {
    const conf = confidence(f);
    f.confidence = conf;
    if (confirm && conf === 'low') uncertain.push(f);
    else findings.push(f);
  }

  let out = '';
  let pos = 0;
  const summary = {};
  const standins = [];
  for (const f of findings) {
    const value = text.slice(f.start, f.end);
    const mode = opts.mode === 'fake' ? 'fake' : 'placeholder';
    let ph;
    if (vault) ph = vault.placeholderFor(f.label, value, mode);
    else ph = (mode === 'fake' && fakeValue(f.label, 1, value)) || `[${f.label}]`;
    // Keep line numbers stable when a value spans lines (private keys).
    const newlines = (value.match(/\n/g) || []).length;
    out += text.slice(pos, f.start) + ph + '\n'.repeat(newlines);
    pos = f.end;
    summary[f.label] = (summary[f.label] || 0) + 1;
    if (!standins.includes(ph)) standins.push(ph);
  }
  out += text.slice(pos);
  return { text: out, count: findings.length, summary, standins, uncertain };
}

const PLACEHOLDER = /\[([A-Z_]+)_(\d+)\]/g;

function restoreText(text, vault) {
  let restored = 0;
  let out = String(text).replace(PLACEHOLDER, (ph) => {
    const v = vault.valueOf(ph);
    if (v === undefined) return ph;
    restored++;
    return v;
  });
  // Realistic stand-ins: longest first so "Olivia Walker" wins over shorter ones.
  const fakes = [...(vault.data.fakes || [])].sort((a, b) => b.length - a.length);
  for (const f of fakes) {
    if (!out.includes(f)) continue;
    const parts = out.split(f);
    restored += parts.length - 1;
    out = parts.join(vault.valueOf(f));
  }
  return { text: out, restored };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

module.exports = {
  ALL_TYPES, DETECTORS, Vault, FileVault, DbVault, pawsHome, rootId,
  findAll, redactText, restoreText, looksBinary, fakeValue,
  luhn, validTfn, validAbn, validMedicare,
};
