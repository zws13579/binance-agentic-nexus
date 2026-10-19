# 预测市场：Agent 主导与可选 Jev

本项目的业务接口是 Node.js CLI、标准输入/输出和 JSON。主 Agent 负责组织任务、汇总证据和形成决策，长任务使用子 Agent 搜索和独立复核。更换 Agent 或 harness 后，读取 AGENTS.md 与 prediction-quant/SKILL.md，并将协作步骤映射到当前客户端提供的能力；业务数据契约保持一致，文档不固定工具名称或会话 ID。

## 配置与模式

项目根目录 .env 中的非空 TYPESAFE_API_KEY 是 Jev 开关。缺 Key、空字符串、只配置地址，都表示禁用 Jev。harness 继承的进程级 Key 不会意外打开此开关；不输出 Key 或修改用户凭证。

| 模式 | Jev 配置 | 行为 |
| --- | --- | --- |
| auto（默认） | 无 Key | 使用当前 Agent 的 agentAssessment，不请求 Jev |
| auto | 有 Key | 主 Agent 汇总已核查的证据，自主调用 Jev 做第二意见 |
| agent | 任意 | 使用 Agent 分析，不调用 Jev |
| jev | 有 Key | 要求 Jev 成功返回合法结果 |
| jev | 无 Key | 返回 jev_disabled，调用方可选择 auto/agent |

地址保留原有优先级：

1. TYPESAFE_ENDPOINT 是完整请求 URL。
2. 没有 endpoint 时，TYPESAFE_BASE_URL 去除末尾斜杠后追加 /systemone（base 如包含 /v1，会保留）。
3. 均未填写时使用 https://api.typesafe.ai/v1/systemone。

地址与模型同名配置仍支持进程变量优先于 .env；Key 只认项目文件。模型默认 jev-latest，可通过 TYPESAFE_MODEL 或评估的 --model 修改。Jev 请求默认期限 15 秒，--timeout-ms 可设置 1 到 120000ms。

## 子 Agent 搜索与长任务上下文隔离

长任务、多来源调查、阵容与疲劳情报搜索或关键证据冲突时，主 Agent 应使用当前客户端可用的子 Agent 能力；但**纯行情读取、跨市场盘口比对（BAW 订单簿 vs Polymarket CLOB vs 外部公开赔率 API）与确定性 EV 预筛必须先由主 Agent 用本地脚本完成（0 模型 Token 消耗）**。

1. **先本地数学预筛，再派子 Agent**：主 Agent 先通过本地脚本批量比对 BAW 实盘买卖盘（含 Taker Ask 与点差 `>= $0.03` 时的 Maker Limit 档位）与公开赔率源，筛出存在 `>= +300 bps` 潜在正边缘的标的，绝不对无赔率差的镜像盘口盲派子 Agent。
2. **子 Agent 优先选用轻量模型档位与最小快照**：对筛出的候选标的调查事实（赛程、首发、伤停）与反证风险时，若当前客户端/harness 支持模型层级参数，优先选用该环境支持的**轻量高速模型档位**（例如 `flash`、`haiku`、`luna` 等，不绑定单一平台或固定模型名），并合并同类查询以控制调用次数。给子 Agent 传递最小任务快照，不复制主 Agent 的长篇历史或把初步方向作为既定结论。
3. 子 Agent 返回来源 URL、发布时间、采集时间、事实摘录、事件/选项映射、推断依据、冲突与未知项。不得用无来源的评分替代证据，或把未找到信息解释为风险为零。
4. 主 Agent 核对关键引用、信息时效和结算条件，汇总双方证据后形成 agentAssessment。长任务按阶段整理简短事实快照；上下文累积、重复推理或结论冲突时，交给新的子 Agent 独立复核。
5. 客户端没有子 Agent 能力时如实披露限制，按独立来源分段调查。必要核查尚未完成时保留未知、选择 pass 或等待补充证据，不声称完成了多人验证。

子 Agent 的数量和分工随任务变化；使用客户端实际提供的协作接口，不依赖某个 Agent 的专有工具名称。子 Agent 的意见与 Jev 判断都需要由主 Agent 核对证据，不能保证消除幻觉。

## 按情景自主调用 Jev

配置 Jev 后，主 Agent 根据问题自主决定调用方式，无需用户每次点名。预测市场的概率估计与候选比较通常使用 engine.mjs 默认 auto 模式；CEX/Web3 的入场或退出风险、异常信号及证据冲突需要结构化第二意见时，使用 typesafe-evaluator 的通用 CLI。

