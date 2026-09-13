# AGENTS.md - Binance Agentic 统一运行规范与项目知识库

> 本文件是本项目（`binance-agentic` / `agitated-raman`）的最高运行准则与全景记忆文档。  
> 任何后续对话中的 Agent 进驻本项目时，**必须第一时间阅读并严格遵循本文档所载的所有架构、规范与经验精髓**，严禁重复造轮子，严禁脱离现有资产盲目开发。

---

## 一、项目核心背景与基本准则

1. **项目定位**：
   - 本项目致力于构建一套基于 AI 智能体（Agent）驱动的币安综合生态交互与量化投研系统，打通 **Web3 链上智能钱包**、**CEX 现货/合约量化与盘口追踪**、**全网 Alpha 聪明钱/情绪情报监控** 以及 **币安广场（Binance Square）内容挖矿自动化**。
2. **第一铁律：严禁重复造轮子**：
   - 本项目经历过多轮深度对话演进，沉淀了极其丰富的本地 Skill、环境配置与核心脚本。
   - **禁止**在没有检查项目现有资产的情况下自行重写测试脚本或安装冗余依赖。
   - **禁止**向全局目录乱放配置文件；项目所有扩展功能均以本项目工作区本地优先。
3. **防“降智”与长会话隔离准则**：
   - 历史多轮对话经验证明，单个对话在达到 50~100 轮交互后会出现严重的上下文拥挤和认知衰退（俗称“降智”）。
   - 新开会话时，Agent 必须以本项目根目录的 `AGENTS.md`、`.env`、`.agents/skills/` 和 `scripts/` 作为唯一权威事实来源，无需重新询问用户已知背景。

---

## 二、运行环境与网络基础设施规范

### 1. 网络代理机制与运行方式
* **网络现状**：访问币安服务（CEX REST API、Web3 接口、Square 端点、DNS 解析）在特定网络环境下需要代理支持。
* **双模式代理支持**：
  1. **TUN 模式（系统级透明代理，首选日常状态）**：
     - 当前环境已配置 TUN 虚拟网卡代理。在 TUN 模式开启时，操作系统会在网络层接管所有进出流量。
     - **脚本执行**：所有自定义 Node.js / Python 脚本或系统命令均可**直接原生运行**（如 `node your_script.mjs`），无需附加任何代理引导参数。
  2. **端口代理模式（备用方案 / TUN 关闭时）**：
     - 若未开启 TUN 模式，本地 HTTP/SOCKS 代理端口通常为 `http://127.0.0.1:7890`（已在 `.env` 中定义 `HTTP_PROXY` 与 `HTTPS_PROXY`）。
     - **为何存在 [`./scripts/proxy_bootstrap.mjs`](./scripts/proxy_bootstrap.mjs)**：Node.js 原生 `fetch`（基于 `undici`）默认不会主动读取 Windows 环境变量中的 `HTTP_PROXY`。在**纯端口代理环境（无 TUN）**下，可通过 `node --import ./scripts/proxy_bootstrap.mjs your_script.mjs` 注入 `ProxyAgent` 作为备用通道；而在 TUN 模式正常工作时，完全无需挂载此脚本。

### 2. 命令行工具维护规范（`baw` CLI）
* **完全动态与按需更新原则**：
  - `baw`（`@binance/agentic-wallet`）处于高频迭代期，**禁止在文档或逻辑中硬编码任何特定版本号**，以防后续会话因静态版本信息产生误判。
  - CLI 工具已注册至系统 `PATH`，全局各终端均可直接执行 `baw` 命令。
* **动态检查与按需升级**：
  - Agent 在执行涉及钱包或相关 Skill 的任务时，应以各 Skill 的 `requiredCliVersion` 声明或 npm 远端最新版为准动态适配。
  - 若提示版本不匹配或遇到新接口需求，执行动态检查与升级：
    ```bash
    # 动态查看本地安装版本与远端最新版本
    baw --version
    npm view @binance/agentic-wallet version
    # 升级到官方最新发布版
    npm install -g @binance/agentic-wallet@latest
    ```
  - 升级后按当前调用的 Skill 目标版本执行校验：
    ```bash
    baw cli-check --required-version <target-version> --json
    ```
