# Deploying Paws

Three stages: run it yourself, pilot it with one team, then ship it as a product. Each stage reuses the same code.

## Stage 1: run it yourself (today, about 10 minutes)

You need Node.js 22.5 or newer for the local database and pop-up (Node 18 works, with the vault kept in a private file instead), and git. For PDF and Word support, also install `pdftotext` (poppler) and `unzip`.

```bash
unzip paws-prototype.zip
cd paws && npm test             # 35 tests should pass

cd ~/code/some-repo                # any repo you use with Claude Code
node ~/paws/bin/paws.js init --claude
```

Then:

1. Edit `.paws.yml` so the paths match the repo.
2. Run `node ~/paws/bin/paws.js sync`.
3. Start Claude Code through the local agent with `node ~/paws/bin/paws.js run claude`.
4. In another terminal, run `node ~/paws/bin/paws.js popup`. A small window opens in the corner of your screen and shows what Paws is doing. Use Claude Code as normal.

Try asking Claude to read a file with customer data in it, or to edit `.github/workflows/`.

**Editor extension:** in VS Code or Cursor, run "Developer: Install Extension from Location…" and pick `paws/vscode-extension`.

**Pull request check:** copy `examples/paws-workflow.yml` to `.github/workflows/paws.yml`. Change `uses: your-org/paws@v0` to point at your copy (see Stage 2), push a branch, and open a PR.

## Stage 2: pilot with one team (weeks 2–6)

Put the code in its own **private GitHub repository** (for example `your-org/countersign`), then:

| Piece | How the pilot team gets it |
| --- | --- |
| CLI and Claude Code hooks | `npm install -g github:your-org/countersign`, then `paws init --claude` in each repo |
| Claude Code plugin | Add a `.claude-plugin/marketplace.json` to the repo listing the plugin. The team then runs `/plugin marketplace add your-org/countersign` and installs it from there. Check Claude Code's plugin docs for the current format |
| GitHub Action | Tag a release (`git tag v0.1.0 && git push --tags`, plus a moving `v0` tag). Workflows use `your-org/countersign@v0`. For a private repo, allow access under Settings → Actions → General |
| Editor extension | Build a `.vsix` with `npx @vscode/vsce package` inside `vscode-extension/` (run `npm run sync-extension` first). Send the file; people install it with "Install from VSIX…" |
| Policy | One `.paws.yml` per repo, reviewed by the pilot's risk or security lead. Make **Paws** a required status check in branch rules |

Before the pilot, do these (each is small):

- [ ] Encrypt the vault with the OS key store (macOS Keychain, Windows Credential Manager, libsecret on Linux)
- [ ] Add the OpenAI Privacy Filter as the main local detector (see below)
- [ ] Hand the customer's security team PRIVACY.md, plus a `PAWS_GATEWAY_DUMP` file from a test session showing exactly what left the laptop
- [ ] Agree what "success" means: for example, zero real customer values in AI traffic during the pilot, and every AI change to protected paths approved

## Stage 3: ship it as a product

**Rename first.** Pick the final name (Countersign or other), check the trademark and domain, and rename the package, CLI, plugin, Action and extension together.

| Channel | What to do |
| --- | --- |
| npm | Publish a scoped package (`@countersign/cli`) so the name is yours. `npm publish --access public`. Then `npx @countersign/cli init` works anywhere |
| Claude Code plugins | Publish the plugin through a public marketplace repo and list it wherever Claude Code plugin directories accept submissions |
| VS Code Marketplace | `vsce publish`. Needs a publisher account (Azure DevOps token) |
| Open VSX | `npx ovsx publish`. Cursor, Windsurf and other VS Code-based editors install from here |
| GitHub Marketplace | Make the Action repo public, then tick "Publish this Action to the GitHub Marketplace" on a release |

**The local gateway** (next build) ships as a desktop app, because it has to run quietly in the background on every laptop:

- Signed installers for macOS (notarised) and Windows (code-signed)
- Auto-start, a menu-bar icon with the corner pop-up (Tauri keeps it small and lets it stay on top), and auto-update
- **Enterprise rollout through device management** (Jamf, Intune, Kandji): IT pushes the app, the company policy and the gateway settings to every laptop, so staff can't switch it off

**Subscription without storing anything.** Customers pay per developer per month, and nothing about their work reaches you:

- Billing runs through Stripe (or invoices for enterprises). That's the only customer data you hold: company name, billing contact, seat count
- Each subscription gets a **signed licence file** (Ed25519). The app checks the signature offline with a public key built into it. No sign-in, no phone-home, works on air-gapped machines
- Licences carry an expiry date and seat count; renewals send a new file (or IT pushes it through device management)
- Policies are shared through the repo (`.paws.yml`) and device management, so no server is needed for that either

**A team view, if customers ask for one,** runs inside the customer's own environment (a container they host), reading the evidence records from their own GitHub. It still never reaches you.

**What regulated buyers will ask for** before they sign:

- A security questionnaire, plus a penetration test by an outside firm
- A list of everything in the software (an SBOM) and signed releases
- SOC 2 Type I, then Type II, and ISO 27001 later. Some government buyers ask for IRAP
- Clear answers on CPS 234 (information security) and the Privacy Act
- Legal: customer terms, a data processing agreement, and professional indemnity and cyber insurance

## Adding the OpenAI Privacy Filter

It's an open model (Apache 2.0) that finds personal data and runs on the laptop. The cleanest setup:

1. Run it in a small local service (Python, on `127.0.0.1`), downloaded once from Hugging Face.
2. Add a `detector: "privacy-filter"` option next to `local_model` in `.paws.yml`. `lib/local-model.js` already shows how a local detector plugs in, and its findings merge with the built-in checksum detectors.
3. Test it on realistic Australian data before relying on it. Fine-tune it on Australian formats if results are weak.

## Checklist: first demo

- [ ] A sample repo with a fake `customers.csv`, a `secrets/` folder, `payments/` and `.github/workflows/`
- [ ] `paws init --claude`, with `mode: fake` switched on
- [ ] Live: Claude reads customers (sees fakes), edits a row (real file stays correct), tries `secrets/` (blocked), changes `payments/` (asks), opens a PR (needs 2 approvals)
- [ ] Show the evidence record and the edit log
