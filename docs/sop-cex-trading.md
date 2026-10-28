# CEX 现货/合约 API 交互与量化投研 SOP

供 Agent 按需读取，覆盖现货与合约的账户、行情、投研、交易安全以及 Earn 赎回和资金划转。Agent 主导判断，代码负责可核实事实、确定性计算及执行约束。交易、赎回和划转需要各自的用户授权；模型意见不是授权。

## 1. 统一客户端与 CLI 速查

统一客户端 scripts/binance_unified.js 整合现货、合约、Earn 和资金接口；scripts/binance_client.mjs 提供同一客户端的 ESM 入口。采用 Node.js 原生 fetch、HMAC SHA256 签名、服务端校时、明确的业务状态及大整数 ID 保存。保护单、仓位模式和串行开仓能力用于合约。

调用前确认市场和账户。当前统一 CLI 的接口范围如下；同一 symbol 的现货行情与合约行情需要分别核对。

| 命令 | 当前接口范围 |
|---|---|
| status | Spot、Futures、Earn 账户及合约保护单概览 |
| ticker、top-volume | 现货 24h 行情和计价成交量榜 |
| depth | 同时读取现货与 USDⓈ-M 合约盘口 |
| klines、sentiment | USDⓈ-M 合约 K 线与衍生品指标 |
| order、open-orders、trades | USDⓈ-M 合约订单与成交 |
| positions、position-mode、leverage、margin-type | USDⓈ-M 合约仓位、持仓模式、杠杆和保证金模式 |
| open-algos、set-tpsl、open-tpsl、close-position、reconcile | 合约保护、入场、平仓与只读核对 |
| cancel-order、cancel-all、cancel-algo、cancel-all-algos | 合约普通单和策略单撤销 |
| redeem-earn、earn-redemptions | Simple Earn 活期赎回及历史 |
| transfer-to-futures、transfer-from-futures、transfer-history | 现货与 USDⓈ-M 合约账户划转及历史 |

统一 CLI 的 `--approved` / `--dry-run` 互斥门禁仅覆盖 `open-tpsl`、`redeem-earn`、`transfer-to-futures` 和 `transfer-from-futures`。前者提交写请求，后者预览；两者都不构成用户授权。`close-position`、`set-tpsl`、`cancel-order`、`cancel-all`、`cancel-algo`、`cancel-all-algos`、`leverage`、`margin-type` 及 `position-mode <true|false>` 的写入形式没有这组统一门禁。每个写操作都必须在对应的明确用户授权范围内执行，不能仅凭 CLI 未拒绝或模型建议推定已获授权。

```bash
# 账户概览、现货行情和成交量榜
node scripts/binance_unified.js status
node scripts/binance_unified.js ticker <symbol1> [symbol2 ...]
node scripts/binance_unified.js top-volume [limit]

# 现货/合约盘口，以及合约 K 线与情绪
node scripts/binance_unified.js depth <symbol> [limit]
node scripts/binance_unified.js klines <symbol> [interval] [limit]
node scripts/binance_unified.js sentiment <symbol>

# 合约订单、成交、持仓与只读持仓模式查询
node scripts/binance_unified.js order <symbol> <orderId>
node scripts/binance_unified.js open-orders [symbol]
node scripts/binance_unified.js open-algos [symbol]
node scripts/binance_unified.js trades <symbol> [limit]
node scripts/binance_unified.js positions [symbol]
node scripts/binance_unified.js position-mode

# 以下为账户或订单写操作，均须在对应用户授权范围内使用
node scripts/binance_unified.js leverage <symbol> <leverage>
node scripts/binance_unified.js margin-type <symbol> <ISOLATED|CROSSED>
node scripts/binance_unified.js position-mode <true|false>
node scripts/binance_unified.js cancel-order <symbol> <orderId>
node scripts/binance_unified.js cancel-all <symbol>
node scripts/binance_unified.js cancel-algo <algoId>
node scripts/binance_unified.js cancel-all-algos <symbol> [LONG|SHORT]
```

