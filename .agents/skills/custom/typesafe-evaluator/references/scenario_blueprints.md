# TypeSafe System One (Jev) 量化字段 Schema 规范

本文档归属于自研技能 [`typesafe-evaluator`](../SKILL.md)，仅定义 CEX 量化风控与 Web3 预测市场概率估计的**字段类型与层级规范 (Abstract Schema)**。

项目 .env 有 API Key 时，Agent 根据当前情景自主选用这些请求结构，动态构造 state、instructions 与 criteria，无需用户每次点名 Jev。长任务使用可用子 Agent 搜索和独立核查，主 Agent 汇总证据。无 API Key 时继续 Agent 协作分析与经批准的交易；预测市场使用 engine.mjs 的 agentAssessment 契约，不构造 Jev 请求。

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

## 规范一：CEX 现货/合约突破开仓硬风控字段规范

启用 Jev 复核时，在开仓前通过代码抓取行情并组装为如下结构。未启用时仍执行 CEX SOP 的行情、止损和授权要求：

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
