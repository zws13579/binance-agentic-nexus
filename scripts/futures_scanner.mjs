#!/usr/bin/env node
/** Direction-neutral USDⓈ-M perpetual evidence scanner. No strategy scores or probabilities. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);
const numberOrNull = value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function loadProjectEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function poolAll(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function emaSeries(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  result[period - 1] = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) result[i] = closes[i] * alpha + result[i - 1] * (1 - alpha);
  return result;
}

/** Fixed definitions, exported for offline verification without importing credentials. */
export function calculateFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 55) throw new Error('At least 55 valid closed candles are required');
  const last = candles.at(-1);
  const history = candles.slice(-21, -1);
  const boxTop = Math.max(...history.map(candle => candle.high));
  const boxBottom = Math.min(...history.map(candle => candle.low));
  const averageQuoteVolume = history.reduce((sum, candle) => sum + candle.quoteVolume, 0) / 20;
  const closes = candles.map(candle => candle.close);
  const ema = period => {
    const series = emaSeries(closes, period);
    const value = series.at(-1);
    const fiveCandlesAgo = series.at(-6);
    return { value, fiveCandlesAgo, change: value - fiveCandlesAgo, changePercent: (value / fiveCandlesAgo - 1) * 100 };
  };
  const ranges = candles.map((candle, index) => index === 0 ? candle.high - candle.low : Math.max(
    candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)
  ));
  let atr14 = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (let i = 14; i < ranges.length; i++) atr14 = (atr14 * 13 + ranges[i]) / 14;
  return {
    signalOpenTime: last.openTime, signalCloseTime: last.closeTime, signalClose: last.close,
    boxTop, boxBottom, averageQuoteVolume,
    volumeRatio: averageQuoteVolume > 0 ? last.quoteVolume / averageQuoteVolume : null,
    ema20: ema(20), ema50: ema(50), atr14,
    rangePosition: boxTop > boxBottom ? (last.close - boxBottom) / (boxTop - boxBottom) : null,
    upperDistance: { percent: (last.close / boxTop - 1) * 100, atr: atr14 > 0 ? (last.close - boxTop) / atr14 : null },
    lowerDistance: { percent: (1 - last.close / boxBottom) * 100, atr: atr14 > 0 ? (boxBottom - last.close) / atr14 : null },
    changes: Object.fromEntries([1, 5, 20].map(count => [count, (last.close / candles.at(-1 - count).close - 1) * 100]))
  };
}

function closedEvidence(rows, serverTime) {
  if (!Array.isArray(rows)) throw new Error('Invalid kline response');
  const candles = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) throw new Error('Malformed kline');
    const closeTime = numberOrNull(row[6]);
    if (closeTime === null) throw new Error('Missing kline close time');
    if (closeTime >= serverTime) continue;
    const candle = {
      openTime: numberOrNull(row[0]), open: numberOrNull(row[1]), high: numberOrNull(row[2]),
      low: numberOrNull(row[3]), close: numberOrNull(row[4]), volume: numberOrNull(row[5]),
      closeTime, quoteVolume: numberOrNull(row[7])
    };
    if (Object.values(candle).some(value => value === null) || candle.openTime > candle.closeTime ||
      [candle.open, candle.high, candle.low, candle.close].some(value => value <= 0) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close) ||
      candle.volume < 0 || candle.quoteVolume < 0) throw new Error('Invalid kline values');
    candles.push(candle);
  }
  const selected = candles.slice(-200);
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].openTime !== selected[i - 1].closeTime + 1) {
      return { status: 'INVALID', candles: selected, features: null, missingData: ['Non-contiguous or unordered closed candles'] };
    }
  }
  if (selected.length < 200) return {
    status: 'INSUFFICIENT_DATA', candles: selected, features: null,
    missingData: [`Expected 200 closed candles; received ${selected.length}`]
  };
  return { status: 'OK', candles: selected, features: calculateFeatures(selected), missingData: [] };
}

