# PawsOff

Keep AI coding tools away from your sensitive data.

One policy file (`.pawsoff.yml`) controls what AI tools can read and edit. Personal data is redacted on your machine before any AI sees it. Everything stays local — no server, no account, no telemetry.

**[Website](https://mdkt.dev/pawsoff)** · **[Privacy](PRIVACY.md)** · **[Deploy guide](DEPLOY.md)**

## What it does

```
Real file                          What the AI sees
─────────────────────────────      ─────────────────────────────
Sarah Mitchell                     [NAME_1]
sarah.mitchell@bigpond.com.au      [EMAIL_1]
0412 345 678                       [PHONE_1]
TFN: 123 456 782                   TFN: [TFN_1]
```

When the AI writes `[EMAIL_1]` back into an edit, PawsOff swaps the real value in. The AI never sees the real data, your files stay correct.

## Install

```bash
npx pawsoff init --claude
```

This creates `.pawsoff.yml` with example rules, installs Claude Code hooks, and hides protected paths from other AI tools (Cursor, Windsurf, Gemini Code Assist, Aider).

Requires **Node.js 22.5+** (uses built-in SQLite for the encrypted local vault).

## The policy

```yaml
version: 1
rules:
  - path: "secrets/**"
    ai_read: block              # AI can't see these at all
  - path: "customers/**"
    ai_read: redact             # PII replaced before AI reads
  - path: ".github/workflows/**"
    ai_edit: block              # humans only
  - path: "payments/**"
    ai_edit: review             # AI can edit after human approval
    reviewers: 2

redact:
  enabled: true
  mode: fake                    # realistic stand-ins, or "placeholder" for [NAME_1]
  # local_model: "ollama:llama3.2"   # optional local AI for extra detection
```

| Setting | What it does |
|---------|-------------|
| `ai_read: block` | AI tools can't read, search, or print the file |
| `ai_read: redact` | AI sees the file with PII replaced |
| `ai_edit: block` | AI can read but never edit |
| `ai_edit: review` | AI can edit after human approves; PR needs human approvals |
| `ai_edit: warn` | Allowed but logged and flagged on the PR |

## What it catches

PII detection runs locally using pattern matching and official checksums:

- **Emails** and **phone numbers** (Australian mobile + landline)
- **TFNs** (ATO weighted checksum), **ABNs** (mod-89), **Medicare** (mod-10)
- **Credit cards** (Luhn), **BSBs** and **account numbers**
- **Addresses**, **dates of birth**, **labelled names**
- **Secrets**: API keys, tokens, passwords, private keys
- **CSV columns**: header says `full_name` or `email` → whole column redacted

Checksums prevent false positives — a random 9-digit number won't be flagged as a TFN.

**Optional local AI**: Add `local_model: "ollama:llama3.2"` to catch names in free text the patterns miss. Runs on your laptop only.

## Three layers

### 1. On your machine

Claude Code hooks intercept every tool call. Reads get redacted copies. Edits to protected files are blocked or require approval. Stand-ins are swapped back to real values locally.

### 2. The gateway agent

```bash
pawsoff run claude    # or: pawsoff run codex
```

Proxies all API traffic through a local agent on `127.0.0.1`. Every message, file content, and command output is scrubbed before it leaves your machine. Replies are restored before the tool acts on them. Supports both Anthropic and OpenAI API formats.

### 3. On the pull request

A GitHub Action detects AI-written changes (commit trailers, bot accounts, edit log), fails the check if they touch blocked files, and requires the human approvals the policy asks for. The base branch's policy is used, so a PR can't loosen its own rules.

```yaml
# .github/workflows/pawsoff.yml
- uses: developerannaliese/pawsoff@main
```

## Commands

| Command | What it does |
|---------|-------------|
| `pawsoff init [--claude]` | Create policy; `--claude` installs Claude Code hooks |
| `pawsoff scan <file>` | Show what PII a file contains |
| `pawsoff redact <file> [--fake]` | Print the file as AI would see it |
| `pawsoff check <path>` | Show what an AI edit needs |
| `pawsoff rules` | List rules in force |
| `pawsoff sync` | Copy hidden-file rules to all AI tools' ignore settings |
| `pawsoff run <cmd>` | Start gateway + run a tool through it (`claude`, `codex`, etc.) |
| `pawsoff gateway` | Run the gateway on its own (port 4480) |
| `pawsoff popup` | Live companion window with today's activity |
| `pawsoff ui` | Local dashboard |
| `pawsoff sessions` | List recent AI sessions |
| `pawsoff clear --session <id>` | Clear one session's data |
| `pawsoff clear --older-than <days>` | Clear old events |
| `pawsoff pr-check` | Check a pull request (in GitHub Actions) |
| `pawsoff verify-log` | Confirm the edit log hasn't been tampered with |

## AI tool support

| Tool | File hiding | Pre-edit hooks | Gateway (prompt redaction) |
|------|------------|---------------|--------------------------|
| Claude Code | `.claude/settings.json` | Yes | `pawsoff run claude` |
| Codex CLI | ignore files | Planned | `pawsoff run codex` |
| Cursor | `.cursorignore` | — | — |
| Windsurf | `.codeiumignore` | — | — |
| Aider | `.aiderignore` | — | `OPENAI_BASE_URL` |
| Gemini Code Assist | `.aiexclude` | — | — |
| Copilot | GitHub content exclusion | — | — |

All tools get file-hiding via `pawsoff sync`. The PR check catches AI changes regardless.

## Privacy

- **Local database**: `~/.pawsoff/pawsoff.db` (SQLite). Real values encrypted with AES-256-GCM. Activity stored as counts and file names, never values.
- **No telemetry, no account, no PawsOff server.** The only network connections are the ones your AI tools already make (with stand-ins in place of real data).
- **Privacy test**: fails if any unexpected network call is added to the codebase.

See [PRIVACY.md](PRIVACY.md).

## Project structure

```
bin/pawsoff.js           CLI
lib/                     Policy engine, hooks, redaction, gateway, audit log, sync
.claude-plugin/          Claude Code plugin
hooks/                   Hook definitions
action.yml               GitHub Action
vscode-extension/        VS Code / Cursor / Windsurf extension
site/                    Landing page
examples/                GitHub workflow
test/                    35 tests
```

## License

MIT
