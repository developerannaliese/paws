'use strict';

// The local agent: a gateway on 127.0.0.1 that AI tools send their model traffic
// through. Outgoing requests have personal and confidential data swapped for
// stand-ins; replies have real values put back before the tool acts on them.
// Real values never leave this machine. Works with Claude Code today
// (ANTHROPIC_BASE_URL) and any tool that speaks the Anthropic Messages API.

const http = require('http');
const { loadPolicy } = require('./policy');
const redact = require('./redact');
const ledger = require('./ledger');

const DROP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'te', 'upgrade']);
const DROP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

function makeContext(root, env) {
  const policy = loadPolicy(root);
  if (!policy) throw new Error('No .paws.yml here. Run "paws init" first.');
  const vault = new redact.Vault(policy.root, env);
  const opts = { types: policy.redact.types, allowEmails: policy.redact.allowEmails, mode: policy.redact.mode, vault };
  return { policy, vault, opts };
}

// ---------- outgoing: redact ----------

function redactString(s, ctx, tally) {
  if (typeof s !== 'string' || !s) return s;
  const r = redact.redactText(s, ctx.opts);
  for (const [k, n] of Object.entries(r.summary)) tally[k] = (tally[k] || 0) + n;
  if (ctx.standins) for (const x of r.standins) ctx.standins.add(x);
  return r.text;
}

function redactDeep(value, ctx, tally) {
  if (typeof value === 'string') return redactString(value, ctx, tally);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, ctx, tally));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, ctx, tally);
    return out;
  }
  return value;
}

function redactBlocks(content, ctx, tally) {
  if (typeof content === 'string') return redactString(content, ctx, tally);
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (!b || typeof b !== 'object') return b;
    switch (b.type) {
      case 'text':
        return { ...b, text: redactString(b.text, ctx, tally) };
      case 'tool_result':
        return { ...b, content: redactBlocks(b.content, ctx, tally) };
      case 'tool_use':
      case 'server_tool_use':
        return { ...b, input: redactDeep(b.input, ctx, tally) };
      case 'document':
        if (b.source && b.source.type === 'text') return { ...b, source: { ...b.source, data: redactString(b.source.data, ctx, tally) } };
        return b;
      default:
        // thinking blocks are signed by the model; images and other binary data are passed as they are
        return b;
    }
  });
}

// Claude Code puts its session ID in request metadata; use it to group activity.
function sessionOf(body) {
  try {
    const uid = body && body.metadata && body.metadata.user_id;
    if (!uid) return null;
    const parsed = typeof uid === 'string' && uid.trim().startsWith('{') ? JSON.parse(uid) : null;
    if (parsed && parsed.session_id) return String(parsed.session_id);
    const m = String(uid).match(/session_([0-9a-f-]{8,})/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function redactRequest(body, ctx) {
  const tally = {};
  ctx.standins = new Set();
  const out = { ...body };
  if (typeof out.system === 'string') out.system = redactString(out.system, ctx, tally);
  else if (Array.isArray(out.system)) out.system = redactBlocks(out.system, ctx, tally);
  if (Array.isArray(out.messages)) out.messages = out.messages.map((m) => ({ ...m, content: redactBlocks(m.content, ctx, tally) }));
  return { body: out, tally };
}

// ---------- OpenAI Chat Completions format ----------

function redactOpenAIContent(content, ctx, tally) {
  if (typeof content === 'string') return redactString(content, ctx, tally);
  if (Array.isArray(content)) return content.map((p) => {
    if (p && p.type === 'text') return { ...p, text: redactString(p.text, ctx, tally) };
    return p;
  });
  return content;
}

function redactOpenAIRequest(body, ctx) {
  const tally = {};
  ctx.standins = new Set();
  const out = { ...body };
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      const msg = { ...m };
      if (msg.content != null) msg.content = redactOpenAIContent(msg.content, ctx, tally);
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls.map((tc) => {
          if (tc.function && typeof tc.function.arguments === 'string') {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              return { ...tc, function: { ...tc.function, arguments: JSON.stringify(redactDeep(parsed, ctx, tally)) } };
            } catch (e) {
              return { ...tc, function: { ...tc.function, arguments: redactString(tc.function.arguments, ctx, tally) } };
            }
          }
          return tc;
        });
      }
      return msg;
    });
  }
  return { body: out, tally };
}

function restoreOpenAIResponse(body, ctx, counter) {
  if (!body || !Array.isArray(body.choices)) return body;
  return {
    ...body,
    choices: body.choices.map((c) => {
      if (!c.message) return c;
      const msg = { ...c.message };
      if (typeof msg.content === 'string') {
        const r = redact.restoreText(msg.content, ctx.vault);
        counter.n += r.restored;
        msg.content = r.text;
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls.map((tc) => {
          if (tc.function && typeof tc.function.arguments === 'string') {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              const restored = restoreDeep(parsed, ctx, counter);
              return { ...tc, function: { ...tc.function, arguments: JSON.stringify(restored) } };
            } catch (e) {
              const r = redact.restoreText(tc.function.arguments, ctx.vault);
              counter.n += r.restored;
              return { ...tc, function: { ...tc.function, arguments: r.text } };
            }
          }
          return tc;
        });
      }
      return { ...c, message: msg };
    }),
  };
}

