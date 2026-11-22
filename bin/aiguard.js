#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadPolicy, decide, decideRead, relativeToRoot } = require('../lib/policy');
const { runHook } = require('../lib/hook');
const { prCheck, VERSION } = require('../lib/pr-check');
const ledger = require('../lib/ledger');
const { sync } = require('../lib/sync');
const redact = require('../lib/redact');

const SAMPLE_POLICY = `# AI Guard policy: which files AI coding tools may change.
# ai_read: block   AI tools may not open, search or print these files
# ai_read: redact  AI tools see the file with personal and confidential data blanked
# ai_edit: allow | warn | review | block
#   warn    AI may edit; the edit is logged and flagged
#   review  AI may edit only after a human approves it in the session,
#           and the pull request needs human approvals
#   block   AI may never edit; a human must make the change
# The most restrictive matching rule wins.
version: 1

rules:
  # Hidden: AI tools may not read these at all (and so can't edit them).
  - path: "**/.env*"
    ai_read: block
    reason: "Secrets never go through AI tools"
  - path: "secrets/**"
    ai_read: block

  # Redacted: AI tools see these with personal data blanked out ([EMAIL_1], [TFN_1]).
  - path: "customer-data/**"
    ai_read: redact

  - path: "payments/**"
    ai_edit: review
    reviewers: 2
    team: "@payments-team"
    reason: "Payments code needs two human approvals"
  - path: ".github/workflows/**"
    ai_edit: block
    reason: "CI and deployment pipelines are changed by humans only"
  - path: "infra/**"
    ai_edit: review
    reviewers: 1
  - path: "**/migrations/**"
    ai_edit: warn

# Redaction runs on this machine for every file an AI tool reads.
# Detects emails, Australian phone numbers, TFNs, ABNs, Medicare and card numbers,
# BSBs and account numbers, addresses, dates of birth, names and secrets.
redact:
  enabled: true
  # mode: fake                         # realistic stand-ins (Olivia Walker, 0491 570 006) instead of [NAME_1]
  # types: [secret, card, medicare, tfn, abn, bank, email, phone, address, dob, name]
  # shell_output: true                 # also redact the output of every shell command
  # local_model: "ollama:llama3.2"     # extra detection by a model running on this machine
  # allow_emails: ["yourcompany.com.au"]

# Words that identify AI tools in commit trailers and bot accounts.
# Leave out to use the built-in list.
# ai_authors: ["claude", "copilot", "cursor", "codex", "devin"]

# Only count approvals given on the latest commit (default true).
# require_fresh_approvals: true
`;

