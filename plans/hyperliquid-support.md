# Hyperliquid Exchange Support

## Context

The market maker is tightly coupled to 01 Exchange (Zo Protocol) via the `@n1xyz/nord-ts` SDK. All exchange interactions flow through 4 SDK modules in `src/sdk/`. The trading logic (fair price, position tracking, quoting) is already well-separated and exchange-agnostic. The goal is to support Hyperliquid as an alternative exchange, selectable via `exchange = "hyperliquid"` in `config.toml`.

**Scope**: ~500-700 lines of new code (Hyperliquid adapter + helpers), ~100 lines of refactoring (MarketMaker + PositionTracker to use adapter interface).

## Approach: Adapter Pattern

Define an `ExchangeAdapter` interface consumed by `MarketMaker`. Two implementations: `ZoAdapter` (wraps existing `src/sdk/*` unchanged) and `HyperliquidAdapter` (new code). This avoids modifying any existing Zo-specific code — the adapter is a thin composition layer.

**SDK choice for Hyperliquid**: Raw `fetch` + `ws` (no third-party SDK). The API is simple (3 endpoints), and we already use raw WebSockets for Binance. Use `viem` for EIP-712 signing only.

## Implementation Steps

### Step 1: Move shared types to `src/types.ts`

Move types out of SDK-specific modules so both adapters can share them:
- `BBO` from `src/sdk/orderbook.ts:13-16`
- `FillEvent` from `src/sdk/account.ts:16-23`
- `CachedOrder` from `src/sdk/orders.ts:16-21`

Update imports in `src/sdk/orderbook.ts`, `src/sdk/account.ts`, `src/sdk/orders.ts`, `src/bots/mm/index.ts`, `src/bots/mm/quoter.ts`.

### Step 2: Define `ExchangeAdapter` interface

**New file**: `src/exchange/adapter.ts`

```typescript
interface ExchangeAdapter {
  readonly exchangeName: string;
  connect(symbol: string): Promise<MarketInfo>;
  close(): void;

  // Account/fills
  subscribeAccount(onFill: FillCallback): void;
  syncOrders(): Promise<CachedOrder[]>;

  // Orderbook
  subscribeOrderbook(onPrice: PriceCallback): Promise<void>;
  getMidPrice(): MidPrice | null;
  getBBO(): BBO | null;

  // Orders
  updateQuotes(current: CachedOrder[], quotes: Quote[]): Promise<CachedOrder[]>;
  cancelOrders(orders: CachedOrder[]): Promise<void>;
  closePosition(baseSize: number, price: string): Promise<void>;

  // Position
  fetchPosition(): Promise<{ baseSize: number }>;
}
```

### Step 3: Create `ZoAdapter`

**New file**: `src/exchange/zo-adapter.ts`

Thin wrapper composing existing `src/sdk/client.ts`, `src/sdk/account.ts`, `src/sdk/orderbook.ts`, `src/sdk/orders.ts`. No changes to the underlying SDK files. Each adapter method delegates to the corresponding SDK function.

### Step 4: Refactor `PositionTracker` to remove `NordUser` dependency

**Modify**: `src/bots/mm/position.ts`

Change `startSync(user: NordUser, accountId: number, marketId: number)` to `startSync(fetchPosition: () => Promise<{ baseSize: number }>)`. The `syncFromServer` method calls this callback instead of `user.fetchInfo()` + `user.positions[accountId]`.

### Step 5: Refactor `MarketMaker` to use `ExchangeAdapter`

**Modify**: `src/bots/mm/index.ts`

- Constructor: `(config, privateKey)` → `(config, adapter: ExchangeAdapter)`
- `initialize()`: Replace `createZoClient()` + market lookup with `adapter.connect(symbol)`
- `setupEventHandlers()`: Replace `AccountStream`/`ZoOrderbookStream` direct usage with `adapter.subscribeAccount()`, `adapter.subscribeOrderbook()`
- `executeUpdate()`: Replace `updateQuotes(client.user, ...)` with `adapter.updateQuotes(...)`
- `shutdown()`: Replace `cancelOrders(client.user, ...)` with `adapter.cancelOrders(...)`
- `syncInitialOrders()` / `syncOrders()`: Replace `user.fetchInfo()` + `user.orders[accountId]` with `adapter.syncOrders()`
- `positionTracker.startSync()`: Pass `() => adapter.fetchPosition()`
- Remove all `@n1xyz/nord-ts` imports

### Step 6: Add `exchange` to config

**Modify**: `src/bots/mm/config.ts`

