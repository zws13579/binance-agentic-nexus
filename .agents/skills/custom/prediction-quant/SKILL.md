---
name: prediction-quant
description: Binance Web3 预测市场工作流。主 Agent 编排、子 Agent 搜索与上下文隔离、根据情景自主调用已配置的 Jev、独立赔率基准、毛/净 EV、只读历史评分与人工审批；通过通用 CLI/JSON 和客户端可用能力跨 harness 执行。
---

# 预测市场评估与执行

主 Agent 编排任务、核对证据、比较选项和向用户解释判断；长任务中的搜索与独立核查交给具有新上下文的子 Agent。确定性代码负责概率限幅、EV、成本与执行约束。配置 Jev 后，Agent 根据情景自主调用它进行结构化分析；没有 Key 时由 Agent 团队继续完成分析。两种模型的概率在历史验证前均为未校准估计。

## Jev 开关与配置

- 默认 `--provider auto`：项目根目录 `.env` 有非空 `TYPESAFE_API_KEY` 时使用 Jev；没有时直接消费当前 Agent 的 `state.agentAssessment`，不发送 Jev 请求。
- `--provider agent`：显式仅用 Agent 分析；`--provider jev`：要求 Jev，但不能绕过未配置 Key 的禁用状态。
- 地址优先级：`TYPESAFE_ENDPOINT` > `TYPESAFE_BASE_URL` 去除末尾斜杠后加 `/systemone`（只填域名时补 `/v1`） > 官方 `https://api.typesafe.ai/v1/systemone`。模型默认 `jev-latest`，保留 `TYPESAFE_MODEL`。
- 仅配置地址、或 harness 注入进程级 API Key，都不会启用 Jev。不要打印真实凭证。
- 无 Jev 时，扫描、Agent 评估、询价、人工批准后的交易和赎回均可继续。缺少 Agent 分析时，补充真实分析再评估，不制造替代概率。
- 已配置 Key 时，事件概率、入场风险、相互矛盾的证据或候选动作比较等情景自动触发 Jev 分析，无需用户额外指定“调用 Jev”。预测市场常规评估使用默认 auto 模式；直接行情读取和确定性算术由代码完成。

## 标准 CLI

所有命令从项目根目录运行。搜索编排使用当前客户端提供的子 Agent 能力，业务评估与执行使用标准 Node.js CLI/JSON；规则描述分工与输入输出，不固定某个客户端的工具名称。

```bash
# 扫描真实市场；每个市场保留所有 outcomes
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --scan --l1Category esports --limit 5

# 查看机器可读输入契约，不联网、不写文件
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --describe-input

# 输入单个 state 或同一市场的 state 数组；auto 为默认模式
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --file tmp/market-outcomes.json

# 从标准输入接收 JSON，无需创建临时文件
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --provider agent --stdin

# 只读用户提供的历史数据
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --score-file <forecasts.jsonl> --bins 10

# 只读询价；下注金额沿用用户指令，未声明时默认 1 USDT
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --quote --tokenId <id> --marketTopicId <id> --amount 1

# 仅在用户明确批准具体交易后执行
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --execute --quoteId <id> --approved

# LIMIT 询价与执行：必须使用同一订单类型和限价，并沿用报价返回的滑点
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --quote --tokenId <id> --marketTopicId <id> --amount 1 --orderType LIMIT --priceLimit 0.6
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --execute --quoteId <id> --orderType LIMIT --priceLimit 0.6 --slippageBps <报价返回值> --approved

# 结算后按用户授权赎回
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --redeem --tokenIds <id1,id2>
```

`--stdin`、`--json`、`--file` 三选一。Jev 请求默认超时 15000ms，可用 `--timeout-ms` 调整。评估/评分只输出 JSON，不自动保存台账。临时文件放 `tmp/`，用后清理。数学与审批闸门本地检查：`node .agents/skills/custom/prediction-quant/scripts/engine.mjs test`。

quote/execute 默认 `orderType=MARKET` 兼容旧调用；显式只接受 `MARKET` 或 `LIMIT`。LIMIT 必填 `priceLimit`，本封装要求有限 USDT 价格严格在 `(0,1)` 内；这是本封装的约束，不宣称是 BAW 官方完整价格范围。MARKET 禁止携带限价。交易 CLI 拒绝未知、重复、不适用和缺值参数，不静默降级。

