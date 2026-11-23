'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const Module = require('module');

const { matchPath } = require('../lib/glob');
const { parseYaml } = require('../lib/yaml');
const { parsePolicyText, decide, loadPolicy } = require('../lib/policy');
const { runHook, pathsFromCommand } = require('../lib/hook');
const { sync, claudeReadRule } = require('../lib/sync');
const redact = require('../lib/redact');

// Keep the redaction vault and cache out of the real home folder.
process.env.PAWS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-home-'));
const ledger = require('../lib/ledger');
const { prCheck, aiSignals } = require('../lib/pr-check');

const POLICY = `version: 1
rules:
  - path: "payments/**"   # money
    ai_edit: review
    reviewers: 2
    team: "@payments-team"
    reason: "Payments code needs two human approvals"
  - path: ".github/workflows/**"
    ai_edit: block
  - path: "**/.env*"
    ai_edit: block
  - path: "**/migrations/**"
    ai_edit: warn
  - path: "payments/legacy/**"
    ai_edit: warn
  - path: "secrets/**"
    ai_read: block
    reason: "Keys stay out of AI tools"
  - path: "customers.csv"
    ai_read: block
`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paws-'));
}

function repoWithPolicy(text = POLICY) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.paws.yml'), text);
  return dir;
}

function hook(dir, payload) {
  const res = runHook(JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'PreToolUse', ...payload }), { CLAUDE_PROJECT_DIR: dir });
  return { ...res, json: res.stdout ? JSON.parse(res.stdout) : null };
}

test('glob matching follows gitignore-style rules', () => {
  assert.ok(matchPath('payments/**', 'payments/charge.ts'));
  assert.ok(matchPath('payments/**', 'payments/a/b/c.ts'));
  assert.ok(matchPath('payments/**', 'payments'));
  assert.ok(!matchPath('payments/**', 'src/payments/x.ts'));
  assert.ok(matchPath('**/.env*', '.env'));
  assert.ok(matchPath('**/.env*', 'apps/web/.env.local'));
  assert.ok(matchPath('*.sql', 'db/schema/init.sql'));
  assert.ok(!matchPath('*.sql', 'db/schema/init.sql.bak'));
  assert.ok(matchPath('/infra/', 'infra/main.tf'));
  assert.ok(matchPath('secrets', 'config/secrets/key.pem'));
  assert.ok(!matchPath('payments/**', '../payments/x'));
  assert.ok(matchPath('src/*.ts', 'src/a.ts') && !matchPath('src/*.ts', 'src/a/b.ts'));
});

test('policy parser reads the YAML subset and rejects bad rules', () => {
  const raw = parseYaml(POLICY);
  assert.strictEqual(raw.rules.length, 7);
  assert.deepStrictEqual(raw.rules[0], { path: 'payments/**', ai_edit: 'review', reviewers: 2, team: '@payments-team', reason: 'Payments code needs two human approvals' });
  assert.deepStrictEqual(parseYaml('ai_authors: ["claude", "devin"]\n').ai_authors, ['claude', 'devin']);
  assert.throws(() => parsePolicyText('rules:\n  - path: "x"\n    ai_edit: maybe\n'), /ai_edit/);
  assert.throws(() => parsePolicyText('rules:\n\t- path: x\n'), /tabs/);
  assert.strictEqual(parsePolicyText('{"rules":[{"path":"a/**","ai_edit":"block"}]}').userRuleCount, 1);
});

test('the most restrictive rule wins, and the guard protects itself', () => {
  const p = parsePolicyText(POLICY);
  assert.strictEqual(decide(p, 'payments/legacy/old.js').action, 'review');
  assert.strictEqual(decide(p, 'payments/legacy/old.js').reviewers, 2);
  assert.strictEqual(decide(p, 'db/migrations/001.sql').action, 'warn');
  assert.strictEqual(decide(p, 'src/app.ts').action, 'allow');
  assert.strictEqual(decide(p, '.paws.yml').action, 'block');
  assert.strictEqual(decide(p, '.paws/ledger.jsonl').action, 'block');
});

test('hook blocks, asks, warns or stays quiet', () => {
  const dir = repoWithPolicy();
  const block = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.github/workflows/deploy.yml') } });
  assert.strictEqual(block.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(block.json.hookSpecificOutput.permissionDecisionReason, /blocked/);

  const ask = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/charge.ts') } });
  assert.strictEqual(ask.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(ask.json.hookSpecificOutput.permissionDecisionReason, /2 human approvals from @payments-team/);

  const relative = hook(dir, { tool_name: 'Edit', tool_input: { file_path: 'payments/refund.ts' } });
  assert.strictEqual(relative.json.hookSpecificOutput.permissionDecision, 'ask');

  const warn = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'db/migrations/002.sql') } });
  assert.match(warn.json.systemMessage, /flagged/);

  const fine = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/app.ts') } });
  assert.strictEqual(fine.stdout, '');

  const outside = hook(dir, { tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } });
  assert.strictEqual(outside.stdout, '');

  const self = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.paws.yml') } });
  assert.strictEqual(self.json.hookSpecificOutput.permissionDecision, 'deny');

  const nb = hook(dir, { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(dir, 'payments/model.ipynb') } });
  assert.strictEqual(nb.json.hookSpecificOutput.permissionDecision, 'ask');
});

