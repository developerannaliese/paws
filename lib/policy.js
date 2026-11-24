'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseYaml } = require('./yaml');
const { matchPath, normalisePath } = require('./glob');

const POLICY_FILES = ['.pawsoff.yml', '.pawsoff.yaml', '.pawsoff.json'];
const ACTIONS = ['allow', 'warn', 'review', 'block'];
const READ_ACTIONS = ['allow', 'redact', 'block'];
const REDACT_TYPES = ['secret', 'card', 'medicare', 'tfn', 'abn', 'bank', 'email', 'phone', 'address', 'dob', 'name'];
const RANK = { allow: 0, warn: 1, review: 2, block: 3 };

// The guard always protects itself: an AI agent must not be able to weaken
// its own rules or rewrite the edit log.
const BUILT_IN_RULES = [
  { path: '.pawsoff.yml', ai_edit: 'block', reason: 'The PawsOff policy can only be changed by a human', builtIn: true },
  { path: '.pawsoff.yaml', ai_edit: 'block', reason: 'The PawsOff policy can only be changed by a human', builtIn: true },
  { path: '.pawsoff.json', ai_edit: 'block', reason: 'The PawsOff policy can only be changed by a human', builtIn: true },
  { path: '.pawsoff/**', ai_edit: 'block', reason: 'The PawsOff edit log can only be written by PawsOff', builtIn: true },
];

const DEFAULT_AI_MARKERS = [
  'claude', 'anthropic', 'copilot', 'cursor', 'codex', 'openai', 'devin',
  'windsurf', 'codeium', 'gemini', 'aider', 'sweep', 'amp', 'jules', 'junie',
];

function findPolicyFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    for (const name of POLICY_FILES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validate(raw, file) {
  const errors = [];
  const rules = [];
  const list = raw && raw.rules;
  if (list !== undefined && list !== null && !Array.isArray(list)) errors.push('"rules" must be a list');
  (Array.isArray(list) ? list : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') {
      errors.push(`rule ${i + 1}: must have "path" and "ai_edit"`);
      return;
    }
    const read = String(r.ai_read || 'allow').toLowerCase();
    // A file the AI can't read is a file it can't safely edit either.
    let action = String(r.ai_edit || (read === 'block' ? 'block' : read === 'redact' ? 'allow' : '')).toLowerCase();
    if (read === 'block') action = 'block';
    if (!r.path) errors.push(`rule ${i + 1}: missing "path"`);
    if (!READ_ACTIONS.includes(read)) errors.push(`rule ${i + 1}: "ai_read" must be allow, redact or block`);
    if (!ACTIONS.includes(action)) errors.push(`rule ${i + 1}: needs "ai_edit" (${ACTIONS.join(', ')}) or "ai_read: block"`);
    const reviewers = r.reviewers === undefined || r.reviewers === null ? (action === 'review' ? 1 : 0) : Number(r.reviewers);
    if (!Number.isInteger(reviewers) || reviewers < 0) errors.push(`rule ${i + 1}: "reviewers" must be a whole number`);
    rules.push({
      path: String(r.path || ''),
      ai_edit: action,
      ai_read: read,
      reviewers,
      reason: r.reason ? String(r.reason) : '',
      team: r.team ? String(r.team) : '',
    });
  });
  if (errors.length) {
    const err = new Error(`PawsOff policy ${file ? path.basename(file) + ' ' : ''}has problems: ${errors.join('; ')}`);
    err.policyErrors = errors;
    throw err;
  }
  // Redaction: on by default for every file an AI tool reads.
  const rd = raw.redact === false ? { enabled: false } : raw.redact && typeof raw.redact === 'object' ? raw.redact : {};
  let types = REDACT_TYPES;
  if (Array.isArray(rd.types) && rd.types.length) {
    types = rd.types.map((t) => String(t).toLowerCase());
    const bad = types.filter((t) => !REDACT_TYPES.includes(t));
    if (bad.length) errors.push(`redact.types: unknown ${bad.join(', ')} (use ${REDACT_TYPES.join(', ')})`);
  }
  if (rd.mode && !['placeholder', 'fake'].includes(String(rd.mode))) errors.push('redact.mode must be placeholder or fake');
  if (errors.length) {
    const err = new Error(`PawsOff policy ${file ? path.basename(file) + ' ' : ''}has problems: ${errors.join('; ')}`);
    err.policyErrors = errors;
    throw err;
  }
  const redact = {
    enabled: rd.enabled !== false,
    mode: rd.mode === 'fake' ? 'fake' : 'placeholder',
    types,
    shellOutput: rd.shell_output !== false,
    localModel: rd.local_model || null,
    localModelUrl: rd.local_model_url || null,
    allowEmails: Array.isArray(rd.allow_emails) ? rd.allow_emails.map(String) : [],
    confirm: rd.confirm === true,
    custom: Array.isArray(rd.custom) ? rd.custom.map(c => ({
      label: String(c.label || 'CUSTOM').toUpperCase(),
      pattern: c.pattern ? String(c.pattern) : null,
      near: Array.isArray(c.near) ? c.near.map(String) : null,
      columns: Array.isArray(c.columns) ? c.columns.map(String) : null,
    })).filter(c => c.pattern || c.columns) : [],
  };
  let markers = DEFAULT_AI_MARKERS;
  if (Array.isArray(raw.ai_authors) && raw.ai_authors.length) {
    markers = raw.ai_authors.map((m) => String(m).toLowerCase()).filter(Boolean);
  }
  return {
    version: raw.version || 1,
    rules: [...rules, ...BUILT_IN_RULES.map((r) => ({ reviewers: 0, team: '', ai_read: 'allow', ...r }))],
    userRuleCount: rules.length,
    aiMarkers: markers,
    logAllEdits: raw.log_all_edits === true,
    requireFreshApprovals: raw.require_fresh_approvals !== false,
    redact,
  };
}