Agent 从当前证据构造 state、instructions 与 criteria，并按判断类型选择 Choice、Noul 或 Score；说明问题、目标、依据和未知项。直接读取行情、确定性算术或格式检查不需要模型。子 Agent 搜索提供事实，Jev 评估已提供的事实，两者承担不同步骤。

.env 无 Key 时跳过 Jev，主 Agent 与可用子 Agent 继续分析、询价及经批准的交易；Jev 不是交易前置条件。显式 provider=agent 仍可用于用户选择的 Agent 分析。模型分析与真实交易授权分开，实际执行继续要求人类审批。

## 统一数据契约

```bash
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --describe-input
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --stdin
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --provider agent --file tmp/market-outcomes.json
```

输入仍兼容原有 state；额外的 agentAssessment 含事件、市场、选项标识、probability、action（enter/pass/reject）、source、evaluatedAt 和 rationale。可附 expiresAt；过期时要求重新分析。Agent-only 模式必须提供真实 Agent 分析；程序不在本地生成或假装调用新的 Agent。若缺分析，返回 agent_assessment_required 和输入契约指引。

普通组合中，主 Agent 汇总并核对搜索证据，形成自己的意见；Jev 请求排除 agentAssessment 与 allowed，降低先前意见和执行权限对概率判断的干扰。输出分别保留原始 Agent/Jev 概率、方向和来源。最终采用所选 provider 的概率，有独立赔率时限制在锚点 ±5 个百分点；暂不平均或学习权重。所有估计均为 calibrated=false。

Agent 的 pass/reject 不会被 Jev 的入场意见覆盖。若 Agent 判断改变，应基于更新的证据重新评估，不能为了通过检查删除否定意见。

## 失败与交易授权

- 无 Key 是正常的 Agent-only 运行模式，不是一次 API 失败。
- auto 中出现网络、HTTP 或超时错误时，只有输入已包含合法 Agent 分析才可继续；evaluation 明确记录实际 provider、reason、jevStatus 和错误代码。
- Jev 缺概率、越界、非法方向、无效 JSON 或 Mock 结果返回失败，不通过自动切换 provider 掩盖异常。显式 jev 模式也不切换。
- 原始模型意见和 executionEligibility 分开。未知成本、缺资金限制、缺流动性等都不能被模型信心填补。统计上未校准的候选可以在人类知情且成本/风险条件完整时交给人类审批。
- 同一市场所有 outcomes 应一起评估。部分失败或多侧候选会清除整组 readyForHumanApproval，先处理分歧；同场持仓和在途订单在执行前另行核对。
- quote / execute 与 Jev 解耦。执行始终要求 --approved；这是宿主 Agent 传递既有人类授权的接口，不会代替人类授权，也不强制任何客户端专有审批 UI。
- 评估只代表输入快照。执行前重新检查报价、成本、持仓和限额；未设置 expiresAt 的分析没有自动新鲜度保证。执行接口本身不重新验证分析报告。

## 工作流设计

| 设计 | 行为 |
| --- | --- |
| 子 Agent 搜索与复核 | 长任务分配独立调查，传递最小快照，主 Agent 核对来源与冲突 |
| 情景自主调用 | 有 Key 时依据当前概率/风险问题构造 Jev 请求；无 Key 继续 Agent 协作 |
| 可选评估来源 | provider=auto/agent/jev，统一输入与评估输出 |
| 判断与执行分离 | 保留原始模型意见，单独输出执行资格；订单提交后按 BAW 状态核对 |
| 请求期限与信息时效 | Jev 请求设定超时；Agent 分析支持显式过期时间 |
| 测试数据隔离 | Mock 仅用于离线验证，业务评估使用真实证据与明确来源的分析 |

候选判断允许 pass/reject。真实交易经过用户审批，评估和评分向标准输出报告，历史数据由用户提供和管理。

## 验证与历史比较

```bash
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --score-file <用户文件.jsonl>
```

内置 test 命令验证数学算子和审批闸门。一次性验证脚本、中间数据与缓存放在 tmp/，完成后清理；需要离线 fixture 时，与真实业务输入隔离。历史评分读用户文件，输出 Brier、校准分箱、命中率、净盈亏与同样本基线比较；不创建台账。没有历史样本时，接口正确与风控检查通过均不能证明准确率优于人工。
