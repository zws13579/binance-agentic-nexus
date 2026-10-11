#!/usr/bin/env node
/** Read-only futures analysis. Never places orders or persists an analysis ledger. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig, evaluateSystemOne } from '../.agents/skills/custom/typesafe-evaluator/scripts/typesafe.mjs';

export const DIRECTIONS = ['LONG', 'SHORT', 'WAIT', 'NO_TRADE'];
export const SETUP_TYPES = {
  breakout_long: 'LONG', breakdown_short: 'SHORT',
  pullback_long: 'LONG', rebound_short: 'SHORT',
  range_bottom_long: 'LONG', range_top_short: 'SHORT'
};
const INTERVALS = ['4h', '1h', '15m'];
const INTERVAL_MS = { '4h': 14_400_000, '1h': 3_600_000, '15m': 900_000 };
const NETWORK_ERRORS = new Set(['TYPESAFE_API_TIMEOUT', 'TYPESAFE_API_REQUEST_FAILED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => new Date(value).toISOString();
const list = value => Array.isArray(value) && value.every(nonempty);

export const INPUT_CONTRACT = {
  schemaVersion: 1,
  required: ['symbol', 'agentAssessment'],
  observedAt: 'Required collection timestamp, or scannerResult.observedAt/serverTime',
  evidence: 'Use timeframes from a scannerResult, or features keyed by 4h/1h/15m. Each timeframe needs status=OK and features: signalCloseTime, signalClose, boxTop, boxBottom, volumeRatio, atr14, ema20.value, ema50.value. All candles must be closed. Snapshot freshness limit is 15 minutes. Unknown data remains unknown.',
  agentAssessment: {
    symbol: 'Must match input symbol', direction: DIRECTIONS,
    setupType: Object.keys(SETUP_TYPES),
    rationale: 'Required nonempty string', counterEvidence: 'Required array of strings',
    invalidations: 'Required array of strings; entries require at least one condition',
    source: 'Required actual Agent/model identifier', evaluatedAt: 'Required ISO timestamp',
    expiresAt: 'Required ISO timestamp later than evaluatedAt',
    note: 'WAIT/NO_TRADE use setupType=null and specify waiting/no-trade conditions in rationale/invalidations.'
  },
  tradePlan: { entryPrice: 'positive decimal', stopLoss: 'positive decimal', takeProfit: 'positive decimal', quantity: 'positive decimal', leverage: 'positive decimal' },
  riskLimits: { maxLossUsd: 'positive', maxNotionalUsd: 'positive', maxLeverage: 'positive', maxSlippageBps: 'nonnegative', source: 'Required provenance for approval readiness' },
  executionChecks: { accountModeKnown: 'true', flat: 'true', noPendingEntry: 'true', filtersPassed: 'true', availableMarginUsd: 'nonnegative', slippageBps: 'nonnegative', observedAt: 'Required fresh timestamp' },
  executionCosts: { entryUsd: 'nonnegative', stopExitUsd: 'nonnegative', targetExitUsd: 'nonnegative', fundingUsd: 'nonnegative conservative allowance', quantity: 'must match tradePlan quantity', source: 'Required cost evidence', observedAt: 'Required fresh timestamp' },
  jevInstructions: 'Optional additional contextual question; neutrality and evidence rules still apply',
  note: 'Approval readiness is analysis only, never transaction authorization. No calibrated probability or binary EV is claimed. Missing cost/risk/execution data prevents readiness.'
};

function invalid(status, message) {
  return { success: false, schemaVersion: 1, status, error: message, direction: 'WAIT',
    probabilitySource: null, calibrated: false, readyForHumanApproval: false,
    agentAssessment: null, jevAssessment: null, providerUsed: null,
    jevStatus: 'not_requested', tradePlan: null, riskChecks: [], missingData: [] };
}

function validateAgent(input, now) {
  const assessment = input.agentAssessment;
  if (!object(assessment)) return invalid('agent_assessment_required', 'A current Agent assessment is required.');
  if (assessment.isMock === true || assessment.metrics?.isMock === true) return invalid('mock_blocked', 'Mock analysis cannot support a trading recommendation.');
  for (const field of ['symbol', 'direction', 'rationale', 'source', 'evaluatedAt', 'expiresAt']) {
    if (!nonempty(assessment[field])) return invalid('invalid_agent_assessment', `agentAssessment.${field} is required.`);
  }
  if (assessment.symbol !== input.symbol || !DIRECTIONS.includes(assessment.direction)) {
    return invalid('invalid_agent_assessment', 'Agent symbol/direction does not match the analysis contract.');
  }
  if (!list(assessment.counterEvidence) || !list(assessment.invalidations)) {
    return invalid('invalid_agent_assessment', 'counterEvidence and invalidations must be arrays of nonempty strings.');
  }
  const entering = ['LONG', 'SHORT'].includes(assessment.direction);
  if (entering && (SETUP_TYPES[assessment.setupType] !== assessment.direction || assessment.invalidations.length === 0)) {
    return invalid('invalid_agent_assessment', 'An entry requires a matching setupType and explicit invalidation conditions.');
  }
  if (!entering && assessment.setupType !== null) {
    return invalid('invalid_agent_assessment', 'WAIT/NO_TRADE require setupType=null.');
  }
  const evaluated = timestamp(assessment.evaluatedAt), expires = timestamp(assessment.expiresAt);
  if (evaluated === null || expires === null || evaluated > now || expires <= evaluated) {
    return invalid('invalid_agent_assessment', 'Invalid assessment timestamps.');
  }
  if (expires <= now) return invalid('expired_assessment', 'Refresh the expired Agent assessment.');
  return null;
}

function normalizeEvidence(input, now) {
  const scan = object(input.scannerResult) ? input.scannerResult : input;
  if (scan.symbol && scan.symbol !== input.symbol) return { error: 'Evidence symbol does not match input symbol.' };
  // The collection time belongs to the market evidence, not its wrapping message.
  const observed = timestamp(scan.observedAt ?? scan.serverTime ?? input.observedAt);
  if (observed === null || observed > now) return { error: 'A valid evidence collection timestamp is required.' };
  const timeframes = scan.timeframes ?? input.timeframes ?? input.features;
  const missing = [];
  const frames = {};
  for (const interval of INTERVALS) {
    const frame = timeframes?.[interval];
    if (!object(frame)) { missing.push(`timeframes.${interval}`); continue; }
    if (!['OK', 'ok'].includes(frame.status)) missing.push(`timeframes.${interval}.status`);
    const features = object(frame.features) ? frame.features : frame;
    if (Object.keys(features).filter(key => !['status', 'missingData'].includes(key)).length === 0) {
      missing.push(`timeframes.${interval}.features`);
    }
    for (const field of ['signalClose', 'boxTop', 'boxBottom', 'atr14']) {
      if (number(features[field]) === null || number(features[field]) <= 0) missing.push(`timeframes.${interval}.${field}`);
    }
    for (const field of ['ema20', 'ema50']) {
      if (number(features[field]?.value) === null || number(features[field]?.value) <= 0) missing.push(`timeframes.${interval}.${field}`);
    }
    if (number(features.volumeRatio) === null || number(features.volumeRatio) < 0) missing.push(`timeframes.${interval}.volumeRatio`);
    const signalClosedAt = timestamp(features.signalCloseTime);
    if (signalClosedAt === null || signalClosedAt > observed) missing.push(`timeframes.${interval}.closed_signal`);
    if (signalClosedAt !== null && observed - signalClosedAt > INTERVAL_MS[interval] + 60_000) {
      missing.push(`timeframes.${interval}.stale_signal`);
    }
    if (number(features.boxTop) !== null && number(features.boxBottom) !== null && number(features.boxTop) < number(features.boxBottom)) {
      missing.push(`timeframes.${interval}.invalid_box`);
    }
    if (Array.isArray(frame.candles) && frame.candles.some(candle => timestamp(candle?.closeTime) === null || timestamp(candle.closeTime) > observed)) {
      missing.push(`timeframes.${interval}.unclosed_candle`);
    }
    if (Array.isArray(frame.missingData)) missing.push(...frame.missingData.map(item => `timeframes.${interval}.${item}`));
    frames[interval] = scrub({ ...frame, features });
  }
  if (Array.isArray(scan.missingData)) missing.push(...scan.missingData.map(item => `scanner.${item}`));
  if (scan.status && !['OK', 'PARTIAL', 'ok', 'partial'].includes(scan.status)) missing.push('scanner.status');
  const rawPrice = scan.currentPrice ?? scan.price ?? null;
  const currentPrice = number(rawPrice);
  const priceStatus = currentPrice !== null && currentPrice > 0 ? 'OK' : 'UNKNOWN';
  if (rawPrice !== null && priceStatus !== 'OK') missing.push('invalid_current_price');
  // A market snapshot may not authorize an entry beyond one 15-minute candle.
  if (now - observed > 15 * 60_000) missing.push('evidence_stale');
  return { observedAt: iso(observed), timeframes: frames, missingData: [...new Set(missing)],
    facts: scrub({ symbol: input.symbol, observedAt: iso(observed),
      currentPrice: priceStatus === 'OK' ? currentPrice : null, currentPriceStatus: priceStatus,
      currentPriceTime: timestamp(scan.currentPriceTime), timeframes: frames,
      funding: scan.funding ?? input.funding ?? null, openInterest: input.openInterest ?? scan.openInterest ?? null,
      orderbook: input.orderbook ?? null, evidence: input.evidence ?? [], missingData: missing }) };
}

// Keep decisions, permissions and credentials out of the independent model state.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!object(value)) return value;
  const filtered = {};
  const blocked = /^(?:agentAssessment|jevAssessment|allowed|permissions|riskLimits|executionChecks|tradePlan|direction|setupType|confidence|recommendation|apiKey|secret|token|authorization)$/i;
  for (const [key, entry] of Object.entries(value)) {
    if (!blocked.test(key)) filtered[key] = scrub(entry);
  }
  return filtered;
}

export function buildJevPayload(input, evidence) {
  const facts = scrub(evidence.facts);
  const observed = timestamp(facts.observedAt);
  const timeframes = {};
  for (const interval of INTERVALS) {
    const frame = facts.timeframes?.[interval];
    if (!object(frame)) continue;
    const closed = Array.isArray(frame.candles)
      ? frame.candles.filter(candle => timestamp(candle?.closeTime) !== null && timestamp(candle.closeTime) <= observed)
      : null;
    const { candles: _excludedHistory, ...features } = object(frame.features) ? frame.features : {};
    timeframes[interval] = {
      status: frame.status ?? 'UNKNOWN',
      features,
      missingData: frame.missingData ?? [],
      closedCandleCount: closed === null ? null : closed.length,
      candleWindow: 'last_8_closed',
      candles: closed === null ? [] : closed.slice(-8),
      currentCandle: frame.currentCandle ?? null,
      currentCandleStatus: frame.currentCandleStatus ?? 'UNKNOWN',
      currentCandleMissingData: frame.currentCandleMissingData ?? []
    };
    for (const key of ['source', 'observedAt', 'sourceTime', 'serverTime']) {
      if (frame[key] !== undefined) timeframes[interval][key] = frame[key];
    }
  }
  return {
    // Preserve full evidence in the caller. Only this independent opinion gets a bounded snapshot.
    state: { ...facts, timeframes },
    questions: {
      direction: {
        type: 'choice',
        instructions: 'Compare LONG and SHORT neutrally using only sourced market evidence. Examine breakout/breakdown, trend pullback/rebound and range rejection; consider counterevidence, crowding and missing data. Choose WAIT for an unresolved condition or conflicting evidence and NO_TRADE when no supported opportunity exists. Do not invent probabilities, account permissions or facts. '
          + (nonempty(input.jevInstructions) ? `Contextual question: ${input.jevInstructions}. ` : '')
          + 'Apply the same evidence standard to both directions. currentCandle is an unclosed snapshot, separate from closed candles and features; it cannot establish a confirmed breakout. Agent opinion and trading authorization are excluded from state.',
        criteria: {
          LONG: 'Evidence supports a long-side opportunity', SHORT: 'Evidence supports a short-side opportunity',
          WAIT: 'Wait for confirmation or resolve conflicting/missing evidence', NO_TRADE: 'No supported opportunity'
        }
      }
    }
  };
}

function fresh(value, now) {
  const time = timestamp(value);
  return time !== null && time <= now && now - time <= 15 * 60_000;
}

function computePlan(input, now) {
  const raw = input.tradePlan;
  const checks = [], missing = [];
  const check = (name, state, details = null) => {
    checks.push({ name, status: state === null ? 'unknown' : state ? 'passed' : 'blocked', details });
    if (state === null) missing.push(name);
  };
  if (!object(raw)) return { tradePlan: null, riskChecks: [{ name: 'tradePlan', status: 'unknown' }], missingData: ['tradePlan'] };
  const direction = input.agentAssessment.direction;
  const normalized = Object.fromEntries(['entryPrice', 'stopLoss', 'takeProfit', 'quantity', 'leverage'].map(key => [key, number(raw[key])]));
  const pricesValid = ['entryPrice', 'stopLoss', 'takeProfit', 'quantity'].every(key => normalized[key] !== null && normalized[key] > 0);
  check('plan_positive_numbers', pricesValid);
  if (!pricesValid) return { tradePlan: { ...normalized, costStatus: 'unknown', netTargetPnlUsd: null, netStopLossUsd: null }, riskChecks: checks, missingData: missing };
  const { entryPrice: entry, stopLoss: stop, takeProfit: target, quantity: qty, leverage } = normalized;
  const geometry = direction === 'LONG' ? stop < entry && entry < target : target < entry && entry < stop;
  check('price_geometry', geometry);
  const notional = entry * qty;
  const loss = Math.abs(entry - stop) * qty;
  const reward = (direction === 'LONG' ? target - entry : entry - target) * qty;
  const finiteAmounts = [notional, loss, reward].every(Number.isFinite);
  check('finite_derived_amounts', finiteAmounts);
  if (!finiteAmounts) return { tradePlan: { ...normalized, costStatus: 'unknown', netTargetPnlUsd: null, netStopLossUsd: null }, riskChecks: checks, missingData: missing };
  const costs = input.executionCosts;
  const fields = ['entryUsd', 'stopExitUsd', 'targetExitUsd', 'fundingUsd'];
  const parsedCosts = Object.fromEntries(fields.map(key => [key, number(costs?.[key])]));
  const knownCosts = object(costs) && fields.every(key => parsedCosts[key] !== null && parsedCosts[key] >= 0)
    && nonempty(costs.source) && fresh(costs.observedAt, now) && number(costs.quantity) === qty
    && Number.isFinite(parsedCosts.entryUsd + parsedCosts.stopExitUsd + parsedCosts.fundingUsd + loss)
    && Number.isFinite(parsedCosts.entryUsd + parsedCosts.targetExitUsd + parsedCosts.fundingUsd);
  if (!knownCosts) missing.push('executionCosts');
  const netLoss = knownCosts ? loss + parsedCosts.entryUsd + parsedCosts.stopExitUsd + parsedCosts.fundingUsd : null;
  const netReward = knownCosts ? reward - parsedCosts.entryUsd - parsedCosts.targetExitUsd - parsedCosts.fundingUsd : null;
  check('positive_target_after_costs', netReward !== null && Number.isFinite(netReward) ? netReward > 0 : null);
  const limits = input.riskLimits;
  const limitEvidence = object(limits) && nonempty(limits.source);
  const riskValue = key => limitEvidence ? number(limits[key]) : null;
  const maxLoss = riskValue('maxLossUsd'), maxNotional = riskValue('maxNotionalUsd'), maxLeverage = riskValue('maxLeverage'), maxSlippage = riskValue('maxSlippageBps');
  check('max_loss', maxLoss !== null && maxLoss > 0 && netLoss !== null ? netLoss <= maxLoss : null, { netStopLossUsd: netLoss, maxLossUsd: maxLoss });
  check('max_notional', maxNotional !== null && maxNotional > 0 ? notional <= maxNotional : null, { notionalUsd: notional, maxNotionalUsd: maxNotional });
  check('max_leverage', maxLeverage !== null && maxLeverage > 0 && leverage !== null && leverage > 0 ? leverage <= maxLeverage : null);
  const execution = input.executionChecks;
  const executionFresh = object(execution) && fresh(execution.observedAt, now);
  for (const key of ['accountModeKnown', 'flat', 'noPendingEntry', 'filtersPassed']) {
    check(key, executionFresh && typeof execution[key] === 'boolean' ? execution[key] : null);
  }
  const available = executionFresh ? number(execution.availableMarginUsd) : null;
  check('available_margin', available !== null && available >= 0 && leverage !== null && leverage > 0 && knownCosts
    ? notional / leverage + parsedCosts.entryUsd <= available : null);
  const slippage = executionFresh ? number(execution.slippageBps) : null;
  check('max_slippage', maxSlippage !== null && maxSlippage >= 0 && slippage !== null && slippage >= 0 ? slippage <= maxSlippage : null);
  return {
    tradePlan: { ...normalized, direction, notionalUsd: notional, grossTargetPnlUsd: reward,
      grossStopLossUsd: loss, grossRewardRiskRatio: loss > 0 ? reward / loss : null,
      costStatus: knownCosts ? 'verified' : 'unknown', executionCosts: knownCosts ? { ...parsedCosts, source: costs.source, observedAt: costs.observedAt, quantity: qty } : null,
      netTargetPnlUsd: netReward, netStopLossUsd: netLoss,
      netRewardRiskRatio: netLoss !== null && netLoss > 0 ? netReward / netLoss : null,
      calibrated: false, expectedValueUsd: null },
    riskChecks: checks, missingData: missing
  };
}

/** Injectable config/evaluator/clock keep offline validation isolated from .env and network. */
export async function evaluateFutures(input, { provider = 'auto', runtimeConfig, evaluateImpl = evaluateSystemOne, now = Date.now } = {}) {
  const current = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(current)) return invalid('invalid_input', 'Invalid evaluation clock.');
  if (!object(input) || !/^[A-Z0-9]{2,30}$/.test(input.symbol ?? '')) return invalid('invalid_input', 'A valid symbol is required.');
  if (!['auto', 'agent', 'jev'].includes(provider)) return invalid('invalid_provider', 'provider must be auto, agent or jev.');
  const agentFailure = validateAgent(input, current);
  if (agentFailure) return agentFailure;
  const evidence = normalizeEvidence(input, current);
  if (evidence.error) return invalid('invalid_evidence', evidence.error);
  if (timestamp(input.agentAssessment.evaluatedAt) < timestamp(evidence.observedAt)) {
    return invalid('assessment_predates_evidence', 'Agent assessment predates the supplied market snapshot.');
  }
  const output = {
    schemaVersion: 1, success: true, status: 'evaluated', symbol: input.symbol,
    evaluatedAt: iso(current), observedAt: evidence.observedAt,
    agentAssessment: { ...input.agentAssessment }, jevAssessment: null,
    providerUsed: 'agent', jevStatus: 'not_requested', direction: input.agentAssessment.direction,
    setupType: input.agentAssessment.setupType ?? null, rationale: input.agentAssessment.rationale,
    counterEvidence: input.agentAssessment.counterEvidence, invalidations: input.agentAssessment.invalidations,
    probabilitySource: 'agent_unverified_assessment', calibrated: false,
    tradePlan: null, riskChecks: [], missingData: evidence.missingData,
    readyForHumanApproval: false, authorizationRequired: true
  };
  // Deterministic Agent-only use does not even load model credentials.
  const config = provider === 'agent' ? null : runtimeConfig ?? getConfig();
  if (provider === 'jev' && !nonempty(config?.apiKey)) {
    return { ...output, success: false, status: 'jev_not_configured', jevStatus: 'disabled_no_key' };
  }
  if (provider === 'auto' && !nonempty(config?.apiKey)) output.jevStatus = 'disabled_no_key';
  if (provider !== 'agent' && nonempty(config?.apiKey)) {
    try {
      const result = await evaluateImpl({ ...buildJevPayload(input, evidence), runtimeConfig: config });
      if (!object(result) || result.metrics?.isMock === true || result.isMock === true || /mock/i.test(result.model ?? '')) {
        return { ...output, success: false, status: 'mock_or_invalid_jev_result', jevStatus: 'invalid_result' };
      }
      const answer = result.answers?.direction;
      const confidence = answer?.confidence;
      if (!object(answer) || answer.type !== 'choice' || !DIRECTIONS.includes(answer.choice)
        || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return { ...output, success: false, status: 'invalid_jev_result', jevStatus: 'invalid_result' };
      }
      if (!object(answer.probabilities) || Object.keys(answer.probabilities).length !== DIRECTIONS.length
        || DIRECTIONS.some(key => typeof answer.probabilities[key] !== 'number' || !Number.isFinite(answer.probabilities[key]) || answer.probabilities[key] < 0 || answer.probabilities[key] > 1)
        || Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.001
        || answer.probabilities[answer.choice] + 1e-10 < Math.max(...Object.values(answer.probabilities))) {
        return { ...output, success: false, status: 'invalid_jev_result', jevStatus: 'invalid_result' };
      }
      output.jevAssessment = { direction: answer.choice, confidence: confidence ?? null,
        probabilities: answer.probabilities ?? null, source: nonempty(result.model) ? result.model : nonempty(config.model) ? config.model : 'Jev',
        evaluatedAt: iso(current), calibrated: false, probabilitySource: 'jev_unverified_judgment' };
      output.providerUsed = 'agent+jev';
      output.jevStatus = 'evaluated';
      output.probabilitySource = 'agent_and_jev_unverified_judgments';
      if (answer.choice !== output.direction) {
        output.status = 'assessment_conflict';
        output.direction = 'WAIT';
        output.setupType = null;
        output.missingData.push('resolve_agent_jev_direction_conflict');
      }
    } catch (error) {
      output.jevStatus = 'failed';
      output.jevErrorCode = nonempty(error?.code) ? error.code : 'JEV_EVALUATION_FAILED';
      if (provider !== 'auto' || !NETWORK_ERRORS.has(error?.code)) {
        return { ...output, success: false, status: 'jev_evaluation_failed' };
      }
      output.status = 'agent_fallback_network_error';
      output.jevStatus = 'network_failure_agent_fallback';
    }
  }
  const completed = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(completed) || timestamp(input.agentAssessment.expiresAt) <= completed) {
    return { ...output, success: false, status: 'expired_assessment', readyForHumanApproval: false };
  }
  output.evaluatedAt = iso(completed);
  if (completed - timestamp(evidence.observedAt) > 15 * 60_000) output.missingData.push('evidence_stale');
  if (['LONG', 'SHORT'].includes(input.agentAssessment.direction)) {
    const computed = computePlan(input, completed);
    output.tradePlan = computed.tradePlan;
    output.riskChecks = computed.riskChecks;
    output.missingData.push(...computed.missingData);
  }
  output.missingData = [...new Set(output.missingData)];
  output.readyForHumanApproval = ['LONG', 'SHORT'].includes(output.direction)
    && output.missingData.length === 0 && output.riskChecks.length > 0
    && output.riskChecks.every(check => check.status === 'passed');
  return output;
}

