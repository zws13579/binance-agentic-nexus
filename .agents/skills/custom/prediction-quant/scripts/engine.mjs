#!/usr/bin/env node
/**
 * 预测市场评估与执行内核 (Prediction Quant Engine)
 * 归属: .agents/skills/custom/prediction-quant/scripts/engine.mjs
 * 
 * 核心架构与设计精髓:
 * 1. 分层评估架构: 结构化输入、明确概率来源与事前风险状态。
 * 2. Agent 提供现场分析，Jev 是可选的结构化复核；统一 CLI/JSON，不依赖特定 harness。
 * 3. 欧赔乘法去水只生成外部赔率基准；该基准不宣称是真实胜率或已校准概率。
 * 4. 强制人类审批闸门 (Approval Gate): 下单操作必须显式提供 --approved，杜绝私自链上越权开仓。
 * 5. 零 Demo / 零虚构数据原则 (Zero-Demo Guardrail): 严禁内置任何假赛事或模拟盘口，实战必须全量依赖现场实时数据与真实 BAW 接口。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { evaluateSystemOne, getConfig } from '../../typesafe-evaluator/scripts/typesafe.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIN_LIQUIDITY_USD = 1000;

// =============================================================
// 1. 欧赔去水与特征工程数学算子 (纯粹确定性数学，无业务幻觉)
// =============================================================

/**
 * 欧赔乘法模型去水 (Multiplicative De-juicing)
 * @param {number} oddsA 选项 A 欧赔 (例如 1.59)
 * @param {number} oddsB 选项 B 欧赔 (例如 2.45)
 * @returns {{ probA: number, probB: number, margin: number }}
 */
export function dejuiceOdds(oddsA, oddsB) {
  if (!Number.isFinite(oddsA) || !Number.isFinite(oddsB) || oddsA <= 1 || oddsB <= 1) {
    throw new Error('赔率必须大于 1.00');
  }
  const rawProbA = 1 / oddsA;
  const rawProbB = 1 / oddsB;
  const sum = rawProbA + rawProbB;
  const margin = parseFloat((sum - 1).toFixed(4));
  const probA = parseFloat((rawProbA / sum).toFixed(4));
  const probB = parseFloat((rawProbB / sum).toFixed(4));
  return { probA, probB, margin };
}

/**
 * 计算期望价值 Expected Value (EV) 与优势基点
 * @param {number} calibratedProb 最终采用概率估计 (0.0 ~ 1.0)
 * @param {number} marketPrice 盘口当前代币买入价格 (0.0 ~ 1.0，如 0.60 意味着每胜出 1 份获利 1.00)
 * @param {number} stake 下注本金 (USDT，由人工决定，未声明则默认 1.00)
 */
export function calculateEV(estimatedProbability, marketPrice, stake = 1.0) {
  if (!Number.isFinite(estimatedProbability) || estimatedProbability < 0 || estimatedProbability > 1) {
    throw new Error('概率必须为 [0, 1] 内的有限数值');
  }
  if (!Number.isFinite(marketPrice) || marketPrice <= 0 || marketPrice >= 1) {
    throw new Error('盘口买入价格必须在 (0, 1) 区间内');
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error('下注金额必须为正的有限数值');
  }
  // 购买份数 = stake / marketPrice；若获胜总兑付 = 份数 * 1.00
  const payoutIfWon = stake / marketPrice;
  const evUsd = parseFloat((estimatedProbability * payoutIfWon - stake).toFixed(4));
  const evPercent = parseFloat(((evUsd / stake) * 100).toFixed(2));
  const discrepancyBps = Math.round((estimatedProbability - marketPrice) * 10000);

  return {
    stake,
    marketPrice,
    payoutIfWon: parseFloat(payoutIfWon.toFixed(4)),
    evUsd,
    evPercent,
    discrepancyBps,
    isPositiveEV: evUsd > 0
  };
}

function nonNegativeFiniteOrNull(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    throw new Error(fieldName + ' 必须为非负有限数值');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} 必须为非负有限数值`);
  }
  return parsed;
}

function observedAtOrNull(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${fieldName} 必须是可解析的时间戳`);
  return text;
}

