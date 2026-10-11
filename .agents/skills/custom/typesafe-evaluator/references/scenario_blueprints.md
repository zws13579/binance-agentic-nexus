# TypeSafe System One (Jev) 量化字段 Schema 规范

本文档归属于自研技能 [`typesafe-evaluator`](../SKILL.md)，仅定义 CEX 量化风控与 Web3 预测市场概率估计的**字段类型与层级规范 (Abstract Schema)**。

项目 .env 有 API Key 时，Agent 根据当前情景自主选用这些请求结构，动态构造 state、instructions 与 criteria，无需用户每次点名 Jev。多来源/复杂情景及长任务使用可用子 Agent 搜索和独立反证；按搜索、CLI/API等任务能力派发，不统一限制为仅 research，主 Agent 复核来源并汇总证据。无 API Key 时继续 Agent 协作分析与经批准的交易；预测市场使用 engine.mjs 的 agentAssessment 契约，不构造 Jev 请求。

> [!CAUTION]
> **防降智铁律：本文档绝不包含任何具体比赛、代币或赔率的 Demo 假数据！**
> 历史实盘中曾发生多次 Agent 上下文膨胀降智后，直接偷懒照抄文档中的 Demo 示例导致重大误判。
> **客观 state 字段由现场 API/可核对来源提供，主观估计单独标注依据；业务输入不能使用硬编码假数据，离线测试 fixture 必须与业务隔离。**

---

## 核心设计法则

1. **结构化 Instructions (`question` + `goal` + `inputs`)**：
   - 显式在 `inputs` 中声明各指标的权威度（如：尖头去水概率是基准，变阵风险是减分项），引导 Jev 在 System One 层面建立拓扑关联。
2. **概率与执行约束分离 (`allowed`)**：
   - 风控题可以使用已核实的账户限制；赛事概率题不携带账户执行许可，避免把禁选方向当作胜率证据。执行限制由代码单独检查。
3. **软指标依据与不确定性**：
   - 记录来源、时间和估计影响方向；没有证据的传闻保持未知，不将文本权重描述当作统计校准。

---

## 规范一：CEX 永续多空、多行情判断

[合约评估入口](../../../../../scripts/futures_evaluator.mjs)接收实际扫描结果与 Agent 判断；通过 --describe-input 输出当前契约。不使用预测市场二元赔付 EV。特征只是证据，不硬编码策略阈值或胜率。

```bash
node scripts/futures_evaluator.mjs --describe-input
node scripts/futures_evaluator.mjs --evaluate --stdin --provider auto
node scripts/futures_evaluator.mjs --evaluate --file tmp/futures-analysis.json --provider agent
```

### 输入字段

- symbol、observedAt（真实采集时间），以及 scannerResult 或 timeframes：包含 4h、1h、15m 的 status 与 features。
- agentAssessment：symbol、direction、setupType、rationale、counterEvidence 字符串数组、invalidations 字符串数组、source、evaluatedAt、expiresAt；入场须有明确失效条件。
- tradePlan：entryPrice、stopLoss、takeProfit、quantity、leverage。
- riskLimits：maxLossUsd、maxNotionalUsd、maxLeverage、maxSlippageBps、source。
- executionChecks：accountModeKnown、flat、noPendingEntry、filtersPassed、availableMarginUsd、slippageBps、observedAt。
- executionCosts：entryUsd、stopExitUsd、targetExitUsd、fundingUsd、quantity、source、observedAt；数量须匹配计划，成本缺失仍可分析但不得称净盈利已确认。
- jevInstructions：可选现场补充问题，不得改变中立证据规则。

扫描证据、成本与执行快照默认在 15 分钟内；Agent evaluatedAt 不早于证据，expiresAt 必须显式提供且报告结束时仍有效。审批就绪不代替执行时的新鲜价格、深度和账户复检。入场需要完整的已收盘特征，不将空 features 对象视为证据。

| setupType | direction | 分析要点 |
|---|---|---|
| breakout_long | LONG | 上沿突破及假突破反证 |
| breakdown_short | SHORT | 下沿跌破及快速收回反证 |
| pullback_long | LONG | 上升趋势回踩及结构失效反证 |
| rebound_short | SHORT | 下降趋势反弹及转强反证 |
| range_bottom_long | LONG | 区间下沿拒绝及向下突破反证 |
| range_top_short | SHORT | 区间上沿拒绝及向上突破反证 |

