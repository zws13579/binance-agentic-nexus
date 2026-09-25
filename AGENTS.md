# Binance Agentic Nexus (BAN)

<!-- 人类维护备注：本文件是 AI Agent 的行动指南，非百科全书。
     深度 SOP 已拆分到 docs/ 目录，Agent 按需读取。
     Claude Code 会自动剥离 HTML 注释，不消耗 Token。
     目标规格：≤100 行 / ≤5KB / 零截断。 -->

AI-driven Binance ecosystem: CEX spot/futures quantitative trading,
Web3 on-chain smart wallet, smart money intelligence radar,
and Binance Square Write-to-Earn automation.

Tech stack: Node.js (LTS), native fetch, CLI-first (no package.json in root).

## Quick Commands

```bash
# CEX account overview (spot, futures, earn, positions)
node scripts/binance_unified.js status

# Batch ticker query (price, 24h change, volume)
node scripts/binance_unified.js ticker <symbol1> [symbol2...]

# Futures positions & unrealized PnL
node scripts/binance_unified.js positions [symbol]

# Market sentiment (long/short ratio, funding rate, OI)
node scripts/binance_unified.js sentiment <symbol>

# Open position with atomic TP/SL
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>

# Web3 wallet status
baw wallet status --json

# Square mining pipeline (dry run)
node .agents/skills/custom/square-mining/scripts/pipeline.mjs --dry-run
```

## Architecture & Code Map

- `scripts/binance_unified.js` — CEX unified client (spot/futures/risk, native fetch, auto retry)
- `scripts/typesafe.mjs` — TypeSafe AI structured judgment CLI (driven by .env)
- `scripts/publish_square.mjs` — Square content publishing script
- `scripts/proxy_bootstrap.mjs` — Backup network proxy bootstrap (port-proxy mode only)
- `.agents/skills/` — Skill system root (each skill has its own SKILL.md)
  - `binance-skills-hub/` — Official Git Submodule (binance + binance-web3)
  - `custom/` — Custom skills (square-mining, typesafe-evaluator)
  - `typesafe-ai/` — Optional third-party extension
- `.env` — Credentials (see variable list below; NEVER echo values)

## Environment Variables (.env)

Variables only — values are NEVER printed:
`BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BINANCE_API_ENV`,
`HTTP_PROXY`, `HTTPS_PROXY`, `BINANCE_CHAIN_ID`, `BINANCE_SQUARE_OPENAPI_KEY`

## Guardrails

### Credentials
- NEVER output, print, or log .env file contents or credential values in any form
- When reporting config status, mention variable names or masked placeholders only

### Directory Hygiene
- NEVER dump one-off scripts into `scripts/` or project root
- Temporary scripts MUST go in `tmp/` (gitignored) and be deleted after use
- All extensions are workspace-local; no polluting global directories

### Trading Safety
- NEVER open positions without stop-loss — always use `open-tpsl` for atomic entry+SL
- Verify orderbook depth (bid/ask ratio) + smart money inflow before entry

### Square Content (Write to Earn)
- STRICTLY zero Markdown in post body (no **bold**, # heading, - list, or emoji walls)
- ≤3 CASHTAGs per post (uppercase, e.g. $BTC $ETH)
- Tags must reference real macro events (e.g. #Fed加息 #BTC突破10万)
- NEVER self-identify as "老韭菜"; NEVER use "总而言之/综上所述"
- End with cold, decisive assertions — no fence-sitting

### CLI Maintenance
- NEVER hardcode `baw` version numbers; dynamically check via `baw --version`
- After `npm install -g` upgrades, port-proxy injection in baw entry scripts is lost (TUN users unaffected)

### Network
- TUN mode (system-level transparent proxy) is the default — scripts run natively
- Port-proxy mode (via HTTP_PROXY in .env) is fallback only; see docs/network-proxy.md

### Anti-Duplication
- ALWAYS check existing Skills and scripts before building anything new
- Prefer composing via CLI (`baw`, `node scripts/...`) over writing new code
- Long sessions (50+ turns) degrade context quality — start fresh with this file as ground truth

## Deep Dive Docs (read on demand)

- `docs/sop-cex-trading.md` — CEX trading & quantitative research full SOP
- `docs/sop-square-mining.md` — Square Write-to-Earn 4-step workflow
- `docs/sop-web3-wallet.md` — Web3 wallet operations SOP
- `docs/setup-guide.md` — Cross-environment deployment & multi-Agent collaboration
- `docs/network-proxy.md` — Network proxy dual-mode deep dive

## Agent Checklist

- [ ] Operating in project workspace only — not polluting global directories?
- [ ] Privacy guardrail: NOT outputting any .env real values?
- [ ] If TUN proxy is on, running scripts natively? (proxy_bootstrap only for non-TUN)
- [ ] If using `baw`, CLI version meets current Skill requirements?
- [ ] If generating Square content, strictly plain text (0 Markdown) with ≤3 CASHTAGs?
- [ ] Checked and reused existing Skills before building anything new?
- [ ] If one-off scripts were needed, placed in `tmp/` and cleaned up after?
