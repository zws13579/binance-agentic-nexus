# Contributing

Contributions should stay within the repository, preserve the pinned submodule commits unless the change explicitly updates them, and avoid adding credentials or generated runtime data.

## Local checks

- Use Node.js 24 and `npm ci`.
- Run `npm test`. The maintained suites are under `tests/` and the two custom skill script directories.
- Tests must use injected fake fetches or offline fixtures; do not send test requests to Binance or TypeSafe services.
- Keep `.js` files CommonJS and `.mjs` files ESM. Add runtime dependencies only when required by shipped code and pin them in `package.json` and `package-lock.json`.
- Put disposable one-off files in `tmp/` and remove only the artifacts created for that check.

Do not imply the root MIT license covers third-party skills or unresolved assets. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
