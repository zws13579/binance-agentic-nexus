# 结构化提示词与特征工程指南 (Prompt & Feature Engineering Guide)

本文档为 `prediction-quant` 技能提供标准特征工程与问题构造指南。

---

## 1. 核心设计原则

### 原则一：严密特征工程 (Feature-Engineered State)
* **严禁**：直接把整篇赛事战报或推特大段文本扔进 `state`，这会导致 Token 消耗激增、注意力分散和概率漂移。
* **推荐**：在输入 Jev 前由前置流程/子代理将信息清洗提炼为精炼结构化数字：
  * `impliedProb`：盘口当前代币买入价格对应的隐含胜率（如 0.60）。
  * `sharpBookmaker.dejuicedProb`：欧洲尖头机构（Pinnacle 等）赔率去水后的真实物理胜率。
  * `discrepancyBps`：错配基点基准差 = $(P_{\text{sharp}} - P_{\text{implied}}) \times 10000$。
  * `sentiment.polarScore`：社区/解说情绪极性数值化（-1.0 到 +1.0）。
  * `sentiment.rosterRisk`：变阵/替补/换人风险系数（0.0 到 1.0）。
  * `sentiment.fatigueRisk`：赛程背靠背/跨时区疲劳系数（0.0 到 1.0）。

### 原则二：“Inputs” 权重引导语法
Jev 能够根据我们显式指定的因果优先级（Inputs priority）对特征进行严格加权：
* **Priority 1 (锚点)**：尖头博彩机构的去水真实概率是统计学基准，权重最高（~60%）。
* **Priority 2 (边际优势)**：盘口错配基点 `discrepancyBps` 衡量交易利差空间（~20%）。
* **Priority 3 (风险折损)**：阵容稳定性与赛程疲劳系数作为打折惩罚项（~15%）。
* **Priority 4 (硬包络线)**：风控 `allowed` 必须无条件服从，若被禁止或额度为 0，直接拒绝（~5%）。

---

## 2. 预测市场标准 Questions 模板

```json
{
  "questions": {
    "direction": {
      "type": "choice",
      "instructions": {
        "goal": "Evaluate whether entering this prediction market position presents a mathematically sound positive expected value (+EV) wager under strict bankroll constraints.",
        "inputs": "Priority 1: Sharp bookmaker dejuiced probability (sharpBookmaker.dejuicedProb) is the ground-truth probabilistic anchor. Priority 2: Discrepancy basis points (discrepancyBps) reflects the market pricing inefficiency over retail consensus. Priority 3: Sentiment polarScore, rosterRisk, and fatigueRisk act as essential haircut discounting factors. Priority 4: Allowed risk envelope must be respected - if maxBetUsd is zero or option is disallowed, immediately reject.",
        "criteria": {
          "execute_plus_ev": "The trade offers statistically sound positive EV (> 3% expected margin) anchored by sharp odds and verified signals with low or manageable operational risks.",
          "reject_negative_ev": "The trade exhibits negative EV, insufficient margin buffer (< 3%), or unacceptable roster/fatigue disruption risks.",
          "pass_no_bet": "The book is illiquid, fair pricing is ambiguous, or outside bankroll risk envelope."
        }
      }
    },
    "calibrated_prob": {
      "type": "noul",
      "instructions": "Determine the true calibrated probability (0.0 to 1.0) that the target outcome wins, incorporating sharp bookmaker fair probability, liquidity slippage, and discounting roster/fatigue penalties."
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

* **期望价值 Expected Value (EV)**：
  $$\text{Payout} = \frac{\text{Stake}}{\text{MarketPrice}}$$
  $$\text{EV} = P_{\text{calibrated}} \times \text{Payout} - \text{Stake}$$
  $$\text{EV \%} = \frac{\text{EV}}{\text{Stake}} \times 100\%$$