export async function runCli(args, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      stdout.write('Read-only futures assessment\n--evaluate (--stdin | --file PATH) [--provider auto|agent|jev]\n--describe-input\nNo trading requests or ledger writes.\n');
      return 0;
    }
    if (args.length === 1 && args[0] === '--describe-input') {
      stdout.write(JSON.stringify(INPUT_CONTRACT, null, 2) + '\n');
      return 0;
    }
    let file, provider = 'auto', useStdin = false, evaluate = false;
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (flag === '--evaluate') evaluate = true;
      else if (flag === '--stdin') useStdin = true;
      else if (flag === '--file' || flag === '--provider') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
        if (flag === '--file') file = value;
        else provider = value;
      } else throw new Error(`Unsupported flag: ${flag}`);
    }
    if (!evaluate || (useStdin ? 1 : 0) + (file ? 1 : 0) !== 1) throw new Error('Use --evaluate with exactly one of --stdin or --file PATH.');
    let text;
    if (file) text = await fs.readFile(file, 'utf8');
    else { text = ''; for await (const chunk of stdin) { text += chunk; if (text.length > 10_000_000) throw new Error('Input exceeds 10 MB.'); } }
    const output = await evaluateFutures(JSON.parse(text), { ...dependencies, provider });
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output.success ? 0 : 1;
  } catch {
    // Input paths, remote errors and raw JSON can contain secrets. Do not echo them.
    stderr.write('Invalid futures input or CLI arguments; use --describe-input and --help.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
