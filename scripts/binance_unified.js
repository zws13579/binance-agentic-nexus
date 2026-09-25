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
 *   node scripts/binance_unified.js depth <symbol> [limit]
 *   node scripts/binance_unified.js klines <symbol> [interval] [limit]
 *   node scripts/binance_unified.js sentiment <symbol>
 *   node scripts/binance_unified.js open-orders [symbol]
 *   node scripts/binance_unified.js open-algos [symbol]
 *   node scripts/binance_unified.js positions [symbol]
 *   node scripts/binance_unified.js position-mode [true|false]
 *   node scripts/binance_unified.js leverage <symbol> <leverage>
 *   node scripts/binance_unified.js margin-type <symbol> <ISOLATED|CROSSED>
 *   node scripts/binance_unified.js trades <symbol> [limit]
 *   node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]
 *   node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> MARKET <slPrice> <tpPrice>
 *   node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> LIMIT <price> <slPrice> <tpPrice>
 *   node scripts/binance_unified.js close-position <symbol> [LONG|SHORT]
 *   node scripts/binance_unified.js cancel-order <symbol> <orderId>
 *   node scripts/binance_unified.js cancel-all <symbol>
 *   node scripts/binance_unified.js cancel-algo <algoId>
 *   node scripts/binance_unified.js cancel-all-algos <symbol>
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// 1. Configuration & Credentials
const envPath = path.resolve(__dirname, '..', '.env');
const fallbackEnvPath = path.resolve(process.cwd(), '.env');
const actualEnvPath = fs.existsSync(envPath) ? envPath : fallbackEnvPath;

const env = {};
if (fs.existsSync(actualEnvPath)) {
  fs.readFileSync(actualEnvPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const k = trimmed.slice(0, idx).trim();
      let v = trimmed.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[k] = v;
    }
  });
}

const API_KEY = env.BINANCE_API_KEY || process.env.BINANCE_API_KEY;
const SECRET_KEY = env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET_KEY;
const SPOT_HOST = 'https://api.binance.com';
const FAPI_HOST = 'https://fapi.binance.com';

let timeOffset = null;