资金命令完整参数见第 5 节，合约入场及保护命令见第 6 节。其他命令和参数通过 binance_unified.js help 查阅。批量撤单须确认影响范围；维护本流程保护时使用第 6 节的归属及替换规则。

## 2. 时间戳、签名与自动恢复

客户端通过 /api/v3/time 维护 timeOffset，在签名请求中发送 recvWindow=10000，以 HMAC SHA256 签名 queryString，Header 携带 X-MBX-APIKEY。凭据值永不输出。

仅收到明确 -1021 拒绝响应时，重新校时后重发一次。超时、连接中断或可能已执行的服务端故障须先核对结果。请求 ID 用于关联和恢复；交易所历史保留期限及跨客户端并发会限制核对能力，不承诺永久幂等。其他网络和结果处理要求见第 7 节。

## 3. 通用投研、现货流程与交易安全

先确认用户选择的市场、symbol、资产和账户，再读取真实余额、行情、对应市场 K 线、拟交易方向的盘口以及成本。记录数据来源和时间，区分事实、推断和未知项。Agent 给出依据、反证、入场条件、失效条件、数量和风险预算，取得相应交易授权后执行，并核对成交与剩余订单。

现货买入检查可用计价资产，现货卖出检查可用基础资产。数量步长、价格步长、最小名义金额和手续费使用对应现货交易对资料；确认成交后重新读取资产余额。现货止损、退出计划和订单维护须依据所用现货接口能力。合约 LONG/SHORT、持仓模式、杠杆、资金费率和最大可转出额属于合约章节的检查。

现货 K 线、下单、订单查询和撤单通过已有 [Binance Skill](../.agents/skills/binance-skills-hub/skills/binance/binance/SKILL.md) 的 [Spot 接口说明](../.agents/skills/binance-skills-hub/skills/binance/binance/references/spot.md) 选择命令，并核对当前 CLI --help、鉴权和返回结果。上表已标明统一 CLI 的当前接口范围，调用方须按该范围选择入口。

多标的、多来源、复杂事件、证据冲突或上下文累积时，自主分工技术结构核查、外部事件搜索及方向反证。传递最小快照和新上下文，子 Agent 返回来源 URL、时间、事实、推断与未知项，主 Agent 复核关键证据并解决分歧。按搜索、CLI/API 等实际工具需求选择子 Agent，不能全部限制为只有搜索权限的 research 模式。客户端缺乏能力时如实说明，必要证据不足时等待。

项目 .env 配置 Jev Key 时，Agent 按概率、风险、异常和证据冲突等情景自主调用；无 Key 时继续 Agent 与子 Agent 分析。模型意见、深度比、大户多空比或链上聪明钱数据都需要结合其来源和适用市场解释。链上流向与 CEX 成交应分别核对，不能凭单一指标声称支撑位可靠。

交易计划须明确损失预算、退出条件和必要保护。实际成交数量、均价与费用变化后重算风险；保护失败、部分成交、剩余挂单和不确定提交分别核对。合约开仓、保护失败补偿以及可信归零后清理保护的具体规则见第 6 节。

## 4. 永续合约数据与中立候选池

以下永续研究默认面向日内至数日；做空次数、短期胜率或模型信心不能代替工程验收。

```bash
node scripts/binance_unified.js status
# 现货参考行情；合约研究数据使用下方 futures_scanner，执行前重取合约价格
node scripts/binance_unified.js ticker <symbol1> [symbol2 ...]
node scripts/binance_unified.js depth <symbol> [limit]
node scripts/binance_unified.js sentiment <symbol>
node scripts/binance_unified.js positions [symbol]
node scripts/binance_unified.js open-orders [symbol]
node scripts/binance_unified.js open-algos [symbol]
node scripts/futures_scanner.mjs --top 20
```

扫描器默认 --top 5，研究阶段使用 --top 20。仅筛选交易中的 USDT 保证金永续合约，最低 24 小时成交额沿用 1,000 万 USDT；按计价成交额排序，不按涨幅奖励做多，也不要求多空数量相等。

