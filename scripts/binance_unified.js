/**
 * Unified Binance CEX/Futures CLI & Library
 * Location: scripts/binance_unified.js
 *
 * Four-layer architecture:
 * 1. Communication, Signing, Read Retries & Explicit Write Outcome Handling
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
const D = require('./trading_primitives.cjs');

function createClient({ fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), loadEnv = true, credentials = {} } = {}) {

// ============================================================================
// 1. Configuration, Credentials & Error Types
// ============================================================================
const envPath = path.resolve(__dirname, '..', '.env');
const fallbackEnvPath = path.resolve(process.cwd(), '.env');
const actualEnvPath = fs.existsSync(envPath) ? envPath : fallbackEnvPath;

const env = {};
if (loadEnv && fs.existsSync(actualEnvPath)) {
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

const API_KEY = credentials.apiKey || env.BINANCE_API_KEY || (loadEnv ? process.env.BINANCE_API_KEY : undefined);
const SECRET_KEY = credentials.secretKey || env.BINANCE_SECRET_KEY || (loadEnv ? process.env.BINANCE_SECRET_KEY : undefined);
const SPOT_HOST = 'https://api.binance.com';
const FAPI_HOST = 'https://fapi.binance.com';

let timeOffset = null;

// Structured Error Type (Categorized by failure domain)
class BinanceError extends Error {
  constructor(message, { code = null, type = 'UNKNOWN', retryable = false, httpStatus = null } = {}) {
    super(message);
    this.name = 'BinanceError';
    this.code = code;
    this.type = type; // 'NETWORK' | 'RATE_LIMIT' | 'AUTH' | 'MARGIN' | 'PARAMS' | 'AMBIGUOUS_STATE' | 'API_ERROR'
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.status = type === 'AMBIGUOUS_STATE' ? 'UNKNOWN' : 'FAILED';
  }
}

// In-Flight Transaction Context
class TransactionContext {
  constructor(requestId) {
    this.requestId = requestId || `BAN_${now()}_${crypto.randomBytes(6).toString('hex')}`;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(this.requestId)) throw new BinanceError('Invalid request ID', {type:'PARAMS'});
    this.correlationId = 'BAN_' + crypto.createHash('sha256').update(this.requestId).digest('hex').slice(0,24);
    this.entryClientOrderId = this.correlationId + '_ENT';
    this.slClientOrderId = this.correlationId + '_SL';
    this.tpClientOrderId = this.correlationId + '_TP';
    this.stage = 'INITIALIZED';
  }
}
function generateClientOrderId(prefix='BAN') { return `${prefix.slice(0,8)}_${now()}_${crypto.randomBytes(5).toString('hex')}`.slice(0,36); }
function paramsError(message) { return new BinanceError(message, {type:'PARAMS'}); }
function requireArray(data, name) { if(!Array.isArray(data)) throw new BinanceError('Invalid '+name+' response', {type:'API_ERROR'}); return data; }
function positiveOrZero(value) {try{const text=D.decimal(value,{positive:false}).text;if(!Number.isFinite(Number(text)))throw Error('Decimal must be finite');return text;}catch(e){throw paramsError(e.message);}}
function absQty(value) { const s=String(value);return positiveOrZero(s.startsWith('-')?s.slice(1):s); }
function positive(value) { try { const text=D.decimal(value).text;if(!Number.isFinite(Number(text)))throw Error('Decimal must be finite');return text; } catch(e) {throw paramsError(e.message);} }
function name(value) { if(typeof value!=='string'||!value.trim()||!/^[A-Za-z0-9_]+$/.test(value.trim()))throw paramsError('Explicit asset, product or symbol required'); return value.trim().toUpperCase(); }
function exchangeId(value) {try{return D.idString(value);}catch(e){throw paramsError(e.message);}}
function owner(order) {return typeof order.clientAlgoId==='string' && /^BAN_[a-f0-9]{24}_(SL|TP)([a-f0-9]{4})?$/.test(order.clientAlgoId);}
function ambiguous(err) {return err?.type==='AMBIGUOUS_STATE' || ['TimeoutError','AbortError'].includes(err?.name);}
function modeFlags(options={}) {
 if(!options||typeof options!=='object'||Array.isArray(options)||['approved','dryRun'].some(k=>options[k]!==undefined&&typeof options[k]!=='boolean'))throw paramsError('Approval and dry-run flags must be booleans');
 if((options.approved===true)===(options.dryRun===true))throw paramsError('Choose exactly one of --approved or --dry-run');
}
function fundingAmount(value) {
 if(typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)))throw paramsError('Funding amount must be a decimal string or a safe integer');
 return positive(value);
}
function fundingPrecision(base,options) {
 let rule=options.precisionRule;
 if(options.precisionFile!==undefined) {
   if(rule!==undefined)throw paramsError('Choose precisionRule or --precision-file');
   let document;try{document=D.parseLossless(fs.readFileSync(options.precisionFile,'utf8'));}catch{throw paramsError('Cannot read funding precision JSON');}
   const rules=requireArray(document.rules,'funding precision rules');
   const matches=rules.filter(r=>r&&r.endpoint===base.endpoint&&r.operation===base.operation&&r.asset===base.asset&&(base.productId?r.productId===base.productId:r.productId===undefined));
   if(matches.length>1)throw paramsError('Multiple funding precision rules match this operation');
   if(matches.length===0)throw paramsError('No funding precision rule matches this operation');
   rule=matches[0];
 }
 if(rule===undefined)return {status:'DEFERRED_TO_EXCHANGE',maxScale:null,stepSize:null,source:null,clientMaxScale:18,localValidationPassed:true,exchangeValidated:false,reason:'Amount format checked locally; exchange-specific precision will be checked on submission'};
 if(!rule||typeof rule!=='object'||rule.endpoint!==base.endpoint||rule.operation!==base.operation||rule.asset!==base.asset||
   (base.productId?rule.productId!==base.productId:rule.productId!==undefined))throw paramsError('Funding precision rule identity mismatch');
 const maxScale=rule.maxScale,stepSize=rule.stepSize;
 if(maxScale===undefined&&stepSize===undefined)throw paramsError('Precision rule requires maxScale or stepSize');
 if(maxScale!==undefined&&(!Number.isInteger(maxScale)||maxScale<0||maxScale>18))throw paramsError('Invalid precision maxScale');
 if(stepSize!==undefined){if(typeof stepSize!=='string')throw paramsError('Funding stepSize must be a decimal string');positive(stepSize);}
 let url;try{url=new URL(rule.source?.url);}catch{throw paramsError('Precision rule needs an authoritative source URL');}
 if(url.protocol!=='https:'||!(url.hostname==='binance.com'||url.hostname.endsWith('.binance.com'))||url.username||url.password||
   typeof rule.source?.reference!=='string'||!rule.source.reference.trim())throw paramsError('Precision rule requires a Binance source and reference');
 const isoTimestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
 const verified=Date.parse(rule.source.verifiedAt);
 if(!isoTimestamp(rule.source.verifiedAt)||verified>now())throw paramsError('Precision rule requires a valid verification time');
 if(rule.expiresAt!==undefined&&(!isoTimestamp(rule.expiresAt)||Date.parse(rule.expiresAt)<=now()||Date.parse(rule.expiresAt)<=verified))throw paramsError('Funding precision rule expired or invalid');
 // CONFIGURED records caller-supplied evidence; this client does not attest that a URL proves its contents.
 const result={status:'CONFIGURED',maxScale:maxScale??null,stepSize:stepSize??null,source:rule.source,expiresAt:rule.expiresAt??null};
 try{if(maxScale!==undefined)D.decimal(base.amount,{maxScale});if(stepSize!==undefined&&!D.onStep(base.amount,stepSize))throw Error('Amount is not on the funding step');}
 catch(err){return {...result,status:'INVALID_AMOUNT',reason:err.message};}
 return result;
}
function fundingHistoryRecord(row,operation,source,destination) {
 const completed=['PAID','CONFIRMED','SUCCESS'].includes(row.status),failed=['FAILED','FAIL','REJECTED'].includes(row.status);
 let id=null,identityValid=false;try{id=exchangeId(operation==='REDEEM_EARN'?row.redeemId:row.tranId);identityValid=!!row.asset&&positive(row.amount)!==undefined;}catch{}
 if(operation==='REDEEM_EARN'){destination=row.destAccount??null;identityValid=identityValid&&['SPOT','FUND'].includes(destination)&&!!(row.productId??row.projectId);}
 else identityValid=identityValid&&row.type===operation;
 return {operation,asset:row.asset??null,amount:row.amount??null,source,destination,
   ...(operation==='REDEEM_EARN'?{productId:row.projectId??row.productId??null,redeemId:id}:{tranId:id}),
   requestedAt:row.timestamp??row.time??row.createTime??null,checkedAt:new Date(now()).toISOString(),
   identityVerified:identityValid,status:!identityValid?'UNKNOWN':completed?'CONFIRMED':failed?'FAILED':['PENDING','PROCESSING','CREATED'].includes(row.status)?'SUBMITTED':'UNKNOWN',rawStatus:row.status??null};
}
// Output Normalizer for Orders
function normalizeOrder(raw) {
  if(!raw || typeof raw!=='object' || raw.code<0 || !raw.orderId || !raw.status || raw.executedQty===undefined || raw.origQty===undefined) throw new BinanceError('Invalid order response', {code:raw?.code,type:'API_ERROR'});
  if(!raw.symbol||!['BUY','SELL'].includes(raw.side)||!['BOTH','LONG','SHORT'].includes(raw.positionSide)||!raw.type||!raw.clientOrderId||!['NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED','PENDING_CANCEL'].includes(raw.status))throw new BinanceError('Invalid order identity or status',{type:'API_ERROR'});
  try{positive(raw.origQty);positiveOrZero(raw.executedQty);if(D.compare(raw.executedQty,raw.origQty)>0||raw.status==='FILLED'&&D.compare(raw.executedQty,raw.origQty)!==0||raw.status==='PARTIALLY_FILLED'&&D.compare(raw.executedQty,'0')===0)throw Error('Inconsistent fill');}catch{throw new BinanceError('Invalid order fill state',{type:'API_ERROR'});}
  return {...raw, orderId:exchangeId(raw.orderId), executedQty:String(raw.executedQty ?? '0'), origQty:String(raw.origQty ?? '0'), avgPrice:String(raw.avgPrice ?? raw.price ?? '0')};
}

// ============================================================================
// 2. Core Network, Time Sync & Read Retries
// ============================================================================
async function httpRequest(url, method='GET', headers={}, retries, deadline) {
 const count=method==='GET'?(retries??2):0;
 for(let attempt=0;attempt<=count;attempt++) {
  try {
   const remaining=deadline===undefined?10000:Math.min(10000,deadline-now());
   if(remaining<=0)throw new BinanceError('Read confirmation deadline exceeded',{type:'NETWORK'});
   const res=await fetchImpl(url,{method,headers,signal:AbortSignal.timeout(Math.max(1,Math.ceil(remaining)))});
   const text=await res.text(); let data;
   try {data=D.parseLossless(text);} catch {throw new BinanceError('Invalid API JSON', {type:method==='GET'?'API_ERROR':'AMBIGUOUS_STATE'});}
   if(data?.code<0 || res.status<200 || res.status>=300) {
    const type=(res.status>=500 && method!=='GET')?'AMBIGUOUS_STATE':res.status===429||res.status===418?'RATE_LIMIT':'API_ERROR';
    throw new BinanceError('Exchange request rejected'+(data?.code ? ' ['+data.code+'] '+String(data.msg||'') : ' [HTTP '+res.status+']'),{code:data?.code??res.status,type,httpStatus:res.status,retryable:method==='GET'&&(res.status>=500||res.status===429)});
   }
   if(!data || typeof data!=='object')throw new BinanceError('Invalid API response', {type:method==='GET'?'API_ERROR':'AMBIGUOUS_STATE'});
   return data;
  } catch(err) {
   if(err instanceof BinanceError) {if(!err.retryable||attempt===count)throw err;}
   else if(method!=='GET')throw new BinanceError('Write request result unknown; reconcile before resubmitting',{type:'AMBIGUOUS_STATE'});
   else if(attempt===count)throw new BinanceError('Read request failed',{type:'NETWORK'});
   await sleep(400*(attempt+1));
  }
 }
}
async function syncTime() {
 if(timeOffset===null) {const result=await httpRequest(`${SPOT_HOST}/api/v3/time`); if(!Number.isFinite(result.serverTime))throw new BinanceError('Server time unknown',{type:'API_ERROR'});timeOffset=result.serverTime-now();}
}
function sign(qs) {if(!API_KEY||!SECRET_KEY)throw new BinanceError('Missing BINANCE_API_KEY or BINANCE_SECRET_KEY',{type:'AUTH'});return crypto.createHmac('sha256',SECRET_KEY).update(qs).digest('hex');}
async function signedReq(host,endpoint,params={},method='GET',retries,deadline) {
 if(deadline!==undefined&&timeOffset===null)throw new BinanceError('Clock unavailable for bounded confirmation',{type:'NETWORK'});
 await syncTime();
 const request=()=>{const qs=new URLSearchParams({...params,timestamp:String(now()+timeOffset),recvWindow:'10000'}).toString();return httpRequest(`${host}${endpoint}?${qs}&signature=${sign(qs)}`,method,{'X-MBX-APIKEY':API_KEY},retries,deadline);};
 try {return await request();}catch(err){if(err.code!==-1021||deadline!==undefined)throw err;timeOffset=null;await syncTime();return request();}
}

// ============================================================================
// 3. Private Domain Helpers (Order Validation & Rollback Machine)
// ============================================================================
function _validatePriceBounds(direction,ref,sl,tp) {
 positive(ref); if(sl!==undefined)positive(sl);if(tp!==undefined)positive(tp);
 if(direction==='LONG') {if(sl!==undefined&&D.compare(sl,ref)>=0)throw paramsError('LONG requires SL < entry');if(tp!==undefined&&D.compare(tp,ref)<=0)throw paramsError('LONG requires TP > entry');}
 else if(direction==='SHORT') {if(sl!==undefined&&D.compare(sl,ref)<=0)throw paramsError('SHORT requires SL > entry');if(tp!==undefined&&D.compare(tp,ref)>=0)throw paramsError('SHORT requires TP < entry');}
 else throw paramsError('Direction must be LONG or SHORT');
}
function executionRisk(direction,quantity,price,stopPrice,feeRate,referencePrice,leverage) {
 const notional=D.multiply(quantity,price),entryFee=D.multiply(notional,feeRate),stopFee=D.multiply(D.multiply(quantity,stopPrice),feeRate);
 const loss=D.add(D.multiply(quantity,D.absDifference(price,stopPrice)),D.add(entryFee,stopFee));
 const slippageBps=Math.max(0,(direction==='LONG'?Number(price)/Number(referencePrice)-1:1-Number(price)/Number(referencePrice))*10000);
 const adverse=direction==='LONG'?D.compare(price,referencePrice)>0:D.compare(price,referencePrice)<0;
 return {price,quantity,notionalUsd:notional,lossAtStopUsd:loss,entryFeeUsd:entryFee,stopExitFeeUsd:stopFee,
   slippagePriceDelta:adverse?D.absDifference(price,referencePrice):'0',slippageReferencePrice:referencePrice,
   marginRequiredUsd:Number(notional)/leverage+Number(entryFee),slippageBps};
}
function executionRiskBlockers(risk,input,availableMargin,leverage) {
 const blockers=[];
 if(input.riskUsd!==undefined&&D.compare(risk.lossAtStopUsd,input.riskUsd)>0)blockers.push('Stop loss plus fees exceeds risk budget');
 if(input.maxNotionalUsd!==undefined&&D.compare(risk.notionalUsd,input.maxNotionalUsd)>0)blockers.push('Notional exceeds limit');
 if(input.maxLeverage!==undefined&&(!Number.isFinite(leverage)||leverage>Number(input.maxLeverage)))blockers.push('Leverage exceeds limit');
 if(input.maxSlippageBps!==undefined&&D.compare(D.multiply(risk.slippagePriceDelta,'10000'),D.multiply(risk.slippageReferencePrice,input.maxSlippageBps))>0)blockers.push('Slippage limit exceeded');
 // Compare (available - fee) * leverage with notional without rounding a division.
 if(availableMargin!==undefined&&(D.compare(risk.entryFeeUsd,availableMargin)>0||
   Number.isFinite(leverage)&&leverage>0&&D.compare(risk.notionalUsd,D.multiply(D.subtract(availableMargin,risk.entryFeeUsd),String(leverage)))>0))blockers.push('Insufficient available margin');
 return blockers;
}

// ============================================================================
// 4. Consolidated Client Methods
// ============================================================================
const Client = {
  // Account Status: Earn, Spot, Futures
  async getStatus() {
    const [earn,spot,futures,openAlgos]=await Promise.all([
      this._history('/sapi/v1/simple-earn/flexible/position',{}),this.getSpotAccount(),this.getFuturesAccount(),this.getOpenAlgos()]);

    const spotBalances = (spot.balances || []).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    const futuresPositions = (futures.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    return {
      earn,
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
    return requireArray(data,'tickers').map(t => ({
      symbol: t.symbol,
      price: t.lastPrice,
      change: t.priceChangePercent + '%',
      high: t.highPrice,
      low: t.lowPrice,
      volMillion: (parseFloat(t.quoteVolume) / 1e6).toFixed(2) + 'M'
    }));
  },

  // Top Volume USDT pairs
  async getTopVolume(limit = 10) {
    const tickers = await httpRequest(`${SPOT_HOST}/api/v3/ticker/24hr`);
    requireArray(tickers,'tickers');
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
        throw new BinanceError('Invalid depth response',{type:'API_ERROR'});
      }
      for(const level of [...data.bids,...data.asks]){if(!Array.isArray(level)||level.length<2)throw new BinanceError('Invalid depth level',{type:'API_ERROR'});positive(level[0]);positiveOrZero(level[1]);}
      const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
      const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;
      const totalBidsQty = data.bids.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
      const totalAsksQty = data.asks.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
      const spread = bestAsk !== null && bestBid !== null ? (bestAsk - bestBid).toFixed(4) : null;
      const ratio = totalAsksQty > 0 ? (totalBidsQty / totalAsksQty).toFixed(2) : 'N/A';
      return {
        bestBid, bestAsk, spread,sourceTime:data.E??data.T??null,observedAt:new Date(now()).toISOString(),status:bestBid!==null&&bestAsk!==null?'OK':'UNKNOWN',
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
    requireArray(data, 'array');
    return data.map(c => ({
      time: new Date(c[0]).toISOString(), openTime:c[0],closeTime:c[6],quoteVolume:c[7],closed:Number(c[6])<now(),
      open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  },

  // Sentiment & Derivative Indicators (L/S, OI, Taker)
  async getSentiment(symbol) {
    if (!symbol) throw new BinanceError('Symbol is required for sentiment analysis.', { type: 'PARAMS' });
    const cleanSymbol = symbol.toUpperCase().trim();
    const results = await Promise.allSettled([
      httpRequest(`${FAPI_HOST}/futures/data/globalLongShortAccountRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/futures/data/topLongShortPositionRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/futures/data/takerlongshortRatio?symbol=${cleanSymbol}&period=1h&limit=1`),
      httpRequest(`${FAPI_HOST}/fapi/v1/openInterest?symbol=${cleanSymbol}`),
      httpRequest(`${FAPI_HOST}/fapi/v1/premiumIndex?symbol=${cleanSymbol}`),
      httpRequest(`${FAPI_HOST}/futures/data/openInterestHist?symbol=${cleanSymbol}&period=1h&limit=2`)
    ]);
    if(results.every(r=>r.status==='rejected'))throw new BinanceError('Sentiment sources unavailable',{type:'NETWORK'});
    const labels=['globalRatio','topRatio','takerRatio','openInterest','funding','openInterestHistory'];
    const missingData=results.flatMap((r,i)=>r.status==='rejected'?[labels[i]+' request failed']:[]);
    const [globalRatio,topRatio,takerRatio,oi,funding,historical]=results.map(r=>r.status==='fulfilled'?r.value:null);
    const numeric=v=>['number','string'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
    const ratio=(rows,field,label)=>{const v=Array.isArray(rows)?numeric(rows[0]?.[field]):null;if(v===null)missingData.push(label+' unknown');return v;};
    const globalLong=ratio(globalRatio,'longAccount','globalRatio'),topLong=ratio(topRatio,'longAccount','topRatio'),taker=ratio(takerRatio,'buySellRatio','takerRatio');
    const fundingValue=numeric(funding?.lastFundingRate),oiValue=numeric(oi?.openInterest);
    if(fundingValue===null)missingData.push('funding unknown');if(oiValue===null)missingData.push('openInterest unknown');
    let openInterestHistory={interval:'1h',status:'UNKNOWN',rows:[],changePercent:null,startTime:null,endTime:null,source:'/futures/data/openInterestHist'};
    if(Array.isArray(historical)&&historical.length===2) {
      const rows=historical.map(row=>({timestamp:numeric(row.timestamp),openInterest:numeric(row.sumOpenInterest),notional:numeric(row.sumOpenInterestValue)})).sort((a,b)=>a.timestamp-b.timestamp);
      if(rows.every(r=>r.timestamp!==null&&r.openInterest!==null&&r.openInterest>0)&&rows[1].timestamp-rows[0].timestamp===3600000&&rows[1].timestamp<=now()&&now()-rows[1].timestamp<=7200000)openInterestHistory={...openInterestHistory,status:'OK',rows,changePercent:(rows[1].openInterest/rows[0].openInterest-1)*100,startTime:rows[0].timestamp,endTime:rows[1].timestamp};
    }
    if(openInterestHistory.status!=='OK')missingData.push('openInterestHistory unknown or discontinuous');
    return {
      symbol: cleanSymbol,status:missingData.length?'PARTIAL':'OK',observedAt:new Date(now()).toISOString(),missingData:[...new Set(missingData)],
      globalLongRatio:globalLong===null?null:(globalLong*100).toFixed(1)+'%',topTraderLongRatio:topLong===null?null:(topLong*100).toFixed(1)+'%',takerBuySellRatio:taker,
      ratioSourceTimes:{global:globalRatio?.[0]?.timestamp??null,top:topRatio?.[0]?.timestamp??null,taker:takerRatio?.[0]?.timestamp??null},
      openInterest:oiValue===null?null:oi.openInterest,openInterestChange:openInterestHistory.changePercent,openInterestHistory,openInterestSourceTime:oi?.time??null,
      fundingSourceTime:funding?.time??null,nextFundingTime:funding?.nextFundingTime??null,fundingRate:fundingValue===null?null:(fundingValue*100).toFixed(4)+'%'
    };
  },

  async getOpenAlgos(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return requireArray(await signedReq(FAPI_HOST, '/fapi/v1/openAlgoOrders', params), 'algo orders');
  },

  async getOpenOrders(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    return requireArray(await signedReq(FAPI_HOST, '/fapi/v1/openOrders', params), 'orders');
  },

  async getPositionRisk(symbol) {
    const params = symbol ? { symbol: symbol.toUpperCase().trim() } : {};
    const data = await signedReq(FAPI_HOST, '/fapi/v2/positionRisk', params);
    requireArray(data, 'array');
    return data
      .filter(p => { try{if(!p||!p.symbol||symbol&&p.symbol!==symbol.toUpperCase().trim()||!['LONG','SHORT','BOTH'].includes(p.positionSide))throw Error('Invalid position');return D.compare(absQty(p.positionAmt),'0')!==0;}catch{throw new BinanceError('Invalid position snapshot',{type:'API_ERROR'});} })
      .map(p => ({
        symbol: p.symbol, positionSide: p.positionSide, positionAmt: p.positionAmt,
        entryPrice: p.entryPrice, markPrice: p.markPrice, unrealizedProfit: p.unRealizedProfit,
        liquidationPrice: p.liquidationPrice, leverage: p.leverage, marginType: p.marginType
      }));
  },

  async getPositionMode() {
    const mode=await signedReq(FAPI_HOST, '/fapi/v1/positionSide/dual');
    if(typeof mode.dualSidePosition!=='boolean')throw new BinanceError('Position mode unknown',{type:'API_ERROR'});return mode;
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
    requireArray(data, 'array');
    return data.map(t => ({
      id: t.id, symbol: t.symbol, side: t.side, positionSide: t.positionSide,
      price: parseFloat(t.price), qty: parseFloat(t.qty), realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission), commissionAsset: t.commissionAsset,
      time: new Date(t.time).toISOString().replace('T', ' ').slice(0, 19)
    }));
  },

  async getSpotAccount() {
    const data=await signedReq(SPOT_HOST,'/api/v3/account');
    requireArray(data.balances,'spot balances');
    if(data.accountType!=='SPOT')throw new BinanceError('Unsupported or unknown account type',{type:'PARAMS'});
    for(const balance of data.balances){try{if(!balance.asset)throw Error('Asset unknown');positiveOrZero(balance.free);positiveOrZero(balance.locked);}catch{throw new BinanceError('Invalid spot balance snapshot',{type:'API_ERROR'});}}
    return data;
  },
  async getFuturesAccount() {
    const data=await signedReq(FAPI_HOST,'/fapi/v2/account');requireArray(data.assets,'futures assets');requireArray(data.positions,'futures positions');
    if(typeof data.multiAssetsMargin!=='boolean')throw new BinanceError('Futures asset mode unknown',{type:'API_ERROR'});
    if(data.multiAssetsMargin===true)throw new BinanceError('Multi-assets margin is not supported by this workflow',{type:'PARAMS'});
    for(const position of data.positions){try{if(!position.symbol||!['BOTH','LONG','SHORT'].includes(position.positionSide))throw Error('Position identity unknown');absQty(position.positionAmt);}catch{throw new BinanceError('Invalid futures account position',{type:'API_ERROR'});}}
    return data;
  },
  async getApiRestrictions() {
    const data=await signedReq(SPOT_HOST,'/sapi/v1/account/apiRestrictions');
    if(!data||Array.isArray(data))throw new BinanceError('Invalid API permissions response',{type:'API_ERROR'});
    return {source:'/sapi/v1/account/apiRestrictions',observedAt:new Date(now()).toISOString(),
      ...Object.fromEntries(['ipRestrict','enableReading','enableFutures','permitsUniversalTransfer'].map(key=>[key,typeof data[key]==='boolean'?data[key]:null]))};
  },
  async getContract(symbol) {
    const data=await httpRequest(`${FAPI_HOST}/fapi/v1/exchangeInfo`);const contracts=requireArray(data.symbols,'exchange symbols');
    const contract=contracts.find(x=>x.symbol===name(symbol));
    if(!contract||contract.status!=='TRADING'||contract.contractType!=='PERPETUAL'||contract.marginAsset!=='USDT')throw paramsError('Only trading USDT perpetual contracts are supported');return contract;
  },
  async _history(endpoint,params) {
    const rows=[];let expectedTotal=null;
    for(let current=1;current<=100;current++) {
      const data=await signedReq(SPOT_HOST,endpoint,{...params,current:String(current),size:'100'});
      if(!['number','string'].includes(typeof data.total)||!/^\d+$/.test(String(data.total))||!Number.isSafeInteger(Number(data.total)))throw new BinanceError('Invalid history count',{type:'API_ERROR'});
      const total=Number(data.total);
      if(expectedTotal!==null&&total!==expectedTotal)throw new BinanceError('History count changed during pagination; reconcile again',{type:'API_ERROR'});expectedTotal=total;
      // Binance can return {total:0} for a trustworthy empty transfer history.
      const page=total===0&&data.rows==null?[]:requireArray(data.rows,'history rows');
      if(rows.length+page.length>total)throw new BinanceError('History rows exceed declared count',{type:'API_ERROR'});
      rows.push(...page);
      if(rows.length===total)return rows;
      if(!page.length)throw new BinanceError('Incomplete history page',{type:'API_ERROR'});
    }
    throw new BinanceError('History exceeds bounded query size; narrow time window',{type:'API_ERROR'});
  },
  async getEarnRedemptions(productId,{redeemId,startTime,endTime}={}) {
    const product=name(productId);
    let rows=await this._history('/sapi/v1/simple-earn/flexible/history/redemptionRecord',{productId:product,...(redeemId?{redeemId:exchangeId(redeemId)}:{}),...(startTime?{startTime:String(startTime)}:{}),...(endTime?{endTime:String(endTime)}:{})});
    rows=rows.filter(x=>(x.projectId||x.productId)===product && (!redeemId||String(x.redeemId)===exchangeId(redeemId)));
    return {operation:'REDEEM_EARN',productId:product,checkedAt:new Date(now()).toISOString(),rows,records:rows.map(row=>fundingHistoryRecord(row,'REDEEM_EARN','SIMPLE_EARN','SPOT')),...(redeemId?{status:rows.length===1?fundingHistoryRecord(rows[0],'REDEEM_EARN','SIMPLE_EARN','SPOT').status:'UNKNOWN'}:{})};
  },
  async getTransferHistory(direction,{tranId,startTime,endTime}={}) {
    if(!['to-futures','from-futures'].includes(direction))throw paramsError('Transfer direction must be to-futures or from-futures');
    const type=direction==='to-futures'?'MAIN_UMFUTURE':'UMFUTURE_MAIN';
    let rows=await this._history('/sapi/v1/asset/transfer',{type,...(startTime?{startTime:String(startTime)}:{}),...(endTime?{endTime:String(endTime)}:{})});
    rows=rows.filter(x=>x.type===type && (!tranId||String(x.tranId)===exchangeId(tranId)));
    const source=direction==='to-futures'?'SPOT':'USDS_FUTURES',destination=direction==='to-futures'?'USDS_FUTURES':'SPOT';
    return {operation:type,checkedAt:new Date(now()).toISOString(),rows,records:rows.map(row=>fundingHistoryRecord(row,type,source,destination)),...(tranId?{status:rows.length===1?fundingHistoryRecord(rows[0],type,source,destination).status:'UNKNOWN'}:{})};
  },
  async _fundingResult(base,submit,history,refresh) {
    let result;
    try {result=await submit();}catch(err) {
      if(!ambiguous(err))return {...base,status:'FAILED',checkedAt:new Date(now()).toISOString(),errorCode:err.code,errorType:err.type,errorMessage:err.message+(base.operation!=='REDEEM_EARN'&&[-1002,-2014,-2015].includes(err.code)?'; verify Permits Universal Transfer permission':''),nextAction:'Resolve the explicit rejection before requesting a new submission'};
      let candidates=[];try{candidates=(await history()).rows.filter(x=>x.asset===base.asset&&D.compare(String(x.amount),base.amount)===0);}catch{}
      return {...base,status:'UNKNOWN',checkedAt:new Date(now()).toISOString(),candidates,errorCode:err.code,nextAction:'Do not resubmit. Reconcile exchange history; same amount is not proof of identity.'};
    }
    const idKey=base.operation==='REDEEM_EARN'?'redeemId':'tranId';
    if(result.success===false&&result[idKey]) {
      let id=null;try{id=exchangeId(result[idKey]);}catch{}
      return {...base,...(id?{[idKey]:id}:{}),status:'UNKNOWN',checkedAt:new Date(now()).toISOString(),errorMessage:'Conflicting rejection and funding identifier in submission response',nextAction:'Reconcile this identifier and history; do not resubmit'};
    }
    if(result.success!==undefined&&typeof result.success!=='boolean')return {...base,status:'UNKNOWN',checkedAt:new Date(now()).toISOString(),errorMessage:'Invalid funding success flag',nextAction:'Reconcile history before any new submission'};
    if((idKey==='redeemId'&&result.success!==true)||!result[idKey])return {...base,status:result.success===false?'FAILED':'UNKNOWN',checkedAt:new Date(now()).toISOString(),errorMessage:'Funding submission response invalid',nextAction:'Reconcile history before any new submission'};
    let id;try{id=exchangeId(result[idKey]);}catch{return {...base,status:'UNKNOWN',checkedAt:new Date(now()).toISOString(),errorMessage:'Funding identifier invalid',nextAction:'Reconcile history; do not resubmit'};}let rows=[];
    try{rows=(await history(id)).rows;}catch{return {...base,[idKey]:id,status:'SUBMITTED',checkedAt:new Date(now()).toISOString(),nextAction:'Query history before proceeding'};}
    const matches=rows.filter(x=>String(x[idKey])===id),row=matches[0];
    let identityMatches=matches.length<=1;
    try{if(row)identityMatches=identityMatches&&row.asset===base.asset&&row.amount!==undefined&&D.compare(String(row.amount),base.amount)===0&&
      (base.operation==='REDEEM_EARN'?(row.productId??row.projectId)===base.productId&&row.destAccount==='SPOT':row.type===base.operation);}catch{identityMatches=false;}
    if(!identityMatches)return {...base,[idKey]:id,status:'UNKNOWN',checkedAt:new Date(now()).toISOString(),nextAction:'History identity does not match submitted asset and amount; do not resubmit'};
    let status=row&&['PAID','CONFIRMED','SUCCESS'].includes(row.status)?'CONFIRMED':row&&['FAILED','FAIL','REJECTED'].includes(row.status)?'FAILED':'SUBMITTED';
    let balances=null;try{if(status==='CONFIRMED')balances=await refresh();}catch{}
    return {...base,[idKey]:id,status,rawStatus:row?.status??null,checkedAt:new Date(now()).toISOString(),balances,balanceVerified:balances!==null,nextAction:status==='CONFIRMED'&&balances?'Re-evaluate the trade using fresh available balance':'Reconcile status and refresh balance before any next operation'};
  },
  async redeemEarn(productId,amount,options={}) {
    if(!options||typeof options!=='object'||Array.isArray(options))throw paramsError('Legacy FAST/type argument removed; pass options');
    modeFlags(options);const product=name(productId),qty=fundingAmount(amount);
    const base={operation:'REDEEM_EARN',endpoint:'/sapi/v1/simple-earn/flexible/redeem',productId:product,asset:null,amount:qty,source:'SIMPLE_EARN',destination:'SPOT',requestedAt:new Date(now()).toISOString(),checks:{productHeld:null,canRedeem:null,totalAmount:null,collateralAmount:null,available:null},precision:{status:'UNKNOWN',reason:'Product asset has not been established'}};
    const blockers=[];
    try {
      const positions=await this._history('/sapi/v1/simple-earn/flexible/position',{productId:product});
      const held=positions.filter(x=>x.productId===product);base.checks.productHeld=held.length===1;
      if(held.length!==1)throw paramsError(held.length?'Ambiguous product holding':'Product not held');
      const pos=held[0];base.asset=name(pos.asset);base.precision=fundingPrecision(base,options);
      if(!['CONFIGURED','DEFERRED_TO_EXCHANGE'].includes(base.precision.status))blockers.push(base.precision.reason);
      const products=await this._history('/sapi/v1/simple-earn/flexible/list',{asset:base.asset});
      const productInfo=products.find(x=>x.productId===product);base.checks.canRedeem=productInfo?.canRedeem===true&&pos.canRedeem===true;
      if(!base.checks.canRedeem||pos.collateralAmount===undefined)throw paramsError('Redemption status or collateral unknown or unavailable');
      const total=positiveOrZero(pos.totalAmount),collateral=positiveOrZero(pos.collateralAmount);Object.assign(base.checks,{totalAmount:total,collateralAmount:collateral});
      if(D.compare(collateral,total)>0)throw paramsError('Collateral exceeds holdings; reconcile product position');
      base.checks.available=D.subtract(total,collateral);if(D.compare(qty,base.checks.available)>0)blockers.push('Insufficient unencumbered Earn holdings');
    }catch(err){blockers.push(err.message);base.checks.preflightError={type:err.type??'ERROR',code:err.code??null};}
    base.blockers=[...new Set(blockers)];base.checkedAt=new Date(now()).toISOString();
    if(options.dryRun)return {...base,dryRun:true,status:'PREVIEW',readyForApproval:!base.blockers.length};
    if(base.blockers.length){const err=paramsError(base.blockers.join('; '));err.preview=base;throw err;}
    return this._fundingResult(base,()=>signedReq(SPOT_HOST,'/sapi/v1/simple-earn/flexible/redeem',{productId:product,amount:qty,redeemAll:'false',destAccount:'SPOT'},'POST'),id=>this.getEarnRedemptions(product,{redeemId:id,startTime:now()-60000,endTime:now()}),()=>this.getSpotAccount());
  },
  async transferToFutures(asset,amount,options={}) {return this._transferFunding('to-futures',asset,amount,options);},
  async transferFromFutures(asset,amount,options={}) {return this._transferFunding('from-futures',asset,amount,options);},
  async _transferFunding(direction,asset,amount,options) {
    modeFlags(options);const token=name(asset),qty=fundingAmount(amount);
    const base={operation:direction==='to-futures'?'MAIN_UMFUTURE':'UMFUTURE_MAIN',endpoint:'/sapi/v1/asset/transfer',asset:token,amount:qty,source:direction==='to-futures'?'SPOT':'USDS_FUTURES',destination:direction==='to-futures'?'USDS_FUTURES':'SPOT',requestedAt:new Date(now()).toISOString(),checks:{assetSupport:null,available:null,positionsPresent:null,marginBalanceAfter:null,minMarginUsd:options.minMarginUsd??null},precision:{status:'UNKNOWN'}};
    const blockers=[];
    try {
      base.precision=fundingPrecision(base,options);if(!['CONFIGURED','DEFERRED_TO_EXCHANGE'].includes(base.precision.status))blockers.push(base.precision.reason);
      // This workflow only handles ordinary single-asset USDT accounts. marginAvailable describes multi-assets collateral, not transfer support.
      base.checks.assetSupport=token==='USDT';if(token!=='USDT')throw paramsError('This single-asset funding workflow supports USDT only');
      const snapshots=await Promise.allSettled([this.getSpotAccount(),this.getFuturesAccount(),this.getApiRestrictions()]);
      for(let i=0;i<snapshots.length;i++)if(snapshots[i].status==='rejected')blockers.push(['Spot account','Futures account','API permissions'][i]+' unavailable: '+snapshots[i].reason.message);
      const spot=snapshots[0].status==='fulfilled'?snapshots[0].value:null,futures=snapshots[1].status==='fulfilled'?snapshots[1].value:null;
      const permissions=snapshots[2].status==='fulfilled'?snapshots[2].value:null;
      base.checks.universalTransferPermitted=permissions?.permitsUniversalTransfer??null;
      if(base.checks.universalTransferPermitted!==true)blockers.push('Permits Universal Transfer API permission disabled or unknown');
      const permission=futures?(direction==='to-futures'?futures.canDeposit:futures.canWithdraw):null;base.checks.directionPermitted=permission;
      if(permission!==true)blockers.push('Futures transfer permission disabled or unknown');
      const spotAsset=spot?.balances.find(x=>x.asset===token),margin=futures?.assets.find(x=>x.asset===token);
      base.checks.accountAssetPresent=!!margin;if(futures&&!margin)blockers.push('Asset missing from futures account snapshot');
      const available=direction==='to-futures'?spotAsset?.free:margin?.maxWithdrawAmount;
      if(available===undefined)blockers.push('Transferable balance unknown');
      else {base.checks.available=positiveOrZero(available);if(D.compare(qty,base.checks.available)>0)blockers.push('Insufficient transferable balance');}
      const held=futures?futures.positions.some(x=>D.compare(absQty(x.positionAmt),'0')!==0):null;base.checks.positionsPresent=held;
      if(direction==='from-futures'&&held) {
        if(margin?.marginBalance===undefined||options.minMarginUsd===undefined)blockers.push('Active positions require explicit --min-margin-usd and known USDT margin balance');
        else {const reserve=positive(options.minMarginUsd);base.checks.marginBalanceAfter=D.subtract(positiveOrZero(margin.marginBalance),qty);
          if(base.checks.marginBalanceAfter.startsWith('-')||D.compare(base.checks.marginBalanceAfter,reserve)<0)blockers.push('Transfer violates margin reserve');}
      }
    }catch(err){blockers.push(err.message);base.checks.preflightError={type:err.type??'ERROR',code:err.code??null};}
    base.blockers=[...new Set(blockers)];base.checkedAt=new Date(now()).toISOString();
    if(options.dryRun)return {...base,dryRun:true,status:'PREVIEW',readyForApproval:!base.blockers.length};
    if(base.blockers.length){const err=paramsError(base.blockers.join('; '));err.preview=base;throw err;}
    try{return await this._fundingResult(base,()=>signedReq(SPOT_HOST,'/sapi/v1/asset/transfer',{type:base.operation,asset:token,amount:qty},'POST'),id=>this.getTransferHistory(direction,{tranId:id,startTime:now()-60000,endTime:now()}),()=>direction==='to-futures'?this.getFuturesAccount():this.getSpotAccount());}
    catch(err){if(err.type==='API_ERROR')err.message+='; verify Permits Universal Transfer permission';throw err;}
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
    try {return normalizeOrder(res);}catch {throw new BinanceError('Entry response invalid; submission result unknown',{type:'AMBIGUOUS_STATE'});}
  },

  async _tradeRules(symbol,type,quantity,prices=[]) {
    const contract=await this.getContract(symbol),filters=requireArray(contract.filters,'filters');
    const lot=filters.find(x=>x.filterType===(type==='MARKET'?'MARKET_LOT_SIZE':'LOT_SIZE'));
    const priceRule=filters.find(x=>x.filterType==='PRICE_FILTER');
    const notionalRule=filters.find(x=>['MIN_NOTIONAL','NOTIONAL'].includes(x.filterType));
    if(!lot||!priceRule||!notionalRule)throw new BinanceError('Missing contract constraints',{type:'API_ERROR'});
    const q=D.floorStep(positive(quantity),positive(lot.stepSize));positive(q);
    if(D.compare(q,lot.minQty)<0||D.compare(q,lot.maxQty)>0)throw paramsError('Quantity outside contract limits');
    for(const price of prices){positive(price);if(!D.onStep(price,priceRule.tickSize)||D.compare(price,priceRule.minPrice)<0||D.compare(price,priceRule.maxPrice)>0)throw paramsError('Price violates PRICE_FILTER');}
    return {contract,quantity:q,minNotional:String(notionalRule.notional??notionalRule.minNotional),priceRule};
  },
  async _directionMode(direction) {
    if(!['LONG','SHORT'].includes(direction))throw paramsError('Direction must be LONG or SHORT');
    const mode=await this.getPositionMode();return {hedge:mode.dualSidePosition,wireSide:mode.dualSidePosition?direction:'BOTH'};
  },
  _matchPosition(positions,direction,mode) {
    requireArray(positions,'positions');
    const matches=positions.filter(p=>mode.hedge?p.positionSide===direction:p.positionSide==='BOTH'&&(direction==='LONG'?Number(p.positionAmt)>0:Number(p.positionAmt)<0));
    if(matches.length>1)throw new BinanceError('Multiple matching positions',{type:'AMBIGUOUS_STATE'});return matches[0];
  },
  async _entryPreflight(input) {
    const {symbol,side,positionSide,quantity,type='MARKET',price,stopLossPrice,takeProfitPrice}=input;
    const cleanSymbol=name(symbol),direction=name(positionSide),orderSide=name(side);
    if(!['LONG','SHORT'].includes(direction)||orderSide!==(direction==='LONG'?'BUY':'SELL')||!['MARKET','LIMIT'].includes(type))throw paramsError('Entry side/direction/type mismatch');
    positive(quantity);positive(stopLossPrice);positive(takeProfitPrice);if(type==='LIMIT')positive(price);
    const maxAgeMs=Number(input.maxAgeMs??30000);if(!Number.isInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>120000)throw paramsError('Invalid max age');
    const [mode,rules,ticker,positions,orders,algos,account,depth,commission]=await Promise.all([
      this._directionMode(direction),this._tradeRules(cleanSymbol,type,quantity,[stopLossPrice,takeProfitPrice,...(type==='LIMIT'?[price]:[])]),
      httpRequest(`${FAPI_HOST}/fapi/v1/ticker/price?symbol=${cleanSymbol}`),this.getPositionRisk(cleanSymbol),this.getOpenOrders(cleanSymbol),this.getOpenAlgos(cleanSymbol),this.getFuturesAccount(),
      httpRequest(`${FAPI_HOST}/fapi/v1/depth?symbol=${cleanSymbol}&limit=100`),signedReq(FAPI_HOST,'/fapi/v1/commissionRate',{symbol:cleanSymbol})]);
    const market=positive(ticker.price);if(!Number.isFinite(Number(ticker.time))||Math.abs(now()-Number(ticker.time))>maxAgeMs)throw paramsError('Market price stale or timestamp missing');
    const ref=type==='LIMIT'?positive(price):market;_validatePriceBounds(direction,ref,stopLossPrice,takeProfitPrice);
    const blockers=[];if(account.canTrade!==true)blockers.push('Trading permission disabled or unknown');if(positions.length)blockers.push('Existing position: adding, hedging and reversing are disabled');if(orders.length)blockers.push('Pending entry order exists');if(algos.length)blockers.push('Existing algorithm orders require reconciliation');
    const q=rules.quantity,notional=D.multiply(q,ref);
    if(D.compare(notional,rules.minNotional)<0)throw paramsError('Order below minimum notional');
    const config=account.positions.find(p=>p.symbol===cleanSymbol&&p.positionSide===mode.wireSide);
    const leverage=config?.leverage!==undefined?Number(config.leverage):NaN;
    const fees=positiveOrZero(commission.takerCommissionRate);
    if(D.compare(fees,'1')>=0)throw new BinanceError('Invalid commission rate',{type:'API_ERROR'});
    let available=account.availableBalance;try{available=positiveOrZero(available);}catch{available=undefined;blockers.push('Available margin unknown or invalid');}
    const levels=requireArray(direction==='LONG'?depth.asks:depth.bids,'execution depth');
    let remaining=q,cost='0',marketableRemaining=q,marketableCost='0';
    for(const level of levels){
      if(!Array.isArray(level)||level.length<2)throw new BinanceError('Invalid depth level',{type:'API_ERROR'});
      const p=positive(level[0]),size=positiveOrZero(level[1]),filled=D.compare(remaining,size)<0?remaining:size;
      cost=D.add(cost,D.multiply(filled,p));remaining=D.subtract(remaining,filled);
      if(type==='LIMIT'&&(direction==='LONG'?D.compare(p,ref)<=0:D.compare(p,ref)>=0)) {
        const eligible=D.compare(marketableRemaining,size)<0?marketableRemaining:size;
        marketableCost=D.add(marketableCost,D.multiply(eligible,p));marketableRemaining=D.subtract(marketableRemaining,eligible);
      }
      if(D.compare(remaining,'0')===0)break;
    }
    if(depth.E===undefined||!Number.isFinite(Number(depth.E))||Math.abs(now()-Number(depth.E))>maxAgeMs)blockers.push('Orderbook timestamp missing or stale');
    const vwap=D.compare(remaining,'0')>0?null:D.divide(cost,q);
    if(!Number.isFinite(leverage)||leverage<=0)blockers.push('Current leverage unknown');
    const required=['riskUsd','maxNotionalUsd','maxLeverage','maxSlippageBps'];
    for(const key of required) {if(input[key]===undefined)blockers.push(key+' is required');else key==='maxSlippageBps'?positiveOrZero(input[key]):positive(input[key]);}
    const estimates=[executionRisk(direction,q,ref,String(stopLossPrice),fees,ref,leverage)];
    if(type==='MARKET'&&vwap!==null||type==='LIMIT'&&D.compare(marketableRemaining,q)<0){
      // Bound a repeating VWAP on both sides, retaining exact weighted depth cost.
      // A marketable limit can fill at better prices; residual potential fill is bounded at its limit.
      const executionCost=type==='LIMIT'?D.add(marketableCost,D.multiply(marketableRemaining,ref)):cost;
      for(const executionPrice of new Set([D.divide(executionCost,q),D.divide(executionCost,q,{roundUp:true})])) {
        try{_validatePriceBounds(direction,executionPrice,stopLossPrice,takeProfitPrice);}catch(err){blockers.push('Expected fill invalidates protection geometry: '+err.message);}
        estimates.push(executionRisk(direction,q,executionPrice,String(stopLossPrice),fees,ref,leverage));
      }
    }
    if(vwap===null)blockers.push('Insufficient executable depth');
    for(const estimate of estimates){
      blockers.push(...executionRiskBlockers(estimate,input,available,leverage));
      if(D.compare(estimate.notionalUsd,rules.minNotional)<0)blockers.push('Expected execution below minimum notional');
    }
    const largest=field=>estimates.reduce((a,b)=>D.compare(a[field],b[field])>=0?a:b)[field];
    const slippage=vwap===null?null:Math.max(...estimates.map(r=>r.slippageBps));
    const uniqueBlockers=[...new Set(blockers)];
    return {symbol:cleanSymbol,direction,wireSide:mode.wireSide,hedge:mode.hedge,side:orderSide,type,quantity:q,requestedQuantity:String(quantity),referencePrice:ref,price:type==='LIMIT'?String(price):undefined,stopLossPrice:String(stopLossPrice),takeProfitPrice:String(takeProfitPrice),notional:largest('notionalUsd'),lossAtStopUsd:Number(largest('lossAtStopUsd')),knownFees:{entryUsd:largest('entryFeeUsd'),stopExitUsd:largest('stopExitFeeUsd')},commissionRate:fees,availableMarginBefore:available??null,executionEstimates:estimates,fundingCostStatus:'UNKNOWN',leverage,slippageBps:slippage,checkedAt:new Date(now()).toISOString(),blockers:uniqueBlockers,readyForApproval:uniqueBlockers.length===0};
  },
  async _lookupEntry(symbol,clientOrderId) {
    try{return await this.getOrder(symbol,{origClientOrderId:clientOrderId});}catch(err){if(err.code===-2013)return null;throw err;}
  },
  async reconcile(symbol,requestId) {
    if(!requestId)throw paramsError('Explicit request ID required');const sym=name(symbol),tx=new TransactionContext(requestId);
    const blockers=[],queryErrors=[],nextActions=[],terminal=['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'];
    const owned=a=>a&&owner(a)&&a.clientAlgoId.startsWith(tx.correlationId+'_');
    const recordError=(source,err)=>{queryErrors.push({source,type:err.type||'API_ERROR',code:err.code??null,message:err.message});blockers.push(source+' could not be verified');};
    const read=async(source,operation)=>{try{return await operation();}catch(err){recordError(source,err);return null;}};
    const snapshot=()=>Promise.all([
      read('entry',()=>this._lookupEntry(sym,tx.entryClientOrderId)),read('positions',()=>this.getPositionRisk(sym)),
      read('openOrders',()=>this.getOpenOrders(sym)),read('openAlgos',()=>this.getOpenAlgos(sym)),read('positionMode',()=>this.getPositionMode()),
      read('contractTicker',()=>httpRequest(`${FAPI_HOST}/fapi/v1/ticker/price?symbol=${sym}`))]);
    const initial=await snapshot(),historyEnd=now(),historyStart=Math.max(0,historyEnd-7*24*60*60*1000+1);
    // History is bounded and subject to exchange retention; absence never proves an order was not submitted.
    const history=await read('algoHistory',async()=>requireArray(await signedReq(FAPI_HOST,'/fapi/v1/allAlgoOrders',{symbol:sym,startTime:String(historyStart),endTime:String(historyEnd),limit:'1000'}),'algo history'));
    const candidates=[...(initial[3]||[]),...(history||[])].filter(owned),verified=new Map(),lookups=[];
    for(const row of candidates) {
      try{const id=exchangeId(row.algoId);if(!lookups.some(x=>x.algoId===id))lookups.push({algoId:id,clientAlgoId:row.clientAlgoId});}
      catch(err){recordError('algoIdentity',err);}
    }
    for(const clientAlgoId of [tx.slClientOrderId,tx.tpClientOrderId])if(!lookups.some(x=>x.clientAlgoId===clientAlgoId))lookups.push({clientAlgoId});
    for(let offset=0;offset<lookups.length;offset+=5)await Promise.all(lookups.slice(offset,offset+5).map(async identity=>{
      try {
        const row=await signedReq(FAPI_HOST,'/fapi/v1/algoOrder',identity.algoId?{algoId:identity.algoId}:{clientAlgoId:identity.clientAlgoId});
        if(!owned(row)||row.symbol!==sym||row.clientAlgoId!==identity.clientAlgoId||(identity.algoId&&exchangeId(row.algoId)!==identity.algoId)||!row.algoStatus)throw new BinanceError('Algo query identity or status mismatch',{type:'API_ERROR'});
        verified.set(exchangeId(row.algoId),row);
      }catch(err){if(![-2011,-2013].includes(err.code))recordError('algoStatus:'+identity.clientAlgoId,err);}
    }));
    const triggeredProtection=[];
    const triggeredRows=[...verified.values()].filter(row=>['TRIGGERED','FINISHED'].includes(row.algoStatus)||!['',null,undefined,'0',0].includes(row.actualOrderId)||![null,undefined,'0',0].includes(row.triggerTime));
    for(let offset=0;offset<triggeredRows.length;offset+=5)await Promise.all(triggeredRows.slice(offset,offset+5).map(async row=>{
      const evidence={algoId:exchangeId(row.algoId),clientAlgoId:row.clientAlgoId,algoStatus:row.algoStatus,triggerTime:row.triggerTime??null,actualOrderId:row.actualOrderId??null,executionStatus:'UNKNOWN',executedQty:null};
      if(row.actualOrderId!==undefined&&row.actualOrderId!==null&&!['','0'].includes(String(row.actualOrderId))) {
        const actual=await read('triggeredOrder:'+row.clientAlgoId,()=>this.getOrder(sym,{orderId:exchangeId(row.actualOrderId)}));
        if(actual&&actual.symbol===sym&&actual.side===row.side&&actual.positionSide===row.positionSide) {evidence.executionStatus=actual.status;evidence.executedQty=actual.executedQty;}
        else if(actual)recordError('triggeredOrderIdentity',new BinanceError('Triggered order identity mismatch',{type:'API_ERROR'}));
      }
      triggeredProtection.push(evidence);
    }));
    if(triggeredProtection.some(row=>!terminal.includes(row.executionStatus))) {
      blockers.push('Triggered protection execution is pending or unverified');
      nextActions.push('Verify the triggered protective order terminal state before resolving this lifecycle');
    }
    // Re-read core state after history/status queries so an old NEW leg cannot confirm a now-flat or changed position.
    const [rawEntry,positions,orders,algos,mode,ticker]=await snapshot();let entry=rawEntry,direction=null,matchingPosition=null;
    if(entry) {
      try {entry=normalizeOrder(entry);if(entry.symbol!==sym||entry.clientOrderId!==tx.entryClientOrderId||!['MARKET','LIMIT'].includes(entry.type))throw new BinanceError('Entry identity mismatch',{type:'API_ERROR'});direction=entry.side==='BUY'?'LONG':'SHORT';}
      catch(err){recordError('entryIdentity',err);entry=null;}
    }
    if(!entry)blockers.push('Entry absent or unverified; request ID cannot be safely reused');
    const entryTerminal=entry?terminal.includes(entry.status):null,filledQuantity=entry?entry.executedQty:null;
    let pendingEntries=null;
    if(orders) {
      try {pendingEntries=orders.filter(o=>o?.clientOrderId===tx.entryClientOrderId).map(o=>{
        const normalized=normalizeOrder(o);if(normalized.symbol!==sym||terminal.includes(normalized.status))throw new BinanceError('Invalid pending entry snapshot',{type:'API_ERROR'});return normalized;
      });}catch(err){recordError('pendingEntries',err);}
    }
    if(entry&&mode) {
      if(typeof mode.dualSidePosition!=='boolean')recordError('positionMode',new BinanceError('Position mode unknown',{type:'API_ERROR'}));
      else if(entry.positionSide!==(mode.dualSidePosition?direction:'BOTH'))blockers.push('Entry direction does not match current position mode');
      else if(positions) {
        try {
          for(const p of positions)if(p.symbol!==sym||(mode.dualSidePosition?p.positionSide==='BOTH':p.positionSide!=='BOTH')||(p.positionSide==='LONG'&&String(p.positionAmt).startsWith('-'))||(p.positionSide==='SHORT'&&!String(p.positionAmt).startsWith('-')))throw new BinanceError('Position direction or mode mismatch',{type:'API_ERROR'});
          matchingPosition=this._matchPosition(positions,direction,{hedge:mode.dualSidePosition})||null;
          if(positions.some(p=>p!==matchingPosition))blockers.push('Unexpected other or opposite exposure exists');
          if(matchingPosition&&D.compare(absQty(matchingPosition.positionAmt),filledQuantity)>0)blockers.push('Current position exceeds this entry fill; exposure attribution is unknown');
        }catch(err){recordError('matchingPosition',err);}
      }
    }
    const protection=algos?algos.filter(owned):null,effective={stopLoss:[],takeProfit:[]},invalidProtection=[];
    for(const row of protection||[]) {
      let reason=null;
      try {
        const id=exchangeId(row.algoId),statusRow=verified.get(id),type=row.orderType||row.type;
        if(!statusRow)reason='Not verified by individual algo query; reconcile again';
        else if(!['NEW','WORKING'].includes(row.algoStatus)||!['NEW','WORKING'].includes(statusRow.algoStatus))reason='Not active';
        else if([row,statusRow].some(a=>!['',null,undefined,'0',0].includes(a.actualOrderId)||![null,undefined,'0',0].includes(a.triggerTime)))reason='Triggered order cannot count as active protection';
        else if(!entry||!mode||typeof mode.dualSidePosition!=='boolean'||row.symbol!==sym||row.positionSide!==(mode.dualSidePosition?direction:'BOTH')||row.side!==(direction==='LONG'?'SELL':'BUY'))reason='Wrong symbol, direction or position mode';
        else if(type!==(row.clientAlgoId.slice(tx.correlationId.length+1,tx.correlationId.length+3)==='SL'?'STOP_MARKET':'TAKE_PROFIT_MARKET'))reason='Wrong protective order type';
        else if(!['true',true].includes(row.closePosition)||!['true',true].includes(statusRow.closePosition)||row.workingType!=='CONTRACT_PRICE'||statusRow.workingType!==row.workingType)reason='Full close-all protection or trigger basis unverified';
        else if(statusRow.side!==row.side||statusRow.positionSide!==row.positionSide||(statusRow.orderType||statusRow.type)!==type||D.compare(positive(row.triggerPrice),positive(statusRow.triggerPrice))!==0)reason='Protection changed during reconciliation';
        else {
          const ref=ticker?.price;if(ref===undefined||ticker.symbol!==sym||!Number.isFinite(Number(ticker.time))||Math.abs(now()-Number(ticker.time))>30000)reason='Fresh contract price unavailable for trigger validation';
          else _validatePriceBounds(direction,positive(ref),type==='STOP_MARKET'?row.triggerPrice:undefined,type==='TAKE_PROFIT_MARKET'?row.triggerPrice:undefined);
        }
        if(!reason)effective[type==='STOP_MARKET'?'stopLoss':'takeProfit'].push(row);
      }catch(err){reason=err.message;}
      if(reason)invalidProtection.push({algoId:row.algoId??null,clientAlgoId:row.clientAlgoId,reason});
    }
    if(invalidProtection.length)blockers.push('Owned open protection contains invalid or unverified legs');
    const flat=positions?positions.length===0:null,hasFill=filledQuantity===null?null:D.compare(filledQuantity,'0')>0;
    const covered=matchingPosition?effective.stopLoss.length>0&&effective.takeProfit.length>0:false;
    if(entryTerminal===false||pendingEntries?.length) {blockers.push('Entry remains pending; fills may still increase');nextActions.push('Handle this request entry remainder with explicit authorization, then reconcile');}
    if(entryTerminal===true&&pendingEntries?.length)blockers.push('Terminal entry conflicts with pending entry snapshot');
    if(hasFill&&matchingPosition&&!covered) {blockers.push('Current position lacks verified owned SL and TP coverage');nextActions.push('Maintain or repair both owned protective legs under explicit authorization, then reconcile');}
    if(hasFill&&flat)nextActions.push('Review triggered leg evidence and closure cause; flat snapshot does not prove rollback was executed');
    if(flat&&protection?.length) {blockers.push('Flat symbol retains owned active protection');nextActions.push('Clean up owned protection only after authorized flat-state verification');}
    if(hasFill===false&&positions?.length)blockers.push('Exposure exists despite zero entry fill');
    let status='UNKNOWN',outcome='UNRESOLVED';
    if(!blockers.length&&entryTerminal&&pendingEntries?.length===0) {
      if(hasFill&&matchingPosition&&covered) {status='CONFIRMED';outcome='OPEN_PROTECTED';}
      else if(hasFill&&flat) {status='CONFIRMED';outcome='FLAT_AFTER_FILL';}
      else if(hasFill===false&&flat) {status='FAILED';outcome='ENTRY_TERMINAL_WITHOUT_FILL';}
    }else if(!queryErrors.length&&entry&&!entryTerminal&&pendingEntries?.length===1&&(!hasFill&&flat||hasFill&&matchingPosition&&covered)&&blockers.every(b=>b==='Entry remains pending; fills may still increase')) {status='SUBMITTED';outcome='ENTRY_PENDING';}
    if(!nextActions.length)nextActions.push(status==='CONFIRMED'?'Current state verified; continue position monitoring':'Reconcile missing or conflicting evidence before any further execution');
    nextActions.push('Do not resubmit this entry request ID');
    return {symbol:sym,requestId:tx.requestId,correlationId:tx.correlationId,status,outcome,readOnly:true,entry,entryAccepted:entry?entry.status!=='REJECTED':null,entrySucceeded:hasFill,entryTerminal,filledQuantity,direction,positionMode:mode,positions,matchingPosition,flat,pendingEntries,protection,
      protectionCoverage:{status:matchingPosition?(covered?'COVERED':'UNVERIFIED'):flat?'NOT_REQUIRED':'UNKNOWN',fullPosition:matchingPosition?absQty(matchingPosition.positionAmt):null,stopLoss:effective.stopLoss,takeProfit:effective.takeProfit,invalid:invalidProtection},
      triggeredProtection,closureCause:hasFill&&flat?(triggeredProtection.some(p=>p.executionStatus==='FILLED')?'OWNED_PROTECTION_EXECUTION_OBSERVED':'UNKNOWN'):null,
      algoHistory:{status:history?'OK':'UNKNOWN',startTime:historyStart,endTime:historyEnd,limit:1000,possiblyTruncated:history?history.length===1000:null,scope:'Bounded recent history with exchange retention; missing records do not prove non-submission'},
      blockers:[...new Set(blockers)],queryErrors,checkedAt:new Date(now()).toISOString(),nextActions,nextAction:nextActions.join('; ')};
  },
  async openPositionWithTPSL(input) {
    modeFlags(input);const symbol=name(input.symbol),tx=new TransactionContext(input.requestId||input.clientOrderId);
    const waitMs=Number(input.waitMs??30000);if(!Number.isInteger(waitMs)||waitMs<1||waitMs>120000)throw paramsError('wait-ms must be 1..120000');
    if(!input.dryRun&&input.requestId) {
      const prior=await this._lookupEntry(symbol,tx.entryClientOrderId);
      if(prior) {
        const direction=name(input.positionSide),side=name(input.side),type=input.type??'MARKET';
        if(!['LONG','SHORT'].includes(direction)||side!==(direction==='LONG'?'BUY':'SELL')||!['MARKET','LIMIT'].includes(type))throw paramsError('Entry side/direction/type mismatch');
        const [mode,rules]=await Promise.all([this._directionMode(direction),this._tradeRules(symbol,type,input.quantity,type==='LIMIT'?[input.price]:[])]);
        if(prior.symbol!==symbol||prior.side!==side||prior.positionSide!==mode.wireSide||prior.type!==type||D.compare(prior.origQty,rules.quantity)!==0||(type==='LIMIT'&&D.compare(prior.price,positive(input.price))!==0))throw paramsError('Request ID already used for a different intent');
        const snapshot=await this.reconcile(symbol,input.requestId);
        return {...snapshot,replayed:true};
      }
    }
    const plan=await this._entryPreflight(input);
    const entryParams={symbol,side:plan.side,positionSide:plan.wireSide,type:plan.type,quantity:plan.quantity,newClientOrderId:tx.entryClientOrderId,newOrderRespType:'RESULT',...(plan.type==='LIMIT'?{price:plan.price,timeInForce:'GTC'}:{})};
    if(input.dryRun)return {status:'PREVIEW',dryRun:true,requestId:tx.requestId,plan,requests:{entry:entryParams},readyForApproval:plan.readyForApproval};
    if(plan.blockers.length)throw paramsError(plan.blockers.join('; '));
    let entry;
    try{entry=await this.placeOrder(entryParams);}catch(err) {
      if(!ambiguous(err))throw err;
      for(let i=0;i<3;i++){await sleep(400*(i+1));try{entry=await this._lookupEntry(symbol,tx.entryClientOrderId);if(entry)break;}catch{}}
      if(!entry)throw new BinanceError('Entry result unknown; use reconcile --request-id '+tx.requestId,{type:'AMBIGUOUS_STATE'});
    }
    let knownFilledQuantity=entry.executedQty;
    try {
      const started=now();let protectedQuantity='0',protection=null,actualExecutionRisk=null;
      const maxChecks=Math.ceil(waitMs/200)+5;
      for(let checks=0;checks<maxChecks;checks++) {
        positiveOrZero(entry.executedQty);
        if(D.compare(entry.executedQty,knownFilledQuantity)<0)throw new BinanceError('Cumulative executed quantity regressed; reconcile before further action',{type:'AMBIGUOUS_STATE'});
        knownFilledQuantity=entry.executedQty;
        if(D.compare(entry.executedQty,protectedQuantity)>0) {
          const snapshot=await this.getPositionRisk(symbol),mode={hedge:plan.hedge};const pos=this._matchPosition(snapshot,plan.direction,mode);
          if(!pos)throw new BinanceError('Filled entry without a confirmed position',{type:'AMBIGUOUS_STATE'});
          protection=await this.setTPSL({symbol,positionSide:plan.direction,quantity:absQty(pos.positionAmt),stopLossPrice:plan.stopLossPrice,takeProfitPrice:plan.takeProfitPrice,clientAlgoIdPrefix:tx.correlationId,manageRef:entry.avgPrice&&Number(entry.avgPrice)>0?entry.avgPrice:plan.referencePrice});
          protectedQuantity=entry.executedQty;
          const fillPrice=Number(entry.avgPrice)>0?positive(entry.avgPrice):positive(pos.entryPrice);
          _validatePriceBounds(plan.direction,fillPrice,plan.stopLossPrice,plan.takeProfitPrice);
          actualExecutionRisk=executionRisk(plan.direction,entry.executedQty,fillPrice,plan.stopLossPrice,plan.commissionRate,plan.referencePrice,plan.leverage);
          const violations=executionRiskBlockers(actualExecutionRisk,input,plan.availableMarginBefore??undefined,plan.leverage);
          if(violations.length)throw paramsError('Actual fill violates approved limits: '+violations.join('; '));

        }
        if(['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(entry.status))break;
        if(now()-started>=waitMs||checks===maxChecks-2) {entry=await this._cancelAndVerifyEntry(symbol,entry);continue;}
        await sleep(200);entry=await this.getOrder(symbol,{orderId:entry.orderId});
      }
      const fresh=await this.getOrder(symbol,{orderId:entry.orderId});
      if(D.compare(fresh.executedQty,knownFilledQuantity)<0)throw new BinanceError('Final cumulative executed quantity regressed',{type:'AMBIGUOUS_STATE'});
      if(!['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(fresh.status))throw new BinanceError('Entry remains pending',{type:'AMBIGUOUS_STATE'});
      if(D.compare(fresh.executedQty,protectedQuantity)>0)throw new BinanceError('Fill increased after last protection update',{type:'AMBIGUOUS_STATE'});
      const positions=await this.getPositionRisk(symbol),pos=this._matchPosition(positions,plan.direction,{hedge:plan.hedge});
      if(D.compare(fresh.executedQty,'0')>0 && !pos)throw new BinanceError('Position disappeared; reconcile triggered protection',{type:'AMBIGUOUS_STATE'});
      if(pos&&D.compare(fresh.executedQty,'0')>0) {
        const finalPrice=Number(fresh.avgPrice)>0?positive(fresh.avgPrice):positive(pos.entryPrice);
        _validatePriceBounds(plan.direction,finalPrice,plan.stopLossPrice,plan.takeProfitPrice);
        actualExecutionRisk=executionRisk(plan.direction,fresh.executedQty,finalPrice,plan.stopLossPrice,plan.commissionRate,plan.referencePrice,plan.leverage);
        const finalViolations=executionRiskBlockers(actualExecutionRisk,input,plan.availableMarginBefore??undefined,plan.leverage);
        if(finalViolations.length)throw paramsError('Final fill violates approved limits: '+finalViolations.join('; '));
        if(D.compare(absQty(pos.positionAmt),fresh.executedQty)!==0)throw new BinanceError('Current exposure differs from this entry fill; reconcile attribution',{type:'AMBIGUOUS_STATE'});
        const active=await this.getOpenAlgos(symbol);
        for(const [key,type,trigger] of [['stopLoss','STOP_MARKET',plan.stopLossPrice],['takeProfit','TAKE_PROFIT_MARKET',plan.takeProfitPrice]]) {
          const leg=active.find(a=>String(a.algoId)===String(protection?.[key]?.algoId));
          if(!leg||!owner(leg)||!leg.clientAlgoId.startsWith(tx.correlationId+'_')||leg.symbol!==symbol||leg.positionSide!==plan.wireSide||leg.side!==(plan.direction==='LONG'?'SELL':'BUY')||
            (leg.orderType||leg.type)!==type||!['NEW','WORKING'].includes(leg.algoStatus)||!['true',true].includes(leg.closePosition)||leg.workingType!=='CONTRACT_PRICE'||
            !['',null,undefined,'0',0].includes(leg.actualOrderId)||![null,undefined,'0',0].includes(leg.triggerTime)||D.compare(positive(leg.triggerPrice),trigger)!==0)throw new BinanceError('Final protective coverage could not be verified',{type:'AMBIGUOUS_STATE'});
        }
      }
      if(D.compare(fresh.executedQty,'0')===0)return {status:'FAILED',requestId:tx.requestId,correlationId:tx.correlationId,entrySucceeded:false,entryAccepted:true,tpslSucceeded:false,entry:fresh,filledQuantity:'0',plan,error:'Entry terminated without a fill'};
      return {status:'CONFIRMED',requestId:tx.requestId,correlationId:tx.correlationId,entrySucceeded:D.compare(fresh.executedQty,'0')>0,entryAccepted:true,tpslSucceeded:!!protection,entry:fresh,tpsl:protection,filledQuantity:fresh.executedQty,actualExecutionRisk,plan};
    }catch(err){
      if(D.compare(entry.executedQty,knownFilledQuantity)<0)return {status:'UNKNOWN',requestId:tx.requestId,entrySucceeded:D.compare(knownFilledQuantity,'0')>0,knownFilledQuantity,error:err.message,nextAction:'Reconcile inconsistent cumulative fills; protection retained, do not resubmit'};
      return this._rollbackEntry(symbol,plan.direction,entry,tx,err);
    }
  },
  async _cancelAndVerifyEntry(symbol,entry) {
    if(!['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(entry.status)) {
      try{await this.cancelOrder(symbol,entry.orderId);}catch(err){if(!ambiguous(err)&&![-2011,-2013].includes(err.code))throw err;}
    }
    const final=await this.getOrder(symbol,{orderId:entry.orderId});
    if(D.compare(final.executedQty,entry.executedQty)<0)throw new BinanceError('Cumulative executed quantity regressed during cancellation',{type:'AMBIGUOUS_STATE'});
    if(!['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(final.status))throw new BinanceError('Entry cancellation not confirmed',{type:'AMBIGUOUS_STATE'});return final;
  },
  async _rollbackEntry(symbol,direction,entry,tx,cause) {
    try {
      const final=await this._cancelAndVerifyEntry(symbol,entry);
      const result=await this.closePosition(symbol,direction,{requestPrefix:tx.correlationId});
      if(result.closeSuccess!==true)throw new BinanceError('Rollback not verified',{type:'AMBIGUOUS_STATE'});
      return {status:'FAILED',requestId:tx.requestId,entrySucceeded:D.compare(final.executedQty,'0')>0,tpslSucceeded:false,rollbackSucceeded:true,entry:final,error:cause.message,protectionResult:cause.protectionResult??null,rollbackClose:result};
    }catch(err){return {status:'UNKNOWN',requestId:tx.requestId,entrySucceeded:D.compare(entry.executedQty,'0')>0,tpslSucceeded:false,rollbackSucceeded:false,error:cause.message,protectionResult:cause.protectionResult??null,rollbackError:err.message,nextAction:'Reconcile entry, positions and existing protection; do not resubmit'};}
  },
  async closePosition(symbol,positionSide,options={}) {
    const sym=name(symbol),[modeInfo,positions,orders]=await Promise.all([this.getPositionMode(),this.getPositionRisk(sym),this.getOpenOrders(sym)]);
    const mode={hedge:modeInfo.dualSidePosition};
    if(!positionSide&&positions.length>1)throw paramsError('Explicit direction required for multiple positions');
    let direction=positionSide?name(positionSide):positions[0]?(Number(positions[0].positionAmt)>0?'LONG':'SHORT'):null;
    if(direction&&!['LONG','SHORT'].includes(direction))throw paramsError('Invalid close direction');
    for(const order of orders) {
      if(!/^BAN_[a-f0-9]{24}_ENT$/.test(order.clientOrderId||''))continue;
      if(options.requestPrefix&&!order.clientOrderId.startsWith(options.requestPrefix+'_'))continue;
      if(direction&&(order.side!==(direction==='LONG'?'BUY':'SELL') || mode.hedge&&order.positionSide!==direction))continue;
      await this._cancelAndVerifyEntry(sym,normalizeOrder(order));
    }
    const refreshed=await this.getPositionRisk(sym);
    if(!direction&&refreshed.length>1)throw new BinanceError('Exposure became ambiguous during cancellation',{type:'AMBIGUOUS_STATE'});
    if(!direction&&refreshed.length===1)direction=Number(refreshed[0].positionAmt)>0?'LONG':'SHORT';
    const target=direction?this._matchPosition(refreshed,direction,mode):null;
    if(!target) {
      const opposite=direction&&refreshed.length>0;
      if(opposite)return {closeSuccess:false,status:'FAILED',message:'Requested direction does not match existing exposure'};
      return {closeSuccess:true,status:'CONFIRMED',alreadyFlat:true,cancelledAlgos:direction?await this._clearOwnedProtection(sym,mode.hedge?direction:'BOTH',options.requestPrefix):[]};
    }
    const qty=absQty(target.positionAmt),closeSide=direction==='LONG'?'SELL':'BUY';
    const closeParams={symbol:sym,side:closeSide,type:'MARKET',quantity:qty,positionSide:mode.hedge?direction:'BOTH',newClientOrderId:generateClientOrderId('BAN_CLOSE'),...(mode.hedge?{}:{reduceOnly:'true'})};
    let closeOrder;try{closeOrder=await this.placeOrder(closeParams);}catch(err){if(!ambiguous(err))throw err;closeOrder=null;}
    for(let i=0;i<5;i++){await sleep(200);const fresh=await this.getPositionRisk(sym);const remaining=this._matchPosition(fresh,direction,mode);
      if(!remaining) {if(!mode.hedge&&fresh.length)throw new BinanceError('Unexpected reverse exposure after close',{type:'AMBIGUOUS_STATE'});return {closeSuccess:true,status:'CONFIRMED',closeOrder,cancelledAlgos:await this._clearOwnedProtection(sym,mode.hedge?direction:'BOTH',options.requestPrefix)};}
    }
    return {closeSuccess:false,status:'UNKNOWN',closeOrder,message:'Residual position; protection retained'};
  },
  async _clearOwnedProtection(symbol,wireSide,prefix) {
    const algos=await this.getOpenAlgos(symbol),cancelled=[];
    for(const a of algos)if(a.positionSide===wireSide&&owner(a)&&(!prefix||a.clientAlgoId.startsWith(prefix+'_')))cancelled.push(await this.cancelAlgoOrder(a.algoId));return cancelled;
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
    const id=exchangeId(algoId);let ack;
    try{ack=await signedReq(FAPI_HOST, '/fapi/v1/algoOrder', { algoId:id }, 'DELETE');}catch(err){if(!ambiguous(err)&&![-2011,-2013].includes(err.code))throw err;}
    try{const row=await signedReq(FAPI_HOST,'/fapi/v1/algoOrder',{algoId:id});if(['CANCELED','CANCELLED','EXPIRED','FINISHED','REJECTED'].includes(row.algoStatus))return {algoId:id,cancelConfirmed:true,ack,rawStatus:row.algoStatus};}
    catch(err){if(![-2011,-2013].includes(err.code))throw new BinanceError('Protection cancellation result unknown',{type:'AMBIGUOUS_STATE'});const open=await this.getOpenAlgos();if(!open.some(a=>String(a.algoId)===id))return {algoId:id,cancelConfirmed:true,ack,rawStatus:'ABSENT'};}
    throw new BinanceError('Protection cancellation not confirmed',{type:'AMBIGUOUS_STATE'});
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

  async _confirmProtectiveLeg(params,algoId) {
    // Bound the entire read-after-write window, including HTTP timeouts. Never repeat the POST.
    const deadline=now()+3000;
    const validate=row=>{
      let identityValid=false;
      try{identityValid=!!row&&exchangeId(row.algoId)!==undefined&&(algoId===undefined||exchangeId(row.algoId)===algoId);}catch{}
      if(!identityValid||row.clientAlgoId!==params.clientAlgoId||row.symbol!==params.symbol||row.side!==params.side||row.positionSide!==params.positionSide||
        (row.orderType||row.type)!==params.type||row.workingType!==params.workingType||!['NEW','WORKING'].includes(row.algoStatus)||!['true',true].includes(row.closePosition)||
        !['',null,undefined,'0',0].includes(row.actualOrderId)||![null,undefined,'0',0].includes(row.triggerTime))throw new BinanceError('Protective leg not confirmed active or identity mismatch',{type:'AMBIGUOUS_STATE'});
      try{if(D.compare(positive(row.triggerPrice),params.triggerPrice)!==0)throw Error();}
      catch{throw new BinanceError('Protective trigger price mismatch',{type:'AMBIGUOUS_STATE'});}
      return row;
    };
    let lastError;
    const read=async(endpoint,query)=>{
      try{
        const row=await signedReq(FAPI_HOST,endpoint,query,'GET',0,deadline);
        if(now()>=deadline)throw new BinanceError('Read confirmation deadline exceeded',{type:'NETWORK'});
        return row;
      }
      catch(err){
        // Authentication, rate limits and malformed responses are not visibility delays.
        if(err.type==='RATE_LIMIT'||![-2011,-2013].includes(err.code)&&err.type!=='NETWORK'&&!(err.retryable&&err.httpStatus>=500&&err.httpStatus<600))throw err;
        lastError=err;return null;
      }
    };
    for(let attempt=0;attempt<3&&now()<deadline;attempt++) {
      const queries=[...(algoId===undefined?[]:[{algoId}]),{clientAlgoId:params.clientAlgoId}];
      for(const query of queries) {
        if(now()>=deadline)break;
        const row=await read('/fapi/v1/algoOrder',query);
        if(row!==null)return validate(row);
      }
      if(now()<deadline) {
        const rows=await read('/fapi/v1/openAlgoOrders',{symbol:params.symbol});
        if(rows!==null) {
          const matches=requireArray(rows,'open algo orders').filter(row=>row&&(row.clientAlgoId===params.clientAlgoId||algoId!==undefined&&String(row.algoId)===algoId));
          if(matches.length>1)throw new BinanceError('Conflicting protective order identities',{type:'AMBIGUOUS_STATE'});
          if(matches.length===1)return validate(matches[0]);
        }
      }
      if(attempt<2&&now()<deadline)await sleep(Math.min(200*(attempt+1),deadline-now()));
    }
    throw new BinanceError('Protective leg unconfirmed after bounded read-back'+(lastError?' ('+lastError.type+(lastError.code!==null?' '+lastError.code:'')+')':''),{type:'AMBIGUOUS_STATE'});
  },

  async setTPSL({symbol,positionSide,quantity,stopLossPrice,takeProfitPrice,cancelExisting=true,clientAlgoIdPrefix,manageRef,replaceAlgoIds=[]}) {
    const sym=name(symbol),direction=name(positionSide);
    if(stopLossPrice===undefined&&takeProfitPrice===undefined)throw paramsError('Provide at least one protective price');
    const mode=await this._directionMode(direction),positions=await this.getPositionRisk(sym),target=this._matchPosition(positions,direction,mode);
    if(!target)throw paramsError('No matching position for protection');
    const ticker=await httpRequest(`${FAPI_HOST}/fapi/v1/ticker/price?symbol=${sym}`);
    const ref=positive(ticker.price);if(!Number.isFinite(Number(ticker.time))||Math.abs(now()-Number(ticker.time))>30000)throw paramsError('Protection price stale');
    _validatePriceBounds(direction,ref,stopLossPrice,takeProfitPrice);
    const prices=[stopLossPrice,takeProfitPrice].filter(x=>x!==undefined);
    const actual=absQty(target.positionAmt);
    const rules=await this._tradeRules(sym,'MARKET',quantity??actual,prices);
    if(quantity!==undefined&&D.compare(rules.quantity,actual)!==0)throw paramsError('Protection quantity must cover the full current position');
    // Close-all protective legs track the full direction through partial fills and cannot reverse exposure.
    if(typeof cancelExisting!=='boolean'||!Array.isArray(replaceAlgoIds))throw paramsError('Invalid protection replacement options');
    const externalIds=replaceAlgoIds.map(exchangeId),old=await this.getOpenAlgos(sym);
    const related=old.filter(x=>x.symbol===sym&&x.positionSide===mode.wireSide&&x.side===(direction==='LONG'?'SELL':'BUY')&&owner(x));
    const prefixes=[...new Set(related.map(x=>x.clientAlgoId.slice(0,28)))];
    if(!clientAlgoIdPrefix&&prefixes.length>1)throw paramsError('Multiple protection request prefixes; specify the request ID to maintain');
    const prefix=clientAlgoIdPrefix||prefixes[0]||new TransactionContext().correlationId;
    if(!/^BAN_[a-f0-9]{24}$/.test(prefix))throw paramsError('Invalid protection ownership prefix');
    const priorIds=old.filter(x=>x.symbol===sym&&x.positionSide===mode.wireSide&&x.side===(direction==='LONG'?'SELL':'BUY')&&(owner(x)&&x.clientAlgoId.startsWith(prefix+'_')||externalIds.includes(String(x.algoId)))).map(x=>String(x.algoId));
    const results={symbol:sym,correlationId:prefix,status:'SUBMITTED',cancelled:[],submissions:[],retainedOldAlgoIds:priorIds,unknownCancellationAlgoIds:[],oldProtectionRetained:priorIds.length>0};
    const base={algoType:'CONDITIONAL',symbol:sym,side:direction==='SHORT'?'BUY':'SELL',positionSide:mode.wireSide,closePosition:'true',workingType:'CONTRACT_PRICE'};
    let pendingLeg=null,pendingCancellation=null;
    try {
    for(const [key,type,trigger] of [['stopLoss','STOP_MARKET',stopLossPrice],['takeProfit','TAKE_PROFIT_MARKET',takeProfitPrice]]) {
      if(trigger===undefined)continue;
      pendingLeg=key;
      const suffix=key==='stopLoss'?'SL':'TP';
      // Replacements retain request ownership with a fresh suffix; old legs remain until confirmation.
      const revision=old.some(x=>x.clientAlgoId?.startsWith(prefix+'_'+suffix))?crypto.randomBytes(2).toString('hex'):'';
      const params={...base,type,triggerPrice:String(trigger),clientAlgoId:prefix+'_'+suffix+revision};
      const submission={leg:key,clientAlgoId:params.clientAlgoId,status:'UNKNOWN'};results.submissions.push(submission);
      let created;
      try {created=await this.placeAlgoOrder(params);}catch(err) {
        if(!ambiguous(err)){submission.status='FAILED';throw err;}
      }
      let id;if(created!==undefined) {
        try{id=exchangeId(created?.algoId);}catch{throw new BinanceError('Invalid protective order identifier; reconcile client algo ID',{type:'AMBIGUOUS_STATE'});}
        submission.algoId=id;submission.status='SUBMITTED';
      }
      const verified=await this._confirmProtectiveLeg(params,id);
      submission.algoId=exchangeId(verified.algoId);
      submission.status='CONFIRMED';
      results[key]=verified;
    }
    pendingLeg=null;
    // Only confirmed new legs allow same-leg replacement; failure above leaves old legs untouched.
    if(cancelExisting)for(const order of old) {
      const orderType=order.orderType||order.type;
      const replace=orderType==='STOP_MARKET'&&results.stopLoss||orderType==='TAKE_PROFIT_MARKET'&&results.takeProfit;
      if(order.symbol===sym&&order.positionSide===mode.wireSide&&order.side===base.side&&replace&&(owner(order)&&order.clientAlgoId.startsWith(prefix+'_')||externalIds.includes(String(order.algoId)))) {
        pendingCancellation=String(order.algoId);results.cancelled.push(await this.cancelAlgoOrder(order.algoId));
        results.retainedOldAlgoIds=results.retainedOldAlgoIds.filter(id=>id!==pendingCancellation);pendingCancellation=null;
      }
    }
    }catch(err){
      const uncertain=ambiguous(err)||results.submissions.some(s=>s.status!=='FAILED');
      err.protectionResult={...results,status:uncertain?'UNKNOWN':'FAILED',failedLeg:pendingLeg,retainedOldAlgoIds:results.retainedOldAlgoIds.filter(id=>id!==pendingCancellation),unknownCancellationAlgoIds:pendingCancellation?[pendingCancellation]:[],oldProtectionRetained:pendingCancellation?null:results.retainedOldAlgoIds.length>0,nextAction:'Query current position and these client algo IDs before further maintenance; confirmed new legs remain active'};
      if(uncertain)err.status='UNKNOWN';throw err;
    }
    results.status='CONFIRMED';results.oldProtectionRetained=results.retainedOldAlgoIds.length>0;
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
  'redeem-earn': {minArgs:2,usage:'<productId> <amount> <--dry-run|--approved> [--precision-file <source-backed-rules.json>]',run:args=>Client.redeemEarn(args[0],args[1],cliOptions(args.slice(2)))},
  'transfer-to-futures': {minArgs:2,usage:'<asset> <amount> <--dry-run|--approved> [--precision-file <source-backed-rules.json>]',run:args=>Client.transferToFutures(args[0],args[1],cliOptions(args.slice(2)))},
  'transfer-from-futures': {minArgs:2,usage:'<asset> <amount> <--dry-run|--approved> [--min-margin-usd <reserve>] [--precision-file <source-backed-rules.json>]',run:args=>Client.transferFromFutures(args[0],args[1],cliOptions(args.slice(2)))},
  'earn-redemptions': {minArgs:1,usage:'<productId> [--redeem-id <id>]',run:args=>Client.getEarnRedemptions(args[0],cliOptions(args.slice(1)))},
  'transfer-history': {minArgs:1,usage:'<to-futures|from-futures> [--tran-id <id>]',run:args=>Client.getTransferHistory(args[0],cliOptions(args.slice(1)))},
  'reconcile': {minArgs:3,usage:'<symbol> --request-id <id>',run:args=>Client.reconcile(args[0],cliOptions(args.slice(1)).requestId)},
  'set-tpsl': {
    minArgs: 4, usage: '<symbol> <LONG|SHORT> <slPrice|-> <tpPrice|-> [qty] [--request-id <id>] [--replace-algo-id <id>]', desc: 'Bind TP/SL to existing position; - leaves a leg unchanged',
    run: args => {const hasQuantity=args[4]!==undefined&&!args[4].startsWith('--'),options=cliOptions(args.slice(hasQuantity?5:4));return Client.setTPSL({ symbol: args[0], positionSide: args[1], stopLossPrice: args[2]==='-'?undefined:args[2], takeProfitPrice: args[3]==='-'?undefined:args[3], quantity:hasQuantity?args[4]:undefined,clientAlgoIdPrefix:options.requestId?new TransactionContext(options.requestId).correlationId:undefined,replaceAlgoIds:options.replaceAlgoIds??[] });}
  },
  'open-tpsl': {
    minArgs:7, usage:'<symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <sl> <tp> <--dry-run|--approved> [risk flags]',
    desc:'Entry with verified protection and compensation',
    run:args=>{const [symbol,side,positionSide,quantity,rawType]=args;const type=String(rawType).toUpperCase();const n=type==='LIMIT'?8:7;if(!['LIMIT','MARKET'].includes(type)||args.length<n)throw paramsError('Invalid entry arguments');return Client.openPositionWithTPSL({symbol,side,positionSide,quantity,type,price:type==='LIMIT'?args[5]:undefined,stopLossPrice:args[n-2],takeProfitPrice:args[n-1],...cliOptions(args.slice(n))});}
  }

};

function cliOptions(args) {
 const opts={};const map={'--request-id':'requestId','--wait-ms':'waitMs','--risk-usd':'riskUsd','--max-notional-usd':'maxNotionalUsd','--max-leverage':'maxLeverage','--max-slippage-bps':'maxSlippageBps','--max-age-ms':'maxAgeMs','--min-margin-usd':'minMarginUsd','--redeem-id':'redeemId','--tran-id':'tranId','--precision-file':'precisionFile'};
 for(let i=0;i<args.length;i++) {if(args[i]==='--approved')opts.approved=true;else if(args[i]==='--dry-run')opts.dryRun=true;else if(args[i]==='--replace-algo-id'&&args[i+1]&&!args[i+1].startsWith('--'))(opts.replaceAlgoIds??=[]).push(exchangeId(args[++i]));else if(map[args[i]] && args[i+1] && !args[i+1].startsWith('--'))opts[map[args[i]]]=args[++i];else throw paramsError('Unknown or missing option '+args[i]);}return opts;
}
function printHelp() {
 console.log('Unified Binance CLI\n');for(const [cmd,def]of Object.entries(COMMANDS))console.log(cmd+' '+(def.usage||'')+' '+(def.desc||''));
}
async function cli(argv=process.argv.slice(2)) {
 const [cmd,...args]=argv;if(!cmd||['help','--help','-h'].includes(cmd)){printHelp();return;}
 const def=COMMANDS[cmd];if(!def)throw paramsError('Unknown command');if(def.minArgs&&args.length<def.minArgs)throw paramsError('Usage: '+cmd+' '+def.usage);
 const result=await def.run(args); console.log(JSON.stringify(result,null,2));if(['FAILED','UNKNOWN'].includes(result?.status)||result?.rollbackSucceeded===false||result?.dryRun===true&&(result?.readyForApproval===false||result?.plan?.readyForApproval===false))process.exitCode=1;
}
Client.cli=cli;
Client.primitives=D;Client.BinanceError=BinanceError;Client.TransactionContext=TransactionContext;Client.generateClientOrderId=generateClientOrderId;Client.normalizeOrder=normalizeOrder;
return Client;
}
const Client=createClient({loadEnv:process.env.BAN_TEST_NO_ENV!=='1'});
Client.Client=Client;Client.createClient=createClient;
module.exports=Client;
if(require.main===module)Client.cli().catch(err=>{console.error(JSON.stringify({status:err.status||'FAILED',type:err.type||'ERROR',code:err.code,message:err.message,...(err.preview?{preview:err.preview}:{}),...(err.protectionResult?{protectionResult:err.protectionResult}:{})}));process.exitCode=1;});
