# 币安生态常见故障排障手册 (Troubleshooting Guide)

> 汇集 CEX 现货/合约、网络代理、API 频控与鉴权高频异常诊断与自愈指南。

---

## 一、 Binance API 核心错误码速查

| 错误码 | 错误提示 (Message) | 根因分析 | 客户端自愈与排查方案 |
|:---|:---|:---|:---|
| **-1021** | `Timestamp for this request is outside of the recvWindow` | 本地系统时钟与币安服务器产生漂移（> 1000ms） | 客户端底层内置自愈：自动同步 `/api/v3/time` 计算并更新 `timeOffset`，无感重新签名重试。 |
| **-1106** | `Parameter 'reduceOnly' sent when not required` | 持仓模式冲突。在双向持仓（Hedge Mode）下平仓不能传 `reduceOnly`；单向持仓则需传 `true`。 | `closePosition` 已做自适应分流：Hedge 模式仅传 `positionSide`，One-way 模式传 `reduceOnly: true`。 |
| **-2019** | `Margin is insufficient` | 当前可用保证金不足以支持本次开仓或挂单 | 1. 降低杠杆或缩减下单名义价值；<br/>2. 运行 `node scripts/binance_unified.js status` 查验可用余额；<br/>3. 检查是否存在同方向未成交挂单占用了冻结保证金。 |
| **-4061** | `Order's position side does not match user's setting` | 委托的 `positionSide` 与当前账户持仓模式（单向/双向）不匹配 | 1. 运行 `node scripts/binance_unified.js position-mode` 查看当前模式；<br/>2. 双向持仓必须严格指定 `LONG` 或 `SHORT`，单向持仓必须为 `BOTH`。 |
| **-2013** | `Order does not exist` | 查询或撤单时目标 OrderId 不存在 | 幂等键反查中出现此错误属于正常安全分支，证明网络超时下订单并未进入撮合引擎。 |
| **429 / 418** | `IP Rate Limit Exceeded / IP banned` | 触发币安接口 1 分钟权重限制（1200 weight/min） | 1. 客户端已内置自适应反压：`x-mbx-used-weight-1m > 1050` 时自动微减速；<br/>2. 捕获 429 时读取 `Retry-After` 头，强制休眠指定秒数后再试。 |

---

## 二、 网络模式与代理诊断

| 现象 / 报错 | 诊断原因 | 解决方案 |
|:---|:---|:---|
| `fetch failed` / `ECONNRESET` | 本地代理未开启或 TUN 未接管流量 | 1. 确认代理客户端处于运行状态；<br/>2. 确认 `.env` 中 `HTTP_PROXY` / `HTTPS_PROXY` 配置正确；<br/>3. `binance_unified.js` 会自动将 `.env` 代理注入 `process.env` 供原生 fetch 使用。 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | 端口代理自签名证书被拦截 | 在仅使用端口代理（非 TUN）时，挂载 `node --import ./scripts/proxy_bootstrap.mjs <script>`。 |

---

## 三、 Square 内容挖矿与推流故障

| 现象 / 报错 | 诊断原因 | 解决方案 |
|:---|:---|:---|
| `Cashtags 超过平台限制` | 正文中 `$XXX` 数量超过 3 个 | 严格控制正文提及核心币种 ≤ 3 个，系统会自动正则校验并拦截。 |
| `API error [220003]: API key not found` | 广场 OpenAPI Key 失效或未配置 | 触发 Browser Fill 降级容灾：文案已安全保存至 `tmp/draft.txt`，复制后直接访问官方发布页手动发布。 |

---

## 四、 交易审计日志调试

- **无日志产生**：核验 `.env` 中是否设置了 `ENABLE_TRADE_JOURNAL=true`。默认出于保密隐私考量为 `false`，零文件落地。
- **历史对账**：运行 `node scripts/trade_journal.mjs --summary` 查看近期战绩与盈亏统计。