/** A snapshot of the unclosed candle, never an input to closed-candle features. */
function currentCandleEvidence(rows, serverTime) {
  const unavailable = (status, message) => ({ currentCandle: null, currentCandleStatus: status, currentCandleMissingData: [message] });
  if (!Array.isArray(rows)) return unavailable('INVALID', 'Invalid kline response for current candle');
  let previous = null;
  let currentCandle = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) return unavailable('INVALID', 'Malformed kline in current candle response');
    const candle = {
      openTime: numberOrNull(row[0]), open: numberOrNull(row[1]), high: numberOrNull(row[2]),
      low: numberOrNull(row[3]), close: numberOrNull(row[4]), volume: numberOrNull(row[5]),
      closeTime: numberOrNull(row[6]), quoteVolume: numberOrNull(row[7])
    };
    if (Object.values(candle).some(value => value === null) ||
      !Number.isSafeInteger(candle.openTime) || !Number.isSafeInteger(candle.closeTime) ||
      candle.openTime < 0 || candle.openTime > candle.closeTime ||
      [candle.open, candle.high, candle.low, candle.close].some(value => value <= 0) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close) ||
      candle.volume < 0 || candle.quoteVolume < 0) return unavailable('INVALID', 'Invalid kline values in current candle response');
    if (previous && candle.openTime <= previous.closeTime) return unavailable('INVALID', 'Overlapping or unordered candles in current candle response');
    if (candle.openTime > serverTime) return unavailable('INVALID', 'Future candle open time exceeds server time');
    if (candle.closeTime >= serverTime) {
      if (previous && candle.openTime !== previous.closeTime + 1) return unavailable('INVALID', 'Current candle is not contiguous with previous closed candle');
      currentCandle = candle;
    }
    previous = candle;
  }
  if (!currentCandle) return unavailable('UNKNOWN', 'Current candle absent at server time');
  return { currentCandle, currentCandleStatus: 'OK', currentCandleMissingData: [] };
}