test('hook catches shell commands that write to protected files', () => {
  const dir = repoWithPolicy();
  const rm = hook(dir, { tool_name: 'Bash', tool_input: { command: 'rm -f .env && echo done' } });
  assert.strictEqual(rm.json.hookSpecificOutput.permissionDecision, 'deny');
  const redirect = hook(dir, { tool_name: 'Bash', tool_input: { command: 'echo "x" >> payments/charge.ts' } });
  assert.strictEqual(redirect.json.hookSpecificOutput.permissionDecision, 'ask');
  const sed = hook(dir, { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' .github/workflows/ci.yml" } });
  assert.strictEqual(sed.json.hookSpecificOutput.permissionDecision, 'deny');
  const rmdir = hook(dir, { tool_name: 'Bash', tool_input: { command: 'rm -rf payments' } });
  assert.strictEqual(rmdir.json.hookSpecificOutput.permissionDecision, 'ask');
  const read = hook(dir, { tool_name: 'Bash', tool_input: { command: 'cat payments/charge.ts | grep total 2>&1' } });
  assert.strictEqual(read.stdout, '');
  assert.deepStrictEqual(pathsFromCommand('ls -la payments', dir), []);
});

test('a broken policy pauses AI edits instead of switching the guard off', () => {
  const dir = repoWithPolicy('rules:\n  - path: "x"\n    ai_edit: sometimes\n');
  const res = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } });
  assert.strictEqual(res.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /paused/);
});

test('no policy means the hook does nothing', () => {
  const dir = tmpDir();
  const res = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/x.ts') } });
  assert.strictEqual(res.stdout, '');
});

test('edit log records decisions in a hash chain and detects tampering', () => {
  const dir = repoWithPolicy();
  hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.github/workflows/a.yml') } });
  hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/charge.ts') } });
  runHook(JSON.stringify({ cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/charge.ts') } }), { CLAUDE_PROJECT_DIR: dir });
  runHook(JSON.stringify({ cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/ok.ts') } }), { CLAUDE_PROJECT_DIR: dir });
  const entries = ledger.readLedger(dir);
  assert.deepStrictEqual(entries.map((e) => e.event), ['blocked', 'asked', 'edited']);
  assert.ok(ledger.verifyEntries(entries).ok);

  const file = path.join(dir, ledger.LEDGER_REL);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.path = 'src/innocent.ts';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = ledger.verifyEntries(ledger.readLedger(dir));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 2);

  const dropped = ledger.parseLedger([lines[0], lines[2]].join('\n'));
  assert.strictEqual(ledger.verifyEntries(dropped).ok, false);
});

test('AI commits are recognised from trailers and bot accounts, not human names', () => {
  const m = ['claude', 'copilot', 'cursor'];
  const base = { authorName: 'Sam', authorEmail: 'sam@acme.com', committerName: 'Sam', committerEmail: 'sam@acme.com', body: 'Fix bug' };
  assert.deepStrictEqual(aiSignals(base, m), []);
  assert.ok(aiSignals({ ...base, body: 'Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>' }, m).length);
  assert.ok(aiSignals({ ...base, authorName: 'Copilot', authorEmail: '198982749+Copilot@users.noreply.github.com' }, m).length);
  assert.ok(aiSignals({ ...base, authorName: 'cursor-agent[bot]', authorEmail: 'agent@cursor.com' }, m).length);
  assert.deepStrictEqual(aiSignals({ ...base, authorName: 'Claude Smith', authorEmail: 'claude.smith@acme.com' }, ['claudeai']), []);
});

test('hidden files: AI tools may not read, search or print them', () => {
  const dir = repoWithPolicy();
  const deny = (r) => r.json && r.json.hookSpecificOutput.permissionDecision === 'deny';
  const read = hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'secrets/prod.pem') } });
  assert.ok(deny(read));
  assert.match(read.json.hookSpecificOutput.permissionDecisionReason, /hidden from AI tools.*Keys stay out of AI tools/);
  assert.ok(deny(hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'data/customers.csv') } })));
  assert.ok(deny(hook(dir, { tool_name: 'Grep', tool_input: { pattern: 'BEGIN', path: path.join(dir, 'secrets') } })));
  assert.ok(deny(hook(dir, { tool_name: 'Glob', tool_input: { pattern: '*', path: 'secrets' } })));
  assert.ok(deny(hook(dir, { tool_name: 'Bash', tool_input: { command: 'cat secrets/prod.pem | base64' } })));
  assert.ok(deny(hook(dir, { tool_name: 'Bash', tool_input: { command: 'head -5 customers.csv' } })));
  assert.ok(deny(hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'secrets/prod.pem') } })), 'hidden implies no edits');
  assert.strictEqual(hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/app.ts') } }).stdout, '');
  assert.strictEqual(hook(dir, { tool_name: 'Grep', tool_input: { pattern: 'x' } }).stdout, '', 'repo-wide search is left to native ignore rules');
  assert.ok(ledger.readLedger(dir).some((e) => e.event === 'read_blocked' && e.path === 'secrets/prod.pem'));
  assert.deepStrictEqual(decide(parsePolicyText(POLICY), 'secrets/a').action, 'block');
});

test('sync copies hidden rules into each AI tool\'s ignore settings, safely', () => {
  const dir = repoWithPolicy();
  fs.writeFileSync(path.join(dir, '.cursorignore'), 'node_modules/\n');
  const policy = loadPolicy(dir);
  const out = sync(policy);
  sync(policy);
  const cursor = fs.readFileSync(path.join(dir, '.cursorignore'), 'utf8');
  assert.match(cursor, /^node_modules\/\n/, 'keeps what was there');
  assert.strictEqual((cursor.match(/>>> paws/g) || []).length, 1, 'one managed block after two syncs');
  assert.match(cursor, /secrets\/\*\*\ncustomers\.csv/);
  assert.ok(fs.existsSync(path.join(dir, '.aiexclude')) && fs.existsSync(path.join(dir, '.codeiumignore')));
  const deny = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).permissions.deny;
  assert.deepStrictEqual(deny, ['Read(./secrets/**)', 'Read(./**/customers.csv)']);
  assert.match(out.copilot, /"\/secrets\/\*\*"/);
  assert.strictEqual(claudeReadRule('**/.env*'), 'Read(./**/.env*)');
});

// ---------- local redaction ----------

