---
name: typesafe-evaluator
description: >-
  Optional TypeSafe System One (Jev) structured second opinion for Web3/CEX probability,
  categorical and risk judgments. Use when Jev is configured or explicitly requested.
  Without a project .env API key, the host Agent continues the normal analysis and
  approved trading workflow. Portable Node.js CLI/JSON; no harness-specific tools.
---

# TypeSafe Evaluator (System One 业务决策裁决器)

本 Skill 为 BAN 提供可选的结构化第二意见，默认模型为 `jev-latest`。Agent 负责现场分析与用户沟通，代码负责算术和执行闸门。Jev 的意见不构成交易授权。

项目根目录 `.env` 中未配置非空 `TYPESAFE_API_KEY` 时不使用 Jev；客户端继承的进程级 Key 不会启用它。预测市场应使用 `engine.mjs --evaluate` 的默认 auto 模式，由当前 Agent 填写 agentAssessment 继续。直接调用本 Skill 的真实 API 功能仍会如实报告缺 Key。

保留地址配置：`TYPESAFE_ENDPOINT` 优先，其次 `TYPESAFE_BASE_URL` + `/systemone`，均未填写时为 `https://api.typesafe.ai/v1/systemone`。支持 `TYPESAFE_MODEL`，不绑定特定后端构建版本。地址/模型同名配置维持进程变量优先于文件值的兼容行为，Key 的启用开关始终在项目文件中。

> [!IMPORTANT]
> **核心原则：特征结构化、权重明确化、风控事前包络化！**
> 工业级量化最佳实践：
> 1. **严禁无指导长文盲目喂入**：`instructions` 优先采用包含 `inputs` 引导的对象结构，显式告知 Jev 各特征权威度与优先级；
> 2. **概率与风控分开**：只有风控题需要执行约束；赛事概率题不把资金上限或禁止下注方向作为概率证据，执行检查由代码完成；
> 3. **模型别名规范**：严格由环境解析默认模型为 `jev-latest`，严禁在任何脚本或参数中硬编码特定后端构建版本号。

> [!CAUTION]
> **生产评估不得使用 Demo / Mock 假数据；Mock 只允许显式离线测试。**
> 历史实盘中曾多次发生 Agent 因上下文过长发生认知疲劳（降智）后，直接偷懒照抄 Demo 示例数据或伪造行情的重大失误。
> **state 中的客观行情由现场 API/可核对来源提供，主观分析单独标注来源与依据。业务路径禁止静态 Demo 和硬编码假数据；离线测试 fixture 必须与业务隔离。**

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
2. **软数据保留凭证与不确定性**：
   * 针对新闻、变阵、替补等非结构化情报，必须附带一手来源引用；无确凿证据时标记为未知，不要用 roster_risk: 0.0 代替缺失；
   * 解释每项证据影响估计的方向与依据；不把传闻当作事实，也不将提示词中的优先级宣称为已验证的数值权重；
3. **重新核对证据**：
   * 长上下文中重新读取事实来源与采集时间，并缩减输入到当前问题相关的数据。单个 Agent 即可执行；工作流不依赖特定客户端的子代理、记忆或审批工具；
4. **决策看板原始数据穿透**：
   * 呈报人类审批时并列呈现原始事实、Agent 判断与可选 Jev 估计，标注来源与分歧，禁止把模型概率称为已校准胜率。

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

# 2. 调用内核执行真实评估 (需要 TYPESAFE_API_KEY)
node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --file tmp/payload.json

# 仅测试输入解析时显式指定 --mock；Mock 输出是中性占位数据，不能作为业务判断
node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --file tmp/payload.json --mock

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
* **性能与成本审计**：读取 metrics.latencyMs（推理耗时）与 metrics.costUsd（Token 计费）；仅由调用方已启用的审计流程负责持久化，预测历史不会自动落盘。

---

## 四、真实评估失败处理与 Mock 隔离

- 直接请求 Jev 时，缺少项目 `.env` 的 `TYPESAFE_API_KEY`、网络失败或 API 错误均如实报错。默认请求/响应期限 15 秒；不自动重试或切换到 Mock。
- 预测市场的 auto 编排在无 Key 时直接使用真实 Agent 分析；Jev 服务故障时，只有已提供合法 Agent 分析才可继续，并公开 Jev 失败状态。显式 jev 模式及非法模型返回不使用该回退。
- `--mock` 仅用于本地 schema/调用链测试，输出 `metrics.isMock: true`、中性概率与空方向；任何业务评估器都必须拒绝将其生成交易建议。
- 预测市场流程中的概率仍须标记来源和校准状态；Mock 或 Jev 自报 confidence 都不能代替历史赛果评分。无独立赔率时可展示未校准 Jev 估计，但不得将其描述为已验证优势。

---

## 五、场景蓝图参考

直接参考成熟的生产级量化决策模板：[`references/scenario_blueprints.md`](./references/scenario_blueprints.md)
* 蓝图 1：CEX 现货/合约突破开仓硬风控 (`trading_gatekeeper`)
* 蓝图 2：Web3 预测市场概率估计与 +EV 评估 (`prediction_probability_estimation`)

> [!NOTE]
> **关于币安广场内容治理**：广场发帖与内容挖掘由 [`square-mining`](../square-mining/SKILL.md) 技能负责，文案由 Agent 生成，格式由代码校验，无需调用 Jev。
