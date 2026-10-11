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

# Neutral perpetual research (closed 4h/1h/15m candles, liquidity ranking)
node scripts/futures_scanner.mjs --top 20

# Preview serial entry + protection; retain request ID for reconciliation
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <sl> <tp> --dry-run --request-id <id>

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

- `scripts/binance_unified.js` — CEX data, funding and protected execution CLI
- `scripts/binance_client.mjs` — ESM
- `scripts/futures_scanner.mjs` — Neutral perpetual facts (schema 2; no opportunity score)
- `scripts/futures_evaluator.mjs` — Agent-led LONG/SHORT/WAIT/NO_TRADE review; optional Jev
- `scripts/trade_journal.mjs` — Trade logger (disabled by default)
- `scripts/publish_square.mjs` — Square content publisher with Browser Fill fallback
- `scripts/proxy_bootstrap.mjs` — Proxy fallback
- `.agents/skills/` — Official/custom skills; prediction-quant and typesafe-evaluator
- `.env` — Credentials; NEVER echo values

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
- Use `open-tpsl` with SL/TP, risk limits and authorized `--approved`; dry-run previews
- Check both market directions, executable depth and source-backed flows; no adding, reversing or dual holding
- Funding requires asset/product, amount, `--dry-run` or authorized `--approved`; see CEX SOP

### Square Content (Write to Earn)
- STRICTLY zero Markdown in post body (no **bold**, # heading, - list, or emoji walls)
- ≤3 CASHTAGs per post (uppercase, e.g. $BTC $ETH); tags must reference real macro events
- Anchor claims with verified micro-data (funding rate, OI, L/S ratio); end with cold, decisive assertions

### CLI & Network
- Dynamically check `baw` via `baw --version`; TUN mode is default (native run); port-proxy mode is fallback only
- Anti-Duplication: ALWAYS check existing Skills and scripts before building anything new
- Harness portability: use CLI/JSON and adapt orchestration to available client capabilities
- Research: use fresh-context subagents for facts/counterevidence; adapt search and CLI/API tools to tasks
- Jev: with project .env key, autonomously use for relevant probability/risk judgments; without key, use Agent

## Deep Dive Docs (read on demand)

- `docs/sop-cex-trading.md` — CEX trading & quantitative research full SOP
- `docs/sop-square-mining.md` — Square Write-to-Earn 4-step workflow
- `docs/sop-web3-wallet.md` — Web3 wallet operations SOP
- `docs/troubleshooting.md` — API error codes, rate limits & network troubleshooting
- `docs/setup-guide.md` & `docs/network-proxy.md` — Cross-environment deployment & proxy guide
- `docs/prediction-workflow.md` — Agent collaboration and optional Jev

## Agent Checklist

- [ ] Operating in project workspace only — not polluting global directories?
- [ ] Privacy guardrail: NOT outputting any .env real values?
- [ ] If TUN proxy is on, running scripts natively? (proxy_bootstrap only for non-TUN)
- [ ] If generating Square content, strictly plain text (0 Markdown) with ≤3 CASHTAGs and hard data anchors?
- [ ] Checked and reused existing Skills before building anything new?
- [ ] If one-off scripts were needed, placed in `tmp/` and cleaned up after?
