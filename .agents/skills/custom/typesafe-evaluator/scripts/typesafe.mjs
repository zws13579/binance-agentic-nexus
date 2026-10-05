#!/usr/bin/env node
/**
 * TypeSafe AI (System One) 原生量化执行内核与通用客户端
 * 归属: .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs
 * 
 * 特性:
 * 1. 纯原生 Node.js (ESM)，零外部依赖，安全驱动。
 * 2. 严格动态模型解析: 默认 'jev-latest'，完全由 .env 中的 TYPESAFE_MODEL 驱动，零写死版本。
 * 3. 本地 Pre-flight 静态模式自愈: 自动纠正 criteria 嵌套错位、旧版 levels -> criteria 数组平滑升级，杜绝 422 报错。
 * 4. 确定性 Mock 评估引擎: 仅支持显式 --mock 测试，不会在生产评估中静默降级。
 * 5. 毫秒级延迟与成本计量: 自动注入 latencyMs 与 Jev Token 费用 (costUsd)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project-local configuration, independent of the invoking harness and working directory.
const envPath = path.resolve(__dirname, '../../../../../.env');

function loadEnv() {
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match) {
        let val = match[2].trim();
        if (val.startsWith('"') || val.startsWith("'")) {
          const end = val.indexOf(val[0], 1);
          val = end < 0 ? '' : val.slice(1, end);
        } else val = val.split('#')[0].trim();
        env[match[1]] = val;
      }
    }
  }
  return env;
}

/**
 * 获取当前全局运行配置
 * 严格遵从项目规范：默认模型为 'jev-latest'
 */
export function getConfig() {
  return resolveTypeSafeConfig(loadEnv(), process.env);
}

/** Pure config resolution; credentials are never included in CLI status output. */
export function resolveTypeSafeConfig(env, runtimeEnv = {}) {
  // The project .env is the enable switch, including for the standalone client.
  const apiKey = String(env.TYPESAFE_API_KEY || '').trim();
  
  const clean = value => typeof value === 'string' ? value.trim() : '';
  let endpoint = clean(runtimeEnv.TYPESAFE_ENDPOINT) || clean(env.TYPESAFE_ENDPOINT);
  if (!endpoint) {
    const baseUrl = clean(runtimeEnv.TYPESAFE_BASE_URL) || clean(env.TYPESAFE_BASE_URL);
    if (baseUrl) {
      endpoint = baseUrl.replace(/\/+$/, '') + '/systemone';
    } else {
      endpoint = 'https://api.typesafe.ai/v1/systemone';
    }
  }

  // 默认且唯一标准别名绑定 jev-latest
  const model = clean(runtimeEnv.TYPESAFE_MODEL) || clean(env.TYPESAFE_MODEL) || 'jev-latest';

  return { apiKey, endpoint, model };
}

/**
 * 本地 Pre-flight 静态校验与自动自愈
 * 修复常见 Schema 错位，确保符合 TypeSafe v1 HTTP 规范
 */
export function validateAndNormalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload 必须是一个有效的 JSON 对象');
  }

  if (!payload.state && payload.state !== '' && payload.state !== 0) {
    throw new Error('缺少评估状态 (state)，请提供待评估的上下文数据');
  }

  if (!payload.questions || typeof payload.questions !== 'object' || Object.keys(payload.questions).length === 0) {
    throw new Error('缺少判定问题 (questions)，请根据业务场景定义具体的判定项');
  }

  const normalizedQuestions = {};

  for (const [qId, qDef] of Object.entries(payload.questions)) {
    if (!qDef || typeof qDef !== 'object') {
      throw new Error(`问题 [${qId}] 定义无效，必须为包含 type 和 instructions 的对象`);
    }

    const q = { ...qDef };

    if (!q.type || !['choice', 'noul', 'score'].includes(q.type)) {
      throw new Error(`问题 [${qId}] 缺少合法的 type (必须为 'choice' | 'noul' | 'score')`);
    }

    if (!q.instructions) {
      throw new Error(`问题 [${qId}] 缺少 instructions 指令内容`);
    }

    // 自愈 1: 若 criteria 误嵌套在 instructions 内部，自动平移到 question 顶层
    if (typeof q.instructions === 'object' && !Array.isArray(q.instructions)) {
      if (q.instructions.criteria && !q.criteria) {
        q.criteria = q.instructions.criteria;
        const cleanInstructions = { ...q.instructions };
        delete cleanInstructions.criteria;
        q.instructions = cleanInstructions;
      }
    }

    // 自愈 2: 针对 score 题型，处理历史 levels 字段向 v1 criteria 数组的平滑迁移
    if (q.type === 'score') {
      if (!q.criteria && q.levels) {
        if (Array.isArray(q.levels)) {
          q.criteria = q.levels;
        } else if (typeof q.levels === 'object') {
          // 将对象的 values 转换为有序 criteria 数组
          q.criteria = Object.values(q.levels);
        }
        delete q.levels;
      }

      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        throw new Error(`Score 题型 [${qId}] 必须包含 2 到 10 个等级描述的 criteria 数组 (例如: ["低", "中", "高"])`);
      }
    }

    // 自愈 3: 针对 choice 题型校验 criteria 必须为 map 且至少 2 个选项
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new Error(`Choice 题型 [${qId}] 必须包含 criteria 选项映射 (例如: {"optA": "...", "optB": "..."})`);
      }
      const optCount = Object.keys(q.criteria).length;
      if (optCount < 2 || optCount > 255) {
        throw new Error(`Choice 题型 [${qId}] criteria 至少需要 2 个互斥选项 (最多 255 个)`);
      }
    }

    normalizedQuestions[qId] = q;
  }

  return {
    ...payload,
    questions: normalizedQuestions
  };
}

