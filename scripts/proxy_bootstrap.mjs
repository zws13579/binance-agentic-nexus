import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let setGlobalDispatcher, ProxyAgent;
try {
  ({ setGlobalDispatcher, ProxyAgent } = await import('undici'));
} catch {
  // Dynamically resolve undici from Node.js install / user directories (portable across machines & Linux/WSL)
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'undici', 'index.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'undici', 'index.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', '@binance', 'agentic-wallet', 'node_modules', 'undici', 'index.js'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node_modules', 'undici', 'index.js') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'undici', 'index.js') : ''
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      ({ setGlobalDispatcher, ProxyAgent } = await import(pathToFileURL(c).href));
      if (setGlobalDispatcher && ProxyAgent) break;
    } catch {}
  }
}


process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

try {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
} catch (e) {
  console.error('Failed to set ProxyAgent:', e);
}
