'use strict';

// Claude Code hook handler.
// PreToolUse: before an AI edit, deny it (block), make a human approve it (review),
//             or flag it (warn), based on .pawsoff.yml.
// PostToolUse: after an AI edit lands, record it in the edit log so the
//              pull request check knows which protected files an AI touched.

const path = require('path');
const fs = require('fs');
const { loadPolicy, decide, decideRead, shouldRedact, mostRestrictive, relativeToRoot, findPolicyFile } = require('./policy');
const { matchPath } = require('./glob');
const ledger = require('./ledger');
const redact = require('./redact');
const { detectWithLocalModel } = require('./local-model');
const { extractText, isDocument, isImage, ocrImage } = require('./extract');

const MAX_REDACT_BYTES = 5 * 1024 * 1024;
const BIN = path.resolve(__dirname, '..', 'bin', 'pawsoff.js');

function cacheDir(policy, env) {
  return path.join(redact.pawsoffHome(env), 'cache', redact.rootId(policy.root));
}

// Redacted copies live outside the repo. Map a copy's path back to the real file.
function realPath(policy, env, p) {
  if (!p) return p;
  const dir = cacheDir(policy, env);
  const abs = path.resolve(p);
  if (abs === dir || abs.startsWith(dir + path.sep)) return path.join(policy.root, path.relative(dir, abs));
  return p;
}

// Put real values back into an AI edit that uses placeholders, and point
// edits of a redacted copy at the real file. Everything happens on this machine.
function translateInput(tool, ti, policy, env, vault) {
  const out = { ...(ti || {}) };
  let restored = 0;
  let moved = false;
  const fix = (s) => {
    if (typeof s !== 'string') return s;
    const r = redact.restoreText(s, vault);
    restored += r.restored;
    return r.text;
  };
  for (const key of ['file_path', 'notebook_path']) {
    if (out[key]) {
      const real = realPath(policy, env, out[key]);
      if (real !== out[key]) {
        out[key] = real;
        moved = true;
      }
    }
  }
  if (EDIT_TOOLS.has(tool)) {
    for (const key of ['old_string', 'new_string', 'content', 'new_source']) if (key in out) out[key] = fix(out[key]);
    if (Array.isArray(out.edits)) out.edits = out.edits.map((e) => ({ ...e, old_string: fix(e.old_string), new_string: fix(e.new_string) }));
  }
  return { input: out, changed: moved || restored > 0, restored };
}

function redactOptions(policy, filePath) {
  return { vaultTypes: policy.redact.types, types: policy.redact.types, filePath, allowEmails: policy.redact.allowEmails, custom: policy.redact.custom };
}

function redactForAi(text, policy, filePath, vault) {
  const opts = redactOptions(policy, filePath);
  if (policy.redact.localModel) {
    opts.extraFindings = detectWithLocalModel(text, { localModel: policy.redact.localModel, localModelUrl: policy.redact.localModelUrl });
  }
  return redact.redactText(text, { ...opts, vault, mode: policy.redact.mode, confirm: policy.redact.confirm });
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);
// Shell commands that can change files. Read-only commands are left alone.
const WRITE_COMMAND = /(^|[^<>&|0-9])>{1,2}(?!&)|\b(rm|rmdir|mv|cp|tee|truncate|chmod|chown|ln|dd|touch|install|patch|unlink|shred)\b|\b(sed|perl)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\bgit\s+(checkout|restore|rm|mv|apply|am)\b/;

function pathsFromTool(toolName, toolInput, cwd) {
  const ti = toolInput || {};
  if (toolName === 'NotebookEdit') return ti.notebook_path ? [ti.notebook_path] : [];
  if (EDIT_TOOLS.has(toolName)) return ti.file_path ? [ti.file_path] : [];
  if (toolName === 'Bash') return pathsFromCommand(String(ti.command || ''), cwd);
  return [];
}