function parsePolicyText(text, file) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new Error(`PawsOff can't read ${file ? path.basename(file) : 'the policy'}: ${e.message}`);
  }
  return validate(raw || {}, file);
}

// Load the policy that applies to startDir. Returns null when there isn't one.
function loadPolicy(startDir) {
  const file = findPolicyFile(startDir);
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const policy = parsePolicyText(text, file);
  policy.file = file;
  policy.root = path.dirname(file);
  policy.hash = crypto.createHash('sha256').update(text).digest('hex');
  return policy;
}

// Decide what an AI edit to relPath needs. The most restrictive matching rule wins;
// reviewer counts take the highest required.
function decide(policy, relPath) {
  const rel = normalisePath(relPath);
  const matches = policy.rules.filter((r) => matchPath(r.path, rel));
  if (!matches.length) return { path: rel, action: 'allow', reviewers: 0, rules: [], reason: '' };
  let top = matches[0];
  for (const r of matches) if (RANK[r.ai_edit] > RANK[top.ai_edit]) top = r;
  const sameLevel = matches.filter((r) => r.ai_edit === top.ai_edit);
  const reviewers = Math.max(0, ...sameLevel.map((r) => r.reviewers || 0));
  const teams = [...new Set(sameLevel.map((r) => r.team).filter(Boolean))];
  return {
    path: rel,
    action: top.ai_edit,
    reviewers,
    teams,
    rules: sameLevel.map((r) => r.path),
    reason: top.reason || '',
  };
}

// Decide whether an AI tool may read relPath at all.
function decideRead(policy, relPath) {
  const rel = normalisePath(relPath);
  const hidden = policy.rules.filter((r) => r.ai_read === 'block' && matchPath(r.path, rel));
  if (!hidden.length) return { path: rel, action: 'allow', rules: [], reason: '' };
  return { path: rel, action: 'block', rules: hidden.map((r) => r.path), reason: hidden[0].reason || '' };
}

// Should file contents be redacted before an AI tool sees them?
function shouldRedact(policy, relPath) {
  if (!policy.redact) return false;
  const rel = normalisePath(relPath);
  const forced = policy.rules.some((r) => r.ai_read === 'redact' && matchPath(r.path, rel));
  return forced || policy.redact.enabled;
}

function redactRules(policy) {
  return policy.rules.filter((r) => r.ai_read === 'redact');
}

// Rules whose files AI tools must not read.
function hiddenRules(policy) {
  return policy.rules.filter((r) => r.ai_read === 'block');
}

function mostRestrictive(decisions) {
  let top = null;
  for (const d of decisions) if (!top || RANK[d.action] > RANK[top.action]) top = d;
  return top;
}

// Is a path inside the policy root? Returns the relative path, or null.
function relativeToRoot(policy, filePath, cwd) {
  const abs = path.resolve(cwd || policy.root, filePath);
  const rel = path.relative(policy.root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

module.exports = {
  ACTIONS, READ_ACTIONS, REDACT_TYPES, RANK, POLICY_FILES, DEFAULT_AI_MARKERS,
  findPolicyFile, loadPolicy, parsePolicyText, decide, decideRead, shouldRedact, redactRules, hiddenRules, mostRestrictive, relativeToRoot,
};
