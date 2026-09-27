/**
 * Binance Client ESM Compatibility Bridge
 * Location: scripts/binance_client.mjs
 *
 * Allows modern ESM modules (e.g. pipeline.mjs, futures_scanner.mjs)
 * to directly import Client and helper utilities from binance_unified.js.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const unified = require('./binance_unified.js');

export const Client = unified.Client || unified;
export const BinanceError = unified.BinanceError;
export const TransactionContext = unified.TransactionContext;
export const generateClientOrderId = unified.generateClientOrderId;
export const normalizeOrder = unified.normalizeOrder;

export default Client;
