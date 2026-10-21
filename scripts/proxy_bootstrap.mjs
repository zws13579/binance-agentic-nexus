import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Pre-load .env from project root or process.cwd() if exists
const __bootstrapDir = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(__bootstrapDir, '../.env'),
  resolve(process.cwd(), '.env'),
];
for (const envFile of envCandidates) {
  if (fs.existsSync(envFile)) {
    try {
      const content = fs.readFileSync(envFile, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      }
      break;
    } catch {}
  }
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (proxyUrl) {
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

  if (!setGlobalDispatcher || !ProxyAgent) {
    throw new Error('ProxyAgent unavailable');
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