// Dummy test data only: built at run time so nothing in this file looks like a real key.
const DUMMY_KEY = ['sk', 'live', 'DUMMY0DUMMY0DUMMY0'].join('_');
const PEM = (k) => `-----${k} RSA ${'PRIVATE'} KEY-----`;

const SAMPLE = `Customer: Jane Citizen
email jane.citizen@gmail.com, mobile 0412 345 678
TFN: 123 456 782, ABN 51 824 753 556, Medicare 2123 45670 1
Card 4111 1111 1111 1111. BSB 062-000 account 12345678
Lives at 12 Smith Street, Parramatta NSW 2150. DOB: 03/04/1985
stripe_key = "${DUMMY_KEY}"
`;

test('redaction finds Australian identifiers and leaves ordinary code alone', () => {
  const r = redact.redactText(SAMPLE);
  for (const v of ['Jane Citizen', 'jane.citizen@gmail.com', '0412 345 678', '123 456 782', '51 824 753 556', '2123 45670 1', '4111 1111 1111 1111', '062-000', '12345678', '12 Smith Street', '03/04/1985', DUMMY_KEY]) {
    assert.ok(!r.text.includes(v), `should redact ${v}`);
  }
  assert.strictEqual(r.count, 12);
  const code = 'const port = 8080;\nconst id = 123456789;\nconst key = process.env.STRIPE_KEY;\nfetch("https://api.example.com/v1")\nname: CI\nemail: dev@example.com\n';
  assert.strictEqual(redact.redactText(code).count, 0, 'no false positives on plain code');
  assert.strictEqual(redact.redactText('TFN: 123 456 789').count, 0, 'invalid TFN checksum is left alone');
  assert.ok(redact.validTfn('123 456 782') && redact.validAbn('51 824 753 556') && redact.validMedicare('2123456701') && redact.luhn('4111111111111111'));
  const csv = redact.redactText('id,full_name,email,plan\n1,Jane Citizen,jane@x.com.au,gold\n2,"Bob, Jr",bob@y.com,silver\n', { filePath: 'customers.csv' });
  assert.strictEqual(csv.text, 'id,full_name,email,plan\n1,[NAME],[EMAIL],gold\n2,"[NAME]",[EMAIL],silver\n');
  const pem = `a\n${PEM('BEGIN')}\ndummy\ndummy\n${PEM('END')}\nb`;
  const key = redact.redactText(pem);
  assert.match(key.text, /\[PRIVATE_KEY\]/);
  assert.strictEqual(key.text.split('\n').length, pem.split('\n').length, 'line numbers stay the same');
});

test('placeholders are stable and swap back to real values from the local vault', () => {
  const root = tmpDir();
  const vault = new redact.Vault(root);
  const a = redact.redactText('Call 0412 345 678 or 0412 345 678; mail sam@acme.com.au', { vault });
  assert.strictEqual(a.text, 'Call [PHONE_1] or [PHONE_1]; mail [EMAIL_1]');
  vault.save();
  const again = new redact.Vault(root);
  assert.strictEqual(redact.restoreText('to [EMAIL_1] and [EMAIL_9]', again).text, 'to sam@acme.com.au and [EMAIL_9]');
  const st = fs.statSync(again.file);
  assert.strictEqual(st.mode & 0o777, 0o600, 'vault is private to the user');
  assert.ok(!again.file.startsWith(root), 'vault lives outside the repo');
});

test('hook: AI reads a redacted copy, and its edits are turned back into real values', () => {
  const dir = repoWithPolicy();
  write(dir, 'data/customers.txt', SAMPLE);
  const readRes = hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'data/customers.txt') } });
  const out = readRes.json.hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'allow');
  const copy = out.updatedInput.file_path;
  assert.notStrictEqual(copy, path.join(dir, 'data/customers.txt'));
  const seen = fs.readFileSync(copy, 'utf8');
  assert.ok(!seen.includes('jane.citizen@gmail.com') && seen.includes('[EMAIL_1]'));
  assert.match(out.permissionDecisionReason, /redacted .*email/);
  const logged = ledger.readLedger(dir).find((e) => e.event === 'redacted');
  assert.ok(logged && !JSON.stringify(logged).includes('jane'), 'the log records counts, never values');

  // AI edits the copy it saw, using placeholders.
  const edit = hook(dir, { permission_mode: 'default', tool_name: 'Edit', tool_input: { file_path: copy, old_string: 'email [EMAIL_1]', new_string: 'email [EMAIL_1] (primary)' } });
  const e = edit.json.hookSpecificOutput;
  assert.strictEqual(e.permissionDecision, 'ask');
  assert.strictEqual(e.updatedInput.file_path, path.join(dir, 'data/customers.txt'));
  assert.strictEqual(e.updatedInput.old_string, 'email jane.citizen@gmail.com');
  assert.strictEqual(e.updatedInput.new_string, 'email jane.citizen@gmail.com (primary)');
  const auto = hook(dir, { permission_mode: 'acceptEdits', tool_name: 'Edit', tool_input: { file_path: copy, old_string: '[PHONE_1]', new_string: '[PHONE_1]' } });
  assert.strictEqual(auto.json.hookSpecificOutput.permissionDecision, 'allow');

  // Protected paths still apply after the swap.
  write(dir, 'payments/notes.txt', 'Refund to jane.citizen@gmail.com\n');
  const pay = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/notes.txt'), old_string: '[EMAIL_1]', new_string: 'x' } });
  assert.strictEqual(pay.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(pay.json.hookSpecificOutput.updatedInput.old_string, 'jane.citizen@gmail.com');
  assert.match(pay.json.hookSpecificOutput.permissionDecisionReason, /2 human approvals.*put back 1/);

  // Clean files are read normally.
  write(dir, 'src/clean.ts', 'export const a = 1;\n');
  assert.strictEqual(hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/clean.ts') } }).stdout, '');
});