export async function scanFuturesMarket({
  top = 5, interval, intervals = ['4h', '1h', '15m'], minVolume = 10_000_000,
  fetchImpl = globalThis.fetch, now = Date.now, loadEnv = true, baseUrl = 'https://fapi.binance.com'
} = {}) {
  if (!Number.isSafeInteger(top) || top <= 0) throw new Error('top must be a positive integer');
  if (!Number.isFinite(minVolume) || minVolume < 0) throw new Error('minVolume must be a nonnegative number');
  const requestedIntervals = [...new Set(interval ? [interval] : intervals)];
  if (!requestedIntervals.length || requestedIntervals.some(value => !INTERVALS.has(value))) throw new Error('Unsupported kline interval');
  if (loadEnv) loadProjectEnv();
  const request = async (pathname, params) => {
    const url = new URL(pathname, baseUrl);
    if (params) url.search = new URLSearchParams(params).toString();
    const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && typeof data === 'object' && Number(data.code) < 0) throw new Error(`Binance error ${data.code}`);
    return data;
  };
  const [exchange, tickers, time, premium] = await Promise.allSettled([
    request('/fapi/v1/exchangeInfo'), request('/fapi/v1/ticker/24hr'), request('/fapi/v1/time'), request('/fapi/v1/premiumIndex')
  ]);
  for (const [name, result] of [['exchangeInfo', exchange], ['24hr ticker', tickers], ['serverTime', time]]) {
    if (result.status !== 'fulfilled') throw new Error(`${name} unavailable: ${result.reason.message}`);
  }
  if (!Array.isArray(exchange.value?.symbols) || !Array.isArray(tickers.value)) throw new Error('Invalid exchangeInfo or ticker response');
  const serverTime = numberOrNull(time.value?.serverTime);
  if (serverTime === null || serverTime <= 0) throw new Error('Invalid serverTime response');
  const active = new Set(exchange.value.symbols.filter(symbol => symbol.status === 'TRADING' && symbol.contractType === 'PERPETUAL' &&
    symbol.quoteAsset === 'USDT' && symbol.marginAsset === 'USDT').map(symbol => symbol.symbol));
  const fundingData = premium.status === 'fulfilled' && Array.isArray(premium.value) ? new Map(premium.value.map(row => [row.symbol, row])) : new Map();
  const candidates = tickers.value.filter(ticker => active.has(ticker.symbol) && numberOrNull(ticker.quoteVolume) !== null &&
    Number(ticker.quoteVolume) >= minVolume).sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume) || a.symbol.localeCompare(b.symbol)).slice(0, top);
  const observedAt = new Date(now()).toISOString();
  const result = candidates.map(ticker => {
    const funding = fundingData.get(ticker.symbol);
    const rate = numberOrNull(funding?.lastFundingRate);
    const sourceTime = numberOrNull(funding?.time);
    const nextFundingTime = numberOrNull(funding?.nextFundingTime);
    const currentPrice = numberOrNull(ticker.lastPrice);
    const change24h = numberOrNull(ticker.priceChangePercent);
    const missingData = [];
    if (currentPrice === null || currentPrice <= 0) missingData.push('Current ticker price unknown');
    if (change24h === null) missingData.push('24h price change unknown');
    if (rate === null || sourceTime === null || nextFundingTime === null) missingData.push('Funding data unavailable or incomplete');
    return {
      schemaVersion: 2, rankingBasis: 'quoteVolume', symbol: ticker.symbol, price: currentPrice, currentPrice,
      change24h: change24h === null ? null : `${change24h.toFixed(2)}%`, change24hPercent: change24h,
      quoteVolume: Number(ticker.quoteVolume), volMillion: `${(Number(ticker.quoteVolume) / 1e6).toFixed(1)}M`,
      observedAt, serverTime, currentPriceTime: numberOrNull(ticker.closeTime),
      funding: { rate, nextFundingTime, sourceTime, status: rate !== null && sourceTime !== null && nextFundingTime !== null ? 'OK' : 'UNKNOWN', source: '/fapi/v1/premiumIndex' },
      timeframes: {}, missingData, status: 'OK'
    };
  });
  const jobs = result.flatMap((candidate, index) => requestedIntervals.map(period => ({ index, period, symbol: candidate.symbol })));
  await poolAll(jobs, async ({ index, period, symbol }) => {
    let current = { currentCandle: null, currentCandleStatus: 'UNKNOWN', currentCandleMissingData: ['Current candle request unavailable'] };
    try {
      const rows = await request('/fapi/v1/klines', { symbol, interval: period, limit: '201', endTime: String(serverTime) });
      current = currentCandleEvidence(rows, serverTime);
      result[index].timeframes[period] = { ...closedEvidence(rows, serverTime), ...current };
    } catch (error) {
      result[index].timeframes[period] = { status: 'UNKNOWN', candles: [], features: null, missingData: [error.message], ...current };
    }
  }, 5);
  for (const candidate of result) {
    candidate.timeframes = Object.fromEntries(requestedIntervals.map(period => [period, candidate.timeframes[period]]));
    for (const [period, evidence] of Object.entries(candidate.timeframes)) {
      candidate.missingData.push(...evidence.missingData.map(message => `${period}: ${message}`));
      if (evidence.currentCandleStatus === 'INVALID') candidate.missingData.push(
        ...evidence.currentCandleMissingData.map(message => `${period} current candle: ${message}`)
      );
    }
    candidate.status = candidate.missingData.length ? 'PARTIAL' : 'OK';
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  let json = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const argument = args[i];
      if (argument === '--json') { json = true; continue; }
      if (argument === '--help') {
        console.log('Usage: futures_scanner.mjs [--top 5] [--min-volume 10000000] [--interval 4h | --intervals 4h,1h,15m] [--json]');
        process.exit(0);
      }
      if (!['--top', '--min-volume', '--interval', '--intervals'].includes(argument) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${argument}`);
      const value = args[++i];
      if (argument === '--top') {
        if (!/^[1-9]\d*$/.test(value)) throw new Error('--top requires a positive integer');
        options.top = Number(value);
      } else if (argument === '--min-volume') options.minVolume = Number(value);
      else if (argument === '--interval') options.interval = value;
      else options.intervals = value.split(',');
    }
    if (options.interval && options.intervals) throw new Error('--interval and --intervals are mutually exclusive');
    const results = await scanFuturesMarket(options);
    if (json) console.log(JSON.stringify(results, null, 2));
    else {
      console.log('Binance 合约中立候选雷达：按真实成交额排序，结构数据不代表胜率');
      console.table(results.map(row => ({ 标的: row.symbol, 现价: row.currentPrice, '24h涨跌': row.change24h,
        成交额: row.volMillion, 资金费率: row.funding.rate, 数据状态: row.status })));
      for (const row of results) console.log(JSON.stringify({ symbol: row.symbol, timeframes: Object.fromEntries(
        Object.entries(row.timeframes).map(([period, evidence]) => [period, {
          status: evidence.status, features: evidence.features, missingData: evidence.missingData,
          currentCandle: evidence.currentCandle, currentCandleStatus: evidence.currentCandleStatus,
          currentCandleMissingData: evidence.currentCandleMissingData
        }])
      ), missingData: row.missingData }, null, 2));
    }
  } catch (error) { console.error(`Scanner error: ${error.message}`); process.exitCode = 1; }
}
