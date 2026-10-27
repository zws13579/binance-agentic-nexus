# Local setup

## Node.js workspace

This repository's own CEX scripts and tests use Node.js 24. From a fresh clone:

```bash
git clone --recurse-submodules https://github.com/zws13579/binance-agentic-nexus.git
cd binance-agentic-nexus
nvm install
npm ci
npm test
```

The test suite uses fake network responses and needs no `.env`, Binance credentials, `baw`, or live API access. Successful tests verify local code paths only; they do not certify account permissions, exchange behavior, production connectivity, or third-party skills.

Copy `.env.example` to `.env` only for workflows that need configuration. Public ticker and scanner requests still contact Binance production. Keep the proxy variables blank when TUN is enabled. `BINANCE_API_ENV` defaults to `prod`; any configured value other than `prod` is rejected because testnet is not implemented.

## Optional BAW CLI

The `baw` command is used by some Web3 and prediction-market skills, but is not a dependency of the root package or required by `npm test`. If a workflow needs it, install a pinned release into this project without changing the root manifest or lockfile:

```bash
npm install --no-save --no-package-lock @binance/agentic-wallet@1.12.0
export PATH="$PWD/node_modules/.bin:$PATH"
baw --version
```

The version in the example is an optional package pin, not a compatibility certification. Check each selected skill's pinned prerequisites and verify the installed CLI locally. `npm ci` removes this no-save package, so reinstall it when needed after running `npm ci`.

## Port-proxy mode

For systems without a TUN proxy, configure `HTTP_PROXY` and `HTTPS_PROXY` in `.env`, install the project dependencies with `npm ci`, then opt into the bootstrap:

```bash
node --import ./scripts/proxy_bootstrap.mjs scripts/binance_unified.js ticker BTCUSDT
```

If `undici` is missing, the bootstrap stops with a local `npm ci` instruction. See [network proxy notes](network-proxy.md). The example above makes a public production GET request.

## Credentials and real operations

Use separate least-privilege API credentials. Enable read access only for account inspection; do not enable trading or universal-transfer permissions unless a specific authorized workflow needs them. Never commit `.env` or print credential values. Dry-run order and funding workflows still make live read requests. An approved order can submit real requests, and entry/protection steps are serial rather than atomic. Review the [CEX SOP](sop-cex-trading.md) before use.
