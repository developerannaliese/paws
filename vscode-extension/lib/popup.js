'use strict';

// `paws popup`: the companion that sits in the corner of the screen.
//  - a small live window, bottom-right (an app-style browser window, no tabs or address bar)
//  - a native notification when Paws stops something or needs approval
// It reads the local database only; it serves on 127.0.0.1 behind a one-time token.

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const store = require('./store');
const { popupPage } = require('./popup-page');
const { page } = require('./ui-page');
const { buildState, reveal } = require('./ui');
const { loadPolicy, findPolicyFile } = require('./policy');
const { parseYaml, writeYaml } = require('./yaml');

function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

function feed(env) {
  const events = store.recentEvents({ limit: 500 }, env);
  const today = { kept: 0, stopped: 0, asked: 0, restored: 0, sessions: 0 };
  const sessions = new Set();
  for (const e of events) {
    if (!isToday(e.ts)) continue;
    if (e.session) sessions.add(e.session);
    if (e.event === 'redacted' || e.event === 'gateway_redacted') today.kept += Object.values(e.found || {}).reduce((a, b) => a + b, 0);
    if (e.event === 'blocked' || e.event === 'read_blocked') today.stopped++;
    if (e.event === 'asked') today.asked++;
    if (e.event === 'restored' || e.event === 'gateway_restored') today.restored += e.count || 0;
  }
  today.sessions = sessions.size;
  let current = null;
  if (events.length) {
    const top = events[0];
    const same = events.filter((e) => e.root === top.root && (e.session || null) === (top.session || null));
    current = { root: top.root, repo: path.basename(top.root), session: top.session, kept: 0, stopped: 0, asked: 0 };
    for (const e of same) {
      if (e.event === 'redacted' || e.event === 'gateway_redacted') current.kept += Object.values(e.found || {}).reduce((a, b) => a + b, 0);
      if (e.event === 'blocked' || e.event === 'read_blocked') current.stopped++;
      if (e.event === 'asked') current.asked++;
    }
  }
  return {
    today,
    current,
    events: events.slice(0, 30).map((e) => ({ ts: e.ts, event: e.event, path: e.path && !e.path.startsWith('/v1/') ? e.path : null, found: e.found, count: e.count, repo: path.basename(e.root) })),
  };
}

