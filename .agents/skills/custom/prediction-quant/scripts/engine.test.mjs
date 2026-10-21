import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  quotePrediction, executePrediction,
  buildPredictionTradeState, buildOpportunityAssessment, MAX_OPEN_EXPOSURE_RATIO
} from './engine.mjs';

const quote = { tokenId: 'token_test', marketTopicId: 'topic_test' };
const execute = {
  quoteId: 'quote_test',
  amountIn: 1.0,
  approved: true,
  bankroll: { targetActionAllowed: true, maxBetUsd: 5, balance: 10, openExposureUsd: 0 }
};

test('LIMIT and default MARKET reach both executors with explicit order type', async () => {
  for (const [fn, input] of [[quotePrediction, quote], [executePrediction, execute]]) {
    const calls = [];
    const options = { orderExecutor: args => { calls.push(args); return { success: true }; } };
    await fn({ ...input, orderType: 'LIMIT', priceLimit: '0.60' }, options);
    assert.equal(calls[0][calls[0].indexOf('--orderType') + 1], 'LIMIT');
    assert.equal(calls[0][calls[0].indexOf('--priceLimit') + 1], '0.6');
    await fn(input, options);
    assert.equal(calls[1][calls[1].indexOf('--orderType') + 1], 'MARKET');
    assert.ok(!calls[1].includes('--priceLimit'));
  }
});

test('invalid order parameters never invoke quote or place-order executor', async () => {
  const invalid = [
    { orderType: 'limit', priceLimit: 0.5 }, { orderType: 'STOP' },
    { orderType: 'LIMIT' }, ...[null, true, '', ' ', '0.5junk', NaN, Infinity, -1, 0, 1, 2].map(priceLimit => ({ orderType: 'LIMIT', priceLimit })),
    { orderType: 'MARKET', priceLimit: 0.5 }
  ];
  for (const [fn, input] of [[quotePrediction, quote], [executePrediction, execute]]) {
    for (const order of invalid) {
      let calls = 0;
      await assert.rejects(fn({ ...input, ...order }, {
        orderExecutor: () => { calls++; return { success: true }; }
      }));
      assert.equal(calls, 0, 'invalid parameters must not invoke executor');
    }
  }
});

test('approval gate blocks both order types before execution', async () => {
  for (const orderType of ['MARKET', 'LIMIT']) {
    const result = await executePrediction({ quoteId: 'quote_test', orderType }, {
      orderExecutor: () => assert.fail('executor called')
    });
    assert.equal(result.blockedByApprovalGate, true);
  }
});

