# 跨环境迁移与多 Agent 协同规范

> 迁移自原 AGENTS.md §五，供 Agent 按需读取。

## 1. 更换计算机 / 全新环境部署（3 步极简部署）

当本项目迁移至新计算机、或通过 Git Clone 到新环境时，仅需 3 步即可实现全功能开箱即用：

### Step 1：拉取代码（带子模块递归克隆）

```bash
# 克隆主项目并自动拉取 binance-skills-hub 官方子模块
git clone --recurse-submodules <repository-url>

# 若已执行普通 git clone，执行此命令补拉子模块：
git submodule update --init --recursive
```

### Step 2：安装标准运行底座

- 安装官方标准 Node.js（LTS 版本）
- 打开终端执行标准全局安装：

```bash
npm install -g @binance/agentic-wallet@latest
```

- 验证安装：`baw --version`

### Step 3：恢复凭证与网络

- 参考 `.env.example` 复制或填入本项目的真实凭证创建 `.env`
- 开启网络代理工具（首选开启 TUN 模式，免任何端口配置直接畅连）

### 可选：TypeSafe AI 结构化判定

- 项目根目录 `.env` 的非空 `TYPESAFE_API_KEY` 是 Jev 开关；未配置时不调用 Jev，当前 Agent 继续分析与经人工批准的交易。harness 继承的进程级 Key 不会打开开关。
- 预测市场默认 `--provider auto`：有 Key 使用 Jev；无 Key 使用 Agent 提供的 `state.agentAssessment`。支持 `--provider agent`、`--provider jev`，普通使用为 Agent + Jev。输入契约可用 `engine.mjs --describe-input` 获取。
- 永续合约使用 `scripts/futures_evaluator.mjs --evaluate --stdin --provider auto`；契约通过 `--describe-input` 获取。中立扫描 schema 2 无旧 score，研究用 `--top 20`，默认 4h/1h/15m。多空六情景及资金/串行保护执行见 [CEX SOP](sop-cex-trading.md)。资金迁移使用 Universal Transfer 权限；缺模式不提交，dry-run 和 approved 互斥。
- 配置 Key 后，Agent 按概率估计、交易风险、异常信号或证据冲突等情景自主调用 Jev，并动态构造问题；不要求用户逐次点名。无 Key 时主 Agent 和可用子 Agent 继续执行分析流程。
- 自定义地址保留：`TYPESAFE_ENDPOINT` > `TYPESAFE_BASE_URL` + `/systemone`（只填域名时补 `/v1`） > 官方 `https://api.typesafe.ai/v1/systemone`；模型默认 `jev-latest`，支持 `TYPESAFE_MODEL`。地址/模型的进程变量覆盖同名文件值，Key 的开关只认项目文件。
- 直接调用真实 Jev API 时，缺 Key 或请求失败仍明确报错。auto 模式仅在已有合法 Agent 分析且 Jev 服务故障时公开切换至该分析；Mock/非法概率不走该回退。`--mock` 只用于离线测试。
- 若拉取其官方说明，放于 `.agents/skills/typesafe-ai` 即可；业务自研决策器位于 `.agents/skills/custom/typesafe-evaluator`

### 日常官方 Skills 更新

```bash
git submodule update --remote --merge
```

## 2. 在其他 AI 智能体中使用

本项目具备天然的 **Agent-Agnostic（跨平台智能体通用性）**。

### 记忆与规则导入

新 Agent 进入该项目后，仅需一条提示词引导：

> "请阅读根目录下的 `AGENTS.md`，严格遵循其中的架构规范、Skill 清单与实战 SOP 执行任务。"

### 底层能力无锁定

本项目沉淀的全部 Skill 均基于**标准 CLI 与原生 Node.js / Python 脚本**，没有绑定任何专有协议。任何拥有终端执行权限的 Agent（如 OpenAI Codex、Claude Code、Cursor、Antigravity 等）均可直接运行：

复杂情景、多来源、冲突及长任务须使用当前客户端可用子 Agent 做搜索和新上下文独立核查，主 Agent 汇总并复核证据；按搜索、CLI/API 等任务需求适配能力，不固定工具名称，不全部限制为仅可 research。缺少能力如实说明，必要证据不足时暂缓结论。CLI 接受 JSON 文件、参数或 stdin，报告走 stdout；换 harness 保留契约。配置 Jev 后按情景自主调用，交易与资金操作各需对应授权，相同已有授权直接复用。详细分工见 [Agent 主导与可选 Jev](prediction-workflow.md)。

```bash
# 示例 1：查询全网热度榜 (Official Web3)
node .agents/skills/binance-skills-hub/skills/binance-web3/crypto-market-rank/scripts/cli.mjs token-rank '{"rankType":10}'

# 示例 2：查询链上钱包状态 (Official CLI)
baw wallet status --json

# 示例 3：发布广场动态 (Official CEX)
node .agents/skills/binance-skills-hub/skills/binance/square-post/scripts/post-text.mjs "动态正文..."

# 示例 4：运行自研广场挖矿工作流 (Custom)
node .agents/skills/custom/square-mining/scripts/pipeline.mjs --dry-run
```
