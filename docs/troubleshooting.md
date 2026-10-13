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

### 1.1 USDⓈ-M 合约常见错误码补充

| 错误码 | 错误提示 (Message) | 根因分析 | 排查方案 |
|:---|:---|:---|:---|
| **-1003 / -1015** | `Too many requests` / `Too many new orders` | 合约侧频控：请求数或下单数超过当前上限，官方明确建议改用 WebSocket 轮询替代 REST 轮询。 | 1. 按响应提示降低请求频率，行情改用 WS；<br/>2. 下单类触发时减少单批次数量并检查 `X-MBX-ORDER-COUNT-*` 响应头；<br/>3. 用 `node scripts/futures_scanner.mjs` 等只读命令替代高频 REST 查询。 |
| **-1112** | `No orders on book for symbol` | 该交易对盘口为空，无法按当前价格成交。 | 换流动性更好的交易对或等待盘口恢复；不要在同一价格反复重发。 |
| **-1121** | `Invalid symbol` | 交易对写法错误、大小写不符或已下架。 | 用 `node scripts/binance_unified.js ticker <symbol>` 或 `/fapi/v1/exchangeInfo` 校验正式代码。 |
| **-1122** | `Invalid symbol status` | 交易对当前状态不允许请求的操作。 | 在 `exchangeInfo` 的 `status` 字段确认是否处于暂停/交割等状态。 |
| **-2012** | `Cancel all failure` | 批量撤单失败。 | 分批重试；先用只读命令核对仍开放的委托，再判断是否真的全部撤掉。 |
| **-2016** | `No trading window could be found for the symbol` | 该交易对没有可用的交易窗口。 | 改用 ticker/24h 行情接口；不要按 K 线窗口推断交易状态。 |
| **-2017** | `API Keys are locked on this account` | 账户 API Key 被平台锁定。 | 到 API 管理页面解锁或重建 Key；这不是脚本层能修复的问题。 |
| **-2018** | `Balance is insufficient` | 余额不足，区别于 `-2019` 的保证金不足。 | 检查账户余额与冻结；缩小下单数量。 |
| **-2020** | `Unable to fill` | 撮合引擎无法成交该委托。 | 核对价格是否越过限价带、数量与流动性；必要时改用限价。 |
| **-2021** | `Order would immediately trigger` | 条件单触发价会让它立即触发，被拒绝。 | 把触发价调整到距市价合理的位置。 |
| **-2022** | `ReduceOnly Order is rejected` | 减仓单与现有挂单冲突。 | 按官方说明撤掉冲突的现有委托后重新提交。 |
| **-2024** | `Position is not sufficient` | 持仓数量不足以完成本次减仓或平仓。 | 先用只读命令核对当前持仓数量，再按实际数量操作。 |
| **-2025 / -4045** | `Reach max open order limit` / `Reach max stop order limit` | 开放委托或条件单数量达到上限。 | 撤掉不再需要的委托再提交；批量操作前先查询当前数量。 |
| **-2027 / -2028** | `Exceeded the maximum allowable position at current leverage` / `Leverage is smaller than permitted` | 杠杆与可开仓位不匹配：前者是超出上限，后者是杠杆过低导致保证金不足。 | 调整杠杆或缩小名义价值；注意方向可能与直觉相反。 |
| **-4004 / -4005** | `Quantity less than min quantity` / `Quantity greater than max quantity` | 数量超出该交易对 `LOT_SIZE` 过滤器范围。 | 从 `exchangeInfo` 读取 `minQty`/`maxQty`/`stepSize` 后重新取整。 |
| **-4015** | `Client order id is not valid` | 客户端订单 ID 超过 36 字符。 | 缩短 ID；项目 `generateClientOrderId` 已截断到 36 字符。 |
| **-4023** | `Qty not increased by step size` | 数量未按 `stepSize` 递增。 | 按 `stepSize` 对齐数量。 |
| **-4024** | `Price is lower than mark price multiplier floor` | 限价低于标记价格下限。 | 调整委托价或改用市价；与 `-4016`（高于上限）同理。 |
| **-4028** | `Invalid leverage` | 杠杆值不在允许范围或重复设置。 | 用只读命令查询当前杠杆后设置有效值。 |
| **-4047 / -4048** | `Margin type cannot be changed ...` | 变更保证金模式前必须没有开放委托和持仓。 | 先撤销相关委托并平掉该交易对持仓，再切换逐仓/全仓。 |
| **-4067 / -4068** | `Position side cannot be changed ...` | 切换单向/双向持仓模式前必须没有开放委托和持仓。 | 清空该交易对的委托与持仓后再用 `position-mode` 切换。 |
| **-4116** | `clientOrderId is duplicated` | 客户端订单 ID 已被使用。 | 换新的客户端订单 ID；重试时不要复用同一个 ID。 |
| **-4118** | `ReduceOnly Order Failed` | 减仓单与同方向现有委托组合后可能形成反向持仓并导致保证金不足。 | 撤掉冲突的同方向委托后重试。 |
| **-4120** | `Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.` | 条件单走错了端点。 | 条件单改用 Algo Order 接口；项目 `set-tpsl`、`open-algos`、`cancel-algo` 已按此实现。 |
| **-4137 / -4138** | `Quantity must be zero with closePosition equals true` / `Reduce only must be true with closePosition equals true` | `closePosition=true` 时不能同时传数量，且必须配 `reduceOnly=true`。 | 删掉 `quantity` 并补齐 `reduceOnly`。 |
| **-4164** | `Order's notional must be no smaller than ...` | 订单名义价值低于该交易对最小限额（减仓单除外）。 | 提高数量或价格；确认该交易对的 `minNotional`。 |
| **-4192** | `Trade forbidden due to Cooling-off Period` | 触发平台冷静期，暂停交易。 | 等待冷静期结束；期间不要反复重试。 |
| **-4202 / -4203 / -4205** | 杠杆调整需要更高 KYC 或等待注册时长 | 超过 20x 的杠杆有认证与注册时长要求。 | 调整杠杆前确认账户认证等级与注册时间。 |
| **-4400 / -4401** | 量化和风控规则触发，只允许减仓 | 触发了平台的量化或持仓风控规则。 | 只提交 `reduceOnly` 委托降仓，等待限制解除。 |
| **-5021 / -5022** | FOK 无法立即成交被拒 / Post Only 无法作为 maker 成交被拒 | `timeInForce` 与盘口状态不匹配。 | FOK 改为 GTC 或调整数量；GTX 改价或改用其他 `timeInForce`。 |

