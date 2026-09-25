#!/usr/bin/env node
/**
 * 币安广场通用推流发布脚本
 * 支持通过命令行参数 --text、--file 或 --title 发布动态或长文
 * 严禁在脚本内硬编码任何文章内容
 *
 * Network: 使用 Node.js 原生 fetch()。TUN 模式下直接原生运行；
 * 端口代理模式下挂载引导脚本：node --import ./scripts/proxy_bootstrap.mjs scripts/publish_square.mjs ...
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

let apiKey = '';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const squareMatch = line.match(/^\s*BINANCE_SQUARE_OPENAPI_KEY\s*=\s*(.+)$/);
    if (squareMatch) {
      apiKey = squareMatch[1].trim();
      break;
    }
    const apiMatch = line.match(/^\s*BINANCE_API_KEY\s*=\s*(.+)$/);
    if (apiMatch && !apiKey) {
      apiKey = apiMatch[1].trim();
    }
  }
}

const args = process.argv.slice(2);

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const isDryRun = args.includes('--dry-run');
const textArg = getArgValue('--text');
const fileArg = getArgValue('--file');
const titleArg = getArgValue('--title');

if (args.includes('--help') || (!textArg && !fileArg)) {
  console.log(`
使用方式:
  node scripts/publish_square.mjs --text "<正文内容>" [--title "<文章标题>"] [--dry-run]
  node scripts/publish_square.mjs --file "<文本文件路径>" [--title "<文章标题>"] [--dry-run]

选项:
  --text <内容>     直接传入纯文本正文
  --file <路径>     从指定文件中读取正文（推荐长文或含特殊换行时使用）
  --title <标题>    长文标题。提供此项时将发布为文章 (contentType: 2)，否则为短动态 (contentType: 1)
  --dry-run         试运行预览，不实际调用 OpenAPI 发帖
`);
  process.exit(textArg || fileArg ? 0 : 1);
}

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

const contentType = titleArg ? 2 : 1;
const body = {
  contentType,
  bodyTextOnly: content,
};
if (titleArg) {
  body.title = titleArg;
}

console.log(`\n================ 发帖预览 (${isDryRun ? '试运行 DRY-RUN' : '即将推流'}) ================`);
if (titleArg) {
  console.log(`【标题】${titleArg}\n`);
}
console.log(content);
console.log('=====================================================================\n');

if (isDryRun) {
  console.log('[DRY-RUN] 预览正常，未调用接口发帖。');
  process.exit(0);
}

if (!apiKey) {
  console.error('错误: 未在 .env 中找到有效的 BINANCE_SQUARE_OPENAPI_KEY');
  process.exit(1);
}

const maskedKey = apiKey.length <= 9 ? apiKey.slice(0, 2) + '...' : `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
console.log(`使用广场 API Key: ${maskedKey}`);

const skillLibPath = path.join(__dirname, '..', '.agents', 'skills', 'binance-skills-hub', 'skills', 'binance', 'square-post', 'scripts', 'lib.mjs');
const { publish, printPublishSuccess } = await import(`file://${skillLibPath.replace(/\\/g, '/')}`);

try {
  console.log(`正在推流至币安广场 (类型: ${contentType === 2 ? '文章' : '短动态'})...`);
  const result = await publish(apiKey, body);
  printPublishSuccess(result);
} catch (err) {
  console.error(`\n发布失败: ${err.message}`);
  process.exit(1);
}
