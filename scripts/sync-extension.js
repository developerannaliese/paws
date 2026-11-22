'use strict';
// Copies the shared engine into the editor extension so it can be packaged on its own.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'vscode-extension');
for (const dir of ['lib', 'bin']) {
  fs.rmSync(path.join(ext, dir), { recursive: true, force: true });
  fs.cpSync(path.join(root, dir), path.join(ext, dir), { recursive: true });
}
console.log('Copied lib/ and bin/ into vscode-extension/.');
