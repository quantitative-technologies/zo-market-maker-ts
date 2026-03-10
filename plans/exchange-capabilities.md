# Exchange API Capabilities Catalogue

Comparison of exchange APIs relevant to market-making integration.

## Capability Matrix with References

Each claim links to the relevant documentation page for verification.

### General

| Capability | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **Chain** | Solana (NordVM) | Custom L1 (HyperBFT) | Starknet |
| **Auth** | Solana keypair (Ed25519) | ECDSA (Ethereum key) [[1]](#hl-exchange) | STARK signature (SNIP12) + API key [[2]](#ext-api) |
| **SDK** | `@n1xyz/nord-ts` [[3]](#o1-npm) | Raw fetch + ws | Raw fetch + ws |
| **Collateral** | USDC | USDC | USDC |
| **Leverage** | Up to 20x | Up to 50x | Up to 100x |

### Order Execution

| Capability | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **Atomic cancel+place** | Yes (up to 4 actions) [[4]](#o1-docs) | No (sequential requests) [[1]](#hl-exchange) | No (but has `cancelId` replace) [[2]](#ext-api) |
| **Batch place** | Yes (atomic, max 4) [[4]](#o1-docs) | Yes (single request, N orders) [[1]](#hl-exchange) | No (one order per request) [[2]](#ext-api) |
| **Batch cancel** | Yes (atomic, max 4) [[4]](#o1-docs) | Yes (single request, N cancels) [[1]](#hl-exchange) | Mass-cancel only (by market/side) [[2]](#ext-api) |
| **Batch modify** | Via atomic cancel+place | Yes (`batchModify` endpoint) [[1]](#hl-exchange) | Via `cancelId` replace (1 at a time) [[2]](#ext-api) |
| **Order replace/amend** | No native amend | Yes (`batchModify`) [[1]](#hl-exchange) | Yes (`cancelId` param on create) [[2]](#ext-api) |

### Order Types & Fill Modes

| Mode | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **Limit (GTC)** | `Limit` [[4]](#o1-docs) | `{"limit":{"tif":"Gtc"}}` [[1]](#hl-exchange) | GTT (good-till-time, max 90 days) [[2]](#ext-api) |
| **Post-only** | `PostOnly` [[4]](#o1-docs) | `{"limit":{"tif":"Alo"}}` [[1]](#hl-exchange) | Post-only flag [[2]](#ext-api) |
| **IOC** | `ImmediateOrCancel` [[4]](#o1-docs) | `{"limit":{"tif":"Ioc"}}` [[1]](#hl-exchange) | IOC flag [[2]](#ext-api) |
| **FOK** | `FillOrKill` [[4]](#o1-docs) | Not documented | Not documented |
| **Market** | Via IOC | Via IOC with slippage [[5]](#hl-order-types) | Via IOC with 0.75% slippage [[2]](#ext-api) |
| **Reduce-only** | Yes | Yes [[1]](#hl-exchange) | Yes [[2]](#ext-api) |
| **Trigger/conditional** | Not documented | Yes (TP/SL) [[5]](#hl-order-types) | Yes (conditional + TPSL) [[2]](#ext-api) |
| **TWAP** | No | Yes (2+ min) [[1]](#hl-exchange) | No |

### Real-time Data (WebSocket)

| Stream | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **Orderbook** | Delta updates on L2 snapshot [[4]](#o1-docs) | Full L2 snapshot per msg [[6]](#hl-ws-subs) | Snapshot + deltas (100ms push) [[7]](#ext-ws) |
| **Account/orders** | Account subscription [[4]](#o1-docs) | `userFills`, `orderUpdates` [[6]](#hl-ws-subs) | Private account stream [[2]](#ext-api) |
| **Trades** | Via account subscription | `trades` subscription [[6]](#hl-ws-subs) | Public trades stream [[7]](#ext-ws) |
| **Funding rate** | Not documented | `activeAssetCtx` [[6]](#hl-ws-subs) | Public funding stream [[7]](#ext-ws) |
| **Mark/index price** | Not documented | Not documented via WS | Public mark/index stream [[7]](#ext-ws) |

### Rate Limits

| Limit | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **REST** | Solana TX throughput | 1200 weight/min (IP) [[8]](#hl-rate) | 1000 req/min default, up to 12000 [[2]](#ext-api) |
| **Address-based** | N/A | 1 req per 1 USDC traded cumulative [[8]](#hl-rate) | Not documented |
| **WS connections** | Not documented | 10 max, 30 new/min [[8]](#hl-rate) | Not documented |
| **WS subscriptions** | Not documented | 1000 max [[8]](#hl-rate) | Not documented |
| **Open orders** | Not documented | 1000 default, up to 5000 [[8]](#hl-rate) | Not documented |
| **Dead man's switch** | No | Yes (5s min delay, 10/day) [[1]](#hl-exchange) | No |

### Position & Account

| Capability | 01 Exchange | Hyperliquid | Extended |
|---|---|---|---|
| **Sub-accounts** | Multi-account support [[4]](#o1-docs) | Vault-based (master signs) [[1]](#hl-exchange) | Up to 10 per wallet [[2]](#ext-api) |
| **Position fetch** | `user.fetchInfo()` [[3]](#o1-npm) | `POST /info clearinghouseState` [[9]](#hl-info) | `GET /api/v1/user/positions` [[2]](#ext-api) |
| **Fee structure** | Not documented | Maker/taker tiered | Maker 0%, Taker 0.025% [[2]](#ext-api) |
| **Self-trade prevention** | Not documented | Not documented | 3 levels (disabled, account, client) [[2]](#ext-api) |

---

## References

<a id="hl-exchange"></a>
**[1]** Hyperliquid Exchange Endpoint — order placement, cancellation, batch modify, TWAP, dead man's switch, auth
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint

<a id="ext-api"></a>
**[2]** Extended API Documentation — orders, cancelId replace, fees, rate limits, sub-accounts, self-trade prevention
https://api.docs.extended.exchange/

<a id="o1-npm"></a>
**[3]** `@n1xyz/nord-ts` npm — 01 Exchange TypeScript SDK
https://www.npmjs.com/package/@fn03/nord-ts

<a id="o1-docs"></a>
**[4]** 01 Exchange Documentation — atomic operations, order types, WebSocket, multi-account
https://docs.01.xyz/

<a id="hl-order-types"></a>
**[5]** Hyperliquid Order Types — limit, trigger, TP/SL, market orders
https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types

<a id="hl-ws-subs"></a>
**[6]** Hyperliquid WebSocket Subscriptions — l2Book, userFills, orderUpdates, trades, activeAssetCtx
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions

<a id="ext-ws"></a>
**[7]** Extended WebSocket Streams — orderbook (snapshot + 100ms deltas), trades, funding, mark/index
`wss://api.starknet.extended.exchange` — documented at [[2]](#ext-api) under WebSocket section

<a id="hl-rate"></a>
**[8]** Hyperliquid Rate Limits — IP/address limits, WS limits, open order caps, congestion throttling
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

<a id="hl-info"></a>
**[9]** Hyperliquid Info Endpoint — clearinghouseState, openOrders, meta, userFills
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint

---

## Matching Engine Execution Details

### Hyperliquid Block-Level Transaction Ordering

Hyperliquid processes transactions in blocks (~1s). Within each block, transactions are sorted into priority tiers [[10]](#hl-orderbook):

1. **High priority**: Actions that only send cancels or ALO (post-only) orders
2. **Low priority**: Actions that send at least one GTC or IOC order

**Modifies are categorized according to the new order they place** [[10]](#hl-orderbook). This has critical implications:

| Requote method | Priority tier | Same-block guarantee | Adverse selection risk |
|---|---|---|---|
| `batchModify` with ALO | High | Yes (single TX) | Low — cancel+place in same block, high priority |
| `batchModify` with GTC | Low | Yes (single TX) | Higher — same tier as taker's GTC order |
| Separate cancel + ALO place | Both high | No (two TXs, may span blocks) | Low per-block, but ~1s gap risk between blocks |
| Separate cancel only | High | N/A | Lowest — fastest removal, no new order overhead |

**Recommended approach for post-only MM**: `batchModify` with ALO is the best requoting method. It gets high priority (same as cancel), guaranteed same-block execution, and single round-trip. The concern about modify being low priority **only applies when the new order is GTC or IOC** [[10]](#hl-orderbook).

**Size-only modifications** preserve queue priority at the existing price level. Price modifications move the order to the back of the queue at the new price [[11]](#cs-modify).

**Additional latency details** [[12]](#hl-latency):
- Median end-to-end latency (co-located): ~200ms
- P99 end-to-end latency (co-located): ~900ms
- Block time: ~1s
- Cancel optimization: noop-based cancel by nonce invalidation conserves rate limits [[13]](#hl-optimize)
- No separate latency figures published for cancel vs modify vs place

**Open questions** (not documented):
- Whether `batchModify` processes individual modifications sequentially or in parallel within the transaction. Third-party sources contradict: Chainstack says "sequentially" [[11]](#cs-modify), Dwellir says "atomic all-or-nothing" [[14]](#dw-modify).
- Whether the order ID changes on a price modify.

### Extended cancelId Replacement Internals

The failure semantics reveal the internal model [[2]](#ext-api):

> "In the rare event that validations pass at the REST API level but fail at the Matching Engine, both the updated order and the initial open order will be cancelled."

This implies a two-phase process within a single matching engine message:

1. **Phase 1**: Remove old order from book (by `cancelId`)
2. **Phase 2**: Validate and insert new order
3. **No rollback**: If Phase 2 fails, Phase 1 is not reversed — old order is already gone

The cancel leg executes at least as fast as a standalone cancel. The advantage over separate cancel + place is single round-trip and no gap where another order can take your price level between operations. But it is **not failure-safe**: ME rejection loses both orders.

**No documented priority ordering** between cancel, place, and replace messages in Extended's matching engine queue. The architecture is off-chain matching with on-chain Starknet settlement [[15]](#ext-arch).

**Latency details**:
- Server location: AWS Tokyo — co-locate in same AZ for optimal latency [[2]](#ext-api)
- Orderbook WS push interval: 100ms [[7]](#ext-ws)
- REST is asynchronous: returns order ID before book confirmation; actual confirmation via WS [[2]](#ext-api)
- No published order-to-ack, cancel, or matching engine processing latency specs

**Maker incentives** [[16]](#ext-fees):
- Maker fee: 0.000%
- Maker rebates (by market share): 0.5% → 0.002%, 1.0% → 0.004%, 2.5% → 0.008%, 5.0% → 0.013%
- Contact: makers@extended.exchange

### 01 Exchange Atomic Execution

The `user.atomic()` call bundles up to 4 actions (any mix of cancels and places) into a single Solana transaction [[4]](#o1-docs). All succeed or all fail — true atomicity. No priority tier concerns since atomicity eliminates the gap entirely.

**MM-relevant limitations:**
- Max 4 actions per atomic call (need chunking for >4)
- No native order amend/modify — must cancel+place
- Limited public documentation on rate limits and matching engine internals

---

## Requoting Strategy Summary

| Exchange | Best requote method | Why |
|---|---|---|
| **01** | `atomic()` cancel+place | True atomicity, all-or-nothing, no gap |
| **Hyperliquid** | `batchModify` with ALO (post-only) | High priority tier + guaranteed same-block + single round-trip |
| **Extended** | `cancelId` replace | Single ME message, no gap, but 1:1 only and lose both on ME rejection |

---

## References

<a id="hl-exchange"></a>
**[1]** Hyperliquid Exchange Endpoint — order placement, cancellation, batch modify, TWAP, dead man's switch, auth
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint

<a id="ext-api"></a>
**[2]** Extended API Documentation — orders, cancelId replace, fees, rate limits, sub-accounts, self-trade prevention
https://api.docs.extended.exchange/

<a id="o1-npm"></a>
**[3]** `@n1xyz/nord-ts` npm — 01 Exchange TypeScript SDK
https://www.npmjs.com/package/@fn03/nord-ts

<a id="o1-docs"></a>
**[4]** 01 Exchange Documentation — atomic operations, order types, WebSocket, multi-account
https://docs.01.xyz/

<a id="hl-order-types"></a>
**[5]** Hyperliquid Order Types — limit, trigger, TP/SL, market orders
https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types

<a id="hl-ws-subs"></a>
**[6]** Hyperliquid WebSocket Subscriptions — l2Book, userFills, orderUpdates, trades, activeAssetCtx
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions

<a id="ext-ws"></a>
**[7]** Extended WebSocket Streams — orderbook (snapshot + 100ms deltas), trades, funding, mark/index
`wss://api.starknet.extended.exchange` — documented at [[2]](#ext-api) under WebSocket section

<a id="hl-rate"></a>
**[8]** Hyperliquid Rate Limits — IP/address limits, WS limits, open order caps, congestion throttling
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

<a id="hl-info"></a>
**[9]** Hyperliquid Info Endpoint — clearinghouseState, openOrders, meta, userFills
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint

<a id="hl-orderbook"></a>
**[10]** Hyperliquid Order Book — block-level transaction ordering, cancel priority, modify categorization
https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/order-book

<a id="cs-modify"></a>
**[11]** Chainstack: Modify Order — queue priority preservation (size-only vs price change)
https://docs.chainstack.com/reference/hyperliquid-exchange-modify-order

<a id="hl-latency"></a>
**[12]** Hyperliquid Blog: Latency and Transaction Ordering — co-located latency numbers, throughput
https://hyperliquid.medium.com/latency-and-transaction-ordering-on-hyperliquid-cf28df3648eb

<a id="hl-optimize"></a>
**[13]** Hyperliquid Optimizing Latency — noop cancel, non-validating node, hardware recs
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/optimizing-latency

<a id="dw-modify"></a>
**[14]** Dwellir: batchModify — atomic execution claim (contradicts Chainstack on partial success)
https://www.dwellir.com/docs/hyperliquid/batchModify

<a id="ext-arch"></a>
**[15]** Extended Technical Architecture — off-chain matching, on-chain Starknet settlement
https://docs.extended.exchange/about-extended/technical-architecture

<a id="ext-fees"></a>
**[16]** Extended Trading Fees & Rebates — maker 0%, rebate tiers, payout schedule
https://docs.extended.exchange/extended-resources/trading/trading-fees-and-rebates

<a id="n1-docs"></a>
**[17]** N1 Introduction & 01 Exchange FAQ — Proton chain, curated operator model, Priority Access Program
https://docs.n1.xyz/learn/introduction-to-n1 / https://docs.01.xyz/support/faq/general

<a id="hl-obs"></a>
**[18]** Hyperliquid Order Book Server — open-source Rust WS server for L2/L4 book from node output
https://github.com/hyperliquid-dex/order_book_server

<a id="hl-node-gh"></a>
**[19]** Hyperliquid Node Setup — hardware requirements, configuration, peering
https://github.com/hyperliquid-dex/node

<a id="qn-hl"></a>
**[20]** QuickNode: Hyperliquid RPC Providers Comparison — provider landscape, pricing, features
https://blog.quicknode.com/best-hyperliquid-rpc-providers-2026-full-comparison/

<a id="dw-hl"></a>
**[21]** Dwellir: Hyperliquid RPC — dedicated clusters, co-location, gRPC streaming
https://www.dwellir.com/networks/hyperliquid

<a id="ext-vision"></a>
**[22]** Extended Rationale & Vision — future validator program, open-source state machines
https://docs.extended.exchange/starknet-migration/rationale-and-vision

---

## Infrastructure & Latency

### DEX Architecture Models

The infrastructure needed depends on the DEX's architecture:

| Model | How it works | Examples |
|---|---|---|
| **App-chain** | Orderbook lives on a dedicated L1. Every node replicates state. | Hyperliquid, dYdX v4 |
| **Hybrid CLOB** | Centralized off-chain matching engine, on-chain settlement. | Extended, Paradex |
| **01 (unique)** | Own chain (Proton/NordVM), but no public node program. | 01 Exchange |

### Node vs No Node

A node gives you faster **reads** (market data), not faster **writes** (order submission). You see price changes sooner, so you can react sooner — but your cancel/modify still travels the same network path as everyone else.

| Exchange | Own node? | What it gives you | What it doesn't give you |
|---|---|---|---|
| **Hyperliquid** | Yes (non-validating) [[13]](#hl-optimize) | Local orderbook from block outputs, no API rate limits for reads | Faster order submission — still goes through public API [[13]](#hl-optimize) |
| **Extended** | No (centralized ME) [[15]](#ext-arch) | N/A | N/A — co-locate in AWS Tokyo instead [[2]](#ext-api) |
| **01** | Not available [[17]](#n1-docs) | N/A — curated operator model, no public validators | N/A |

### Feed Latency vs Order Submission Latency

These are two separate concerns. Feed latency determines how quickly you *detect* a price move. Order submission latency determines how quickly your reaction *reaches* the matching engine. Both matter for adverse selection — seeing the move first is only useful if you can act on it before getting picked off.

| Exchange | Feed latency (best case) | Feed latency (public API) | Order submission latency |
|---|---|---|---|
| **Hyperliquid** | Block execution time (local node read) [[13]](#hl-optimize) | API WS: ~50-200ms [[12]](#hl-latency) | ~200ms median co-located [[12]](#hl-latency) |
| **Extended** | WS push every 100ms [[7]](#ext-ws) | Same (no node alternative) | Network RTT to AWS Tokyo [[2]](#ext-api) |
| **01** | WS delta stream [[4]](#o1-docs) | Same (no node alternative) | Network RTT to `zo-mainnet.n1.xyz` |

Order submission latency on app-chains is bounded by consensus/block time (~200ms on Hyperliquid, ~1s blocks). No amount of co-location gets below this floor. On hybrid CLOBs (Extended), the floor is matching engine processing time — not documented, but network RTT to Tokyo dominates.

### Hyperliquid Node Details

Running a non-validating node replicates chain state locally [[13]](#hl-optimize):

- Streams raw L1 data to `~/hl/data/`: blocks, snapshots (every 10K blocks), trades, fills, order statuses, book diffs, oracle updates
- Use `--disable-output-file-buffering` for outputs as soon as blocks execute
- Open-source [order_book_server](https://github.com/hyperliquid-dex/order_book_server) [[18]](#hl-obs) builds L2/L4 books from node output
- Co-locate in **Tokyo** (AWS apne1-az1 where Foundation node runs) [[13]](#hl-optimize)
- Cancel optimization: noop-based nonce invalidation instead of explicit cancel [[13]](#hl-optimize)

**Hardware requirements** [[19]](#hl-node-gh):

| | Non-validating | Validator |
|---|---|---|
| vCPUs | 16 | 32 |
| RAM | 64 GB | 128 GB |
| Storage | 500 GB SSD (500 MB/s) | 1 TB SSD |
| OS | Ubuntu 24.04 | Ubuntu 24.04 |
| Ports | 4001-4002 open | 4001-4002 open |

**Third-party node/RPC providers** (alternative to self-hosting):

| Provider | Offering | Price | Source |
|---|---|---|---|
| QuickNode | All 7 HyperCore data streams, gRPC, zstd compression | $49-999/mo | [[20]](#qn-hl) |
| Dwellir | gRPC streaming, dedicated order book server, co-location | $699-1150/mo | [[21]](#dw-hl) |
| Hydromancer | L4 orderbook with address visibility | $300-2500/mo | [[20]](#qn-hl) |

### 01 Exchange Infrastructure

01 runs on N1's Proton chain, **not Solana** — Solana is only used for deposits/withdrawals [[17]](#n1-docs). The `solanaConnection` in the SDK handles wallet auth and bridging, not trade execution.

- Orders go to `zo-mainnet.n1.xyz` via HTTP/WS, executed on Proton
- Running a Solana RPC node provides **zero trading latency benefit**
- No public validator or node program — curated operator model [[17]](#n1-docs)
- N1 has a [Priority Access Program](https://tally.so/r/wM8KRg) for MM infrastructure guidance
- Server location unknown — co-location requires contacting N1 team

### Extended Infrastructure

Centralized matching engine with Starknet settlement [[15]](#ext-arch):

- **Co-locate in AWS ap-northeast-1a (Tokyo)** — explicitly recommended in docs [[2]](#ext-api)
- No node to run, no validator program (planned for future [[22]](#ext-vision))
- Functionally identical to a CEX for latency — competitive edge is co-location + algorithm
- REST is async: returns order ID before book confirmation, actual confirmation via WS [[2]](#ext-api)
- Future roadmap: open-source validator state machines with "latency under 100ms" target [[22]](#ext-vision)

---

## Adapter Complexity Estimate

| Exchange | Complexity | Notes |
|---|---|---|
| 01 Exchange | Done | Already integrated via `@n1xyz/nord-ts` |
| Hyperliquid | Medium (~500-700 LOC) | Plan exists. Raw fetch+ws, EIP-712 signing via `viem`. Use `batchModify` with ALO for requoting. |
| Extended | Medium-High (~600-900 LOC) | STARK signing adds complexity. `cancelId` replace for requoting (1:1 per level). Must handle "both cancelled" failure case. |
