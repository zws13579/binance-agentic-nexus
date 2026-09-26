#!/usr/bin/env node
/**
 * 币安广场统一推流发布脚本 (Agent-Friendly Wrapper)
 *
 * 所有底层能力 100% 复用官方 square-post 技能包 lib.mjs，
 * 本脚本仅提供 --file、--dry-run、中文预览、Markdown 清洗等 Agent 适配层。
 *
 * Network: 使用 Node.js 原生 fetch()。TUN 模式下直接原生运行；
 * 端口代理模式下挂载引导脚本：node --import ./scripts/proxy_bootstrap.mjs scripts/publish_square.mjs ...
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveApiKey, maskApiKey, publish, printPublishSuccess, uploadImage
} from '../.agents/skills/binance-skills-hub/skills/binance/square-post/scripts/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// ---- .env 自动加载 (仅注入 process.env，Key 解析交给 resolveApiKey) ----
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// ---- 参数解析 ----
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const isDryRun  = args.includes('--dry-run');
const textArg   = getArg('--text');
const fileArg   = getArg('--file');
const titleArg  = getArg('--title');
const coverArg  = getArg('--cover');
const imagesArg = getArg('--images');

// ---- Help ----
if (args.includes('--help') || (!textArg && !fileArg)) {
  console.log(`
币安广场统一推流发布脚本 (复用官方 square-post lib.mjs)

用法:
  node scripts/publish_square.mjs --text "<内容>" [选项]
  node scripts/publish_square.mjs --file <文件> [选项]

选项:
  --text <内容>      直接传入正文
  --file <路径>      从文件读取正文
  --title <标题>     长文标题 (contentType: 2)
  --images <路径>    逗号分隔的图片路径 (动态配图, 最多4张, 与 --title 互斥)
  --cover <路径>     文章封面图 (需配合 --title 使用)
  --dry-run          试运行预览，不实际发帖
`);
  process.exit(textArg || fileArg ? 0 : 1);
}

// ---- 输入互斥校验 (对齐官方 post-image.mjs) ----
if (titleArg && imagesArg) {
  console.error('错误: 文章模式 (--title) 使用 --cover 设置封面，不支持 --images');
  process.exit(1);
}

// ---- 读取正文 ----
let content = textArg || '';
if (fileArg) {
  if (!fs.existsSync(fileArg)) {
    console.error(`错误: 文件不存在: ${fileArg}`);
    process.exit(1);
  }
  content = fs.readFileSync(fileArg, 'utf8');
}
content = content.trim();
if (!content) {
  console.error('错误: 正文内容不能为空');
  process.exit(1);
}

// ---- Markdown 零容忍清洗 + Cashtag 校验 (移植自 pipeline.mjs) ----
if (/\*\*|#+\s+|[-*]\s+/.test(content)) {
  console.warn('[警告] 检测到 Markdown 语法，已自动清洗');
}
content = content.replace(/\*\*/g, '').replace(/^#+\s+/gm, '').replace(/^[-*]\s+/gm, '').trim();

const cashtags = [...new Set([...content.matchAll(/\$([A-Za-z0-9]+)/g)].map(m => `$${m[1].toUpperCase()}`))];
if (cashtags.length > 3) {
  console.error(`错误: Cashtags 超过平台限制 (最多3个): ${cashtags.join(', ')}`);
  process.exit(1);
}

// ---- 图片文件预检 ----
const imagePaths = imagesArg ? imagesArg.split(',').map(s => s.trim()).filter(Boolean) : [];
if (imagePaths.length > 4) {
  console.error('错误: 最多支持4张配图');
  process.exit(1);
}
for (const p of [...imagePaths, ...(coverArg ? [coverArg] : [])]) {
  if (!fs.existsSync(p)) {
    console.error(`错误: 图片文件不存在: ${p}`);
    process.exit(1);
  }
}

// ---- 构建 payload ----
const contentType = titleArg ? 2 : 1;
const body = { contentType, bodyTextOnly: content };
if (titleArg) body.title = titleArg;

// ---- 预览 ----
console.log(`\n================ 发帖预览 (${isDryRun ? '试运行 DRY-RUN' : '即将推流'}) ================`);
if (titleArg) console.log(`【标题】${titleArg}\n`);
if (coverArg) console.log(`【封面图】${coverArg}`);
if (imagePaths.length) console.log(`【配图】${imagePaths.join(', ')}`);
console.log(`【Cashtags】${cashtags.length ? cashtags.join(' ') : '(无)'}`);
console.log(`【字数】${content.length}\n`);
console.log(content);
console.log('=====================================================================\n');

if (isDryRun) {
  console.log('[DRY-RUN] 预览正常，未调用接口发帖。');
  process.exit(0);
}

// ---- 发布 ----
const apiKey = resolveApiKey();
console.log(`使用广场 API Key: ${maskApiKey(apiKey)}`);

try {
  if (titleArg) {
    // 文章模式：封面图 → cover 字段
    if (coverArg) {
      console.log('正在上传文章封面图...');
      body.cover = await uploadImage(apiKey, coverArg);
    }
  } else {
    // 动态模式：图片 → imageList 字段
    const targets = imagePaths.length ? imagePaths : (coverArg ? [coverArg] : []);
    if (targets.length > 0) {
      console.log(`正在上传配图 (${targets.length} 张)...`);
      body.imageList = [];
      for (const img of targets) {
        body.imageList.push(await uploadImage(apiKey, img));
      }
    }
  }

  console.log(`正在推流至币安广场 (${contentType === 2 ? '文章' : '短动态'})...`);
  const result = await publish(apiKey, body);
  printPublishSuccess(result);
} catch (err) {
  console.error(`\n发布失败: ${err.message}`);
  process.exit(1);
}