扫描 JSON 顶层仍为数组，每项 schemaVersion: 2、rankingBasis: quoteVolume；旧 score 已移除，不得补零或按旧分数解释。默认 4h、1h、15m 各取最近 200 根已收盘 K 线：4h 判断环境，1h 判断结构，15m 检查入场。当前未收盘行情另列，缺失、断档和接口失败保留状态。

每周期 currentCandle 单独提供 openTime/closeTime、OHLC、volume（基础量）和 quoteVolume，配套 currentCandleStatus/currentCandleMissingData；不会进入已收盘特征。当前快照可以变化，不能把盘中越界称为收盘突破。

| 特征 | 定义 |
|---|---|
| 箱顶、箱底 | 信号 K 线之前 20 根最高、最低价 |
| 放量倍数 | 信号 K 线计价量 / 前 20 根计价均量 |
| EMA20、EMA50 | 前 N 根均值初始化，提供当前值与此前 5 根变化 |
| ATR14 | Wilder 平滑 |
| 区间位置 | 相对上下沿位置，可越过 0～1 |
| 越界距离 | 突破上沿、跌破下沿的百分比与 ATR 距离 |
| 动量 | 最近 1、5、20 根收盘变化，保留正负号 |

资金费率从 premiumIndex 读取并关联时间；ticker 不提供该字段，未知不补零。OI 当前量与历史变化分开，无历史不能声称增减仓。大户多空持仓比例不等于净流入。深度和拟交易数量对应的滑点按方向检查：买入吃卖盘，卖出吃买盘。链上聪明钱仅作有资产映射、有来源的补充，不把净流入作为所有方向必要条件。

sentiment 的 openInterest 是当前接口快照；openInterestChange 是最近两个相邻 1h 历史快照的百分比变化，openInterestHistory 单独附起止时间与来源。历史缺失、断档或过期时变化为 null，不能用当前量与旧快照拼成一个变化值。

基础数据优先批量获取，K 线最多 5 个并发任务；入围后再取完整深度、账户与实际成本。部分失败不能包装成没有机会。

### 永续多空情景与可选 Jev 评估

| 情景 | 入场证据 | 反证 |
|---|---|---|
| 向上突破做多 | 上沿突破、量能与承接 | 假突破、追涨、阻力 |
| 向下跌破做空 | 下沿失守、卖压与空间 | 假跌破、收回、空头拥挤 |
| 上升回踩做多 | 上升结构保持、重新承接 | 结构失效、持续卖压 |
| 下降反弹做空 | 下降结构保持、反弹受阻 | 结构反转、持续买入 |
| 震荡下沿做多 | 区间有效、拒绝下跌 | 向下突破、波动扩张 |
| 震荡上沿做空 | 区间有效、拒绝上涨 | 向上突破、持续逼空 |

无法解决冲突时输出 WAIT 并说明条件，或 NO_TRADE 说明证据/优势/约束不足；两者必须显式提供 setupType:null。特征与情景不自动产生未经校准的胜率。

项目 .env 有非空 TYPESAFE_API_KEY 时按情景自主调用 Jev，无需用户逐次点名；无 Key 时继续 Agent 与子 Agent 分析。保留 TYPESAFE_ENDPOINT > TYPESAFE_BASE_URL + /systemone（只填域名时补 /v1） > 官方地址，模型默认 jev-latest。

```bash
node scripts/futures_evaluator.mjs --evaluate --stdin --provider auto
node scripts/futures_evaluator.mjs --evaluate --file tmp/futures-analysis.json --provider agent
```

评估入口只读。输入真实特征、时间、Agent 方向/情景、依据/反证/失效条件/有效期、入场/止损/止盈/数量及已知风险与成本；输出原始 Agent/Jev 判断、provider、Jev 状态、方向、计划、缺失数据、风险检查及 readyForHumanApproval。方向冲突须解决后再交付审批，不平均意见。服务故障仅在已有合法 Agent 判断时显式回退；非法模型输出与 Mock 不生成真实建议。

输入契约通过 futures_evaluator.mjs --describe-input 获取；扫描证据、成本及执行快照默认在 15 分钟内，Agent 判断必须显式有效期且不得早于证据。缺必要风险、成本或执行资料可继续分析，但 readyForHumanApproval=false。auto 仅对网络超时/连接失败公开回退，HTTP 拒绝、非法输出与 Mock 不回退；显式 jev 模式失败即报告。

