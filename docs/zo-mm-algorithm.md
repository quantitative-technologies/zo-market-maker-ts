# Zo Market Maker Algorithm Specification

This document describes the market maker algorithm with sufficient precision for reimplementation. All behavior is derived from source code; line numbers reference the current codebase.

## 1. Architecture

The bot is event-driven with a dual-feed design:

```
Binance WebSocket (reference price)
  │
  ▼
FairPriceCalculator ──► Quoter ──► diffOrders ──► adapter.updateQuotes()
  ▲                       ▲                              │
  │                       │                              ▼
Exchange Orderbook    PositionTracker              Exchange (atomic)
  (execution price)       ▲                              │
                          │                              │
                    Exchange Fills ◄──────────────────────┘
                          │
                    BalanceTracker
                    AnalyticsTracker
```

**Components:**

| Component | File | Role |
|-----------|------|------|
| MarketMaker | `src/bots/mm/index.ts` | Main loop, event wiring, lifecycle |
| FairPriceCalculator | `src/pricing/fair-price.ts` | Computes fair price from dual feeds |
| BinancePriceFeed | `src/pricing/binance.ts` | Binance Futures bookTicker stream |
| Quoter | `src/bots/mm/quoter.ts` | Generates bid/ask quotes |
| PositionTracker | `src/bots/mm/position.ts` | Tracks position, PnL, close mode |
| BalanceTracker | `src/bots/mm/balance.ts` | Tracks equity, funding, fees |
| AnalyticsTracker | `src/bots/mm/analytics.ts` | Markout analytics per fill |
| diffOrders | `src/orders.ts` | Diffs desired quotes vs active orders |
| ExchangeAdapter | `src/exchanges/adapter.ts` | Exchange-agnostic interface |

## 2. Startup Sequence

`MarketMaker.run()` (`index.ts:92`):

1. **Create throttled update** function: `lodash.throttle(executeUpdate, updateThrottleMs, {leading: true, trailing: true})`
2. **Connect** to exchange adapter → returns `MarketInfo` (symbol, priceDecimals, sizeDecimals, quoteDecimals, minOrderNotionalUsd)
3. **Validate** `orderSizeUsd >= minOrderNotionalUsd` — throw if below
4. **Derive Binance symbol** from exchange symbol (e.g., `"BTC-PERP"` → `"btcusdt"`)
5. **Create components:**
   - `FairPriceCalculator(windowMs=fairPriceWindowMs, minSamples=warmupSeconds)`
   - `PositionTracker(closeThresholdUsd, positionSyncIntervalMs)`
   - `BalanceTracker(balanceSyncIntervalMs)`
   - `Quoter(priceDecimals, sizeDecimals, spreadBps, takeProfitBps, orderSizeUsd)`
   - `AnalyticsTracker(getMarkPriceFn, markoutHorizonsMs)`
   - `BinancePriceFeed(binanceSymbol, staleThresholdMs, staleCheckIntervalMs)`
6. **Register event handlers** (see Section 7)
7. **Sync initial orders** from exchange via `adapter.syncOrders()` → populate `activeOrders[]`
8. **Initialize balance** — fetch snapshot + fee rates from exchange
9. **Optionally close existing position** if `closePosition` option passed via constructor
10. **Start position sync loop** with trade recovery callback
11. **Start periodic intervals** (status display, order sync)
12. **Register shutdown handlers** (SIGINT, SIGTERM)
13. **Block** indefinitely (`waitForever()`)

### Close Existing Position (`index.ts:329`)

If position is non-zero at startup:
1. Fetch current position, round to `sizeDecimals`
2. Get mid price from orderbook
3. Calculate close price: `mid - (mid * closeSlippageBps / 10000)` for longs, `mid + (mid * closeSlippageBps / 10000)` for shorts
4. Submit IOC reduce-only order via `adapter.closePosition(baseSize, closePrice)`
5. Fetch position again — throw if not flat

## 3. Fair Price Calculation

`FairPriceCalculator` (`src/pricing/fair-price.ts`):

### Data Structure
- Circular buffer of `MAX_SAMPLES = 500` offset samples
- Each sample: `{ offset: number, second: number }` where `second = Math.floor(Date.now() / 1000)`
- Deduplication: at most one sample per Unix second

### Sampling (`addSample(localMid, referenceMid)`)
- Called when both exchange and Binance have fresh prices (timestamps within 1000ms of each other)
- `offset = localMid - referenceMid`
- Write to circular buffer at `head` position; advance `head = (head + 1) % MAX_SAMPLES`