// 2. Core Network & Signing (native fetch with auto timeout & retry)
async function httpRequest(url, method = 'GET', headers = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { method, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 429 || res.status === 418) {
        console.error(`[API 频率告警] HTTP ${res.status}: 触发币安接口频次限制`);
      }

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function syncTime() {
  if (timeOffset === null) {
    try {
      const res = await httpRequest(`${SPOT_HOST}/api/v3/time`);
      timeOffset = res && res.serverTime ? res.serverTime - Date.now() : 0;
    } catch {
      timeOffset = 0;
    }
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
  let res = await httpRequest(fullUrl, method, { 'X-MBX-APIKEY': API_KEY });

  // Auto-recover from timestamp drift (-1021)
  if (res && res.code === -1021) {
    timeOffset = null;
    await syncTime();
    const retryTs = Date.now() + timeOffset;
    const retryQp = new URLSearchParams({ ...params, timestamp: retryTs.toString(), recvWindow: '10000' });
    const retryQs = retryQp.toString();
    const retrySig = sign(retryQs);
    const retryUrl = `${host}${endpoint}?${retryQs}&signature=${retrySig}`;
    res = await httpRequest(retryUrl, method, { 'X-MBX-APIKEY': API_KEY });
  }

  return res;
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
    const cleanSymbols = symbols.map(s => s.toUpperCase().trim());
    const data = await httpRequest(`${SPOT_HOST}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(cleanSymbols))}`);
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

  // Orderbook Depth & Microstructure (Spot & Futures)
  async getDepth(symbol, limit = 20) {
    if (!symbol) throw new Error('Symbol is required for depth analysis.');
    const cleanSymbol = symbol.toUpperCase().trim();
    const [spotRes, futRes] = await Promise.all([
      httpRequest(`${SPOT_HOST}/api/v3/depth?symbol=${cleanSymbol}&limit=${limit}`),
      httpRequest(`${FAPI_HOST}/fapi/v1/depth?symbol=${cleanSymbol}&limit=${limit}`)
    ]);

    const calcDepth = (data) => {
      if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
        return { error: data && data.msg ? data.msg : 'Invalid depth response' };
      }
      const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : 0;
      const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : 0;
      const totalBidsQty = data.bids.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
      const totalAsksQty = data.asks.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
      const spread = bestAsk > 0 ? (bestAsk - bestBid).toFixed(4) : 0;
      const ratio = totalAsksQty > 0 ? (totalBidsQty / totalAsksQty).toFixed(2) : 'N/A';
      return {
        bestBid,
        bestAsk,
        spread,
        totalBidsQty: parseFloat(totalBidsQty.toFixed(4)),
        totalAsksQty: parseFloat(totalAsksQty.toFixed(4)),
        bidAskRatio: ratio,
        top5Bids: data.bids.slice(0, 5),
        top5Asks: data.asks.slice(0, 5)
      };
    };

    return {
      symbol: cleanSymbol,
      spot: calcDepth(spotRes),
      futures: calcDepth(futRes)
    };
  },

  // Candlestick K-Lines (Futures)
  async getKlines(symbol, interval = '1h', limit = 10) {
    if (!symbol) throw new Error('Symbol is required for klines.');
    const cleanSymbol = symbol.toUpperCase().trim();
    const data = await httpRequest(`${FAPI_HOST}/fapi/v1/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`);
    if (!Array.isArray(data)) return data;
    return data.map(c => ({
      time: new Date(c[0]).toISOString().replace('T', ' ').slice(0, 19),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(parseFloat(c[5]).toFixed(2))
    }));
  },

  // Sentiment & Derivative Indicators (L/S, OI, Taker)
  async getSentiment(symbol) {
    if (!symbol) {
      throw new Error('Symbol is required for sentiment analysis.');
    }
    const cleanSymbol = symbol.toUpperCase().trim();
    const globalRatio = await httpRequest(`${FAPI_HOST}/futures/data/globalLongShortAccountRatio?symbol=${cleanSymbol}&period=1h&limit=1`);
    const topRatio = await httpRequest(`${FAPI_HOST}/futures/data/topLongShortPositionRatio?symbol=${cleanSymbol}&period=1h&limit=1`);
    const takerRatio = await httpRequest(`${FAPI_HOST}/futures/data/takerlongshortRatio?symbol=${cleanSymbol}&period=1h&limit=1`);
    const oi = await httpRequest(`${FAPI_HOST}/fapi/v1/openInterest?symbol=${cleanSymbol}`);
    const funding = await httpRequest(`${FAPI_HOST}/fapi/v1/premiumIndex?symbol=${cleanSymbol}`);

    return {
      symbol: cleanSymbol,
      globalLongRatio: globalRatio[0] ? (parseFloat(globalRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      topTraderLongRatio: topRatio[0] ? (parseFloat(topRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      takerBuySellRatio: takerRatio[0] ? takerRatio[0].buySellRatio : null,
      openInterest: oi.openInterest,
      fundingRate: funding.lastFundingRate ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) + '%' : null
    };
  },

  // Open Algo Orders
  async getOpenAlgos(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openAlgoOrders', params);
  },

  // Open Standard Orders
  async getOpenOrders(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openOrders', params);
  },

  // Position Risk & Liquidation details
  async getPositionRisk(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    const data = await signedReq(FAPI_HOST, '/fapi/v2/positionRisk', params);
    if (!Array.isArray(data)) return data;
    return data
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedProfit: p.unRealizedProfit,
        liquidationPrice: p.liquidationPrice,
        leverage: p.leverage,
        marginType: p.marginType
      }));
  },

  // Dual Position Mode (Hedge Mode: dualSidePosition = true; One-way: false)
  async getPositionMode() {
    return signedReq(FAPI_HOST, '/fapi/v1/positionSide/dual');
  },

  async setPositionMode(dualSide) {
    const dualSidePosition = (dualSide === true || dualSide === 'true') ? 'true' : 'false';
    return signedReq(FAPI_HOST, '/fapi/v1/positionSide/dual', { dualSidePosition }, 'POST');
  },

  // Set Leverage
  async setLeverage(symbol, leverage) {
    if (!symbol || !leverage) throw new Error('Symbol and leverage are required.');
    return signedReq(FAPI_HOST, '/fapi/v1/leverage', { symbol: symbol.toUpperCase().trim(), leverage: leverage.toString() }, 'POST');
  },

  // Set Margin Type (ISOLATED / CROSSED)
  async setMarginType(symbol, marginType) {
    if (!symbol || !marginType) throw new Error('Symbol and marginType (ISOLATED|CROSSED) are required.');
    return signedReq(FAPI_HOST, '/fapi/v1/marginType', { symbol: symbol.toUpperCase().trim(), marginType: marginType.toUpperCase() }, 'POST');
  },

  // User Trade History
  async getUserTrades(symbol, limit = 5) {
    if (!symbol) {
      throw new Error('Symbol is required to query trade history.');
    }
    const data = await signedReq(FAPI_HOST, '/fapi/v1/userTrades', { symbol: symbol.toUpperCase().trim(), limit: limit.toString() });
    if (!Array.isArray(data)) return data;
    return data.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      positionSide: t.positionSide,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission),
      commissionAsset: t.commissionAsset,
      time: new Date(t.time).toISOString().replace('T', ' ').slice(0, 19)
    }));
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

    const cleanSymbol = symbol.toUpperCase().trim();
    const cleanSide = side.toUpperCase().trim();
    const cleanPosSide = positionSide ? positionSide.toUpperCase().trim() : (cleanSide === 'BUY' ? 'LONG' : 'SHORT');

    // 1. Place entry order
    const entryParams = {
      symbol: cleanSymbol,
      side: cleanSide,
      positionSide: cleanPosSide,
      type,
      quantity: quantity.toString()
    };
    if (type === 'LIMIT') {
      if (!price) throw new Error('【风控拦截】LIMIT 委托必须提供委托价格 (price)！');
      entryParams.price = price.toString();
      entryParams.timeInForce = 'GTC';
    }

    const entryRes = await signedReq(FAPI_HOST, '/fapi/v1/order', entryParams, 'POST');
    if (entryRes && entryRes.code && entryRes.code < 0) {
      throw new Error(`【开仓委托失败】Binance API 报错: [${entryRes.code}] ${entryRes.msg}`);
    }

    // 2. Automatically bind TP and SL
    const tpslRes = await this.setTPSL({
      symbol: cleanSymbol,
      positionSide: cleanPosSide,
      quantity,
      stopLossPrice,
      takeProfitPrice
    });

    return { entry: entryRes, tpsl: tpslRes };
  },

  // Close Position with MARKET Order and automatically clean up open TP/SL algo orders
  async closePosition(symbol, positionSide) {
    if (!symbol) throw new Error('Symbol is required to close position.');
    const cleanSymbol = symbol.toUpperCase().trim();
    const positions = await this.getPositionRisk(cleanSymbol);
    if (!Array.isArray(positions) || positions.length === 0) {
      return { message: `No active positions found for ${cleanSymbol}.` };
    }

    const targetPos = positionSide
      ? positions.find(p => p.positionSide === positionSide.toUpperCase().trim())
      : positions[0];

    if (!targetPos) {
      return { message: `No matching position for ${cleanSymbol} with positionSide=${positionSide}` };
    }

    const amt = Math.abs(parseFloat(targetPos.positionAmt));
    const closeSide = parseFloat(targetPos.positionAmt) > 0 ? 'SELL' : 'BUY';

    // 1. Execute market close
    const closeRes = await signedReq(FAPI_HOST, '/fapi/v1/order', {
      symbol: cleanSymbol,
      side: closeSide,
      positionSide: targetPos.positionSide,
      type: 'MARKET',
      quantity: amt.toString(),
      reduceOnly: 'true'
    }, 'POST');

    // 2. Clear remaining algo orders (TP/SL)
    const cancelledAlgos = await this.cancelAllAlgoOrders(cleanSymbol);

    return {
      closeOrder: closeRes,
      cancelledAlgos
    };
  },

  // Cancel standard order by symbol and orderId
  async cancelOrder(symbol, orderId) {
    if (!symbol || !orderId) throw new Error('Symbol and orderId are required to cancel order.');
    return signedReq(FAPI_HOST, '/fapi/v1/order', { symbol: symbol.toUpperCase().trim(), orderId: orderId.toString() }, 'DELETE');
  },

  // Cancel all open standard orders for a symbol
  async cancelAllOrders(symbol) {
    if (!symbol) throw new Error('Symbol is required to cancel all orders.');
    return signedReq(FAPI_HOST, '/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase().trim() }, 'DELETE');
  },

  // Cancel an Algo Order by ID
  async cancelAlgoOrder(algoId) {
    return signedReq(FAPI_HOST, '/fapi/v1/algoOrder', { algoId: algoId.toString() }, 'DELETE');
  },

  // Cancel all open algo orders for a symbol
  async cancelAllAlgoOrders(symbol) {
    const cleanSymbol = symbol.toUpperCase().trim();
    const algos = await this.getOpenAlgos(cleanSymbol);
    const results = [];
    if (Array.isArray(algos)) {
      for (const a of algos) {
        results.push(await this.cancelAlgoOrder(a.algoId));
      }
    }
    return results;
  },

  // Set Stop-Loss and Take-Profit for current position via Algo Order API
  async setTPSL({ symbol, positionSide = 'LONG', quantity, stopLossPrice, takeProfitPrice, cancelExisting = true }) {
    if (!symbol) {
      throw new Error('Symbol is required for setTPSL');
    }
    const cleanSymbol = symbol.toUpperCase().trim();
    const cleanPosSide = positionSide.toUpperCase().trim();
    const results = { cancelled: [] };

    if (cancelExisting) {
      const existing = await this.getOpenAlgos(cleanSymbol);
      if (Array.isArray(existing)) {
        for (const order of existing) {
          results.cancelled.push({ algoId: order.algoId, res: await this.cancelAlgoOrder(order.algoId) });
        }
      }
    }
    const baseParams = {
      algoType: 'CONDITIONAL',
      symbol: cleanSymbol,
      side: cleanPosSide === 'SHORT' ? 'BUY' : 'SELL',
      positionSide: cleanPosSide
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
        console.log(JSON.stringify(await Client.getTickers(args), null, 2));
        break;

      case 'top-volume':
        console.log(JSON.stringify(await Client.getTopVolume(args[0] ? parseInt(args[0], 10) : 10), null, 2));
        break;

      case 'depth':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js depth <symbol> [limit]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getDepth(args[0], args[1] ? parseInt(args[1], 10) : 20), null, 2));
        break;

      case 'klines':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js klines <symbol> [interval] [limit]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getKlines(args[0], args[1] || '1h', args[2] ? parseInt(args[2], 10) : 10), null, 2));
        break;

      case 'sentiment':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js sentiment <symbol>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.getSentiment(args[0]), null, 2));
        break;

      case 'open-algos':
        console.log(JSON.stringify(await Client.getOpenAlgos(args[0] || undefined), null, 2));
        break;

      case 'open-orders':
        console.log(JSON.stringify(await Client.getOpenOrders(args[0] || undefined), null, 2));
        break;

      case 'positions':
        console.log(JSON.stringify(await Client.getPositionRisk(args[0] || undefined), null, 2));
        break;

      case 'position-mode':
        if (args[0] === undefined) {
          console.log(JSON.stringify(await Client.getPositionMode(), null, 2));
        } else {
          console.log(JSON.stringify(await Client.setPositionMode(args[0]), null, 2));
        }
        break;

      case 'leverage':
        if (!args[0] || !args[1]) {
          console.error('Usage: node scripts/binance_unified.js leverage <symbol> <leverage>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.setLeverage(args[0], args[1]), null, 2));
        break;

      case 'margin-type':
        if (!args[0] || !args[1]) {
          console.error('Usage: node scripts/binance_unified.js margin-type <symbol> <ISOLATED|CROSSED>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.setMarginType(args[0], args[1]), null, 2));
        break;

      case 'set-tpsl':
        if (!args[0] || !args[1] || !args[2] || !args[3]) {
          console.error('Usage: node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.setTPSL({
          symbol: args[0],
          positionSide: args[1],
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
        console.log(JSON.stringify(await Client.getUserTrades(args[0], args[1] ? parseInt(args[1], 10) : 5), null, 2));
        break;

      case 'open-tpsl': {
        const symbol = args[0] ? args[0].toUpperCase() : null;
        const side = args[1] ? args[1].toUpperCase() : null;
        const positionSide = args[2] ? args[2].toUpperCase() : null;
        const quantity = args[3];
        const type = args[4] ? args[4].toUpperCase() : null;

        if (!symbol || !side || !positionSide || !quantity || !type) {
          console.error('Usage:\n  MARKET: node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> MARKET <slPrice> <tpPrice>\n  LIMIT:  node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> LIMIT <price> <slPrice> <tpPrice>');
          process.exit(1);
        }

        let price = undefined;
        let slPrice = undefined;
        let tpPrice = undefined;

        if (type === 'MARKET') {
          if (args.length === 7) {
            slPrice = args[5];
            tpPrice = args[6];
          } else if (args.length >= 8) {
            slPrice = args[6];
            tpPrice = args[7];
          } else {
            console.error('Error: MARKET orders require <slPrice> and <tpPrice>.');
            process.exit(1);
          }
        } else if (type === 'LIMIT') {
          if (args.length < 8) {
            console.error('Error: LIMIT orders require <price>, <slPrice> and <tpPrice>.');
            process.exit(1);
          }
          price = args[5];
          slPrice = args[6];
          tpPrice = args[7];
        } else {
          console.error('Error: Unsupported order type. Use MARKET or LIMIT.');
          process.exit(1);
        }

        console.log(JSON.stringify(await Client.openPositionWithTPSL({
          symbol,
          side,
          positionSide,
          quantity,
          type,
          price,
          stopLossPrice: slPrice,
          takeProfitPrice: tpPrice
        }), null, 2));
        break;
      }

      case 'close-position':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js close-position <symbol> [LONG|SHORT]');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.closePosition(args[0], args[1] || undefined), null, 2));
        break;

      case 'cancel-order':
        if (!args[0] || !args[1]) {
          console.error('Usage: node scripts/binance_unified.js cancel-order <symbol> <orderId>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.cancelOrder(args[0], args[1]), null, 2));
        break;

      case 'cancel-all':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js cancel-all <symbol>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.cancelAllOrders(args[0]), null, 2));
        break;

      case 'cancel-algo':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js cancel-algo <algoId>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.cancelAlgoOrder(args[0]), null, 2));
        break;

      case 'cancel-all-algos':
        if (!args[0]) {
          console.error('Usage: node scripts/binance_unified.js cancel-all-algos <symbol>');
          process.exit(1);
        }
        console.log(JSON.stringify(await Client.cancelAllAlgoOrders(args[0]), null, 2));
        break;

      case 'help':
      case '--help':
      case '-h':
      default:
        console.log(`Unified Binance CEX/Futures CLI

Usage: node scripts/binance_unified.js <command> [arguments...]

[Account & Portfolio]
  status                                                                            - Overview of Spot, Futures, and Earn balances
  positions [symbol]                                                               - Active contract positions, PnL, leverage
  trades <symbol> [limit]                                                          - Formatted user trade history
  position-mode [true|false]                                                       - Query or set dual/hedge position mode

[Market Data & Microstructure]
  ticker <s1> [s2...]                                                              - Query 24h ticker prices and stats
  top-volume [limit]                                                               - Top volume USDT pairs
  depth <symbol> [limit]                                                           - Spot & Futures orderbook depth, bid/ask ratio
  klines <symbol> [interval] [limit]                                               - Candlesticks (OHLCV)
  sentiment <symbol>                                                               - Global/Top trader L/S ratio, OI, funding rate

[Trading & Risk Management]
  leverage <symbol> <leverage>                                                     - Set leverage (1-125)
  margin-type <symbol> <ISOLATED|CROSSED>                                          - Set margin type
  set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]                        - Bind TP/SL to an existing position
  open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> MARKET <slPrice> <tpPrice>      - Market entry with atomic TP/SL
  open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> LIMIT <price> <slPrice> <tpPrice> - Limit entry with atomic TP/SL
  close-position <symbol> [LONG|SHORT]                                             - Market close position and clear TP/SL algos

[Order Management]
  open-orders [symbol]                                                             - Query pending standard orders
  open-algos [symbol]                                                              - Query pending algo/conditional orders
  cancel-order <symbol> <orderId>                                                  - Cancel standard order by ID
  cancel-all <symbol>                                                              - Cancel all open standard orders
  cancel-algo <algoId>                                                             - Cancel algo order by ID
  cancel-all-algos <symbol>                                                        - Cancel all open algo orders`);
        if (cmd && !['help', '--help', '-h'].includes(cmd)) {
          process.exit(1);
        }
    }
  } catch (err) {
    console.error('Execution error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  cli();
}

module.exports = Client;
