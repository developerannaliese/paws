'use strict';
// Child process for local-model.js: asks a local Ollama server and prints {"items":[...]}.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  try {
    const { url, model, prompt } = JSON.parse(input);
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
    });
    const body = await res.json();
    const parsed = JSON.parse(body.response || '{}');
    process.stdout.write(JSON.stringify({ items: Array.isArray(parsed.items) ? parsed.items : [] }));
  } catch (e) {
    process.stdout.write('{"items":[]}');
  }
});
