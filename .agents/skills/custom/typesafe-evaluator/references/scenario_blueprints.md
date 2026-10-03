# TypeSafe System One (Jev) 量化字段 Schema 规范

本文档归属于自研技能 [`typesafe-evaluator`](../SKILL.md)，仅定义 CEX 量化风控与 Web3 预测市场胜率校准的**字段类型与层级规范 (Abstract Schema)**。

> [!CAUTION]
> **防降智铁律：本文档绝不包含任何具体比赛、代币或赔率的 Demo 假数据！**  
> 历史实盘中曾发生多次 Agent 上下文膨胀降智后，直接偷懒照抄文档中的 Demo 示例导致重大误判。  
> **所有 `state` 字段必须在执行时由 API（CEX API 或 BAW Prediction API）现场实时抓取，严禁硬编码或使用任何静态假数据！**

---

## 核心设计法则

1. **结构化 Instructions (`question` + `goal` + `inputs`)**：
   - 显式在 `inputs` 中声明各指标的权威度（如：尖头去水概率是基准，变阵风险是减分项），引导 Jev 在 System One 层面建立拓扑关联。
2. **事前风控硬包络 (`allowed`)**：
   - 在 `state.allowed` 中显式注入账户资金上限与合规动作（如 `allowed: { opt_a: true, opt_b: false }`），使模型决策严格收敛于合规空间。
3. **软指标“非对称减法”**：
   - 舆情、伤病、传闻只能作为风险折扣（Penalty）或一票否决项，主驱动力永远是硬数据的数学正期望 (+EV)。

---

## 规范一：CEX 现货/合约突破开仓硬风控字段规范

在调用 `scripts/binance_unified.js open-tpsl` 开仓前，必须通过代码动态抓取行情并组装为如下类型结构：

### 字段结构定义
```json
{
  "state": {
    "symbol": "<STRING: 交易对，如从行情接口获取>",
    "market_type": "USDT_M_FUTURES",
    "current_price": "<FLOAT: 实时撮合价>",
    "breakout_metric": {
      "box_high_price": "<FLOAT: 箱体阻力位>",
      "breakout_depth_pct": "<FLOAT: 突破幅度百分比>",
      "volume_surge_ratio_20p": "<FLOAT: 20周期成交量放大倍数>"
    },
    "derivatives_flow": {
      "funding_rate": "<FLOAT: 实时资金费率>",
      "oi_change_24h_pct": "<FLOAT: 24小时持仓量变化率>",
      "top_trader_long_short_ratio": "<FLOAT: 大户多空比>",
      "orderbook_bid_ask_depth_ratio": "<FLOAT: 订单簿买卖深度比>"
    },
    "risk_envelope": {
      "planned_stop_loss_pct": "<FLOAT: 止损距离百分比>",
      "reward_risk_ratio": "<FLOAT: 盈亏比>",
      "position_size_usdt": "<FLOAT: 开仓名义金额>",
      "allowed": {
        "open_long": "<BOOLEAN: 是否允许做多>",
        "open_short": "<BOOLEAN: 是否允许做空>",
        "max_leverage": "<INTEGER: 最大允许杠杆>"
      }
    }
  },
  "questions": {
    "execution_verdict": {
      "type": "choice",
      "instructions": {
        "question": "<STRING: 是否确认顺势突破入场？>",
        "goal": "<STRING: 过滤假突破并确保滑点与手续费覆盖>",
        "inputs": "<STRING: 明确指出资金费率、大户比与订单簿支撑墙的判定权重。若 allowed.open_long 为 false 则拒绝>"
      },
      "criteria": {
        "approve_entry": "<STRING: 量价共振且深度充足的标准>",
        "reject_fakeout": "<STRING: 诱多假突破或衰竭量的特征>",
        "wait_pullback": "<STRING: 短期超买等待回踩确认的特征>"
      }
    },
    "squeeze_intensity": {
      "type": "noul",
      "instructions": "<STRING: 轧空爆发概率是否大于预期阈值？>"
    }
  }
}
```

---

## 规范二：Web3 预测市场胜率校准与 +EV 发现字段规范

在调用 `baw prediction` 交易前，必须通过 `baw` 与外网接口抓取真实数据并组装：

### 字段结构定义
```json
{
  "state": {
    "match": "<STRING: 真实赛事对阵名称，实时获取>",
    "market_title": "<STRING: 链上盘口具体标题>",
    "target_outcome": "<STRING: 拟下注的目标选项>",
    "chain_market": {
      "token_id": "<STRING: 链上真实 Token ID，从 baw market 详情获取>",
      "current_price": "<FLOAT: 链上当前买入价格>",
      "implied_prob_pct": "<FLOAT: 盘口隐含胜率>",
      "orderbook_slippage_at_1u_bps": "<INTEGER: 测算的1U滑点基点>",
      "pool_liquidity_usd": "<FLOAT: 实时流动性池规模>"
    },
    "sharp_benchmark": {
      "pinnacle_price": "<FLOAT: 欧洲尖头盘欧赔>",
      "dejuiced_true_prob_pct": "<FLOAT: 纯代码数学公式去水后的真实胜率>",
      "mispricing_discrepancy_bps": "<INTEGER: 胜率错配基点 (去水胜率 - 隐含胜率)>",
      "calculated_ev_pct": "<FLOAT: 数学期望值 EV>"
    },
    "tactical_intelligence": {
      "roster_stability": "<STRING: 必须带原文引用的变阵情报，无变阵则标 stable>",
      "recent_h2h_form": "<STRING: 真实交手战绩>"
    },
    "risk_limits": {
      "allowed": {
        "target_action_allowed": "<BOOLEAN: 是否符合单注与持仓硬风控>",
        "max_bet_amount_usd": "<FLOAT: 严禁超过 1.00 USDT>"
      }
    }
  },
  "questions": {
    "math_ev_verdict": {
      "type": "choice",
      "instructions": {
        "question": "<STRING: 目标选项在扣除滑点后是否为明确的数学正期望 (+EV)？>",
        "goal": "<STRING: 捕获链上流动性定价偏差>",
        "inputs": "<STRING: 尖头去水胜率为第一基准。错配点差必须覆盖滑点。战术变阵只能作为折扣因子>"
      },
      "criteria": {
        "execute_entry": "<STRING: 期望值为正且深度足够>",
        "reject_stale": "<STRING: 无显著优势或期望值为负>"
      }
    }
  }
}
```
