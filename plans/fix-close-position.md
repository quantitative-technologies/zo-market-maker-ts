# Fix: closePosition sends unrounded size and doesn't verify fill

## Context

On shutdown, BTC and HYPE positions were not closed despite logs showing "SHUTDOWN: position closed". Root cause confirmed from logs:

- BTC sent size `0.00043999999999999996` instead of `0.00044`
- HYPE sent size `0.30999999999999966` instead of `0.31`

The floating point noise comes from `positionTracker.getBaseSize()` returning raw floats. In normal operation, the `Quoter` rounds sizes via `alignSize()` (`src/bots/mm/quoter.ts:105-108`), but `closePosition` bypasses the Quoter and calls `.toString()` on the raw float.

Additionally, `closePosition` ignores the `AtomicResult` return value — it doesn't check the `fills` array to verify the IOC order actually filled. The SDK's `Receipt_PlaceOrderResult` contains `posted?: Posted` and `fills: Trade[]`, but `extractPlacedOrders` only looks at `posted?.orderId`.

## Files to Modify

### `src/sdk/orders.ts`

1. **`closePosition()`**: Add `sizeDecimals` parameter, round size with `.toFixed(sizeDecimals)` instead of `.toString()`. Check `fills` array from the result and warn if empty (position not actually closed).

2. **`executeAtomic()`**: Improve result logging:
   - **INFO**: Log outcome summary comparing placed vs requested: `ATOMIC: 2/2 placed` or `ATOMIC: 1/2 placed`
   - **WARN**: Log when place actions don't all succeed: `ATOMIC: 1/2 placed (1 rejected)`
   - **DEBUG**: Keep order IDs at debug level: `ATOMIC: ids [1821262083, 1838175728]`
   - **DEBUG**: Log raw `AtomicResult` for full exchange response visibility

### `src/bots/mm/index.ts`

1. **Shutdown `closePosition` call**: Pass `this.sizeDecimals` as the new parameter.

### `src/bots/mm/config.ts`

1. **Add `shutdown_slippage_bps`** to config — the current hardcoded `0.005` (50bps) is a magic number. Move to config with a reasonable default (e.g., 50bps). Per CLAUDE.md: no magic numbers.

## Verification

1. Build: `npm run build`
2. Start bots, let them open positions, then `make stop`
3. Check logs for:
   - Rounded sizes in CLOSE POSITION lines
   - INFO-level outcome summary for atomic operations
   - WARN if any place actions were rejected
   - Fill verification (warning if fills empty on close)