test('hook: shell output from redacted paths goes through the redactor', () => {
  const dir = repoWithPolicy(POLICY + '  - path: "crm/**"\n    ai_read: redact\n');
  write(dir, 'crm/export.txt', 'Contact sam@acme.com.au on 0412 345 678\n');
  const res = hook(dir, { tool_name: 'Bash', tool_input: { command: 'cat crm/export.txt' } });
  const out = res.json.hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'ask');
  const shown = execFileSync('bash', ['-c', out.updatedInput.command], { cwd: dir, encoding: 'utf8' });
  assert.match(shown, /Contact \[EMAIL_\d+\] on \[PHONE_\d+\]/);
  assert.ok(!shown.includes('sam@acme.com.au'));
  assert.strictEqual(hook(dir, { tool_name: 'Bash', tool_input: { command: 'ls src' } }).stdout, '', 'other commands are untouched');
});

test('hook: an optional local model adds names the patterns miss', async () => {
  // A stand-in for Ollama, in its own process (the hook calls it synchronously).
  const serverJs = path.join(tmpDir(), 'fake-ollama.js');
  fs.writeFileSync(serverJs, `require('http').createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({response:JSON.stringify({items:[{type:'NAME',text:'Priya Raman'}]})}));});}).listen(0,'127.0.0.1',function(){console.log(this.address().port)});`);
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((r) => proc.stdout.once('data', (d) => r(String(d).trim())));
  try {
    const dir = repoWithPolicy(POLICY + `redact:\n  local_model: "ollama:llama3.2"\n  local_model_url: "http://127.0.0.1:${port}"\n`);
    write(dir, 'notes/meeting.md', 'Meet Priya Raman about the Q3 numbers.\n');
    const res = hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'notes/meeting.md') } });
    const seen = fs.readFileSync(res.json.hookSpecificOutput.updatedInput.file_path, 'utf8');
    assert.match(seen, /Meet \[NAME_\d+\] about/);
  } finally {
    proc.kill();
  }
});

test('fake mode: realistic stand-ins that are not real, and swap back exactly', () => {
  const root = tmpDir();
  const vault = new redact.Vault(root);
  const r = redact.redactText(SAMPLE, { vault, mode: 'fake' });
  assert.match(r.text, /Customer: Olivia Walker/);
  assert.match(r.text, /olivia\.walker@example\.com/);
  assert.match(r.text, /0491 570 006/);
  assert.match(r.text, /\[SECRET_1\]/, 'secrets never get a realistic fake');
  for (const m of r.text.matchAll(/TFN: ([\d ]+),/g)) assert.ok(!redact.validTfn(m[1]), 'fake TFN fails the checksum');
  const card = r.text.match(/Card ([\d ]+)\./)[1];
  assert.ok(!redact.luhn(card), 'fake card fails the Luhn check');
  assert.strictEqual(redact.restoreText(r.text, vault).text, SAMPLE);
  const two = redact.redactText('a@b.com.au then c@d.com.au then a@b.com.au', { vault, mode: 'fake' });
  const emails = two.text.match(/[\w.]+@example\.com/g);
  assert.strictEqual(emails[0], emails[2]);
  assert.notStrictEqual(emails[0], emails[1]);
});

function minimalPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test('papers and documents: PDF and Word files are redacted as text before the AI sees them', () => {
  const dir = repoWithPolicy();
  fs.writeFileSync(path.join(dir, 'paper.pdf'), minimalPdf('Participant Jane, email jane.citizen@gmail.com, phone 0412 345 678'));
  const pdf = hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'paper.pdf') } }).json.hookSpecificOutput;
  assert.strictEqual(pdf.permissionDecision, 'allow');
  assert.match(pdf.updatedInput.file_path, /paper\.pdf\.redacted\.txt$/);
  const pdfText = fs.readFileSync(pdf.updatedInput.file_path, 'utf8');
  assert.match(pdfText, /email \[EMAIL_\d+\], phone \[PHONE_\d+\]/);

  const work = tmpDir();
  fs.mkdirSync(path.join(work, 'word'));
  fs.writeFileSync(path.join(work, 'word', 'document.xml'), '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Interview with client: Raj Patel</w:t></w:r></w:p><w:p><w:r><w:t>TFN 123 456 782 &amp; mobile 0400 111 222</w:t></w:r></w:p></w:body></w:document>');
  execFileSync('zip', ['-q', '-r', path.join(dir, 'notes.docx'), 'word'], { cwd: work });
  const docx = hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'notes.docx') } }).json.hookSpecificOutput;
  const docText = fs.readFileSync(docx.updatedInput.file_path, 'utf8');
  assert.match(docText, /client: \[NAME_\d+\]\nTFN \[TFN_\d+\] & mobile \[PHONE_\d+\]/);
});