扫描结果保留每周期 200 根已收盘 K 线；Jev 接收完整特征、状态、来源时间及每周期最近 8 根的最小快照，closedCandleCount 标明原数量、candleWindow 标明窗口。模型答案必须完整提供 choice 类型、方向、confidence 和四方向概率分布，概率合法且所选方向为最高概率之一；这些概率表示模型选择判断，不是赛事胜率。

永续合约按入场、目标、止损和数量计算毛盈亏、已知成本、净盈亏及盈亏比；成本未知披露。不得套用预测市场二元赔付 EV 公式，或把模型观点称为已校准胜率。

## 5. Earn 赎回与账户划转：明确参数与状态

```bash
node scripts/binance_unified.js redeem-earn <productId> <amount> --dry-run
node scripts/binance_unified.js transfer-to-futures <asset> <amount> --dry-run
node scripts/binance_unified.js transfer-from-futures <asset> <amount> --dry-run
# 有持仓的合约账户转出需明确保证金保留要求
node scripts/binance_unified.js transfer-from-futures <asset> <amount> --dry-run --min-margin-usd <reserve>
node scripts/binance_unified.js earn-redemptions <productId> [--redeem-id <id>]
node scripts/binance_unified.js transfer-history <to-futures|from-futures> [--tran-id <id>]
```

三项资金提交必须显式指定产品/币种、金额和 --dry-run 或 --approved，两模式互斥，无模式或缺参拒绝。实际执行将 dry-run 换成 --approved；宿主 Agent 须已获得对应操作、来源、目标和金额的授权。已有相同明确授权直接复用，开仓授权不自动扩大为赎回和转出保证金，明确组合授权可覆盖多步骤。

金额使用精确十进制字符串，拒绝零、负数、科学计数法、非法尾字符和超过客户端输入范围的精度，不自动修改授权金额。库调用只兼容安全整数 Number，小数必须传字符串，防止传入前已经丢失精度。客户端最多支持 18 位小数，这是本地输入范围，不代表交易所允许的精度。

未提供精度规则时，precision.status=DEFERRED_TO_EXCHANGE、localValidationPassed=true、exchangeValidated=false；金额格式已通过本地校验，具体资金接口精度由交易所提交时校验，不因缺规则文件而阻断。maxScale/stepSize 保留 null，不默认 8 位，也不借用交易 LOT_SIZE 或网络提现步长。dry-run 仅表示本地预检结果，不能证明交易所已经接受金额。交易所明确拒绝时保留错误码和 FAILED，不修改金额后重试；超时仍为 UNKNOWN 并查询历史。

权限、余额、产品状态和保证金约束仍须通过。失败预览保留来源、去向、金额、已取得的检查值、未知项和 blockers，CLI 非零退出。交易所 ID 无损保存。只读检查失败不能当作余额为零或通过检查。

### 有来源的资金精度规则

精度规则是可选的额外本地约束。从对应交易所资料或接口支持答复取得实际精度后，可用 --precision-file 提供调用方维护的 JSON；库调用可传 options.precisionRule。文件形状为 {"rules":[...]}，每条规则包含以下字段：

| 字段 | 要求 |
|---|---|
| endpoint | /sapi/v1/simple-earn/flexible/redeem 或 /sapi/v1/asset/transfer |
| operation | REDEEM_EARN、MAIN_UMFUTURE 或 UMFUTURE_MAIN |
| asset | 精确币种标识；划转本期只支持 USDT |
| productId | 赎回必须匹配具体产品；划转不填 |
| maxScale / stepSize | 至少一项，必须来自该资金操作的精度依据；maxScale 为 0～18 的整数，stepSize 为正十进制字符串 |
| source | url（Binance HTTPS 来源）、reference（具体段落或支持答复引用）、verifiedAt（核实时间） |
| expiresAt | 可选失效时间；过期规则拒绝，应随接口契约更新重新核实 |