Add `exchange: "zo" | "hyperliquid"` field (default: `"zo"`). Add `exchange` to TOML key map (string, not numeric — needs a small tweak to `extractOverrides` or handle separately).

### Step 7: Create adapter factory + update CLI

**New file**: `src/exchange/factory.ts`

```typescript
function createAdapter(exchange: "zo" | "hyperliquid", privateKey: string): ExchangeAdapter
```

**Modify**: `src/cli/bot.ts` — Use factory to create adapter, pass to `MarketMaker`.

### Step 8: Implement `HyperliquidAdapter`

**New files**:
- `src/exchange/hyperliquid/adapter.ts` — Main adapter implementing `ExchangeAdapter`
- `src/exchange/hyperliquid/api.ts` — Raw HTTP client for `/info` and `/exchange` endpoints
- `src/exchange/hyperliquid/signing.ts` — EIP-712 typed data signing via `viem`
- `src/exchange/hyperliquid/types.ts` — Hyperliquid API response types

Key Hyperliquid API mappings:

| Operation | Hyperliquid API |
|-----------|----------------|
| Connect + metadata | `POST /info` `{"type":"meta"}` → universe array (asset index, szDecimals) |
| Orderbook WS | `wss://api.hyperliquid.xyz/ws` subscribe `{"type":"l2Book","coin":"BTC"}` |
| Place orders | `POST /exchange` action `{"type":"order","orders":[...],"grouping":"na"}` |
| Cancel orders | `POST /exchange` action `{"type":"cancel","cancels":[{"a":idx,"o":oid}]}` |
| Fetch position | `POST /info` `{"type":"clearinghouseState","user":"0x..."}` |
| Fetch orders | `POST /info` `{"type":"openOrders","user":"0x..."}` |
| Account fills WS | Subscribe `{"type":"userFills","user":"0x..."}` |

Key differences handled inside adapter:
- Symbol: `"BTC"` not `"BTC-PERP"` (adapter strips `-PERP` or uses coin name directly)
- Order IDs: numeric `oid` → converted to string
- Auth: Ethereum private key (hex) + EIP-712 signature + nonce (ms timestamp)
- PostOnly: `{"limit":{"tif":"Alo"}}`, IOC: `{"limit":{"tif":"Ioc"}}`
- Orderbook: Full L2 snapshots on each WS message (simpler than Zo's delta model)
- Batching: `orders` array supports multiple orders per POST, `cancels` array supports multiple cancels per POST, but cancel+place can't be combined in one request (unlike Zo's `atomic()`). The adapter sends cancel request first, then place request sequentially.

### Step 9: Add `viem` dependency

```bash
npm install viem
```

### Step 10 (optional, follow-up): Update monitor TUI

`src/cli/monitor.ts` also directly uses `Nord` SDK. Lower priority — can be updated to use the adapter pattern in a subsequent PR.

## Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `BBO`, `FillEvent`, `CachedOrder` types |
| `src/sdk/orderbook.ts` | Re-export `BBO` from types (or update imports) |
| `src/sdk/account.ts` | Re-export `FillEvent` from types (or update imports) |
| `src/sdk/orders.ts` | Re-export `CachedOrder` from types (or update imports) |
| `src/bots/mm/index.ts` | Use `ExchangeAdapter` instead of direct SDK |
| `src/bots/mm/position.ts` | Replace `NordUser` param with fetch callback |
| `src/bots/mm/config.ts` | Add `exchange` field |
| `src/cli/bot.ts` | Use adapter factory |
| `config.toml` | Add `exchange = "zo"` |

## New Files

| File | Purpose |
|------|---------|
| `src/exchange/adapter.ts` | `ExchangeAdapter` interface |
| `src/exchange/factory.ts` | `createAdapter()` factory |
| `src/exchange/zo-adapter.ts` | Wraps existing `src/sdk/*` |
| `src/exchange/hyperliquid/adapter.ts` | Hyperliquid adapter |
| `src/exchange/hyperliquid/api.ts` | HTTP/WS client |
| `src/exchange/hyperliquid/signing.ts` | EIP-712 signing |
| `src/exchange/hyperliquid/types.ts` | API response types |

## Verification

1. **Zo regression**: After steps 1-7, run existing bot with `exchange = "zo"` — behavior should be identical
2. **Hyperliquid testnet**: After step 8, test with `HYPERLIQUID_TESTNET=true` and Hyperliquid testnet key
   - Verify orderbook subscription and mid price calculation
   - Verify order placement (PostOnly) and cancellation
   - Verify position fetch and fill detection
   - Verify shutdown gracefully closes position
3. **Config**: Verify `exchange = "hyperliquid"` in TOML selects the correct adapter
