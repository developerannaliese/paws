'use strict';

// Pull request check: find changes an AI wrote, apply .paws.yml, and confirm
// protected files got the human approvals the policy asks for.
// Works in GitHub Actions (reads the event payload and calls the GitHub API)
// or locally between two commits (--base/--head) in report-only mode.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadPolicy, decide, parsePolicyText } = require('./policy');
const ledger = require('./ledger');

const VERSION = '0.1.0';

function git(cwd, args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (opts.allowFail) return null;
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}

function readEvent(env) {
  const p = env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function listCommits(cwd, base, head) {
  const out = git(cwd, ['log', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', `${base}..${head}`]);
  return out
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter((s) => s.trim())
    .map((rec) => {
      const [sha, parents, an, ae, cn, ce, body] = rec.split('\x1f');
      return { sha, parents: parents.trim().split(' ').filter(Boolean), authorName: an, authorEmail: ae, committerName: cn, committerEmail: ce, body: body || '' };
    });
}

// Decide whether a commit was written by an AI tool, using signals the tools
// leave themselves: Co-authored-by trailers, "Generated with" lines and bot accounts.
function aiSignals(commit, markers) {
  const signals = [];
  const has = (s) => {
    const low = String(s || '').toLowerCase();
    return markers.find((m) => low.includes(m));
  };
  for (const line of commit.body.split('\n')) {
    const m = line.match(/^\s*co-authored-by:\s*(.+)$/i);
    if (m && has(m[1])) signals.push(`Co-authored-by: ${m[1].trim()}`);
    const g = line.match(/generated (with|by)\s+(.+)/i);
    if (g && has(g[2])) signals.push(`Generated ${g[1]} ${g[2].trim()}`);
  }
  for (const [label, name, email] of [['author', commit.authorName, commit.authorEmail], ['committer', commit.committerName, commit.committerEmail]]) {
    const botLike = /\[bot\]|bot@|noreply|agent/i.test(`${name} ${email}`);
    const marker = has(email) || (botLike && has(name));
    if (marker) signals.push(`${label} ${name} <${email}>`);
  }
  return [...new Set(signals)];
}

function filesInCommit(cwd, sha) {
  const out = git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function ledgerAt(cwd, rev) {
  const text = git(cwd, ['show', `${rev}:${ledger.LEDGER_REL}`], { allowFail: true });
  return text === null ? [] : ledger.parseLedger(text);
}

function policyAt(cwd, rev, fallbackDir) {
  for (const name of ['.paws.yml', '.paws.yaml', '.paws.json']) {
    const text = git(cwd, ['show', `${rev}:${name}`], { allowFail: true });
    if (text !== null) {
      const p = parsePolicyText(text, name);
      p.file = name;
      p.hash = ledger.sha256(text);
      return p;
    }
  }
  return loadPolicy(fallbackDir);
}

async function githubJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'paws' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

async function fetchApprovals({ apiUrl, repo, prNumber, token, prAuthor, headSha, fresh }) {
  const reviews = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubJson(`${apiUrl}/repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`, token);
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  // Latest review per person decides their state, as GitHub does.
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(r.user.login, r);
  }
  const approvers = [];
  for (const [login, r] of latest) {
    if (r.state !== 'APPROVED') continue;
    if (login === prAuthor) continue;
    if (r.user.type === 'Bot' || /\[bot\]$/.test(login)) continue;
    if (fresh && headSha && r.commit_id && r.commit_id !== headSha) continue;
    approvers.push(login);
  }
  return approvers;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|');
}

async function prCheck(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const event = readEvent(env);
  const pr = event && event.pull_request ? event.pull_request : null;

  const base = opts.base || (pr && pr.base && pr.base.sha) || env.PAWS_BASE;
  const head = opts.head || (pr && pr.head && pr.head.sha) || env.PAWS_HEAD || 'HEAD';
  if (!base) throw new Error('No base commit. In GitHub Actions run this on pull_request events; locally pass --base <ref>.');
  const headSha = git(cwd, ['rev-parse', head]).trim();
  const baseSha = git(cwd, ['rev-parse', base]).trim();

  // Use the policy from the base branch, so a pull request can't loosen its own rules.
  const policy = policyAt(cwd, baseSha, cwd);
  if (!policy) {
    return { ok: true, skipped: true, summaryMd: '### Paws\n\nNo `.paws.yml` on the base branch, so there is nothing to check.\n', evidence: null };
  }

  const commits = listCommits(cwd, baseSha, headSha);
  const touched = new Map(); // path -> sources
  const aiCommits = [];
  for (const c of commits) {
    if (c.parents.length > 1) continue; // merge commits carry no authorship of their own
    const signals = aiSignals(c, policy.aiMarkers);
    if (!signals.length) continue;
    const files = filesInCommit(cwd, c.sha);
    aiCommits.push({ sha: c.sha, signals, files });
    for (const f of files) {
      if (!touched.has(f)) touched.set(f, []);
      touched.get(f).push(`commit ${c.sha.slice(0, 7)} (${signals[0]})`);
    }
  }

  // Edit log: new entries added in this pull request.
  const baseLog = ledgerAt(cwd, baseSha);
  const headLog = ledgerAt(cwd, headSha);
  const logCheck = ledger.verifyEntries(headLog);
  let logProblem = null;
  if (!logCheck.ok) logProblem = `Edit log is broken: ${logCheck.reason}`;
  for (let i = 0; i < baseLog.length && !logProblem; i++) {
    if (!headLog[i] || headLog[i].hash !== baseLog[i].hash) logProblem = `Edit log history was rewritten at entry ${i + 1}`;
  }
  const newEntries = headLog.slice(baseLog.length);
  const blockedAttempts = [];
  for (const e of newEntries) {
    if (e.event === 'edited' && e.path) {
      if (!touched.has(e.path)) touched.set(e.path, []);
      touched.get(e.path).push(`edit log (${e.agent || 'agent'}, ${e.ts})`);
    }
    if (e.event === 'blocked') blockedAttempts.push(e);
  }

  // Only judge files that still differ between base and head.
  const changed = new Set(git(cwd, ['diff', '--name-only', baseSha, headSha]).split('\n').map((s) => s.trim()).filter(Boolean));

  const decisions = [];
  for (const [p, sources] of touched) {
    // The edit log is written by Paws itself and checked by its hash chain above.
    if (p === ledger.LEDGER_REL) continue;
    const d = decide(policy, p);
    if (d.action === 'allow') continue;
    decisions.push({ ...d, sources, stillChanged: changed.has(p) });
  }

  // Approvals
  const needReview = decisions.filter((d) => d.action === 'review' && d.stillChanged);
  const required = needReview.reduce((m, d) => Math.max(m, d.reviewers || 1), 0);
  let approvers = null;
  let approvalNote = '';
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const prNumber = pr && pr.number;
  if (required > 0) {
    if (token && repo && prNumber) {
      try {
        approvers = await fetchApprovals({
          apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
          repo, prNumber, token,
          prAuthor: pr.user && pr.user.login,
          headSha,
          fresh: policy.requireFreshApprovals,
        });
      } catch (e) {
        approvalNote = `Couldn't read approvals: ${e.message}`;
      }
    } else {
      approvalNote = 'Not running on a GitHub pull request, so approvals were not checked.';
    }
  }

  const problems = [];
  for (const d of decisions.filter((x) => x.action === 'block' && x.stillChanged)) {
    problems.push(`\`${d.path}\`: AI changes aren't allowed (rule \`${d.rules.join(', ')}\`)${d.reason ? `. ${d.reason}` : ''}`);
  }
  if (required > 0) {
    if (approvers === null) {
      if (!opts.reportOnly) problems.push(`${required} human approval(s) needed for AI changes to protected files. ${approvalNote}`);
    } else if (approvers.length < required) {
      problems.push(`${required} human approval(s) needed for AI changes to protected files; ${approvers.length} so far${policy.requireFreshApprovals ? ' on the latest commit' : ''}.`);
    }
  }
  if (logProblem) problems.push(logProblem);

  const ok = problems.length === 0;

  const evidence = {
    tool: 'paws', version: VERSION,
    generated_at: new Date().toISOString(),
    repository: repo || null,
    pull_request: prNumber || null,
    base: baseSha, head: headSha,
    policy: { file: policy.file, sha256: policy.hash, rules: policy.rules.length },
    ai_commits: aiCommits.map((c) => ({ sha: c.sha, signals: c.signals, files: c.files })),
    decisions: decisions.map((d) => ({ path: d.path, action: d.action, rules: d.rules, reviewers: d.reviewers, still_changed: d.stillChanged, sources: d.sources })),
    blocked_attempts: blockedAttempts.map((e) => ({ path: e.path, ts: e.ts, agent: e.agent })),
    edit_log: { entries: headLog.length, new_entries: newEntries.length, intact: !logProblem, head: logCheck.head || null },
    approvals: required > 0 ? { required, approvers, note: approvalNote || null } : null,
    result: ok ? 'pass' : 'fail',
    problems,
  };
  evidence.sha256 = ledger.sha256(JSON.stringify(evidence));

  const lines = [];
  lines.push(`### Paws: ${ok ? 'passed' : 'needs attention'}`);
  lines.push('');
  lines.push(`Checked ${commits.length} commit(s); ${aiCommits.length} written with AI tools. ${decisions.length} protected file(s) touched by AI.`);
  if (decisions.length) {
    lines.push('');
    lines.push('| File | Rule | Needs | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of decisions) {
      const needs = d.action === 'block' ? 'No AI changes' : d.action === 'review' ? `${d.reviewers || 1} human approval(s)` : 'Logged';
      lines.push(`| \`${mdEscape(d.path)}\`${d.stillChanged ? '' : ' (reverted)'} | \`${mdEscape(d.rules.join(', '))}\` | ${needs} | ${mdEscape(d.sources.join('; '))} |`);
    }
  }
  if (approvers) lines.push('', `Approvals counted: ${approvers.length ? approvers.join(', ') : 'none'}.`);
  if (approvalNote) lines.push('', approvalNote);
  if (blockedAttempts.length) lines.push('', `Paws stopped ${blockedAttempts.length} AI edit attempt(s) on protected files during development.`);
  if (problems.length) {
    lines.push('', '**To fix:**');
    for (const p of problems) lines.push(`- ${p}`);
  }
  lines.push('', `Evidence record: \`${evidence.sha256.slice(0, 16)}…\` (policy \`${policy.hash.slice(0, 12)}…\`).`);
  const summaryMd = lines.join('\n') + '\n';

  return { ok, summaryMd, evidence };
}

module.exports = { prCheck, aiSignals, listCommits, VERSION };
