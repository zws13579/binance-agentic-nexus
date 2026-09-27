#!/usr/bin/env node
/**
 * Binance USDT-M Futures Multi-Factor Breakout Scanner
 * Location: scripts/futures_scanner.mjs
 *
 * Lightweight, 2-stage market scanner:
 * Stage 1: Single-call market filter (24hr ticker, volume > 10M USDT)
 * Stage 2: Concurrent 20-period K-line resonance analysis (Box breakout + Volume surge)
 *
 * Usage:
 *   node scripts/futures_scanner.mjs [--top 5] [--interval 4h] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

// Auto-load .env into process.env so native fetch routes via proxy if set
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

const FAPI_HOST = 'https://fapi.binance.com';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// Stage 1: Filter Top Liquid USDT-M Contracts
async function getActiveSymbols(minVolumeUSDT = 10_000_000, candidateLimit = 20) {
  const tickers = await fetchJson(`${FAPI_HOST}/fapi/v1/ticker/24hr`);
  if (!Array.isArray(tickers)) return [];

  const stablecoins = ['USDCUSDT', 'FDUSDUSDT', 'BUSDUSDT', 'TUSDUSDT', 'EURUSDT'];
  return tickers
    .filter(t => t.symbol.endsWith('USDT') && !stablecoins.includes(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= minVolumeUSDT)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, candidateLimit);
}

// Concurrency pool helper
async function poolAll(items, fn, concurrency = 5) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (concurrency <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// Stage 2: Calculate Multi-Factor Resonance Score
function calculateResonanceScore(ticker, klines) {
  const currentPrice = parseFloat(ticker.lastPrice);

  // 1. Volume Breakout (latest volume vs 20-period average)
  const volumes = klines.map(k => parseFloat(k[7])); // quoteVolume
  const latestVol = volumes[volumes.length - 1] || 0;
  const historyVol = volumes.slice(0, -1);
  const avgVol = historyVol.length > 0 ? historyVol.reduce((a, b) => a + b, 0) / historyVol.length : 1;
  const volRatio = avgVol > 0 ? latestVol / avgVol : 0;
  const volumeBreakout = Math.min(Math.max((volRatio - 1) / 1.5, 0), 1.0); // 2.5x volume = 1.0

  // 2. Price Box Breakout (current price vs highest high of past 19 candles)
  const highs = klines.slice(0, -1).map(k => parseFloat(k[2]));
  const boxTop = highs.length > 0 ? Math.max(...highs) : currentPrice;
  let priceBoxBreakout = 0;
  if (boxTop > 0 && currentPrice > boxTop) {
    const breakoutPct = (currentPrice - boxTop) / boxTop;
    priceBoxBreakout = Math.min(breakoutPct / 0.03, 1.0); // 3% breakout above box = 1.0
  }

  // 3. Funding Rate Indicator (low or negative funding rate = lower long crowd risk)
  const fundingRate = parseFloat(ticker.lastFundingRate || '0');
  let fundingRateSignal = 0.5;
  if (fundingRate < 0) {
    fundingRateSignal = 1.0; // Negative rate (short squeeze potential)
  } else if (fundingRate <= 0.0001) {
    fundingRateSignal = 0.8; // Low neutral rate
  } else if (fundingRate > 0.0005) {
    fundingRateSignal = 0.1; // Overcrowded long rate
  }

  // 4. Momentum Signal (24h price change normalized)
  const changePct = parseFloat(ticker.priceChangePercent);
  const priceChangeSignal = Math.min(Math.max((changePct + 5) / 20, 0), 1.0);

  // Composite Weighted Score (0 ~ 10)
  const total = (
    volumeBreakout    * 0.35 +
    priceBoxBreakout  * 0.35 +
    fundingRateSignal * 0.15 +
    priceChangeSignal * 0.15
  ) * 10;

  return {
    total: Math.round(total * 100) / 100,
    detail: {
      volumeRatio: Math.round(volRatio * 100) / 100,
      boxTop,
      breakoutMargin: boxTop > 0 && currentPrice > boxTop ? ((currentPrice - boxTop) / boxTop * 100).toFixed(2) + '%' : '0%',
      volumeBreakout: Math.round(volumeBreakout * 100) / 100,
      priceBoxBreakout: Math.round(priceBoxBreakout * 100) / 100,
      fundingRateSignal: Math.round(fundingRateSignal * 100) / 100,
    }
  };
}

// Main Scanner Execution
export async function scanFuturesMarket({ top = 5, interval = '4h', minVolume = 10_000_000 } = {}) {
  const candidates = await getActiveSymbols(minVolume, Math.max(top * 4, 20));
  if (candidates.length === 0) return [];

  const scoredCandidates = await poolAll(candidates, async (ticker) => {
    try {
      const klines = await fetchJson(`${FAPI_HOST}/fapi/v1/klines?symbol=${ticker.symbol}&interval=${interval}&limit=20`);
      if (!Array.isArray(klines) || klines.length < 10) return null;
      const score = calculateResonanceScore(ticker, klines);
      return {
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        change24h: parseFloat(ticker.priceChangePercent).toFixed(2) + '%',
        volMillion: (parseFloat(ticker.quoteVolume) / 1e6).toFixed(1) + 'M',
        score: score.total,
        metrics: score.detail
      };
    } catch {
      return null;
    }
  }, 5);

  return scoredCandidates
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

// CLI Execution
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const topIdx = args.indexOf('--top');
  const top = topIdx !== -1 && args[topIdx + 1] ? parseInt(args[topIdx + 1], 10) : 5;
  const intervalIdx = args.indexOf('--interval');
  const interval = intervalIdx !== -1 && args[intervalIdx + 1] ? args[intervalIdx + 1] : '4h';

  scanFuturesMarket({ top, interval })
    .then(results => {
      if (isJson) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`\n================= Binance 合约多因子突破雷达 (Top ${top}) =================`);
        console.log(`周期: ${interval} | 算法: 箱体突破(35%) × 放量倍数(35%) × 费率健康(15%) × 动量(15%)\n`);
        console.table(results.map(r => ({
          '标的': r.symbol,
          '现价': r.price,
          '24h涨跌': r.change24h,
          '成交额': r.volMillion,
          '共振总分': r.score,
          '量比': r.metrics.volumeRatio + 'x',
          '突破箱顶': r.metrics.breakoutMargin
        })));
        console.log('========================================================================\n');
      }
    })
    .catch(err => {
      console.error('Scanner error:', err.message);
      process.exit(1);
    });
}
