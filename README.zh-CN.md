# Binance Agentic Nexus

[English](README.md)

Binance Agentic Nexus（BAN）整合了公开市场研究、需要认证的 CEX 账户工作流、可选的 Binance Web3 技能，以及自定义的预测市场和币安广场（Square）工作流。项目使用 Node.js 24，自有 JavaScript 代码采用 CommonJS `.js` 和 ESM `.mjs` 文件，并可在无需凭据或实时网络请求的情况下运行本地回归测试。

## 本地启动

```bash
git clone --recurse-submodules https://github.com/zws13579/binance-agentic-nexus.git
cd binance-agentic-nexus
nvm install
npm ci
npm test
```

`npm ci` 会安装项目锁定的依赖。`npm test` 会运行根目录的 fake-fetch 测试以及现有的两个自定义技能测试套件。测试无需 `.env`、Binance 凭据、`baw` CLI 或交易所访问权限。只有在某个工作流需要配置时，才从 `.env.example` 复制 `.env`；系统 TUN 代理启用时，代理变量应留空。

## CI 与本地安全检查

CI 会运行 `npm test`、阈值为 high 的 `npm audit --audit-level=high`，以及对完整根 Git 历史进行全量脱敏扫描的 Gitleaks 8.30.1。密钥扫描会获取根仓库完整历史，但不会初始化子模块，因此不涵盖子模块的历史。安装依赖并准备好 Gitleaks 8.30.1 后，可在本地运行：

```bash
npm audit --audit-level=high
gitleaks git --log-opts=--all --redact=100 .
```

可选的 `baw` CLI 不是本项目的 npm 依赖。如果 Web3 工作流需要它，请在本地安装该工作流支持的版本，并用 `./node_modules/.bin/baw --version` 验证。安装本仓库不会安装 BAW，也不会认证其兼容性。请参阅[安装说明](docs/setup-guide.md)。

## 能力与边界

- 公开的现货和 USDⓈ-M 市场数据、不预设多空方向的永续合约扫描器，以及以证据为导向的评估器。
- 需要认证的账户读取，以及受保护的下单、资金划转和对账工作流。CLI 的 `--approved` / `--dry-run` 门禁仅适用于 `open-tpsl`、`redeem-earn`、`transfer-to-futures` 和 `transfer-from-futures`；其他写命令没有统一使用这组标志。所有写操作仍须获得明确的用户授权。ticker 和 reconcile 等只读命令仍可能访问生产环境。官方第三方技能有各自的行为和前置条件。
- 可选的 Binance 官方技能和 TypeSafe 技能子模块，以及由项目维护的预测市场和币安广场工作流。
- 可选的项目本地 `undici` 代理引导程序，用于端口代理模式。TUN 模式可直接使用 Node 的原生 `fetch`。

如需在生产环境发起**只读**公开市场请求，可运行：

```bash
BINANCE_API_ENV=prod node scripts/binance_unified.js ticker BTCUSDT
```

此命令会向 Binance 生产环境发送公开 GET 请求。读取账户需要具有读取权限的 API Key。请使用权限最小化且相互隔离的凭据；切勿将密钥放入 issue、日志、截图或已提交的文件中。`open-tpsl`、`redeem-earn`、`transfer-to-futures` 和 `transfer-from-futures` 使用 `--dry-run` 预览或 `--approved` 提交；两个标志互斥，且都不等同于用户授权。其他写命令，包括 `close-position`、`set-tpsl`、撤单命令、`leverage`、`margin-type` 和 `position-mode` 的写入形式，没有统一的 CLI 标志门禁，仍须获得明确的用户授权。dry-run 仍会读取生产环境的实时状态；串行的入场与保护流程不是原子操作：交易所可能已接受前一个请求，而后续保护请求失败。执行任何写入工作流前，请先阅读 [CEX 交易 SOP](docs/sop-cex-trading.md)。

## 项目文件

- `scripts/binance_unified.js` — CommonJS CEX 客户端和 CLI。
- `scripts/futures_scanner.mjs` — 基于已收盘 K 线的市场证据扫描器。
- `scripts/futures_evaluator.mjs` — 由 Agent 主导的证据评估器。
- `scripts/proxy_bootstrap.mjs` — 可选启用的本地代理分发器。
- `.agents/skills/custom/` — 项目维护的技能。
- `docs/` — 操作指南、安装说明和发布检查清单。

`BINANCE_API_ENV` 默认值为 `prod`。除 `prod` 之外的值会在发起网络访问前被拒绝；尚未支持测试网。

## 许可证范围

根目录的 MIT 许可证仅适用于项目自有的原创代码。该许可证不涵盖第三方技能、子模块或其他许可条款独立存在或尚未厘清的资源。独立根快照方案会排除更早的根仓库提交，但不会厘清当前树或子模块中内容的权利状态。再分发前，请参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[源代码分发说明](docs/source-distribution.md)和[发布检查清单](docs/release-checklist.md)。