* **已知问题：升级后端口代理注入丢失**（仅端口代理模式相关）：
  - `npm install -g` 会重写 `baw.cmd` 和 `baw.ps1` 入口脚本，导致手动注入的 `--import proxy_bootstrap.mjs` 参数被覆盖。
  - **TUN 模式用户可忽略**：TUN 开启时 `baw` 无需 `--import` 也能正常联网。
  - 若需恢复端口代理支持，在 `baw.cmd` 最后一行的 `"%_prog%"` 后、`"%dp0%\..."` 前插入：
    ```
    --import "file:///<项目绝对路径>/scripts/proxy_bootstrap.mjs"
    ```
    `baw.ps1` 中类似，在所有 `node` 调用参数中追加相同的 `--import` 标志。

### 3. 环境变量配置规范（`.env`）
根目录下的 [`.env`](./.env) 文件包含了项目全部关键凭证，Agent 应直接读取该文件（**注意：禁止在对话与日志中明文打印 Secret**）：
* `BINANCE_API_KEY` / `BINANCE_SECRET_KEY`：币安 CEX API 密钥对。
* `BINANCE_API_ENV`：API 环境类型（默认 `prod`）。
* `HTTP_PROXY` / `HTTPS_PROXY`：本地备用代理地址（`http://127.0.0.1:7890`）。
* `BINANCE_CHAIN_ID`：Web3 默认链 ID（如 BSC: `56`，Solana: `CT_501`）。
* `BINANCE_SQUARE_OPENAPI_KEY`：币安广场 Open API 内容发布 Key。

---

## 三、项目技能体系（20 个 Skill 全景清单）

所有 Skill 统一存放于项目工作区目录 [`.agents/skills/`](./.agents/skills/) 下，完全与全局配置隔离。

### 1. Web3 链上钱包与资金流（3 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`binance-agentic-wallet`](./.agents/skills/binance-agentic-wallet) | Web3 钱包连接、代币转账、DEX 交易、签名、DeFi 质押、预测市场 | `baw <command> --json` |
| [`onchain-pay`](./.agents/skills/onchain-pay) | 法币买币并直接提至链上钱包（一键购币直达） | `sign_and_call.sh` |
| [`payment`](./.agents/skills/payment) | Binance Pay 扫码与链接收付款（C2C / PIX） | `python payment_skill.py` |

### 2. 市场热度、代币筛选与情报发现（6 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`crypto-market-rank`](./.agents/skills/crypto-market-rank) | 社交热度榜、代币热搜/涨幅榜、聪明钱净流入榜、Meme 发射台打新榜、交易员盈亏榜 | `node .agents/skills/crypto-market-rank/scripts/cli.mjs <cmd>` |
| [`query-token-info`](./.agents/skills/query-token-info) | 查代币合约、实时价格、流动性、池子、K线与社交信息 | `node .agents/skills/query-token-info/scripts/cli.mjs <cmd>` |
| [`query-address-info`](./.agents/skills/query-address-info) | 查单个钱包地址的多链代币持仓与价值快照 | `node .agents/skills/query-address-info/scripts/cli.mjs <cmd>` |
| [`query-token-audit`](./.agents/skills/query-token-audit) | 代币安全审计、貔貅/假币/蜜罐合约检测 | 内置合约安全审计模型 |
| [`trading-signal`](./.agents/skills/trading-signal) | 单笔链上聪明钱买卖信号、跟单收益率分析 | `node .agents/skills/trading-signal/scripts/cli.mjs <cmd>` |
| [`meme-rush`](./.agents/skills/meme-rush) | Pump.fun / Four.meme 等发射台实时打新与叙事流 | `node .agents/skills/meme-rush/scripts/cli.mjs <cmd>` |