### Calculation (`getFairPrice(referenceMid)`)
1. Filter samples to those within `fairPriceWindowMs` of now (default 300,000ms = 5 minutes)
2. If fewer than `minSamples` (= `warmupSeconds` from config) valid samples → return `null`
3. Sort valid offsets numerically
4. Compute median:
   - Odd count: middle element
   - Even count: average of two middle elements
5. Return `referenceMid + median(offsets)`

### Design Rationale
- Median is robust to outliers (flash wicks on exchange don't corrupt fair price)
- Offset-based: tracks the exchange's premium/discount vs Binance
- One-per-second dedup prevents fast-ticking feeds from dominating the window

## 4. Quote Generation

`Quoter.getQuotes(ctx, bbo)` (`src/bots/mm/quoter.ts:26`):

### Inputs
- `ctx.fairPrice: number` — computed fair price
- `ctx.positionState` — position size, direction, close mode
- `ctx.allowedSides: ("bid" | "ask")[]` — which sides to quote
- `bbo: {bestBid, bestAsk} | null` — current best bid/offer from orderbook

### Spread
```
if (closeMode):
    bps = takeProfitBps
else:
    bps = spreadBps

spreadAmount = fairPrice * bps / 10000
```

### Price Alignment
```
tickSize = 10^(-priceDecimals)
lotSize  = 10^(-sizeDecimals)

alignPrice(price, "floor") = floor(price / tickSize) * tickSize
alignPrice(price, "ceil")  = ceil(price / tickSize) * tickSize
```

### Bid Quote (if "bid" in allowedSides)
```
bidPrice = alignPrice(fairPrice - spreadAmount, "floor")

if bbo exists AND bidPrice >= bestAsk:
    bidPrice = alignPrice(bestAsk - tickSize, "floor")

if bidPrice > 0:
    emit Quote{side: "bid", price: bidPrice, size}
```

### Ask Quote (if "ask" in allowedSides)
```
askPrice = alignPrice(fairPrice + spreadAmount, "ceil")

if bbo exists AND askPrice <= bestBid:
    askPrice = alignPrice(bestBid + tickSize, "ceil")

if askPrice > 0:
    emit Quote{side: "ask", price: askPrice, size}
```

### Size Calculation
```
if closeMode:
    size = alignSize(|positionSize|)
         = floor(|positionSize| / lotSize) * lotSize

else:
    size = usdToSize(orderSizeUsd, fairPrice)
         = ceil((orderSizeUsd / fairPrice) / lotSize) * lotSize
```

Normal mode rounds UP (`ceil`) to ensure size exceeds minimum notional.
Close mode rounds DOWN (`floor`) to avoid overshooting position size.

### Output
Returns 0, 1, or 2 `Quote` objects. Returns empty array if computed size ≤ 0.

## 5. Order Diffing

`diffOrders(current, desired)` (`src/orders.ts:21`):

Pure function. Compares cached active orders against newly desired quotes.

### Match Criteria (`orderMatchesQuote`, `orders.ts:12`)
An order matches a quote if ALL of:
- `order.side === quote.side`
- `order.price.eq(quote.price)` (Decimal exact equality)
- `order.size.eq(quote.size)` (Decimal exact equality)

### Algorithm
```
for each quote in desired:
    if exists order in current matching quote:
        add order to kept[]
    else:
        add quote to toPlace[]

toCancel = current.filter(o => o not in kept)

return {kept, toCancel, toPlace}
```

### Behavior
- If all quotes match existing orders: `toCancel=[], toPlace=[]` → no exchange call
- If price moved: old orders cancelled, new quotes placed
- If only one side changed: other side kept, changed side cancelled+replaced

### Partial Fill Gap

`diffOrders` compares against `activeOrders`, which is only updated by `executeUpdate()` completion or periodic `syncOrders()`. When a partial fill occurs:

1. Order rests on exchange with size 0.00015. `activeOrders` stores `CachedOrder{size: 0.00015}`.
2. Partial fill: 0.00005 taken. Exchange order now has size 0.00010.
3. `onFill` fires — position tracker updated, but `activeOrders` is **not** updated (cached size still 0.00015).
4. Next `executeUpdate`: quoter produces `Quote{size: 0.00015}` (same USD target). `diffOrders` compares cached 0.00015 == desired 0.00015 → **match → kept**. No exchange call.
5. The bot believes the order is fully sized, but the exchange order is only 0.00010. The bot is **underquoted** on that side.
6. After up to `orderSyncIntervalMs` (typically 3s): `syncOrders()` fetches exchange state → `activeOrders` updated to actual size 0.00010.
7. Next `diffOrders`: cached 0.00010 != desired 0.00015 → cancel + place new full-size order.

During this gap (up to `orderSyncIntervalMs`), the bot has less size on the book than intended.

## 6. Order Execution

### Zo Adapter (`src/exchanges/zo/adapter.ts`)

`updateQuotes(cancels, places)` calls `executeQuoteUpdate()` (`src/sdk/orders.ts:177`):

1. Build action list:
   - Cancel actions: `{kind: "cancel", orderId}` for each cancel
   - Place actions: `{kind: "place", marketId, side, fillMode: PostOnly, price, size}` for each place
2. Chunk into groups of 4 (Zo atomic limit)
3. Execute each chunk via `user.atomic(chunk)` — all-or-nothing per chunk
4. Extract placed order IDs from result (filter for `placeOrderResult.posted.orderId`)
5. Return `CachedOrder[]` with orderId, side, price, size

### Atomicity
- Each chunk of 4 is atomic: if one cancel fails (e.g., `ORDER_NOT_FOUND`), the entire chunk is rejected
- Cancels and places within the same chunk are all-or-nothing
- Multiple chunks execute sequentially; a later chunk can fail independently

## 7. Update Loop

### Event Flow

**Binance price tick** → `handleBinancePrice()` (`index.ts:214`):
1. Record `tickTimestamp = performance.now()` for T2T measurement
2. If exchange price is fresh (within 1000ms): `fairPriceCalc.addSample(exchangeMid, binanceMid)`
3. Compute fair price: `fairPriceCalc.getFairPrice(binanceMid)`
4. If null (warming up): return
5. Set mark price on position tracker
6. Call `throttledUpdate(fairPrice)`

**Exchange price tick** → `handleExchangePrice()` (`index.ts:247`):
1. If Binance price is fresh (within 1000ms): `fairPriceCalc.addSample(exchangeMid, binanceMid)`
2. No quote update triggered (Binance is the trigger)

### `executeUpdate(fairPrice)` (`index.ts:486`)

```
if isUpdating: return          // re-entrancy guard
isUpdating = true

try:
    ctx = positionTracker.getQuotingContext(fairPrice)
    quotes = quoter.getQuotes(ctx, adapter.getBBO())

    if quotes is empty: return

    {kept, toCancel, toPlace} = diffOrders(activeOrders, quotes)

    if toCancel=0 AND toPlace=0: return

    analyticsTracker.recordQuoteUpdate()
    placedOrders = adapter.updateQuotes(toCancel, toPlace)
    activeOrders = [...kept, ...placedOrders]

    if tickTimestamp > 0:
        t2t = performance.now() - tickTimestamp
        record t2t sample (rolling window of 100)
        // Note: recorded on every successful updateQuotes call

catch err:
    classify error:
        exchange_rejection → log warn, retry next cycle
        http_error         → log error
        client_error       → log error
        network_error      → log error, await periodic sync

finally:
    isUpdating = false
```

### Throttling
- `lodash.throttle` with `leading: true, trailing: true`
- Minimum interval: `updateThrottleMs` (typically 100ms)
- Leading: first call executes immediately
- Trailing: if calls arrive during cooldown, one final call fires after cooldown

## 8. Fill Handling

### Fill Event Source

Zo account stream (`src/sdk/account.ts:171`):
- WebSocket delivers fills with `remaining` field (remaining order size after fill)
- Creates `FillEvent`: `{orderId, side, size, price, remaining, marketId}`
- Internal order tracking: removes order if `remaining <= 0`, updates size if `remaining > 0`

### Bot Handler (`index.ts:169`)

```
onFill(fill):
    1. pnl = positionTracker.applyFill(fill.side, fill.size, fill.price)
    2. balanceTracker.recordFill(fill.side, fill.size, fill.price)
    3. analyticsTracker.recordFill(fill.side, fill.size, fill.price, fairPriceAtFill)
    4. log fill (side, price, size, pnl)
    5. if positionTracker.isCloseMode(fill.price):
           cancelOrdersAsync()   // fire-and-forget
```

### `fill.remaining` usage

`fill.remaining` is NOT currently used to update `activeOrders` in the bot handler. Stale order IDs persist in `activeOrders` until the next `syncOrders()` call (every `orderSyncIntervalMs`). During this gap, the bot may attempt to cancel/modify a filled order, triggering an atomic rejection on the next update cycle.

## 9. Position Tracking

`PositionTracker` (`src/bots/mm/position.ts`)

### State
| Field | Type | Description |
|-------|------|-------------|
| `baseSize` | number | Signed position size (positive=long, negative=short) |
| `avgEntryPrice` | number | Volume-weighted average entry price |
| `realizedPnL` | number | Cumulative realized PnL from closed trades |
| `fillCount` | number | Total fill count |
| `totalVolumeUsd` | number | Cumulative notional volume |
| `lastMarkPrice` | number | Last fair price (for unrealized PnL) |
| `lastSyncTime` | string | ISO timestamp of last position sync |
| `lastTradeId` | number | Highest trade ID seen (for recovery dedup) |

### `applyFill(side, size, price)` (`position.ts:234`)

```
fillSign = (side == "bid") ? +1 : -1
fillCount += 1
totalVolumeUsd += size * price

previousBase = baseSize
isIncreasing = (previousBase == 0) OR (sign(previousBase) == fillSign)

if isIncreasing:
    // VWAP entry update
    avgEntryPrice = (|previousBase| * avgEntryPrice + size * price) / (|previousBase| + size)
    fillPnL = 0

else:  // reducing or flipping
    reduceSize = min(size, |previousBase|)
    remainingSize = size - reduceSize

    if previousBase > 0:  // was long
        fillPnL = (price - avgEntryPrice) * reduceSize
    else:                 // was short
        fillPnL = (avgEntryPrice - price) * reduceSize

    realizedPnL += fillPnL

    if remainingSize > 0:
        avgEntryPrice = price     // flipped: new position at fill price
    elif |previousBase + size * fillSign| < 1e-10:
        avgEntryPrice = 0         // fully closed
    // else: partially reduced, keep old avgEntryPrice

baseSize = previousBase + size * fillSign
return fillPnL
```

### Close Mode

```
getState(fairPrice):
    sizeUsd = baseSize * fairPrice
    isLong = baseSize > 0
    isCloseMode = |sizeUsd| >= closeThresholdUsd
    return {sizeBase: baseSize, sizeUsd, isLong, isCloseMode, avgEntryPrice}

getAllowedSides(state):
    if isCloseMode AND isLong:  return ["ask"]    // sell to reduce
    if isCloseMode AND !isLong: return ["bid"]    // buy to reduce
    return ["bid", "ask"]                         // normal: both sides
```

### Unrealized PnL

```
getUnrealizedPnL(markPrice):
    if baseSize == 0: return 0
    if baseSize > 0:  return (markPrice - avgEntryPrice) * baseSize
    else:             return (avgEntryPrice - markPrice) * |baseSize|
```

### Position Sync (`position.ts:132`)

Runs periodically every `positionSyncIntervalMs`:

```
syncFromServer():
    exchangePosition = adapter.fetchPosition()

    if |exchangePosition.baseSize - localBaseSize| > 0.0001:
        recoverMissedFills()
        overwrite localBaseSize from exchange
        fire onDrift callback

    update lastSyncTime (unconditionally, even if no discrepancy)
```

### Fill Recovery (`position.ts:183`)

```
recoverMissedFills():
    trades = adapter.fetchTrades(since=lastSyncTime)
    newTrades = trades.filter(t => t.tradeId > lastTradeId)

    for each trade in newTrades:
        feePpm = trade.isMaker ? makerFeePpm : takerFeePpm
        fee = trade.baseSize * trade.price * feePpm / 1_000_000
        applyFill(trade.side, trade.baseSize, trade.price)
        lastTradeId = trade.tradeId
```

## 10. Balance Tracking

`BalanceTracker` (`src/bots/mm/balance.ts`)

### Balance Model

```
While position is open:
    Δbalance = realizedPnL - fees
    (funding accrues on position but does NOT touch balance)

On position close:
    Δbalance = closingPnL - closingFee + accumulatedFunding
    (everything settles into balance at once)

equity = balance + unrealizedPnL
```

### Fee Tracking

On each fill (`recordFill`, `balance.ts:112`):
```
fee = size * price * makerFeePpm / 1_000_000
pendingFeeAccumulator += fee
```

### Periodic Sync (`balance.ts:153`)

Every `balanceSyncIntervalMs`:
```
snapshot = adapter.fetchBalanceSnapshot()
    → {balance, fundingPnlByMarket, unrealizedPnlByMarket}

balanceChange = newBalance - previousBalance
fundingDelta  = sum(currentFunding - previousFunding) per market
feesDelta     = pendingFeeAccumulator (reset to 0)

totalFunding    += fundingDelta
totalNetTrading += balanceChange
totalFees       += feesDelta

currentBalance = snapshot.balance
currentUnrealizedPnL = sum(unrealizedPnlByMarket)
```

### Session Summary

```
{
    startingBalance, currentBalance,
    startingEquity, currentEquity,
    totalFunding, totalNetTrading, totalFees,
    netChange = currentBalance - startingBalance,
    equityChange = currentEquity - startingEquity
}
```

## 11. Analytics (Markouts)

`AnalyticsTracker` (`src/bots/mm/analytics.ts`)

### On Fill (`recordFill`, `analytics.ts:38`)

```
record = {
    timestamp: Date.now(),
    side, size, price,
    fairPriceAtFill,
    markouts: {horizon1: null, horizon2: null, ...}
}

for each horizonMs in markoutHorizonsMs:
    setTimeout(observeMarkout, horizonMs)
```

### Markout Observation (`analytics.ts:66`)

```
observeMarkout(fillIndex, horizonMs):
    currentFairPrice = getMarkPrice()

    if side == "bid":
        markoutBps = ((currentFairPrice - fillPrice) / fillPrice) * 10_000
    else:  // "ask"
        markoutBps = ((fillPrice - currentFairPrice) / fillPrice) * 10_000

    record.markouts[horizonMs] = markoutBps
```

Positive markout = price moved favorably after our fill.
Negative markout = adverse selection (we got picked off).

### Summary

```
for each horizon:
    observed = non-null markouts at that horizon
    avgBps = mean(observed)

fillRate = fillCount / quoteUpdateCount
```

### Export

All fills written to JSONL file at shutdown (`writeFillsToFile`).

## 12. Periodic Intervals

| Interval | Period | Action |
|----------|--------|--------|
| Order sync | `orderSyncIntervalMs` | `adapter.syncOrders()` → overwrite `activeOrders` |
| Status log | `statusIntervalMs` | Log position, PnL, T2T latency |
| Position sync | `positionSyncIntervalMs` | Compare local vs exchange, recover missed fills |
| Balance sync | `balanceSyncIntervalMs` | Fetch snapshot, compute deltas |

All intervals fire-and-forget; errors are logged but do not crash the bot.

## 13. Shutdown Sequence

`shutdown()` (`index.ts:362`):

1. Set `isShuttingDown = true`, `isRunning = false`
2. Cancel throttled update function
3. Stop position sync and balance sync loops
4. Clear status and order sync intervals
5. Capture final mark price (try fair price → Binance mid → 0)
6. Cancel all active orders via `adapter.cancelOrders(activeOrders)`. On error: log, continue.
7. Clear `activeOrders = []`
8. Fetch position from exchange, compare to local state, log if mismatch
9. If position non-zero:
   - Calculate close price: `mid ± (mid * closeSlippageBps / 10000)`
   - Submit IOC reduce-only via `adapter.closePosition(baseSize, closePrice)`
   - Verify position flat; log error if not
10. Close Binance feed and exchange adapter
11. Log session summary: duration, fill count, volume, realized PnL, unrealized PnL, net PnL
12. Final balance sync via `adapter.fetchBalanceSnapshot()` — **note: this runs after `adapter.close()`, so it will fail and be caught/logged**
13. Log balance summary: starting/current balance, equity change, funding, fees
14. Log analytics summary: markouts by horizon, fill rate
15. Write fills to JSONL file
16. `process.exit(0)`

## 14. Error Handling

### Error Classification (`index.ts:23`)

| Kind | Condition | Response |
|------|-----------|----------|
| `exchange_rejection` | Exchange rejected operation | Log warn, retry next cycle. `activeOrders` preserved. |
| `http_error` | HTTP transport error | Log error. Exchange state uncertain. |
| `client_error` | Client-side validation error | Log error. Nothing sent to exchange. |
| `network_error` | Network failure | Log error. Await periodic `syncOrders` to reconcile. |

### Invariants

- All exceptions are logged or re-raised — no silent swallows
- Exchange is always source of truth; local state is a cache
- Atomic order updates are all-or-nothing per chunk of 4
- On any error in `executeUpdate`: `activeOrders` preserved (not cleared), periodic sync reconciles
- `cancelOrdersAsync()` preserves `activeOrders` on error; next sync reconciles

### Stream Reconnection

All WebSocket streams track `lastMessageTime`. If gap exceeds `staleThresholdMs`: close and reconnect.

- **Exchange streams** (orderbook, account): first reconnect attempt immediate; subsequent use `reconnectDelayMs` backoff
- **Binance feed**: always waits a hardcoded 3000ms before reconnecting (does not use `reconnectDelayMs`)

## 15. Configuration Reference

All values loaded from `config.toml`. Missing keys cause startup error (no defaults). Per-symbol overrides in `[SYMBOL]` section.

### Strategy Parameters

| TOML Key | Type | Description |
|----------|------|-------------|
| `spread_bps` | number | Spread from fair price in basis points (normal mode) |
| `take_profit_bps` | number | Spread in basis points (close mode) |
| `order_size_usd` | number | Order size per side in USD |
| `close_threshold_usd` | number | Position USD value that triggers close mode |
| `close_slippage_bps` | number | Slippage tolerance for IOC close orders in basis points |
| `warmup_seconds` | number | Minimum price samples before quoting begins |
| `markout_horizons_ms` | number[] | Markout observation windows in milliseconds |

### Operational Parameters

| TOML Key | Type | Description |
|----------|------|-------------|
| `exchange` | string | Exchange identifier (e.g., `"zo"`) |
| `update_throttle_ms` | number | Minimum interval between quote updates |
| `order_sync_interval_ms` | number | Periodic order sync from exchange |
| `status_interval_ms` | number | Status log display interval |
| `fair_price_window_ms` | number | Sliding window for fair price offset samples |
| `position_sync_interval_ms` | number | Periodic position reconciliation |
| `balance_sync_interval_ms` | number | Periodic balance snapshot |
| `stale_threshold_ms` | number | Mark feed stale if no updates for this long |
| `stale_check_interval_ms` | number | How often to check for staleness |
| `reconnect_delay_ms` | number | Base delay for WebSocket reconnect backoff |
| `max_book_levels` | number | Max orderbook depth per side |

## 16. Data Types

```typescript
// Core types (src/types.ts)

interface FillEvent {
    orderId: string;
    side: "bid" | "ask";
    size: number;         // Fill size (base units)
    price: number;        // Fill price
    remaining: number;    // Remaining order size after this fill (0 = fully filled)
    marketId: number;
}

interface MidPrice {
    mid: number;
    bid: number;
    ask: number;
    timestamp: number;       // Date.now() ms
    tickTimestamp?: number;   // performance.now() for T2T measurement
}

interface CachedOrder {
    orderId: string;
    side: "bid" | "ask";
    price: Decimal;
    size: Decimal;
}

interface Quote {
    side: "bid" | "ask";
    price: Decimal;
    size: Decimal;
}

interface BBO {
    bestBid: number;
    bestAsk: number;
}

// Adapter types (src/exchanges/adapter.ts)

interface MarketInfo {
    symbol: string;
    priceDecimals: number;
    sizeDecimals: number;
    quoteDecimals: number;
    minOrderNotionalUsd: number;
}

interface BalanceSnapshot {
    balance: number;
    fundingPnlByMarket: Map<number, number>;
    unrealizedPnlByMarket: Map<number, number>;
}

interface TradeRecord {
    tradeId: number;
    side: "bid" | "ask";
    baseSize: number;
    price: number;
    isMaker: boolean;
}

interface FeeRateInfo {
    feeTierId: number;
    makerFeePpm: number;
    takerFeePpm: number;
}
```

## 17. ExchangeAdapter Interface

```typescript
interface ExchangeAdapter {
    readonly name: string;

    // Lifecycle
    connect(): Promise<MarketInfo>;
    close(): Promise<void>;

    // Data feeds (adapter fires these callbacks)
    onFill: FillCallback | null;
    onPrice: PriceCallback | null;
    onOrderbookUpdate: OrderbookUpdateCallback | null;
    onTrade: PublicTradeCallback | null;

    // Orders
    syncOrders(): Promise<CachedOrder[]>;
    updateQuotes(cancels: CachedOrder[], places: Quote[]): Promise<CachedOrder[]>;
    cancelOrders(orders: CachedOrder[]): Promise<void>;
    closePosition(baseSize: number, price: string): Promise<void>;

    // Position & Trades
    fetchPosition(): Promise<{baseSize: number}>;
    fetchTrades(since: string): Promise<TradeRecord[]>;

    // Balance
    fetchBalanceSnapshot(): Promise<BalanceSnapshot>;
    fetchFeeRates(): Promise<FeeRateInfo>;

    // Synchronous cached state
    getMidPrice(): MidPrice | null;
    getBBO(): BBO | null;
}
```