// Paths a tool would read. Search tools count when they search inside a hidden area.
function readPathsFromTool(toolName, toolInput, cwd) {
  const ti = toolInput || {};
  if (toolName === 'Read') return ti.file_path ? [ti.file_path] : [];
  if (toolName === 'NotebookRead') return ti.notebook_path ? [ti.notebook_path] : [];
  if (toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS') return ti.path ? [ti.path] : [];
  if (toolName === 'Bash') return tokensFromCommand(String(ti.command || ''), cwd);
  return [];
}

function pathsFromCommand(command, cwd) {
  if (!WRITE_COMMAND.test(command)) return [];
  return tokensFromCommand(command, cwd);
}

function tokensFromCommand(command, cwd) {
  const tokens = command.split(/[\s;&|<>()`'"=]+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue;
    if (!/[./]/.test(tok) && !/^[A-Za-z0-9_\-]+$/.test(tok)) continue;
    out.push(path.resolve(cwd, tok));
  }
  return out;
}

function describe(d) {
  const target = d.path;
  const why = d.reason ? ` ${d.reason}.` : '';
  if (d.action === 'block') {
    return `PawsOff: AI edits to "${target}" are blocked by rule "${d.rules.join(', ')}".${why} Ask a human to make this change.`;
  }
  if (d.action === 'review') {
    const n = d.reviewers || 1;
    const team = d.teams && d.teams.length ? ` from ${d.teams.join(' or ')}` : '';
    return `PawsOff: "${target}" is protected (rule "${d.rules.join(', ')}").${why} Approve only after you've read the change. The pull request will also need ${n} human approval${n === 1 ? '' : 's'}${team}.`;
  }
  return `PawsOff: "${target}" is flagged (rule "${d.rules.join(', ')}").${why} This AI edit will be logged.`;
}

function result(exitCode, stdoutObj, stderr) {
  return { exitCode, stdout: stdoutObj ? JSON.stringify(stdoutObj) : '', stderr: stderr || '' };
}

function safeAppend(root, fields) {
  try {
    const entry = ledger.appendEntry(root, fields);
    require('./store').recordEvent(root, entry);
  } catch (e) {
    // Logging must never break the developer's session.
  }
}

const EDIT_NOTE = 'PawsOff note: personal and confidential values in this file were replaced on this machine with stand-ins. '
  + 'The real file still holds the real values. When you edit it: in old_string, quote only text that contains no stand-in (pick nearby text that is unique); '
  + 'in new_string you may use the stand-ins, and they will be turned back into the real values locally. Never guess the real values or try to read them another way.';

// After Claude reads a redacted copy, tell it how to edit safely. Claude Code checks
// old_string against the real file before any hook runs, so stand-ins can't be matched.
function afterRead(input, env, projectDir) {
  let policy;
  try {
    policy = loadPolicy(projectDir);
  } catch (e) {
    return result(0);
  }
  if (!policy) return result(0);
  const fp = input.tool_input && input.tool_input.file_path;
  if (!fp) return result(0);
  const dir = cacheDir(policy, env);
  const abs = path.resolve(fp);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return result(0);
  return result(0, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: EDIT_NOTE } });
}

