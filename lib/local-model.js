'use strict';

// Optional local AI model for things patterns can't catch, such as names,
// addresses written loosely, and internal confidential terms.
// It talks only to a model server on this machine (Ollama by default), so text
// never leaves the laptop. If the server isn't running, PawsOff carries on
// with its built-in detectors.
//
// Policy:  redact:
//            local_model: "ollama:llama3.2"      # model name
//            local_model_url: "http://127.0.0.1:11434"

const path = require('path');
const { execFileSync } = require('child_process');

const PROMPT = `You find personal and confidential information in text for a redaction tool.
Return JSON only: {"items":[{"type":"NAME|ADDRESS|CONFIDENTIAL","text":"<exact substring>"}]}
- NAME: a real person's name (not code identifiers, products or companies).
- ADDRESS: a street or postal address.
- CONFIDENTIAL: internal project code names, unreleased financial figures, or customer identifiers.
Copy each "text" exactly as it appears. Return {"items":[]} if there is nothing.

Text:
`;

// The model must run on this machine. Any other address is refused, so text
// meant for redaction can never be sent somewhere else by a policy change.
function isLoopback(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch (e) {
    return false;
  }
}

function parseModelSpec(spec) {
  const s = String(spec || '');
  if (!s) return null;
  const [provider, ...rest] = s.split(':');
  if (provider !== 'ollama' || !rest.length) return null;
  return { provider, model: rest.join(':') };
}

// Synchronous so the hook can stay simple; runs the request in a child process.
function detectWithLocalModel(text, opts) {
  const spec = parseModelSpec(opts.localModel);
  if (!spec) return [];
  const url = (opts.localModelUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  if (!isLoopback(url)) return [];
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'local-model-worker.js')], {
      input: JSON.stringify({ url, model: spec.model, prompt: PROMPT + String(text).slice(0, 12000) }),
      encoding: 'utf8',
      timeout: opts.timeoutMs || 15000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const items = JSON.parse(out).items || [];
    const findings = [];
    for (const it of items) {
      const needle = String(it.text || '').trim();
      if (needle.length < 3) continue;
      const label = ['NAME', 'ADDRESS', 'CONFIDENTIAL'].includes(it.type) ? it.type : 'CONFIDENTIAL';
      let i = text.indexOf(needle);
      while (i !== -1) {
        findings.push({ start: i, end: i + needle.length, type: label.toLowerCase(), label });
        i = text.indexOf(needle, i + needle.length);
      }
    }
    return findings;
  } catch (e) {
    return [];
  }
}

module.exports = { detectWithLocalModel, parseModelSpec, isLoopback, PROMPT };
