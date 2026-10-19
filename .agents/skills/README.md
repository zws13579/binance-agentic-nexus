# Binance Agentic Nexus (BAN) - Skills 技能体系架构与索引

本项目采用 **「官方 Git Submodule + 本地 Custom 深度解耦」** 的现代化技能治理架构：

```text
.agents/skills/
├── binance-skills-hub/                # 【Git Submodule: 币安官方开源技能中心】
│   │                                  # Upstream: https://github.com/binance/binance-skills-hub
│   └── skills/
│       ├── binance/                   # 【CEX/法币/支付/广场官方技能】
│       │   ├── academy-skill/         # 币安学院官方教育与词汇检索
│       │   ├── binance/               # CEX 现货、合约 (USD-S)、闪兑 (Convert)
│       │   ├── fiat/                  # 币安法币通道、出入金汇率与支付渠道
│       │   ├── onchain-pay/           # 法币买币并直提链上钱包
│       │   ├── p2p/                   # P2P / C2C 盘口比价与订单追踪
│       │   ├── payment/               # Binance Pay 扫码与链接收付款
│       │   └── square-post/           # 币安广场官方 OpenAPI 推流发布能力
│       │
│       └── binance-web3/              # 【Web3/链上/聪明钱/量化官方技能】
│           ├── binance-agentic-wallet/        # Web3 链上智能钱包 (baw) 与 DEX
│           ├── binance-leaderboard/           # 链上交易员排行榜与 6 维画像打分
│           ├── binance-onchain-copy-trader/   # Web3 链上跟单交易器
│           ├── binance-prediction-updown/     # BTC 周期性涨跌预测市场策略脚手架与回测
│           ├── binance-sports-ai-analyzer/    # 体育赛事与预测市场 AI 分析
│           ├── binance-tokenized-securities-info/ # Ondo 美股代币化资产行情与 RWA 数据
│           ├── binance-trading-signal/        # Web3 策略与自定义信号管理
│           ├── binance-wallet-tracker/        # 巨鲸监控、共识买入、筹码吸筹追踪
│           ├── crypto-market-rank/            # 社交热度榜、代币热搜/涨幅榜、聪明钱流入榜
│           ├── meme-rush/                     # 发射台 (Pump.fun/Four.meme) 打新与叙事流
│           ├── query-address-info/            # 钱包地址代币持仓与价值快照
│           ├── query-token-audit/             # 代币安全审计与貔貅/蜜罐检测
│           ├── query-token-info/              # 代币合约、实时价格、流动性与 K 线
│           └── trading-signal/                # 链上聪明钱单笔交易信号与跟单分析
│
├── custom/                            # 【自行研发与编排 Skills】（独立维护，永不冲突）
│   ├── prediction-quant/              # 预测市场概率评估、EV 状态与执行审批工作流
│   ├── square-mining/                 # 广场「内容挖矿」五步自动化全链路工作流
│   └── typesafe-evaluator/            # 情景自主触发的 TypeSafe 分析（配置可选）
│
├── typesafe-ai/                       # 【Git Submodule: 第三方开源官方技能（可选扩展 / Optional）】
│   │                                  # Upstream: https://github.com/typesafe-ai/skills.git
│   └── skills/
│       └── typesafe-ai/
│           ├── SKILL.md               # TypeSafe System One (Jev) 编程模型与状态类型化判断
│           └── LICENSE                # MIT License
│
└── README.md                          # 本说明文档
```

---

## 一、日常维护与官方同步 SOP

### 1. 一键拉取官方最新 Skills
当币安官方发布新技能或修复 Bug 时，在本项目根目录执行一行命令即可：
```bash
# 拉取 upstream 最新 commit
git submodule update --remote --merge
```
或者进入子目录直接拉取：
```bash
cd .agents/skills/binance-skills-hub
git pull origin main
```

### 2. 新环境初次克隆克隆指南
在全新设备克隆本项目时，使用递归克隆即可一次性拉取全部子模块：
```bash
# 一步到位克隆主项目与子模块
git clone --recurse-submodules <repository-url>

# 若已执行普通 git clone，执行此命令补拉子模块：
git submodule update --init --recursive
```

---

## 二、自研核心技能说明 (Custom Skills)

### [`custom/prediction-quant`](./custom/prediction-quant/SKILL.md)
* **定位**：主 Agent 编排、子 Agent 搜索与独立复核的预测市场工作流，包含毛/净 EV 和人工审批；有 Key 时自主调用 Jev，Agent/Jev 概率均为未校准估计。
* **架构精髓**：协作适配当前客户端，长任务传递最小快照并隔离上下文；业务使用标准 CLI/JSON 与 auto/agent/jev 三种模式。.env 无 Key 使用 Agent 分析。有独立锚点时模型调整限制在 ±5 个百分点；缺失数据保持未知，Mock 仅供测试。
* **执行中枢**：[`scripts/engine.mjs`](./custom/prediction-quant/scripts/engine.mjs)，包含成对 outcome 评估、只读历史评分、BAW 深度询价、强制人类审批与赛后批量赎回。

### [`custom/typesafe-evaluator`](./custom/typesafe-evaluator/SKILL.md)
* **定位**：Agent 根据概率、风险、异常、证据冲突和分类/评分需求自主调用 TypeSafe AI (System One)，动态构造判断问题；配置可选，无 Key 时继续 Agent 分析和经批准的交易。长任务使用可用子 Agent 搜索与独立核查。
* **执行中枢**：[`scripts/typesafe.mjs`](./custom/typesafe-evaluator/scripts/typesafe.mjs)（默认模型 `jev-latest`，完全由 `.env` 中的 `TYPESAFE_API_KEY` 与 `TYPESAFE_MODEL` 驱动，具备本地 Pre-flight 静态自愈与确定性 Mock 引擎）。

---

## 三、第三方独立 Skills 说明（可选扩展 / Optional）

### [`typesafe-ai`](./typesafe-ai/skills/typesafe-ai/SKILL.md)
* **性质**：可选扩展项（已注册为独立 Git Submodule，非强制基础依赖；真实 Jev 评估仍需要 TYPESAFE_API_KEY，缺 Key 或请求失败时明确报错，只有显式 --mock 可运行离线测试）。
* **来源**：[typesafe-ai/skills (GitHub)](https://github.com/typesafe-ai/skills)（完全保持官方 submodule 纯净，通过 `git submodule update` 直接同步上游）。
* **定位**：TypeSafe System One 模型（如 Jev）的结构化判断底层概念与编程原语。
* **业务联动**：在业务场景中由自研技能 [`custom/typesafe-evaluator`](./custom/typesafe-evaluator/SKILL.md) 与 [`custom/prediction-quant`](./custom/prediction-quant/SKILL.md) 依据情境调度。

---

## 四、技能发现与跨客户端使用

支持技能自动发现的客户端可读取下列目录索引；其他客户端直接读取 SKILL.md 并运行 CLI。复杂情景、多来源和长任务使用当前客户端的子 Agent 搜索与独立核查，按实际搜索/CLI/API 能力适配，不固定工具名称或全部 research；业务 CLI/JSON 保持通用。有 Key 时 Agent 按情景自主调用 Jev，无 Key 时继续协作分析。

在根目录 [`.agents/skills.json`](../skills.json) 中已注册多路径扫描入口：
```json
{
  "entries": [
    { "path": ".agents/skills/binance-skills-hub/skills/binance" },
    { "path": ".agents/skills/binance-skills-hub/skills/binance-web3" },
    { "path": ".agents/skills/custom" },
    { "path": ".agents/skills/typesafe-ai/skills" }
  ]
}
```