### 1.2 现货常见错误码补充

| 错误码 | 错误提示 (Message) | 根因分析 | 排查方案 |
|:---|:---|:---|:---|
| **-1013** | `INVALID_MESSAGE` | 请求在 API 层被拒，没有到达撮合引擎；真实原因在返回的 `msg` 里。 | 读完整 `msg`，常见为过滤器或下单参数问题，见下方 1.3。 |
| **-2010** 附带的 msg | `Unknown order sent` / `Duplicate order sent` / `Market is closed` / `Account has insufficient balance ...` / `Market orders are not supported for this symbol` 等 | 现货撮合引擎的具体拒单原因通过 `msg` 返回，而不是错误码。 | 按 `msg` 逐条处理：查不到订单先核对 ID；重复 ID 换新 ID；休市等待开市；余额不足先充值；市价单不支持就改限价。 |

### 1.3 现货过滤器失败消息（`Filter failure: ...`）

| 消息 | 含义 | 排查方案 |
|:---|:---|:---|
| `Filter failure: PRICE_FILTER` | 价格过高、过低或不符合 tick size。 | 按 `exchangeInfo` 的 `tickSize` 重新取整。 |
| `Filter failure: PERCENT_PRICE` / `PERCENT_PRICE_BY_SIDE` | 价格偏离近期成交均价超过限价带。 | 收窄委托价格，或改用市价单。 |
| `Filter failure: LOT_SIZE` | 数量过高、过低或不符合 step size。 | 按 `minQty`/`maxQty`/`stepSize` 重新取整。 |
| `Filter failure: MIN_NOTIONAL` / `NOTIONAL` | 价格乘数量过低，或超出名义价值区间。 | 提高数量或价格，确认 `minNotional`/`maxNotional`。 |
| `Filter failure: MARKET_LOT_SIZE` | 市价单数量不符合 step size。 | 按 step size 调整市价单数量。 |
| `Filter failure: MAX_POSITION` | 账户持仓达到该交易对上限（基础资产余额加未成交买单）。 | 平掉或撤销部分买单后再下单。 |
| `Filter failure: MAX_NUM_ORDERS` | 该交易对未成交委托过多。 | 撤销部分委托后再提交。 |
| `Filter failure: MAX_NUM_ALGO_ORDERS` | 止损/止盈等条件单数量达到上限。 | 用 `cancel-algo` 或 `cancel-all-algos` 清理后再提交。 |

