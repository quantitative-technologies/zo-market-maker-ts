# Fix: Shutdown session summary shows unrealized PnL after position close

## Problem

Session summary incorrectly shows unrealized PnL even though the position was closed:
1. Stale position size — missed in-flight WebSocket fills when reading `baseSize`
2. Fabricated fill price — manual `applyFill` uses limit price (with 50bps slippage), not actual fill
3. No verification that close order succeeded (CLAUDE.md requires this)

## Done

- `reconcileWithExchange()` added to `PositionTracker` in `position.ts` (commit `054630a`)
  - Public method delegating to private `syncFromServer` (REST `fetchInfo` + `getTrades()`)

## TODO — rewrite close-position block in `src/bots/mm/index.ts` shutdown()

Current uncommitted changes in `index.ts` are intermediate state — replace with:

1. After `accountStream.close()`, call `positionTracker.reconcileWithExchange(user)` to get true position (captures any missed WS fills)
2. Read `baseSize` from tracker (now reflects exchange truth)
3. Send close order via `closePosition()`
4. Call `positionTracker.reconcileWithExchange(user)` again to capture actual close fill price via `getTrades()`
5. Verify position is flat; log error if not
6. **Remove** the manual `applyFill(closeSide, ...)` call entirely
7. Extract `1e-10` magic number to a named constant (CLAUDE.md: no magic numbers)

## Expected log output after fix

```
Position sync: ...        <- reconcile before close
SHUTDOWN: closing position ...
Position sync: ...        <- reconcile after close (captures real fill price)
SHUTDOWN: position closed and verified flat
Session Summary: ...      <- realized PnL for close trade, not unrealized
```
