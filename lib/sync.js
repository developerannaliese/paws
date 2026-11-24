'use strict';

// Push hidden-file rules into each AI tool's own ignore settings, so tools
// that PawsOff can't hook into still keep those files out of the AI's view.
// File names follow each tool's documentation at the time of writing; check
// them against the current docs for the tools your team uses.

const fs = require('fs');
const path = require('path');
const { hiddenRules } = require('./policy');

const START = '# >>> pawsoff: managed block, edit .pawsoff.yml instead >>>';
const END = '# <<< pawsoff <<<';

const IGNORE_FILES = [
  { file: '.cursorignore', tool: 'Cursor' },
  { file: '.codeiumignore', tool: 'Windsurf' },
  { file: '.aiexclude', tool: 'Gemini Code Assist' },
  { file: '.aiderignore', tool: 'Aider' },
];

function writeManagedBlock(file, lines) {
  const block = [START, ...lines, END].join('\n');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (re.test(text)) text = text.replace(re, block);
  else text = (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '\n' : '') + block + '\n';
  fs.writeFileSync(file, text);
}

function claudeReadRule(pattern) {
  let p = pattern.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  if (p.startsWith('**/') || p.includes('/')) return `Read(./${p.replace(/^\.\//, '')})`;
  return `Read(./**/${p})`;
}

function syncClaude(root, patterns) {
  const file = path.join(root, '.claude', 'settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  settings.permissions = settings.permissions || {};
  const deny = (settings.permissions.deny = settings.permissions.deny || []);
  for (const p of patterns) {
    const rule = claudeReadRule(p);
    if (!deny.includes(rule)) deny.push(rule);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function sync(policy) {
  const patterns = [...new Set(hiddenRules(policy).map((r) => r.path))];
  const written = [];
  for (const { file, tool } of IGNORE_FILES) {
    writeManagedBlock(path.join(policy.root, file), patterns);
    written.push({ file, tool });
  }
  written.push({ file: path.relative(policy.root, syncClaude(policy.root, patterns)), tool: 'Claude Code (permissions.deny)' });
  const copilot = patterns.length
    ? ['GitHub Copilot content exclusion is set in GitHub, not in a file. Paste these paths into the repository\'s Settings > Copilot > Content exclusion:', ...patterns.map((p) => `  - "${p.startsWith('/') || p.startsWith('**') ? p : '/' + p}"`)].join('\n')
    : '';
  return { patterns, written, copilot };
}

module.exports = { sync, claudeReadRule, writeManagedBlock, IGNORE_FILES };
