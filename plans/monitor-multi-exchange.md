# Plan: Add Orderbook Depth & Trade Streams to ExchangeAdapter + Refactor Monitor

## Context

The market monitor (`src/cli/monitor.ts`) is hardcoded to Zo exchange. With Hyperliquid support added, the monitor needs to work with any exchange. Additionally, future trading strategies will need orderbook depth and public trade data, which the `ExchangeAdapter` interface currently doesn't expose.

## Approach

1. Add `onOrderbookUpdate` and `onTrade` callbacks to `ExchangeAdapter`
2. Create a lightweight `MonitorFeed` interface (no auth required) with per-exchange implementations
3. Refactor the monitor to use `MonitorFeed` + accept exchange as CLI arg

The `MonitorFeed` is separate from `ExchangeAdapter` because the monitor is read-only and shouldn't require private keys. The full `ExchangeAdapter` also gets the new callbacks for future bot use.

## Implementation Steps

### Step 1: Add shared types (`src/types.ts`)

Move `OrderbookUpdateCallback` from `src/sdk/orderbook.ts` to `src/types.ts`. Add:
```typescript
export interface PublicTrade {
    time: number;
    side: "buy" | "sell";
    price: number;
    size: number;
}
export type PublicTradeCallback = (trades: PublicTrade[]) => void;
```

Re-export `OrderbookUpdateCallback` from `src/sdk/orderbook.ts` for backward compatibility.

### Step 2: Extend `ExchangeAdapter` (`src/exchanges/adapter.ts`)

Add to interface:
```typescript
onOrderbookUpdate: OrderbookUpdateCallback | null;
onTrade: PublicTradeCallback | null;
```

### Step 3: Add depth callback to Hyperliquid orderbook (`src/exchanges/hyperliquid/orderbook.ts`)

- Add `getLevels(): Map<number, number>` to `OrderbookSide`
- Add `onOrderbookUpdate` callback property to `HyperliquidOrderbookStream`
- Emit in `emitPrice()` after price callback

### Step 4: Create Hyperliquid trade stream (`src/exchanges/hyperliquid/trades.ts` — new file)

Follows `HyperliquidAccountStream` pattern. Subscribes to `{ type: "trades", coin }` on `wss://api.hyperliquid.xyz/ws`. Maps `side: "A"` → `"buy"` (taker bought at ask), `"B"` → `"sell"`. Add WS types to `src/exchanges/hyperliquid/types.ts`.

### Step 5: Wire callbacks in adapters

**ZoAdapter** (`src/exchanges/zo/adapter.ts`):
- Forward `orderbookStream.onOrderbookUpdate` → `this.onOrderbookUpdate`
- Add `nord.subscribeTrades()` subscription, map to `PublicTrade[]`, forward to `this.onTrade`

**HyperliquidAdapter** (`src/exchanges/hyperliquid/adapter.ts`):
- Forward `orderbookStream.onOrderbookUpdate` → `this.onOrderbookUpdate`
- Create `HyperliquidTradeStream`, forward `onTrade`
- Clean up trade stream in `close()`

### Step 6: Create `MonitorFeed` interface (`src/exchanges/monitor-feed.ts` — new file)

```typescript
export interface MonitorFeed {
    readonly name: string;
    connect(): Promise<MarketInfo>;
    close(): void;
    onPrice: PriceCallback | null;
    onOrderbookUpdate: OrderbookUpdateCallback | null;
    onTrade: PublicTradeCallback | null;
    getMidPrice(): MidPrice | null;
    getBBO(): BBO | null;
}
```

Factory: `createMonitorFeed(options)` returns exchange-specific implementation.

### Step 7: Per-exchange MonitorFeed implementations

**`src/exchanges/zo/monitor-feed.ts`** (new): Creates `Nord.new()` (no wallet), `ZoOrderbookStream`, trade subscription. Returns `MarketInfo` from `nord.markets`.

**`src/exchanges/hyperliquid/monitor-feed.ts`** (new): Creates `HyperliquidOrderbookStream`, `HyperliquidTradeStream`. Calls `getMeta()` REST endpoint for `MarketInfo`.

### Step 8: Refactor monitor (`src/cli/monitor.ts`)

- Remove direct `Nord`, `Connection`, `@solana/web3.js` imports
- CLI args: `npm run monitor -- <exchange> <symbol>` (e.g. `npm run monitor -- zo BTC`)
- Default exchange to `zo` if only symbol provided (backward compatible)
- Create `MonitorFeed` via factory
- Wire `feed.onPrice`, `feed.onOrderbookUpdate`, `feed.onTrade` callbacks
- Header: use `feed.name` instead of hardcoded "ZO"
- All constants remain as named constants in the module (approved: display-only script)
- No config.toml dependency

### Step 9: Makefile targets

- `make monitor-%` stays as-is (defaults to Zo): `npm run monitor -- $*`
- Add `make monitor-hl-%` for Hyperliquid: `npm run monitor -- hyperliquid $*`

## Files Changed

| File | Action |
|------|--------|
| `src/types.ts` | Modify — add `OrderbookUpdateCallback`, `PublicTrade`, `PublicTradeCallback` |
| `src/sdk/orderbook.ts` | Modify — re-export `OrderbookUpdateCallback` from types |
| `src/exchanges/adapter.ts` | Modify — add 2 callbacks to interface |
| `src/exchanges/hyperliquid/orderbook.ts` | Modify — add `getLevels()`, `onOrderbookUpdate` |
| `src/exchanges/hyperliquid/types.ts` | Modify — add trade WS message types |
| `src/exchanges/hyperliquid/trades.ts` | **New** — trade stream |
| `src/exchanges/hyperliquid/adapter.ts` | Modify — wire new callbacks |
| `src/exchanges/hyperliquid/monitor-feed.ts` | **New** — HL monitor feed |
| `src/exchanges/zo/adapter.ts` | Modify — wire new callbacks |
| `src/exchanges/zo/monitor-feed.ts` | **New** — Zo monitor feed |
| `src/exchanges/monitor-feed.ts` | **New** — interface + factory |
| `src/cli/monitor.ts` | Modify — refactor to use MonitorFeed, CLI args |
| `Makefile` | Modify — add `monitor-hl-%` target |

## Verification

1. `npx tsc --noEmit` — type check passes
2. `make start-btc` — bot still works, no regressions
3. `make monitor-btc` — Zo monitor shows orderbook + trades
4. `make monitor-hl-btc` — Hyperliquid monitor shows orderbook + trades
