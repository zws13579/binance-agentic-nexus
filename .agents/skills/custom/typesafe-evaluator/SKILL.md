---
name: typesafe-evaluator
description: >-
  Use this skill whenever the agent needs to make objective, probability-calibrated
  decisions or categorical judgments for Web3 and CEX trading operations using
  TypeSafe System One (Jev). Triggers automatically on: (1) CEX/DEX trading risk
  evaluation before opening or closing positions (assessing leverage, volatility,
  or cut-loss urgency); (2) Smart money & whale behavior classification (accumulation
  vs distribution/pump-and-dump); (3) Binance Square post audit before publishing
  (phishing/scam detection, factual plausibility check, sensationalism scoring);
  (4) Any structured decision requiring Choice (discrete categories), Noul (0.0-1.0
  probability), or Score. Executes via node scripts/typesafe.mjs.
---

# TypeSafe Evaluator (System One 业务决策裁决器)

本 Skill 是 BAN 系统的自研业务决策与风控裁决器，它将 TypeSafe System One（Jev 模型）的底层能力与币安现货、合约、链上巨鲸跟单及广场内容挖矿等实战业务深度绑定。

> [!NOTE]
> - **底层概念与官方说明**：参考上游官方说明文档 [`.agents/skills/typesafe-ai/skills/typesafe-ai/SKILL.md`](../../typesafe-ai/skills/typesafe-ai/SKILL.md)。
> - **可选模块声明**：本技能依赖外部 API（官方或第三方中转）。若在 `.env` 中未检测到 `TYPESAFE_API_KEY`，Agent 应自动降级为使用自身内部推理逻辑，不阻断主业务。

---

## 一、核心执行工具：`scripts/typesafe.mjs`

本技能统一调用项目根目录下的执行脚本 [`scripts/typesafe.mjs`](../../../scripts/typesafe.mjs)，完全由 `.env` 配置驱动，免装任何 SDK：

* **API Key**：读取 `TYPESAFE_API_KEY`
* **端点**：读取 `TYPESAFE_ENDPOINT` 或 `TYPESAFE_BASE_URL`（支持任意第三方代理/中转站；默认官方 `https://api.typesafe.ai/v1/systemone`）
* **模型**：读取 `TYPESAFE_MODEL`（默认 `jev-latest`）

---

## 二、自动触发场景与命令配方

当 Agent 处理以下业务情境时，应当自发（无需用户额外提示）调用本裁决器：

### 场景 1：CEX 现货/合约开仓前风控裁决 (Trading Risk Assessment)
在调用 `binance_unified.js` 开单（尤其是高杠杆或单边行情）前，将当前盘口深度、大户多空比、资金费率组成 `state` 进行裁决。

```bash
node scripts/typesafe.mjs \
  --state "Symbol: BTCUSDT, Long/Short Ratio: 0.65, Funding Rate: -0.015%, 1h Price Drop: -4.2%" \
  --choice "safe:低风险可建仓,warning:波动加剧宜观望,danger:极端单边禁止开多"
```

### 场景 2：广场推文/新闻真伪与合规机审 (Square Post Verification)
在运行 [`square-mining`](../square-mining) 自动发帖前，对搜集到的宏观新闻或准备发布的推文做合规、防诈骗与真实性机审：

```bash
# 是非题 (Noul)：检测是否包含虚假或高危引流诈骗信息（返回 0.0 ~ 1.0 是非概率）
node scripts/typesafe.mjs \
  --state "推文草稿或抓取的新闻内容..." \
  --noul "Does this content contain misleading rumors, malicious phishing links, or unauthorized financial guarantees?"
```

### 场景 3：链上聪明钱行为意图研判 (Whale Intent Classification)
结合 `trading-signal` 或 `binance-wallet-tracker` 抓取到的单笔大额交易，判断巨鲸是真实吸筹还是短线拉高出货：

```bash
node scripts/typesafe.mjs \
  --state "Token: ABC, Whale: 0x123..., Net Inflow: $500k, Token Age: 3 hours, Dev Liquidity: Unlocked" \
  --choice "accumulation:真金白银建仓,dump_risk:诱多拉高出货,arbitrage:纯套利搬砖"
```

### 场景 4：完整复合评估 (JSON Mode)
当需要同时并发裁决多个维度时，构造完整 JSON 传入：
```bash
node scripts/typesafe.mjs --json '{
  "state": {
    "symbol": "ETHUSDT",
    "market_depth_ratio": 1.45,
    "funding_rate": 0.0001
  },
  "questions": {
    "should_open_trade": {
      "type": "noul",
      "instructions": "Is current market condition favorable for opening a position?"
    },
    "risk_level": {
      "type": "choice",
      "instructions": "Classify the market risk",
      "criteria": {
        "low": "Stable orderbook, normal funding",
        "medium": "Spreading spread or rising volatility",
        "high": "Liquidity vacuum or abnormal dump"
      }
    }
  }
}'
```

---

## 三、Agent 执行决策流与优雅降级

1. **环境自检**：
   - 检查根目录 `.env` 中是否存在 `TYPESAFE_API_KEY`；
   - 若**已配置**：执行 `node scripts/typesafe.mjs ...` 获取精确类型化判定与概率结果，以此作为风控依据；
   - 若**未配置**：说明用户未启用 TypeSafe 可选模块，Agent 直接采用自身语言模型进行常规分析与推断，并在回答中轻量提示用户“（如需启用 TypeSafe 外部判定，可在 .env 中配置 TYPESAFE_API_KEY）”。