test('CLI forwards LIMIT and rejects misspelled, missing, duplicate and mixed flags offline', () => {
  // PATH points only at this local stub: a real baw process cannot be reached.
  mkdirSync(path.resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(path.resolve('tmp/prediction-cli-test-'));
  try {
    const stub = path.join(dir, 'baw');
    writeFileSync(
      stub,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'prediction' && args[1] === 'position' && args[2] === 'list') {
  console.log(JSON.stringify({
    success: true,
    data: {
      summary: { walletBalance: 10 },
      counts: { ongoingCount: 0 },
      positions: []
    }
  }));
  process.exit(0);
}
console.log(JSON.stringify({success:true,args}));
`
    );
    chmodSync(stub, 0o700);
    const engine = fileURLToPath(new URL('./engine.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [engine, ...args], {
      env: { PATH: dir }, encoding: 'utf8'
    });
    for (const base of [
      ['--quote', '--tokenId', 'token_test', '--marketTopicId', 'topic_test'],
      ['--execute', '--quoteId', 'quote_test', '--amountIn', '1', '--approved']
    ]) {
      const ok = run([...base, '--orderType', 'LIMIT', '--priceLimit', '0.6']);
      assert.equal(ok.status, 0, ok.stderr);
      const args = JSON.parse(ok.stdout).args;
      assert.equal(args[args.indexOf('--orderType') + 1], 'LIMIT');
      assert.equal(args[args.indexOf('--priceLimit') + 1], '0.6');
      const market = run(base);
      assert.equal(market.status, 0, market.stderr);
      assert.equal(JSON.parse(market.stdout).args.at(-2), 'MARKET');
      for (const flags of [
        ['--orderType'], ['--priceLimit'], ['--orderType', '--approved'],
        ['--orderType', 'LIMIT'], ['--orderType', 'LIMIT', '--priceLimit', 'garbage'],
        ['--priceLimit', '0.6'], ['--orderTyp', 'LIMIT'],
        ['--orderType', 'LIMIT', '--orderType', 'MARKET'], ['--scan'],
        [base[0] === '--quote' ? '--execute' : '--quote']
      ]) {
        const bad = run([...base, ...flags]);
        assert.equal(bad.status, 1, JSON.stringify(flags));
        assert.equal(bad.stdout, '', 'must fail before stub call output');
      }
    }
    const denied = run(['--execute', '--quoteId', 'quote_test', '--orderType', 'LIMIT', '--priceLimit', '0.6']);
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stdout).blockedByApprovalGate, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 在途仓位 30% 硬上限（references/risk_rules.md §1） ----

function exposureCase(bankroll, stake = 1.02) {
  const now = new Date().toISOString();
  const assessment = {
    eventId: 'e1', marketId: 'm1', targetOutcome: 'A', probability: 0.40, action: 'enter',
    source: 'unit-test-agent', evaluatedAt: now, rationale: 'unit test fixture'
  };
  const state = buildPredictionTradeState({
    market: 'Unit test market', eventId: 'e1', marketId: 'm1', tokenId: 't1',
    targetOutcome: 'A', opponentOutcome: 'B', marketPrice: 0.28, marketObservedAt: now,
    liquidityUsd: 5000, executionCosts: { totalUsd: 0, stakeUsd: stake, source: 'unit test', observedAt: now },
    agentAssessment: assessment, bankroll
  });
  return buildOpportunityAssessment(state, assessment, { stake, provider: 'agent' });
}

test('exposure cap blocks the real CBA sizing (1.02 of 1.455 total bankroll)', () => {
  assert.equal(MAX_OPEN_EXPOSURE_RATIO, 0.30);
  const r = exposureCase({ targetActionAllowed: true, maxBetUsd: 5, balance: 1.455, openExposureUsd: 0 });
  assert.equal(r.decision.riskEnvelopeStatus, 'blocked');
  assert.equal(r.decision.action, 'blocked_by_risk_limit');
  assert.ok(r.decision.riskLimitReasons.includes('exposure_cap_exceeded'));
  assert.ok(r.decision.executionEligibility.blockers.includes('exposure_cap_exceeded'));
  assert.equal(r.decision.readyForHumanApproval, false);
});

test('exposure cap counts existing open positions in both numerator and bankroll', () => {
  // 总资产 10，已在途 2.5，再下 1.02 → 3.52 > 3.0
  const blocked = exposureCase({ targetActionAllowed: true, maxBetUsd: 5, balance: 7.5, openExposureUsd: 2.5 });
  assert.ok(blocked.decision.riskLimitReasons.includes('exposure_cap_exceeded'));
  // 总资产 4，无在途，下 1.02 → 1.02 ≤ 1.2
  const ok = exposureCase({ targetActionAllowed: true, maxBetUsd: 5, balance: 4, openExposureUsd: 0 });
  assert.equal(ok.decision.riskEnvelopeStatus, 'provided_allowed');
  assert.deepEqual(ok.decision.riskLimitReasons, []);
  assert.equal(ok.decision.exposure.ratioAfter, 0.255);
});

test('missing openExposureUsd keeps the risk envelope unknown instead of assuming zero', () => {
  const r = exposureCase({ targetActionAllowed: true, maxBetUsd: 5, balance: 100 });
  assert.equal(r.decision.riskEnvelopeStatus, 'unknown');
  assert.equal(r.decision.exposure, null);
  assert.equal(r.decision.readyForHumanApproval, false);
  assert.ok(r.decision.executionEligibility.blockers.includes('risk_envelope_unknown'));
});

test('executePrediction blocks over-cap orders and never calls orderExecutor even when approved=true', async () => {
  const blockedAssessment = exposureCase(
    { targetActionAllowed: true, maxBetUsd: 5, balance: 1.455, openExposureUsd: 0 },
    1.02
  );
  assert.equal(blockedAssessment.decision.readyForHumanApproval, false);

  let executorCalls = 0;
  const neverCallExecutor = () => {
    executorCalls++;
    assert.fail('orderExecutor must not be called when exposure cap is exceeded');
  };

  // 1) Passing blocked assessment directly
  const viaAssessment = await executePrediction(
    {
      quoteId: 'quote_cba',
      amountIn: 1.02,
      approved: true,
      assessment: blockedAssessment
    },
    { orderExecutor: neverCallExecutor }
  );
  assert.equal(viaAssessment.success, false);
  assert.equal(viaAssessment.blockedByRiskGate, true);
  assert.ok(viaAssessment.riskLimitReasons.includes('exposure_cap_exceeded'));
  assert.equal(executorCalls, 0);

  // 2) Bypassing assessment and passing bankroll directly (offline repro: balance 1.455, bet 1.02)
  const viaBankroll = await executePrediction(
    {
      quoteId: 'quote_cba',
      amountIn: 1.02,
      approved: true,
      bankroll: { targetActionAllowed: true, maxBetUsd: 5, balance: 1.455, openExposureUsd: 0 }
    },
    { orderExecutor: neverCallExecutor }
  );
  assert.equal(viaBankroll.success, false);
  assert.equal(viaBankroll.blockedByRiskGate, true);
  assert.equal(viaBankroll.riskEnvelopeStatus, 'blocked');
  assert.ok(viaBankroll.riskLimitReasons.includes('exposure_cap_exceeded'));
  assert.equal(executorCalls, 0);

  // 3) Live positionLister + quote.data.amountIn drift even after an initially passing assessment
  const passingAssessment = exposureCase(
    { targetActionAllowed: true, maxBetUsd: 5, balance: 4.0, openExposureUsd: 0 },
    1.02
  );
  assert.equal(passingAssessment.decision.readyForHumanApproval, true);

  const viaLiveDrift = await executePrediction(
    {
      quoteId: 'quote_cba',
      quote: { data: { amountIn: '1.02' } },
      approved: true,
      assessment: passingAssessment
    },
    {
      positionLister: () => ({
        success: true,
        data: {
          summary: { walletBalance: 0.4358 },
          counts: { ongoingCount: 1 },
          positions: [{ positionStatus: 'OPEN', totalCost: 1.02 }]
        }
      }),
      orderExecutor: neverCallExecutor
    }
  );
  assert.equal(viaLiveDrift.success, false);
  assert.equal(viaLiveDrift.blockedByRiskGate, true);
  assert.ok(viaLiveDrift.riskLimitReasons.includes('exposure_cap_exceeded'));
  assert.equal(executorCalls, 0);

  // 4) Missing amountIn or missing exposure state must also block without calling orderExecutor
  const missingAmount = await executePrediction(
    {
      quoteId: 'quote_cba',
      approved: true,
      bankroll: { balance: 10, openExposureUsd: 0 }
    },
    { orderExecutor: neverCallExecutor }
  );
  assert.equal(missingAmount.success, false);
  assert.equal(missingAmount.blockedByRiskGate, true);
  assert.ok(missingAmount.riskLimitReasons.includes('missing_amount_in'));
  assert.equal(executorCalls, 0);

  const missingExposure = await executePrediction(
    {
      quoteId: 'quote_cba',
      amountIn: 1.0,
      approved: true
    },
    { orderExecutor: neverCallExecutor }
  );
  assert.equal(missingExposure.success, false);
  assert.equal(missingExposure.blockedByRiskGate, true);
  assert.equal(missingExposure.riskEnvelopeStatus, 'unknown');
  assert.equal(executorCalls, 0);
});

test('CLI --execute blocks over-cap trade and never invokes baw place-order', () => {
  mkdirSync(path.resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(path.resolve('tmp/prediction-cli-cap-'));
  try {
    const logFile = path.join(dir, 'calls.json');
    writeFileSync(logFile, '[]');
    const stub = path.join(dir, 'baw');
    writeFileSync(
      stub,
      `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(logFile, 'utf8'));
calls.push(args);
writeFileSync(logFile, JSON.stringify(calls));
if (args[0] === 'prediction' && args[1] === 'position' && args[2] === 'list') {
  console.log(JSON.stringify({
    success: true,
    data: {
      summary: { walletBalance: 1.455 },
      counts: { ongoingCount: 0 },
      positions: []
    }
  }));
  process.exit(0);
}
console.log(JSON.stringify({ success: true, args }));
`
    );
    chmodSync(stub, 0o700);
    const engine = fileURLToPath(new URL('./engine.mjs', import.meta.url));
    const res = spawnSync(
      process.execPath,
      [engine, '--execute', '--quoteId', 'quote_test', '--amountIn', '1.02', '--approved'],
      { env: { PATH: dir }, encoding: 'utf8' }
    );
    assert.equal(res.status, 1);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.blockedByRiskGate, true);
    assert.ok(payload.riskLimitReasons.includes('exposure_cap_exceeded'));

    const calls = JSON.parse(readFileSync(logFile, 'utf8'));
    assert.equal(calls.length, 1, 'only position list may be called');
    assert.deepEqual(calls[0].slice(0, 3), ['prediction', 'position', 'list']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