function validateOutcomeLabel(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} 必须是非空选项标识`);
  }
  return value.trim();
}

function parseOptionalFinite(value) {
  if (value === null || value === undefined || value === '' ||
      (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== ''))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalTimestamp(value) {
  if (value === null || value === undefined || value === '' ||
      (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 构造标准 PredictionTradeState (特征工程)
 */
export function buildPredictionTradeState({
  market,
  eventId = null,
  marketId = null,
  tokenId = null,
  targetOutcome = null,
  opponentOutcome = null,
  category = 'esports',
  marketPrice,
  marketObservedAt = null,
  liquidityUsd = null,
  sharpOdds = null,
  sharpProb = null,
  sharpSource = null,
  sharpObservedAt = null,
  executionCosts = null,
  agentAssessment = null,
  sentiment = {},
  bankroll = {}
}) {
  if (!market || typeof market !== 'string' || !Number.isFinite(marketPrice) || marketPrice <= 0 || marketPrice >= 1) {
    throw new Error('构建 TradeState 必须包含现场真实 market 标题与 marketPrice');
  }

  const observedMarketAt = observedAtOrNull(marketObservedAt, 'marketObservedAt');
  const normalizedLiquidity = nonNegativeFiniteOrNull(liquidityUsd, 'liquidityUsd');
  const sentimentInput = sentiment && typeof sentiment === 'object' && !Array.isArray(sentiment) ? sentiment : {};
  const bankrollInput = bankroll && typeof bankroll === 'object' && !Array.isArray(bankroll) ? bankroll : {};
  let dejuicedProb = null;
  let sharpMargin = 0;
  const hasSharpOdds = sharpOdds && typeof sharpOdds === 'object' &&
    sharpOdds.target !== undefined && sharpOdds.opponent !== undefined;
  const hasSharpProbability = sharpProb !== null && sharpProb !== undefined;
  let sharpBookmaker = null;

  if (hasSharpOdds || hasSharpProbability) {
    const source = typeof sharpSource === 'string' ? sharpSource.trim() : '';
    const observedAt = observedAtOrNull(sharpObservedAt, 'sharpObservedAt');
    const target = validateOutcomeLabel(targetOutcome, 'targetOutcome');
    const opponent = validateOutcomeLabel(opponentOutcome, 'opponentOutcome');
    if (target === opponent) throw new Error('targetOutcome 与 opponentOutcome 必须是不同选项');
    if (!source || !observedAt) {
      throw new Error('独立尖头盘数据必须提供 sharpSource 与 sharpObservedAt');
    }

    if (hasSharpOdds) {
      const oddsTarget = Number(sharpOdds.target);
      const oddsOpponent = Number(sharpOdds.opponent);
      const dj = dejuiceOdds(oddsTarget, oddsOpponent);
      dejuicedProb = dj.probA;
      sharpMargin = dj.margin;
      sharpBookmaker = {
        source,
        observedAt,
        targetOutcome: target,
        opponentOutcome: opponent,
        targetOdds: oddsTarget,
        opponentOdds: oddsOpponent,
        rawTargetProbability: parseFloat((1 / oddsTarget).toFixed(6)),
        rawOpponentProbability: parseFloat((1 / oddsOpponent).toFixed(6)),
        dejuicedProb,
        margin: sharpMargin
      };
    } else {
      if (typeof sharpProb !== 'number' && !(typeof sharpProb === 'string' && sharpProb.trim() !== '')) {
        throw new Error('sharpProb 必须为 [0, 1] 内的有限数值');
      }
      const probability = Number(sharpProb);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('sharpProb 必须为 [0, 1] 内的有限数值');
      }
      dejuicedProb = probability;
      sharpBookmaker = {
        source,
        observedAt,
        targetOutcome: target,
        opponentOutcome: opponent,
        rawTargetProbability: probability,
        dejuicedProb
      };
    }
  }

  const impliedProb = parseFloat(marketPrice.toFixed(4));
  const discrepancyBps = dejuicedProb === null ? null : Math.round((dejuicedProb - marketPrice) * 10000);
  const normalizedSentiment = {};
  for (const [field, value] of Object.entries({
    polarScore: sentimentInput.polarScore,
    rosterRisk: sentimentInput.rosterRisk,
    fatigueRisk: sentimentInput.fatigueRisk
  })) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      normalizedSentiment[field] = null;
      continue;
    }
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
      throw new Error(field + ' 必须是有限数值');
    }
    const parsed = Number(value);
    const min = field === 'polarScore' ? -1 : 0;
    if (!Number.isFinite(parsed) || parsed < min || parsed > 1) {
      throw new Error(`${field} 必须为 [${min}, 1] 内的有限数值`);
    }
    normalizedSentiment[field] = parseFloat(parsed.toFixed(2));
  }

  // A requested stake or unit bet is not a verified account limit.
  const maxBetUsd = nonNegativeFiniteOrNull(bankrollInput.maxBetUsd, 'bankroll.maxBetUsd');
  const accountBalanceUsd = nonNegativeFiniteOrNull(bankrollInput.balance, 'bankroll.balance');
  const allowed = {
    targetActionAllowed: typeof bankrollInput.targetActionAllowed === 'boolean' ? bankrollInput.targetActionAllowed : null,
    maxBetUsd,
    accountBalanceUsd
  };

  const state = {
    market,
    eventId: eventId === null ? null : String(eventId),
    marketId: marketId === null ? null : String(marketId),
    tokenId: tokenId === null ? null : String(tokenId),
    targetOutcome: targetOutcome === null ? null : String(targetOutcome),
    opponentOutcome: opponentOutcome === null ? null : String(opponentOutcome),
    category,
    marketPrice: parseFloat(marketPrice.toFixed(4)),
    impliedProb,
    marketObservedAt: observedMarketAt,
    liquidityUsd: normalizedLiquidity === null ? null : Math.round(normalizedLiquidity),
    sharpBookmaker,
    sharpFairProbability: dejuicedProb === null ? null : parseFloat(dejuicedProb.toFixed(4)),
    discrepancyBps,
    sentiment: normalizedSentiment,
    allowed,
    riskEnvelopeStatus: bankrollInput.targetActionAllowed === false
      ? 'blocked'
      : bankrollInput.targetActionAllowed === true && maxBetUsd !== null && accountBalanceUsd !== null
        ? 'provided'
        : 'unknown',
    executionCosts,
    agentAssessment
  };

  return state;
}

function getSharpAnchor(state) {
  const benchmark = state?.sharpBookmaker;
  if (!benchmark || typeof benchmark !== 'object') {
    const legacyProbability = state?.sharpFairProbability;
    const parsedLegacyProbability = parseOptionalFinite(legacyProbability);
    if (parsedLegacyProbability !== null && Number.isFinite(parsedLegacyProbability) &&
        parsedLegacyProbability >= 0 && parsedLegacyProbability <= 1) {
      return {
        status: 'unverified', probability: null,
        unverifiedProbability: parsedLegacyProbability,
        source: null,
        observedAt: null,
        independentOdds: null,
        rawProbability: null
      };
    }
    if (legacyProbability !== null && legacyProbability !== undefined && legacyProbability !== '') {
      return {
        status: 'invalid',
        probability: null,
        source: null,
        observedAt: null,
        independentOdds: null,
        rawProbability: null
      };
    }
    return { status: 'missing', probability: null, source: null, observedAt: null, independentOdds: null, rawProbability: null };
  }

  const rawProbability = benchmark.dejuicedProb ?? state.sharpFairProbability;
  if (rawProbability === null || rawProbability === undefined || rawProbability === '') {
    return { status: 'missing', probability: null, source: null, observedAt: null, independentOdds: null, rawProbability: null };
  }
  const probability = parseOptionalFinite(rawProbability);
  if (probability === null || probability < 0 || probability > 1) {
    return {
      status: 'invalid',
      probability: null,
      source: benchmark.source || null,
      observedAt: benchmark.observedAt || null,
      independentOdds: null,
      rawProbability: null
    };
  }

  const target = state.targetOutcome ?? state.outcome?.target ?? null;
  const opponent = state.opponentOutcome ?? state.outcome?.opponent ?? null;
  const source = typeof benchmark.source === 'string' ? benchmark.source.trim() : '';
  let observedAt;
  try {
    observedAt = observedAtOrNull(benchmark.observedAt, 'sharpBookmaker.observedAt');
  } catch {
    return { status: 'invalid', probability: null, source, observedAt: null, independentOdds: null, rawProbability: null };
  }
  const mappedTarget = typeof benchmark.targetOutcome === 'string' ? benchmark.targetOutcome.trim() : '';
  const mappedOpponent = typeof benchmark.opponentOutcome === 'string' ? benchmark.opponentOutcome.trim() : '';
  const targetOdds = parseOptionalFinite(benchmark.targetOdds);
  const opponentOdds = parseOptionalFinite(benchmark.opponentOdds);
  const independentOdds = targetOdds !== null && opponentOdds !== null
    ? { target: targetOdds, opponent: opponentOdds }
    : null;
  const rawInputProbability = parseOptionalFinite(benchmark.rawTargetProbability);

  if (!source || !observedAt || !target || !opponent || !mappedTarget || !mappedOpponent) {
    return {
      status: 'unverified', probability: null,
      unverifiedProbability: probability,
      source: source || null,
      observedAt,
      independentOdds,
      rawProbability: rawInputProbability
    };
  }
  if (mappedTarget !== String(target).trim() || mappedOpponent !== String(opponent).trim()) {
    return { status: 'mismatch', probability: null, source, observedAt, independentOdds: null, rawProbability: null };
  }

  return {
    status: 'verified',
    probability,
    source,
    observedAt,
    independentOdds,
    rawProbability: rawInputProbability !== null
      ? rawInputProbability
      : probability
  };
}

function assessExecutionCosts(executionCosts, grossEV) {
  if (!executionCosts || typeof executionCosts !== 'object') {
    return { status: 'unknown', totalUsd: null, netEV: null };
  }
  if (executionCosts.totalUsd === null || executionCosts.totalUsd === undefined || executionCosts.totalUsd === '' ||
      executionCosts.stakeUsd === null || executionCosts.stakeUsd === undefined || executionCosts.stakeUsd === '') {
    return { status: 'unverified', totalUsd: null, netEV: null };
  }
  const numericCostFields = [executionCosts.totalUsd, executionCosts.stakeUsd];
  if (numericCostFields.some(value => typeof value !== 'number' &&
      !(typeof value === 'string' && value.trim() !== ''))) {
    return { status: 'unverified', totalUsd: null, netEV: null };
  }
  const totalUsd = Number(executionCosts.totalUsd);
  const stakeUsd = Number(executionCosts.stakeUsd);
  const source = typeof executionCosts.source === 'string' ? executionCosts.source.trim() : '';
  let observedAt;
  try {
    observedAt = observedAtOrNull(executionCosts.observedAt, 'executionCosts.observedAt');
  } catch {
    return { status: 'unverified', totalUsd: null, netEV: null };
  }
  if (!Number.isFinite(totalUsd) || totalUsd < 0 || !Number.isFinite(stakeUsd) || stakeUsd <= 0 ||
      Math.abs(stakeUsd - grossEV.stake) > 0.000001 || !source || !observedAt) {
    return { status: 'unverified', totalUsd: null, netEV: null };
  }
  const netEV = {
    evUsd: parseFloat((grossEV.evUsd - totalUsd).toFixed(4)),
    evPercent: parseFloat((((grossEV.evUsd - totalUsd) / grossEV.stake) * 100).toFixed(2)),
    isPositiveEV: grossEV.evUsd - totalUsd > 0
  };
  return { status: 'verified', totalUsd, stakeUsd, source, observedAt, netEV };
}

function assessmentFailure(status, message, metrics = null) {
  return {
    success: false,
    status,
    error: message,
    decision: {
      action: 'evaluation_unavailable',
      probability: null,
      calibrated: false,
      grossEV: null,
      netEV: null,
      costStatus: 'unknown',
      riskEnvelopeStatus: 'unknown',
      readyForHumanApproval: false
    },
    metrics
  };
}

export const AGENT_ASSESSMENT_SCHEMA = {
  type: 'object',
  required: ['eventId', 'marketId', 'targetOutcome', 'probability', 'action', 'source', 'evaluatedAt', 'rationale'],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    marketId: { type: 'string', minLength: 1 },
    targetOutcome: { type: 'string', minLength: 1 },
    probability: { type: 'number', minimum: 0, maximum: 1 },
    action: { enum: ['enter', 'pass', 'reject'] },
    source: { type: 'string', minLength: 1, description: '实际分析 Agent / 模型标识；不是独立赔率来源' },
    evaluatedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', description: '可选；过期后必须重新分析' },
    rationale: { type: 'string', minLength: 1 },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }
  }
};

function validateAgentAssessment(state, assessment) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    return assessmentFailure('agent_assessment_required', '当前 Agent 需根据现场数据填写 state.agentAssessment；可用 --describe-input 查看 JSON 契约。');
  }
  if (assessment.isMock === true || assessment.metrics?.isMock === true) {
    return assessmentFailure('mock_blocked', 'Mock 不能作为 Agent 分析输入。');
  }
  for (const field of ['eventId', 'marketId', 'targetOutcome', 'source', 'evaluatedAt', 'rationale']) {
    if (typeof assessment[field] !== 'string' || !assessment[field].trim()) {
      return assessmentFailure('invalid_agent_assessment', 'agentAssessment 缺少有效字段：' + field);
    }
  }
  for (const field of ['eventId', 'marketId', 'targetOutcome']) {
    if (assessment[field] !== state[field]) {
      return assessmentFailure('agent_outcome_mismatch', 'Agent 分析与当前 state 的 ' + field + ' 不匹配。');
    }
  }
  if (!Number.isFinite(assessment.probability) || assessment.probability < 0 || assessment.probability > 1) {
    return assessmentFailure('invalid_model_probability', 'Agent 概率必须是 [0, 1] 内的数值。');
  }
  if (!['enter', 'pass', 'reject'].includes(assessment.action)) {
    return assessmentFailure('invalid_model_decision', 'Agent action 必须为 enter、pass 或 reject。');
  }
  if (assessment.confidence != null &&
      (!Number.isFinite(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 1)) {
    return assessmentFailure('invalid_agent_assessment', 'Agent confidence 必须为 [0, 1] 内数值或 null。');
  }
  const estimatedAt = Date.parse(assessment.evaluatedAt);
  const now = Date.now();
  if (!Number.isFinite(estimatedAt) || estimatedAt > now + 60000) {
    return assessmentFailure('invalid_agent_timestamp', 'Agent evaluatedAt 无效或位于未来。');
  }
  if (assessment.expiresAt !== undefined) {
    const expiry = typeof assessment.expiresAt === 'string' ? Date.parse(assessment.expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= estimatedAt) {
      return assessmentFailure('invalid_agent_timestamp', 'expiresAt 必须晚于 evaluatedAt。');
    }
    if (expiry <= now) return assessmentFailure('agent_assessment_expired', 'Agent 分析已过期，请更新现场数据和分析。');
  }
  return null;
}

/** Both providers share the same math, provenance and execution checks. */
export function buildOpportunityAssessment(state, evalResult, { stake = null, provider = 'jev' } = {}) {
  if (!['agent', 'jev'].includes(provider)) {
    return assessmentFailure('invalid_provider', 'provider 必须为 agent 或 jev。');
  }
  if (provider === 'agent') {
    const failure = validateAgentAssessment(state, evalResult);
    if (failure) return failure;
  }
  if (evalResult?.metrics?.isMock === true) {
    return assessmentFailure('mock_blocked', 'Mock 输出仅供测试，不能生成预测建议。', evalResult.metrics);
  }

  const anchor = getSharpAnchor(state);
  if (anchor.status === 'invalid' || anchor.status === 'mismatch') {
    return assessmentFailure('invalid_independent_anchor', '独立赔率无效或与目标选项映射不一致。', evalResult?.metrics);
  }

  const rawValue = provider === 'agent' ? evalResult?.probability
    : evalResult?.answers?.jev_probability_estimate?.noul ?? evalResult?.answers?.calibrated_prob?.noul;
  const modelProbability = typeof rawValue === 'number' ? rawValue : NaN;
  if (rawValue === null || rawValue === undefined || rawValue === '' ||
      !Number.isFinite(modelProbability) || modelProbability < 0 || modelProbability > 1) {
    return assessmentFailure('invalid_model_probability', '评估未提供 [0, 1] 内的合法概率；没有回退到 Mock 或默认概率。', evalResult?.metrics);
  }

  const modelAction = provider === 'agent'
    ? ({ enter: 'execute_plus_ev', pass: 'pass_no_bet', reject: 'reject_negative_ev' })[evalResult?.action]
    : evalResult?.answers?.direction?.choice;
  const validActions = new Set(['execute_plus_ev', 'reject_negative_ev', 'pass_no_bet']);
  if (!validActions.has(modelAction)) {
    return assessmentFailure('invalid_model_decision', '评估未提供合法的方向判断。', evalResult?.metrics);
  }

  const marketPrice = parseOptionalFinite(state.marketPrice);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0 || marketPrice >= 1) {
    return assessmentFailure('invalid_market_price', '市场价格必须为 (0, 1) 内的有限数值。', evalResult?.metrics);
  }
  // Preserve the documented human-sized default; a maximum limit is a cap, not a requested stake.
  const chosenStake = stake !== null && stake !== undefined ? parseOptionalFinite(stake) : 1.0;

  const probability = anchor.status === 'verified'
    ? Math.min(anchor.probability + 0.05, Math.max(anchor.probability - 0.05, modelProbability))
    : modelProbability;
  const grossEV = calculateEV(probability, marketPrice, chosenStake);
  const costs = assessExecutionCosts(state.executionCosts, grossEV);
  const parsedMaxBetUsd = parseOptionalFinite(state.allowed?.maxBetUsd);
  const maxBetUsd = parsedMaxBetUsd !== null && parsedMaxBetUsd >= 0
    ? parsedMaxBetUsd
    : null;
  const parsedAccountBalanceUsd = parseOptionalFinite(state.allowed?.accountBalanceUsd);
  const accountBalanceUsd = parsedAccountBalanceUsd !== null && parsedAccountBalanceUsd >= 0
    ? parsedAccountBalanceUsd
    : null;
  const riskEnvelopeStatus = state.allowed?.targetActionAllowed === false
    ? 'blocked'
    : state.allowed?.targetActionAllowed === true && maxBetUsd !== null && accountBalanceUsd !== null
      ? chosenStake > maxBetUsd || chosenStake > accountBalanceUsd
        ? 'blocked'
        : 'provided_allowed'
      : 'unknown';
  const parsedLiquidityUsd = state.liquidityUsd === null || state.liquidityUsd === undefined || state.liquidityUsd === ''
    ? null
    : parseOptionalFinite(state.liquidityUsd);
  const liquidityUsd = parsedLiquidityUsd !== null && parsedLiquidityUsd >= 0 ? parsedLiquidityUsd : null;
  const liquidityStatus = liquidityUsd === null
    ? 'unknown'
    : liquidityUsd < MIN_LIQUIDITY_USD
      ? 'below_minimum'
      : 'sufficient';

  let action;
  if (riskEnvelopeStatus === 'blocked') {
    action = 'blocked_by_risk_limit';
  } else if (anchor.status !== 'verified') {
    if (costs.status === 'verified' && !costs.netEV.isPositiveEV) {
      action = 'reject_net_ev';
    } else {
      action = modelAction === 'execute_plus_ev' && grossEV.evPercent > 3
        ? 'unanchored_model_estimate'
        : 'unanchored_model_estimate_no_entry';
    }
  } else if (modelAction !== 'execute_plus_ev' || grossEV.evPercent <= 3) {
    action = modelAction === 'reject_negative_ev' ? 'reject_negative_ev' : 'pass_no_bet';
  } else if (costs.status !== 'verified') {
    action = 'gross_positive_net_unknown';
  } else if (!costs.netEV.isPositiveEV) {
    action = 'reject_net_ev';
  } else {
    action = 'net_positive_candidate';
  }
  if (action === 'net_positive_candidate' && riskEnvelopeStatus === 'unknown') {
    action = 'risk_envelope_unknown';
  }
  if (action === 'net_positive_candidate' && liquidityStatus === 'unknown') {
    action = 'liquidity_unknown';
  } else if (liquidityStatus === 'below_minimum' &&
      ['net_positive_candidate', 'gross_positive_net_unknown', 'risk_envelope_unknown', 'unanchored_model_estimate'].includes(action)) {
    action = 'blocked_by_insufficient_liquidity';
  }

  const confidenceValue = parseOptionalFinite(provider === 'agent' ? evalResult?.confidence : evalResult?.answers?.direction?.confidence);
  const confidence = confidenceValue !== null && confidenceValue >= 0 && confidenceValue <= 1
    ? confidenceValue
    : null;
  const evaluatedAt = new Date().toISOString();
  const blockers = [];
  if (modelAction !== 'execute_plus_ev' || grossEV.evPercent <= 3) blockers.push('no_entry_signal');
  if (riskEnvelopeStatus !== 'provided_allowed') blockers.push('risk_envelope_' + riskEnvelopeStatus);
  if (liquidityStatus !== 'sufficient') blockers.push('liquidity_' + liquidityStatus);
  if (costs.status !== 'verified') blockers.push('costs_' + costs.status);
  else if (!costs.netEV.isPositiveEV) blockers.push('nonpositive_net_ev');
  const readyForHumanApproval = blockers.length === 0;

  return {
    success: true,
    status: anchor.status === 'verified' ? 'anchored_estimate' : 'unanchored_estimate',
    forecast: {
      eventId: state.eventId ?? null,
      marketId: state.marketId ?? null,
      tokenId: state.tokenId ?? null,
      targetOutcome: state.targetOutcome ?? null,
      opponentOutcome: state.opponentOutcome ?? null,
      evaluatedAt,
      marketObservedAt: state.marketObservedAt ?? null,
      marketProbability: marketPrice,
      liquidityUsd,
      liquidityStatus,
      riskInputs: {
        targetActionAllowed: typeof state.allowed?.targetActionAllowed === 'boolean'
          ? state.allowed.targetActionAllowed
          : null,
        maxBetUsd,
        accountBalanceUsd
      },
      sentiment: {
        polarScore: state.sentiment?.polarScore ?? null,
        rosterRisk: state.sentiment?.rosterRisk ?? null,
        fatigueRisk: state.sentiment?.fatigueRisk ?? null
      },
      independentAnchorStatus: anchor.status,
      independentProbability: anchor.status === 'verified' ? anchor.probability : null,
      independentProbabilitySource: anchor.source ?? null,
      independentProbabilityObservedAt: anchor.observedAt ?? null,
      independentOdds: anchor.independentOdds ?? null,
      independentRawProbability: anchor.rawProbability ?? null,
      unverifiedIndependentProbability: anchor.status === 'unverified' ? anchor.unverifiedProbability : null,
      evaluationProvider: provider,
      modelProbability,
      jevProbability: provider === 'jev' ? modelProbability : null,
      agentProbability: provider === 'agent' ? modelProbability : null,
      probability,
      probabilitySource: anchor.status === 'verified'
        ? 'sharp_anchor_bounded_' + provider + '_adjustment'
        : provider + '_unanchored_estimate',
      calibrated: false
    },
    decision: {
      action,
      modelSuggestedAction: modelAction,
      confidence,
      riskEnvelopeStatus,
      liquidityStatus,
      costStatus: costs.status,
      grossEV,
      netEV: costs.netEV,
      costUsd: costs.totalUsd,
      costSource: costs.source ?? null,
      costObservedAt: costs.observedAt ?? null,
      readyForHumanApproval,
      executionEligibility: {
        status: readyForHumanApproval ? 'eligible_for_human_review' : 'not_ready',
        blockers,
        requiresApproval: true
      }
    },
    metrics: evalResult.metrics ?? null,
    rawJevResult: provider === 'jev' ? evalResult : null,
    rawAgentAssessment: provider === 'agent' ? evalResult : null
  };
}

function scoreProbability(records, field, binCount) {
  const usable = records.filter(record => Number.isFinite(record.probabilities?.[field]));
  if (usable.length === 0) return null;
  const brierScore = usable.reduce((sum, record) => sum + ((record.probabilities[field] - record.outcome) ** 2), 0) / usable.length;
  const correct = usable.filter(record => (record.probabilities[field] >= 0.5 ? 1 : 0) === record.outcome).length;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    meanProbability: null,
    observedFrequency: null
  }));
  for (const record of usable) {
    const p = record.probabilities[field];
    const index = Math.min(Math.floor(p * binCount), binCount - 1);
    bins[index].count += 1;
    bins[index].meanProbability = (bins[index].meanProbability || 0) + p;
    bins[index].observedFrequency = (bins[index].observedFrequency || 0) + record.outcome;
  }
  for (const bin of bins) {
    if (bin.count) {
      bin.meanProbability = parseFloat((bin.meanProbability / bin.count).toFixed(6));
      bin.observedFrequency = parseFloat((bin.observedFrequency / bin.count).toFixed(6));
    }
  }
  const pnlRecords = usable.map(record => ({
    value: record.netPnlUsdBySource?.[field] ?? (field === 'workflow' ? record.netPnlUsd : null)
  })).filter(record => Number.isFinite(record.value));
  const costRecords = usable.map(record => ({
    value: record.actualCostsUsdBySource?.[field] ?? (field === 'workflow' ? record.actualCostUsd : null)
  })).filter(record => Number.isFinite(record.value));
  return {
    sampleSize: usable.length,
    brierScore: parseFloat(brierScore.toFixed(6)),
    hitRate: parseFloat((correct / usable.length).toFixed(6)),
    bins,
    netPnlUsd: pnlRecords.length === usable.length
      ? parseFloat(pnlRecords.reduce((sum, record) => sum + record.value, 0).toFixed(4))
      : null,
    netPnlSampleSize: pnlRecords.length,
    actualCostUsd: costRecords.length === usable.length
      ? parseFloat(costRecords.reduce((sum, record) => sum + record.value, 0).toFixed(4))
      : null,
    actualCostSampleSize: costRecords.length
  };
}

/** Score a caller-provided, in-memory history snapshot. This function never writes files. */
export function scoreForecastRecords(records, { binCount = 10 } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('评分文件必须至少包含一条预测记录');
  if (!Number.isInteger(binCount) || binCount < 2 || binCount > 20) throw new Error('binCount 必须为 2 到 20 的整数');
  const normalized = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`第 ${index + 1} 条记录必须是 JSON 对象`);
    }
    const rawOutcome = record.outcome;
    const validOutcomeType = typeof rawOutcome === 'number' ||
      (typeof rawOutcome === 'string' && rawOutcome.trim() !== '') ||
      typeof rawOutcome === 'boolean';
    const outcome = rawOutcome === true ? 1 : rawOutcome === false ? 0 : Number(rawOutcome);
    if (!validOutcomeType) throw new Error(`第 ${index + 1} 条记录的 outcome 必须是 0 或 1`);
    if (outcome !== 0 && outcome !== 1) throw new Error(`第 ${index + 1} 条记录的 outcome 必须是 0 或 1`);
    const probabilities = {};
    for (const field of ['workflow', 'market', 'human']) {
      const value = record.probabilities?.[field];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
        throw new Error(`第 ${index + 1} 条记录的 ${field} 概率必须是数值`);
      }
      const probability = Number(value);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error(`第 ${index + 1} 条记录的 ${field} 概率必须为 [0, 1]`);
      }
      probabilities[field] = probability;
    }
    if (!Number.isFinite(probabilities.workflow)) throw new Error(`第 ${index + 1} 条记录缺少 probabilities.workflow`);
    if (record.netPnlUsd !== null && record.netPnlUsd !== undefined &&
        typeof record.netPnlUsd !== 'number' &&
        !(typeof record.netPnlUsd === 'string' && record.netPnlUsd.trim() !== '')) {
      throw new Error(`第 ${index + 1} 条记录的 netPnlUsd 必须是数值`);
    }
    const netPnlUsd = record.netPnlUsd === null || record.netPnlUsd === undefined
      ? null
      : Number(record.netPnlUsd);
    if (netPnlUsd !== null && !Number.isFinite(netPnlUsd)) throw new Error(`第 ${index + 1} 条记录的 netPnlUsd 必须是有限数值`);
    const netPnlUsdBySource = {};
    if (record.netPnlUsdBySource !== undefined) {
      if (!record.netPnlUsdBySource || typeof record.netPnlUsdBySource !== 'object' || Array.isArray(record.netPnlUsdBySource)) {
        throw new Error(`第 ${index + 1} 条记录的 netPnlUsdBySource 必须是对象`);
      }
      for (const field of ['workflow', 'market', 'human']) {
        const value = record.netPnlUsdBySource[field];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
          throw new Error(`第 ${index + 1} 条记录的 ${field} 净盈亏必须是数值`);
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`第 ${index + 1} 条记录的 ${field} 净盈亏必须是有限数值`);
        netPnlUsdBySource[field] = parsed;
      }
    }
    const actualCostUsd = record.actualCostUsd === null || record.actualCostUsd === undefined
      ? null
      : Number(record.actualCostUsd);
    if (actualCostUsd !== null &&
        (typeof record.actualCostUsd !== 'number' &&
          !(typeof record.actualCostUsd === 'string' && record.actualCostUsd.trim() !== '') ||
          !Number.isFinite(actualCostUsd) || actualCostUsd < 0)) {
      throw new Error(`第 ${index + 1} 条记录的 actualCostUsd 必须是非负有限数值`);
    }
    const actualCostsUsdBySource = {};
    if (record.actualCostsUsdBySource !== undefined) {
      if (!record.actualCostsUsdBySource || typeof record.actualCostsUsdBySource !== 'object' ||
          Array.isArray(record.actualCostsUsdBySource)) {
        throw new Error(`第 ${index + 1} 条记录的 actualCostsUsdBySource 必须是对象`);
      }
      for (const field of ['workflow', 'market', 'human']) {
        const value = record.actualCostsUsdBySource[field];
        if (value === null || value === undefined) continue;
        const parsed = Number(value);
        if ((typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) ||
            !Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`第 ${index + 1} 条记录的 ${field} 实际成本必须是非负有限数值`);
        }
        actualCostsUsdBySource[field] = parsed;
      }
    }
    return {
      eventId: record.eventId ?? null,
      outcome,
      probabilities,
      netPnlUsd,
      netPnlUsdBySource,
      actualCostUsd,
      actualCostsUsdBySource
    };
  });

  const comparisons = {};
  for (const field of ['workflow', 'market', 'human']) comparisons[field] = scoreProbability(normalized, field, binCount);
  const pairedRecords = normalized.filter(record =>
    ['workflow', 'market', 'human'].every(field => Number.isFinite(record.probabilities[field]))
  );
  const pairedComparisons = {};
  for (const field of ['workflow', 'market', 'human']) {
    pairedComparisons[field] = scoreProbability(pairedRecords, field, binCount);
  }
  return {
    sampleSize: normalized.length,
    binCount,
    comparisons,
    sameEventComparison: {
      sampleSize: pairedRecords.length,
      comparisons: pairedComparisons
    }
  };
}

export function parseForecastJsonl(contents) {
  if (typeof contents !== 'string') throw new Error('JSONL 内容必须是文本');
  return contents.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new Error(`JSONL 第 ${index + 1} 行格式无效`);
    }
  });
}

// =============================================================
// 2. 参数安全校验白名单 (彻底消除命令注入与数据越界)
// =============================================================

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateSafeId(val, paramName) {
  if (val === null || val === undefined) {
    throw new Error(`缺少必填参数 [${paramName}]`);
  }
  const str = String(val).trim();
  if (!SAFE_ID_REGEX.test(str)) {
    throw new Error(`参数 [${paramName}] 格式无效或包含非法字符，必须为字母、数字、下划线或短横线`);
  }
  return str;
}

export function validateTokenIds(val) {
  if (!val) throw new Error('缺少必填参数 [tokenIds]');
  const list = Array.isArray(val) ? val : String(val).split(',');
  if (list.length === 0) throw new Error('tokenIds 列表不能为空');
  const cleanList = list.map(item => {
    const s = String(item).trim();
    if (!SAFE_ID_REGEX.test(s)) {
      throw new Error(`tokenId [${s}] 格式无效或包含非法字符`);
    }
    return s;
  });
  return cleanList.join(',');
}

export function validatePositiveNumber(val, paramName, max = 1000000) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > max) {
    throw new Error(`参数 [${paramName}] 必须为在 (0, ${max}] 范围内的有效有限数值`);
  }
  return num;
}

export function validateInteger(val, paramName, min = 0, max = 1000000) {
  const num = Number(val);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`参数 [${paramName}] 必须为在 [${min}, ${max}] 范围内的有效整数`);
  }
  return num;
}

/**
 * 安全执行 BAW 命令 (使用 execFileSync 数组传参，彻底消除 Shell 注入)
 * @param {string[]} argsArray 参数数组，如 ['prediction', 'market', 'list', ...]
 */
export function runBaw(argsArray) {
  if (!Array.isArray(argsArray)) {
    throw new Error('runBaw 必须接收参数数组，严禁拼接 shell 字符串');
  }
  try {
    const stdout = execFileSync('baw', argsArray, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      env: { ...process.env }
    });
    return JSON.parse(stdout);
  } catch (err) {
    let stdout = err.stdout?.toString() || '';
    let stderr = err.stderr?.toString() || '';
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch (_) {}
    }
    throw new Error(`BAW 执行异常: ${stderr || stdout || err.message}`);
  }
}

// =============================================================
// 3. 核心业务工作流 (现场真实数据，杜绝伪造)
// =============================================================

/**
 * 扫描现场真实预测市场机会
 */
export async function scanMarkets({
  l1Category = 'esports',
  limit = 20,
  minLiquidity = MIN_LIQUIDITY_USD,
  marketLister = runBaw
} = {}) {
  const safeCategory = validateSafeId(l1Category, 'l1Category');
  const safeLimit = validateInteger(limit, 'limit', 1, 100);
  const safeMinLiquidity = validatePositiveNumber(minLiquidity, 'minLiquidity', 1e9);

  let result;
  try {
    result = marketLister([
      'prediction', 'market', 'list',
      '--l1Category', safeCategory,
      '--limit', String(safeLimit),
      '--sortBy', 'VOLUME',
      '--orderBy', 'DESC',
      '--json'
    ]);
  } catch (err) {
    if (err.message.includes('NOT_LOGGED_IN') || err.message.includes('10003000')) {
      return {
        success: false,
        error: 'BAW 钱包未登录 (code: 10003000)。请在终端运行 `baw auth signin` 完成扫码登录后重试。严禁使用任何伪造数据！',
        requireAuth: true
      };
    }
    throw err;
  }

  if (!result || !result.success) {
    if (result?.error?.code === 10003000) {
      return {
        success: false,
        error: 'BAW 钱包未登录。请先在终端运行 `baw auth signin` 完成扫码登录。',
        requireAuth: true
      };
    }
    return result;
  }

  const topics = result.data?.marketTopics || [];
  const marketCandidates = [];
  const now = Date.now();

  for (const t of topics) {
    const isLive = t.liveStatus === 'LIVE';
    const startDateMs = parseOptionalTimestamp(t.startDate);
    const isUpcoming = startDateMs !== null && startDateMs > now && startDateMs < now + 24 * 3600 * 1000;
    const topicId = t.marketTopicId ?? t.topicId ?? null;
    if (isLive || isUpcoming) {
      for (const m of (t.markets || [])) {
        if (m.tradingStatus != null && m.tradingStatus !== 'OPEN') continue;
        const reportedLiquidity = parseOptionalFinite(m.liquidity);
        const liquidity = reportedLiquidity !== null && reportedLiquidity >= 0 ? reportedLiquidity : null;
        if (liquidity !== null && liquidity < safeMinLiquidity) continue;
        const outcomes = (m.outcomes || []).map(o => ({
          tokenId: o.tokenId,
          outcome: o.name,
          price: parseOptionalFinite(o.price),
          chance: parseOptionalFinite(o.chance)
        }));
        if (outcomes.length < 2) continue;
        marketCandidates.push({
          topicId,
          marketTopicId: topicId,
          marketId: m.marketId,
          eventId: t.eventId ?? topicId,
          title: t.title,
          marketTitle: m.title ?? null,
          question: m.question ?? null,
          tradingStatus: m.tradingStatus ?? null,
          game: t.l2Categories?.[0] || safeCategory,
          liquidity,
          liquidityUsd: liquidity,
          liquidityStatus: liquidity === null ? 'unknown' : 'sufficient',
          liquidityThresholdMet: liquidity !== null && liquidity >= safeMinLiquidity,
          tradeVolume: parseOptionalFinite(m.tradeVolume),
          startDate: startDateMs === null ? null : new Date(startDateMs).toISOString(),
          scannedAt: new Date(now).toISOString(),
          isLive,
          outcomes
        });
      }
    }
  }

  const selectedMarkets = marketCandidates.slice(0, safeLimit);
  return {
    success: true,
    totalScanned: topics.length,
    candidatesCount: selectedMarkets.length,
    eligibleCount: selectedMarkets.filter(market => market.liquidityThresholdMet).length,
    unknownLiquidityCount: selectedMarkets.filter(market => market.liquidityStatus === 'unknown').length,
    candidates: selectedMarkets
  };
}

/**
 * Provider selection is independent of the host Agent and of trade authorization.
 */
export async function evaluateOpportunity(state, {
  model = null,
  stake = null,
  provider = 'auto',
  runtimeConfig,
  timeoutMs = 15000,
  evaluator = evaluateSystemOne
} = {}) {
  if (!state || typeof state !== 'object' || !state.market) {
    throw new Error('必须传入现场真实的特征工程数据 State，严禁使用假数据！');
  }
  if (!['auto', 'agent', 'jev'].includes(provider)) {
    return assessmentFailure('invalid_provider', 'provider 必须为 auto、agent 或 jev。');
  }
  // A key inherited from a harness does not enable Jev: the project .env is the switch.
  const config = runtimeConfig ?? getConfig();
  const hasKey = typeof config.apiKey === 'string' && Boolean(config.apiKey.trim());
  const agentInput = state.agentAssessment;
  const agentFailure = agentInput == null ? null : validateAgentAssessment(state, agentInput);
  const evaluation = {
    requestedProvider: provider,
    provider: null,
    mode: null,
    reason: null,
    jevStatus: provider === 'agent' ? 'not_requested' : hasKey ? 'configured' : 'not_configured',
    jevError: null
  };
  const finish = (assessment, selected, reason) => {
    const usedAgent = Boolean(agentInput) && !agentFailure;
    if (assessment.success && usedAgent) {
      // A supplied expiry may elapse while awaiting the optional second opinion.
      const expired = validateAgentAssessment(state, agentInput);
      if (expired) assessment = expired;
    }
    assessment.evaluation = {
      ...evaluation, provider: selected, reason,
      mode: selected === 'agent' ? 'agent_only' : selected === 'jev' ? usedAgent ? 'agent_with_jev' : 'jev_only' : null
    };
    if (assessment.success && usedAgent) {
      assessment.rawAgentAssessment = agentInput;
      assessment.forecast.agentProbability = agentInput.probability;
      assessment.forecast.agentSource = agentInput.source;
      assessment.forecast.agentEvaluatedAt = agentInput.evaluatedAt;
      assessment.forecast.agentExpiresAt = agentInput.expiresAt ?? null;
      assessment.decision.agentSuggestedAction = agentInput.action;
      assessment.decision.agentJevProbabilityDifference = selected === 'jev'
        ? assessment.forecast.jevProbability - agentInput.probability : null;
      // Jev can advise, but cannot override the host Agent's explicit abstention.
      if (selected === 'jev' && agentInput.action !== 'enter' &&
          assessment.decision.modelSuggestedAction === 'execute_plus_ev') {
        assessment.decision.action = 'agent_review_required';
        assessment.decision.readyForHumanApproval = false;
        assessment.decision.executionEligibility.status = 'not_ready';
        assessment.decision.executionEligibility.blockers.push('agent_did_not_recommend_entry');
      }
    }
    return assessment;
  };
  const useAgent = reason => {
    if (agentFailure) return finish(agentFailure, null, reason);
    try {
      return finish(buildOpportunityAssessment(state, agentInput, { stake, provider: 'agent' }), 'agent', reason);
    } catch (error) {
      return finish(assessmentFailure('invalid_assessment_input', error.message), null, reason);
    }
  };
  if (agentFailure) return finish(agentFailure, null, 'invalid_agent_input');
  if (provider === 'agent') return useAgent('explicit_agent');
  if (!hasKey) {
    if (provider === 'auto') return useAgent('jev_not_configured');
    return finish(assessmentFailure('jev_disabled', '.env 未配置 TYPESAFE_API_KEY，Jev 已禁用；使用 auto 或 agent 模式可继续。'), null, 'jev_not_configured');
  }

  let anchor;
  try {
    anchor = getSharpAnchor(state);
  } catch (error) {
    return finish(assessmentFailure('invalid_independent_anchor', error.message), null, 'invalid_input');
  }
  if (anchor.status === 'invalid' || anchor.status === 'mismatch') {
    return finish(assessmentFailure('invalid_independent_anchor', '独立赔率无效或与目标选项映射不一致。'), null, 'invalid_input');
  }
  const evaluationState = { ...state };
  // The second opinion sees the evidence, not the first opinion or execution permissions.
  delete evaluationState.agentAssessment;
  delete evaluationState.allowed;
  delete evaluationState.riskEnvelopeStatus;
  if (anchor.status !== 'verified') {
    // Do not let unverified legacy fields masquerade as independent evidence.
    for (const field of ['sharpBookmaker', 'sharpFairProbability', 'sharpOdds', 'sharpProb', 'sharpSource', 'sharpObservedAt', 'discrepancyBps']) {
      delete evaluationState[field];
    }
  }

  // 构造结构化 Questions 规范
  const questions = {
    direction: {
      type: 'choice',
      instructions: {
        goal: 'Estimate the target outcome from the supplied evidence and assess its gross expected margin. Execution limits and authorization are checked separately by code.',
        inputs: 'A verified independent, dejuiced bookmaker probability is the only external probability anchor. If none is supplied, estimate the target outcome from the available evidence and state that the estimate is uncalibrated. Treat missing liquidity, roster, fatigue, bankroll, and cost data as unknown; never infer safe or favorable values from missing fields. Evaluate the named target outcome only and do not interpret execution restrictions as evidence for either side.',
        criteria: {
          execute_plus_ev: 'The supplied evidence supports a positive expected margin (> 3%). If the probability is not independently anchored, treat this only as an uncalibrated model estimate and never describe it as verified edge.',
          reject_negative_ev: 'The trade exhibits negative EV, insufficient margin buffer (< 3%), or unacceptable roster/fatigue disruption risks.',
          pass_no_bet: 'The book is illiquid, evidence is insufficient, or fair pricing is ambiguous.'
        }
      }
    },
    jev_probability_estimate: {
      type: 'noul',
      instructions: 'Estimate the probability (0.0 to 1.0) that the explicitly named target outcome wins from the supplied evidence. This is a model estimate, not a statistically calibrated probability. Do not invent missing odds, liquidity, roster, fatigue, bankroll, or cost data.'
    },
    risk_score: {
      type: 'score',
      instructions: 'Assess the risk category of this position based on volatility, information asymmetry, and series format stability.',
      criteria: [
        'Very Low Risk - Elite liquidity, massive statistical edge (>500 bps), highly stable roster in standard BO3 format.',
        'Low Risk - Solid positive EV, stable roster, verified sharp bookmaker alignment.',
        'Medium Risk - Moderate positive EV, minor roster adjustments, or slight schedule fatigue.',
        'High Risk - Thin margin edge (<200 bps), high variance BO1 format, or retail-dominated volume.',
        'Extreme Risk - Negative EV, major emergency substitute, or severe liquidity trap.'
      ]
    }
  };

  let evalResult;
  try {
    evalResult = await evaluator({ state: evaluationState, questions, model, forceMock: false, runtimeConfig: config, timeoutMs });
  } catch (error) {
    evaluation.jevStatus = 'failed';
    evaluation.jevError = { code: error.code || 'evaluation_failed', message: 'Jev 评估未完成。' };
    const outageCodes = ['TYPESAFE_API_REQUEST_FAILED', 'TYPESAFE_API_HTTP_ERROR', 'TYPESAFE_API_TIMEOUT'];
    if (provider === 'auto' && agentInput && outageCodes.includes(error.code)) {
      return useAgent('jev_unavailable_using_agent');
    }
    return finish(assessmentFailure(error.code || 'evaluation_failed', 'Jev 评估失败；没有生成替代概率。'), null, 'jev_failed');
  }

  try {
    const assessment = buildOpportunityAssessment(state, evalResult, { stake, provider: 'jev' });
    evaluation.jevStatus = assessment.success ? 'succeeded' : 'invalid_result';
    return finish(assessment, assessment.success ? 'jev' : null, 'configured_jev');
  } catch (error) {
    return finish(assessmentFailure('invalid_assessment_input', error.message, evalResult?.metrics), null, 'invalid_input');
  }
}

/** Evaluate every outcome supplied for one market before presenting a side. */
export async function evaluateMarketOutcomes(states, options = {}) {
  if (!Array.isArray(states) || states.length < 2) {
    throw new Error('中立比较至少需要同一市场的两个 outcome');
  }
  const first = states[0];
  const eventId = first?.eventId;
  const marketId = first?.marketId;
  if (!eventId || !marketId) throw new Error('成对评估必须提供 eventId 和 marketId');
  const outcomes = new Set();
  for (const state of states) {
    if (state?.eventId !== eventId || state?.marketId !== marketId) {
      throw new Error('成对评估中的所有 outcomes 必须属于同一 eventId 和 marketId');
    }
    if (typeof state.targetOutcome !== 'string' || !state.targetOutcome.trim()) {
      throw new Error('成对评估的每个 outcome 都必须有 targetOutcome 标识');
    }
    const key = state.targetOutcome.trim();
    if (outcomes.has(key)) throw new Error(`成对评估存在重复 outcome: ${key}`);
    outcomes.add(key);
  }

  const assessments = await Promise.all(states.map(state => evaluateOpportunity(state, options)));
  const modelCandidates = assessments.filter(assessment =>
    assessment.success &&
    assessment.decision.modelSuggestedAction === 'execute_plus_ev' &&
    assessment.decision.grossEV?.isPositiveEV
  );
  const complete = assessments.every(assessment => assessment.success);
  const comparisonStatus = !complete ? 'incomplete_evaluation'
    : modelCandidates.length === 0 ? 'no_model_candidate'
      : modelCandidates.length === 1 ? 'single_model_candidate' : 'ambiguous_multiple_sides';
  if (!complete || modelCandidates.length > 1) {
    for (const assessment of assessments.filter(item => item.success)) {
      assessment.decision.readyForHumanApproval = false;
      assessment.decision.executionEligibility.status = 'not_ready';
      assessment.decision.executionEligibility.blockers.push(comparisonStatus);
    }
  }
  return {
    success: complete,
    eventId,
    marketId,
    comparisonStatus,
    candidateOutcomes: modelCandidates.map(assessment => assessment.forecast.targetOutcome),
    assessments
  };
}

/** Shared quote/place-order policy. Price bounds are this wrapper's constraint. */
export function predictionOrderArgs({ orderType = 'MARKET', priceLimit } = {}) {
  if (orderType !== 'MARKET' && orderType !== 'LIMIT') {
    throw new Error('orderType 必须为 MARKET 或 LIMIT');
  }
  if (orderType === 'MARKET') {
    if (priceLimit !== undefined) throw new Error('MARKET 不允许 priceLimit');
    return ['--orderType', orderType];
  }
  if ((typeof priceLimit !== 'number' && typeof priceLimit !== 'string') ||
      (typeof priceLimit === 'string' && !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(priceLimit)) ||
      !Number.isFinite(Number(priceLimit)) || Number(priceLimit) <= 0 || Number(priceLimit) >= 1) {
    throw new Error('LIMIT 必须提供 priceLimit，本封装要求 USDT 价格在 (0, 1) 内');
  }
  return ['--orderType', orderType, '--priceLimit', String(Number(priceLimit))];
}

/** Reject typos, missing values, duplicates and mixed commands before any BAW call. */
export function parsePredictionTradeArgs(argv) {
  const command = argv.includes('--quote') ? '--quote' : '--execute';
  const allowed = new Set(command === '--quote'
    ? ['--tokenId', '--marketTopicId', '--amount', '--orderType', '--priceLimit']
    : ['--quoteId', '--slippageBps', '--orderType', '--priceLimit']);
  const values = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    seen.add(flag);
    if (flag === command) continue;
    if (command === '--execute' && flag === '--approved') { values.approved = true; continue; }
    if (!allowed.has(flag)) throw new Error(`未知或不适用参数: ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    values[flag.slice(2)] = value;
  }
  predictionOrderArgs(values);
  return values;
}

