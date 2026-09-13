import { dirname, join } from 'node:path';

let setGlobalDispatcher, ProxyAgent;
try {
  ({ setGlobalDispatcher, ProxyAgent } = await import('undici'));
} catch {
  // Fallback: resolve undici from the Node.js installation directory
  const nodeBin = dirname(process.execPath);
  const undiciPath = join(nodeBin, 'node_modules', 'undici', 'index.js');
  ({ setGlobalDispatcher, ProxyAgent } = await import('file:///' + undiciPath.replace(/\\/g, '/')));
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

try {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
} catch (e) {
  console.error('Failed to set ProxyAgent:', e);
}
