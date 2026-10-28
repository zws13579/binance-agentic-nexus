# Binance Agentic Nexus

[简体中文](README.zh-CN.md)

Binance Agentic Nexus (BAN) combines public market research, authenticated CEX account workflows, optional Binance Web3 skills, and custom prediction-market and Square workflows. It uses Node.js 24, keeps its own JavaScript in CommonJS `.js` and ESM `.mjs` files, and runs its local regression suite without credentials or live network requests.

## Start locally

```bash
git clone --recurse-submodules https://github.com/zws13579/binance-agentic-nexus.git
cd binance-agentic-nexus
nvm install
npm ci
npm test
```

`npm ci` installs the pinned project dependency. `npm test` runs the root fake-fetch tests and both existing custom-skill test suites. The tests do not need `.env`, Binance credentials, the `baw` CLI, or exchange access. Copy `.env.example` to `.env` only when a workflow needs configuration; leave proxy variables blank when the system TUN proxy is active.

## CI and local security checks

CI runs `npm test`, `npm audit --audit-level=high`, and Gitleaks 8.30.1 against the complete root Git history with full redaction. The secret scan fetches root history without initializing submodules, so submodule histories are outside its scope. Run the checks locally with dependencies installed and Gitleaks 8.30.1 available:

```bash
npm audit --audit-level=high
gitleaks git --log-opts=--all --redact=100 .
```

The optional `baw` CLI is not an npm dependency of this project. If a Web3 workflow requires it, install a version supported by that workflow locally and verify the result with `./node_modules/.bin/baw --version`; installing this repository does not install or certify BAW compatibility. See [setup guidance](docs/setup-guide.md).

## Capabilities and boundaries

- Public spot and USDⓈ-M market data, a direction-neutral futures scanner, and an evidence-oriented evaluator.
- Authenticated account reads and protected order, funding, and reconciliation workflows. The CLI's `--approved` / `--dry-run` gate applies only to `open-tpsl`, `redeem-earn`, `transfer-to-futures`, and `transfer-from-futures`; other write commands do not share that uniform flag gate. Every write still requires explicit user authorization. Read-only commands such as ticker and reconcile can still contact production. Official third-party skills have their own behavior and prerequisites.
- Optional official Binance and TypeSafe skill submodules, plus project-maintained prediction and Square workflows.
- An optional project-local `undici` proxy bootstrap for port-proxy mode. TUN mode can use Node's native `fetch` directly.

For a production **read-only** public market request, run:

```bash
BINANCE_API_ENV=prod node scripts/binance_unified.js ticker BTCUSDT
```

This command sends a public GET request to Binance production. Account reads require an API key with read permission. Use separate, least-privilege credentials; never put secrets in issues, logs, screenshots, or committed files. For `open-tpsl`, `redeem-earn`, `transfer-to-futures`, and `transfer-from-futures`, use `--dry-run` to preview or `--approved` to submit; these mutually exclusive flags do not grant user authorization. Other write commands, including `close-position`, `set-tpsl`, cancellation commands, `leverage`, `margin-type`, and the write form of `position-mode`, do not share this uniform CLI flag gate and still require explicit user authorization. A dry-run still reads live production state, and the serial entry/protection flow is not atomic: the exchange may accept one request before a later protection request fails. Review the [CEX trading SOP](docs/sop-cex-trading.md) before any write workflow.

## Project files

- `scripts/binance_unified.js` — CommonJS CEX client and CLI.
- `scripts/futures_scanner.mjs` — closed-candle market evidence scanner.
- `scripts/futures_evaluator.mjs` — agent-led evidence evaluation.
- `scripts/proxy_bootstrap.mjs` — opt-in local proxy dispatcher.
- `.agents/skills/custom/` — project-maintained skills.
- `docs/` — operating guidance, setup notes, and release checklist.

`BINANCE_API_ENV` defaults to `prod`. Values other than `prod` are rejected before network access; testnet behavior is not implemented.

## License scope

The root MIT license covers original project-owned code. It does not grant a license to third-party skills, submodules, copied history, or other assets with separate or unresolved terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [release checklist](docs/release-checklist.md) before redistribution.
