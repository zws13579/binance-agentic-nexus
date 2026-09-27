#!/usr/bin/env node
/**
 * Binance Agentic Nexus - Trade Journal & Audit Logger
 * Location: scripts/trade_journal.mjs
 *
 * Persists structured trade events to logs/trades/journal.jsonl
 * (Covered by .gitignore for complete confidentiality).
 *
 * Privacy Rule:
 * Strictly controlled by ENABLE_TRADE_JOURNAL in .env.
 * Defaults to false (Disabled) for complete zero-trace privacy.
 *
 * Usage:
 *   node scripts/trade_journal.mjs --last 10
 *   node scripts/trade_journal.mjs --summary
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

// Auto-load .env
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

const LOG_DIR = path.resolve(__dirname, '..', 'logs', 'trades');
const LOG_FILE = path.join(LOG_DIR, 'journal.jsonl');

/**
 * Record a trade event to disk (if enabled)
 * @param {Object} event
 * @param {string} event.action OPEN | CLOSE | SET_TPSL | CANCEL
 * @param {string} event.symbol
 * @param {string} [event.side]
 * @param {number} [event.quantity]
 * @param {number} [event.price]
 * @param {number} [event.realizedPnl]
 * @param {string} [event.note]
 */
export function recordTrade(event) {
  const isEnabled = (process.env.ENABLE_TRADE_JOURNAL || '').toLowerCase() === 'true';
  if (!isEnabled) {
    return { recorded: false, reason: 'ENABLE_TRADE_JOURNAL is false or unset' };
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      ...event
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
    return { recorded: true, record };
  } catch (err) {
    console.error('[TradeJournal Error] Failed to write journal:', err.message);
    return { recorded: false, error: err.message };
  }
}

export function readTrades(limit = 20) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function getSummary() {
  const all = readTrades(1000);
  if (all.length === 0) return { totalTrades: 0, message: 'No trades recorded yet.' };

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;

  for (const t of all) {
    if (t.realizedPnl !== undefined) {
      const pnl = parseFloat(t.realizedPnl);
      totalPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }
  }

  const closedCount = wins + losses;
  const winRate = closedCount > 0 ? ((wins / closedCount) * 100).toFixed(1) + '%' : 'N/A';

  return {
    totalEvents: all.length,
    closedTrades: closedCount,
    wins,
    losses,
    winRate,
    totalRealizedPnl: totalPnl.toFixed(4)
  };
}

// CLI Execution
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const isSummary = args.includes('--summary');
  const lastIdx = args.indexOf('--last');
  const limit = lastIdx !== -1 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1], 10) : 10;

  if (isSummary) {
    console.log('\n================ 交易日志复盘统计 (Trade Journal Summary) ================');
    console.log(JSON.stringify(getSummary(), null, 2));
    console.log('========================================================================\n');
  } else {
    const records = readTrades(limit);
    console.log(`\n================ 最近 ${records.length} 条交易记录 (Trade Journal) ================`);
    if (records.length === 0) {
      console.log('  (暂无交易日志。如需记录，请在 .env 中设置 ENABLE_TRADE_JOURNAL=true)');
    } else {
      console.table(records.map(r => ({
        '时间': r.timestamp ? r.timestamp.replace('T', ' ').slice(0, 19) : '',
        '动作': r.action || '',
        '标的': r.symbol || '',
        '方向': r.side || r.positionSide || '',
        '数量': r.quantity || '',
        '价格': r.price || '',
        '实现盈亏': r.realizedPnl || ''
      })));
    }
    console.log('========================================================================\n');
  }
}