// Native notification, using what the operating system already has.
function notify(title, message) {
  const opts = { stdio: 'ignore', timeout: 5000 };
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], opts);
    } else if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Shield; $n.Visible = $true; $n.ShowBalloonTip(5000, ${JSON.stringify(title)}, ${JSON.stringify(message)}, 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`;
      spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', detached: true }).unref();
    } else {
      execFileSync('notify-send', ['-a', 'Paws', title, message], opts);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function describeForNotice(e) {
  const where = e.path && !e.path.startsWith('/v1/') ? e.path : 'a protected file';
  if (e.event === 'read_blocked') return `Stopped the AI reading ${where}.`;
  if (e.event === 'blocked') return `Stopped an AI edit to ${where}.`;
  if (e.event === 'asked') return `An AI edit to ${where} needs your approval.`;
  return null;
}

function findBrowser() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
  }[process.platform];
  if (candidates) return candidates.find((p) => p && fs.existsSync(p)) || null;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (e) {
      /* try the next one */
    }
  }
  return null;
}

function screenSize() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { encoding: 'utf8', timeout: 3000 });
      const [, , w, h] = out.split(',').map((x) => Number(x.trim()));
      if (w && h) return { w, h };
    }
  } catch (e) {
    /* fall back to letting the window place itself */
  }
  return null;
}

// Open the small window in the bottom-right corner.
function openCornerWindow(url, env) {
  const W = 380;
  const H = 520;
  const browser = findBrowser();
  if (browser) {
    const size = screenSize();
    const args = [`--app=${url}`, `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(store.homeDir(env), 'popup-window')}`];
    if (size) args.push(`--window-position=${size.w - W - 16},${size.h - H - 48}`);
    spawn(browser, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return 'window';
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  return 'browser';
}

function knownRoots(env) {
  return new Set(store.recentEvents({ limit: 2000 }, env).map((e) => e.root));
}

function startPopup({ port = 4478, env = process.env, notifications = true } = {}) {
  if (!store.available()) throw new Error('The pop-up needs Node 22.5 or newer (it reads the local SQLite database).');
  const token = crypto.randomBytes(18).toString('hex');
  const okHost = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(h || ''));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const given = req.headers['x-paws-token'] || url.searchParams.get('t');
    if (!okHost(req.headers.host) || given !== token) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Paws: open the pop-up from the paws popup command.');
      return;
    }
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // Only repos Paws has actually recorded can be opened.
    const rootParam = url.searchParams.get('root');
    const root = rootParam && knownRoots(env).has(rootParam) ? rootParam : null;
    if (req.method === 'GET' && url.pathname === '/') return send(200, popupPage(token), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/feed') return send(200, feed(env));
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      // Settings from the most recently active repo, or the root param
      const settingsRoot = root || (store.recentEvents({ limit: 1 }, env)[0] || {}).root;
      let settings = { redactEnabled: false, mode: 'placeholder', localModel: null, shellOutput: false, rules: [], policyFile: null, repo: null };
      if (settingsRoot) {
        try {
          const policy = loadPolicy(settingsRoot);
          if (policy) {
            settings.redactEnabled = !!(policy.redact && policy.redact.enabled);
            settings.mode = (policy.redact && policy.redact.mode) || 'placeholder';
            settings.localModel = (policy.redact && policy.redact.localModel) || null;
            settings.shellOutput = !!(policy.redact && policy.redact.shellOutput);
            settings.rules = policy.rules.filter(r => !r.builtIn).map(r => ({ path: r.path, ai_edit: r.ai_edit, ai_read: r.ai_read, reason: r.reason }));
            settings.custom = policy.redact.custom || [];
            settings.policyFile = path.basename(policy.file);
            settings.repo = path.basename(policy.root);
          }
        } catch (e) { /* use defaults */ }
      }
      return send(200, settings);
    }
    // POST /api/settings - update policy from the popup UI
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const changes = JSON.parse(body || '{}');
          const settingsRoot = root || (store.recentEvents({ limit: 1 }, env)[0] || {}).root;
          if (!settingsRoot) return send(400, { error: 'No repo found' });
          const policyFile = findPolicyFile(settingsRoot);
          if (!policyFile) return send(400, { error: 'No .paws.yml found' });
          const raw = parseYaml(fs.readFileSync(policyFile, 'utf8'));

          // Toggle redaction
          if ('enabled' in changes) {
            if (!raw.redact || typeof raw.redact !== 'object') raw.redact = {};
            raw.redact.enabled = !!changes.enabled;
          }
          // Switch mode
          if ('mode' in changes && ['placeholder', 'fake'].includes(changes.mode)) {
            if (!raw.redact || typeof raw.redact !== 'object') raw.redact = {};
            raw.redact.mode = changes.mode;
          }
          // Add custom label
          if (changes.addCustom && changes.addCustom.label && changes.addCustom.pattern) {
            if (!raw.redact || typeof raw.redact !== 'object') raw.redact = {};
            if (!Array.isArray(raw.redact.custom)) raw.redact.custom = [];
            raw.redact.custom.push({
              label: String(changes.addCustom.label).toUpperCase(),
              pattern: String(changes.addCustom.pattern),
              ...(changes.addCustom.near ? { near: changes.addCustom.near } : {}),
              ...(changes.addCustom.columns ? { columns: changes.addCustom.columns } : {}),
            });
          }
          // Remove custom label
          if (changes.removeCustom && Array.isArray(raw.redact && raw.redact.custom)) {
            raw.redact.custom = raw.redact.custom.filter(c => c.label !== changes.removeCustom);
            if (!raw.redact.custom.length) delete raw.redact.custom;
          }
          // Add rule
          if (changes.addRule && changes.addRule.path) {
            if (!Array.isArray(raw.rules)) raw.rules = [];
            raw.rules.push(changes.addRule);
          }

          fs.writeFileSync(policyFile, writeYaml(raw));
          return send(200, { ok: true });
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/full' && root) return send(200, page({ token, root }), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state' && root) return send(200, buildState(root, env));
    if (req.method === 'POST' && url.pathname === '/api/reveal' && root) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const value = reveal(root, JSON.parse(body || '{}').standIn, env);
          return value === undefined ? send(404, { error: 'Not in the vault' }) : send(200, { value, standIn: JSON.parse(body).standIn });
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
      return;
    }
    send(404, { error: 'Not found' });
  });

  // Watch the local database for things worth a notification.
  let lastId = (store.recentEvents({ limit: 1 }, env)[0] || { id: 0 }).id;
  const sent = [];
  const timer = setInterval(() => {
    const fresh = store.recentEvents({ sinceId: lastId, limit: 50 }, env).reverse();
    if (!fresh.length) return;
    lastId = fresh[fresh.length - 1].id;
    if (!notifications) return;
    const notices = fresh.map(describeForNotice).filter(Boolean);
    if (notices.length === 1) sent.push(notices[0]) && notify('Paws', notices[0]);
    else if (notices.length > 1) sent.push(`${notices.length} things`) && notify('Paws', `${notices[0]} And ${notices.length - 1} more.`);
  }, 1500);
  server.on('close', () => clearInterval(timer));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ server, port: p, token, url: `http://127.0.0.1:${p}/?t=${token}`, sent });
    });
  });
}

module.exports = { startPopup, openCornerWindow, feed, notify, describeForNotice, findBrowser };
