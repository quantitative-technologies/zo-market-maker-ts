# Plan: Enforce minimum order notional and fix lot-size rounding

## Context

Hyperliquid rejects orders below $10 notional value. The bot's `order_size_usd = 10` config results in orders slightly below $10 because the quoter's `alignSize` uses `floor()` to snap to lot boundaries, losing up to one lot of value (e.g. BTC: `$10 / $69900 = 14.3 lots → floor → 14 lots → $9.79`).

The $10 minimum is a fixed Hyperliquid platform rule, not exposed via API. Combined with per-asset `szDecimals` (lot size), this determines the effective minimum order size.

## Implementation Steps

### Step 1: Add `minOrderNotionalUsd` to `MarketInfo` (`src/types.ts`)

Already added in this session: `minOrderNotionalUsd: number` field on `MarketInfo`.

### Step 2: Return `minOrderNotionalUsd` from adapters

**`src/exchanges/hyperliquid/adapter.ts`**:
- Add named constant: `const MIN_ORDER_NOTIONAL_USD = 10;` (Hyperliquid fixed platform rule)
- Include in `connect()` return: `minOrderNotionalUsd: MIN_ORDER_NOTIONAL_USD`

**`src/exchanges/zo/adapter.ts`**:
- Set to `0` (no minimum enforced / negligible).
- Include in `connect()` return.

**Monitor feeds** (`src/exchanges/zo/monitor-feed.ts`, `src/exchanges/hyperliquid/monitor-feed.ts`):
- Set `minOrderNotionalUsd: 0` — monitors don't place orders, value is irrelevant.

### Step 3: Validate config at startup (`src/bots/mm/index.ts`)

After `const marketInfo = await this.adapter.connect()`, validate:
```typescript
if (this.config.orderSizeUsd < marketInfo.minOrderNotionalUsd) {
    throw new Error(
        `order_size_usd (${this.config.orderSizeUsd}) is below exchange minimum ($${marketInfo.minOrderNotionalUsd})`
    );
}
```
This catches misconfiguration before the bot starts trading.

### Step 4: Use `ceil()` for USD→size conversion (`src/bots/mm/quoter.ts`)

Modify `usdToSize` to use `ceil()` instead of `floor()`:

```typescript
private usdToSize(usd: number, fairPrice: Decimal): Decimal {
    const rawSize = new Decimal(usd).div(fairPrice);
    const lots = rawSize.div(this.lotSize).ceil();
    return lots.mul(this.lotSize);
}
```

Keep `alignSize` (used by close mode) as `floor()` — overshooting position size when closing is wrong. Reduce-only orders that exactly close a position are exempt from the $10 minimum (per Hyperliquid docs).

### Step 5: Verify

1. `npx tsc --noEmit` — type check passes
2. `npx vitest run test/hyperliquid/` — all tests pass
3. `make start-btc` — bot places orders without "$10 minimum" errors

## Files Changed

| File | Action |
|------|--------|
| `src/types.ts` | Already modified — `minOrderNotionalUsd` added |
| `src/exchanges/hyperliquid/adapter.ts` | Add `MIN_ORDER_NOTIONAL_USD` constant, return in `MarketInfo` |
| `src/exchanges/zo/adapter.ts` | Return `minOrderNotionalUsd: 0` in `MarketInfo` |
| `src/exchanges/zo/monitor-feed.ts` | Return `minOrderNotionalUsd: 0` in `MarketInfo` |
| `src/exchanges/hyperliquid/monitor-feed.ts` | Return `minOrderNotionalUsd: 0` in `MarketInfo` |
| `src/bots/mm/index.ts` | Add startup validation |
| `src/bots/mm/quoter.ts` | Change `usdToSize` to use `ceil()` |
