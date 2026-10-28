# Third-party notices

These entries record the checked submodule pins and license declarations found in those pinned trees. They are not a blanket license grant for the repository.

## Binance Skills Hub

- Source: [binance/binance-skills-hub](https://github.com/binance/binance-skills-hub)
- Pinned commit: `76bb2f61d50164573fd949dc7a7192cf71294bd4`
- The `binance`, `fiat`, `onchain-pay`, and `p2p` skills each contain an MIT `LICENSE.md` naming Binance, copyright 2026: [binance](https://github.com/binance/binance-skills-hub/blob/76bb2f61d50164573fd949dc7a7192cf71294bd4/skills/binance/binance/LICENSE.md), [fiat](https://github.com/binance/binance-skills-hub/blob/76bb2f61d50164573fd949dc7a7192cf71294bd4/skills/binance/fiat/LICENSE.md), [onchain-pay](https://github.com/binance/binance-skills-hub/blob/76bb2f61d50164573fd949dc7a7192cf71294bd4/skills/binance/onchain-pay/LICENSE.md), and [p2p](https://github.com/binance/binance-skills-hub/blob/76bb2f61d50164573fd949dc7a7192cf71294bd4/skills/binance/p2p/LICENSE.md).
- The `payment` skill declares `license: MIT` in its [pinned `SKILL.md`](https://github.com/binance/binance-skills-hub/blob/76bb2f61d50164573fd949dc7a7192cf71294bd4/skills/binance/payment/SKILL.md) metadata.
- The pinned tree does not declare a license for the Academy skill, the broader Web3 skill tree, or `square-post`. The README's MIT example is a skill-authoring template and does not grant a license to those files. Their redistribution status remains unresolved.

## TypeSafe skills

- Source: [typesafe-ai/skills](https://github.com/typesafe-ai/skills)
- Pinned commit: `65a39f393687675ce170e6094757de20370365b9`
- The submodule root and `skills/typesafe-ai` each include an MIT license naming TypeSafe AI, copyright 2026: [root license](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/LICENSE) and [skill license](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/LICENSE).

## Scope and history

The root [`LICENSE`](LICENSE) applies to original project-owned code only. It does not relicense submodules or third-party content. The root history records the initial vendored skill tree (`14c1b76c224f7204a61dc632906465c38434618c`), its move into an `official` directory (`c48812b0c2a2381cb720c6fb3dce0f597669b2ff`), and the later replacement of tracked Binance skill files with a submodule gitlink (`12b540fabad52c1df69bb55a9ab2950637010de2`). A gitlink records a commit pointer; it is not a license grant.

The independent root snapshot described in [`docs/source-distribution.md`](docs/source-distribution.md) excludes earlier root commits, but it does not resolve the provenance or redistribution terms of third-party content still present in the current tree or its submodules. Keep this review open before distributing that content; see [`docs/release-checklist.md`](docs/release-checklist.md).
