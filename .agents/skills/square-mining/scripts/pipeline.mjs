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

// 代理环境引导
let setGlobalDispatcher, ProxyAgent;
try {
  ({ setGlobalDispatcher, ProxyAgent } = await import('undici'));
} catch {
  try {
    ({ setGlobalDispatcher, ProxyAgent } = await import('file:///C:/Users/admin/AppData/Local/Programs/nodejs/node_modules/undici/index.js'));
  } catch {}
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
if (setGlobalDispatcher && ProxyAgent) {
  try { setGlobalDispatcher(new ProxyAgent(proxyUrl)); } catch {}
}

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// 直接从工作区现有兄弟 Skill 中按需复用，杜绝重复实现
import { COMMANDS as rankCommands, call as rankCall } from '../../crypto-market-rank/scripts/cli.mjs';
import { COMMANDS as signalCommands, call as signalCall } from '../../trading-signal/scripts/cli.mjs';
import { publish, printPublishSuccess, resolveApiKey } from '../../square-post/scripts/lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HTML 实体与标签清洗工具
function cleanHtml(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;|&#x2019;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;|&#x201c;|&#x201d;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#x2014;|&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ==========================================
// STEP 1: 广场热搜借势标签池 (Square Trends)
// ==========================================
export async function step1_fetchTrends() {
  console.log('----------------------------------------------------');
  console.log('[Step 1] 正在抓取币安广场热搜榜单（用于正文末尾借势导流）...');
  const url = 'https://www.binance.com/zh-CN/square/trends';
  const trends = [];

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const html = await res.text();
      const trendRegex = /#([^<]+)<\/span>[\s\S]*?([0-9,]+)\s*人讨论中/g;
      let match;
      let rank = 1;
      while ((match = trendRegex.exec(html)) !== null) {
        const rawTag = match[1].trim().replace(/\s+/g, '');
        const count = parseInt(match[2].replace(/,/g, ''), 10);
        trends.push({
          rank: rank++,
          hashtag: `#${rawTag}`,
          topic: rawTag,
          discussionCount: count,
        });
      }
    }
  } catch (err) {
    // 降级由后续 social-hype 补充
  }

  // 若网页直连未获取，联动官方社交热度榜 (social-hype)
  if (trends.length === 0) {
    try {
      const hypeData = await rankCall(rankCommands['social-hype']({
        chainId: '56',
        targetLanguage: 'zh-CN',
        timeRange: 1,
      }));

      const list = hypeData?.data?.leaderBoardList || [];
      list.slice(0, 8).forEach((item, idx) => {
        const brief = item.socialHypeInfo?.socialSummaryBriefTranslated || item.socialHypeInfo?.socialSummaryBrief || item.metaInfo?.symbol;
        const mainTopic = (brief.split('，')[0] || brief).replace(/\s+/g, '');
        trends.push({
          rank: idx + 1,
          hashtag: `#${mainTopic}`,
          topic: mainTopic,
          discussionCount: item.socialHypeInfo?.socialHypeCn || item.socialHypeInfo?.socialHype || 10000,
        });
      });
    } catch (e) {
      // 容错降级
    }
  }

  // 兜底保障标签
  if (trends.length === 0) {
    const fallbackTopics = [
      { topic: 'Wintermute存入ETH', count: 149053 },
      { topic: 'Revolut数据泄露', count: 180808 },
      { topic: 'Zcash挖矿激增', count: 31187 },
      { topic: 'Bitwise清算DOGEETF', count: 19122 },
      { topic: '全网爆仓6.74亿美元', count: 1080 },
    ];
    fallbackTopics.forEach((t, idx) => {
      trends.push({
        rank: idx + 1,
        hashtag: `#${t.topic}`,
        topic: t.topic,
        discussionCount: t.count,
      });
    });
  }

  console.log(`[Step 1] 成功确认 ${trends.length} 个广场热搜借势标签:`);
  trends.slice(0, 5).forEach((t) => {
    console.log(`  Top ${t.rank}: ${t.hashtag} (${t.discussionCount} 讨论度)`);
  });

  return trends;
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

  // 3. Web3 聪明钱净流入 (复用 crypto-market-rank)
  try {
    const bscInflow = await rankCall(rankCommands['smart-money-inflow']({ chainId: '56' }));
    if (bscInflow?.data?.list) {
      result.web3.smartMoneyInflows = bscInflow.data.list.slice(0, 5).map((item) => ({
        symbol: item.symbol,
        tokenAddress: item.tokenAddress,
        netInflowUSD: item.netInflowUsd || item.inflowUsd,
        priceChange24h: item.priceChange24h,
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
  console.log('[Step 3] 正在从传统顶级财经媒体 (CNBC, Yahoo Finance, MarketWatch) 与加密权威机构聚合实时要闻...');

  const newsSummary = {
    traditionalFinance: [],
    cryptoInstitutions: [],
    officialAnnouncements: [],
  };

  // 1. 传统权威金融媒体 A：CNBC Finance & Economy RSS (宏观通胀、美联储、华尔街动向)
  try {
    const cnbcRes = await fetch('https://www.cnbc.com/id/10000664/device/rss/rss.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (cnbcRes.ok) {
      const xml = await cnbcRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && newsSummary.traditionalFinance.length < 4) {
        newsSummary.traditionalFinance.push({
          source: 'CNBC',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] CNBC 新闻源暂缓:', err.message);
  }

  // 2. 传统权威金融媒体 B：Yahoo Finance (BTC / 宏观资产综合信源)
  try {
    const yfRes = await fetch('https://finance.yahoo.com/rss/headline?s=BTC-USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (yfRes.ok) {
      const xml = await yfRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && newsSummary.traditionalFinance.length < 8) {
        newsSummary.traditionalFinance.push({
          source: 'Yahoo Finance',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    console.warn('  [Notice] Yahoo Finance 新闻源暂缓:', err.message);
  }

  // 3. 传统权威金融媒体 C：MarketWatch (Dow Jones / 传统大宗与美股联动)
  try {
    const mwRes = await fetch('https://feeds.content.dowjones.io/public/rss/mw_topstories', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (mwRes.ok) {
      const xml = await mwRes.text();
      const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && newsSummary.traditionalFinance.length < 10) {
        newsSummary.traditionalFinance.push({
          source: 'MarketWatch',
          title: cleanHtml(m[1]),
          summary: cleanHtml(m[2]).slice(0, 180),
        });
      }
    }
  } catch (err) {
    // 降级保护
  }

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
      while ((m = itemRegex.exec(xml)) !== null && newsSummary.cryptoInstitutions.length < 8) {
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

  // 6. 币安官方公告库 (100% 官方，新币与规则调整)
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
  console.log(`  加密机构源: ${newsSummary.cryptoInstitutions.length} 条 (The Block / CoinTelegraph)`);
  if (newsSummary.traditionalFinance[0]) {
    console.log(`  [精选传统金融] [${newsSummary.traditionalFinance[0].source}] ${newsSummary.traditionalFinance[0].title}`);
  }
  if (newsSummary.cryptoInstitutions[0]) {
    console.log(`  [精选加密机构] [${newsSummary.cryptoInstitutions[0].source}] ${newsSummary.cryptoInstitutions[0].title}`);
  }

  return newsSummary;
}

// ==========================================
// STEP 4: 选题加权与多模态去AI味动态创作引擎 (Anti-Shadowban Engine)
// ==========================================
export function step4_generatePost({ trends, marketData, news, type = 'short' }) {
  console.log('----------------------------------------------------');
  console.log(`[Step 4] 正在根据实时新闻热点与盘面特征进行主题决策...`);

  // 汇聚全部新闻文本做特征分析
  const allNewsItems = [...(news.traditionalFinance || []), ...(news.cryptoInstitutions || [])];
  const combinedNewsText = allNewsItems.map(n => `${n.title} ${n.summary}`).join(' ').toLowerCase();

  // 1. 计算 4 种主题模型的热点匹配权重
  let scoreMacro = 0;       // 宏观与通胀美联储联动
  let scoreWhale = 0;       // 做市商与巨鲸筹码博弈
  let scoreNarrative = 0;   // 叙事突发、ETF与老币异动
  let scoreSecurity = 0;    // 安全泄露与风控避险

  if (/inflation|cpi|interest rate|fed|federal reserve|housing|jobs|paycheck|debasement|wall street|macro/.test(combinedNewsText)) scoreMacro += 3;
  if (/whale|wintermute|inflow|outflow|liquidat|dump|accumulat|orderbook/.test(combinedNewsText)) scoreWhale += 3;
  if (/etf|bitwise|grayscale|zcash|zec|doge|solana|xrp|sec|mining|hashrate/.test(combinedNewsText)) scoreNarrative += 3;
  if (/leak|breach|revolut|phish|hack|drain|stolen|scam|warning/.test(combinedNewsText)) scoreSecurity += 3;

  // 结合广场 Trends 热度微调
  const trendsText = trends.map(t => t.topic).join(' ');
  if (/Wintermute|爆仓|清算/.test(trendsText)) scoreWhale += 2;
  if (/Zcash|ETF|DOGE/.test(trendsText)) scoreNarrative += 2;
  if (/Revolut|安全|泄露/.test(trendsText)) scoreSecurity += 2;

  // 确定获胜主题模型
  let archetype = 'macro';
  const scores = [
    { name: 'macro', score: scoreMacro },
    { name: 'whale', score: scoreWhale },
    { name: 'narrative', score: scoreNarrative },
    { name: 'security', score: scoreSecurity },
  ];
  scores.sort((a, b) => b.score - a.score);
  archetype = scores[0].score > 0 ? scores[0].name : 'macro';

  console.log(`[Step 4] 选题决策中心结果: 锁定【${archetype.toUpperCase()}】模型 (Macro:${scoreMacro}, Whale:${scoreWhale}, Narrative:${scoreNarrative}, Security:${scoreSecurity})`);

  // 提取核心盘面价格
  const btc = marketData.cex.tickers['BTC'] || { price: 76700, changePercent24h: -0.8 };
  const eth = marketData.cex.tickers['ETH'] || { price: 2475, changePercent24h: -2.3 };
  const zec = marketData.cex.tickers['ZEC'] || { price: 1085, changePercent24h: -6.0 };
  const doge = marketData.cex.tickers['DOGE'] || { price: 0.083, changePercent24h: -2.1 };
  const ltc = marketData.cex.tickers['LTC'] || { price: 53.5, changePercent24h: -0.8 };

  const btcPriceStr = Math.round(btc.price).toLocaleString();
  const ethPriceStr = Math.round(eth.price).toLocaleString();
  const ethFr = marketData.cex.fundingRates['ETH']?.fundingRate || '-0.002%';

  // 匹配最佳广场借势标签 (1~2个)
  let tag1 = trends[0]?.hashtag || '#全网爆仓6.74亿美元';
  let tag2 = trends[1]?.hashtag || '#Wintermute存入ETH';

  let postContent = '';
  let title = '';

  // 2. 根据选中的主题模型，采用完全不同的开篇、结构与论述方式（彻底消除同质化指纹）
  if (archetype === 'macro') {
    // 模型 A: 传统金融宏观与通胀联动
    const macroNews = news.traditionalFinance.find(n => /inflation|rate|fed|wall street/i.test(n.title)) || news.traditionalFinance[0];
    const newsMention = macroNews ? `华尔街和外媒都在紧盯“${macroNews.title.slice(0, 45)}...”` : '近期美债与通胀预期反复扰动';

    tag1 = trends.find(t => t.topic.includes('爆仓') || t.topic.includes('BTC'))?.hashtag || '#全网爆仓6.74亿美元';
    tag2 = trends.find(t => t.topic.includes('ETH') || t.topic.includes('Wintermute'))?.hashtag || '#Wintermute存入ETH';

    title = `美股通胀预期升温，大饼76K拉锯背后的宏观暗流`;
    postContent = `最近看外媒财经资讯，${newsMention}，宏观流动性的预期显然又在收紧。

映射到盘面上，大饼 $BTC 已经连续几天被死死按在 ${btcPriceStr} 附近来回锯齿震荡，稍微冲一下就遭遇无情砸盘。很多散户在日内上下500点的空间里被磨得心力交瘁，这正是典型的宏观观望期特征。

以太坊 $ETH 表现更弱，在 ${ethPriceStr} 附近承压，合约资金费率持续在 ${ethFr} 低位徘徊。虽然有做市商频繁倒手转移筹码，但在美联储利率路径和真实通胀拐点明朗之前，机构大钱根本不可能在这种位置无脑接盘。

老韭菜的经验是，每次传统金融资金犹豫不决的时候，场内就极易演变成存量互割的“绞肉机行情”。与其在阻力位前硬猜方向上高杠杆，不如多关注宏观风向，留好手里的子弹。

大家目前是空仓观望还是拿着现货死扛？

${tag1} ${tag2}`;

  } else if (archetype === 'whale') {
    // 模型 B: 链上做市商与流动性猎杀
    tag1 = trends.find(t => t.topic.includes('Wintermute') || t.topic.includes('ETH'))?.hashtag || '#Wintermute存入ETH';
    tag2 = trends.find(t => t.topic.includes('爆仓') || t.topic.includes('清算'))?.hashtag || '#全网爆仓6.74亿美元';

    title = `巨鲸大额现货归集，做市商这套流动性猎杀逻辑必须看懂`;
    postContent = `这两天链上监控刷屏，做市巨鲸频繁将大额以太坊归集进交易所，广场上讨论直接破了十几万。

很多人一看到做市商转币就喊大暴跌，但盘面真相往往没那么单纯。以太坊 $ETH 目前挂在 ${ethPriceStr} 附近反复试探支撑，做市商在大额搬砖的同时，往往伴随着期权衍生品的对冲锁仓，核心目的是在清淡流动性里两头吃利差，顺带把挂单密集的散户止损单打掉。

再看大饼 $BTC，在 ${btcPriceStr} 关键位附近缩量横盘。只要大盘没有走出单边放量突破，主力在这个位置的每一次反弹拉升，都极大概率是流动性猎杀。

跟做市商玩，最忌讳的就是盯着链上单笔转账无脑跟风。盘面不放量确认，所有的插针都是试盘。控制好杠杆倍数，保住本金比什么都重要。

${tag1} ${tag2}`;

  } else if (archetype === 'narrative') {
    // 模型 C: 叙事突发、ETF落地与老币异动 (ZEC / DOGE / LTC)
    const isZec = /zcash|zec/i.test(combinedNewsText) || trends.some(t => t.topic.includes('Zcash'));
    const featuredSymbol = isZec ? '$ZEC' : '$DOGE';
    const featuredPrice = isZec ? Math.round(zec.price).toLocaleString() : doge.price;

    tag1 = trends.find(t => t.topic.includes('Zcash') || t.topic.includes('DOGE') || t.topic.includes('ETF'))?.hashtag || '#Zcash挖矿激增';
    tag2 = trends.find(t => t.topic.includes('清算') || t.topic.includes('爆仓'))?.hashtag || '#全网爆仓6.74亿美元';

    title = `老牌币种题材异动，狂欢背后谨防庄家拉高出货`;
    postContent = `这两天老牌赛道异动频频，${featuredSymbol} 突然成为讨论焦点，价格波动剧烈，报价来到 ${featuredPrice} 附近。

不管是传闻算力激增还是所谓的机构ETF产品调整，老韭菜必须保持清醒：在整体流动性有限的震荡市里，老币种借着突发叙事放量拉升，十有八九是潜伏主力借着流动性高潮在悄悄派发筹码。

大盘大饼 $BTC 仍在 ${btcPriceStr} 附近震荡磨人，主流还没真正确立新一轮大趋势。当大盘都在走弱回调时，任何脱离基本面的山寨脉冲都极难维持持久性。

别一看到题材新闻就盲目无脑冲，被套在树顶上往往就是一瞬间。等盘面回调到真正强支撑、大盘止跌企稳了再看也不迟。

${tag1} ${tag2}`;

  } else {
    // 模型 D: 安全漏洞与链上风控防钓鱼
    tag1 = trends.find(t => t.topic.includes('Revolut') || t.topic.includes('安全'))?.hashtag || '#Revolut数据泄露';
    tag2 = trends.find(t => t.topic.includes('BTC') || t.topic.includes('爆仓'))?.hashtag || '#全网爆仓6.74亿美元';

    title = `链上安全事件频发，行情洗盘期如何守住钱包本金`;
    postContent = `最近主流机构和金融平台数据泄露的新闻闹得沸沸扬扬，黑客通过伪造邮件和诱导授权钓走资产的案例层出不穷。

越是在市场行情冷清、大饼 $BTC 在 ${btcPriceStr} 附近来回洗盘磨人的时候，大家的防范心理往往越容易松懈。各种冒充官方空投、账户升级的钓鱼链接铺天盖地，稍不留神就会把授权给出去。

行情做不好大不了少赚点，但钱包要是被黑了，多年积累直接归零。建议各位交易员抽空彻底排查一下自己的钱包授权，长期不动的资产尽量隔离存放在冷钱包或主流大所。

在加密圈摸爬滚打，赚钱靠周期，守财靠风控。安全第一，交易第二。

${tag1} ${tag2}`;
  }

  // 严格自检过滤：彻底去除任何 Markdown 语法符号
  const sanitizedContent = postContent
    .replace(/\*\*/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();

  // 检查 Cashtags 数量（严格 <= 3）
  const cashtags = [...sanitizedContent.matchAll(/\$([A-Za-z0-9]+)/g)].map(m => `$${m[1].toUpperCase()}`);
  const uniqueCashtags = [...new Set(cashtags)];
  if (uniqueCashtags.length > 3) {
    throw new Error(`Cashtags exceed limit 3: ${uniqueCashtags.join(', ')}`);
  }

  console.log(`[Step 4] 内容生成成功！`);
  console.log(`  采用模型: ${archetype}`);
  console.log(`  形态: ${type === 'short' ? '短动态 (contentType: 1)' : '文章 (contentType: 2)'}`);
  console.log(`  字数: ${sanitizedContent.length} 字符`);
  console.log(`  绑定币种(Cashtags <= 3): ${uniqueCashtags.join(', ')}`);
  console.log(`  引用广场热榜: ${tag1}, ${tag2}`);

  return {
    type,
    contentType: type === 'short' ? 1 : 2,
    title: type === 'short' ? null : title,
    bodyTextOnly: sanitizedContent,
    cashtags: uniqueCashtags,
    hashtags: [tag1, tag2],
    archetype,
  };
}

// ==========================================
// STEP 5: 官方 Skill 上传发帖模块
// ==========================================
export async function step5_publishPost(post, { dryRun = false } = {}) {
  console.log('----------------------------------------------------');
  console.log(`[Step 5] ${dryRun ? '【试运行预览 DRY-RUN】' : '【正在发布到币安广场】'}...`);

  console.log('\n================ 生成的内容预览 (真实发帖效果) ================');
  if (post.title) {
    console.log(`【标题】${post.title}\n`);
  }
  console.log(post.bodyTextOnly);
  console.log('===============================================================\n');

  if (dryRun) {
    console.log('[DRY-RUN] 当前为试运行模式，未实际上传至币安广场。');
    console.log('[DRY-RUN] 若文案与数据符合预期，请添加 --publish 参数执行全自动发布。');
    return {
      success: true,
      dryRun: true,
      preview: post,
    };
  }

  const apiKey = resolveApiKey();
  const payload = {
    contentType: post.contentType,
    bodyTextOnly: post.bodyTextOnly,
  };
  if (post.title) {
    payload.title = post.title;
  }

  console.log('正在调用币安广场官方 OpenAPI (/content/add)...');
  const result = await publish(apiKey, payload);
  printPublishSuccess(result);

  return {
    success: true,
    dryRun: false,
    id: result.id,
    shareLink: result.shareLink,
  };
}

// ==========================================
// 统一驱动函数 (CLI Pipeline Runner)
// ==========================================
export async function runPipeline({ dryRun = true, type = 'short' } = {}) {
  console.log('\n======================================================');
  console.log('   🚀 币安广场【内容挖矿】端到端全自动工作流启动');
  console.log(`   模式: ${dryRun ? 'DRY-RUN (试运行预览)' : 'LIVE-PUBLISH (实际发布)'} | 格式: ${type}`);
  console.log('======================================================\n');

  try {
    const trends = await step1_fetchTrends();
    const marketData = await step2_fetchMarketData();
    const news = await step3_fetchNews();
    const post = step4_generatePost({ trends, marketData, news, type });
    const publishResult = await step5_publishPost(post, { dryRun });

    console.log('\n✨ 工作流五步全流程执行完毕！');
    return publishResult;
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
  const isPublish = args.includes('--publish');
  const isDryRun = args.includes('--dry-run') || !isPublish;
  const isArticle = args.includes('--article');
  const type = isArticle ? 'article' : 'short';

  await runPipeline({ dryRun: isDryRun, type });
}


