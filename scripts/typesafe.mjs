#!/usr/bin/env node
/**
 * TypeSafe AI (System One) 原生客户端与 CLI
 * 纯原生 Node.js 实现，零外部依赖，完全由 .env 驱动
 * 支持第三方 API 中转站或反向代理自定义端点
 */
import './proxy_bootstrap.mjs';
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

// 获取端点、Key 与模型配置（优先读取环境变量，其次读取 .env，最后使用官方默认值）
export function getConfig() {
  const apiKey = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || '';
  
  // 自定义端点支持：
  // 1. 若配置 TYPESAFE_ENDPOINT，直接使用完整端点
  // 2. 若配置 TYPESAFE_BASE_URL，自动补充 /systemone
  // 3. 默认官方端点 https://api.typesafe.ai/v1/systemone
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
 * 核心调用函数：向 TypeSafe 或第三方端点发送 System One 评估请求
 * @param {Object} params
 * @param {string|Object|Array} params.state 待评估的状态/文本/数据
 * @param {Object} params.questions 评估问题定义 (noul / choice / score)
 * @param {string} [params.model] 模型名称 (可选，默认读取配置)
 */
export async function evaluateSystemOne({ state, questions, model: overrideModel } = {}) {
  const { apiKey, endpoint, model: configModel } = getConfig();

  if (!apiKey) {
    throw new Error('未检测到 TYPESAFE_API_KEY，请在 .env 文件中配置 TYPESAFE_API_KEY=xxx');
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
// CLI 交互逻辑
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
TypeSafe AI (System One) 原生客户端 CLI
======================================
当前配置状态:
  端点 (Endpoint):  ${endpoint}
  模型 (Model):     ${model}
  API Key:          ${maskedKey}

用法:
  1. 连通性测试 (自检):
     node scripts/typesafe.mjs test

  2. 极简是非题 (Noul):
     node scripts/typesafe.mjs --state "比特币放量突破70000美元大关" --noul "Is this a bullish breakout?"

  3. 多选分类题 (Choice):
     node scripts/typesafe.mjs --state "账户已被强平" --choice "low:正常,medium:预警,critical:爆仓"

  4. 完整 JSON 模式:
     node scripts/typesafe.mjs --json '{"state": "...", "questions": {...}}'
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
  } else if (args.includes('--json')) {
    const jsonStr = getArgValue('--json');
    try {
      const parsed = JSON.parse(jsonStr);
      const res = await evaluateSystemOne(parsed);
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('执行失败:', err.message);
      process.exit(1);
    }
  } else {
    const state = getArgValue('--state') || 'Empty state';
    const noulQuestion = getArgValue('--noul');
    const choiceQuestion = getArgValue('--choice');

    const questions = {};
    if (noulQuestion) {
      questions.judgment = {
        type: 'noul',
        instructions: noulQuestion
      };
    } else if (choiceQuestion) {
      // 格式: key1:desc1,key2:desc2
      const criteria = {};
      for (const item of choiceQuestion.split(',')) {
        const [k, v] = item.split(':');
        if (k) criteria[k.trim()] = (v || k).trim();
      }
      questions.classification = {
        type: 'choice',
        instructions: 'Classify the given state into one category',
        criteria
      };
    }

    if (Object.keys(questions).length === 0) {
      console.error('请提供 --noul 或 --choice 判定参数，或使用 --help 查看帮助。');
      process.exit(1);
    }

    try {
      const res = await evaluateSystemOne({ state, questions });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('调用失败:', err.message);
      process.exit(1);
    }
  }
}
