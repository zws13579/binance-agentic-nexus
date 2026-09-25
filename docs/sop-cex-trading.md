# CEX 现货/合约 API 交互与量化投研 SOP

> 迁移自原 AGENTS.md §四-2，供 Agent 按需读取。

## 1. 统一客户端（`scripts/binance_unified.js`）

本项目已沉淀一体化客户端 `scripts/binance_unified.js`，整合现货、合约、资金流、行情与风控接口。

### 技术特性

- **全面采用 Node.js 原生 `fetch()`**：严禁再使用 `child_process.execSync('curl.exe ...')` 子进程方式调用，消除进程 fork 性能损耗、跨平台兼容问题（Windows/Linux）与 Shell 注入风险。
- **自动重试机制**：底层 `httpRequest()` 内置 2 次指数退避重试，有效抵御代理或网络层偶发的 Socket 重置。

### CLI 子命令速查

```bash
# 1. 账户资产概览（Spot、Futures、Earn 理财与逐仓持仓）
node scripts/binance_unified.js status

# 2. 批量行情查询（最新价、24h 涨跌、高低点与成交量）
node scripts/binance_unified.js ticker <symbol1> [symbol2 ...]

# 3. 市场情绪与微观盘口（大户多空比、资金费率、持仓量、主动买卖比）
node scripts/binance_unified.js sentiment <symbol>

# 4. 当前合约逐仓/全仓持仓与未结盈亏
node scripts/binance_unified.js positions [symbol]

# 5. 历史成交与手续费查询
node scripts/binance_unified.js trades <symbol> [limit]

# 6. 为已有持仓设置止盈止损条件单（TPSL）
node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice> <tpPrice> <qty>

# 7. 开仓并强制绑定止盈止损（原子级风控）
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> <MARKET|LIMIT> [price] <slPrice> <tpPrice>
```

## 2. 防时间戳错误（`-1021`）与签名机制

- 客户端内部已自动调用 `/api/v3/time` 计算并维护 `timeOffset`，并在每次签名时注入 `recvWindow=10000`，彻底避免本地系统时间不同步问题。
- 严格以 HMAC SHA256 签名 `queryString`，Header 携带 `X-MBX-APIKEY`。

## 3. 交易安全与硬风控防线

- **严禁裸奔开仓**：所有自动化或人工开仓策略必须明确止损价，优先调用 `open-tpsl` 实现进场与止损单的原子绑定，拒绝无风控持仓。
- **流动性与深度求证**：开单前需结合订单簿深度买卖墙差额（Bid/Ask Depth Ratio）与聪明钱净流入榜，判断支撑位是否牢固。
