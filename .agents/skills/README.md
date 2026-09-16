# Binance Agentic Nexus (BAN) - Skills 技能分层架构与索引

本项目将所有 Agent 技能进行清晰的物理分层与职责解耦，划分为两大核心目录：

```text
.agents/skills/
├── official/                      # 【Binance 官方原生 Skills】（保持上游纯净）
│   ├── academy-skill/             # 币安学院官方教育与词汇检索
│   ├── binance/                   # CEX 现货、合约 (USD-S)、闪兑 (Convert)
│   ├── binance-agentic-wallet/    # Web3 链上钱包、DEX 交易、质押与签名
│   ├── binance-leaderboard/       # 链上交易员排行榜与 6 维画像打分
│   ├── binance-sports-ai-analyzer/# 体育赛事与预测市场 AI 分析
│   ├── binance-tokenized-securities-info/ # Ondo 美股代币化资产行情与 RWA 数据
│   ├── binance-trading-signal/    # Web3 策略与自定义信号管理
│   ├── binance-wallet-tracker/    # 巨鲸监控、共识买入、筹码吸筹追踪
│   ├── crypto-market-rank/        # 社交热度榜、代币热搜/涨幅榜、聪明钱流入榜
│   ├── fiat/                      # 币安法币通道、出入金汇率与支付渠道
│   ├── meme-rush/                 # 发射台 (Pump.fun/Four.meme) 打新与叙事流
│   ├── onchain-pay/               # 法币买币并直提链上钱包
│   ├── p2p/                       # P2P / C2C 盘口比价与订单追踪
│   ├── payment/                   # Binance Pay 扫码与链接收付款
│   ├── query-address-info/        # 钱包地址代币持仓与价值快照
│   ├── query-token-audit/         # 代币安全审计与貔貅/蜜罐检测
│   ├── query-token-info/          # 代币合约、实时价格、流动性与 K 线
│   ├── square-post/               # 币安广场官方 OpenAPI 推流发布能力
│   └── trading-signal/            # 链上聪明钱单笔交易信号与跟单分析
│
├── custom/                        # 【自行研发与编排 Skills】（定制化/组合型）
│   └── square-mining/             # 广场「内容挖矿」五步自动化全链路工作流
│
└── README.md                      # 本说明文档
```

---

## 一、分层设计理念

1. **`official/`（币安官方原生技能）**：
   - 包含币安官方发布的原子能力与生态接口规范。
   - 保持与官方版本一致。当官方发布新版本或新技能时，可直接在 `official/` 下进行升级或增补，无需担心覆盖项目自研代码。
2. **`custom/`（本地自研与定制技能）**：
   - 存放本项目针对实际量化、情报与套利场景自主研发的复合技能、工作流管线或定制模型。
   - 可跨目录按需调用 `../official/` 中的官方原子能力（如 `crypto-market-rank`、`square-post` 等）。

---

## 二、Antigravity 自动发现配置

在 `.agents/skills.json` 中已注册扫描入口：
```json
{
  "entries": [
    { "path": ".agents/skills/official" },
    { "path": ".agents/skills/custom" }
  ]
}
```