WAIT / NO_TRADE 必须显式提供 setupType:null，不能省略；rationale / invalidations 说明等待或不交易条件。输出保留 agentAssessment、jevAssessment、providerUsed、jevStatus、direction、setupType、tradePlan、riskChecks、missingData、readyForHumanApproval。风险/成本/执行资料未知时就绪为 false；无 Key 不发 Jev 请求，Agent 分析照常。

### Jev 独立市场判断

实际 payload 由评估器构造，state 只包含可核对市场事实：symbol、observedAt、currentPrice、timeframes、funding、openInterest、orderbook、evidence 与 missingData。排除 Agent 方向/信心、交易计划、权限、风险上限及凭据，避免把先验方向或执行资格当作涨跌证据。

原始扫描保留每周期 200 根；Jev 最小快照仅传每周期最近 8 根已收盘 K 线，保留完整特征、状态和来源时间，并以 closedCandleCount 与 candleWindow 明示原数量和窗口。ChoiceAnswer 必须包含完整类型、方向、confidence 与四方向概率分布；概率和有效，选择应为最大概率之一，非法答案不能用于建议。

questions.direction 使用 choice，criteria 同时提供 LONG、SHORT、WAIT、NO_TRADE。动态 instructions 要求同等比较箱顶/箱底、买卖压力、六情景、假突破/假跌破及两侧拥挤，不单问轧空或只检查 open_long。

账户许可、实际止损几何、滑点、风险预算由代码在独立执行检查中验证。Agent 与 Jev 分歧保留原样，不平均；方向冲突待解决后再审批。非法输出和 Mock 拒绝；auto 只有合法 Agent 判断已存在时对网络超时/连接失败显式回退，HTTP 拒绝不回退。明确成本才能计算净目标盈亏与净止损，净目标盈亏为正且全部检查通过才就绪；不宣称已校准胜率或净正 EV。

---

## 规范二：Web3 预测市场概率估计与 EV 字段规范

调用 `baw prediction` 评估或交易时，必须现场读取盘口数据；独立赔率可选。未提供时不能把市场价格当作独立锚点，也不能虚构错配值：

### 字段结构定义
```json
{
  "state": {
    "match": "<STRING: 真实赛事对阵名称，实时获取>",
    "market_title": "<STRING: 链上盘口具体标题>",
    "target_outcome": "<STRING: 拟下注的目标选项>",
    "chain_market": {
      "token_id": "<STRING: 链上真实 Token ID，从 baw market 详情获取>",
      "current_price": "<FLOAT 或 null: 链上当前买入价格>",
      "implied_prob_pct": "<FLOAT 或 null: 盘口隐含概率>",
      "orderbook_slippage_at_1u_bps": "<INTEGER 或 null: 有实测报价时的滑点>",
      "pool_liquidity_usd": "<FLOAT 或 null: 缺失时保持未知>"
    },
    "independent_anchor": {
      "source": "<来源或 null>",
      "observed_at": "<采集时间或 null>",
      "target_outcome": "<赔率对应目标选项或 null>",
      "opponent_outcome": "<赔率对应对手选项或 null>",
      "target_odds": null,
      "opponent_odds": null,
      "raw_target_probability": null,
      "dejuiced_probability": null,
      "discrepancy_bps": null
    },
    "tactical_intelligence": {
      "roster_stability": "<带来源的变阵情报或 null>",
      "recent_h2h_form": "<有来源的交手战绩或 null>"
    },
    "risk_limits": {
      "allowed": {
        "target_action_allowed": "<BOOLEAN 或 null: 缺数据时为 null>",
        "max_bet_amount_usd": "<FLOAT 或 null: 必须来自实际限额>",
        "account_balance_usd": "<FLOAT 或 null: 必须来自实际账户数据>"
      }
    }
  },
  "questions": {
    "math_ev_verdict": {
      "type": "choice",
      "instructions": {
        "question": "<STRING: 目标选项是否有正毛 EV；已验证成本缺失时净 EV 未知>",
        "goal": "<STRING: 捕获链上流动性定价偏差>",
        "inputs": "<STRING: 有独立赔率时以选项映射验证后的去水概率为锚，Jev 最多调整 ±5 个百分点；缺锚点时 Jev 估计必须标为未校准。成本缺失时只报告毛 EV，账户与限额缺失时风控状态未知>"
      },
      "criteria": {
        "execute_entry": "<STRING: 期望值为正且深度足够>",
        "reject_stale": "<STRING: 无显著优势或期望值为负>"
      }
    }
  }
}
```
