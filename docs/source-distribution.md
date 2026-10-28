# Source distribution

One source-distribution option is an independent root snapshot built from a selected current tree with no parent link to this repository's earlier root history. This omits prior root commits; it does not establish or change the license of third-party content in the current tree.

The current tree retains `.gitmodules` and its submodule gitlinks. A gitlink is a commit pointer, not a copy of the submodule repository or a license grant. A root Git bundle contains the root snapshot and its root files, but not submodule object databases. A root `git archive` likewise does not materialize submodule contents. To restore pinned submodules from a clone of a bundle, run `git submodule update --init --recursive`; this fetches the referenced commits from the configured upstreams and requires their availability.

For full-history distribution, resolve provenance and redistribution terms for the included history before publishing. Making the original repository public or changing its default branch does not isolate or remove earlier commits. The independent snapshot is a distribution option, not a resolution of outstanding third-party licensing questions. Its preparation does not mean a public repository has been created or published.
