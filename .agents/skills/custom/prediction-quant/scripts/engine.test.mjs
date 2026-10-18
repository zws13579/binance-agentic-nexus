import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { quotePrediction, executePrediction } from './engine.mjs';

const quote = { tokenId: 'token_test', marketTopicId: 'topic_test' };
const execute = { quoteId: 'quote_test', approved: true };

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
    writeFileSync(stub, `#!${process.execPath}\nconsole.log(JSON.stringify({success:true,args:process.argv.slice(2)}));\n`);
    chmodSync(stub, 0o700);
    const engine = fileURLToPath(new URL('./engine.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [engine, ...args], {
      env: { PATH: dir }, encoding: 'utf8'
    });
    for (const base of [
      ['--quote', '--tokenId', 'token_test', '--marketTopicId', 'topic_test'],
      ['--execute', '--quoteId', 'quote_test', '--approved']
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
