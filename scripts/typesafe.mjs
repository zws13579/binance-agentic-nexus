#!/usr/bin/env node
/**
 * TypeSafe AI (System One) 原生执行引擎与通用客户端
 * 纯原生 Node.js 实现，零外部依赖，完全由 .env 驱动
 * 支持传入任意动态构建的 state 与 questions 结构化判定请求
 *
 * Network: 使用 Node.js 原生 fetch()。TUN 模式下直接原生运行；
 * 端口代理模式下挂载引导脚本：node --import ./scripts/proxy_bootstrap.mjs scripts/typesafe.mjs ...
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

// 解析 .env 配置
function loadEnv() {
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match) {
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[match[1]] = val;
      }
    }
  }
  return env;
}

const env = loadEnv();

// 获取端点、Key 与模型配置
export function getConfig() {
  const apiKey = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || '';
  
  let endpoint = process.env.TYPESAFE_ENDPOINT || env.TYPESAFE_ENDPOINT;
  if (!endpoint) {
    const baseUrl = process.env.TYPESAFE_BASE_URL || env.TYPESAFE_BASE_URL;
    if (baseUrl) {
      endpoint = baseUrl.replace(/\/+$/, '') + '/systemone';
    } else {
      endpoint = 'https://api.typesafe.ai/v1/systemone';
    }
  }

  const model = process.env.TYPESAFE_MODEL || env.TYPESAFE_MODEL || 'jev-latest';

  return { apiKey, endpoint, model };
}

/**
 * 核心执行函数：向端点发送动态构建的 System One 结构化判定请求
 * @param {Object} params
 * @param {string|Object|Array} params.state Agent 针对具体情境提炼的现场事实与上下文
 * @param {Object} params.questions Agent 动态设计的判定问题 (支持 noul / choice / score)
 * @param {string} [params.model] 模型名称 (可选)
 */
export async function evaluateSystemOne({ state, questions, model: overrideModel } = {}) {
  const { apiKey, endpoint, model: configModel } = getConfig();

  if (!apiKey) {
    throw new Error('未检测到 TYPESAFE_API_KEY，请在 .env 文件中配置 TYPESAFE_API_KEY=xxx');
  }

  if (!state) {
    throw new Error('缺少评估状态 (state)，请提供待评估的上下文数据');
  }

  if (!questions || Object.keys(questions).length === 0) {
    throw new Error('缺少判定问题 (questions)，请根据业务场景定义具体的判定项');
  }

  const payload = {
    state,
    model: overrideModel || configModel,
    questions
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`TypeSafe API 请求失败 [${res.status} ${res.statusText}]: ${errorText}`);
  }

  return await res.json();
}

// -------------------------------------------------------------
// CLI 调度逻辑：支持参数传递、文件输入及管道输入
// -------------------------------------------------------------
const args = process.argv.slice(2);

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('typesafe.mjs')) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const { endpoint, model, apiKey } = getConfig();
    const maskedKey = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '(未设置)';
    console.log(`
TypeSafe AI (System One) 原生执行引擎
====================================
当前环境状态:
  端点 (Endpoint):  ${endpoint}
  默认模型 (Model): ${model}
  API Key:          ${maskedKey}

核心定位:
  本脚本是通用的执行引擎，不设死任何业务模板。
  AI Agent 应根据当前实时行情、订单簿深度、推文或聪明钱交易现场，
  自主思考并动态构建具体的 state 与 questions，然后调用本引擎获取客观判定。

支持的输入方式:
  1. 动态 JSON 字符串:
     node scripts/typesafe.mjs --json '{"state": {...}, "questions": {...}}'

  2. 动态 JSON 临时文件 (推荐复杂多维度场景，避免终端引号转义):
     node scripts/typesafe.mjs --file /path/to/dynamic_payload.json

  3. 标准输入 (stdin):
     cat payload.json | node scripts/typesafe.mjs --stdin

  4. 连通性测试 (自检):
     node scripts/typesafe.mjs test
`);
    process.exit(0);
  }

  if (args.includes('test')) {
    const { endpoint, model, apiKey } = getConfig();
    console.log(`正在向端点 ${endpoint} (模型: ${model}) 发起连通性自检...`);
    if (!apiKey) {
      console.error('❌ 错误: .env 中未配置 TYPESAFE_API_KEY');
      process.exit(1);
    }
    try {
      const res = await evaluateSystemOne({
        state: 'Binance Agentic Nexus test ping',
        questions: {
          ping_check: {
            type: 'noul',
            instructions: 'Is this a test message?'
          }
        }
      });
      console.log('✅ 端点响应成功！返回结果:');
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 连通性自检失败:', err.message);
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
      const res = await evaluateSystemOne(payload);
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
  } else if (args.includes('--json')) {
    const jsonStr = getArgValue('--json');
    try {
      const parsed = JSON.parse(jsonStr);
      const res = await evaluateSystemOne(parsed);
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
      const res = await evaluateSystemOne(parsed);
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
  } else {
    // 兼容简单的命令行动态调用 (必须提供明确的 state 与 instructions)
    const state = getArgValue('--state');
    const instructions = getArgValue('--instructions') || getArgValue('--question');
    const noulFlag = args.includes('--noul');
    const choiceCriteria = getArgValue('--choice');

    if (!state || !instructions) {
      console.error('❌ 错误: 请使用 --json 或 --file 传入完整结构化判定，或至少提供 --state 与 --instructions。使用 --help 查看说明。');
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
    }

    try {
      const res = await evaluateSystemOne({ state, questions });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('❌ 调用失败:', err.message);
      process.exit(1);
    }
  }
}
