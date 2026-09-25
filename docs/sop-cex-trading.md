# CEX 现货/合约 API 交互与量化投研 SOP

> 迁移自原 AGENTS.md §四-2，供 Agent 按需读取。

## 1. 统一客户端（`scripts/binance_unified.js`）

本项目已沉淀一体化客户端 `scripts/binance_unified.js`，整合现货、合约、资金流、行情与风控接口。

### 技术特性

- **全面采用 Node.js 原生 `fetch()`**：严禁再使用 `child_process.execSync('curl.exe ...')` 子进程方式调用，消除进程 fork 性能损耗、跨平台兼容问题（Windows/Linux）与 Shell 注入风险。
- **选择性幂等重试与防重发**：仅针对幂等 GET 请求进行重试；对所有 POST/DELETE 交易请求**严格关闭自动重试（retries=0）**，并自动注入全局唯一的 `newClientOrderId` 幂等键，彻底杜绝重复开仓与重复下单风险。
- **双向与单向持仓模式自适应**：平仓请求动态感知持仓模式（Hedge Mode 仅传对应 `positionSide`，避免 `-1106 reduceOnly` 参数冲突；One-Way 模式自动携带 `reduceOnly: true`）。

### CLI 子命令速查

```bash
# 1. 账户资产概览（Spot、Futures、Earn 理财与逐仓持仓）
node scripts/binance_unified.js status

# 2. 批量行情查询（最新价、24h 涨跌、高低点与成交量）
node scripts/binance_unified.js ticker <symbol1> [symbol2 ...]

# 3. 24h 交易量排行榜
node scripts/binance_unified.js top-volume [limit]

# 4. 订单簿深度与微观买卖比（现货与合约）
node scripts/binance_unified.js depth <symbol> [limit]

# 5. K 线蜡烛图数据
node scripts/binance_unified.js klines <symbol> [interval] [limit]

# 6. 市场情绪与衍生品微观指标（大户多空比、资金费率、持仓量、主动买卖比）
node scripts/binance_unified.js sentiment <symbol>

# 7. 当前挂单查询（普通挂单 / 策略条件单）
node scripts/binance_unified.js open-orders [symbol]
node scripts/binance_unified.js open-algos [symbol]

# 8. 当前合约持仓与未结盈亏
node scripts/binance_unified.js positions [symbol]

# 9. 杠杆与保证金模式调整
node scripts/binance_unified.js leverage <symbol> <leverage>
node scripts/binance_unified.js margin-type <symbol> <ISOLATED|CROSSED>
node scripts/binance_unified.js position-mode [true|false]

# 10. 历史成交与手续费查询
node scripts/binance_unified.js trades <symbol> [limit]

# 11. 为已有持仓设置止盈止损条件单（TPSL，同方向精准隔离）
node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> [qty]

# 12. 开仓并链式绑定止盈止损（带失败自动补偿回滚）
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> MARKET <slPrice> <tpPrice>
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> LIMIT <price> <slPrice> <tpPrice>

# 13. 自适应市价平仓与保护单精准清理（平仓失败坚决保留保护单）
node scripts/binance_unified.js close-position <symbol> [LONG|SHORT]

# 14. 撤单管理（单笔普通单、批量普通单、单笔策略单、批量策略单）
node scripts/binance_unified.js cancel-order <symbol> <orderId>
node scripts/binance_unified.js cancel-all <symbol>
node scripts/binance_unified.js cancel-algo <algoId>
node scripts/binance_unified.js cancel-all-algos <symbol> [LONG|SHORT]
```

## 2. 防时间戳错误（`-1021`）与自动恢复

- 客户端内部已自动调用 `/api/v3/time` 计算并维护 `timeOffset`，并在每次签名时注入 `recvWindow=10000`。
- 若偶发捕获 `-1021 Timestamp error`，底层自动重新校准服务器时钟并无感重试，彻底避免本地系统时间不同步问题。
- 严格以 HMAC SHA256 签名 `queryString`，Header 携带 `X-MBX-APIKEY`。

## 3. 交易安全与硬风控防线

- **严禁裸奔开仓与补偿回滚**：所有开仓策略必须明确止损止盈价；若发生开仓成功但后续保护单挂载异常，系统会自动执行补偿回滚（MARKET 紧急平仓，LIMIT 自动撤回挂单），杜绝裸仓留存。
- **平仓保护单防护**：平仓请求必须经过实质成功状态校验后，才定向清理对应方向的保护单；平仓未果坚决保留止损，防止原仓位无保护暴露。
- **流动性与深度求证**：开单前需结合订单簿深度买卖墙差额（Bid/Ask Depth Ratio）与聪明钱净流入榜，判断支撑位是否牢固。
