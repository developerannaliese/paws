'use strict';

// A small parser for the subset of YAML that .pawsoff.yml uses:
// top-level keys, scalar values, lists of scalars, and lists of flat maps.
// JSON is accepted too. No dependencies.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if ((s[0] === '"' && s.endsWith('"') && s.length > 1) || (s[0] === "'" && s.endsWith("'") && s.length > 1)) {
    return s.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => parseScalar(x));
  }
  return s;
}

const KEY = /^([A-Za-z0-9_\-]+):(?:\s+(.*)|\s*)$/;

function parseYaml(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const root = {};
  let curKey = null;
  let curItem = null;
  let itemIndent = -1;
  const lines = String(text).split(/\r?\n/);

  lines.forEach((original, idx) => {
    const line = stripComment(original).replace(/\s+$/, '');
    if (!line.trim()) return;
    if (/^\t/.test(line)) throw new Error(`Line ${idx + 1}: use spaces, not tabs`);
    const indent = line.match(/^ */)[0].length;
    const t = line.trim();

    if (indent === 0) {
      const m = t.match(KEY);
      if (!m) throw new Error(`Line ${idx + 1}: expected "key: value", got "${t}"`);
      curKey = m[1];
      curItem = null;
      root[curKey] = m[2] === undefined || m[2] === '' ? null : parseScalar(m[2]);
      return;
    }
    if (curKey === null) throw new Error(`Line ${idx + 1}: indented line before any key`);

    if (t === '-' || t.startsWith('- ')) {
      if (!Array.isArray(root[curKey])) root[curKey] = [];
      const rest = t.slice(1).trim();
      const kv = rest.match(KEY);
      if (kv && !/^["']/.test(rest)) {
        curItem = {};
        curItem[kv[1]] = kv[2] === undefined ? null : parseScalar(kv[2]);
        root[curKey].push(curItem);
        itemIndent = indent;
      } else {
        curItem = null;
        root[curKey].push(parseScalar(rest));
      }
      return;
    }

    const kv = t.match(KEY);
    if (kv) {
      const value = kv[2] === undefined ? null : parseScalar(kv[2]);
      if (curItem && indent > itemIndent) {
        curItem[kv[1]] = value;
      } else {
        if (root[curKey] === null || typeof root[curKey] !== 'object' || Array.isArray(root[curKey])) {
          root[curKey] = {};
        }
        root[curKey][kv[1]] = value;
      }
      return;
    }
    throw new Error(`Line ${idx + 1}: can't read "${t}"`);
  });

  return root;
}

// Write a policy object back to YAML. Minimal but correct for .pawsoff.yml.
function writeYaml(obj) {
  const lines = [];
  const scalar = (v) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string' && /^[\w./*-]+$/.test(v)) return v;
    return JSON.stringify(v);
  };
  const inlineArray = (arr) => '[' + arr.map(scalar).join(', ') + ']';

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item);
          if (entries.length) {
            lines.push(`  - ${entries[0][0]}: ${scalar(entries[0][1])}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${scalar(entries[i][1])}`);
            }
          }
        } else {
          lines.push(`  - ${scalar(item)}`);
        }
      }
    } else if (val && typeof val === 'object') {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(val)) {
        if (Array.isArray(v)) lines.push(`  ${k}: ${inlineArray(v)}`);
        else lines.push(`  ${k}: ${scalar(v)}`);
      }
    } else {
      lines.push(`${key}: ${scalar(val)}`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { parseYaml, parseScalar, writeYaml };
