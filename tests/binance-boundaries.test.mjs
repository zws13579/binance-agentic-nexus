import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanFuturesMarket } from '../scripts/futures_scanner.mjs';

const require = createRequire(import.meta.url);
const cjsClient = require('../scripts/binance_unified.js');
const FIXED_NOW = 1_800_000_000_000;
const DUMMY_CREDENTIALS = { apiKey: 'offline-test-key', secretKey: 'offline-test-secret' };
const CLI_PATH = fileURLToPath(new URL('../scripts/binance_unified.js', import.meta.url));

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, method: init.method || 'GET', init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  const client = cjsClient.createClient({
    loadEnv: false,
    credentials: DUMMY_CREDENTIALS,
    now: options.now || (() => FIXED_NOW),
    sleep: async () => {},
    fetchImpl,
    ...options.clientOptions
  });
  return { client, calls };
}

function contractInfo() {
  return {
    symbols: [{
      symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', marginAsset: 'USDT',
      filters: [
        { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
        { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
        { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
      ]
    }]
  };
}

function entryFixture(call) {
  const { pathname, searchParams } = call.url;
  if (pathname === '/api/v3/time') return reply({ serverTime: FIXED_NOW });
  if (pathname === '/fapi/v1/positionSide/dual') return reply({ dualSidePosition: false });
  if (pathname === '/fapi/v1/exchangeInfo') return reply(contractInfo());
  if (pathname === '/fapi/v1/ticker/price') return reply({ symbol: 'BTCUSDT', price: '50000', time: FIXED_NOW });
  if (pathname === '/fapi/v2/positionRisk') return reply([]);
  if (pathname === '/fapi/v1/openOrders' || pathname === '/fapi/v1/openAlgoOrders') return reply([]);
  if (pathname === '/fapi/v2/account') return reply({
    multiAssetsMargin: false, canTrade: true, availableBalance: '1000', assets: [],
    positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', leverage: '10' }]
  });
  if (pathname === '/fapi/v1/depth') return reply({ E: FIXED_NOW, bids: [['49999', '10']], asks: [['50001', '10']] });
  if (pathname === '/fapi/v1/commissionRate') return reply({ takerCommissionRate: '0.0004' });
  return reply({ code: -404, msg: `Unexpected fake route ${pathname}?${searchParams}` }, 404);
}

const validEntry = {
  symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', quantity: '0.0019', type: 'MARKET',
  stopLossPrice: '49000', takeProfitPrice: '51000', requestId: 'offline-entry:1',
  dryRun: true, riskUsd: '10', maxNotionalUsd: '100', maxLeverage: '20', maxSlippageBps: '10'
};

test('CJS and ESM exports share the public client and typed helpers', async () => {
  const esm = await import('../scripts/binance_client.mjs');
  assert.equal(cjsClient.Client, cjsClient);
  assert.equal(cjsClient.createClient, cjsClient.createClient);
  assert.equal(esm.Client, cjsClient);
  assert.equal(esm.default, cjsClient);
  assert.equal(esm.BinanceError, cjsClient.BinanceError);
  assert.equal(esm.TransactionContext, cjsClient.TransactionContext);
  assert.equal(esm.generateClientOrderId, cjsClient.generateClientOrderId);
  assert.equal(esm.normalizeOrder, cjsClient.normalizeOrder);
  const injected = cjsClient.createClient({ loadEnv: false, now: () => 123 });
  assert.match(injected.generateClientOrderId('X'), /^X_123_[a-f0-9]{10}$/);
});

test('approval and invalid order fields stop before the request boundary', async () => {
  const { client, calls } = harness(entryFixture);
  await assert.rejects(client.openPositionWithTPSL({ ...validEntry, dryRun: undefined }), error => error.type === 'PARAMS');
  await assert.rejects(client.openPositionWithTPSL({ ...validEntry, side: 'SELL' }), error => error.type === 'PARAMS');
  assert.equal(calls.length, 0);
});

test('dry-run previews floored quantity and stable order identities without writes', async () => {
  const { client, calls } = harness(entryFixture);
  const preview = await client.openPositionWithTPSL(validEntry);
  assert.equal(preview.status, 'PREVIEW');
  assert.equal(preview.plan.quantity, '0.001');
  assert.equal(preview.plan.requestedQuantity, '0.0019');
  assert.equal(preview.readyForApproval, true);
  assert.match(preview.requests.entry.newClientOrderId, /^BAN_[a-f0-9]{24}_ENT$/);
  assert.match(preview.requests.stopLoss.clientAlgoId, /^BAN_[a-f0-9]{24}_SL$/);
  assert.match(preview.requests.takeProfit.clientAlgoId, /^BAN_[a-f0-9]{24}_TP$/);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('preflight blockers prevent approved order writes at the fake request boundary', async () => {
  const { client, calls } = harness(entryFixture);
  const { requestId, riskUsd, maxNotionalUsd, maxLeverage, maxSlippageBps, ...input } = validEntry;
  await assert.rejects(client.openPositionWithTPSL({ ...input, dryRun: false, approved: true }), error => error.type === 'PARAMS');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('read GET retries once after a transient 5xx, while an uncertain write is never retried', async () => {
  let tickerAttempts = 0;
  const { client, calls } = harness(call => {
    if (call.url.pathname === '/api/v3/ticker/24hr') {
      tickerAttempts++;
      return tickerAttempts === 1 ? reply({ message: 'temporary' }, 500) : reply([{ symbol: 'BTCUSDT', lastPrice: '50000' }]);
    }
    if (call.url.pathname === '/api/v3/time') return reply({ serverTime: FIXED_NOW });
    if (call.method === 'POST') throw new TypeError('fake transport timeout');
    return reply({ code: -404 }, 404);
  });
  assert.equal((await client.getTickers(['BTCUSDT'])).length, 1);
  assert.equal(tickerAttempts, 2);
  await assert.rejects(client.setPositionMode(true), error => error.type === 'AMBIGUOUS_STATE');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('reconcile stays read-only and UNKNOWN when required snapshots fail', async () => {
  const { client, calls } = harness(call => {
    if (call.url.pathname === '/api/v3/time') return reply({ serverTime: FIXED_NOW });
    return reply({ code: -2015, msg: 'fake authorization failure' }, 401);
  });
  const result = await client.reconcile('BTCUSDT', 'reconcile-offline-1');
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.readOnly, true);
  assert.ok(result.queryErrors.length > 0);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('BINANCE_API_ENV rejects unsupported client and scanner configuration before fetch', async () => {
  const badValue = 'untrusted-env-value';
  assert.throws(() => cjsClient.createClient({ loadEnv: false, apiEnv: badValue }), error => {
    assert.equal(error.type, 'CONFIG');
    assert.doesNotMatch(error.message, new RegExp(badValue));
    return true;
  });
  let fetches = 0;
  await assert.rejects(scanFuturesMarket({ loadEnv: false, apiEnv: badValue, fetchImpl: async () => { fetches++; } }), error => {
    assert.doesNotMatch(error.message, new RegExp(badValue));
    return true;
  });
  assert.equal(fetches, 0);

  const previousEnv = process.env.BINANCE_API_ENV;
  process.env.BINANCE_API_ENV = badValue;
  try {
    assert.doesNotThrow(() => cjsClient.createClient({ loadEnv: false }));
    let isolatedFetches = 0;
    await assert.rejects(scanFuturesMarket({
      loadEnv: false,
      fetchImpl: async () => { isolatedFetches++; throw new Error('fake offline fetch reached'); }
    }), /fake offline fetch reached/);
    assert.ok(isolatedFetches > 0, 'loadEnv:false must ignore process API_ENV and use the injected fetch');
  } finally {
    if (previousEnv === undefined) delete process.env.BINANCE_API_ENV;
    else process.env.BINANCE_API_ENV = previousEnv;
  }

  const child = spawnSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    env: { BINANCE_API_ENV: badValue }
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /"type":"CONFIG"/);
  assert.doesNotMatch(child.stderr, new RegExp(badValue));
  assert.doesNotMatch(child.stderr, /\n\s+at /);
});

test('scanner returns schema 2 from closed candles and retains missing funding evidence', async () => {
  const klines = Array.from({ length: 201 }, (_, index) => {
    const openTime = FIXED_NOW - (200 - index) * 60_000;
    const open = 50_000 + index;
    const close = open + 0.5;
    return [openTime, String(open), String(close + 1), String(open - 1), String(close), '3', openTime + 59_999, String(1000 + index)];
  });
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/fapi/v1/exchangeInfo') return reply({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT' }] });
    if (url.pathname === '/fapi/v1/ticker/24hr') return reply([{ symbol: 'BTCUSDT', quoteVolume: '20000000', lastPrice: '50200', priceChangePercent: '1.2', closeTime: FIXED_NOW }]);
    if (url.pathname === '/fapi/v1/time') return reply({ serverTime: FIXED_NOW });
    if (url.pathname === '/fapi/v1/premiumIndex') return reply([]);
    if (url.pathname === '/fapi/v1/klines') return reply(klines);
    return reply({ code: -404 }, 404);
  };
  const result = await scanFuturesMarket({ top: 1, interval: '1m', minVolume: 1, fetchImpl, loadEnv: false, baseUrl: 'https://offline.invalid', now: () => FIXED_NOW });
  assert.equal(result.length, 1);
  assert.equal(result[0].schemaVersion, 2);
  assert.equal(result[0].rankingBasis, 'quoteVolume');
  assert.equal(result[0].status, 'PARTIAL');
  assert.match(result[0].missingData.join(' '), /Funding data unavailable/);
  const evidence = result[0].timeframes['1m'];
  assert.equal(evidence.status, 'OK');
  assert.equal(evidence.candles.length, 200);
  assert.equal(evidence.candles.at(-1).closeTime, klines[199][6]);
  assert.equal(evidence.currentCandleStatus, 'OK');
  assert.equal(evidence.currentCandle.openTime, klines[200][0]);
  assert.ok(calls.every(url => url.hostname === 'offline.invalid'));
});

test('replacement confirms both new protections before deleting old ones', async () => {
  const prefix = new cjsClient.TransactionContext('replace-request-1').correlationId;
  const old = [
    { algoId: '101', clientAlgoId: `${prefix}_SL`, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'STOP_MARKET', algoStatus: 'NEW', closePosition: 'true', workingType: 'CONTRACT_PRICE', triggerPrice: '48000', actualOrderId: '0', triggerTime: 0 },
    { algoId: '102', clientAlgoId: `${prefix}_TP`, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'TAKE_PROFIT_MARKET', algoStatus: 'NEW', closePosition: 'true', workingType: 'CONTRACT_PRICE', triggerPrice: '52000', actualOrderId: '0', triggerTime: 0 }
  ];
  const created = new Map();
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const call = { url, method };
    calls.push(call);
    if (url.pathname === '/api/v3/time') return reply({ serverTime: FIXED_NOW });
    if (url.pathname === '/fapi/v1/positionSide/dual') return reply({ dualSidePosition: false });
    if (url.pathname === '/fapi/v2/positionRisk') return reply([{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.001', entryPrice: '50000' }]);
    if (url.pathname === '/fapi/v1/ticker/price') return reply({ symbol: 'BTCUSDT', price: '50000', time: FIXED_NOW });
    if (url.pathname === '/fapi/v1/exchangeInfo') return reply(contractInfo());
    if (url.pathname === '/fapi/v1/openAlgoOrders') return reply(old);
    if (url.pathname === '/fapi/v1/algoOrder' && method === 'POST') {
      const algoId = String(200 + created.size + 1);
      const row = Object.fromEntries(url.searchParams.entries());
      row.algoId = algoId;
      created.set(algoId, row);
      return reply({ algoId });
    }
    if (url.pathname === '/fapi/v1/algoOrder' && method === 'DELETE') return reply({ algoId: url.searchParams.get('algoId'), algoStatus: 'CANCELED' });
    if (url.pathname === '/fapi/v1/algoOrder' && method === 'GET') {
      const id = url.searchParams.get('algoId');
      const createdRow = created.get(id);
      if (createdRow) return reply({
        ...createdRow, algoId: id, algoStatus: 'NEW', orderType: createdRow.type, actualOrderId: '0', triggerTime: 0
      });
      const previous = old.find(row => row.algoId === id);
      if (previous) return reply({ ...previous, algoStatus: 'CANCELED' });
    }
    return reply({ code: -404 }, 404);
  };
  const client = cjsClient.createClient({ loadEnv: false, credentials: DUMMY_CREDENTIALS, now: () => FIXED_NOW, sleep: async () => {}, fetchImpl });
  const result = await client.setTPSL({ symbol: 'BTCUSDT', positionSide: 'LONG', stopLossPrice: '47000', takeProfitPrice: '53000', clientAlgoIdPrefix: prefix });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.cancelled.length, 2);
  const postIndexes = calls.flatMap((call, index) => call.method === 'POST' ? [index] : []);
  const confirmedIndexes = calls.flatMap((call, index) => call.method === 'GET' && call.url.pathname === '/fapi/v1/algoOrder' && created.has(call.url.searchParams.get('algoId')) ? [index] : []);
  const deleteIndexes = calls.flatMap((call, index) => call.method === 'DELETE' ? [index] : []);
  assert.equal(postIndexes.length, 2);
  assert.equal(confirmedIndexes.length, 2);
  assert.equal(deleteIndexes.length, 2);
  assert.ok(Math.max(...postIndexes, ...confirmedIndexes) < Math.min(...deleteIndexes));
});

test('failed replacement leg preserves old protections and sends no cancellations', async () => {
  const prefix = new cjsClient.TransactionContext('replace-request-failure').correlationId;
  const old = [
    { algoId: '301', clientAlgoId: `${prefix}_SL`, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'STOP_MARKET', algoStatus: 'NEW', closePosition: 'true', workingType: 'CONTRACT_PRICE', triggerPrice: '48000', actualOrderId: '0', triggerTime: 0 },
    { algoId: '302', clientAlgoId: `${prefix}_TP`, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'TAKE_PROFIT_MARKET', algoStatus: 'NEW', closePosition: 'true', workingType: 'CONTRACT_PRICE', triggerPrice: '52000', actualOrderId: '0', triggerTime: 0 }
  ];
  let posts = 0;
  let deletes = 0;
  let createdStop;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.pathname === '/api/v3/time') return reply({ serverTime: FIXED_NOW });
    if (url.pathname === '/fapi/v1/positionSide/dual') return reply({ dualSidePosition: false });
    if (url.pathname === '/fapi/v2/positionRisk') return reply([{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.001', entryPrice: '50000' }]);
    if (url.pathname === '/fapi/v1/ticker/price') return reply({ symbol: 'BTCUSDT', price: '50000', time: FIXED_NOW });
    if (url.pathname === '/fapi/v1/exchangeInfo') return reply(contractInfo());
    if (url.pathname === '/fapi/v1/openAlgoOrders') return reply(old);
    if (url.pathname === '/fapi/v1/algoOrder' && method === 'POST') {
      posts++;
      if (posts === 2) return reply({ code: -1111, msg: 'fake rejection' }, 400);
      createdStop = Object.fromEntries(url.searchParams.entries());
      return reply({ algoId: '401' });
    }
    if (method === 'DELETE') {
      deletes++;
      return reply({ algoId: url.searchParams.get('algoId'), algoStatus: 'CANCELED' });
    }
    if (url.pathname === '/fapi/v1/algoOrder' && method === 'GET' && url.searchParams.get('algoId') === '401') {
      return reply({ ...createdStop, algoId: '401', clientAlgoId: createdStop.clientAlgoId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'STOP_MARKET', algoStatus: 'NEW', closePosition: 'true', workingType: 'CONTRACT_PRICE', triggerPrice: '47000', actualOrderId: '0', triggerTime: 0 });
    }
    return reply({ code: -404 }, 404);
  };
  const client = cjsClient.createClient({ loadEnv: false, credentials: DUMMY_CREDENTIALS, now: () => FIXED_NOW, sleep: async () => {}, fetchImpl });
  await assert.rejects(client.setTPSL({ symbol: 'BTCUSDT', positionSide: 'LONG', stopLossPrice: '47000', takeProfitPrice: '53000', clientAlgoIdPrefix: prefix }), error => {
    assert.equal(error.status, 'UNKNOWN');
    assert.equal(error.protectionResult.failedLeg, 'takeProfit');
    assert.equal(error.protectionResult.oldProtectionRetained, true);
    assert.deepEqual(error.protectionResult.retainedOldAlgoIds, ['301', '302']);
    return true;
  });
  assert.equal(posts, 2);
  assert.equal(deletes, 0);
});

test('exported method overrides are honored by the legacy CLI dispatcher', async () => {
  const original = process.env.BAN_TEST_NO_ENV;
  process.env.BAN_TEST_NO_ENV = '1';
  const logged = [];
  const log = console.log;
  try {
    cjsClient.getTickers = async symbols => [{ symbol: symbols[0], price: 'offline' }];
    console.log = value => logged.push(value);
    await cjsClient.cli(['ticker', 'BTCUSDT']);
    assert.deepEqual(JSON.parse(logged[0]), [{ symbol: 'BTCUSDT', price: 'offline' }]);
  } finally {
    console.log = log;
    delete cjsClient.getTickers;
    if (original === undefined) delete process.env.BAN_TEST_NO_ENV;
    else process.env.BAN_TEST_NO_ENV = original;
  }
});