// OpenAI SSE streaming: holds text and tool call argument deltas until a finish
// reason appears, then emits the buffered content with real values restored.
class OpenAIStreamRestorer {
  constructor(ctx, counter) {
    this.ctx = ctx;
    this.counter = counter;
    this.buf = '';
    this.textBuf = '';
    this.toolArgsBuf = '';
    this.toolIndex = null;
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      out += this.handle(raw);
    }
    return out;
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.handle(rest) : '';
  }

  handle(raw) {
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) return raw + '\n\n';
    const payload = dataLine.slice(5).trim();
    if (payload === '[DONE]') {
      let out = this._flushBuffered();
      return out + raw + '\n\n';
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      return raw + '\n\n';
    }
    if (!data.choices || !data.choices[0]) return raw + '\n\n';
    const delta = data.choices[0].delta;
    const finish = data.choices[0].finish_reason;
    if (delta) {
      if (typeof delta.content === 'string') {
        this.textBuf += delta.content;
        return '';
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls[0]) {
        const tc = delta.tool_calls[0];
        if (tc.function && typeof tc.function.arguments === 'string') {
          this.toolArgsBuf += tc.function.arguments;
          if (this.toolIndex === null) this.toolIndex = tc.index != null ? tc.index : 0;
        }
        // Pass through non-argument tool call deltas (function name, id)
        if (!tc.function || typeof tc.function.arguments !== 'string') return raw + '\n\n';
        return '';
      }
    }
    if (finish) {
      let out = this._flushBuffered();
      return out + raw + '\n\n';
    }
    return raw + '\n\n';
  }

  _flushBuffered() {
    let out = '';
    if (this.textBuf) {
      const restored = restoreDeep(this.textBuf, this.ctx, this.counter);
      const obj = { choices: [{ index: 0, delta: { content: restored } }] };
      out += `data: ${JSON.stringify(obj)}\n\n`;
      this.textBuf = '';
    }
    if (this.toolArgsBuf) {
      let args = this.toolArgsBuf;
      try {
        args = JSON.stringify(restoreDeep(JSON.parse(this.toolArgsBuf), this.ctx, this.counter));
      } catch (e) { /* pass through */ }
      const idx = this.toolIndex != null ? this.toolIndex : 0;
      const obj = { choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: args } }] } }] };
      out += `data: ${JSON.stringify(obj)}\n\n`;
      this.toolArgsBuf = '';
      this.toolIndex = null;
    }
    return out;
  }
}

// ---------- incoming: restore ----------

function restoreDeep(value, ctx, counter) {
  if (typeof value === 'string') {
    const r = redact.restoreText(value, ctx.vault);
    counter.n += r.restored;
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, ctx, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v, ctx, counter);
    return out;
  }
  return value;
}

function restoreMessage(msg, ctx, counter) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (b.type === 'text') return { ...b, text: restoreDeep(b.text, ctx, counter) };
      if (b.type === 'tool_use') return { ...b, input: restoreDeep(b.input, ctx, counter) };
      return b;
    }),
  };
}

// Server-sent events: hold each text or tool-call block until it ends, then
// send it once with real values put back. Stand-ins can't be split across chunks.
class StreamRestorer {
  constructor(ctx, counter) {
    this.ctx = ctx;
    this.counter = counter;
    this.buf = '';
    this.blocks = new Map();
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      out += this.handle(raw);
    }
    return out;
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.handle(rest) : '';
  }

  handle(raw) {
    const lines = raw.split('\n');
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!dataLine) return raw + '\n\n';
    let data;
    try {
      data = JSON.parse(dataLine.slice(5).trim());
    } catch (e) {
      return raw + '\n\n';
    }
    const ev = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
    if (data.type === 'content_block_start') {
      const t = data.content_block && data.content_block.type;
      if (t === 'text' || t === 'tool_use') this.blocks.set(data.index, { type: t, text: '', json: '' });
      return raw + '\n\n';
    }
    if (data.type === 'content_block_delta' && this.blocks.has(data.index)) {
      const b = this.blocks.get(data.index);
      if (data.delta.type === 'text_delta') b.text += data.delta.text;
      else if (data.delta.type === 'input_json_delta') b.json += data.delta.partial_json;
      else return raw + '\n\n';
      return '';
    }
    if (data.type === 'content_block_stop' && this.blocks.has(data.index)) {
      const b = this.blocks.get(data.index);
      this.blocks.delete(data.index);
      let out = '';
      if (b.type === 'text' && b.text) {
        out += ev('content_block_delta', { type: 'content_block_delta', index: data.index, delta: { type: 'text_delta', text: restoreDeep(b.text, this.ctx, this.counter) } });
      }
      if (b.type === 'tool_use' && b.json) {
        let json = b.json;
        try {
          json = JSON.stringify(restoreDeep(JSON.parse(b.json), this.ctx, this.counter));
        } catch (e) {
          /* not complete JSON; pass through as it came */
        }
        out += ev('content_block_delta', { type: 'content_block_delta', index: data.index, delta: { type: 'input_json_delta', partial_json: json } });
      }
      return out + raw + '\n\n';
    }
    return raw + '\n\n';
  }
}

