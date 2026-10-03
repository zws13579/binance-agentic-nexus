---
name: typesafe-evaluator
description: >-
  Use this skill whenever the agent needs to make objective, probability-calibrated
  decisions or categorical judgments for Web3 and CEX operations using TypeSafe System One (Jev).
  Triggers automatically on: (1) trading risk evaluations before opening/closing positions;
  (2) on-chain smart money and predictive market event probability calibration; (3) risk anomaly detection;
  (4) any scenario requiring probability-calibrated classification (Choice), condition truth (Noul),
  or graded evaluation (Score). Agent MUST dynamically formulate context-specific state, instructions,
  and criteria in real time from live data, and execute via node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs.
---

# TypeSafe Evaluator (System One 业务决策裁决器)

本 Skill 是 BAN 系统的自研通用业务决策与风控裁决引擎。它将 TypeSafe System One（默认且唯一标准别名绑定 `jev-latest`）底层能力与高频实盘量化工程深度绑定。

> [!IMPORTANT]
> **核心原则：特征结构化、权重明确化、风控事前包络化！**
> 工业级量化最佳实践：
> 1. **严禁无指导长文盲目喂入**：`instructions` 优先采用包含 `inputs` 引导的对象结构，显式告知 Jev 各特征权威度与优先级；
> 2. **事前风控注入**：在 `state.allowed` 中显式固化资金上限与合规开仓方向；
> 3. **模型别名规范**：严格由环境解析默认模型为 `jev-latest`，严禁在任何脚本或参数中硬编码特定后端构建版本号。

> [!CAUTION]
> **绝对防降智铁律：严禁硬编码或使用任何 Demo / Mock 假数据！**
> 历史实盘中曾多次发生 Agent 因上下文过长发生认知疲劳（降智）后，直接偷懒照抄 Demo 示例数据或伪造行情的重大失误。
> **所有 `state` 字段必须由 API（CEX 现货/合约 API 或 BAW 链上预测盘口）现场实时抓取构建，严禁使用任何静态 demo 文件或硬编码假数据！**

---

## 一、通用泛型调用骨架 (Generic Blueprint)

所有请求遵循 TypeSafe v1 HTTP 规范。Agent 现场动态填充客观事实与判定指标：

```json
{
  "state": {
    "market": "<交易对或赛事对阵>",
    "metrics": {
      "<指标1>": 0.00,
      "<指标2>": 0.00
    },
    "allowed": {
      "<action_a>": true,
      "<action_b>": false,
      "max_risk_usd": 1.00
    }
  },
  "questions": {
    "<question_id_choice>": {
      "type": "choice",
      "instructions": {
        "question": "<核心判定问题>",
        "goal": "<当前决断的业务目标与止损预期>",
        "inputs": "<显式指导 Jev 如何权衡上述指标：例如哪个指标是第一信号，哪个指标是折损因子>"
      },
      "criteria": {
        "<选项_1>": "<明确的成立条件描述>",
        "<选项_2>": "<互斥的对比条件描述>"
      }
    },
    "<question_id_noul>": {
      "type": "noul",
      "instructions": "<是非性命题判定，返回 0.0 ~ 1.0 的连续成立概率>",
      "criteria": {
        "true": "<yes 的含义说明 (可选)>",
        "false": "<no 的含义说明 (可选)>"
      }
    },
    "<question_id_score>": {
      "type": "score",
      "instructions": "<程度梯度的量化打分>",
      "criteria": [
        "<Level 0 描述>",
        "<Level 1 描述>",
        "<Level 2 描述>"
      ]
    }
  }
}
```

> [!NOTE]
> **官方 v1 规范提醒**：`score` 题型强制使用 2~10 级的有序字符串数组 `criteria: ["描述1", "描述2", ...]`。底层的 Pre-flight 自愈器已支持自动将旧版 `levels` 转换为标准数组，但编写时请直接遵循 v1 规范。

---

## 二、实战推理与防幻觉四大防线 (Anti-Hallucination Guidelines)

在长时间（超 1000 步）对话中，为防止长上下文污染与 Agent 幻觉向 Jev 投毒，严格执行以下四道物理防线：

