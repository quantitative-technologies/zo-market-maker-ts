# TODO: Migrate position sizes to Decimal

## Problem

Position sizes use `number` (IEEE 754 float), which causes accumulation errors:
- Three fills of `0.00014` produces `0.00041999999999999996` instead of `0.00042`
- This caused a dust position on shutdown close (exchange partially filled the imprecise size)
- Zero-comparison uses `1e-10` epsilon as a workaround — a guesstimate, not exact

## Affected locations

- `src/bots/mm/position.ts` — `baseSize` accumulation, `applyFill()`, zero check (`< 1e-10`)
- `src/sdk/orders.ts` — `closePosition()` zero check (`< 1e-10`), size passed as `Math.abs(baseSize).toString()`
- `src/bots/mm/index.ts` — shutdown reads `getBaseSize()` and passes to `closePosition()`

## Fix

Use `Decimal` (already in codebase via `decimal.js`, used in `Quoter`) for position size accumulation.
This eliminates the need for epsilon comparison entirely — `Decimal.isZero()` is exact.

The `Quoter` already uses `Decimal` with `alignSize()` for order placement. Position tracking should match.
