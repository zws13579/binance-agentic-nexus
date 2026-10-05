# 预测市场：Agent 主导与可选 Jev

本项目的业务接口是 Node.js CLI、标准输入/输出和 JSON。更换 Agent 或 harness 后，读取 AGENTS.md 与 prediction-quant/SKILL.md 即可继续；不需要特定客户端的工具名称、记忆服务、子代理接口或会话 ID。

## 配置与模式

项目根目录 .env 中的非空 TYPESAFE_API_KEY 是 Jev 开关。缺 Key、空字符串、只配置地址，都表示禁用 Jev。harness 继承的进程级 Key 不会意外打开此开关；不输出 Key 或修改用户凭证。

| 模式 | Jev 配置 | 行为 |
| --- | --- | --- |
| auto（默认） | 无 Key | 使用当前 Agent 的 agentAssessment，不请求 Jev |
| auto | 有 Key | 通常由 Agent 提供事实和分析，Jev 做第二意见 |
| agent | 任意 | 使用 Agent 分析，不调用 Jev |
| jev | 有 Key | 要求 Jev 成功返回合法结果 |
| jev | 无 Key | 返回 jev_disabled，调用方可选择 auto/agent |

地址保留原有优先级：

1. TYPESAFE_ENDPOINT 是完整请求 URL。
2. 没有 endpoint 时，TYPESAFE_BASE_URL 去除末尾斜杠后追加 /systemone（base 如包含 /v1，会保留）。
3. 均未填写时使用 https://api.typesafe.ai/v1/systemone。

地址与模型同名配置仍支持进程变量优先于 .env；Key 只认项目文件。模型默认 jev-latest，可通过 TYPESAFE_MODEL 或评估的 --model 修改。Jev 请求默认期限 15 秒，--timeout-ms 可设置 1 到 120000ms。

## 统一数据契约

```bash
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --describe-input
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --stdin
node .agents/skills/custom/prediction-quant/scripts/engine.mjs --evaluate --provider agent --file tmp/market-outcomes.json
```

输入仍兼容原有 state；额外的 agentAssessment 含事件、市场、选项标识、probability、action（enter/pass/reject）、source、evaluatedAt 和 rationale。可附 expiresAt；过期时要求重新分析。Agent-only 模式必须提供真实 Agent 分析；程序不在本地生成或假装调用新的 Agent。若缺分析，返回 agent_assessment_required 和输入契约指引。

普通组合中，Agent 整理同一份现场证据并形成自己的意见；Jev 请求排除 agentAssessment 与 allowed，降低先前意见和执行权限对概率判断的干扰。输出分别保留原始 Agent/Jev 概率、方向和来源。最终采用所选 provider 的概率，有独立赔率时限制在锚点 ±5 个百分点；暂不平均或学习权重。所有估计均为 calibrated=false。

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
