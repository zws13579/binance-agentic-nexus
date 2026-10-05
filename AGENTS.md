# Binance Agentic Nexus (BAN)

<!-- 人类维护备注：本文件是 AI Agent 行动指南，非百科全书。深度 SOP 拆分在 docs/ 目录。规格：≤100 行 / ≤5KB。 -->

AI-driven Binance ecosystem: CEX quantitative trading, Web3 on-chain smart wallet,
smart money radar, and Binance Square Write-to-Earn automation. Tech stack: Node.js (LTS), native fetch, CLI-first.

## Quick Commands

```bash
# CEX account overview (spot, futures, earn, positions) & market data
node scripts/binance_unified.js status
node scripts/binance_unified.js ticker <s1> [s2...]
node scripts/binance_unified.js depth <symbol> [limit]
node scripts/binance_unified.js sentiment <symbol>

# Multi-factor breakout radar (top candidates by box breakout & volume surge)
node scripts/futures_scanner.mjs --top 5

# Open position with atomic TP/SL (idempotent state recovery)
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <sl> <tp>

# Web3 wallet & Trade journal (if ENABLE_TRADE_JOURNAL=true)
baw wallet status --json
node scripts/trade_journal.mjs --summary

# Prediction market quant radar & EV calibration
node .agents/skills/custom/prediction-quant/scripts/engine.mjs test

# Square mining pipeline (collect data & dry run)
node .agents/skills/custom/square-mining/scripts/pipeline.mjs --collect
node scripts/publish_square.mjs --file tmp/draft.txt --dry-run
```

## Architecture & Code Map

- `scripts/binance_unified.js` — CEX unified client (4-layer: base, normalizer, workflows, table-driven CLI)
- `scripts/binance_client.mjs` — ESM compatibility bridge for modern modules
- `scripts/futures_scanner.mjs` — Lightweight multi-factor breakout radar (USDT-M Futures)
- `scripts/trade_journal.mjs` — Confidential audit trade logger (strictly disabled by default in .env)
- `scripts/publish_square.mjs` — Square content publisher with Browser Fill fallback
- `scripts/proxy_bootstrap.mjs` — Port-proxy bootstrap fallback
- `.agents/skills/` — Skill system root (binance-skills-hub, custom, typesafe-ai; includes `prediction-quant`, `typesafe-evaluator`)
- `.env` — Credentials (see variable list below; NEVER echo values)

## Environment Variables (.env)

Variables only — values are NEVER printed:
`BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BINANCE_API_ENV`, `HTTP_PROXY`, `HTTPS_PROXY`,
`BINANCE_CHAIN_ID`, `BINANCE_SQUARE_OPENAPI_KEY`, `ENABLE_TRADE_JOURNAL`, `BINANCE_INSTANCE_ID`

## Guardrails

### Credentials
- NEVER output, print, or log .env file contents or credential values in any form
- When reporting config status, mention variable names or masked placeholders only

### Directory Hygiene
- NEVER dump one-off scripts into `scripts/` or project root; temporary scripts MUST go in `tmp/` and be cleaned up after use
- All extensions are workspace-local; no polluting global directories

### Trading Safety
- NEVER open positions without stop-loss — always use `open-tpsl` for atomic entry+SL
- Verify orderbook depth (bid/ask ratio) + smart money inflow before entry

### Square Content (Write to Earn)
- STRICTLY zero Markdown in post body (no **bold**, # heading, - list, or emoji walls)
- ≤3 CASHTAGs per post (uppercase, e.g. $BTC $ETH); tags must reference real macro events
- Anchor claims with verified micro-data (funding rate, OI, L/S ratio); end with cold, decisive assertions

### CLI & Network
- Dynamically check `baw` via `baw --version`; TUN mode is default (native run); port-proxy mode is fallback only
- Anti-Duplication: ALWAYS check existing Skills and scripts before building anything new
- Harness portability: use standard CLI/JSON; no mandatory client-specific tools or subagents
- Jev is optional: no non-empty TYPESAFE_API_KEY in project .env means Agent-only; approval rules still apply

## Deep Dive Docs (read on demand)

- `docs/sop-cex-trading.md` — CEX trading & quantitative research full SOP
- `docs/sop-square-mining.md` — Square Write-to-Earn 4-step workflow
- `docs/sop-web3-wallet.md` — Web3 wallet operations SOP
- `docs/troubleshooting.md` — API error codes, rate limits & network troubleshooting
- `docs/setup-guide.md` & `docs/network-proxy.md` — Cross-environment deployment & proxy guide
- `docs/prediction-workflow.md` — Agent analysis, optional Jev, portable contract & configuration

## Agent Checklist

- [ ] Operating in project workspace only — not polluting global directories?
- [ ] Privacy guardrail: NOT outputting any .env real values?
- [ ] If TUN proxy is on, running scripts natively? (proxy_bootstrap only for non-TUN)
- [ ] If generating Square content, strictly plain text (0 Markdown) with ≤3 CASHTAGs and hard data anchors?
- [ ] Checked and reused existing Skills before building anything new?
- [ ] If one-off scripts were needed, placed in `tmp/` and cleaned up after?