官方依据：[现货错误码](https://developers.binance.com/en/docs/products/spot/errors)、[现货 REST 通用信息](https://developers.binance.com/en/docs/products/spot/rest-api)、[USDⓈ-M 错误码](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/error-code)、[USDⓈ-M REST 通用信息](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)。

---

## 二、 网络模式与代理诊断

| 现象 / 报错 | 诊断原因 | 解决方案 |
|:---|:---|:---|
| `fetch failed` / `ECONNRESET` | 本地代理未开启或 TUN 未接管流量 | 1. 确认代理客户端处于运行状态；<br/>2. 确认 `.env` 中 `HTTP_PROXY` / `HTTPS_PROXY` 配置正确；<br/>3. `binance_unified.js` 会自动将 `.env` 代理注入 `process.env` 供原生 fetch 使用。 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | 端口代理自签名证书被拦截 | 在仅使用端口代理（非 TUN）时，挂载 `node --import ./scripts/proxy_bootstrap.mjs <script>`。 |
| `Unable to load credentials` / `Missing BINANCE_API_KEY or BINANCE_SECRET_KEY` | 凭据未加载，或 `.env` 未放置在工作目录 | 脚本从项目根目录运行时自动加载 `.env`；确认文件存在且包含变量名（不打印值）。运行 `node scripts/binance_unified.js status` 会最先暴露这个问题。 |
| 请求很慢或被中途掐断 | 单次请求超过 10 秒超时 | `httpRequest` 对所有请求使用 `AbortSignal.timeout(10000)`。只读请求会自动重试，写请求超时后必须对账，不能直接重发。 |

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

---

## 五、 快速排查流程

1. 先分清是网络问题还是接口问题：`fetch failed`、`ECONNRESET`、TLS 报错看第二节；带 `code` 的 JSON 响应看第一节。
2. 写请求结果未知时（超时、`-1007`、5XX、连接中断），先用 `node scripts/binance_unified.js reconcile <symbol> --request-id <id>` 核对，确认状态前不重发。
3. 单次 `-2013` 不等于下单失败；用订单 ID 或客户端订单 ID 再查一次。
4. 频控相关（429、418、`-1003`、`-1015`）先降频和退避，再检查是否该改用 WebSocket。
5. 保证金和杠杆类报错（`-2019`、`-2027`、`-2028`、`-4164`）用 `node scripts/binance_unified.js status` 看余额与占用，缩小名义价值比盲目调杠杆更可靠。
6. 持仓模式类报错（`-4061`、`-4062`、`-4067`、`-4068`）用 `node scripts/binance_unified.js position-mode` 确认当前模式，并注意切换前必须没有开放委托和持仓。