LIMIT 不保证 Maker：当前本地 BAW help 未提供 post-only，可能立即撮合。BAW 询价会把股数截断到 2 位小数，`--amount 1` 在 LIMIT 下实际扣款 `amountIn` 可能略低于 1.00 USDT（实测出现过 0.99x），而 Predict.fun 要求订单价值不低于 1.00 USDT，因此最小仓位建议用 `--amount 1.02` 并校验 `Number(amountIn) >= 1.00`。LIMIT 询价返回的 `averagePrice`/`lastPrice` 可能是最新成交价而非限价（同一限价单两次询价曾分别返回 0.28 与 0.29），实际限价以 `Number(amountIn) / Number(amountOut)` 核验。审批必须覆盖选项、金额、订单类型、限价、报价有效期与滑点；quote 和 execute 参数必须一致，执行使用报价返回的 `slippageBps`（旧默认 1000 仅保留兼容性）。本封装只校验本次输入；仅持有不透明 quoteId 时，无法在本地验证报价内容与执行参数绑定，不能声称已完成该验证，须人工核对原始报价与授权。提交成功也不代表成交。

离线参数/CLI 回归：`node --test .agents/skills/custom/prediction-quant/scripts/engine.test.mjs`。测试注入假执行器，CLI 使用隔离本地 stub，临时文件在 `tmp/` 并自动清理；不连接钱包或交易网络。

## 工作步骤

1. **本地预筛与轻量级子 Agent 搜索**：
   - **第 0 步（本地预筛，不派子 Agent）**：不要对未预筛的盘口盲目派发子 Agent。先复用 `--scan` 读取市场，再用 `tmp/` 下的一次性本地脚本（用后清理）读取 BAW 订单簿的 `Best Bid`/`Best Ask`，并请求公开盘口/赔率来源做粗筛。粗筛阈值与引擎同口径：按拟用价格计算毛 EV 百分比，低于引擎的 3% 入场门槛的盘口直接淘汰（概率差 300 bps 在不同价位对应不同 EV%，不能直接当阈值）。Taker 按 `Best Ask` 计算；当 `Ask - Bid >= $0.03` 时可额外评估买一跳价的 Maker 限价，同时说明 Maker 存在不成交与被知情单逆向选择的风险，EV 需按成交概率折扣，目前仅有单笔成交的经验，不能当作成交率。
   - **锚点独立性**：Polymarket 等预测市场与 Predict.fun 大量镜像，只用于排除盘口或交叉核对，不能充当 `sharpBookmaker` 独立锚点；锚点须是带来源与采集时间的去水赔率。Flashscore GraphQL、Bo3.gg 内部接口等并非稳定公开 API，可能随时失效，失败时按未知处理，不回填。
   - **按需调用轻量级子 Agent（跨客户端适配）**：仅对通过粗筛的少数候选或需深挖阵容/伤停/赛程真实性的标的调用子 Agent；若当前客户端/harness 支持选择子 Agent 模型档位，优先选用轻量快速档位（不写死单一厂商模型名）以节约额度。主 Agent 提供最小任务快照并汇总复核，不把整段历史灌入子 Agent。无法取得的数据留为未知；BAW 未登录则如实提示认证，业务路径不使用 Demo/Mock。
2. **汇总证据并做 Agent 分析**：主 Agent 校验子 Agent 返回的赛事、合约、选项映射、引用和采集时间，区分事实、推测、冲突与缺失。按 `--describe-input` 输出的契约构造每侧 state（需 `market`、`marketPrice` 及 eventId/marketId/targetOutcome 等标识，风控字段放在 `allowed`，`executionCosts.stakeUsd` 与 `--amount` 实际扣款一致），中立比较所有 outcomes，为每侧填写 `agentAssessment`；选择 `enter`、`pass` 或 `reject`。算术交由引擎。
3. **按情景自主调用 Jev**：普通组合为 Agent + Jev；有 Key 的事件概率与风险评估默认使用 auto 模式，无需用户再次指定。Agent 动态构建当前情景的 state、instructions 和 criteria；CEX/Web3 的 Choice、Noul、Score 判定按 typesafe-evaluator 的触发规则执行。Jev 只接收证据，不接收 Agent 的概率或执行权限。输出保留双方意见；暂不混合加权。最终采用所选 provider 的概率，有独立锚点时限幅。
4. **呈报与授权**：展示概率来源、未校准状态、毛/净 EV、缺失数据和双方分歧。询价确认实际成本/报价有效期后，用户批准具体选项和金额，才执行 `--approved`。批准之后若报价或金额改变，重新核对授权范围。执行前检查同场已有和在途订单，避免互斥方向重复下注；成功提交不等于已成交，按 BAW 返回状态核对。

子 Agent 搜索须返回来源 URL、发布/采集时间、事件与选项标识、事实摘录、推断依据及未知项；主 Agent 复核关键证据，不能只消费一个无来源的评分。客户端确实没有子 Agent 能力时，公开该限制，按独立来源分段调查；缺乏必要独立核查的结论选择 pass 或等待补充证据，不冒称已完成多人验证。详细分工见 [工作流设计](../../../../docs/prediction-workflow.md)。

