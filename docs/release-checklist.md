# Release checklist

Before distributing source:

- [ ] Choose and document the distribution path: full root history or an independent current-tree snapshot. See [source-distribution.md](source-distribution.md).
- [ ] For full-history distribution, resolve the provenance and redistribution scope of all third-party content in the included history, including the early vendored skills. Changing repository visibility or the default branch does not remove older commits.
- [ ] For an independent snapshot, verify it has no parent from the original root history. Review the current tree, submodule pins, and all third-party terms; omitting earlier root commits does not resolve rights for content that remains in the snapshot or is fetched from submodules.
- [ ] Review skill assets whose pinned upstream trees do not declare a license; do not describe them as covered by the root MIT license.
- [ ] Run the supported project tests and dependency checks for the target runtime.
- [ ] Review the release contents for secrets with a dedicated secret-scanning tool. Local pattern checks are not a complete secret audit.
- [ ] Review the release notes and CEX operating guidance for live-production and serial-protection limitations.
