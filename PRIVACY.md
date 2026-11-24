# What PawsOff stores, and where

Short version: **everything stays on the laptop. We (the makers of PawsOff) store nothing and receive nothing.**

## On the laptop

| What | Where | Contains |
| --- | --- | --- |
| Local database | `~/.pawsoffoff/pawsoff.db` (readable only by the user) | The vault: each real value encrypted with AES-256-GCM, next to the stand-in the AI saw. Activity: counts, value types, file names, session IDs, times. Never values |
| Encryption key | `~/.pawsoffoff/key` (readable only by the user), or `PAWSOFF_KEY` | 32 random bytes made on first run. Never sent anywhere |
| Redacted copies | `~/.pawsoffoff/cache/` | The stand-in versions of files Claude Code reads, so the AI can open them |

## In the repo

| What | Contains |
| --- | --- |
| `.pawsoff.yml` | The policy |
| `.pawsoff/ledger.jsonl` | Hash-chained edit log: which tool and session touched which protected file, and value counts. Never values. Goes to the pull request check |

## Network connections

PawsOff opens exactly these, and a test fails if another is added:

| Connection | When | What's sent |
| --- | --- | --- |
| Your AI tool's provider (for example `api.anthropic.com`) | Only through the local agent, when you run your AI tool through it | What the tool would have sent anyway, with personal and confidential values swapped for stand-ins |
| `api.github.com` | Only the pull request check, inside GitHub Actions | GitHub's own API calls about that pull request |
| A local AI model on `127.0.0.1` | Only if `local_model` is set | Text to check. Any address that isn't this machine is refused |
| `127.0.0.1` servers for the pop-up, dashboard and agent | While running | Nothing leaves the machine. Each needs a one-time token and only answers to `127.0.0.1` / `localhost` |

There is **no telemetry, no crash reporting, no update check and no account**. The subscription is a signed licence file checked offline.

## What the AI provider still sees

The AI tool still sends your code and prompts to its provider, as it always has. PawsOff changes **what's in it**: real names, emails, phone numbers, TFNs, account numbers, secrets and similar values become stand-ins first. Files marked `ai_read: block` aren't sent at all.

Detection is good but not perfect. Labelled, tabled and previously seen values are caught reliably; names written loosely in prose need the optional local model. Use `PAWSOFF_GATEWAY_DUMP=sent.jsonl` to see exactly what left the laptop in any session.

## Deleting everything

Delete `~/.pawsoff`. Stand-ins already in AI conversations can then never be turned back into real values.
