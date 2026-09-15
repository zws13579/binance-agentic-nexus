import { dirname, join } from 'node:path';

let setGlobalDispatcher, ProxyAgent;
try {
  ({ setGlobalDispatcher, ProxyAgent } = await import('undici'));
} catch {
  // Dynamically resolve undici from Node.js install / user directories (portable across machines)
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'undici', 'index.js'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node_modules', 'undici', 'index.js') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'undici', 'index.js') : ''
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      ({ setGlobalDispatcher, ProxyAgent } = await import('file:///' + c.replace(/\\/g, '/')));
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