/**
 * 盘口报价 (Quote)
 */
export async function quotePrediction({
  tokenId,
  marketTopicId,
  amount = 1.0,
  side = 'BUY',
  binanceChainId = 56,
  orderType = 'MARKET',
  priceLimit
}, { orderExecutor = runBaw } = {}) {
  const orderArgs = predictionOrderArgs({ orderType, priceLimit });
  const safeTokenId = validateSafeId(tokenId, 'tokenId');
  const safeTopicId = validateSafeId(marketTopicId, 'marketTopicId');
  const safeAmount = validatePositiveNumber(amount, 'amount', 100000);
  const safeSide = String(side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const safeChainId = validateInteger(binanceChainId, 'binanceChainId', 1, 1e8);

  return orderExecutor([
    'prediction', 'trade', 'quote',
    '--binanceChainId', String(safeChainId),
    '--tokenId', safeTokenId,
    '--marketTopicId', safeTopicId,
    '--side', safeSide,
    '--amount', String(safeAmount),
    ...orderArgs,
    '--json'
  ]);
}

/**
 * 执行交易 (Execute - 强制审批闸门)
 */
export async function executePrediction({
  quoteId,
  slippageBps = 1000,
  approved = false,
  orderType = 'MARKET',
  priceLimit
}, { orderExecutor = runBaw } = {}) {
  if (approved !== true) {
    return {
      success: false,
      blockedByApprovalGate: true,
      error: '【安全保护闸门拦截】真实资金交易严禁未经人类授权自动开仓！必须提供 --approved 明确确认指令。'
    };
  }

  const orderArgs = predictionOrderArgs({ orderType, priceLimit });
  const safeQuoteId = validateSafeId(quoteId, 'quoteId');
  const safeSlippage = validateInteger(slippageBps, 'slippageBps', 0, 5000);

  return orderExecutor([
    'prediction', 'trade', 'place-order',
    '--quoteId', safeQuoteId,
    '--slippageBps', String(safeSlippage),
    ...orderArgs,
    '--json'
  ]);
}

/**
 * 胜出头寸批量结算赎回 (Redeem)
 */
export async function redeemSettled({
  tokenIds,
  binanceChainId = 56
}) {
  const safeTokenIds = validateTokenIds(tokenIds);
  const safeChainId = validateInteger(binanceChainId, 'binanceChainId', 1, 1e8);

  return runBaw([
    'prediction', 'trade', 'redeem',
    '--tokenIds', safeTokenIds,
    '--binanceChainId', String(safeChainId),
    '--json'
  ]);
}

// =============================================================
// 4. 命令行 CLI 分发 (无任何 Demo 指令与硬编码赛事)
// =============================================================

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const hasFlag = (flag) => args.includes(flag);

async function main() {
  if (args.length === 0 || hasFlag('--help') || hasFlag('-h')) {
    console.log(`
预测市场量化决策执行内核 (Prediction Quant Engine)
===================================================
位置: .agents/skills/custom/prediction-quant/scripts/engine.mjs

核心指令 (只接受现场真实数据，严禁 Demo 与伪造数据):
  --scan                  扫描现场高流动性市场 (--l1Category esports --limit 5；limit 为市场数，每个市场保留全部选项)
  --evaluate              评估并输出概率来源/毛净EV状态 (单个 state 或同一市场的 state 数组)
  --provider <mode>       auto (默认)：.env 有 Key 时使用 Jev，无 Key 时使用 Agent；agent / jev 显式选择
  --stdin                 从标准输入读取评估 JSON；也可用 --json <JSON> 或 --file <path>
  --describe-input        输出跨 harness 的输入契约与 Agent 分析 schema，无网络请求
  --timeout-ms <ms>       Jev 请求期限，默认 15000；仅影响可选 Jev 调用
  --score-file <path>     只读评分用户提供的 JSONL 历史 (workflow/market/human 概率与赛果)
  --quote                 向盘口请求精确深度报价 (--tokenId <id> --marketTopicId <id> [--amount <num> 未声明默认 1.0])
  --execute               执行链上下单 (--quoteId <id> --approved) [安全闸门强制拦截未审批操作]
  --orderType <type>      quote/execute: MARKET (默认) 或 LIMIT；两步必须一致
  --priceLimit <price>    LIMIT 必填，USDT 价格 (0,1)；MARKET 禁用；LIMIT 不保证 Maker
  --slippageBps <bps>     execute: 使用报价返回值；默认 1000 仅为兼容旧调用
  --redeem                赎回已结算胜出头寸 (--tokenIds <id1,id2>)
  --auto-redeem           自动巡检并一键赎回所有已结算获胜头寸
  test                    本地纯数学与安全闸门检查，不调用网络或钱包
    `);
    process.exit(0);
  }

  if (hasFlag('--quote') || hasFlag('--execute')) parsePredictionTradeArgs(args);

  if (hasFlag('--describe-input')) {
    console.log(JSON.stringify({
      contractVersion: 1,
      input: '单个 state 或同一 eventId/marketId 的 state 数组',
      stateFields: {
        required: ['market', 'marketPrice'],
        identity: ['eventId', 'marketId', 'tokenId', 'targetOutcome', 'opponentOutcome'],
        optional: ['marketObservedAt', 'sharpBookmaker', 'liquidityUsd', 'sentiment', 'allowed', 'executionCosts', 'agentAssessment']
      },
      agentAssessment: AGENT_ASSESSMENT_SCHEMA,
      provider: { default: 'auto', modes: ['auto', 'agent', 'jev'], enableJev: '项目 .env 中的非空 TYPESAFE_API_KEY' },
      transport: ['--stdin', '--json', '--file'],
      persistence: 'none',
      authorization: '交易仍需人类批准并显式 --approved；概率估计不构成授权'
    }, null, 2));
    return;
  }

  // 1. Local-only math and safety smoke checks. Detailed tests run with node --test.
  if (args.includes('test')) {
    console.log('>>> [TEST] 启动预测市场内核纯数学算子与安全闸门单元测试...');

    // 算子 1: 欧赔去水数学测试 (2.0 vs 2.0 纯对半)
    const djTest = dejuiceOdds(2.0, 2.0);
    if (djTest.probA !== 0.5 || djTest.probB !== 0.5 || djTest.margin !== 0) {
      throw new Error(`去水数学算子校验失败: ${JSON.stringify(djTest)}`);
    }
    console.log('1. [PASS] 欧赔去水数学公式校验通过 (probA=0.5, probB=0.5, margin=0.0)');

    // 算子 2: EV 期望价值计算测试 (标定胜率 60%，买价 0.50，本金 1U -> EV = +0.20U / +20%)
    const evTest = calculateEV(0.60, 0.50, 1.0);
    if (evTest.evUsd !== 0.20 || evTest.evPercent !== 20.0 || !evTest.isPositiveEV) {
      throw new Error(`EV 期望价值算子校验失败: ${JSON.stringify(evTest)}`);
    }
    console.log('2. [PASS] 期望价值 (EV) 纯数学算子校验通过 (EV=+$0.20, +20.0%)');

    // 算子 3: 人类审批闸门物理拦截测试
    const gateTest = await executePrediction({ quoteId: 'test_liveness_id', approved: false });
    if (!gateTest.blockedByApprovalGate) {
      throw new Error('人类审批闸门失效！');
    }
    console.log('3. [PASS] 人类审批闸门物理拦截校验通过 (未授权操作 100% 阻断)');

    // 算子 4: 命令注入防护与参数白名单校验测试
    let injectionBlocked = false;
    try {
      validateSafeId('esports; touch /tmp/injection_test', 'l1Category');
    } catch (_) {
      injectionBlocked = true;
    }
    if (!injectionBlocked) {
      throw new Error('命令注入校验防线失效！');
    }
    console.log('4. [PASS] 命令注入防护与参数白名单校验通过 (非法字符 100% 拦截)');

    // 算子 5: runBaw 数组参数强制校验测试
    let arrayArgEnforced = false;
    try {
      runBaw('prediction market list');
    } catch (_) {
      arrayArgEnforced = true;
    }
    if (!arrayArgEnforced) {
      throw new Error('runBaw 数组参数强制防线失效！');
    }
    console.log('5. [PASS] runBaw 数组传参物理防线校验通过 (严禁拼接 shell 字符串)');

    console.log('\n>>> [TEST] 本地检查通过；未调用 Jev API、BAW 或真实钱包。\n');
    process.exit(0);
  }

  if (hasFlag('--score-file')) {
    const filePath = getArg('--score-file');
    if (!filePath) {
      console.error('错误: --score-file 必须提供 JSONL 文件路径');
      process.exit(1);
    }
    const records = parseForecastJsonl(fs.readFileSync(filePath, 'utf8'));
    const binCount = parseInt(getArg('--bins') || '10', 10);
    const report = scoreForecastRecords(records, { binCount });
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // 2. 扫描现场市场 (必须直通 BAW，禁止任何假数据 fallback)
  if (hasFlag('--scan')) {
    const l1Category = getArg('--l1Category') || 'esports';
    const limit = parseInt(getArg('--limit') || '10', 10);
    const minLiquidity = parseFloat(getArg('--min-liquidity') || '1000');

    const scanRes = await scanMarkets({ l1Category, limit, minLiquidity });
    console.log(JSON.stringify(scanRes, null, 2));
    process.exit(scanRes.success ? 0 : 1);
  }

  // 3. 量化标定评估 (必须传入真实 JSON)
  if (hasFlag('--evaluate')) {
    let state = null;
    const jsonStr = getArg('--json');
    const filePath = getArg('--file');
    const inputCount = Number(hasFlag('--stdin')) + Number(hasFlag('--json')) + Number(hasFlag('--file'));
    if (inputCount !== 1) throw new Error('评估需且只需 --stdin、--json、--file 中一种输入。');

    if (hasFlag('--stdin')) {
      state = JSON.parse(fs.readFileSync(0, 'utf8'));
    } else if (jsonStr) {
      state = JSON.parse(jsonStr);
    } else if (filePath) {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      console.error('【拒绝执行】必须提供 --json 或 --file 传入现场真实特征工程数据！严禁使用默认 Demo 数据！');
      process.exit(1);
    }

    const amountArg = getArg('--amount');
    const stake = amountArg ? parseFloat(amountArg) : null;
    const modelArg = getArg('--model') || null;
    const options = {
      stake, model: modelArg, provider: getArg('--provider') || 'auto',
      timeoutMs: getArg('--timeout-ms') === null ? 15000 : Number(getArg('--timeout-ms'))
    };
    const evalRes = Array.isArray(state)
      ? await evaluateMarketOutcomes(state, options)
      : await evaluateOpportunity(state, options);
    console.log(JSON.stringify(evalRes, null, 2));
    process.exit(evalRes.success ? 0 : 1);
  }

  // 4. 询价 Quote
  if (hasFlag('--quote')) {
    const { tokenId, marketTopicId, amount = 1.0, orderType, priceLimit } = parsePredictionTradeArgs(args);

    if (!tokenId || !marketTopicId) {
      console.error('错误: 缺少 --tokenId 或 --marketTopicId');
      process.exit(1);
    }

    const q = await quotePrediction({ tokenId, marketTopicId, amount, orderType, priceLimit });
    console.log(JSON.stringify(q, null, 2));
    process.exit(q.success ? 0 : 1);
  }

  // 5. 执行下单 Execute
  if (hasFlag('--execute')) {
    const { quoteId, slippageBps = 1000, approved = false, orderType, priceLimit } = parsePredictionTradeArgs(args);

    if (!quoteId) {
      console.error('错误: 缺少 --quoteId');
      process.exit(1);
    }

    const execRes = await executePrediction({ quoteId, slippageBps, approved, orderType, priceLimit });
    console.log(JSON.stringify(execRes, null, 2));
    process.exit(execRes.success ? 0 : 1);
  }

  // 6. 结算赎回 Redeem
  if (hasFlag('--redeem')) {
    const tokenIds = getArg('--tokenIds');

    if (!tokenIds) {
      console.error('错误: 缺少 --tokenIds');
      process.exit(1);
    }

    const redRes = await redeemSettled({ tokenIds: tokenIds.split(',') });
    console.log(JSON.stringify(redRes, null, 2));
    process.exit(redRes.success ? 0 : 1);
  }

  // 7. 自动巡检与一键赎回 Auto-Redeem
  if (hasFlag('--auto-redeem')) {
    const listRes = runBaw(['prediction', 'position', 'list', '--tab', 'PENDING_CLAIM', '--json']);
    if (!listRes.success) {
      console.error('查询可赎回持仓失败:', listRes.error);
      process.exit(1);
    }
    const claimable = listRes.data?.positions || [];
    if (claimable.length === 0) {
      console.log(JSON.stringify({ success: true, message: '当前没有待领取的胜场奖金 (0 claimable positions)', count: 0 }, null, 2));
      process.exit(0);
    }
    const tokenIds = claimable.map(p => p.tokenId).filter(Boolean);
    console.log(`[Auto-Redeem] 检测到 ${tokenIds.length} 笔获胜待领取头寸，正在执行批量自动赎回...`);
    const redRes = await redeemSettled({ tokenIds });
    console.log(JSON.stringify(redRes, null, 2));
    process.exit(redRes.success ? 0 : 1);
  }
  throw new Error('未知命令；使用 --help 查看 CLI。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(JSON.stringify({ success: false, status: 'invalid_request', error: err.message }));
    process.exit(1);
  });
}