### 3. 巨鲸与交易员追踪分析（3 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`binance-leaderboard`](./.agents/skills/binance-leaderboard) | Web3 交易员排行榜、Gem Hunter（寻宝）钱包筛选、6维交易画像打分 | `baw leaderboard <subcommand>` |
| [`binance-wallet-tracker`](./.agents/skills/binance-wallet-tracker) | 钱包跟踪监控、共识买入检测、筹码吸筹/派发分析、大单异动监控 | `baw tracker <subcommand>` |
| [`binance-trading-signal`](./.agents/skills/binance-trading-signal) | 平台策略、自定义信号策略管理与回测分析 | `baw signal <subcommand>` |

### 4. 股票代币化与预测赛道（2 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`binance-tokenized-securities-info`](./.agents/skills/binance-tokenized-securities-info) | Ondo 美股代币化资产（AAPL/NVDA/MSFT）行情、RWA 储备证明、美股基本面与K线 | 查询 Ondo RWA API |
| [`binance-sports-ai-analyzer`](./.agents/skills/binance-sports-ai-analyzer) | 体育赛事与预测市场 AI 分析 | 赛事预测模型 |

### 5. CEX 交易、法币与 P2P（3 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`binance`](./.agents/skills/binance) | CEX 现货、合约（USD-S）、闪兑（Convert） | REST API / `binance-cli` |
| [`fiat`](./.agents/skills/fiat) | 币安法币通道、出入金汇率、支付渠道与限额查询 | REST API |
| [`p2p`](./.agents/skills/p2p) | P2P / C2C 广告盘口比价、订单追踪与商户资料 | REST API |

### 6. 广场生态与教育赋能（3 个）
| 技能目录 | 说明 | 核心调用方式 |
| :--- | :--- | :--- |
| [`square-mining`](./.agents/skills/square-mining) | 广场「内容挖矿」五步自动化工作流（热点选品→市场数据→新闻求证→拟真文案→自动发帖） | `/square-mining` 或自然语言触发 |
| [`square-post`](./.agents/skills/square-post) | 币安广场自动发帖（短动态、长文章、带图帖、视频帖） | `node .agents/skills/square-post/scripts/post-*.mjs` |
| [`academy-skill`](./.agents/skills/academy-skill) | 币安学院官方教育内容（词汇表、课程、学赚体系） | 知识问答检索 |

---

## 四、核心实战 SOP 与避坑指南

### 1. Web3 智能钱包操作 SOP
1. **连接前置验证**：
   ```bash
   baw wallet status --json
   ```
   若未登录则调用 `baw auth signin` 进行扫码授权。
2. **转账与下单安全原则**：
   - 必须先获取预估报价与 Gas 价格（`baw wallet gas-price`）。
   - 严格遵循每日限额（`baw wallet left-quota`），大额转账必须二次确认。
3. **美股代币化资产（bStocks）套利监控**：
   - 关注美股开盘时段链上 Ondo 代币（`NVDA`、`AAPL`）与现实股价的折溢价波动，结合持仓监控脚本实现自动止盈。

### 2. CEX 现货/合约 API 交互 SOP
1. **防止时间戳错误（`-1021`）**：
   - 每次签名请求前，先请求 `GET https://api.binance.com/api/v3/time` 计算本地系统时差，在 query 参数中加上 `recvWindow=10000`。
2. **防止签名错误（`-2015`）**：
   - 严格采用 HMAC SHA256 加密 `queryString`，确保无多余空格，且 Headers 必须携带 `X-MBX-APIKEY`。
3. **深度与巨鲸资金流分析**：
   - 结合订单簿深度买卖墙差额（Bid/Ask Depth Ratio）与聪明钱净流入榜，判断支撑位是否牢固。

### 3. 币安广场「内容挖矿 (Write to Earn)」SOP
1. **第一步：热点与聪明钱选品**：
   - 调用 `crypto-market-rank` 抓取热搜榜与聪明钱大幅净流入的币种。
2. **第二步：真伪查验与新闻求证**：
   - 通过 Web Search 检索过去 24 小时真实宏观/行业事件（CPI、美联储会议、巨鲸解锁），严禁胡编乱造。
3. **第三步：真人交易员拟真文案**：
   - **文案绝对禁忌**：**严禁使用任何 Markdown 格式**（禁止 `**加粗**`、禁止 `# 标题`、禁止 `- 列表`、禁止表格）。广场显示 Markdown 会造成格式乱码。
   - **正确格式**：采用自然段落换行、表情符号点缀、包含大写 CASHTAG（如 `$BTC`、`$SOL`）以及活动标签（如 `#Write2Earn`、`#BinanceSquare`）。