/**
 * 确定性 Mock 评估引擎 (Deterministic Mock Engine)
 * 仅用于显式测试；其中性占位结果不可作为业务概率或交易建议。
 */
export function mockEvaluate(normalizedPayload, overrideModel) {
  const { model: configModel } = getConfig();
  const modelName = overrideModel || configModel;
  const answers = {};
  const t0 = performance.now();

  for (const [qId, q] of Object.entries(normalizedPayload.questions)) {
    if (q.type === 'noul') {
      answers[qId] = {
        type: 'noul',
        // A neutral placeholder for schema and plumbing tests only.
        noul: 0.5,
        confidence: null
      };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const probs = {};
      keys.forEach(k => { probs[k] = 1 / keys.length; });
      answers[qId] = {
        type: 'choice',
        choice: null,
        confidence: null,
        probabilities: probs
      };
    } else if (q.type === 'score') {
      const levels = q.criteria;
      const midIdx = Math.floor((levels.length - 1) / 2);
      const legend = {};
      const probs = {};
      levels.forEach((desc, idx) => {
        legend[String(idx)] = typeof desc === 'string' ? desc : JSON.stringify(desc);
        probs[String(idx)] = 1 / levels.length;
      });
      answers[qId] = {
        type: 'score',
        score: parseFloat(midIdx.toFixed(2)),
        confidence: null,
        legend,
        probabilities: probs
      };
    }
  }

  const latencyMs = Math.round(performance.now() - t0);
  const inputTokens = Math.round(JSON.stringify(normalizedPayload).length / 4);
  const outputTokens = 35;

  return {
    model: `${modelName} (deterministic-mock)`,
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    },
    metrics: {
      latencyMs,
      costUsd: 0.000000,
      isMock: true
    }
  };
}

/**
 * 核心执行函数：执行 System One 结构化判定
 * 仅显式 forceMock 时使用测试 Mock；真实评估缺 Key 或 API 失败时明确报错。
 */
export async function evaluateSystemOne({
  state,
  questions,
  model: overrideModel,
  forceMock = false,
  runtimeConfig,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch
} = {}) {
  const { apiKey, endpoint, model: configModel } = runtimeConfig || getConfig();
  const rawPayload = {
    state,
    model: overrideModel || configModel,
    questions
  };

  // 1. 本地 Pre-flight 静态自愈与校验
  const normalized = validateAndNormalizePayload(rawPayload);

  // 2. Mock is only reachable through an explicit test-only request.
  if (forceMock) {
    return mockEvaluate(normalized, overrideModel);
  }
  if (!apiKey) {
    const error = new Error('缺少 TYPESAFE_API_KEY；真实评估已阻断。仅可通过显式 --mock 执行非业务测试。');
    error.code = 'TYPESAFE_API_KEY_MISSING';
    throw error;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('timeoutMs 必须为 1 到 120000 的整数');
  }
  const signal = AbortSignal.timeout(timeoutMs);

  // 3. 向端点发起真实 HTTP POST 请求
  const t0 = performance.now();
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(normalized)
    });
  } catch (cause) {
    const error = new Error(signal.aborted ? 'TypeSafe API 请求超时。' : 'TypeSafe API 网络请求失败。');
    error.code = signal.aborted ? 'TYPESAFE_API_TIMEOUT' : 'TYPESAFE_API_REQUEST_FAILED';
    error.cause = cause;
    throw error;
  }

  if (!res.ok) {
    // Do not echo remote response bodies: they may contain credentials or private payloads.
    const error = new Error('TypeSafe API 请求失败 [HTTP ' + res.status + ']。');
    error.code = 'TYPESAFE_API_HTTP_ERROR';
    throw error;
  }

  let result;
  try {
    result = await res.json();
  } catch (cause) {
    const error = new Error(signal.aborted ? 'TypeSafe API 响应读取超时。' : 'TypeSafe API 返回了无效 JSON。');
    error.code = signal.aborted ? 'TYPESAFE_API_TIMEOUT' : 'TYPESAFE_API_RESPONSE_INVALID';
    error.cause = cause;
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    const error = new Error('TypeSafe API 返回格式无效：响应必须是 JSON 对象。');
    error.code = 'TYPESAFE_API_RESPONSE_INVALID';
    throw error;
  }
  const latencyMs = Math.round(performance.now() - t0);

  // 4. 注入性能耗时与成本计量 (按官方标准定价换算: 入参 $0.15/M tok, 出参 $0.60/M tok)
  const inTok = result.usage?.input_tokens || 0;
  const outTok = result.usage?.output_tokens || 0;
  const costUsd = parseFloat(((inTok / 1e6) * 0.15 + (outTok / 1e6) * 0.60).toFixed(6));

  result.metrics = {
    latencyMs,
    costUsd,
    isMock: false
  };

  return result;
}

