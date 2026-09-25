# Web3 智能钱包操作 SOP

> 迁移自原 AGENTS.md §四-1，供 Agent 按需读取。

## 1. 连接前置验证

```bash
baw wallet status --json
```

若未登录则调用 `baw auth signin` 进行扫码授权。

## 2. 转账与下单安全原则

- 必须先获取预估报价与 Gas 价格：`baw wallet gas-price`
- 严格遵循每日限额（`baw wallet left-quota`），大额转账必须二次确认
- 所有交易操作前检查链 ID 是否正确（`.env` 中 `BINANCE_CHAIN_ID`）

## 3. 美股代币化资产（bStocks）套利监控

- 关注美股开盘时段链上 Ondo 代币（`NVDA`、`AAPL`）与现实股价的折溢价波动
- 结合持仓监控脚本实现自动止盈
- 使用 `binance-tokenized-securities-info` Skill 查询实时链上数据与美股基本面

## 4. 常用 CLI 速查

```bash
# 钱包余额
baw wallet balance --json

# 代币转账
baw wallet send --to <address> --token <symbol> --amount <amount> --chain <chainId> --json

# DEX 交换报价
baw wallet swap-quote --from <tokenA> --to <tokenB> --amount <amount> --json

# 执行 DEX 交换
baw wallet swap --from <tokenA> --to <tokenB> --amount <amount> --json
```
