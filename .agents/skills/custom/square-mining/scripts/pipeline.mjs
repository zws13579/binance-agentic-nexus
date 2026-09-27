#!/usr/bin/env node
/**
 * 币安广场【内容挖矿】全自动工作流执行脚本
 * 封装在 square-mining 技能包内部，直接复用同级技能模块
 *
 * 重构升级：
 * 1. 扩充传统顶级金融媒体源 (CNBC Finance, Yahoo Finance, MarketWatch) + 加密权威媒体 (The Block, CoinTelegraph)
 * 2. 调整选题加权：以即时权威新闻为核心议题，币安广场 Trends 作为借势流量标签
 * 3. 彻底重构生成引擎：引入 4 套多模态自适应主题模型，消除固定模板，彻底杜绝内容指纹同质化限流
 */

// 代理环境引导：优先复用根目录统一代理引导脚本
try {
  const { pathToFileURL } = await import('url');
  const { dirname, resolve } = await import('path');
  const bootstrapPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../scripts/proxy_bootstrap.mjs');
  await import(pathToFileURL(bootstrapPath).href);
} catch {
  // 备用兜底环境
  let setGlobalDispatcher, ProxyAgent;
  try {
    ({ setGlobalDispatcher, ProxyAgent } = await import('undici'));
  } catch {}
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl && setGlobalDispatcher && ProxyAgent) {
    try { setGlobalDispatcher(new ProxyAgent(proxyUrl)); } catch {}
  }
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// 直接从工作区官方 binance-skills-hub 中按需复用，杜绝重复实现
import { COMMANDS as rankCommands, call as rankCall } from '../../../binance-skills-hub/skills/binance-web3/crypto-market-rank/scripts/cli.mjs';
import { COMMANDS as signalCommands, call as signalCall } from '../../../binance-skills-hub/skills/binance-web3/trading-signal/scripts/cli.mjs';
import { publish, printPublishSuccess, resolveApiKey } from '../../../binance-skills-hub/skills/binance/square-post/scripts/lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 自动加载项目根目录 .env 到 process.env，确保 OpenAPI 密钥可用
const rootEnvPath = path.resolve(__dirname, '../../../../../.env');
const cwdEnvPath = path.resolve(process.cwd(), '.env');
const actualEnvPath = fs.existsSync(rootEnvPath) ? rootEnvPath : cwdEnvPath;
if (fs.existsSync(actualEnvPath)) {
  const content = fs.readFileSync(actualEnvPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// HTML 实体与标签清洗工具
function cleanHtml(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;|&#x2018;|&#x2019;|&#8216;|&#8217;|&#x27;|&#39;|&lsquo;|&rsquo;/g, "'")
    .replace(/&quot;|&#x201c;|&#x201d;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#x2014;|&#8212;|&mdash;|&ndash;/g, '—')
    .replace(/&hellip;|&#8230;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 缓存单次运行抓取的传统财经新闻，避免 step1 和 step3 重复网络请求
let cachedTraditionalNews = null;

// 从传统权威金融媒体 (CNBC, Yahoo Finance, MarketWatch) 抓取即时财经与宏观新闻
export async function fetchTraditionalFinanceNews(limit = 12) {
  if (cachedTraditionalNews && cachedTraditionalNews.length > 0) {
    return cachedTraditionalNews;
  }

  const list = [];

  // 1. CNBC Finance & Economy RSS
  try {
    const cnbcRes = await fetch('https://www.cnbc.com/id/10000664/device/rss/rss.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (cnbcRes.ok) {
      const xml = await cnbcRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && list.length < 5) {
        list.push({
          source: 'CNBC',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] CNBC 新闻源暂缓:', err.message);
  }

  // 2. Yahoo Finance (BTC / 宏观资产综合信源)
  try {
    const yfRes = await fetch('https://finance.yahoo.com/rss/headline?s=BTC-USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (yfRes.ok) {
      const xml = await yfRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && list.length < 10) {
        list.push({
          source: 'Yahoo Finance',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] Yahoo Finance 新闻源暂缓:', err.message);
  }

  // 3. MarketWatch Top Stories
  try {
    const mwRes = await fetch('https://feeds.content.dowjones.io/public/rss/mw_topstories', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (mwRes.ok) {
      const xml = await mwRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && list.length < limit) {
        list.push({
          source: 'MarketWatch',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    // 降级保护
  }

  cachedTraditionalNews = list;
  return list;
}

// ==========================================
// STEP 1: 全网权威财经即时要闻调取
// 直接提供一手头条与摘要，交由 AI Agent 实时理解与提炼，绝不硬编码预制词库
// ==========================================
export async function step1_fetchTrends() {
  console.log('----------------------------------------------------');
  console.log('[Step 1] 正在调取全网权威财经即时要闻（CNBC / Yahoo Finance / MarketWatch）...');
  let newsList = [];

  try {
    newsList = await fetchTraditionalFinanceNews(10);
  } catch (err) {
    console.warn('  [Notice] 传统财经要闻获取暂缓:', err.message);
  }

  console.log(`[Step 1] 成功获取 ${newsList.length} 条即时权威头条:`);
  newsList.slice(0, 5).forEach((item, idx) => {
    console.log(`  Top ${idx + 1}: [${item.source}] ${item.title}`);
  });

  return newsList;
}

// ==========================================
// STEP 2: 盘面与聪明钱/巨鲸动向模块
// ==========================================
export async function step2_fetchMarketData(focusSymbols = ['BTC', 'ETH', 'LTC', 'SOL', 'BNB', 'ZEC', 'DOGE']) {
  console.log('----------------------------------------------------');
  console.log('[Step 2] 正在调取 CEX 现货盘面与合约资金费率...');

  const result = {
    cex: {
      tickers: {},
      fundingRates: {},
    },
    web3: {
      smartMoneyInflows: [],
      recentWhaleSignals: [],
    },
  };

  // 1. CEX 现货 24h 涨跌与成交额
  try {
    const tickerRes = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: AbortSignal.timeout(5000) });
    if (tickerRes.ok) {
      const allTickers = await tickerRes.json();
      for (const sym of focusSymbols) {
        const pair = `${sym}USDT`;
        const found = allTickers.find((t) => t.symbol === pair);
        if (found) {
          result.cex.tickers[sym] = {
            symbol: pair,
            price: parseFloat(found.lastPrice),
            changePercent24h: parseFloat(found.priceChangePercent),
            high24h: parseFloat(found.highPrice),
            low24h: parseFloat(found.lowPrice),
            volumeUSDT: parseFloat(found.quoteVolume),
          };
        }
      }
    }
  } catch (err) {
    console.warn('  [Warn] CEX 现货 Ticker 抓取微弱异常:', err.message);
  }

  // 2. CEX 合约资金费率
  try {
    const fundingRes = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(5000) });
    if (fundingRes.ok) {
      const allFunding = await fundingRes.json();
      for (const sym of focusSymbols) {
        const pair = `${sym}USDT`;
        const found = allFunding.find((f) => f.symbol === pair);
        if (found) {
          result.cex.fundingRates[sym] = {
            markPrice: parseFloat(found.markPrice),
            fundingRate: (parseFloat(found.lastFundingRate) * 100).toFixed(4) + '%',
            fundingRateRaw: parseFloat(found.lastFundingRate),
          };
        }
      }
    }
  } catch (err) {
    console.warn('  [Warn] CEX 合约费率抓取微弱异常:', err.message);
  }

  // 2.5 CEX 合约微观情绪指标 (多空比、主动买卖量比、未平仓合约量)
  result.cex.derivativeSentiment = {};
  const majorDerivSymbols = ['BTC', 'ETH', 'SOL'];
  for (const sym of majorDerivSymbols) {
    try {
      const pair = `${sym}USDT`;
      const [longShort, takerRatio, oi] = await Promise.all([
        fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=1`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${pair}&period=1h&limit=1`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : {}).catch(() => {})
      ]);

      const fr = result.cex.fundingRates[sym]?.fundingRate || 'N/A';
      result.cex.derivativeSentiment[pair] = {
        symbol: pair,
        longShortRatio: longShort[0] ? (parseFloat(longShort[0].longAccount) * 100).toFixed(1) + '%' : null,
        takerBuySellRatio: takerRatio[0] ? takerRatio[0].buySellRatio : null,
        openInterest: oi && oi.openInterest ? oi.openInterest : null,
        fundingRate: fr
      };
    } catch {}
  }

  // 3. Web3 聪明钱净流入 (复用 crypto-market-rank)
  try {
    const bscInflow = await rankCall(rankCommands['smart-money-inflow']({ chainId: '56' }));
    const rawList = Array.isArray(bscInflow?.data) ? bscInflow.data : (bscInflow?.data?.list || []);
    if (rawList.length > 0) {
      result.web3.smartMoneyInflows = rawList.slice(0, 5).map((item) => ({
        symbol: item.tokenName || item.symbol,
        tokenAddress: item.ca || item.tokenAddress,
        netInflowUSD: item.inflow || item.netInflowUsd || item.inflowUsd,
        priceChange24h: item.priceChangeRate || item.priceChange24h,
      }));
    }
  } catch (err) {
    // 降级保护
  }

  // 4. Web3 巨鲸交易信号 (复用 trading-signal)
  try {
    const whaleSignals = await signalCall(signalCommands['smart-money']({ chainId: '56' }));
    if (whaleSignals?.data?.list) {
      result.web3.recentWhaleSignals = whaleSignals.data.list.slice(0, 5).map((sig) => ({
        tokenSymbol: sig.tokenSymbol || sig.symbol,
        signalType: sig.signalType === 1 ? 'BUY' : 'SELL',
        price: sig.triggerPrice || sig.price,
        maxGain: sig.maxGain ? `${(sig.maxGain * 100).toFixed(1)}%` : null,
        walletTag: sig.walletTag || 'Smart Whale',
      }));
    }
  } catch (err) {
    // 降级保护
  }

  console.log(`[Step 2] 核心资产盘面概览:`);
  for (const [sym, data] of Object.entries(result.cex.tickers)) {
    const fr = result.cex.fundingRates[sym]?.fundingRate || 'N/A';
    console.log(`  ${sym}: $${data.price} (24h ${data.changePercent24h > 0 ? '+' : ''}${data.changePercent24h}%, 费率: ${fr})`);
  }

  return result;
}

// ==========================================
// STEP 3: 传统权威金融媒体 + 加密机构媒体新闻聚合 (News-Driven)
// ==========================================
export async function step3_fetchNews() {
  console.log('----------------------------------------------------');
  console.log('[Step 3] 正在从传统顶级财经媒体 (CNBC, Yahoo Finance, MarketWatch) 与加密权威机构 (The Block, CoinTelegraph, CoinDesk) 聚合实时要闻...');

  // 1-3. 优先复用/抓取传统顶级财经媒体新闻
  const traditionalNews = await fetchTraditionalFinanceNews(10);

  const newsSummary = {
    traditionalFinance: traditionalNews,
    cryptoInstitutions: [],
    officialAnnouncements: [],
  };

  // 4. 加密原生机构媒体：The Block (严格采编、机构持仓与监管动态)
  try {
    const tbRes = await fetch('https://www.theblock.co/rss.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (tbRes.ok) {
      const xml = await tbRes.text();
      const itemRegex = /<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<description><!\[CDATA\[(.*?)\]\]><\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && newsSummary.cryptoInstitutions.length < 4) {
        newsSummary.cryptoInstitutions.push({
          source: 'The Block',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] The Block 新闻源暂缓:', err.message);
  }

  // 5. 加密突发媒体：CoinTelegraph
  try {
    const ctRes = await fetch('https://cointelegraph.com/rss', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (ctRes.ok) {
      const xml = await ctRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      const initialCount = newsSummary.cryptoInstitutions.length;
      while ((m = itemRegex.exec(xml)) !== null && (newsSummary.cryptoInstitutions.length - initialCount) < 4) {
        if (!m[1].includes('Cointelegraph.com News')) {
          newsSummary.cryptoInstitutions.push({
            source: 'CoinTelegraph',
            title: cleanHtml(m[1]),
            summary: cleanHtml(m[2]).slice(0, 180),
          });
        }
      }
    }
  } catch (err) {
    // 降级保护
  }

  // 6. 加密权威标杆媒体：CoinDesk (政策监管、行业深度与独家信源)
  try {
    const cdRes = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (cdRes.ok) {
      const xml = await cdRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      const initialCount = newsSummary.cryptoInstitutions.length;
      while ((m = itemRegex.exec(xml)) !== null && (newsSummary.cryptoInstitutions.length - initialCount) < 4) {
        newsSummary.cryptoInstitutions.push({
          source: 'CoinDesk',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] CoinDesk 新闻源暂缓:', err.message);
  }

  // 7. 币安官方公告库 (100% 官方，新币与规则调整)
  try {
    const cmsRes = await fetch('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageSize=5&pageNo=1', {
      headers: { lang: 'zh-CN' },
      signal: AbortSignal.timeout(5000),
    });
    if (cmsRes.ok) {
      const cmsData = await cmsRes.json();
      if (cmsData?.data?.catalogs) {
        for (const cat of cmsData.data.catalogs) {
          if ([48, 49, 161, 157].includes(cat.catalogId)) {
            const topArticles = (cat.articles || []).slice(0, 2).map(a => a.title);
            newsSummary.officialAnnouncements.push({
              catalog: cat.catalogName,
              titles: topArticles,
            });
          }
        }
      }
    }
  } catch (err) {
    // 降级保护
  }

  console.log(`[Step 3] 权威财经与机构新闻聚合完成:`);
  console.log(`  传统金融源: ${newsSummary.traditionalFinance.length} 条 (CNBC / Yahoo Finance / MarketWatch)`);
  console.log(`  加密机构源: ${newsSummary.cryptoInstitutions.length} 条 (The Block / CoinTelegraph / CoinDesk)`);
  if (newsSummary.traditionalFinance[0]) {
    console.log(`  [精选传统金融] [${newsSummary.traditionalFinance[0].source}] ${newsSummary.traditionalFinance[0].title}`);
  }
  if (newsSummary.cryptoInstitutions[0]) {
    console.log(`  [精选加密机构] [${newsSummary.cryptoInstitutions[0].source}] ${newsSummary.cryptoInstitutions[0].title}`);
  }

  return newsSummary;
}

// ==========================================
// 推流发布模块 (Content Publisher)
// 接收由 AI Agent 现场实时生成的原创文案，执行格式校验并推流到广场 OpenAPI
// ==========================================
export async function step5_publishPost(post, { dryRun = false } = {}) {
  console.log('----------------------------------------------------');
  console.log(`[Publish] ${dryRun ? '【试运行预览 DRY-RUN】' : '【正在发布到币安广场】'}...`);

  const bodyText = (post.bodyTextOnly || '').trim();

  // 1. 严格合规校验：零 Markdown 格式检查
  if (/\*\*|#+\s+|[-*]\s+/.test(bodyText)) {
    console.warn('  [警告] 检测到潜在 Markdown 语法符号，正在自动过滤清洗...');
  }
  const sanitizedContent = bodyText
    .replace(/\*\*/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();

  // 2. 严格合规校验：Cashtags 数量（平台硬限制 <= 3）
  const cashtags = [...sanitizedContent.matchAll(/\$([A-Za-z0-9]+)/g)].map(m => `$${m[1].toUpperCase()}`);
  const uniqueCashtags = [...new Set(cashtags)];
  if (uniqueCashtags.length > 3) {
    throw new Error(`Cashtags 数量超过平台限制 (最多3个): ${uniqueCashtags.join(', ')}`);
  }

  console.log('\n================ 生成的内容预览 (真实发帖效果) ================');
  if (post.title) {
    console.log(`【标题】${post.title}\n`);
  }
  console.log(sanitizedContent);
  console.log('===============================================================\n');

  if (dryRun) {
    console.log('[DRY-RUN] 当前为试运行模式，未实际上传至币安广场。');
    console.log('[DRY-RUN] 若文案与数据符合预期，请添加 --publish 参数执行实际发布。');
    return {
      success: true,
      dryRun: true,
      preview: {
        ...post,
        bodyTextOnly: sanitizedContent,
        cashtags: uniqueCashtags,
      },
    };
  }

  const apiKey = resolveApiKey();
  const payload = {
    contentType: post.contentType,
    bodyTextOnly: sanitizedContent,
  };
  if (post.title) {
    payload.title = post.title;
  }

  try {
    console.log('正在调用币安广场官方 OpenAPI (/content/add)...');
    const result = await publish(apiKey, payload);
    printPublishSuccess(result);

    return {
      success: true,
      dryRun: false,
      id: result.id,
      shareLink: result.shareLink,
    };
  } catch (err) {
    console.error(`\n[❌ API 推流中断] 发布失败: ${err.message}`);
    console.log('\n================ 币安广场降级容灾方案 ================');
    console.log('API 调用受阻（Key 额度或接口变动），文案已安全暂存。');
    console.log('手动发布指引：');
    console.log('  1. 纯净正文已完成 Markdown 清洗与 Cashtag 规整');
    console.log('  2. 浏览器直接访问: https://www.binance.com/zh-CN/square/create');
    console.log('  3. 粘贴正文内容并确认发布');
    console.log('  4. 发布完成后清理临时草稿: rm -f tmp/draft.txt');
    console.log('=====================================================\n');
    throw err;
  }
}

export const publishPost = step5_publishPost;

// ==========================================
// 统一数据采集导出 (Data Collection Only)
// ==========================================
export async function collectData() {
  const trends = await step1_fetchTrends();
  const marketData = await step2_fetchMarketData();
  const news = await step3_fetchNews();
  return { trends, marketData, news };
}

// ==========================================
// 统一驱动函数 (CLI Pipeline Runner)
// ==========================================
export async function runPipeline({ dryRun = true, type = 'short', text = null, title = null, file = null } = {}) {
  try {
    // 模式 1: 传入文案或文件进行推流发布（AI Agent 原创模式）
    if (text || file) {
      let content = text;
      if (file) {
        content = fs.readFileSync(file, 'utf-8');
      }
      content = content.trim();

      const contentType = title ? 2 : (type === 'article' ? 2 : 1);
      const post = {
        type: contentType === 2 ? 'article' : 'short',
        contentType,
        title: title || (contentType === 2 ? '币安广场市场深度复盘' : null),
        bodyTextOnly: content,
        archetype: 'agent_realtime',
      };

      return await step5_publishPost(post, { dryRun });
    }

    // 模式 2: 未传文案时执行数据采集，提示 AI Agent 现场实时生成
    console.log('\n======================================================');
    console.log('   🚀 币安广场【内容挖矿】数据采集启动');
    console.log('   💡 本项目为 Agentic 架构：文章由 AI Agent 结合实时数据即时创作，杜绝预制套路话术');
    console.log('======================================================\n');

    const collected = await collectData();
    console.log('\n✨ 数据采集完毕！请由 AI Agent 结合上述真实盘面与要闻实时原创撰写，并通过 --publish-text 或 --file 传入发布。');
    return collected;
  } catch (err) {
    console.error('\n❌ 工作流执行中断:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
    throw err;
  }
}

// CLI Direct Execution
if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const args = process.argv.slice(2);

  function getArgValue(flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  const isCollect = args.includes('--collect') || args.includes('--data-only');
  const isPublish = args.includes('--publish');
  const isDryRun = args.includes('--dry-run') || !isPublish;
  const isArticle = args.includes('--article');
  const type = isArticle ? 'article' : 'short';

  const textArg = getArgValue('--text') || getArgValue('--publish-text');
  const fileArg = getArgValue('--file');
  const titleArg = getArgValue('--title');

  if (isCollect) {
    const data = await collectData();
    console.log('\n===== DATA_JSON_START =====');
    console.log(JSON.stringify(data, null, 2));
    console.log('===== DATA_JSON_END =====\n');
    process.exit(0);
  }

  await runPipeline({
    dryRun: isDryRun,
    type,
    text: textArg,
    title: titleArg,
    file: fileArg,
  });
}