## Agent 输入与输出契约

`state.agentAssessment` 是当前 Agent 自己产生的分析，不要求接入新的模型服务。

| 字段 | 要求 |
| --- | --- |
| eventId / marketId / targetOutcome | 非空字符串，与所属 state 完全一致 |
| probability | 数值，0 到 1；非市场价格占位值 |
| action | `enter` / `pass` / `reject`，是候选意见，不是下单授权 |
| source | 实际分析 Agent / 模型标识，不充当外部赔率来源 |
| evaluatedAt | 分析时间 ISO 字符串 |
| rationale | 非空分析依据，引用采集事实，披露缺失证据 |
| expiresAt | 可选截止时间；提供后过期分析被拒绝 |
| confidence | 可选，自报置信度，不是历史命中率 |

每侧 state 还需市场标题、价格、事件/市场/选项标识。独立赔率可选；提供时校验来源、采集时间及目标/对手映射。缺失时 `sharpBookmaker`、锚点概率和锚点错配为未知，不能回填盘口价。成对输入必须共享 eventId/marketId，各 targetOutcome 唯一。

输出要点：

- `evaluation` 记录请求模式、实际 provider、组合模式、选择原因、Jev 状态及失败代码。
- `forecast` 保留市场概率、独立锚点/来源/时间、Agent 与 Jev 原始概率、最终概率、预测时间。`calibrated=false`。
- 无锚点的来源为 `agent_unanchored_estimate` 或 `jev_unanchored_estimate`；有锚点的来源为 `sharp_anchor_bounded_agent_adjustment` 或 `sharp_anchor_bounded_jev_adjustment`。两者对独立锚点最多调整 ±5 个百分点。
- `decision.modelSuggestedAction` 是原始模型意见；`action` 和 `executionEligibility` 是代码检查后的状态。`readyForHumanApproval` 仅表示可交给用户审批，不代表概率已验证，更不会下单。未校准估计可在完整成本/风控检查后交给用户审批。
- Agent 选择 pass/reject 时，Jev 的入场意见不能覆盖它；成对评估失败或多侧同时候选时，整组不可标为可审批，先处理分歧。
- `auto` 中 Jev 网络/HTTP/超时失败时，仅在已提供合法 Agent 分析的情况下使用该分析，并披露失败原因。显式 jev 模式失败则返回失败。Mock、非法概率和异常返回不能触发该回退。

## 成本与风控

- 下注金额沿用用户指令，默认 1 USDT；maxBetUsd 是上限，不能当成下注额。
- 缺流动性、账户余额、限额或执行方向许可时保持未知。低于 1000 USDT 的流动性不通过检查。
- 净 EV 需要同一注额的成本对象 `executionCosts: {totalUsd, stakeUsd, source, observedAt}`；否则只报毛 EV，netEV 为 null。没有默认 2% 费用，也不能推断成本为零。
- 同场不得同时下注互斥方向属于执行约束，不能作为胜率先验。
- 审批要求适用于 Agent-only 和 Agent + Jev 两种模式。

决策卡应包含：事件/选项、行情时间、Agent 原始概率/Jev 原始概率（未使用时明确说明）、独立锚点及来源、最终概率来源、毛 EV、净 EV/成本、未知项、分歧、候选金额和审批状态。

## 历史评分（不自动落盘）

用户提供 JSONL，每行是一笔已结算预测，至少有 `outcome`（0/1）及 `probabilities.workflow`（最终采用概率）。可加 eventId、marketId、targetOutcome、evaluatedAt、`probabilities.human`、`probabilities.market`；概率需对应同一事件、选项与决策时点。

`netPnlUsd` 是已扣实际成本的工作流净盈亏，`actualCostUsd` 可单独披露成本。各基线只有真实成交或回放结果时才填 `netPnlUsdBySource`、`actualCostsUsdBySource`，不从概率虚构盈亏。缺失时净盈亏为未知。

评分输出 Brier、概率校准分箱、命中率、净盈亏；`sameEventComparison` 仅使用三方概率齐全的相同记录。文件只读，输入和报告由用户管理。

## 参考

- [特征和提示词指南](references/jev_prompt_guide.md)：为 Agent 和可选 Jev 准备证据。
- [风控规则](references/risk_rules.md)：金额、持仓、审批和未知数据处理。
- [跨客户端协议与工作流设计](../../../../docs/prediction-workflow.md)：模式选择、迁移和评估与执行规范。