function usage() {
  console.log(`AI Guard ${VERSION}: keep AI coding tools away from files that need a human.

Usage:
  aiguard init [--claude]        Create .aiguard.yml here; --claude also installs the Claude Code hooks
  aiguard check <path> [...]     Show what an AI edit to each path needs
  aiguard rules                  List the rules in force
  aiguard sync                   Copy hidden-file rules into Cursor, Windsurf, Gemini,
                                 Aider and Claude Code ignore settings
  aiguard scan <file> [...]      Show what personal or confidential data a file contains
  aiguard redact <file> [--fake] Print the file as an AI tool would see it
  aiguard hook                   Claude Code hook (reads hook JSON on stdin)
  aiguard pr-check [options]     Check a pull request or a commit range
      --base <ref> --head <ref>  Commit range (defaults come from GitHub Actions)
      --report-only              Report problems without failing
      --evidence <file>          Write the signed-off evidence record as JSON
  aiguard verify-log             Check the edit log hasn't been tampered with
  aiguard ui [--port 4477]       Open the local dashboard (this machine only)
  aiguard popup                  Small live window in the corner of the screen, plus
                                 notifications when something is stopped
  aiguard gateway [--port 4480]  Run the local agent: AI traffic goes through it and
                                 real data is swapped for stand-ins before it leaves
  aiguard run <command...>       Start the agent and run an AI tool through it,
                                 e.g. aiguard run claude
`);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function installClaudeHooks(dir) {
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  }
  const command = `node "${path.resolve(__dirname, 'aiguard.js')}" hook`;
  settings.hooks = settings.hooks || {};
  const add = (event, matcher) => {
    const list = (settings.hooks[event] = settings.hooks[event] || []);
    const already = list.some((m) => (m.hooks || []).some((h) => String(h.command || '').includes('aiguard')));
    if (!already) list.push({ matcher, hooks: [{ type: 'command', command }] });
  };
  add('PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|NotebookRead|Grep|Glob|LS');
  add('PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Read');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return settingsFile;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();
  if (cmd === '--version' || cmd === 'version') return console.log(VERSION);

  if (cmd === 'hook') {
    const res = runHook(readStdin(), process.env);
    if (res.stdout) process.stdout.write(res.stdout + '\n');
    if (res.stderr) process.stderr.write(res.stderr + '\n');
    process.exitCode = res.exitCode;
    return;
  }

  if (cmd === 'init') {
    const dir = process.cwd();
    const file = path.join(dir, '.aiguard.yml');
    if (fs.existsSync(file)) console.log('.aiguard.yml already exists; leaving it as it is.');
    else {
      fs.writeFileSync(file, SAMPLE_POLICY);
      console.log('Created .aiguard.yml with example rules. Edit the paths to match your repo.');
    }
    if (args.includes('--claude')) {
      const s = installClaudeHooks(dir);
      console.log(`Installed Claude Code hooks in ${path.relative(dir, s)}.`);
    }
    const out = sync(loadPolicy(dir));
    console.log(`Hid ${out.patterns.length} path(s) from AI tools in: ${out.written.map((w) => w.file).join(', ')}.`);
    console.log('Commit .aiguard.yml and .aiguard/ledger.jsonl so pull request checks can see them.');
    return;
  }

  if (cmd === 'check' || cmd === 'rules') {
    const policy = loadPolicy(process.cwd());
    if (!policy) {
      console.log('No .aiguard.yml found here or in any parent folder. Run "aiguard init".');
      process.exitCode = 1;
      return;
    }
    if (cmd === 'rules') {
      console.log(`Policy: ${policy.file}`);
      for (const r of policy.rules) {
        const extra = r.ai_edit === 'review' ? ` (${r.reviewers || 1} reviewer${(r.reviewers || 1) === 1 ? '' : 's'}${r.team ? ' from ' + r.team : ''})` : '';
        const label = r.ai_read === 'block' ? 'hidden' : r.ai_edit;
        console.log(`  ${label.padEnd(6)} ${r.path}${extra}${r.builtIn ? '  [built in]' : ''}`);
      }
      return;
    }
    if (!args.length) return usage();
    let worst = 0;
    for (const a of args) {
      const rel = relativeToRoot(policy, a, process.cwd());
      if (!rel) {
        console.log(`${a}: outside this repo`);
        continue;
      }
      const d = decide(policy, rel);
      const hidden = decideRead(policy, rel);
      if (hidden.action === 'block') {
        console.log(`${rel}: hidden from AI (may not read or edit) [${hidden.rules.join(', ')}]`);
        worst = Math.max(worst, 2);
        continue;
      }
      const needs = { allow: 'AI may edit', warn: 'AI may edit; logged and flagged', review: `AI edit needs human approval, then ${d.reviewers || 1} PR approval(s)`, block: 'AI may not edit' }[d.action];
      console.log(`${rel}: ${needs}${d.rules.length ? ` [${d.rules.join(', ')}]` : ''}`);
      if (d.action === 'block') worst = Math.max(worst, 2);
    }
    process.exitCode = worst;
    return;
  }

  if (cmd === 'scan' || cmd === 'redact' || cmd === 'redact-stream') {
    const root = argValue(args, '--root') || process.cwd();
    const policy = loadPolicy(root);
    const types = policy && policy.redact ? policy.redact.types : redact.ALL_TYPES;
    const allowEmails = policy && policy.redact ? policy.redact.allowEmails : [];
    if (cmd === 'redact-stream') {
      const vault = new redact.Vault(policy ? policy.root : root);
      const r = redact.redactText(readStdin(), { types, allowEmails, vault });
      vault.save();
      process.stdout.write(r.text);
      if (r.count) process.stdout.write(`\n[AI Guard redacted ${r.count} value(s) in this output]\n`);
      return;
    }
    const files = args.filter((a) => !a.startsWith('--') && a !== argValue(args, '--root'));
    if (!files.length) return usage();
    let total = 0;
    const { extractText, isDocument } = require('../lib/extract');
    for (const f of files) {
      const text = isDocument(f) ? extractText(path.resolve(f)) : fs.readFileSync(f, 'utf8');
      if (text === null) {
        console.log(`${f}: can't read this document type here`);
        continue;
      }
      const r = redact.redactText(text, { types, allowEmails, filePath: f, mode: args.includes('--fake') || (policy && policy.redact && policy.redact.mode === 'fake') ? 'fake' : 'placeholder' });
      total += r.count;
      if (cmd === 'redact') process.stdout.write(r.text);
      else {
        const what = Object.entries(r.summary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
        console.log(`${f}: ${r.count ? what : 'nothing found'}`);
      }
    }
    if (cmd === 'scan') process.exitCode = total ? 3 : 0;
    return;
  }

  if (cmd === 'sync') {
    const policy = loadPolicy(process.cwd());
    if (!policy) {
      console.log('No .aiguard.yml found. Run "aiguard init".');
      process.exitCode = 1;
      return;
    }
    const out = sync(policy);
    for (const w of out.written) console.log(`  ${w.file.padEnd(22)} ${w.tool}`);
    console.log(`Hid ${out.patterns.length} path(s) from AI tools.`);
    if (out.copilot) console.log('\n' + out.copilot);
    return;
  }

  if (cmd === 'gateway' || cmd === 'run') {
    const { startGateway } = require('../lib/gateway');
    const port = cmd === 'run' ? 0 : Number(argValue(args, '--port') || 4480);
    const g = await startGateway({ root: process.cwd(), port, upstream: argValue(args, '--upstream') });
    const base = `http://127.0.0.1:${g.port}`;
    const mode = g.policy.redact.mode === 'fake' ? 'realistic fakes' : 'placeholders';
    if (cmd === 'gateway') {
      console.log(`AI Guard agent running on ${base} (this machine only), forwarding to ${g.upstream}.`);
      console.log(`Redaction: ${g.policy.redact.enabled ? 'on' : 'off'}, ${mode}.`);
      console.log(`\nPoint Claude Code at it:\n  export ANTHROPIC_BASE_URL=${base}\n  claude\n\nWatch it work:  aiguard ui\nPress Ctrl+C to stop.`);
      return new Promise(() => {});
    }
    const command = args.filter((a, i) => !(a === '--upstream' || args[i - 1] === '--upstream'));
    if (!command.length) {
      console.error('Usage: aiguard run <command...>   e.g. aiguard run claude');
      g.server.close();
      process.exitCode = 1;
      return;
    }
    console.error(`AI Guard agent on ${base}: redacting (${mode}) before anything leaves this machine.`);
    const child = require('child_process').spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: base } });
    child.on('exit', (code) => {
      g.server.close();
      process.exit(code === null ? 1 : code);
    });
    return new Promise(() => {});
  }

  if (cmd === 'popup') {
    const { startPopup, openCornerWindow } = require('../lib/popup');
    let p;
    try {
      p = await startPopup({ port: Number(argValue(args, '--port') || 4478), notifications: !args.includes('--quiet') });
    } catch (e) {
      if (e.code === 'EADDRINUSE') p = await startPopup({ port: 0, notifications: !args.includes('--quiet') });
      else throw e;
    }
    const how = args.includes('--no-window') ? 'none' : openCornerWindow(p.url);
    console.log(`AI Guard pop-up running${how === 'window' ? ' in the corner of your screen' : ''}. Link (this machine only):\n  ${p.url}\nPress Ctrl+C to stop.`);
    return new Promise(() => {});
  }

  if (cmd === 'ui') {
    const { startServer } = require('../lib/ui');
    const port = Number(argValue(args, '--port') || 4477);
    let started;
    try {
      started = await startServer({ root: process.cwd(), port });
    } catch (e) {
      if (e.code === 'EADDRINUSE') started = await startServer({ root: process.cwd(), port: 0 });
      else throw e;
    }
    console.log(`AI Guard dashboard (only reachable from this machine):\n  ${started.url}\nPress Ctrl+C to stop.`);
    if (!args.includes('--no-open')) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '', started.url] : [started.url];
      try {
        require('child_process').spawn(opener, openArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      } catch (e) {
        /* no browser available; the link is printed above */
      }
    }
    return new Promise(() => {});
  }

  if (cmd === 'verify-log') {
    const policy = loadPolicy(process.cwd());
    const root = policy ? policy.root : process.cwd();
    const entries = ledger.readLedger(root);
    const v = ledger.verifyEntries(entries);
    if (v.ok) console.log(`Edit log intact: ${v.count} entr${v.count === 1 ? 'y' : 'ies'}${v.head ? `, head ${v.head.slice(0, 16)}…` : ''}.`);
    else {
      console.log(`Edit log broken: ${v.reason}.`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'pr-check') {
    const res = await prCheck({
      base: argValue(args, '--base'),
      head: argValue(args, '--head'),
      reportOnly: args.includes('--report-only'),
    });
    process.stdout.write(res.summaryMd);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, res.summaryMd);
    const evidenceFile = argValue(args, '--evidence');
    if (evidenceFile && res.evidence) fs.writeFileSync(evidenceFile, JSON.stringify(res.evidence, null, 2) + '\n');
    if (!res.ok && !args.includes('--report-only')) process.exitCode = 1;
    return;
  }

  console.error(`Unknown command "${cmd}".`);
  usage();
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`AI Guard: ${e.message}`);
  process.exitCode = 1;
});
