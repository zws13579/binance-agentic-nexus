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

- 本项目核心功能不强依赖 TypeSafe
- 若需启用外部第三方/官方 System One 结构化裁决，只需在 `.env` 中补充 `TYPESAFE_API_KEY`（及可选的 `TYPESAFE_ENDPOINT`）
- 若拉取其官方说明，放于 `.agents/skills/typesafe-ai` 即可

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
