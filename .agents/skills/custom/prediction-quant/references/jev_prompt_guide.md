# 结构化提示词与特征工程指南 (Prompt & Feature Engineering Guide)

本文档为 `prediction-quant` 提供标准特征和可选 Jev 的问题构造指南。长任务由子 Agent 搜索事实和反证，主 Agent 核查来源、时间和选项映射后生成 agentAssessment；.env 无 API Key 时继续 Agent 协作。有 Key 时 Agent 根据当前概率/风险情景自主调用 Jev 复核相同证据，输入中剔除 Agent 的原始概率与执行许可，分别保存双方意见，不自动平均加权。

---

## 1. 核心设计原则

### 原则一：严密特征工程 (Feature-Engineered State)
* **严禁**：直接把整篇赛事战报或推特大段文本扔进 `state`，这会导致 Token 消耗激增、注意力分散和概率漂移。
* **推荐**：硬数据由 API/采集脚本提供；长任务的情报搜索与反证核查交给使用新上下文的子 Agent。主 Agent 将证据提炼为结构化字段，保留来源、时间和不确定性；没有依据的风险或情绪分数保持未知：
  * `impliedProb`：盘口当前代币买入价格对应的隐含胜率（如 0.60）。
  * `sharpBookmaker.dejuicedProb`：独立赔率来源去水后的概率基准；它是外部基准，不应宣称为已知的真实胜率。
  * 独立基准同时需要 `source`、`observedAt`、`targetOutcome`、`opponentOutcome`，并与待评估选项匹配。
  * `discrepancyBps`：错配基点基准差 = $(P_{\text{sharp}} - P_{\text{implied}}) \times 10000$。
  * `sentiment.polarScore`：社区/解说情绪极性数值化（-1.0 到 +1.0）。
  * `sentiment.rosterRisk`：变阵/替补/换人风险系数（0.0 到 1.0）。
  * `sentiment.fatigueRisk`：赛程背靠背/跨时区疲劳系数（0.0 到 1.0）。

### 原则二：“Inputs” 权重引导语法
`inputs` 文字只能表达判断优先级，不能保证模型执行了精确数值权重，也不等于统计校准。
* 有经来源和选项映射验证的独立基准时，以它为锚，代码将所选 Agent 或 Jev 概率影响限制在 ±5 个百分点。
* 没有独立基准时可展示所选模型的独立估计，标记 agent_unanchored_estimate 或 jev_unanchored_estimate，不把自报置信度当作历史准确度。
* 缺失的流动性、阵容、疲劳、资金和交易成本信息必须保持未知；不要通过 prompt 让模型填补虚构数值。
* 同场防双向下注属于执行约束，不要在尚未对比 outcomes 时把某一方向预先写成不可选。

---

## 2. 预测市场标准 Questions 模板

```json
{
  "questions": {
    "direction": {
      "type": "choice",
      "instructions": {
        "goal": "Estimate the target outcome from supplied evidence and assess its gross expected margin. Execution limits and authorization are checked separately by code.",
        "inputs": "Use an independently sourced, outcome-matched dejuiced probability as a benchmark when available. If absent, estimate from the supplied evidence and explicitly label the result uncalibrated. Missing liquidity, roster, fatigue, bankroll, or cost information is unknown and must not be inferred. Execution restrictions are not evidence about which outcome is more likely.",
        "criteria": {
          "execute_plus_ev": "The supplied evidence supports a positive gross expected margin (> 3%). If no independent probability anchor is available, describe the result only as an uncalibrated model estimate; it is not verified edge.",
          "reject_negative_ev": "The trade exhibits negative EV, insufficient margin buffer (< 3%), or unacceptable roster/fatigue disruption risks.",
          "pass_no_bet": "The book is illiquid, evidence is insufficient, or fair pricing is ambiguous."
        }
      }
    },
    "jev_probability_estimate": {
      "type": "noul",
        "instructions": "Estimate the probability (0.0 to 1.0) that the named target outcome wins from the supplied evidence. This estimate is not statistically calibrated. Do not invent missing odds, liquidity, roster, fatigue, bankroll, or cost data."
    },
    "risk_score": {
      "type": "score",
      "instructions": "Assess the risk category of this position based on volatility, information asymmetry, and series format stability.",
      "criteria": [
        "Very Low Risk - Elite liquidity, massive statistical edge (>500 bps), highly stable roster in standard BO3 format.",
        "Low Risk - Solid positive EV, stable roster, verified sharp bookmaker alignment.",
        "Medium Risk - Moderate positive EV, minor roster adjustments, or slight schedule fatigue.",
        "High Risk - Thin margin edge (<200 bps), high variance BO1 format, or retail-dominated volume.",
        "Extreme Risk - Negative EV, major emergency substitute, or severe liquidity trap."
      ]
    }
  }
}
```

---

## 3. 数学模型计算公式

* **欧赔去水 (Multiplicative De-juicing)**：
  $$S = \frac{1}{\text{Odds}_A} + \frac{1}{\text{Odds}_B}$$
  $$P_A = \frac{1 / \text{Odds}_A}{S}, \quad P_B = \frac{1 / \text{Odds}_B}{S}$$

* **毛期望价值 Expected Value (EV)**：
  $$\text{Payout} = \frac{\text{Stake}}{\text{MarketPrice}}$$
  $$\text{Gross EV} = P_{\text{adopted estimate}} \times \text{Payout} - \text{Stake}$$
  $$\text{EV \%} = \frac{\text{EV}}{\text{Stake}} \times 100\%$$
* 采用概率在独立锚点存在时限制为锚点 ±5 个百分点；否则使用所选 Agent 或 Jev 的未校准估计。该估计不因进入公式而变成已校准概率。
* 净 EV 还要扣除同一注额对应的实际总成本；成本来源、采集时间或适用下注额缺失时，净 EV 未知，不可默认费用为零。
