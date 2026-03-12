# Plan: Fix Hyperliquid Duplicate Orders & Wasted Requests

## Context

The Hyperliquid market maker hit rate limits: "Too many cumulative requests sent (165960 > 163553) for cumulative volume traded $153554.48". Hyperliquid's rate limit is cumulative (lifetime, no reset) — ~1 request per $1 traded across all interfaces (API + web UI).

**Root cause chain:**
1. Orders are being canceled on the exchange without the bot's knowledge (cause unknown — could be margin, self-trade prevention, or exchange-internal)
2. The bot subscribes to `orderUpdates` WS channel but **does not process it** — so exchange-initiated cancellations are invisible
3. Next update cycle: `batchModify` tries to modify dead orders → fails with "Cannot modify canceled or filled order"
4. Failed orders are dropped from `activeOrders` but the old surviving orders from earlier cycles remain on the exchange
5. Next cycle: `diffOrders([], newQuotes)` → places fresh orders → now **duplicate orders exist** on the exchange (old + new)
6. `syncOrders` picks up all duplicates → `activeOrders` has 4 orders → `diffOrders` generates cancels for extras → more requests burned
7. This churn cycle wastes requests: each failed modify, extra cancel, and extra place counts against the cumulative rate limit

**Broken state:** A partial edit left `this.logOrderUpdates()` called in `account.ts:83` but the method doesn't exist — this will crash on any `orderUpdates` WS message.

**Out of scope:** Rate limit budget management (separate reserve-actions script). Config tuning for update frequency and spread (user-managed).

## Fixes

### Fix 1: Process `orderUpdates` to detect exchange-initiated cancellations

**File:** `src/exchanges/hyperliquid/account.ts`

- Add an `onOrderCanceled` callback (similar to `onFill`)
- Replace the broken `logOrderUpdates()` call with `handleOrderUpdates()`
- For each update where `status` is not `"open"` or `"filled"` (i.e. `"canceled"`, `"marginCanceled"`, `"rejected"`): emit the canceled order ID via callback
- Filter by `this.coin` (same as fills)
- Log all non-"open" status changes at DEBUG level for visibility into why orders disappear

**File:** `src/exchanges/hyperliquid/adapter.ts`

- Wire `accountStream.onOrderCanceled` in `connect()`
- Forward to adapter-level `onOrderCanceled` callback

**File:** `src/exchanges/adapter.ts` (ExchangeAdapter interface)

- Add optional `onOrderCanceled: ((orderId: string) => void) | null` callback

**File:** `src/bots/mm/index.ts`

- In `setupEventHandlers()`: register `adapter.onOrderCanceled` handler
- Handler removes the canceled order from `activeOrders`
- This prevents the next `executeUpdate()` from trying to modify a dead order

### Fix 2: Handle batchModify partial failures with fallback to place

**File:** `src/exchanges/hyperliquid/adapter.ts` — `updateQuotes()`

When batchModify returns `status.error` for an order:
- The old order is already gone on the exchange (that's why the modify failed)
- Collect failed placements into a `fallbackPlaces` array
- After the batchModify loop, push them into `unpairedPlaces`
- They get placed as fresh orders in the existing step 3
- This prevents the order from silently disappearing from both `activeOrders` and the exchange

## Files Modified

| File | Change |
|------|--------|
| `src/exchanges/hyperliquid/account.ts` | Replace broken `logOrderUpdates` with `handleOrderUpdates`, add `onOrderCanceled` callback |
| `src/exchanges/hyperliquid/adapter.ts` | Wire `onOrderCanceled`, add batchModify fallback-to-place |
| `src/exchanges/adapter.ts` | Add optional `onOrderCanceled` to ExchangeAdapter interface |
| `src/bots/mm/index.ts` | Register `onOrderCanceled` handler to remove from `activeOrders` |

## Verification

1. `npx tsc --noEmit` — type check passes
2. Deploy with `make start-btc` (with adjusted config: higher throttle, tighter spread)
3. Monitor logs for:
   - No crash from `logOrderUpdates`
   - DEBUG lines showing order cancellation reasons (visibility into exchange-initiated cancels)
   - batchModify fallback placements working (warn + successful place in same cycle)
   - No duplicate orders in STATUS lines (should never see more than 1 bid + 1 ask)
   - Reduced request waste over extended operation
