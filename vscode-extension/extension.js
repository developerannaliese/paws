'use strict';

// AI Guard for VS Code, Cursor and Windsurf.
// Shows which files are protected from AI edits, warns when a protected file
// changes, pops up when AI Guard swaps data or stops something, and opens a
// session panel showing what happened. Reads only files and the database on this machine.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadPolicy, decide, decideRead } = require('./lib/policy');
const ledger = require('./lib/ledger');
const { buildState, reveal } = require('./lib/ui');
const { page } = require('./lib/ui-page');

function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

// One short sentence for a pop-up, from a batch of new log entries.
function popupText(entries) {
  let swapped = 0;
  let stopped = 0;
  let asked = 0;
  for (const e of entries) {
    if (e.event === 'redacted' || e.event === 'gateway_redacted') swapped += Object.values(e.found || {}).reduce((a, b) => a + b, 0);
    if (e.event === 'blocked' || e.event === 'read_blocked') stopped++;
    if (e.event === 'asked') asked++;
  }
  const parts = [];
  if (swapped) parts.push(`swapped ${plural(swapped, 'value')} before the AI saw them`);
  if (stopped) {
    const first = entries.find((e) => e.event === 'blocked' || e.event === 'read_blocked');
    parts.push(stopped === 1 && first.path ? `stopped the AI ${first.event === 'read_blocked' ? 'reading' : 'editing'} ${first.path}` : `stopped ${plural(stopped, 'AI action')}`);
  }
  if (asked) parts.push(`needs your approval for ${plural(asked, 'edit')}`);
  if (!parts.length) return null;
  return { text: `AI Guard ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`, serious: stopped > 0 };
}

const LABELS = {
  hidden: { badge: 'H', color: 'errorForeground', text: 'Hidden from AI tools' },
  block: { badge: 'B', color: 'errorForeground', text: 'AI edits blocked' },
  review: { badge: 'R', color: 'editorWarning.foreground', text: 'AI edits need human review' },
  warn: { badge: 'W', color: 'editorInfo.foreground', text: 'AI edits are flagged' },
};

