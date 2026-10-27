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

The root [`LICENSE`](LICENSE) applies to original project-owned code only. It does not relicense submodules, third-party content, or prior repository history. The initial repository history included vendored skill content before the move to submodules; review that history and resolve provenance and redistribution scope before publishing a source archive or history rewrite. Track this open item in [`docs/release-checklist.md`](docs/release-checklist.md).