显式规则必须匹配 endpoint、operation、asset 和 productId；文件损坏、无匹配、重复匹配、过期、来源缺失、超精度或不符合步长均阻断，不退回默认模式，不截断金额。stepSize 必须为十进制字符串。有效规则标记 CONFIGURED，表示调用方提供的有来源规则，代码不宣称自动核实了网页内容。生产项目没有内置未经证实的精度值。一次性规则文件放 tmp/ 并清理，不是交易台账。

```bash
node scripts/binance_unified.js redeem-earn <productId> <amount> --dry-run --precision-file tmp/funding-rules.json
node scripts/binance_unified.js transfer-to-futures USDT <amount> --dry-run --precision-file tmp/funding-rules.json
```

活期赎回使用 /sapi/v1/simple-earn/flexible/redeem，发送 productId、amount、redeemAll=false、destAccount=SPOT，不发送 type=FAST。持仓 canRedeem 必须明确为 true，collateralAmount 必须已知，未质押可赎回量按 totalAmount - collateralAmount 检查；字段缺失不能当零质押。旧第三个 type 参数明确报迁移错误。success=true 和合法 redeemId 仅证明提交，完成记录与现货 free 余额须再核实。

划转迁移到 /sapi/v1/asset/transfer，转入 MAIN_UMFUTURE，转出 UMFUTURE_MAIN；需要 API Key 的 **Universal Transfer** 权限，失败不回退旧接口、不自动改权限。预检通过只读 /sapi/v1/account/apiRestrictions 核实 permitsUniversalTransfer，必须明确为 true；未开启、未知或查询失败均阻断，输出权限名称。本期支持普通现货与单资产 USDⓈ-M 的 USDT 划转；其他币种、未知或多资产账户体系明确阻断。合约账户资产记录和方向权限必须可核实；exchangeInfo 的 marginAvailable 仅指多资产保证金资格，不用于普通账户划转判定。现货检查 free，合约检查币种最大可转出金额及风险约束，不能用 walletBalance/availableBalance 替代。存在持仓时报告保证金变化，要求明确保留预算与必要数据。

资金状态 SUBMITTED / CONFIRMED / FAILED / UNKNOWN 分开。合法 ID 是提交凭证，历史完成记录才确认；明确拒绝为 FAILED，提交不确定为 UNKNOWN。余额变化不能证明某笔完成。缺 ID 时按方向、币种、金额、时间列候选，多个匹配、无记录或查询失败不得自动重发，不虚构服务端幂等键。

历史确认要求匹配 ID 的记录唯一，核对币种、金额，以及赎回产品和 SPOT 目的账户或划转方向；字段缺失、冲突记录维持 UNKNOWN。

历史接口明确 total=0 时允许省略 rows，表示可信零记录；缺 total、非法计数、记录数量矛盾或不完整分页均报失败，不能当成没有执行过操作。可信空历史也不授权自动重发。

资金衔接：说明缺口 → 已授权赎回/划转 → 核实完成与目标余额 → 重查交易有效期 → 经批准开仓。上一步未确认不推进下一步，后续失败不隐式反向划转或申购。

## 6. 永续合约交易执行与保护

| 意图 | 入场 | 保护/平仓 | 价格关系 |
|---|---|---|---|
| LONG | BUY | SELL | SL < 入场 < TP |
| SHORT | SELL | BUY | TP < 入场 < SL |

Hedge Mode 使用 LONG/SHORT，One-Way 使用 BOTH 并按仓位数量符号识别方向。账户模式未知直接阻断，不猜测、不自动切换。拒绝 SELL/LONG、BUY/SHORT 开仓组合。平仓有多个方向时须明确方向；负数 BOTH 能按 SHORT 匹配。

```bash
# 风险上限须来自用户授权或明确配置
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> MARKET <sl> <tp> --dry-run --request-id <id> --risk-usd <risk> --max-notional-usd <notional> --max-leverage <leverage> --max-slippage-bps <bps>
node scripts/binance_unified.js open-tpsl <symbol> <BUY|SELL> <LONG|SHORT> <qty> LIMIT <price> <sl> <tp> --dry-run --request-id <id> --risk-usd <risk> --max-notional-usd <notional> --max-leverage <leverage> --max-slippage-bps <bps>
node scripts/binance_unified.js reconcile <symbol> --request-id <id>
node scripts/binance_unified.js set-tpsl <symbol> <LONG|SHORT> <slPrice|-> <tpPrice|-> [qty] [--request-id <id>] [--replace-algo-id <id>]
node scripts/binance_unified.js close-position <symbol> [LONG|SHORT]
```

