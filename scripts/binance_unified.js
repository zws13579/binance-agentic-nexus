/**
 * Unified Binance CEX/Futures CLI & Library
 * Location: scripts/binance_unified.js
 *
 * Consolidates all CEX query, trading, and risk-management operations
 * into a single reusable client. Reads credentials from the project
 * root .env file automatically.
 *
 * Network: Uses Node.js native fetch(). In TUN mode, works directly.
 * In port-proxy mode, run with: node --import ./scripts/proxy_bootstrap.mjs
 *
 * Usage (from project root):
 *   node scripts/binance_unified.js status
 *   node scripts/binance_unified.js ticker <symbol1> [symbol2...]
 *   node scripts/binance_unified.js top-volume [limit]
 *   node scripts/binance_unified.js sentiment <symbol>
 *   node scripts/binance_unified.js open-algos [symbol]
 *   node scripts/binance_unified.js open-orders [symbol]
 *   node scripts/binance_unified.js positions [symbol]
 *   node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]
 *   node scripts/binance_unified.js trades <symbol> [limit]
 *   node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// 1. Configuration & Credentials
// Resolve .env relative to this script's location (scripts/ -> project root)
const envPath = path.resolve(__dirname, '..', '.env');
const fallbackEnvPath = path.resolve(process.cwd(), '.env');
const actualEnvPath = fs.existsSync(envPath) ? envPath : fallbackEnvPath;

const env = {};
if (fs.existsSync(actualEnvPath)) {
  fs.readFileSync(actualEnvPath, 'utf8').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
}

const API_KEY = env.BINANCE_API_KEY || process.env.BINANCE_API_KEY;
const SECRET_KEY = env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET_KEY;
const SPOT_HOST = 'https://api.binance.com';
const FAPI_HOST = 'https://fapi.binance.com';

let timeOffset = null;

// 2. Core Network & Signing (native fetch, no subprocess)
async function httpRequest(url, method = 'GET', headers = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { method, headers });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

async function syncTime() {
  if (timeOffset === null) {
    const res = await httpRequest(`${SPOT_HOST}/api/v3/time`);
    timeOffset = res && res.serverTime ? res.serverTime - Date.now() : 0;
  }
}

function sign(qs) {
  return crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
}

async function signedReq(host, endpoint, params = {}, method = 'GET') {
  await syncTime();
  const ts = Date.now() + timeOffset;
  const qp = new URLSearchParams({ ...params, timestamp: ts.toString(), recvWindow: '10000' });
  const qs = qp.toString();
  const sig = sign(qs);
  const fullUrl = `${host}${endpoint}?${qs}&signature=${sig}`;
  return httpRequest(fullUrl, method, { 'X-MBX-APIKEY': API_KEY });
}

// 3. Consolidated Methods
const Client = {
  // Account Status: Earn, Spot, Futures
  async getStatus() {
    const earn = await signedReq(SPOT_HOST, '/sapi/v1/simple-earn/flexible/position');
    const spot = await signedReq(SPOT_HOST, '/api/v3/account');
    const futures = await signedReq(FAPI_HOST, '/fapi/v2/account');
    const openAlgos = await signedReq(FAPI_HOST, '/fapi/v1/openAlgoOrders');

    const spotBalances = (spot.balances || []).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    const futuresPositions = (futures.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    return {
      earn: earn.rows || earn,
      spotBalances,
      futures: {
        walletBalance: futures.totalWalletBalance,
        availableBalance: futures.availableBalance,
        unrealizedProfit: futures.totalUnrealizedProfit,
        positions: futuresPositions,
        openAlgoOrders: openAlgos
      }
    };
  },

  // Market Tickers
  async getTickers(symbols) {
    if (!symbols || (Array.isArray(symbols) && symbols.length === 0)) {
      throw new Error('Symbols list is required. Example: Client.getTickers(["BTCUSDT", "ETHUSDT"])');
    }
    const data = await httpRequest(`${SPOT_HOST}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
    return Array.isArray(data) ? data.map(t => ({
      symbol: t.symbol,
      price: t.lastPrice,
      change: t.priceChangePercent + '%',
      high: t.highPrice,
      low: t.lowPrice,
      volMillion: (parseFloat(t.quoteVolume) / 1e6).toFixed(2) + 'M'
    })) : data;
  },

  // Top Volume USDT pairs
  async getTopVolume(limit = 10) {
    const tickers = await httpRequest(`${SPOT_HOST}/api/v3/ticker/24hr`);
    if (!Array.isArray(tickers)) return tickers;
    const stable = ['USDC', 'FDUSD', 'EUR', 'TUSD', 'USDP', 'BUSD', 'AEUR', 'USD1'];
    return tickers
      .filter(t => t.symbol.endsWith('USDT') && !stable.includes(t.symbol.replace('USDT', '')))
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent) + '%',
        volMillion: (parseFloat(t.quoteVolume) / 1e6).toFixed(2) + 'M',
        trades: parseInt(t.count, 10)
      }))
      .sort((a, b) => parseFloat(b.volMillion) - parseFloat(a.volMillion))
      .slice(0, limit);
  },

  // Sentiment & Derivative Indicators (L/S, OI, Taker)
  async getSentiment(symbol) {
    if (!symbol) {
      throw new Error('Symbol is required for sentiment analysis.');
    }
    const globalRatio = await httpRequest(`${FAPI_HOST}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
    const topRatio = await httpRequest(`${FAPI_HOST}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`);
    const takerRatio = await httpRequest(`${FAPI_HOST}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`);
    const oi = await httpRequest(`${FAPI_HOST}/fapi/v1/openInterest?symbol=${symbol}`);
    const funding = await httpRequest(`${FAPI_HOST}/fapi/v1/premiumIndex?symbol=${symbol}`);

    return {
      symbol,
      globalLongRatio: globalRatio[0] ? (parseFloat(globalRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      topTraderLongRatio: topRatio[0] ? (parseFloat(topRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      takerBuySellRatio: takerRatio[0] ? takerRatio[0].buySellRatio : null,
      openInterest: oi.openInterest,
      fundingRate: funding.lastFundingRate ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) + '%' : null
    };
  },

  // Open Algo Orders
  async getOpenAlgos(symbol) {
    const params = symbol ? { symbol } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openAlgoOrders', params);
  },

  // Open Standard Orders
  async getOpenOrders(symbol) {
    const params = symbol ? { symbol } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openOrders', params);
  },

  // Position Risk & Liquidation details
  async getPositionRisk(symbol) {
    const params = symbol ? { symbol } : {};
    const data = await signedReq(FAPI_HOST, '/fapi/v2/positionRisk', params);
    return Array.isArray(data) ? data.filter(p => parseFloat(p.positionAmt) !== 0) : data;
  },

  // User Trade History
  async getUserTrades(symbol, limit = 5) {
    if (!symbol) {
      throw new Error('Symbol is required to query trade history.');
    }
    return signedReq(FAPI_HOST, '/fapi/v1/userTrades', { symbol, limit: limit.toString() });
  },

  // Place standard order
  async placeOrder(params) {
    return signedReq(FAPI_HOST, '/fapi/v1/order', params, 'POST');
  },

  // Open contract position with MANDATORY Stop-Loss and Take-Profit
  async openPositionWithTPSL({ symbol, side, positionSide, quantity, type = 'MARKET', price, stopLossPrice, takeProfitPrice }) {
    if (!symbol) {
      throw new Error('【风控硬拦截】开仓必须指定交易对 (symbol)！');
    }
    if (!stopLossPrice) {
      throw new Error('【风控硬拦截】开仓必须指定硬止损价格 (stopLossPrice)，严禁裸奔开仓！');
    }
    if (!takeProfitPrice) {
      throw new Error('【风控硬拦截】开仓必须指定止盈价格 (takeProfitPrice)！');
    }
    // 1. Place entry order
    const entryParams = {
      symbol,
      side,
      positionSide: positionSide || (side === 'BUY' ? 'LONG' : 'SHORT'),
      type,
      quantity: quantity.toString()
    };
    if (type === 'LIMIT') {
      if (price) entryParams.price = price.toString();
      entryParams.timeInForce = 'GTC';
    }
    const entryRes = await signedReq(FAPI_HOST, '/fapi/v1/order', entryParams, 'POST');

    // 2. Automatically bind TP and SL
    const tpslRes = await this.setTPSL({
      symbol,
      positionSide: entryParams.positionSide,
      quantity,
      stopLossPrice,
      takeProfitPrice
    });

    return { entry: entryRes, tpsl: tpslRes };
  },

  // Cancel an Algo Order by ID
  async cancelAlgoOrder(algoId) {
    return signedReq(FAPI_HOST, '/fapi/v1/algoOrder', { algoId: algoId.toString() }, 'DELETE');
  },

  // Set Stop-Loss and Take-Profit for current position via Algo Order API
  async setTPSL({ symbol, positionSide = 'SHORT', quantity, stopLossPrice, takeProfitPrice, cancelExisting = true }) {
    if (!symbol) {
      throw new Error('Symbol is required for setTPSL');
    }
    const results = { cancelled: [] };
    if (cancelExisting) {
      const existing = await this.getOpenAlgos(symbol);
      if (Array.isArray(existing)) {
        for (const order of existing) {
          results.cancelled.push({ algoId: order.algoId, res: await this.cancelAlgoOrder(order.algoId) });
        }
      }
    }
    const baseParams = {
      algoType: 'CONDITIONAL',
      symbol,
      side: positionSide === 'SHORT' ? 'BUY' : 'SELL',
      positionSide
    };
    if (quantity) {
      baseParams.quantity = quantity.toString();
    } else {
      baseParams.closePosition = 'true';
    }

    if (stopLossPrice) {
      results.stopLoss = await signedReq(FAPI_HOST, '/fapi/v1/algoOrder', {
        ...baseParams,
        type: 'STOP_MARKET',
        triggerPrice: stopLossPrice.toString()
      }, 'POST');
    }
    if (takeProfitPrice) {
      results.takeProfit = await signedReq(FAPI_HOST, '/fapi/v1/algoOrder', {
        ...baseParams,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: takeProfitPrice.toString()
      }, 'POST');
    }
    return results;
  }
};

// 4. CLI Entry Point
async function cli() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'status':
        console.log(JSON.stringify(await Client.getStatus(), null, 2));
        break;
      case 'ticker':
        if (!args.length) {
          console.error('Usage: node scripts/binance_unified.js ticker <symbol1> [symbol2 ...]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getTickers(args.map(s => s.toUpperCase())), null, 2));
        break;
      case 'top-volume':
        console.log(JSON.stringify(await Client.getTopVolume(args[0] ? parseInt(args[0], 10) : 10), null, 2));
        break;
      case 'sentiment':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js sentiment <symbol>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getSentiment(args[0].toUpperCase()), null, 2));
        break;
      case 'open-algos':
        console.log(JSON.stringify(await Client.getOpenAlgos(args[0] ? args[0].toUpperCase() : undefined), null, 2));
        break;
      case 'open-orders':
        console.log(JSON.stringify(await Client.getOpenOrders(args[0] ? args[0].toUpperCase() : undefined), null, 2));
        break;
      case 'positions':
        console.log(JSON.stringify(await Client.getPositionRisk(args[0] ? args[0].toUpperCase() : undefined), null, 2));
        break;
      case 'set-tpsl':
        if (!args[0] || !args[1] || !args[2] || !args[3]) {
          console.error('Usage: node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.setTPSL({
          symbol: args[0].toUpperCase(),
          positionSide: args[1].toUpperCase(),
          stopLossPrice: args[2],
          takeProfitPrice: args[3],
          quantity: args[4]
        }), null, 2));
        break;
      case 'trades':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js trades <symbol> [limit]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getUserTrades(args[0].toUpperCase(), args[1] ? parseInt(args[1], 10) : 5), null, 2));
        break;
      case 'open-tpsl':
        if (!args[0] || !args[1] || !args[2] || !args[3] || !args[4] || !args[6] || !args[7]) {
          console.error('Usage: node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.openPositionWithTPSL({
          symbol: args[0].toUpperCase(),
          side: args[1].toUpperCase(),
          positionSide: args[2].toUpperCase(),
          quantity: args[3],
          type: args[4].toUpperCase(),
          price: args[5],
          stopLossPrice: args[6],
          takeProfitPrice: args[7]
        }), null, 2));
        break;
      default:
        console.log('Available commands: status, ticker <symbol1> [symbol2...], top-volume [limit], sentiment <symbol>, open-algos [symbol], open-orders [symbol], positions [symbol], set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty], trades <symbol> [limit], open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>');
    }
  } catch (err) {
    console.error('Execution error:', err.message);
  }
}

if (require.main === module) {
  cli();
}

module.exports = Client;
