# AI Guard (working name)

Keep AI coding tools away from the files and data that need a human.

One policy file, `.aiguard.yml`, says which files AI tools may **not read**, may **not edit**, or may edit only with **human review**. On top of that, **personal and confidential data is blanked out on your machine before any AI tool sees it**. AI Guard enforces all of this in three places:

1. **On the developer's machine.** A Claude Code plugin stops the AI before it reads a hidden file or edits a protected one. Hidden-file rules are also copied into the ignore settings of Cursor, Windsurf, Gemini Code Assist, Aider and Claude Code.
2. **In the editor.** A VS Code / Cursor / Windsurf extension marks protected files and warns when one changes.
3. **On the pull request.** A GitHub Action finds AI-written changes, fails the check if they touch blocked files, and requires the human approvals the policy asks for.

Every decision goes into a hash-chained edit log, and each pull request check writes an evidence record you can give an auditor.

## Local redaction

Every file an AI tool reads is checked on your machine first. Personal and confidential values are swapped for stand-ins, and the AI only ever sees the stand-ins:

```
id,full_name,email,phone,plan          id,full_name,email,phone,plan
1,Jane Citizen,jane.citizen@gmail...   →   1,[NAME_1],[EMAIL_1],[PHONE_1],gold
```

- **What it finds:** emails, Australian mobile and landline numbers, TFNs, ABNs, Medicare and card numbers (checked with their official checksums, so ordinary numbers aren't caught), BSBs and account numbers, street addresses, dates of birth, labelled names, and CSV columns like `full_name` or `email`. It also finds secrets: API keys, tokens, passwords and private keys.
- **Papers and documents:** PDF and Word files are turned into text and redacted before the AI reads them (needs `pdftotext` and `unzip`). If a document can't be checked, it isn't shown to the AI at all.
- **Two styles:** placeholders like `[EMAIL_1]` (default), or `mode: fake` for realistic stand-ins that aren't real: "Olivia Walker", `olivia.walker@example.com`, phone numbers from ACMA's fiction ranges, and TFN, ABN and card numbers that fail their checksums. Secrets always get a placeholder.
- **Edits still work:** when the AI writes a stand-in into a file, AI Guard swaps the real value back in on your machine. The mapping lives in a private vault in `~/.aiguard`, never in the repo or the log.
- **Optional local AI:** add `local_model: "ollama:llama3.2"` to also catch loosely written names, addresses and internal code names, using a model running on your machine. If it isn't running, the built-in detectors still apply.
- **Shell output:** commands that touch `ai_read: redact` paths have their output redacted too (set `shell_output: true` to redact every command).

```yaml
redact:
  enabled: true
  mode: fake                      # or leave out for [NAME_1] placeholders
  allow_emails: ["yourcompany.com.au"]
  # local_model: "ollama:llama3.2"
```

Try it on any file: `aiguard scan customers.csv`, or `aiguard redact paper.pdf --fake` to see exactly what an AI would see.

## The local agent

`aiguard run claude` starts a small agent on your laptop and runs Claude Code through it. Or run `aiguard gateway` and set `ANTHROPIC_BASE_URL=http://127.0.0.1:4480` yourself. Then:

1. Every message Claude Code sends to the model is checked on your machine first: your prompts, files it read, command output and search results.
2. Real personal and confidential data is swapped for stand-ins before anything leaves. Values seen before are swapped wherever they turn up again, even in plain sentences.
3. Replies come back through the agent, and stand-ins are swapped back to real values before Claude Code acts on them. Edits land correctly in your real files, and you see the real values in your own terminal.
4. If a request can't be checked, it isn't sent.
5. Activity shows up in `aiguard ui`.

In a live test with Claude Code, it read a customer file, reported back and edited the right row. No name, email or phone from the file appeared in any request that left the machine. Set `AIGUARD_GATEWAY_DUMP=sent.jsonl` to keep a copy of exactly what was sent, which is handy for showing a security team.

The agent covers any tool that uses the Anthropic API and lets you set its address. Tools with fixed addresses (Cursor, Copilot, ChatGPT in a browser) need the intercepting-proxy version described in DEPLOY.md.

## The corner pop-up

`aiguard popup` opens a small window in the bottom-right corner of your screen. It shows, live, across every repo on this laptop:

- how many personal and confidential values were kept from AI today, plus what was stopped, what needs approval and what was put back
- the AI session happening now and what AI Guard did in it
- a short feed of recent activity, with **Open sessions** for the full view

When AI Guard stops the AI reading or editing something, or needs your approval, you also get a normal system notification (macOS, Windows or Linux). It opens as an app-style window in Chrome, Edge or Brave if you have one, otherwise in your browser. `--quiet` turns notifications off.

## Everything stays on your laptop

- **Local database:** one SQLite file, `~/.aiguard/aiguard.db`, using the SQLite built into Node, so nothing to install. Real values are encrypted (AES-256-GCM) with a key that never leaves the laptop, and looked up by keyed hash, so the file holds no readable real value. Activity is recorded as counts, types, file names and session IDs, never values.
- **Local agent:** `aiguard run claude` runs on `127.0.0.1`. The pop-up and dashboard are served on `127.0.0.1` too, behind a one-time link.
- **Nothing is sent to us.** There's no telemetry, no account and no AI Guard server. The subscription will be a signed licence file checked offline. The only connections AI Guard makes are the ones your tools already make: AI traffic goes to the AI provider (with stand-ins in place of real data), and the pull request check talks to GitHub inside GitHub Actions. A test (`privacy:` in the test suite) fails if any other network call is added. See **PRIVACY.md**.

## Sessions view

The views read the edit log in the repo and the local database, grouped by AI session.

- **In your editor:** the AI Guard extension adds **AI Guard: Show sessions**, also opened by clicking the status bar. It's a panel beside your code that uses your editor's own colours and fonts. Pick a session to see a one-line summary ("AI Guard kept 8 values away from the AI and put 1 back for your tools"), its activity, and **What the AI saw**: each real value, masked, next to the stand-in the AI got. Reveal shows one real value for 10 seconds.
- **Pop-ups:** when AI Guard stops the AI reading or editing something, or needs your approval, a notification pops up with a **Show session** button. Set `aiguard.popups` to `all` to also hear about every swap, or `off` for none.
- **In a browser:** `aiguard ui` serves the same view on `127.0.0.1` only, behind a one-time link.

## Quick start (5 minutes)

```bash
cd your-repo
node /path/to/aiguard/bin/aiguard.js init --claude
```

This creates `.aiguard.yml` with example rules, installs the Claude Code hooks in `.claude/settings.json`, and hides the "hidden" paths from AI tools. Edit the paths to match your repo, then run `aiguard sync` again.

Commit `.aiguard.yml`, the tool ignore files, and `.aiguard/ledger.jsonl`.

To check pull requests, copy `examples/aiguard-workflow.yml` to `.github/workflows/aiguard.yml`, then make **AI Guard** a required status check in your branch rules.

## The policy

```yaml
version: 1
rules:
  - path: "secrets/**"
    ai_read: block            # AI may not open, search, print or edit these
    reason: "Keys stay out of AI tools"
  - path: "payments/**"
    ai_edit: review           # AI may edit after a human approves in the session,
    reviewers: 2              # and the PR needs 2 human approvals
    team: "@payments-team"
  - path: ".github/workflows/**"
    ai_edit: block            # a human must make the change
  - path: "**/migrations/**"
    ai_edit: warn             # allowed, but logged and flagged
```

| Setting | Meaning |
| --- | --- |
| `ai_read: block` | Hidden. AI tools may not read, search or print it, so they can't edit it either |
| `ai_read: redact` | Always redacted, even if redaction is switched off elsewhere; shell output for these paths is redacted too |
| `ai_edit: block` | AI may read but never change it |
| `ai_edit: review` | AI may change it only after a human approves in the session; the pull request needs `reviewers` human approvals |
| `ai_edit: warn` | Allowed, but logged and shown on the pull request |

Paths use `.gitignore`-style patterns. When several rules match, the strictest wins. AI tools can never edit `.aiguard.yml` or the edit log.

## Commands

| Command | What it does |
| --- | --- |
| `aiguard init [--claude]` | Create the policy; `--claude` also installs the Claude Code hooks |
| `aiguard check <path>…` | Show what an AI edit to each path needs |
| `aiguard rules` | List the rules in force |
| `aiguard sync` | Copy hidden-file rules into each AI tool's ignore settings |
| `aiguard scan <file>…` | Show what personal or confidential data a file contains |
| `aiguard redact <file> [--fake]` | Print a file as an AI tool would see it |
| `aiguard pr-check` | Check a pull request (in GitHub Actions) or `--base`/`--head` locally |
| `aiguard verify-log` | Confirm the edit log hasn't been changed |
| `aiguard popup` | Small live window in the corner of the screen, plus notifications |
| `aiguard ui` | Open the local dashboard: activity, what the AI saw, rules and log status |
| `aiguard run claude` | Run Claude Code through the local agent |
| `aiguard gateway` | Run the local agent on its own (port 4480) |

## How AI changes are spotted on a pull request

- **Commit signals:** `Co-authored-by` trailers, "Generated with" lines, and bot accounts from Claude Code, Copilot, Cursor, Codex, Devin and others.
- **The edit log:** the Claude Code plugin records every AI edit to a protected file, so they're caught even if the commit looks human.
- **The base branch's policy is used,** so a pull request can't loosen its own rules.
- **Approvals:** only approvals from humans other than the author count, and only on the latest commit (`require_fresh_approvals: false` turns that off).

See **DEPLOY.md** for running it yourself, piloting it with a team, and shipping it.

## In this folder

```
bin/aiguard.js            CLI
lib/                      policy engine, hook, redaction, PR check, edit log, tool sync
.claude-plugin/, hooks/   Claude Code plugin
action.yml                GitHub Action
vscode-extension/         editor extension (run `npm run sync-extension` after changing lib/)
examples/                 GitHub workflow
test/                     35 tests: `npm test`
```

To try the editor extension: in VS Code or Cursor, run **Developer: Install Extension from Location…** and pick the `vscode-extension` folder. You can also copy that folder into `~/.vscode/extensions/`.

## Limits of this prototype

- **Pre-edit blocking covers Claude Code only.** Other tools get hidden-file rules through their ignore files, and their edits are caught at the pull request from commit signals. Hooks for Cursor and Codex are the next step.
- **Local hooks can be switched off by the developer.** The pull request check is the control that counts.
- **Shell commands are checked by matching file names,** which catches common cases (`cat`, `rm`, `>`, `sed -i`) but not every trick.
- **The edit log is tamper-evident, not tamper-proof.** Someone could rebuild the whole chain. A hosted version would anchor it with a third party.
- **Without the local agent,** redaction covers Claude Code file reads only, and searches and command output go out as they are. Run Claude Code through `aiguard run claude` to cover everything it sends.
- **The agent speaks the Anthropic API only for now.** OpenAI-style APIs and tools with fixed addresses come next.
- **The pop-up window can't stay on top of other windows** while it's a browser window. The native menu-bar app planned in DEPLOY.md fixes that.
- **The vault key is a file** (`~/.aiguard/key`, readable only by you). Moving it to the OS keychain is next.
- **Names in free text** are caught only when labelled, in tables, or already seen. A local model (OpenAI Privacy Filter) is the planned fix.
- **Detection is never perfect.** Patterns plus an optional local model reduce what leaks; they don't guarantee nothing does. Fake values could, rarely, clash with real text.
- **Claude Code checks an edit against the real file before any hook runs,** so the AI is told to match text around stand-ins, not the stand-ins themselves. Stand-ins in new text are swapped back.
- **Documents are read-only to the AI.** Edits to a PDF or Word file aren't supported.
- **Check the tool ignore-file names** against each tool's current docs. Copilot content exclusion is set in GitHub settings, and `aiguard sync` prints the paths to paste.
