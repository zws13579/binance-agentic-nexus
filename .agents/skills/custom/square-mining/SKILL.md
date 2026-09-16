---
name: square-mining
description: >-
  Use this skill when the user wants to run the Binance Square Write to Earn (内容挖矿) 5-step automated workflow,
  publish a post or article to Binance Square based on trending topics and smart money data, or types /square-mining.
  Orchestrates trends scraping, CEX/Web3 market metrics, news verification, natural living-trader copywriting (strictly zero markdown),
  and auto-publishing via square-post OpenAPI.
---

# 币安广场【内容挖矿】五步工作流 (Square Mining Workflow)

本技能按照 Google Antigravity 官方技能规范设计，通过编排工作区已有的兄弟技能，实现从热点挖掘到自动发帖的全链路自动化。

## 适用场景与触发

- **斜杠命令**：`/square-mining`
- **自然语言意图**：
  - “帮我跑一下广场内容挖矿”
  - “抓取最新热点发一篇广场动态”
  - “根据当下盘面和聪明钱写一篇广场帖子并发布”

---

## 目录结构 (Directory Structure)

```text
.agents/skills/custom/square-mining/
├── SKILL.md                          # 本说明主文档
├── scripts/
│   └── pipeline.mjs                  # 可执行底层批处理管线 (支持 --dry-run / --publish)
└── references/
    └── copywriting_rules.md          # 详细去AI味法则、零Markdown铁律与平台合规规则
```

---

## 五大执行阶段 (Five Stages)

### Step 1: 广场热搜借势标签池 (Square Trends)
1. 抓取 `https://www.binance.com/zh-CN/square/trends` 页面，结合 `crypto-market-rank` 的 `social-hype` 接口。
2. 提取当前讨论热度最高的 1~2 个官方热门标签（如 `#Wintermute存入ETH`、`#Revolut数据泄露`、`#Zcash挖矿激增`、`#全网爆仓`）。
3. 降低 trends 选题权重，仅作为正文末尾附着的**借势流量入口**，核心议题由 Step 3 权威新闻决定。

### Step 2: 调取市场盘面与聪明钱动向 (Market & Whale Inflows)
1. **CEX 核心盘面**：调取主流资产（`BTC`、`ETH`、`ZEC`、`DOGE`、`LTC` 等）现货 24h 涨跌幅与合约最新资金费率（识别多空挤压/轧空）。
2. **Web3 链上动向**：
   - 调取 `crypto-market-rank` 的 `smart-money-inflow` 获取 24h 净流入榜；
   - 调取 `trading-signal` 的 `smart-money` 获取链上巨鲸最新买卖点位。

### Step 3: 传统权威金融媒体与加密机构要闻聚合 (Authoritative News & Macro)
1. **传统顶级金融媒体源**：
   - **CNBC Finance & Economy**（宏观经济、美联储货币政策、通胀指标、华尔街动向）；
   - **Yahoo Finance**（华尔街机构动向、传统资本流向、综合路透与彭博快讯）；
   - **MarketWatch (Dow Jones)**（美股与大宗商品走势对加密市场的溢出效应）。
2. **加密原生机构媒体**：
   - **国际机构加密媒体：The Block**（深度监管动态、机构级链上研究与宏观分析）；
   - **全球行业媒体：CoinTelegraph**（突发行业要闻与权威媒体快讯）；
   - **币安官方交易所公告**（新币上线、下架预警、网络升级、保证金变动 — 100% 官方，杜绝造假）。

### Step 4: 选题加权与多模态去 AI 味动态创作 (Anti-Shadowban Engine)
> 详细规范参阅：[copywriting_rules.md](./references/copywriting_rules.md)

1. **多模态自适应主题模型（彻底消除固定模板指纹）**：
   - **宏观联动型 (Macro)**：围绕美联储利率、通胀与美股大盘，解析对大饼以太的流动性压制；
   - **链上博弈型 (Whale)**：围绕做市商（如 Wintermute）转币、期权对冲与清算流动性猎杀；
   - **叙事突发型 (Narrative)**：围绕 ETF 申请/清算、老币算力与突发题材，拆解庄家拉高出货套路；
   - **安全风控型 (Security)**：围绕金融机构泄露（如 Revolut）、钓鱼空投与授权风险，提供交易员避险指南。
2. **彻底杜绝 AI 味与模板重复**：
   - 每次生成采用完全不同的开篇句式、核心论点与论述框架，严防平台 Shadowban 隐性限流；
   - 采用第一人称老交易员口吻，适度带有口语化交流感与冷峻风控提醒；
   - 严禁使用机械套话：“教科书级”、“多空双杀”、“重磅利好”、“飞灰湮灭”、“综上所述”、“值得注意的是”。
3. **零 Markdown 格式（严禁使用任何语法符号）**：
   - 严禁出现 `**` 加粗、`#` 标题、`-` 列表横杠、Markdown 链接、以及成排装饰 Emoji（🚨、📊、⚠️）；
   - 所有段落通过自然空行（回车换行）分隔。
4. **内容挖矿合规与 Cashtag 限制**：
   - 必须嵌入 1~3 个交易对 Cashtags（如 `$BTC`、`$ETH`、`$ZEC`），**严格不得超过 3 个**（防止触发 API 220095 报错）；
   - 正文末尾自然附带 Step 1 挑选的 1~2 个热门话题标签。

### Step 5: 官方 OpenAPI 上传发布 (Publish)
1. 调取 `square-post` 技能（复用 `lib.mjs` 中的 `publish` 函数）。
2. 带 `--publish` 时执行全自动端到端闭环发帖（0 确认）；带 `--dry-run` 时提供预览。
3. 输出帖子 ID 与币安广场正式分享链接。

---

## 自动化运行助手 (Executable Helper)

本技能在 [scripts/pipeline.mjs](./scripts/pipeline.mjs) 提供了自包含的可执行工具脚本，支持在终端或定时任务中无缝运行：

```bash
# 试运行预览模式 (查看抓取数据与生成文案，不实际发帖)
node .agents/skills/square-mining/scripts/pipeline.mjs --dry-run

# 实际发布短动态 (全自动跑完五步并直接上传到币安广场)
node .agents/skills/square-mining/scripts/pipeline.mjs --publish

# 发布长文章形态
node .agents/skills/square-mining/scripts/pipeline.mjs --publish --article
```
