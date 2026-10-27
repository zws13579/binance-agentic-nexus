# Release checklist

Before publishing a release or source archive:

- [ ] Run `npm ci` and `npm test` on Node.js 24.
- [ ] Confirm the intended submodule pins and review their current license declarations.
- [ ] Resolve the provenance and redistribution scope of the skills vendored in early repository history, before the conversion to submodules. The root MIT license does not relicense that history.
- [ ] Review the Academy, Web3, and Square skill assets whose pinned trees do not declare a license; do not describe them as covered by the root MIT license.
- [ ] Review the release contents for secrets with a dedicated secret-scanning tool. Local pattern checks are not a complete secret audit.
- [ ] Review the release notes and CEX operating guidance for live-production and serial-protection limitations.