test('CLI: scan and redact show what an AI would see', () => {
  const dir = tmpDir();
  write(dir, 'c.txt', SAMPLE);
  const cli = path.join(__dirname, '..', 'bin', 'paws.js');
  let scan;
  try {
    execFileSync('node', [cli, 'scan', 'c.txt'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    scan = e;
  }
  assert.strictEqual(scan.status, 3);
  assert.match(String(scan.stdout), /c\.txt: .*1 email.*1 tfn/);
  const shown = execFileSync('node', [cli, 'redact', 'c.txt'], { cwd: dir, encoding: 'utf8' });
  assert.match(shown, /email \[EMAIL_1\], mobile \[PHONE_1\]/);
});

// ---------- pull request check, against a real git repo ----------

function g(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@acme.com', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@acme.com' } }).trim();
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function gitRepo() {
  const dir = repoWithPolicy();
  g(dir, 'init', '-q', '-b', 'main');
  write(dir, 'payments/charge.ts', 'export const fee = 1;\n');
  write(dir, 'src/app.ts', 'console.log(1);\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'Initial');
  return { dir, base: g(dir, 'rev-parse', 'HEAD') };
}

test('PR check: human-only changes pass', async () => {
  const { dir, base } = gitRepo();
  write(dir, 'payments/charge.ts', 'export const fee = 2;\n');
  g(dir, 'commit', '-qam', 'Human change');
  const res = await prCheck({ cwd: dir, base, env: {} });
  assert.strictEqual(res.ok, true, res.summaryMd);
  assert.strictEqual(res.evidence.decisions.length, 0);
});

test('PR check: AI change to a blocked file fails; to a review file needs approvals', async () => {
  const { dir, base } = gitRepo();
  write(dir, 'src/app.ts', 'console.log(2);\n');
  write(dir, 'payments/charge.ts', 'export const fee = 3;\n');
  g(dir, 'commit', '-qam', 'Tidy up\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  let res = await prCheck({ cwd: dir, base, env: {}, reportOnly: true });
  assert.strictEqual(res.ok, true, 'report-only does not fail on unknown approvals');
  assert.deepStrictEqual(res.evidence.decisions.map((d) => [d.path, d.action]), [['payments/charge.ts', 'review']]);
  res = await prCheck({ cwd: dir, base, env: {} });
  assert.strictEqual(res.ok, false);
  assert.match(res.summaryMd, /2 human approval/);

  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'Add CI\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  res = await prCheck({ cwd: dir, base, env: {}, reportOnly: true });
  assert.strictEqual(res.ok, false);
  assert.match(res.summaryMd, /\.github\/workflows\/ci\.yml/);
  assert.ok(res.evidence.sha256 && res.evidence.ai_commits.length === 2);
});

test('PR check: a pull request cannot loosen its own policy', async () => {
  const { dir, base } = gitRepo();
  write(dir, '.paws.yml', 'rules: []\n');
  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'Loosen\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const res = await prCheck({ cwd: dir, base, env: {}, reportOnly: true });
  assert.strictEqual(res.ok, false);
  const paths = res.evidence.decisions.map((d) => d.path).sort();
  assert.deepStrictEqual(paths, ['.github/workflows/ci.yml', '.paws.yml']);
});

test('PR check: edit log shows AI edits even when the commit looks human', async () => {
  const { dir, base } = gitRepo();
  runHook(JSON.stringify({ cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'payments/charge.ts') } }), { CLAUDE_PROJECT_DIR: dir });
  write(dir, 'payments/charge.ts', 'export const fee = 9;\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'Change fee');
  const res = await prCheck({ cwd: dir, base, env: {}, reportOnly: true });
  assert.deepStrictEqual(res.evidence.decisions.map((d) => d.path), ['payments/charge.ts']);
  assert.match(res.evidence.decisions[0].sources[0], /edit log/);
  assert.strictEqual(res.evidence.edit_log.intact, true);

  // Rewriting the committed log is caught.
  const file = path.join(dir, ledger.LEDGER_REL);
  const e = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  e.path = 'src/app.ts';
  fs.writeFileSync(file, JSON.stringify(e) + '\n');
  g(dir, 'commit', '-qam', 'Edit log');
  const res2 = await prCheck({ cwd: dir, base, env: {}, reportOnly: true });
  assert.strictEqual(res2.ok, false);
  assert.match(res2.summaryMd, /Edit log is broken/);
});

test('PR check: counts fresh human approvals from the GitHub API', async () => {
  const { dir, base } = gitRepo();
  write(dir, 'payments/charge.ts', 'export const fee = 5;\n');
  g(dir, 'commit', '-qam', 'Fee\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const head = g(dir, 'rev-parse', 'HEAD');

  let reviews = [];
  const server = http.createServer((req, res) => {
    assert.match(req.url, /^\/repos\/acme\/bank\/pulls\/7\/reviews/);
    assert.strictEqual(req.headers.authorization, 'Bearer t0ken');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reviews));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const eventFile = path.join(tmpDir(), 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7, base: { sha: base }, head: { sha: head }, user: { login: 'sam' } } }));
  const env = { GITHUB_EVENT_PATH: eventFile, GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'acme/bank', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` };

  try {
    reviews = [
      { user: { login: 'ana', type: 'User' }, state: 'APPROVED', commit_id: head },
      { user: { login: 'sam', type: 'User' }, state: 'APPROVED', commit_id: head },
      { user: { login: 'helper[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: head },
      { user: { login: 'raj', type: 'User' }, state: 'APPROVED', commit_id: base },
    ];
    let res = await prCheck({ cwd: dir, env });
    assert.strictEqual(res.ok, false, 'author, bots and stale approvals do not count');
    assert.deepStrictEqual(res.evidence.approvals.approvers, ['ana']);

    reviews.push({ user: { login: 'raj', type: 'User' }, state: 'APPROVED', commit_id: head });
    res = await prCheck({ cwd: dir, env });
    assert.strictEqual(res.ok, true, res.summaryMd);
    assert.deepStrictEqual(res.evidence.approvals.approvers.sort(), ['ana', 'raj']);

    reviews.push({ user: { login: 'raj', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: head });
    res = await prCheck({ cwd: dir, env });
    assert.strictEqual(res.ok, false, 'a later "changes requested" cancels an approval');
  } finally {
    server.close();
  }
});

test('CLI: init, check, rules and verify-log work', () => {
  const dir = tmpDir();
  const cli = path.join(__dirname, '..', 'bin', 'paws.js');
  const run = (...a) => {
    try {
      return { code: 0, out: execFileSync('node', [cli, ...a], { cwd: dir, encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const initOut = run('init', '--claude').out;
  assert.match(initOut, /Created .paws.yml/);
  assert.match(initOut, /Hid 2 path\(s\)/);
  assert.match(run('check', 'secrets/a.pem').out, /hidden from AI/);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /paws\.js" hook$/);
  run('init', '--claude');
  const again = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.strictEqual(again.hooks.PreToolUse.length, 1, 'init is safe to run twice');
  const chk = run('check', 'payments/a.ts', '.github/workflows/x.yml', 'src/a.ts');
  assert.strictEqual(chk.code, 2);
  assert.match(chk.out, /payments\/a.ts: AI edit needs human approval, then 2 PR approval/);
  assert.match(chk.out, /src\/a.ts: AI may edit/);
  assert.match(run('rules').out, /block  \.github\/workflows\/\*\*/);
  assert.match(run('verify-log').out, /intact: 0 entries/);

  const hookOut = execFileSync('node', [cli, 'hook'], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, '.env') } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.strictEqual(JSON.parse(hookOut).hookSpecificOutput.permissionDecision, 'deny');
});

// ---------- editor extension, with a stand-in for the VS Code API ----------

test('editor extension marks protected files, warns on edits, pops up and opens the session panel', async () => {
  const dir = repoWithPolicy();
  const messages = [];
  let provider = null;
  let changeHandler = null;
  const commands = {};
  class Emitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  const uri = (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p });
  let webview = null;
  const fakeVscode = {
    EventEmitter: Emitter,
    ViewColumn: { Beside: -2 },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    FileDecoration: class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerFileDecorationProvider: (p) => { provider = p; return { dispose() {} }; },
      showWarningMessage: (m) => messages.push(m),
      showInformationMessage: (m) => messages.push(m),
      showErrorMessage: (m) => messages.push(m),
      showQuickPick: async () => undefined,
      activeTextEditor: null,
      createTerminal: () => ({ show() {}, sendText() {} }),
      createWebviewPanel: () => {
        webview = { html: '', posted: [], cspSource: 'vscode-webview:', postMessage(m) { this.posted.push(m); }, onDidReceiveMessage(h) { this.handler = h; } };
        return { webview, reveal() {}, onDidDispose() {} };
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => d }),
      workspaceFolders: [{ uri: uri(dir) }],
      getWorkspaceFolder: () => ({ uri: uri(dir) }),
      onDidChangeTextDocument: (h) => { changeHandler = h; return { dispose() {} }; },
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return fakeVscode;
    return realLoad.call(this, request, ...rest);
  };
  try {
    const extPath = path.join(__dirname, '..', 'vscode-extension', 'extension.js');
    delete require.cache[require.resolve(extPath)];
    const ext = require(extPath);
    const api = ext.activate({ subscriptions: [], extensionPath: path.join(__dirname, '..', 'vscode-extension') });
    assert.strictEqual(provider.provideFileDecoration(uri(path.join(dir, 'payments/x.ts'))).badge, 'R');
    assert.strictEqual(provider.provideFileDecoration(uri(path.join(dir, '.github/workflows/ci.yml'))).badge, 'B');
    assert.strictEqual(provider.provideFileDecoration(uri(path.join(dir, 'payments'))).badge, 'R');
    assert.strictEqual(provider.provideFileDecoration(uri(path.join(dir, 'src/app.ts'))), undefined);
    changeHandler({ document: { uri: uri(path.join(dir, 'payments/x.ts')) }, contentChanges: [{}] });
    changeHandler({ document: { uri: uri(path.join(dir, 'payments/x.ts')) }, contentChanges: [{}] });
    assert.strictEqual(messages.filter((m) => /x\.ts is protected/.test(m)).length, 1, 'warns once per file');
    commands['paws.verifyLog']();
    assert.match(messages[messages.length - 1], /intact/);
    assert.strictEqual(api.decisionFor(uri(path.join(dir, '.env'))).action, 'block');
    assert.strictEqual(provider.provideFileDecoration(uri(path.join(dir, 'secrets/prod.pem'))).badge, 'H');

    // A blocked read arrives in the log: one pop-up, offering to show the session.
    hook(dir, { session_id: 'sess-9', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'secrets/prod.pem') } });
    api.checkLog(dir);
    await new Promise((r) => setTimeout(r, 1700));
    assert.ok(messages.some((m) => m === 'Paws stopped the AI reading secrets/prod.pem.'), messages.join(' | '));
    assert.strictEqual(api.popupText([{ event: 'gateway_redacted', found: { EMAIL: 2, NAME: 1 } }]).text, 'Paws swapped 3 values before the AI saw them.');

    // The session panel shows that session's activity.
    commands['paws.openSessions']('sess-9');
    assert.match(webview.html, /script-src 'nonce-[0-9a-f]+'/);
    webview.handler({ type: 'state' });
    const state = JSON.parse(webview.posted.find((m) => m.type === 'state').json);
    assert.strictEqual(state.sessions.find((x) => x.id === 'sess-9').stats.readsBlocked, 1);
    assert.ok(webview.posted.some((m) => m.type === 'focus' && m.session === 'sess-9'));
  } finally {
    Module._load = realLoad;
  }
});

// ---------- local dashboard ----------

test('dashboard: local only, needs the launch token, grouped by session, reveals one value at a time', async () => {
  const { startServer } = require('../lib/ui');
  const dir = repoWithPolicy();
  write(dir, 'data/c.txt', 'Mail jane.citizen@gmail.com now\n');
  hook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'data/c.txt') } });
  hook(dir, { session_id: 's2', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'secrets/k.pem') } });
  const { server, port, token } = await startServer({ root: dir, port: 0 });
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.strictEqual((await fetch(`${base}/api/state`)).status, 403, 'no token, no data');
    const state = await (await fetch(`${base}/api/state`, { headers: { 'x-paws-token': token } })).json();
    assert.deepStrictEqual(state.sessions.map((s) => s.id).sort(), ['s1', 's2']);
    const s1 = state.sessions.find((s) => s.id === 's1');
    assert.strictEqual(s1.stats.replaced, 1);
    assert.strictEqual(state.sessions.find((s) => s.id === 's2').stats.readsBlocked, 1);
    assert.strictEqual(state.totals.replaced, 1);
    assert.strictEqual(state.log.intact, true);
    assert.ok(!JSON.stringify(state).includes('jane.citizen@gmail.com'), 'real values are not in the dashboard data');
    assert.deepStrictEqual(s1.mapping[0].seenIn, ['data/c.txt']);
    const page = await (await fetch(`${base}/?t=${token}`)).text();
    assert.match(page, /What the AI saw/);
    const rev = await (await fetch(`${base}/api/reveal`, { method: 'POST', headers: { 'x-paws-token': token }, body: JSON.stringify({ standIn: s1.mapping[0].standIn }) })).json();
    assert.strictEqual(rev.value, 'jane.citizen@gmail.com');
  } finally {
    server.close();
  }
});

test('dashboard page script is valid JavaScript', () => {
  const { page } = require('../lib/ui-page');
  for (const opts of [{ token: 'tok' }, { webview: true, cspSource: 'vscode-resource:', nonce: 'abc' }]) {
    const html = page(opts);
    const js = html.split(/<script[^>]*>/)[1].split('</script>')[0];
    assert.doesNotThrow(() => new Function(js));
  }
  assert.match(page({ webview: true, nonce: 'abc', cspSource: 'x' }), /script-src 'nonce-abc'/);
});

test('agent: values already in the vault are replaced even in plain sentences', () => {
  const root = tmpDir();
  const vault = new redact.Vault(root);
  redact.redactText('id,full_name\n1,Jane Citizen\n', { vault, mode: 'fake' });
  const r = redact.redactText('Customer 1 is Jane Citizen, as you asked.', { vault, mode: 'fake' });
  assert.strictEqual(r.text, 'Customer 1 is Olivia Walker, as you asked.');
  assert.strictEqual(redact.redactText(r.text, { vault, mode: 'fake' }).text, r.text, 'stand-ins are never redacted twice');
});

test('agent: what leaves the machine is redacted, and replies come back with real values', async () => {
  const { startGateway } = require('../lib/gateway');
  const dir = repoWithPolicy(POLICY + 'redact:\n  mode: fake\n');
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(b) };
      const userText = seen.body.messages[0].content;
      const fakeEmail = userText.match(/[\w.]+@example\.com/)[0];
      if (seen.body.stream) {
        // Split the stand-in across chunks to prove the agent waits for whole blocks.
        const half = Math.floor(fakeEmail.length / 2);
        const events = [
          { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing to ' + fakeEmail.slice(0, half) } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fakeEmail.slice(half) + ' now.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Edit', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"old_string":"' + fakeEmail.slice(0, 5) } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: fakeEmail.slice(5) + '","new_string":"x"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_stop' },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm2', role: 'assistant', content: [{ type: 'text', text: `Noted ${fakeEmail}` }, { type: 'tool_use', id: 't2', name: 'Write', input: { content: `to: ${fakeEmail}` } }] }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const g = await startGateway({ root: dir, port: 0, upstream: `http://127.0.0.1:${upstream.address().port}` });
  const call = (stream) => fetch(`http://127.0.0.1:${g.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'dummy-key-for-test' },
    body: JSON.stringify({
      model: 'm', stream,
      metadata: { user_id: JSON.stringify({ session_id: 'sess-agent' }) },
      system: 'Customer: Jane Citizen, TFN: 123 456 782',
      messages: [
        { role: 'user', content: 'Please email jane.citizen@gmail.com about her 0412 345 678 number' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { note: 'jane.citizen@gmail.com' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'jane.citizen@gmail.com,0412 345 678' }] },
      ],
    }),
  });
  try {
    const json = await (await call(false)).json();
    const out = JSON.stringify(seen.body);
    for (const real of ['jane.citizen@gmail.com', '0412 345 678', 'Jane Citizen', '123 456 782']) assert.ok(!out.includes(real), `${real} must not leave the machine`);
    assert.match(out, /olivia\.walker@example\.com/);
    assert.strictEqual(seen.headers['x-api-key'], 'dummy-key-for-test', 'auth passes through untouched');
    assert.strictEqual(json.content[0].text, 'Noted jane.citizen@gmail.com');
    assert.strictEqual(json.content[1].input.content, 'to: jane.citizen@gmail.com');

    const sse = await (await call(true)).text();
    assert.ok(!sse.includes('example.com'), 'no stand-ins reach the tool');
    assert.match(sse, /"text":"Writing to jane\.citizen@gmail\.com now\."/);
    const toolDelta = sse.split('\n').find((l) => l.includes('input_json_delta'));
    assert.strictEqual(JSON.parse(JSON.parse(toolDelta.slice(5)).delta.partial_json).old_string, 'jane.citizen@gmail.com');
    const logged = ledger.readLedger(dir);
    assert.ok(logged.some((e) => e.event === 'gateway_redacted' && e.session === 'sess-agent'), 'activity is tagged with the session');
    assert.ok(logged.some((e) => e.event === 'gateway_restored'));
  } finally {
    g.server.close();
    upstream.close();
  }
});

// ---------- local database ----------

test('local database: real values are encrypted, shared safely between processes, and old plain files are migrated', () => {
  const store = require('../lib/store');
  assert.ok(store.available(), 'Node has SQLite built in');
  const root = tmpDir();
  const a = new redact.Vault(root);
  const b = new redact.Vault(root); // a second process, e.g. a hook while the agent runs
  const p1 = a.placeholderFor('EMAIL', 'secret.person@bigpond.com', 'fake');
  const p2 = b.placeholderFor('EMAIL', 'other.person@bigpond.com', 'fake');
  assert.notStrictEqual(p1, p2, 'two processes never hand out the same stand-in');
  assert.strictEqual(b.valueOf(p1), 'secret.person@bigpond.com', 'each sees what the other wrote');
  assert.strictEqual(a.placeholderFor('EMAIL', 'other.person@bigpond.com', 'fake'), p2);
  const bytes = fs.readFileSync(a.file).toString('latin1') + (fs.existsSync(a.file + '-wal') ? fs.readFileSync(a.file + '-wal').toString('latin1') : '');
  assert.ok(!bytes.includes('secret.person'), 'no readable real value in the database file');
  assert.strictEqual(fs.statSync(a.file).mode & 0o777, 0o600);

  // An older plain JSON vault is moved in and deleted.
  const root2 = tmpDir();
  const oldFile = path.join(process.env.PAWS_HOME, 'vault', `${redact.rootId(root2)}.json`);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ counters: { NAME: 1 }, byKey: { 'NAME\u0000Old Person': '[NAME_1]' }, byPlaceholder: { '[NAME_1]': 'Old Person' } }));
  const migrated = new redact.Vault(root2);
  assert.strictEqual(migrated.valueOf('[NAME_1]'), 'Old Person');
  assert.ok(!fs.existsSync(oldFile), 'the plain file is gone');

  // Without SQLite (older Node), a private file is used instead.
  const fv = new redact.Vault(tmpDir(), { PAWS_STORE: 'files' });
  assert.ok(fv instanceof redact.FileVault);
});

test('local database: events are recorded without values, across repos', () => {
  const store = require('../lib/store');
  const dir = repoWithPolicy();
  write(dir, 'x.txt', 'ring 0412 345 678\n');
  hook(dir, { session_id: 'db-sess', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'x.txt') } });
  const recent = store.recentEvents({ limit: 20 });
  const mine = recent.find((e) => e.root === dir && e.session === 'db-sess');
  assert.ok(mine && mine.event === 'redacted' && mine.found.PHONE === 1);
  assert.ok(!JSON.stringify(recent).includes('0412 345 678'));
});

test('privacy: the only outside connections are the AI provider (via the agent) and GitHub (in CI)', () => {
  // Every file that can open a network connection, and why. Anything new fails this test.
  const allowed = {
    'lib/gateway.js': 'forwards AI tool traffic, after redaction, to the provider the tool already uses',
    'lib/pr-check.js': 'reads the pull request from the GitHub API, inside GitHub Actions only',
    'lib/local-model-worker.js': 'talks to a model on this machine (loopback only)',
    'lib/ui.js': 'serves the dashboard on 127.0.0.1',
    'lib/popup.js': 'serves the pop-up on 127.0.0.1',
  };
  const NET = /require\(['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]\)|\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|sendBeacon/;
  const root = path.join(__dirname, '..');
  const files = ['bin/paws.js', 'vscode-extension/extension.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => 'lib/' + f)];
  const found = files.filter((f) => f.endsWith('.js') && !f.endsWith('-page.js') && NET.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(found.sort(), Object.keys(allowed).sort());
  // The pages only ever call back to the local server they came from.
  for (const f of ['lib/ui-page.js', 'lib/popup-page.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(src), f + ' has no outside addresses');
    assert.ok(/connect-src 'self'|connect-src \$\{|cspSource/.test(src) || f.includes('ui-page'), f + ' locks connections to itself');
  }
  // No outside address anywhere except the two the product exists to talk to.
  const hosts = new Set();
  for (const f of files) for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
  for (const h of hosts) assert.ok(['127.0.0.1', 'localhost', 'api.anthropic.com', 'api.github.com', 'www.w3.org'].includes(h), 'unexpected address ' + h);
});

test('privacy: a local model on another machine is refused', () => {
  const lm = require('../lib/local-model');
  assert.ok(lm.isLoopback('http://127.0.0.1:11434') && lm.isLoopback('http://localhost:11434') && lm.isLoopback('http://[::1]:11434'));
  assert.ok(!lm.isLoopback('http://10.0.0.5:11434') && !lm.isLoopback('https://models.example.com'));
  assert.deepStrictEqual(lm.detectWithLocalModel('Jane Citizen', { localModel: 'ollama:x', localModelUrl: 'https://models.example.com' }), []);
});

test('pop-up: feed across repos, token required, only recorded repos open', async () => {
  const store = require('../lib/store');
  const { startPopup, describeForNotice } = require('../lib/popup');
  const dir = repoWithPolicy();
  store.recordEvent(dir, { session: 'pop-1', event: 'read_blocked', path: '.env' });
  store.recordEvent(dir, { session: 'pop-1', event: 'redacted', path: 'c.csv', found: { EMAIL: 2, NAME: 3 } });
  const p = await startPopup({ port: 0, notifications: false });
  try {
    const base = 'http://127.0.0.1:' + p.port;
    assert.strictEqual((await fetch(base + '/api/feed')).status, 403);
    const feed = await (await fetch(base + '/api/feed', { headers: { 'x-paws-token': p.token } })).json();
    assert.strictEqual(feed.current.root, dir);
    assert.strictEqual(feed.current.kept, 5);
    assert.ok(feed.today.stopped >= 1);
    assert.strictEqual((await fetch(base + '/full?t=' + p.token + '&root=' + encodeURIComponent(dir))).status, 200);
    assert.strictEqual((await fetch(base + '/api/state?t=' + p.token + '&root=/etc')).status, 404);
    assert.strictEqual(p.server.address().address, '127.0.0.1');
    const html = await (await fetch(base + '/?t=' + p.token)).text();
    new Function(html.split('<script>')[1].split('</script>')[0]);
  } finally {
    p.server.close();
  }
  assert.strictEqual(describeForNotice({ event: 'read_blocked', path: '.env' }), 'Stopped the AI reading .env.');
  assert.strictEqual(describeForNotice({ event: 'redacted' }), null);
});
