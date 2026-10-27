import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  } catch (cause) {
    throw new Error('Proxy mode requires the project dependency "undici". Run `npm ci` from the repository root.', { cause });
  }

  if (!setGlobalDispatcher || !ProxyAgent) {
    throw new Error('Installed undici does not provide ProxyAgent; reinstall project dependencies with `npm ci`.');
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