function activate(context) {
  const policies = new Map(); // workspace folder path -> policy
  const changed = new vscode.EventEmitter();
  const warned = new Set();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'aiguard.openSessions';
  context.subscriptions.push(status, changed);

  function reload() {
    policies.clear();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      try {
        const p = loadPolicy(folder.uri.fsPath);
        if (p && p.root === folder.uri.fsPath) policies.set(folder.uri.fsPath, p);
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }
    const count = [...policies.values()].reduce((n, p) => n + p.userRuleCount, 0);
    status.text = count ? `$(shield) AI Guard: ${count} rule${count === 1 ? '' : 's'}` : '$(shield) AI Guard: no policy';
    status.tooltip = count ? 'Click to see what AI Guard did in each AI session.' : 'No .aiguard.yml in this workspace. Run "AI Guard: Create policy".';
    status.show();
    changed.fire(undefined);
  }

  function decisionFor(uri) {
    if (!uri || uri.scheme !== 'file') return null;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return null;
    const policy = policies.get(folder.uri.fsPath);
    if (!policy) return null;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return null;
    const hidden = decideRead(policy, rel);
    if (hidden.action === 'block') return { ...hidden, action: 'hidden' };
    return decide(policy, rel);
  }

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: changed.event,
      provideFileDecoration(uri) {
        const d = decisionFor(uri);
        if (!d || d.action === 'allow') return undefined;
        const l = LABELS[d.action];
        const extra = d.action === 'review' ? ` (${d.reviewers || 1} reviewer${(d.reviewers || 1) === 1 ? '' : 's'})` : '';
        return new vscode.FileDecoration(l.badge, `AI Guard: ${l.text}${extra}${d.reason ? '. ' + d.reason : ''}`, new vscode.ThemeColor(l.color));
      },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges || !e.contentChanges.length) return;
      const d = decisionFor(e.document.uri);
      if (!d || d.action === 'allow') return;
      const key = e.document.uri.toString();
      if (warned.has(key)) return;
      warned.add(key);
      const name = path.basename(e.document.uri.fsPath);
      const what = {
        hidden: 'AI tools may not read or change it. Your own edits are fine.',
        block: 'AI tools may not change it. Your own edits are fine.',
        review: `AI changes need ${d.reviewers || 1} human approval(s) on the pull request.`,
        warn: 'AI changes are logged and flagged on the pull request.',
      }[d.action];
      vscode.window.showWarningMessage(`AI Guard: ${name} is protected. ${what}`);
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/.aiguard.{yml,yaml,json}');
  watcher.onDidChange(reload);
  watcher.onDidCreate(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reload));

  context.subscriptions.push(
    vscode.commands.registerCommand('aiguard.showRules', async () => {
      const items = [];
      for (const p of policies.values()) {
        for (const r of p.rules) {
          items.push({
            label: r.path,
            description: (r.ai_read === 'block' ? 'hidden' : r.ai_edit) + (r.ai_edit === 'review' ? ` · ${r.reviewers || 1} reviewer(s)` : '') + (r.builtIn ? ' · built in' : ''),
            detail: r.reason || undefined,
          });
        }
      }
      if (!items.length) {
        vscode.window.showInformationMessage('No .aiguard.yml in this workspace. Run "AI Guard: Create policy".');
        return;
      }
      await vscode.window.showQuickPick(items, { placeHolder: 'Files protected from AI edits' });
    }),

    vscode.commands.registerCommand('aiguard.checkFile', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return vscode.window.showInformationMessage('Open a file first.');
      const d = decisionFor(ed.document.uri);
      if (!d) return vscode.window.showInformationMessage('No AI Guard policy covers this file.');
      const text = d.action === 'allow' ? 'AI tools may edit this file.' : `${LABELS[d.action].text} (rule ${d.rules.join(', ')}).`;
      vscode.window.showInformationMessage(`AI Guard: ${text}`);
    }),

    vscode.commands.registerCommand('aiguard.verifyLog', () => {
      const results = [];
      for (const p of policies.values()) {
        const v = ledger.verifyEntries(ledger.readLedger(p.root));
        results.push(v.ok ? `intact (${v.count} entries)` : `broken: ${v.reason}`);
      }
      if (!results.length) return vscode.window.showInformationMessage('No AI Guard policy in this workspace.');
      const bad = results.some((r) => r.startsWith('broken'));
      (bad ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(`AI Guard edit log: ${results.join('; ')}`);
    }),

    vscode.commands.registerCommand('aiguard.init', async () => {
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      if (!folder) return vscode.window.showInformationMessage('Open a folder first.');
      const term = vscode.window.createTerminal('AI Guard');
      term.show();
      term.sendText(`node "${path.join(context.extensionPath, 'bin', 'aiguard.js')}" init --claude`);
    })
  );

  // ---------- session panel ----------
  let panel = null;
  const firstRoot = () => {
    const p = [...policies.values()][0];
    return p ? p.root : ((vscode.workspace.workspaceFolders || [])[0] || { uri: { fsPath: process.cwd() } }).uri.fsPath;
  };
  function openSessions(sessionId) {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      panel = vscode.window.createWebviewPanel('aiguard.sessions', 'AI Guard', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
      const nonce = crypto.randomBytes(16).toString('hex');
      panel.webview.html = page({ webview: true, cspSource: panel.webview.cspSource, nonce });
      panel.webview.onDidReceiveMessage((m) => {
        const root = firstRoot();
        if (m.type === 'state') {
          try {
            panel.webview.postMessage({ type: 'state', json: JSON.stringify(buildState(root)) });
          } catch (e) {
            /* the page keeps showing the last good state */
          }
        }
        if (m.type === 'reveal') {
          const value = reveal(root, m.standIn);
          if (value !== undefined) panel.webview.postMessage({ type: 'revealed', standIn: m.standIn, value });
        }
      });
      panel.onDidDispose(() => (panel = null));
    }
    if (sessionId) panel.webview.postMessage({ type: 'focus', session: sessionId });
  }
  context.subscriptions.push(vscode.commands.registerCommand('aiguard.openSessions', (id) => openSessions(id)));

  // ---------- pop-ups when something happens ----------
  const seen = new Map(); // root -> entries already handled
  let batch = [];
  let timer = null;
  function checkLog(root) {
    const entries = ledger.readLedger(root);
    const before = seen.has(root) ? seen.get(root) : entries.length; // don't replay history on start-up
    seen.set(root, entries.length);
    const fresh = entries.slice(Math.min(before, entries.length));
    if (!fresh.length) return;
    batch.push(...fresh);
    clearTimeout(timer);
    // Group bursts (one AI action often logs several entries) into one pop-up.
    timer = setTimeout(() => {
      const items = batch;
      batch = [];
      const level = vscode.workspace.getConfiguration('aiguard').get('popups', 'important');
      if (level === 'off') return;
      const msg = popupText(items);
      if (!msg) return;
      // "important": only when something was stopped or needs approval; "all": swaps too.
      if (level === 'important' && !msg.serious && !items.some((e) => e.event === 'asked')) return;
      const session = [...items].reverse().find((e) => e.session);
      const show = msg.serious ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      Promise.resolve(show(msg.text, 'Show session')).then((pick) => {
        if (pick === 'Show session') openSessions(session ? session.session : undefined);
      });
    }, 1500);
  }
  const logWatcher = vscode.workspace.createFileSystemWatcher('**/.aiguard/ledger.jsonl');
  const onLog = (uri) => checkLog(path.dirname(path.dirname(uri.fsPath)));
  logWatcher.onDidChange(onLog);
  logWatcher.onDidCreate(onLog);
  context.subscriptions.push(logWatcher);

  reload();
  for (const p of policies.values()) checkLog(p.root);
  return { reload, decisionFor, openSessions, checkLog, popupText };
}

function deactivate() {}

module.exports = { activate, deactivate };
