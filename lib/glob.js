'use strict';

// Minimal gitignore-style glob matching, no dependencies.
//   *   any characters except "/"
//   **  any characters including "/"
//   ?   one character except "/"
// A pattern with no "/" matches at any depth (like .gitignore).
// A pattern ending in "/" or "/**" also matches the folder itself.

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function normalisePath(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const cache = new Map();

function compile(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let p = String(pattern).trim().replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  const anchored = p.includes('/');
  const bases = anchored ? [p] : [p, '**/' + p];
  const regs = [];
  for (const b of bases) {
    regs.push(globToRegExp(b));
    // "dir/**" should also match "dir"; "dir" should also match everything inside it.
    if (b.endsWith('/**')) regs.push(globToRegExp(b.slice(0, -3)));
    else regs.push(globToRegExp(b + '/**'));
  }
  cache.set(pattern, regs);
  return regs;
}

function matchPath(pattern, relPath) {
  const rel = normalisePath(relPath);
  if (!rel || rel.startsWith('../') || rel === '..') return false;
  return compile(pattern).some((r) => r.test(rel));
}

module.exports = { globToRegExp, matchPath, normalisePath };