实际开仓将 --dry-run 换为 --approved，两者须选一且互斥。风险上限缺失只可预览 blocked，不可执行。价格有效期 --max-age-ms 默认 30000。建议显式请求 ID；未传时使用输出的生成 ID，重试须复用，不生成新 ID 绕过核对。

发单前校验完整有限正数、枚举、tickSize/stepSize、最小数量和名义金额，使用精确十进制。数量可向下量化并重算风险，不为满足最小额增仓。必要价格、模式、账户和深度数据缺失时阻断。

MARKET 及可立即成交的 LIMIT 预检查使用精确盘口加权成本计算 VWAP，并在参考价和预计成交价下检查费用、止损风险、名义金额和保证金。LIMIT 只使用符合限价的即时深度，潜在余量按限价计算，不估成超过限价的成交。实际及最终成交均价更新后按实际数量重新核对授权上限；越限进入补偿。累计成交快照倒退视为不确定，保留保护并核对，不能解释为未成交。费用使用账户 taker 费率估计，实际清算费用和未来资金费仍有不确定性，止损触发也不能保证最终平仓价。最终成交后再次核对双腿有效覆盖，缺失或查询失败不能报告完整成功。

新开仓要求同币无已有仓位、无未决入场单。禁止加仓、反手和双持；既有仓位维护和平仓继续可用。主 Agent 是同账户同币唯一执行者，子 Agent 不并发下单；本地预检不保证跨客户端互斥。

入场、保护、补偿是**串行请求**，存在时间窗口，不宣称原子交易。入场委托受理后立即提交止损、止盈，不等待首次成交；复用入场前已校验的模式、价格和交易规则，避免在提交止损前重复查询仓位。LIMIT 预挂保护使用完整计划 quantity 和 GTC，不传 closePosition；双向模式使用 SELL/LONG 或 BUY/SHORT，单向模式须带 reduceOnly=true，交易所拒绝时进入补偿，不能去掉只减仓限制重试。入场前同时核验 LOT_SIZE 和保护单 MARKET_LOT_SIZE，不向下缩减保护数量。MARKET 成交后的保护及已有仓位维护继续使用 closePosition 全仓保护。后续部分成交沿用双腿并重算实际风险。保护价格须同时符合计划入场价和当前市场价，不能提交已经达到触发条件的预挂保护。

LIMIT 默认 GTC，不设置客户端撤单期限（等同 --wait-ms 0）。入场受理后立即提交并核实双腿保护，再查询最新成交状态及仓位：仍未成交或部分成交时返回 SUBMITTED/ENTRY_PENDING，保留交易所上的入场余量与保护单，不因脚本结束撤单，也不把挂单中报告为全部成交。适用于等待回踩、反弹或区间边缘的入场计划；委托何时撤销应由交易计划失效条件和用户指令决定。

只有显式指定正数 --wait-ms 才启用等待到期撤余量，例如 --wait-ms 3600000 表示本次进程等待一小时；取消原先 120 秒上限。该参数是客户端计时，不是交易所 GTD，进程退出后不会继续定时撤单。等待期间持续核对双腿有效性；任一腿已触发、失效或无法核实，先撤入场余量并确认终态，再处理剩余仓位。超时撤余量后核查新增成交和保护覆盖；无成交且可信空仓后清理本请求保护。MARKET 保留原有成交确认等待流程。

已经就位的保护由交易所执行，无需 Agent 再醒来补挂；但独立保护单不会自动撤销未成交的入场余单，整个流程也不具备交易所原子关联。进程被强制终止、断电或断网时，客户端无法保证余单清理；默认 GTC 返回后不启动后台监控，executionPolicy.monitoringActive=false。应按交易计划复核，撤单或保护触发后核查入场余量、实际仓位和剩余保护；进程恢复后须先 reconcile。只读对账不会自动撤余单，预挂保护也不提供原子关联。

