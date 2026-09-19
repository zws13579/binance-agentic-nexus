---
name: typesafe-evaluator
description: >-
  Use this skill whenever the agent needs to make objective, probability-calibrated
  decisions or categorical judgments for Web3 and CEX operations using TypeSafe System One (Jev).
  Triggers automatically on: (1) trading risk evaluations before opening/closing positions;
  (2) on-chain behavior and intent classification; (3) content verification and anomaly detection;
  (4) any scenario requiring probability-calibrated classification (Choice), condition truth (Noul),
  or graded evaluation (Score). Agent MUST dynamically formulate context-specific state, instructions,
  and criteria in real time from live data, and execute via node scripts/typesafe.mjs.
---

# TypeSafe Evaluator (System One 业务决策裁决器)

本 Skill 是 BAN 系统的自研通用业务决策与风控裁决引擎。它将 TypeSafe System One（Jev 模型）的底层能力与工程实践深度绑定。

> [!IMPORTANT]
> **第一铁律：零预设、零死板模板，从第一性原理动态推演！**  
> 本技能不预设任何僵化的业务场景模板。Agent 必须根据当前面临的**任何实时业务现场**（行情、盘口、链上、舆情、异常流等），自主抽取事实并量身设计判定逻辑。

---

## 一、通用泛型调用骨架 (Generic Blueprint)

所有请求均遵循如下底层泛型数据结构。Agent 在执行时现场填充具体的键名、判断指令与选项解释：

```json
{
  "state": {
    "<现场实体字段_1>": "<一手事实数据 / 实时观测指标>",
    "<现场实体字段_2>": "<事件描述 / 文本全文 / 上下文记录>",
    "<现场指标数据_N>": 0.00
  },
  "questions": {
    "<question_id_a>": {
      "type": "choice",
      "instructions": "<针对当前现场的核心判定问题，必须清晰具体>",
      "criteria": {
        "<分类标签_1>": "<明确定义该分类在该现场的具体特征或数值区间>",
        "<分类标签_2>": "<明确定义互斥的对比特征>",
        "<兜底分类_3>": "<当无明确特征匹配时的判定规则>"
      }
    },
    "<question_id_b>": {
      "type": "noul",
      "instructions": "<是非性命题判定，返回 0.0 ~ 1.0 的成立概率>"
    },
    "<question_id_c>": {
      "type": "score",
      "instructions": "<按程度梯度的量化打分，返回加权位置>",
      "levels": {
        "1": "<最低等级描述>",
        "2": "<中间等级描述>",
        "3": "<最高等级描述>"
      }
    }
  }
}
```

---

## 二、第一性原理动态推理指南 (Reasoning Guidelines)

面对任意全新的情景，Agent 遵循以下原则进行构建：

### 1. `state`（事实输入）构建准则
* **纯客观事实**：仅包含当前可验证的一手数据（抓取到的价格、异动数值、推文原文、链上哈希状态），严禁在 `state` 中混入未经证实的推论；
* **信息高密度**：保留与当前判断直接相关的上下文要素，消除冗余无关噪点；
* **结构化优先**：优先使用多键值的 JSON 对象（键名直接体现指标属性），便于模型建立语义拓扑。

### 2. `questions`（问题与准则）定制准则
* **问题独立且专注**：每一个 question ID 只做一项正交判定；
* **语义闭环**：`instructions` 必须包含完整的前因后果，不能简写为指代不清的短语；
* **选项明确互斥**：在 `choice` 的 `criteria` 中，每个选项的文字描述必须有清晰的判别边界，严禁使用含糊词汇；
* **完备性保证**：当可能存在不符合任何常规分支的情况时，必须预留兜底选项（如 `other` 或 `unclear`）。

---

## 三、执行调用与结果消费

Agent 将现场动态生成的 JSON 传给执行引擎：
```bash
# 方式 A：直接传入动态 JSON
node scripts/typesafe.mjs --json '<Agent现场生成的动态JSON>'

# 方式 B：复杂或长上下文时，先写入 scratch 临时文件再执行 (推荐，避免命令行转义)
node scripts/typesafe.mjs --file /path/to/dynamic_payload.json
```

Agent 读取返回报文中的 `answers.<question_id>`，直接提取 `choice`、`noul`（概率）或 `score` 驱动后续自动化决策。

---

## 四、优雅降级机制（Optional Fallback）

若根目录 `.env` 中未配置 `TYPESAFE_API_KEY`：
1. Agent **绝不报错中止**；
2. Agent 将自身大模型作为本地推理引擎，利用自身语义理解能力在对话中完成上述动态判定；
3. 输出结果并附注提示：*“可配置 TYPESAFE_API_KEY 接入外部 Jev 模型获取标定概率”*。
