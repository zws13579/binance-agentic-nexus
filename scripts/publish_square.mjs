import './proxy_bootstrap.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

let apiKey = '';
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

if (!apiKey) {
  console.error('No API key found in .env');
  process.exit(1);
}

const maskedKey = apiKey.length <= 9 ? apiKey.slice(0, 2) + '...' : `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
console.log(`Using Square API key: ${maskedKey}`);

const skillLibPath = path.join(__dirname, '..', '.agents', 'skills', 'binance-skills-hub', 'skills', 'binance', 'square-post', 'scripts', 'lib.mjs');
const { publish, printPublishSuccess } = await import(`file://${skillLibPath.replace(/\\/g, '/')}`);

const title = "Wintermute巨资异动！大盘多空双杀后，这几个关键位必须盯紧";
// Limit Cashtags to 3 distinct tokens ($BTC, $ETH, $ZEC), avoiding excessive $ symbols
const text = `美国核心 CPI 创下 66 个月新低，但加密市场却迎来了极致的洗盘行情！结合链上做市商与聪明钱动向，当下有几个核心信号需要重点关注：

1. 做市巨鲸动向：Wintermute 向币安存入 6.1 万枚 $ETH
链上数据显示，顶级做市商 Wintermute 刚刚向 Binance 和 Coinbase 转移了 61,847 枚 ETH（价值约 1.6 亿美元）。以太坊在冲高 2,666 美元后目前回踩测试 2,480 美元支撑。做市商的大额现货归集往往预示着做市流动性补充或期权对冲，关注 2,420 - 2,450 美元区间的买盘承接。

2. $BTC 震荡剧烈，警惕多空双杀
过去 24 小时内，BTC 在 76,000 美元至 79,800 美元之间剧烈插针，清算了数百万美元杠杆。目前在 76,700 美元附近拉锯。上方关键阻力在 78,500 美元，若能有效放量突破才有望重返 8 万大关；下方防守位看 76,000 美元。同时，BNB 保持强劲韧性，稳守 716 美元上方。

3. 链上黑马：巨鲸一周狂买 4,100 万美元 $ZEC
除主流资产外，链上聪明钱监控显示，有神秘巨鲸在过去一周持续吸筹 4,160 万美元的 ZEC，知名交易员亦同步开设 570 万美元多单。结合灰度关于其挖矿高收益的研报，资金建仓逻辑明确，可作为异动标的持续追踪。

当前行情属于典型的“流动性猎杀期”，切忌盲目上高杠杆追涨杀跌，建议做好严格仓位管理与止损保护。

免责声明：本文仅代表个人观点与盘面数据复盘，不构成任何投资建议。加密资产波动较大，请谨慎评估个人风险承受能力。`;

try {
  console.log("Publishing article to Binance Square...");
  const body = {
    contentType: 2,
    title,
    bodyTextOnly: text,
  };
  const result = await publish(apiKey, body);
  printPublishSuccess(result);
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