// ---------- server ----------

function log(ctx, fields) {
  try {
    const entry = ledger.appendEntry(ctx.policy.root, { agent: 'gateway', ...fields });
    require('./store').recordEvent(ctx.policy.root, entry);
  } catch (e) {
    /* never break the AI tool over logging */
  }
}

function startGateway({ root = process.cwd(), port = 4480, upstream, env = process.env } = {}) {
  const target = (upstream || env.PAWS_UPSTREAM || 'https://api.anthropic.com').replace(/\/$/, '');
  const ctx = makeContext(root, env);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    headers['accept-encoding'] = 'identity';

    const isMessages = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url);
    const isChatCompletions = req.method === 'POST' && /^\/v1\/chat\/completions(\?|$)/.test(req.url);
    const isRedactable = isMessages || isChatCompletions;
    ctx.vault.refresh(); // pick up stand-ins other Paws processes added
    let tally = {};
    let streaming = false;
    let session = null;
    let standins = [];
    if (isRedactable && body.length) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        streaming = json.stream === true;
        session = isMessages ? sessionOf(json) : null;
        const r = isChatCompletions ? redactOpenAIRequest(json, ctx) : redactRequest(json, ctx);
        tally = r.tally;
        standins = [...(ctx.standins || [])].slice(0, 200);
        body = Buffer.from(JSON.stringify(r.body));
        // Optional: keep a copy of exactly what left this machine, to check or show an auditor.
        if (env.PAWS_GATEWAY_DUMP) require('fs').appendFileSync(env.PAWS_GATEWAY_DUMP, body.toString('utf8') + '\n');
      } catch (e) {
        // Fail closed: never forward a request we couldn't check.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Paws couldn't check this request: ${e.message}` } }));
        return;
      }
    }
    ctx.vault.save();
    const sent = Object.values(tally).reduce((a, b) => a + b, 0);
    if (sent) log(ctx, { event: 'gateway_redacted', session, tool: isChatCompletions ? 'openai' : 'agent', path: req.url.split('?')[0], found: tally, standins });

    let upstreamRes;
    try {
      upstreamRes = await fetch(target + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        redirect: 'manual',
      });
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Paws gateway couldn't reach ${target}: ${e.message}` } }));
      return;
    }

    if (env.PAWS_GATEWAY_TRACE) process.stderr.write(`[paws] ${req.method} ${req.url} -> ${upstreamRes.status}\n`);
    const outHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    });
    const counter = { n: 0 };
    const ctype = upstreamRes.headers.get('content-type') || '';

    if (isRedactable && streaming && ctype.includes('text/event-stream') && upstreamRes.body) {
      res.writeHead(upstreamRes.status, outHeaders);
      const restorer = isChatCompletions ? new OpenAIStreamRestorer(ctx, counter) : new StreamRestorer(ctx, counter);
      const decoder = new TextDecoder();
      for await (const chunk of upstreamRes.body) {
        const out = restorer.push(decoder.decode(chunk, { stream: true }));
        if (out) res.write(out);
      }
      const tail = restorer.flush();
      if (tail) res.write(tail);
      res.end();
    } else if (isRedactable && ctype.includes('application/json')) {
      const text = await upstreamRes.text();
      let out = text;
      try {
        const parsed = JSON.parse(text);
        out = JSON.stringify(isChatCompletions ? restoreOpenAIResponse(parsed, ctx, counter) : restoreMessage(parsed, ctx, counter));
      } catch (e) {
        /* error bodies and the like pass through */
      }
      res.writeHead(upstreamRes.status, outHeaders);
      res.end(out);
    } else {
      res.writeHead(upstreamRes.status, outHeaders);
      if (upstreamRes.body) for await (const chunk of upstreamRes.body) res.write(chunk);
      res.end();
    }
    if (counter.n) log(ctx, { event: 'gateway_restored', session, tool: isChatCompletions ? 'openai' : 'agent', path: req.url.split('?')[0], count: counter.n });
  });

  // WebSocket and other upgraded connections (tools use them for settings and
  // live sessions, not for model messages) are tunnelled through untouched.
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(target);
    const secure = u.protocol === 'https:';
    const port = Number(u.port || (secure ? 443 : 80));
    const connect = secure
      ? () => require('tls').connect({ host: u.hostname, port, servername: u.hostname })
      : () => require('net').connect({ host: u.hostname, port });
    const up = connect();
    up.on(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? u.host : req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      up.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    if (env.PAWS_GATEWAY_TRACE) process.stderr.write(`[paws] UPGRADE ${req.url} (tunnelled)\n`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, upstream: target, policy: ctx.policy }));
  });
}

module.exports = { sessionOf, startGateway, redactRequest, restoreMessage, StreamRestorer, makeContext, redactOpenAIRequest, restoreOpenAIResponse, OpenAIStreamRestorer };
