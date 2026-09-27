/**
 * Unified Binance CEX/Futures CLI & Library
 * Location: scripts/binance_unified.js
 *
 * Industrial 4-layer architecture:
 * 1. Base Communication, Signing & Adaptive Rate Limiter (Weight Backpressure)
 * 2. Data Normalization (normalizeOrder)
 * 3. Business Workflows & State Machines (TransactionContext, Chained TP/SL, Rollback)
 * 4. Table-Driven CLI Dispatcher (declarative metadata)
 *
 * Network: Node.js native fetch(). In TUN mode, works directly.
 * In port-proxy mode: node --import ./scripts/proxy_bootstrap.mjs scripts/binance_unified.js ...
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ============================================================================
// 1. Configuration, Credentials & Error Types
// ============================================================================
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
      if (!process.env[k]) process.env[k] = v;
    }
  });
}

const API_KEY = env.BINANCE_API_KEY || process.env.BINANCE_API_KEY;
const SECRET_KEY = env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET_KEY;
const SPOT_HOST = 'https://api.binance.com';
const FAPI_HOST = 'https://fapi.binance.com';

let timeOffset = null;

// Structured Error Type (Categorized by failure domain)
class BinanceError extends Error {
  constructor(message, { code = null, type = 'UNKNOWN', retryable = false } = {}) {
    super(message);
    this.name = 'BinanceError';
    this.code = code;
    this.type = type; // 'NETWORK' | 'RATE_LIMIT' | 'AUTH' | 'MARGIN' | 'PARAMS' | 'AMBIGUOUS_STATE' | 'API_ERROR'
    this.retryable = retryable;
  }
}

// In-Flight Transaction Context
class TransactionContext {
  constructor(prefix = 'BAN') {
    const id = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 28);
    this.correlationId = id;
    this.entryClientOrderId = `${id}_ENT`;
    this.slClientOrderId = `${id}_SL`;
    this.tpClientOrderId = `${id}_TP`;
    this.stage = 'INITIALIZED';
  }
}

function generateClientOrderId(prefix = 'BAN') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// Output Normalizer for Orders
function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const executed = parseFloat(raw.executedQty || '0');
  const cumQuote = parseFloat(raw.cumQuote || '0');
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    status: raw.status,
    side: raw.side,
    positionSide: raw.positionSide,
    origQty: parseFloat(raw.origQty || '0'),
    executedQty: executed,
    avgPrice: executed > 0 && cumQuote > 0 ? (cumQuote / executed).toFixed(4) : (raw.avgPrice || raw.price || '0'),
    updateTime: raw.updateTime || Date.now()
  };
}

// ============================================================================
// 2. Core Network, Time Sync & Adaptive Rate Limiter
// ============================================================================
async function httpRequest(url, method = 'GET', headers = {}, retries = undefined) {
  const maxRetries = (retries !== undefined) ? retries : (method === 'GET' ? 2 : 0);

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(10000) });

      // Adaptive Rate Limiter Backpressure (Sniff x-mbx-used-weight-1m)
      const usedWeight = res.headers ? res.headers.get('x-mbx-used-weight-1m') : null;
      if (usedWeight && parseInt(usedWeight, 10) > 1050) {
        console.warn(`[⚠️ 频次水位高危] Binance 1m 权重已达 ${usedWeight}/1200，触发自适应微冷却 200ms`);
        await new Promise(r => setTimeout(r, 200));
      }

      if (res.status === 429 || res.status === 418) {
        const retryAfter = res.headers ? parseInt(res.headers.get('Retry-After') || '60', 10) : 60;
        console.error(`[API 频率告警] HTTP ${res.status}: 触发币安接口频次限制, Retry-After: ${retryAfter}s`);
        throw new BinanceError(`触发币安接口限频 HTTP ${res.status}，需冷却 ${retryAfter}s`, {
          code: res.status,
          type: 'RATE_LIMIT',
          retryable: true
        });
      }

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (err instanceof BinanceError && !err.retryable) throw err;
      if (i === maxRetries) throw err;
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

async function signedReq(host, endpoint, params = {}, method = 'GET', retries = undefined) {
  await syncTime();
  const ts = Date.now() + timeOffset;
  const qp = new URLSearchParams({ ...params, timestamp: ts.toString(), recvWindow: '10000' });
  const qs = qp.toString();
  const sig = sign(qs);
  const fullUrl = `${host}${endpoint}?${qs}&signature=${sig}`;
  let res = await httpRequest(fullUrl, method, { 'X-MBX-APIKEY': API_KEY }, retries);

  // Auto-recover from timestamp drift (-1021)
  if (res && res.code === -1021) {
    timeOffset = null;
    await syncTime();
    const retryTs = Date.now() + timeOffset;
    const retryQp = new URLSearchParams({ ...params, timestamp: retryTs.toString(), recvWindow: '10000' });
    const retryQs = retryQp.toString();
    const retrySig = sign(retryQs);
    const retryUrl = `${host}${endpoint}?${retryQs}&signature=${retrySig}`;
    res = await httpRequest(retryUrl, method, { 'X-MBX-APIKEY': API_KEY }, retries);
  }

  return res;
}

// ============================================================================
// 3. Private Domain Helpers (Order Validation & Rollback Machine)
// ============================================================================
function _validatePriceBounds(posSide, refPrice, sl, tp) {
  if (!refPrice) return;
  if (posSide === 'LONG') {
    if (sl >= refPrice) throw new BinanceError(`【价格逻辑防呆拦截】多单止损价 ($${sl}) 不能大于或等于参考价格 ($${refPrice})！`, { type: 'PARAMS' });
    if (tp <= refPrice) throw new BinanceError(`【价格逻辑防呆拦截】多单止盈价 ($${tp}) 不能小于或等于参考价格 ($${refPrice})！`, { type: 'PARAMS' });
  } else if (posSide === 'SHORT') {
    if (sl <= refPrice) throw new BinanceError(`【价格逻辑防呆拦截】空单止损价 ($${sl}) 不能小于或等于参考价格 ($${refPrice})！`, { type: 'PARAMS' });
    if (tp >= refPrice) throw new BinanceError(`【价格逻辑防呆拦截】空单止盈价 ($${tp}) 不能大于或等于参考价格 ($${refPrice})！`, { type: 'PARAMS' });
  }
}

async function _executeRollback(client, { cleanSymbol, cleanPosSide, type, entryRes, quantity, tpslErr }) {
  console.error(`【严重风控报警】入场单已提交，但保护单挂载失败 (${tpslErr.message})，立即启动补偿回滚！`);

  if (type === 'LIMIT' && entryRes && entryRes.orderId) {
    let orderState = null;
    try {
      orderState = await client.getOrder(cleanSymbol, { orderId: entryRes.orderId });
    } catch {
      orderState = null;
    }

    const status = orderState ? orderState.status : 'UNKNOWN';
    const executedQty = orderState && orderState.executedQty ? parseFloat(orderState.executedQty) : 0;

    if (status === 'FILLED' || executedQty >= parseFloat(quantity)) {
      try {
        const rollbackClose = await client.closePosition(cleanSymbol, cleanPosSide);
        return {
          entrySucceeded: true, tpslSucceeded: false, rollbackSucceeded: true,
          action: 'POSITION_EMERGENCY_CLOSED', orderStatus: status, executedQty,
          error: tpslErr.message, rollbackClose
        };
      } catch (closeErr) {
        throw new BinanceError(`【穿仓风险/紧急告警】限价单已全成但保护单失败，且市价紧急平仓失败: ${closeErr.message}。请立刻人工接管！`, { type: 'AMBIGUOUS_STATE' });
      }
    } else if (status === 'PARTIALLY_FILLED' || executedQty > 0) {
      await client.cancelOrder(cleanSymbol, entryRes.orderId).catch(() => {});
      try {
        const rollbackClose = await client.closePosition(cleanSymbol, cleanPosSide);
        return {
          entrySucceeded: true, tpslSucceeded: false, rollbackSucceeded: true,
          action: 'PARTIAL_POSITION_CLOSED', orderStatus: status, executedQty,
          error: tpslErr.message, rollbackClose
        };
      } catch (closeErr) {
        throw new BinanceError(`【穿仓风险/紧急告警】限价单部分成交但保护单挂载失败，且紧急平仓失败: ${closeErr.message}。请立刻人工接管！`, { type: 'AMBIGUOUS_STATE' });
      }
    } else {
      try {
        const cancelRes = await client.cancelOrder(cleanSymbol, entryRes.orderId);
        return {
          entrySucceeded: true, tpslSucceeded: false, rollbackSucceeded: true,
          action: 'LIMIT_ORDER_CANCELLED', orderStatus: status, error: tpslErr.message, cancelRes
        };
      } catch (cErr) {
        throw new BinanceError(`【双重失败】TP/SL 失败且撤回入场挂单失败: ${cErr.message}。请立刻人工检查订单！`, { type: 'AMBIGUOUS_STATE' });
      }
    }
  } else {
    // MARKET order emergency close
    try {
      const rollbackClose = await client.closePosition(cleanSymbol, cleanPosSide);
      return {
        entrySucceeded: true, tpslSucceeded: false, rollbackSucceeded: true,
        action: 'POSITION_EMERGENCY_CLOSED', error: tpslErr.message, rollbackClose
      };
    } catch (closeErr) {
      throw new BinanceError(`【穿仓风险/紧急告警】市价开仓后保护单挂载失败，且紧急平仓失败: ${closeErr.message}。请立即人工接管！`, { type: 'AMBIGUOUS_STATE' });
    }
  }
}

// ============================================================================
// 4. Consolidated Client Methods
// ============================================================================
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
      throw new BinanceError('Symbols list is required. Example: Client.getTickers(["BTCUSDT", "ETHUSDT"])', { type: 'PARAMS' });
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

  // Orderbook Depth (Spot & Futures)
  async getDepth(symbol, limit = 20) {
    if (!symbol) throw new BinanceError('Symbol is required for depth analysis.', { type: 'PARAMS' });
    const cleanSymbol = symbol.toUpperCase().trim();
    const validFutLimits = [5, 10, 20, 50, 100, 500, 1000];
    const futLimit = validFutLimits.find(l => l >= limit) || 20;

    const [spotRes, futRes] = await Promise.all([
      httpRequest(`${SPOT_HOST}/api/v3/depth?symbol=${cleanSymbol}&limit=${limit}`),
      httpRequest(`${FAPI_HOST}/fapi/v1/depth?symbol=${cleanSymbol}&limit=${futLimit}`)
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
        bestBid, bestAsk, spread,
        totalBidsQty: parseFloat(totalBidsQty.toFixed(4)),
        totalAsksQty: parseFloat(totalAsksQty.toFixed(4)),
        bidAskRatio: ratio,
        top5Bids: data.bids.slice(0, 5),
        top5Asks: data.asks.slice(0, 5)
      };
    };

    return { symbol: cleanSymbol, spot: calcDepth(spotRes), futures: calcDepth(futRes) };
  },

  // Candlestick K-Lines (Futures)
  async getKlines(symbol, interval = '1h', limit = 10) {
    if (!symbol) throw new BinanceError('Symbol is required for klines.', { type: 'PARAMS' });
    const cleanSymbol = symbol.toUpperCase().trim();
    const data = await httpRequest(`${FAPI_HOST}/fapi/v1/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`);
    if (!Array.isArray(data)) return data;
    return data.map(c => ({
      time: new Date(c[0]).toISOString().replace('T', ' ').slice(0, 19),
      open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]),
      volume: parseFloat(parseFloat(c[5]).toFixed(2))
    }));
  },

  // Sentiment & Derivative Indicators (L/S, OI, Taker)
  async getSentiment(symbol) {
    if (!symbol) throw new BinanceError('Symbol is required for sentiment analysis.', { type: 'PARAMS' });
    const cleanSymbol = symbol.toUpperCase().trim();
    const [globalRatio, topRatio, takerRatio, oi, funding] = await Promise.all([
      httpRequest(`${FAPI_HOST}/futures/data/globalLongShortAccountRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/futures/data/topLongShortPositionRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/futures/data/takerlongshortRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/fapi/v1/openInterest?symbol=${cleanSymbol}`),
      httpRequest(`${FAPI_HOST}/fapi/v1/premiumIndex?symbol=${cleanSymbol}`)
    ]);

    return {
      symbol: cleanSymbol,
      globalLongRatio: globalRatio[0] ? (parseFloat(globalRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      topTraderLongRatio: topRatio[0] ? (parseFloat(topRatio[0].longAccount) * 100).toFixed(1) + '%' : null,
      takerBuySellRatio: takerRatio[0] ? takerRatio[0].buySellRatio : null,
      openInterest: oi.openInterest,
      fundingRate: funding.lastFundingRate ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) + '%' : null
    };
  },

  async getOpenAlgos(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openAlgoOrders', params);
  },

  async getOpenOrders(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return signedReq(FAPI_HOST, '/fapi/v1/openOrders', params);
  },

  async getPositionRisk(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    const data = await signedReq(FAPI_HOST, '/fapi/v2/positionRisk', params);
    if (!Array.isArray(data)) return data;
    return data
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol, positionSide: p.positionSide, positionAmt: p.positionAmt,
        entryPrice: p.entryPrice, markPrice: p.markPrice, unrealizedProfit: p.unRealizedProfit,
        liquidationPrice: p.liquidationPrice, leverage: p.leverage, marginType: p.marginType
      }));
  },

  async getPositionMode() {
    return signedReq(FAPI_HOST, '/fapi/v1/positionSide/dual');
  },

  async setPositionMode(dualSide) {
    if (typeof dualSide !== 'boolean' && dualSide !== 'true' && dualSide !== 'false') {
      throw new BinanceError(`【参数校验拦截】setPositionMode 仅接受 true 或 false，收到非法参数: "${dualSide}"`, { type: 'PARAMS' });
    }
    const dualSidePosition = (dualSide === true || dualSide === 'true') ? 'true' : 'false';
    return signedReq(FAPI_HOST, '/fapi/v1/positionSide/dual', { dualSidePosition }, 'POST');
  },

  async setLeverage(symbol, leverage) {
    if (!symbol || !leverage) throw new BinanceError('Symbol and leverage are required.', { type: 'PARAMS' });
    return signedReq(FAPI_HOST, '/fapi/v1/leverage', { symbol: symbol.toUpperCase().trim(), leverage: leverage.toString() }, 'POST');
  },

  async setMarginType(symbol, marginType) {
    if (!symbol || !marginType) throw new BinanceError('Symbol and marginType (ISOLATED|CROSSED) are required.', { type: 'PARAMS' });
    return signedReq(FAPI_HOST, '/fapi/v1/marginType', { symbol: symbol.toUpperCase().trim(), marginType: marginType.toUpperCase() }, 'POST');
  },

  async getUserTrades(symbol, limit = 5) {
    if (!symbol) throw new BinanceError('Symbol is required to query trade history.', { type: 'PARAMS' });
    const data = await signedReq(FAPI_HOST, '/fapi/v1/userTrades', { symbol: symbol.toUpperCase().trim(), limit: limit.toString() });
    if (!Array.isArray(data)) return data;
    return data.map(t => ({
      id: t.id, symbol: t.symbol, side: t.side, positionSide: t.positionSide,
      price: parseFloat(t.price), qty: parseFloat(t.qty), realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission), commissionAsset: t.commissionAsset,
      time: new Date(t.time).toISOString().replace('T', ' ').slice(0, 19)
    }));
  },

  async getOrder(symbol, { orderId, origClientOrderId } = {}) {
    if (!symbol) throw new BinanceError('Symbol is required for getOrder', { type: 'PARAMS' });
    const params = { symbol: symbol.toUpperCase().trim() };
    if (orderId) params.orderId = orderId.toString();
    if (origClientOrderId) params.origClientOrderId = origClientOrderId.toString();
    const res = await signedReq(FAPI_HOST, '/fapi/v1/order', params, 'GET');
    return normalizeOrder(res);
  },

  async placeOrder(params) {
    const orderParams = { ...params };
    if (!orderParams.newClientOrderId) {
      orderParams.newClientOrderId = generateClientOrderId('BAN_ORD');
    }
    const res = await signedReq(FAPI_HOST, '/fapi/v1/order', orderParams, 'POST');
    return normalizeOrder(res);
  },

  // Open position with chained TP/SL, Lifecycle Correlation ID, and Idempotent State Recovery
  async openPositionWithTPSL({ symbol, side, positionSide, quantity, type = 'MARKET', price, stopLossPrice, takeProfitPrice, clientOrderId }) {
    if (!symbol || !positionSide || !stopLossPrice || !takeProfitPrice) {
      throw new BinanceError('【风控硬拦截】开仓必须指定 symbol、positionSide (LONG|SHORT)、stopLossPrice 与 takeProfitPrice！', { type: 'PARAMS' });
    }

    const cleanSymbol = symbol.toUpperCase().trim();
    const cleanSide = side.toUpperCase().trim();
    const cleanPosSide = positionSide.toUpperCase().trim();
    const sl = parseFloat(stopLossPrice);
    const tp = parseFloat(takeProfitPrice);

    // 1. Pre-trade Price Direction Validation
    let refPrice = price ? parseFloat(price) : null;
    if (!refPrice) {
      try {
        const ticker = await httpRequest(`${FAPI_HOST}/fapi/v1/ticker/price?symbol=${cleanSymbol}`);
        refPrice = ticker && ticker.price ? parseFloat(ticker.price) : null;
      } catch (err) {
        console.warn(`[Warning] 无法获取 ${cleanSymbol} 实时价格用于事前防呆校验: ${err.message}`);
      }
    }
    _validatePriceBounds(cleanPosSide, refPrice, sl, tp);

    // 2. Transaction Context & Entry Order
    const tx = new TransactionContext(clientOrderId || 'BAN');
    const entryParams = {
      symbol: cleanSymbol,
      side: cleanSide,
      positionSide: cleanPosSide,
      type,
      quantity: quantity.toString(),
      newClientOrderId: tx.entryClientOrderId
    };
    if (type === 'LIMIT') {
      if (!price) throw new BinanceError('【风控拦截】LIMIT 委托必须提供委托价格 (price)！', { type: 'PARAMS' });
      entryParams.price = price.toString();
      entryParams.timeInForce = 'GTC';
    }

    let entryRes;
    try {
      entryRes = await this.placeOrder(entryParams);
      if (entryRes && entryRes.code && entryRes.code < 0) {
        throw new BinanceError(`Binance API 报错: [${entryRes.code}] ${entryRes.msg}`, { code: entryRes.code, type: 'API_ERROR' });
      }
      tx.stage = 'ENTRY_SENT';
    } catch (err) {
      // 3. Network Ambiguity State Recovery (状态不明只查不重试)
      const isNetworkAmbiguous = err.name === 'AbortError' ||
                                 err.message.includes('fetch failed') ||
                                 err.message.includes('ETIMEDOUT') ||
                                 err.message.includes('ECONNRESET');

      if (isNetworkAmbiguous) {
        console.warn(`[⚠️ 网络抖动] 入场单请求超时/未决，执行状态不明只查不重试: ${tx.entryClientOrderId}`);
        await new Promise(r => setTimeout(r, 1200));

        try {
          const queryRes = await this.getOrder(cleanSymbol, { origClientOrderId: tx.entryClientOrderId });
          if (queryRes && queryRes.status) {
            console.warn(`[状态恢复] 反查成功！订单已被撮合接收，状态: ${queryRes.status}, 成交量: ${queryRes.executedQty}`);
            entryRes = queryRes;
            tx.stage = 'ENTRY_SENT';
          }
        } catch (queryErr) {
          if (queryErr.message && queryErr.message.includes('-2013')) {
            throw new BinanceError(`【开仓委托失败】网络异常，已确认订单未进入撮合: ${err.message}`, { type: 'NETWORK' });
          }
          throw new BinanceError(`【严重告警/状态不明】开仓超时且反查失败 (${queryErr.message})。请立刻人工核对 clientOrderId: ${tx.entryClientOrderId}！`, { type: 'AMBIGUOUS_STATE' });
        }
      } else {
        throw new BinanceError(`【开仓委托失败】${err.message}`, { type: 'API_ERROR' });
      }
    }

    // 4. Chained TP/SL Submission
    let tpslRes;
    try {
      tpslRes = await this.setTPSL({
        symbol: cleanSymbol,
        positionSide: cleanPosSide,
        quantity,
        stopLossPrice,
        takeProfitPrice,
        clientAlgoIdPrefix: tx.correlationId
      });

      const slErr = tpslRes.stopLoss && tpslRes.stopLoss.code < 0 ? tpslRes.stopLoss.msg : null;
      const tpErr = tpslRes.takeProfit && tpslRes.takeProfit.code < 0 ? tpslRes.takeProfit.msg : null;
      if (slErr || tpErr) {
        throw new Error(`TP/SL 挂单返回异常: ${slErr || tpErr}`);
      }
      tx.stage = 'COMPLETE';
    } catch (tpslErr) {
      return await _executeRollback(this, { cleanSymbol, cleanPosSide, type, entryRes, quantity, tpslErr });
    }

    return {
      entrySucceeded: true,
      tpslSucceeded: true,
      correlationId: tx.correlationId,
      entry: entryRes,
      tpsl: tpslRes
    };
  },

  // Close Position with Adaptive Mode and Verified Zero-Position Protection Cleanup
  async closePosition(symbol, positionSide) {
    if (!symbol) throw new BinanceError('Symbol is required to close position.', { type: 'PARAMS' });
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

    const modeInfo = await this.getPositionMode();
    const isHedgeMode = modeInfo && modeInfo.dualSidePosition === true;

    const closeParams = {
      symbol: cleanSymbol,
      side: closeSide,
      type: 'MARKET',
      quantity: amt.toString(),
      newClientOrderId: generateClientOrderId('BAN_CLOSE')
    };

    if (isHedgeMode) {
      closeParams.positionSide = targetPos.positionSide;
    } else {
      closeParams.positionSide = 'BOTH';
      closeParams.reduceOnly = 'true';
    }

    // 1. Execute market close
    const closeRes = await this.placeOrder(closeParams);
    if (!closeRes || (closeRes.code && closeRes.code < 0)) {
      throw new BinanceError(`【平仓失败】币安拒绝平仓: [${closeRes ? closeRes.code : 'UNKNOWN'}] ${closeRes ? closeRes.msg : '网络异常'}。保护单坚决保留！`, { type: 'API_ERROR' });
    }

    // 2. Poll/verify position risk to confirm positionAmt is genuinely 0 before cancelling algo protection
    let remainingAmt = 0;
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 150));
      const currentPositions = await this.getPositionRisk(cleanSymbol);
      const remainingPos = Array.isArray(currentPositions)
        ? currentPositions.find(p => p.positionSide === targetPos.positionSide)
        : null;
      remainingAmt = remainingPos ? Math.abs(parseFloat(remainingPos.positionAmt)) : 0;
      if (remainingAmt === 0) break;
    }

    if (remainingAmt > 0) {
      return {
        closeSuccess: false,
        closeOrder: closeRes,
        remainingQuantity: remainingAmt,
        message: `【平仓未完全完成】仓位仍剩余 ${remainingAmt} ${cleanSymbol}，保护单坚决保留未撤销！`
      };
    }

    // 3. Clear remaining algo orders
    const cancelledAlgos = await this.cancelAlgoOrdersByPositionSide(cleanSymbol, targetPos.positionSide);

    return {
      closeSuccess: true,
      closeOrder: closeRes,
      cancelledAlgos
    };
  },

  async cancelOrder(symbol, orderId) {
    if (!symbol || !orderId) throw new BinanceError('Symbol and orderId are required to cancel order.', { type: 'PARAMS' });
    return signedReq(FAPI_HOST, '/fapi/v1/order', { symbol: symbol.toUpperCase().trim(), orderId: orderId.toString() }, 'DELETE');
  },

  async cancelAllOrders(symbol) {
    if (!symbol) throw new BinanceError('Symbol is required to cancel all orders.', { type: 'PARAMS' });
    return signedReq(FAPI_HOST, '/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase().trim() }, 'DELETE');
  },

  async placeAlgoOrder(params) {
    return signedReq(FAPI_HOST, '/fapi/v1/algoOrder', params, 'POST');
  },

  async cancelAlgoOrder(algoId) {
    return signedReq(FAPI_HOST, '/fapi/v1/algoOrder', { algoId: algoId.toString() }, 'DELETE');
  },

  async cancelAllAlgoOrders(symbol, positionSide) {
    return this.cancelAlgoOrdersByPositionSide(symbol, positionSide);
  },

  async cancelAlgoOrdersByPositionSide(symbol, positionSide) {
    const cleanSymbol = symbol.toUpperCase().trim();
    const cleanPosSide = positionSide ? positionSide.toUpperCase().trim() : null;
    const algos = await this.getOpenAlgos(cleanSymbol);
    const results = [];
    if (Array.isArray(algos)) {
      for (const a of algos) {
        if (!cleanPosSide || a.positionSide === cleanPosSide) {
          results.push(await this.cancelAlgoOrder(a.algoId));
        }
      }
    }
    return results;
  },

  // Set Stop-Loss and Take-Profit with Create-Before-Cancel Transaction Pattern
  async setTPSL({ symbol, positionSide, quantity, stopLossPrice, takeProfitPrice, cancelExisting = true, clientAlgoIdPrefix }) {
    if (!symbol || !positionSide) throw new BinanceError('Symbol and positionSide (LONG|SHORT) are required for setTPSL', { type: 'PARAMS' });
    const cleanSymbol = symbol.toUpperCase().trim();
    const cleanPosSide = positionSide.toUpperCase().trim();
    const results = { cancelled: [] };

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
      const slParams = { ...baseParams, type: 'STOP_MARKET', triggerPrice: stopLossPrice.toString() };
      if (clientAlgoIdPrefix) slParams.clientAlgoId = `${clientAlgoIdPrefix}_SL`.slice(0, 36);
      results.stopLoss = await this.placeAlgoOrder(slParams);
    }
    if (takeProfitPrice) {
      const tpParams = { ...baseParams, type: 'TAKE_PROFIT_MARKET', triggerPrice: takeProfitPrice.toString() };
      if (clientAlgoIdPrefix) tpParams.clientAlgoId = `${clientAlgoIdPrefix}_TP`.slice(0, 36);
      results.takeProfit = await this.placeAlgoOrder(tpParams);
    }

    if (cancelExisting) {
      const existing = await this.getOpenAlgos(cleanSymbol);
      if (Array.isArray(existing)) {
        const newAlgoIds = [
          results.stopLoss && results.stopLoss.algoId,
          results.takeProfit && results.takeProfit.algoId
        ].filter(Boolean);

        for (const order of existing) {
          if (order.positionSide === cleanPosSide && !newAlgoIds.includes(order.algoId)) {
            results.cancelled.push({ algoId: order.algoId, res: await this.cancelAlgoOrder(order.algoId) });
          }
        }
      }
    }

    return results;
  }
};

// ============================================================================
// 5. Table-Driven CLI Dispatcher (Declarative Command Registry)
// ============================================================================
const COMMANDS = {
  'status':           { desc: 'Overview of Spot, Futures, and Earn balances', run: () => Client.getStatus() },
  'ticker':          { minArgs: 1, usage: '<symbol1> [symbol2 ...]', desc: 'Query 24h ticker prices and stats', run: args => Client.getTickers(args) },
  'top-volume':      { desc: 'Top volume USDT pairs', run: args => Client.getTopVolume(args[0] ? parseInt(args[0], 10) : 10) },
  'depth':           { minArgs: 1, usage: '<symbol> [limit]', desc: 'Spot & Futures orderbook depth', run: args => Client.getDepth(args[0], args[1] ? parseInt(args[1], 10) : 20) },
  'klines':          { minArgs: 1, usage: '<symbol> [interval] [limit]', desc: 'Candlesticks (OHLCV)', run: args => Client.getKlines(args[0], args[1] || '1h', args[2] ? parseInt(args[2], 10) : 10) },
  'sentiment':       { minArgs: 1, usage: '<symbol>', desc: 'Global/Top trader L/S ratio, OI, funding rate', run: args => Client.getSentiment(args[0]) },
  'open-algos':      { desc: 'Query pending algo/conditional orders', run: args => Client.getOpenAlgos(args[0] || undefined) },
  'open-orders':     { desc: 'Query pending standard orders', run: args => Client.getOpenOrders(args[0] || undefined) },
  'positions':       { desc: 'Active contract positions, PnL, leverage', run: args => Client.getPositionRisk(args[0] || undefined) },
  'position-mode':   { desc: 'Query or set dual/hedge position mode', run: args => args[0] === undefined ? Client.getPositionMode() : Client.setPositionMode(args[0]) },
  'leverage':        { minArgs: 2, usage: '<symbol> <leverage>', desc: 'Set leverage (1-125)', run: args => Client.setLeverage(args[0], args[1]) },
  'margin-type':     { minArgs: 2, usage: '<symbol> <ISOLATED|CROSSED>', desc: 'Set margin type', run: args => Client.setMarginType(args[0], args[1]) },
  'trades':          { minArgs: 1, usage: '<symbol> [limit]', desc: 'Formatted user trade history', run: args => Client.getUserTrades(args[0], args[1] ? parseInt(args[1], 10) : 5) },
  'order':           { minArgs: 2, usage: '<symbol> <orderId>', desc: 'Query single standard order status', run: args => Client.getOrder(args[0], { orderId: args[1] }) },
  'close-position':  { minArgs: 1, usage: '<symbol> [LONG|SHORT]', desc: 'Adaptive market close and protection cleanup', run: args => Client.closePosition(args[0], args[1] || undefined) },
  'cancel-order':    { minArgs: 2, usage: '<symbol> <orderId>', desc: 'Cancel standard order by ID', run: args => Client.cancelOrder(args[0], args[1]) },
  'cancel-all':      { minArgs: 1, usage: '<symbol>', desc: 'Cancel all open standard orders', run: args => Client.cancelAllOrders(args[0]) },
  'cancel-algo':     { minArgs: 1, usage: '<algoId>', desc: 'Cancel algo order by ID', run: args => Client.cancelAlgoOrder(args[0]) },
  'cancel-all-algos':{ minArgs: 1, usage: '<symbol> [LONG|SHORT]', desc: 'Cancel open algo orders', run: args => Client.cancelAllAlgoOrders(args[0], args[1] || undefined) },
  'set-tpsl': {
    minArgs: 4, usage: '<symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]', desc: 'Bind TP/SL to existing position',
    run: args => Client.setTPSL({ symbol: args[0], positionSide: args[1], stopLossPrice: args[2], takeProfitPrice: args[3], quantity: args[4] })
  },
  'open-tpsl': {
    minArgs: 5,
    usage: '<symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>',
    desc: 'Entry with chained TP/SL protection and rollback',
    run: async args => {
      const [symbol, side, positionSide, quantity, rawType] = args;
      const type = rawType.toUpperCase();
      let price, slPrice, tpPrice;

      if (type === 'MARKET') {
        if (args.length === 7) {
          slPrice = args[5]; tpPrice = args[6];
        } else if (args.length >= 8) {
          slPrice = args[6]; tpPrice = args[7];
        } else {
          throw new BinanceError('MARKET orders require <slPrice> and <tpPrice>.', { type: 'PARAMS' });
        }
      } else if (type === 'LIMIT') {
        if (args.length < 8) {
          throw new BinanceError('LIMIT orders require <price>, <slPrice> and <tpPrice>.', { type: 'PARAMS' });
        }
        price = args[5]; slPrice = args[6]; tpPrice = args[7];
      } else {
        throw new BinanceError('Unsupported order type. Use MARKET or LIMIT.', { type: 'PARAMS' });
      }

      return Client.openPositionWithTPSL({
        symbol: symbol.toUpperCase(), side: side.toUpperCase(), positionSide: positionSide.toUpperCase(),
        quantity, type, price, stopLossPrice: slPrice, takeProfitPrice: tpPrice
      });
    }
  }
};

function printHelp() {
  console.log(`Unified Binance CEX/Futures CLI (Table-Driven Engine)\n\nUsage: node scripts/binance_unified.js <command> [arguments...]\n\nCommands:`);
  for (const [cmd, def] of Object.entries(COMMANDS)) {
    const usageStr = def.usage ? ` ${def.usage}` : '';
    console.log(`  ${(cmd + usageStr).padEnd(52)} - ${def.desc}`);
  }
}

async function cli() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    printHelp();
    process.exit(0);
  }

  const def = COMMANDS[cmd];
  if (!def) {
    console.error(`Unknown command: "${cmd}". Run with --help to see available commands.`);
    process.exit(1);
  }

  if (def.minArgs && args.length < def.minArgs) {
    console.error(`Usage: node scripts/binance_unified.js ${cmd} ${def.usage || ''}`);
    process.exit(1);
  }

  try {
    const result = await def.run(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Execution error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  cli().catch(err => {
    console.error('Fatal CLI Error:', err.message);
    process.exit(1);
  });
}

// Exports for CommonJS and ESM bridge
module.exports = Client;
Client.Client = Client;
Client.BinanceError = BinanceError;
Client.TransactionContext = TransactionContext;
Client.generateClientOrderId = generateClientOrderId;
Client.normalizeOrder = normalizeOrder;