保护单提交后，每腿最多用 3 秒、3 轮只读核对：优先按 algoId 查询，暂时查不到时改用 clientAlgoId 和同币活动保护单列表。提交结果不确定时按原 clientAlgoId 核对，不重发保护单。只有唯一匹配且身份、方向、触发价、触发基准、保护方式和未触发的有效状态全部通过才确认；指定数量的保护还须确认数量、GTC 及平仓方向，单向模式必须确认 reduceOnly=true；身份冲突或已失效立即失败，持续查不到仍进入原有补偿流程。该窗口包含查询超时，不把单次 -2013 直接等同于创建失败。

更新保护先确认新腿有效再撤对应旧腿；撤销后确认已撤状态或可信查询证明不存在，不能只看请求正常返回。修订保护继续使用原交易 request ID 前缀，保持生命周期归属。只更新一腿保留另一腿，无新参数拒绝。只撤本流程保护，外部订单需用户明确指定 ID。一腿失败保留有效保护并报告待补偿状态。

LIMIT 空仓预挂不能使用 closePosition=true：全平保护只对已有持仓有效，空仓时交易所会拒绝。dry-run 展示入场与双腿保护的实际参数，但不证明交易所接受了保护单。

单独 set-tpsl 自动继承唯一的现有保护前缀；多个前缀必须通过 --request-id 明确维护范围。只替换指定前缀或 --replace-algo-id 明确授权的外部订单。核验 algoId、clientAlgoId、workingType、方向、closePosition 和有效状态；已有触发订单 ID 的腿不算有效。失败时 protectionResult 返回已确认腿、尝试的 clientAlgoId、确认已撤 ID、保留 ID 及撤销状态未知的 ID，不把不确定撤单说成旧保护仍完整。

平仓通过可信快照确认归零后才能清理保护。查询失败、剩余仓位或不确定提交不能当成功；回滚核实余单处理与仓位终态。重复 request ID 必须核对原订单数量、类型及限价，匹配时返回当前核对状态并标记 replayed，不再发新入场单；不匹配直接拒绝。稳定请求 ID 不保证永久幂等；不能确定时输出 AMBIGUOUS_STATE，禁止重开。

reconcile 全程只读，输出 entryTerminal、pendingEntries、matchingPosition、protectionCoverage、触发腿的实际子订单证据、blockers 和 nextActions。可信已成交终态且双腿覆盖为 CONFIRMED/OPEN_PROTECTED；未成交或部分成交的入场单须有双腿覆盖完整委托数量才为 SUBMITTED，空仓但仍有入场委托的合法预挂保护不算孤儿保护；无成交终态且可信空仓为 FAILED；缺失或冲突证据为 UNKNOWN。可信已成交但目前空仓可以确认当前 FLAT_AFTER_FILL，closureCause 未核实时仍 UNKNOWN，不能据此声称执行了回滚。订单及保护历史受保留期限限制，查不到不能证明未发单。重复请求保留该核对状态并标记 replayed，不再统一包装成 SUBMITTED。

## 7. 公共网络与结果消费

原生 fetch；HTTP 错误、负错误码、非法 JSON/业务响应在标准化前拒绝，保留 code/msg。不能把错误包装成成功订单或空仓位。

只读请求可重试；写请求不自动重发。仅收到明确 -1021 拒绝时校时后重发一次，超时、连接中断和可能已执行的服务端故障先核对历史/订单。签名使用 HMAC SHA256、服务器时差和 recvWindow，凭据值永不输出。

扫描、评估、历史、reconcile、dry-run 不产生资金写请求。运行状态通过 stdout 交付，不自动建台账；既有显式日志按原开关管理。仓库的持久离线回归套件通过 `npm test` 运行，测试在 `tests/` 与自研 skill 脚本目录维护，使用伪造 fetch 和 fixture。一次性输入与验证脚本放 `tmp/`，使用后清理，不要把临时探针留在源码目录。