1. **硬数据代码直通（Zero-LLM Touching）**：
   * 盘口价、订单薄深度、外网去水胜率、持仓量、滑点等纯数字，必须由脚本直接通过 API 读取并写入 JSON，严禁主 Agent 在对话里进行二次口算估算；
2. **软数据强凭证与非对称减法**：
   * 针对新闻、变阵、替补等非结构化情报，必须附带一手来源引用；无确凿证据时一律保守归零（`roster_risk: 0.0`）；
   * 软指标只能充当“减分项/一票否决项”，交易信号的主驱动力必须来自硬数据的正期望 (+EV)；
3. **隔离子代理接单（Stateless Subagents）**：
   * 若主对话步数过长，严禁疲劳的主 Agent 在本上下文中进行复杂的情报主观推演，必须调用 `invoke_subagent` 派发 0 历史污染的全新子代理完成调研；
4. **决策看板原始数据穿透**：
   * 呈报人类审批时，必须同时并列呈现脚本抓取的原始数据与 Jev 标定概率，让人类一眼识别事实偏差。

---

## 三、执行调用与结果消费

本技能脚本完全内聚收拢在自身目录中，直接执行：

```bash
# 方式 A：直接传入动态 JSON (简单短输入)
node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --json '<Agent现场生成的动态JSON>'

# 方式 B：通过受 .gitignore 保护的 tmp/ 文件夹执行 (强烈推荐，避免长文本与字符转义错乱)
# 1. 创建 tmp 目录并将现场事实写入临时 Payload
mkdir -p tmp
# Agent 将 live payload 写入 tmp/payload.json

# 2. 调用内核执行评估 (亦可加 --mock 离线模拟)
node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --file tmp/payload.json

# 3. 评估完成后必须立即物理清理临时文件，确保工作区始终保持 Clean 纯净状态
rm -f tmp/payload.json
```

> [!IMPORTANT]
> **临时产物与目录卫生铁律 (Directory Hygiene)**：
> - 所有一次性产物、中间 JSON、临时计算脚本**必须且仅能写入受 `.gitignore` 保护的 `tmp/` 文件夹**（如 `tmp/payload.json`）；
> - 严禁写入项目根目录、`scripts/` 或任何代码资产目录；
> - 执行完成后（无论成功或异常）**必须立即执行 `rm -f tmp/...` 进行物理清理**，绝不残留垃圾文件。

### 返回值解析与度量消费
* **连续概率分布**：读取 `answers.<id>.probabilities` 获取精细概率（如 `{"optA": 0.95, "optB": 0.05}`）；
* **离散选择**：读取 `answers.<id>.choice`；
* **性能与成本审计**：读取 `metrics.latencyMs`（推理耗时）与 `metrics.costUsd`（Token 计费），并同步记录至审计台账。

---

## 四、双轨优雅降级机制 (Dual-Track Fallback)

当未配置 `TYPESAFE_API_KEY` 或网络离线时：
1. **数学计算代码硬接管**：
   * `typesafe.mjs` 自动激活内置的确定性 `MockEvaluator`，由代码原生根据去水公式与赔率错配计算 EV，输出绝对不可篡改的代码基准事实（`isMock: true`），**严禁 Agent 在对话里用感觉口算赔率**；
2. **语义裁决隔离子代理补充**：
   * 若确实存在需要大模型主观理解的战术定性问题，由无历史污染的独立子代理完成打分；
3. **人类终审明确标注**：
   * 输出决策卡片时明确标注来源（`[源自 Jev-latest 标定]` 或 `[源自 代码数学Mock + 子代理复核]`），确保决策链路全透明。

---

## 五、场景蓝图参考

直接参考成熟的生产级量化决策模板：[`references/scenario_blueprints.md`](./references/scenario_blueprints.md)
* 蓝图 1：CEX 现货/合约突破开仓硬风控 (`trading_gatekeeper`)
* 蓝图 2：Web3 预测市场胜率校准与 +EV 发现 (`prediction_calibration`)

> [!NOTE]
> **关于币安广场内容治理**：广场发帖与内容挖掘由 [`square-mining`](../square-mining/SKILL.md) 技能独立负责，零 Markdown 格式校验由纯代码/正则瞬间完成，文案创作由 Agent 大脑现场生成，**无需且不应调用 Jev**，避免不必要的 API 消耗与延迟。Jev 专精于低延迟客观概率标定与量化风控。