function runHook(stdinText, env) {
  env = env || process.env;
  let input;
  try {
    input = JSON.parse(stdinText || '{}');
  } catch (e) {
    return result(0, null, 'PawsOff: hook input was not JSON; skipping.');
  }
  const event = input.hook_event_name || 'PreToolUse';
  const tool = input.tool_name || '';
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;

  if (event === 'PostToolUse' && tool === 'Read') return afterRead(input, env, projectDir);

  let rawPaths = pathsFromTool(tool, input.tool_input, cwd);
  let readPaths = event === 'PreToolUse' ? readPathsFromTool(tool, input.tool_input, cwd) : [];
  if (!rawPaths.length && !readPaths.length) return result(0);

  let policy;
  try {
    policy = loadPolicy(projectDir);
  } catch (e) {
    // Fail closed for file edits: a broken policy shouldn't silently switch the guard off.
    if (event === 'PreToolUse' && (EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool))) {
      return result(0, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${e.message}. AI edits are paused until a human fixes the policy.`,
        },
      });
    }
    return result(0, { systemMessage: e.message });
  }
  if (!policy) return result(0);
  const base = { agent: 'claude-code', session: input.session_id || null, tool };
  const autoApprove = ['acceptEdits', 'bypassPermissions'].includes(input.permission_mode);

  const vault = new redact.Vault(policy.root, env);
  const tr = translateInput(tool, input.tool_input, policy, env, vault);
  const toolInput = tr.input;
  if (tr.changed) {
    rawPaths = pathsFromTool(tool, toolInput, cwd);
    readPaths = event === 'PreToolUse' ? readPathsFromTool(tool, toolInput, cwd) : [];
  }

  // Hidden files: AI tools may not read them at all.
  for (const p of readPaths) {
    const rel = relativeToRoot(policy, p, cwd);
    if (!rel) continue;
    const r = decideRead(policy, rel);
    if (r.action === 'block') {
      safeAppend(policy.root, { ...base, event: 'read_blocked', path: r.path, action: 'hide', rules: r.rules });
      return result(0, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `PawsOff: "${r.path}" is hidden from AI tools (rule "${r.rules.join(', ')}").${r.reason ? ' ' + r.reason + '.' : ''} Don't try to read it another way; ask a human if you need something from it.`,
        },
      });
    }
  }

  // Redaction of reads: show the AI a copy with personal and confidential values replaced.
  if (event === 'PreToolUse' && tool === 'Read' && toolInput.file_path) {
    const abs = path.resolve(cwd, toolInput.file_path);
    const rel = relativeToRoot(policy, abs, cwd);
    if (rel && shouldRedact(policy, rel)) {
      let buf = null;
      try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= MAX_REDACT_BYTES) buf = fs.readFileSync(abs);
      } catch (e) {
        buf = null;
      }
      let text = null;
      let copyRel = rel;
      if (buf && isImage(abs)) {
        // Images: OCR the text, scan for PII. If found, give AI a redacted text
        // transcript instead of the image. If OCR unavailable, block the image.
        const ocrText = ocrImage(abs);
        if (ocrText) {
          const ocrResult = redactForAi(ocrText, policy, rel, vault);
          if (ocrResult.count > 0) {
            // Write a redacted text transcript for the AI instead of the image
            copyRel = rel + '.ocr-redacted.txt';
            const header = `[PawsOff: this image contained personal data. Here is a redacted text transcript.]\n\n`;
            const copy = path.join(cacheDir(policy, env), copyRel);
            fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
            fs.writeFileSync(copy, header + ocrResult.text, { mode: 0o600 });
            vault.save();
            const ocrWhat = Object.entries(ocrResult.summary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
            safeAppend(policy.root, { ...base, event: 'image_redacted', path: rel, action: 'redact', found: ocrResult.summary });
            return result(0, {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: `PawsOff OCR-scanned this image and found PII (${ocrWhat}). The AI gets a redacted text transcript instead.`,
                updatedInput: { ...toolInput, file_path: copy },
              },
              systemMessage: `PawsOff: image ${rel} contained ${ocrResult.count} PII value(s). AI sees a redacted text transcript, not the original image.`,
            });
          }
          // OCR found text but no PII - let the image through
        } else {
          // No OCR available - block the image in redacted paths, it can't be checked
          safeAppend(policy.root, { ...base, event: 'image_blocked', path: rel, action: 'block' });
          return result(0, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `PawsOff can't scan this image for personal data (OCR not available). Images in redacted paths are blocked when they can't be checked.`,
            },
          });
        }
      }
      if (buf && isDocument(abs)) {
        // Papers and documents: redact a plain-text copy of the PDF or Word file.
        text = extractText(abs);
        copyRel = rel + '.redacted.txt';
        if (text === null) {
          safeAppend(policy.root, { ...base, event: 'read_blocked', path: rel, action: 'unreadable_document' });
          return result(0, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `PawsOff can't check ${rel} for personal data on this machine (install pdftotext for PDFs, or unzip for Word files), so it isn't shown to the AI. Ask a human for the parts you need.`,
            },
          });
        }
      } else if (buf && !redact.looksBinary(buf)) {
        text = buf.toString('utf8');
      }
      if (text !== null) {
        const r = redactForAi(text, policy, rel, vault);
        if (r.count > 0 || copyRel !== rel) {
          const copy = path.join(cacheDir(policy, env), copyRel);
          fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
          fs.writeFileSync(copy, r.text, { mode: 0o600 });
          vault.save();
          const what = Object.entries(r.summary).map(([k, v]) => `${v} ${k.toLowerCase().replace('_', ' ')}`).join(', ') || 'nothing';
          safeAppend(policy.root, { ...base, event: 'redacted', path: rel, action: 'redact', found: r.summary, standins: r.standins.slice(0, 200) });

          // If there are uncertain findings (from local model), tell the user what was
          // found but not redacted, so they can decide whether to add them.
          let uncertainNote = '';
          if (r.uncertain && r.uncertain.length) {
            const items = r.uncertain.map(u => `"${text.slice(u.start, u.end)}" (${u.label.toLowerCase()})`).slice(0, 5);
            uncertainNote = `\n\nPawsOff also found ${r.uncertain.length} possible match${r.uncertain.length === 1 ? '' : 'es'} it wasn't sure about: ${items.join(', ')}. These were NOT redacted. To always redact these, add them to your .pawsoff.yml allow list or confirm them in the PawsOff popup.`;
            safeAppend(policy.root, { ...base, event: 'uncertain', path: rel, action: 'confirm_needed', found: Object.fromEntries(r.uncertain.map(u => [u.label, 1])) });
          }

          return result(0, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: r.uncertain && r.uncertain.length ? 'ask' : 'allow',
              permissionDecisionReason: `PawsOff redacted ${what} in ${rel} on this machine before the AI saw it.${uncertainNote}`,
              updatedInput: { ...toolInput, file_path: copy },
            },
            systemMessage: `PawsOff: ${rel} shown to the AI with ${r.count} value(s) redacted (${what}). Placeholders like [EMAIL_1] are swapped back locally when the AI edits the file.`,
          });
        }
      }
    }
  }

  // Check write protection BEFORE shell output wrapping, so blocked writes are denied.
  const decisions = [];
  for (const p of rawPaths) {
    const rel = relativeToRoot(policy, p, cwd);
    if (rel) decisions.push(decide(policy, rel));
  }

  // Shell output redaction: wrap the command so its output goes through the redactor.
  // Only for commands that aren't writing to blocked files.
  if (event === 'PreToolUse' && tool === 'Bash' && toolInput.command && (!decisions.length || decisions.every(d => d.action === 'allow'))) {
    const touched = tokensFromCommand(String(toolInput.command), cwd)
      .map((p) => relativeToRoot(policy, p, cwd))
      .filter(Boolean);
    const forced = touched.some((rel) => policy.rules.some((r) => r.ai_read === 'redact' && matchPath(r.path, rel)));
    if (policy.redact && (forced || (policy.redact.enabled && policy.redact.shellOutput))) {
      const wrapped = `set -o pipefail; { ${toolInput.command}\n} 2>&1 | node "${BIN}" redact-stream --root "${policy.root}"`;
      return result(0, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: input.permission_mode === 'bypassPermissions' ? 'allow' : 'ask',
          permissionDecisionReason: 'PawsOff will redact personal and confidential data in this command\'s output before the AI sees it.',
          updatedInput: { ...toolInput, command: wrapped },
        },
      });
    }
  }

  if (!decisions.length) return result(0);
  const top = mostRestrictive(decisions);

  if (event === 'PostToolUse') {
    if (!EDIT_TOOLS.has(tool)) return result(0);
    for (const d of decisions) {
      if (d.action !== 'allow' || policy.logAllEdits) {
        safeAppend(policy.root, { ...base, event: 'edited', path: d.path, action: d.action, rules: d.rules });
      }
    }
    return result(0);
  }

  // PreToolUse
  if (tr.restored) {
    const target = decisions[0] ? decisions[0].path : null;
    safeAppend(policy.root, { ...base, event: 'restored', path: target, action: 'restore', count: tr.restored });
  }
  const restoreNote = tr.restored ? ` PawsOff put back ${tr.restored} redacted value(s) on this machine before saving.` : '';
  const withInput = (hso) => (tr.changed ? { ...hso, updatedInput: toolInput } : hso);
  if (top.action === 'allow') {
    if (!tr.changed) return result(0);
    return result(0, {
      hookSpecificOutput: withInput({
        hookEventName: 'PreToolUse',
        permissionDecision: autoApprove ? 'allow' : 'ask',
        permissionDecisionReason: restoreNote.trim() || 'PawsOff pointed this edit at the real file.',
      }),
    });
  }
  safeAppend(policy.root, {
    ...base,
    event: top.action === 'block' ? 'blocked' : top.action === 'review' ? 'asked' : 'warned',
    path: top.path,
    action: top.action,
    rules: top.rules,
  });

  if (top.action === 'block') {
    return result(0, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: describe(top) },
    });
  }
  if (top.action === 'review') {
    return result(0, {
      hookSpecificOutput: withInput({ hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: describe(top) + restoreNote }),
    });
  }
  // warn: let the normal permission flow continue, but tell the user.
  if (tr.changed) {
    return result(0, {
      hookSpecificOutput: withInput({ hookEventName: 'PreToolUse', permissionDecision: autoApprove ? 'allow' : 'ask', permissionDecisionReason: describe(top) + restoreNote }),
      systemMessage: describe(top),
    });
  }
  return result(0, { systemMessage: describe(top) });
}

module.exports = { runHook, translateInput, realPath, cacheDir, pathsFromTool, readPathsFromTool, pathsFromCommand, tokensFromCommand, describe, findPolicyFile };