// -------------------------------------------------------------
// CLI 命令分发与测试入口
// -------------------------------------------------------------
const args = process.argv.slice(2);

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const isMock = args.includes('--mock');

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const { endpoint, model, apiKey } = getConfig();
    const maskedKey = apiKey ? '(已配置)' : '(未设置/Jev 已禁用)';
    console.log(`
TypeSafe AI (System One) 原生量化执行内核
==========================================
位置: .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs

当前运行配置:
  端点 (Endpoint):  ${endpoint}
  默认模型 (Model): ${model} (严格遵从动态标准别名: jev-latest)
  API Key:          ${maskedKey}

核心能力:
  - Jev 原生决策: 支持 choice, noul, score (v1 criteria 规范)
  - Pre-flight 自愈: 自动纠正 criteria 嵌套错位与旧版 levels 字段
  - 显式 --mock 测试: 中性占位结果，不是业务概率；真实评估缺 Key 时失败
  - 延迟与成本计量: 自动输出 latencyMs 与 Token 费用指标

常用命令:
  1. 连通性与自检 (支持真实端点与 Mock 模式):
     node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs test
     node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs test --mock

  2. 动态 JSON 评估 (必须传入现场真实数据，严禁硬编码 Demo):
     node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --json '{"state": {...}, "questions": {...}}'
     node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --file payload.json
     cat payload.json | node .agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs --stdin
`);
    process.exit(0);
  }

  if (args.includes('test')) {
    const { endpoint, model, apiKey } = getConfig();
    console.log(`[TypeSafe 执行内核自检] 端点: ${endpoint} | 默认模型: ${model}`);
    
    if (isMock) {
      console.log('⚡ 运行模式: 确定性 Mock 引擎 (Deterministic Mock Mode)');
      const res = mockEvaluate({
        state: "Binance Agentic Nexus mock test ping",
        questions: {
          ping_check: {
            type: "noul",
            instructions: "Is this a valid deterministic mock test?"
          }
        }
      });
      console.log('✅ Mock 引擎自检成功，返回结果:');
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    }

    if (!apiKey) {
      console.error('❌ 未配置 TYPESAFE_API_KEY。真实连通性测试未执行；如只测本地解析，请显式添加 --mock。');
      process.exit(1);
    }

    console.log(`🌐 运行模式: 真实端点评估 (使用模型: ${model})...`);
    try {
      const res = await evaluateSystemOne({
        state: "Binance Agentic Nexus live connectivity ping",
        questions: {
          ping_check: {
            type: "noul",
            instructions: "Is this a live connectivity test ping?"
          }
        }
      });
      console.log('✅ 真实端点自检成功，返回结果:');
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 连通性测试异常:', err.message);
      console.log('提示: 您可以添加 --mock 参数运行离线确定性模拟测试');
      process.exit(1);
    }
  } else if (args.includes('--file')) {
    const filePath = getArgValue('--file');
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`❌ 错误: 找不到指定的 JSON 文件: ${filePath}`);
      process.exit(1);
    }
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const payload = JSON.parse(fileContent);
      const res = await evaluateSystemOne({ ...payload, forceMock: isMock });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
  } else if (args.includes('--json')) {
    const jsonStr = getArgValue('--json');
    try {
      const parsed = JSON.parse(jsonStr);
      const res = await evaluateSystemOne({ ...parsed, forceMock: isMock });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
  } else if (args.includes('--stdin')) {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    try {
      const parsed = JSON.parse(input);
      const res = await evaluateSystemOne({ ...parsed, forceMock: isMock });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
  } else {
    // 简易快捷入参模式 (支持旧版命令行参数)
    const state = getArgValue('--state');
    const instructions = getArgValue('--instructions') || getArgValue('--question');
    const noulFlag = args.includes('--noul');
    const choiceCriteria = getArgValue('--choice');

    if (!state || !instructions) {
      console.error('❌ 错误: 请使用 --json 或 --file 传入完整结构化判定，或提供 --state 与 --instructions。使用 --help 查看说明。');
      process.exit(1);
    }

    const questions = {};
    if (noulFlag) {
      questions.judgment = {
        type: 'noul',
        instructions: instructions
      };
    } else if (choiceCriteria) {
      const criteria = {};
      for (const item of choiceCriteria.split(',')) {
        const [k, v] = item.split(':');
        if (k) criteria[k.trim()] = (v || k).trim();
      }
      questions.judgment = {
        type: 'choice',
        instructions: instructions,
        criteria
      };
    } else {
      questions.judgment = {
        type: 'noul',
        instructions: instructions
      };
    }

    try {
      const res = await evaluateSystemOne({ state, questions, forceMock: isMock });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 调用失败:', err.message);
      process.exit(1);
    }
  }
}
