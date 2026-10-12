# 币安生态常见故障排障手册 (Troubleshooting Guide)

> 汇集 CEX 现货/合约、网络代理、API 频控与鉴权高频异常诊断与自愈指南。

---

## 一、 Binance API 核心错误码速查

| 错误码 | 错误提示 (Message) | 根因分析 | 客户端自愈与排查方案 |
|:---|:---|:---|:---|
| **-1021** | `Timestamp for this request is outside of the recvWindow` / `Timestamp for this request was 1000ms ahead of the server's time` | 时间戳超出 `recvWindow`，可能是本机时钟偏差、请求延迟、时间戳单位错误，或时间戳比服务器快 1000ms 以上。 | 校准系统时间并确认毫秒/微秒单位。项目 CLI 会同步 `/api/v3/time`，收到明确 `-1021` 后重新签名并重试一次；当前发送 `recvWindow=10000`。现货官方建议使用不超过 5000ms 的较小窗口，最大 60000ms；合约请求以对应接口文档为准。 |
| **-1022** | `Signature for this request is not valid` | 签名与实际请求参数不一致，或 API Key / Secret Key 不匹配。 | 核对签名所用 query/body 字符串、参数编码与密钥配对；不要输出或记录密钥值。 |
| **-1106** | `Parameter '%s' sent when not required` | 请求包含该接口或当前请求场景不需要的参数；不只表示持仓模式冲突。 | 按具体接口文档删去多余参数。USDⓈ-M 双向持仓订单不能发送 `reduceOnly`；项目 `close-position` 会按模式选择 `positionSide`，并只在单向模式发送 `reduceOnly`。 |
| **-2010** | `NEW_ORDER_REJECTED`（现货撮合引擎拒单） | 通用拒单码；具体原因通常在返回的 `msg` 中，例如余额不足、交易对未开放或订单参数不符合要求。 | 先看完整错误消息，再核对余额、交易对状态及 `exchangeInfo` 中的价格/数量过滤器；不要只凭错误码猜原因。 |
| **-2013** | `Order does not exist` | 按给定交易对和订单 ID 查询不到订单；也可能是标识不匹配或订单已不在可查询范围。 | 这**不能证明**超时订单没有成交。先用交易对和订单 ID/客户端订单 ID 查询；本项目可运行 `node scripts/binance_unified.js reconcile <symbol> --request-id <id>`。状态未确认前不要盲目重发。 |
| **-2014 / -2015** | `API-key format invalid` / `Invalid API-key, IP, or permissions for action` | Key 格式错误，或 Key、IP 白名单、接口权限不符合请求要求。 | 检查环境变量是否配置、Key 是否有效、IP 白名单及读取/交易权限；仅检查配置状态，不打印凭据。 |
| **-2019** | `Margin is insufficient` | 可用保证金不足以覆盖下单所需初始保证金及相关占用。 | 缩小数量/名义价值；运行 `node scripts/binance_unified.js status` 检查可用余额，并检查当前保证金模式和未成交订单占用。单纯降低杠杆可能提高同等名义价值所需的初始保证金。 |
| **-4061** | `Order's position side does not match user's setting` | 订单的 `positionSide` 与账户单向/双向持仓模式不匹配。 | 运行 `node scripts/binance_unified.js position-mode` 查询模式；单向模式使用 `BOTH`，双向模式明确使用 `LONG` 或 `SHORT`。 |
| **-4062** | `Invalid or improper reduceOnly value` | `reduceOnly` 值或用法不符合当前持仓模式/订单场景。 | 双向模式移除 `reduceOnly`；单向模式确认值和订单方向确实用于减少持仓，并核对现有委托是否冲突。 |
| **-1007 / HTTP 5XX** | `Timeout waiting for response ... execution status unknown` / 服务端错误 | 写请求超时可能是未知状态；现货 5XX 也可能表示执行状态未知。USDⓈ-M HTTP 503 要结合消息区分：`Unknown error...` 为未知状态，`Service Unavailable.` 为确定失败。 | 未知状态时不要立即重发，先通过用户数据流、订单查询或项目的 `reconcile` 命令核对；明确失败时按官方说明退避后重试。项目写请求不会自动重发。 |
| **429 / 418** | `Too many requests` / `IP banned` | 触发动态请求权重或下单频率限制；反复违反 429 或不退避会导致 IP 被暂时封禁为 418。请求权重按 IP 计，下单频率按账户计，两者不是同一额度。 | 若响应含 `Retry-After`，按该值等待；现货 418/429 会提供此响应头。通过 `/api/v3/exchangeInfo` 或 `/fapi/v1/exchangeInfo` 查询当前限制。项目只读 GET 对 429/5XX 最多额外重试两次，固定等待 400/800ms；写请求不重试，当前代码未读取 `Retry-After` 或使用权重阈值自动降速。 |
| **HTTP 403** | WAF blocked request | 请求触发 Web Application Firewall 限制或安全规则，不等同于普通 429。 | 检查请求频率、参数及来源网络；停止重复发送相同请求，必要时检查 Binance 支持渠道。 |
| **-1008** | `Request throttled by system-level protection`（USDⓈ-M） | 系统级并发保护触发，通常是节点过载。 | 降低并发并退避后再试；此错误下减仓/平仓类请求享有例外。 |

官方依据：[现货错误码](https://developers.binance.com/en/docs/products/spot/errors)、[现货 REST 通用信息](https://developers.binance.com/en/docs/products/spot/rest-api)、[USDⓈ-M 错误码](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/error-code)、[USDⓈ-M REST 通用信息](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)。

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
