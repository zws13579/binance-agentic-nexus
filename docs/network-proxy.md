# 网络代理双模式详解

> 迁移自原 AGENTS.md §二-1，供 Agent 按需读取。

## 网络现状

访问币安服务（CEX REST API、Web3 接口、Square 端点、DNS 解析）在特定网络环境下需要代理支持。

## 模式 1：TUN 模式（系统级透明代理，首选）

当前环境已配置 TUN 虚拟网卡代理。在 TUN 模式开启时，操作系统会在网络层接管所有进出流量。

**脚本执行**：所有自定义 Node.js / Python 脚本或系统命令均可**直接原生运行**（如 `node your_script.mjs`），无需附加任何代理引导参数。

## 模式 2：端口代理模式（备用方案 / TUN 关闭时）

若未开启 TUN 模式，本地 HTTP/SOCKS 代理端口通常为 `http://127.0.0.1:7890`（已在 `.env` 中定义 `HTTP_PROXY` 与 `HTTPS_PROXY`）。

### 为何存在 `scripts/proxy_bootstrap.mjs`

Node.js 原生 `fetch`（基于 `undici`）默认不会主动读取环境变量中的 `HTTP_PROXY`。在**纯端口代理环境（无 TUN）**下，可通过以下方式注入 `ProxyAgent` 作为备用通道：

```bash
node --import ./scripts/proxy_bootstrap.mjs your_script.mjs
```

在 TUN 模式正常工作时，完全无需挂载此脚本。

### 跨设备路径兼容

`proxy_bootstrap.mjs` 内部采用动态多候选路径解析 `undici`（结合 `process.execPath`），避免因不同设备 Node.js 安装路径差异导致模块加载失败。

## 代理模式验证方法

```bash
# 验证 TUN 透明代理连通性（直连）
node -e "fetch('https://api.binance.com/api/v3/ping').then(r=>console.log('TUN OK', r.status)).catch(e=>console.log('TUN FAIL', e.message))"

# 验证备用端口代理引导（挂载 proxy_bootstrap）
node --import ./scripts/proxy_bootstrap.mjs -e "fetch('https://api.binance.com/api/v3/ping').then(r=>console.log('Proxy OK', r.status))"
```

## `baw` CLI 升级后端口代理注入丢失

- `npm install -g` 会重写 `baw.cmd` 和 `baw.ps1` 入口脚本，导致手动注入的 `--import proxy_bootstrap.mjs` 参数被覆盖。
- **TUN 模式用户可忽略**：TUN 开启时 `baw` 无需 `--import` 也能正常联网。
- 若需恢复端口代理支持，在 `baw.cmd` 最后一行的 `"%_prog%"` 后、`"%dp0%\..."` 前插入：

```
--import "file:///<项目绝对路径>/scripts/proxy_bootstrap.mjs"
```

`baw.ps1` 中类似，在所有 `node` 调用参数中追加相同的 `--import` 标志。
