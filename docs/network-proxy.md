# Network proxy modes

## TUN mode

When a system TUN proxy handles outbound traffic, run the Node scripts normally. Leave `HTTP_PROXY` and `HTTPS_PROXY` blank in `.env.example` and `.env` unless the local network setup requires otherwise.

## Port-proxy mode

By default, Node's built-in `fetch` does not automatically route requests through the proxy environment variables. The optional bootstrap uses the project-pinned `undici` `ProxyAgent` only when a proxy URL is configured:

```bash
npm ci
node --import ./scripts/proxy_bootstrap.mjs scripts/binance_unified.js ticker BTCUSDT
```

The dependency is resolved from this project. The bootstrap does not search Node, npm, or user-global installation directories. If local dependencies are missing or incompatible, it fails with a setup message rather than running without the requested proxy.

The ticker example makes a public GET request to Binance production. Proxy setup and the request destination are separate concerns: `BINANCE_API_ENV` accepts only `prod`; testnet support is not implemented. Tests use injected fake fetches and do not verify real proxy connectivity.

## Optional BAW CLI

The local `baw` installation does not automatically inherit this bootstrap. Some npm or installer updates may replace command shims. If a BAW workflow needs proxy routing, follow the selected CLI version's official project-local launch instructions and verify the actual route; do not treat this repository's Node bootstrap as proof that BAW is proxied.