4. **第四步：API 自动化推流发布**：
   - 读取 `.env` 中的 `BINANCE_SQUARE_OPENAPI_KEY`，使用 `post-text.mjs` 或 `post-image.mjs` 直接上链/上推。

---

## 五、跨环境迁移与多 Agent（Codex / Claude / Cursor）协同规范

### 1. 更换计算机 / 全新环境部署（3 步极简部署）
当本项目迁移至新计算机、或通过 Git Clone 到新环境时，仅需 3 步即可实现全功能开箱即用：
1. **拉取代码**：
   - 克隆或拷贝本项目文件夹。项目内置的 20 个 Skill（`.agents/skills/`）、代理模块（`scripts/`）、`.env.example` 与 `AGENTS.md` 将完整随身带入新环境。
2. **安装标准运行底座**：
   - 安装官方标准 Node.js（LTS 版本）；
   - 打开终端执行标准全局安装：
     ```bash
     npm install -g @binance/agentic-wallet@latest
     ```
   - 验证安装：`baw --version`。
3. **恢复凭证与网络**：
   - 参考 [`.env.example`](./.env.example) 复制或填入本项目的真实凭证创建 `.env`；
   - 开启网络代理工具（首选开启 TUN 模式，免任何端口配置直接畅连）。

### 2. 在其他 AI 智能体（Codex / Claude Code / Cursor / Windsurf）中使用
本项目具备天然的 **Agent-Agnostic（跨平台智能体通用性）**：
* **记忆与规则导入**：
  - 新 Agent 进入该项目后，仅需一条提示词引导：
    > “请阅读根目录下的 `AGENTS.md`，严格遵循其中的架构规范、20 个 Skill 清单与实战 SOP 执行任务。”
* **底层能力无锁定**：
  - 本项目沉淀的全部 20 个 Skill 均基于**标准 CLI 与原生 Node.js / Python 脚本**，没有绑定 Antigravity 专有协议。
  - 任何拥有终端执行权限的 Agent（如 OpenAI Codex、Claude Code、Cursor 等）均可直接运行：
    ```bash
    # 示例 1：查询全网热度榜
    node .agents/skills/crypto-market-rank/scripts/cli.mjs token-rank '{"rankType":10}'
    # 示例 2：查询链上钱包状态
    baw wallet status --json
    # 示例 3：发布广场动态
    node .agents/skills/square-post/scripts/post-text.mjs "动态正文..."
    ```

---

## 六、项目文件目录树全景

```text
agitated-raman/ (binance-agentic)
├── .agents/
│   └── skills/                  # 本项目专属的 20 个 Binance 官方技能包
│       ├── binance-agentic-wallet/
│       ├── crypto-market-rank/
│       ├── square-post/
│       ├── trading-signal/
│       └── ... (其余 16 个 Skill)
├── scripts/
│   └── proxy_bootstrap.mjs     # 备用网络代理引导入口（仅非 TUN 纯端口代理模式时使用）
├── .env                         # 核心凭证配置文件（勿提交至公共仓库）
├── .env.example                 # 环境变量配置模板（公开、供新环境复现）
├── .gitignore                   # Git 忽略规则
└── AGENTS.md                    # 本项目最高规则与知识库说明书 (当前文件)
```

---

## 七、Agent 自检清单（每次执行任务前对照）

- [ ] 是否确认了当前是在项目工作区本地操作，未污染全局目录？
- [ ] 若 TUN 代理已开启，是否已直接运行原生脚本？（仅在非 TUN 环境下才需挂载 proxy_bootstrap）
- [ ] 若操作 `baw`，是否确认 CLI 版本满足当前 Skill 依赖，并在有新版本发布时及时跟进升级？
- [ ] 若生成广场内容，是否严格确保了纯文本排版（**0 Markdown**）并挂载了 CASHTAG？
- [ ] 是否优先检索并复用了本项目的 20 个现成 Skill，杜绝了重复造轮子？
