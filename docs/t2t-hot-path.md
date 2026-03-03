# Tick-to-Trade Hot Path

The T2T latency measures the time from Binance WebSocket tick receipt to order
submission on 01 Exchange. This table maps each step to its benchmark coverage.

## Hot Path Steps

| Step | Function | Benchmarked? |
|------|----------|--------------|
| 1. Binance tick → callback | `handleBinancePrice` throttle check | Yes (e2e) |
| 2. Add price sample | `FairPriceCalculator.addSample()` | Yes |
| 3. Compute fair price | `FairPriceCalculator.getFairPrice()` | Yes |
| 4. Build quoting context | `PositionTracker.getQuotingContext()` | Yes (e2e) |
| 5. Compute quotes | `Quoter.getQuotes()` | Yes |
| 6. Log quote | `log.quote()` | Yes |
| 7. Diff orders vs quotes | `orderMatchesQuote` loop | Yes |
| 8. Build atomic actions | `buildPlaceAction` / `buildCancelAction` | Yes (e2e) |
| 9. Send to exchange | `executeAtomic` → `user.atomic()` | No (network I/O) |

## Benchmark Files

- `bench/logger.bench.ts` — Steps 6 (plus other logger methods)
- `bench/fair-price.bench.ts` — Steps 2, 3
- `bench/quoter.bench.ts` — Step 5
- `bench/orders.bench.ts` — Step 7
- `bench/hot-path.bench.ts` — Steps 1-8 chained end-to-end (info + debug level variants)

## Notes

- Steps 2-3, 5-7 have dedicated component benchmarks.
- Steps 1-8 are covered end-to-end by `hot-path.bench.ts`.
- Step 9 is network I/O and cannot be benchmarked offline.
- T2T is only measured when `updateQuotes` returns new orders (quotes differ from current orders).
- In production, T2T includes the throttle delay (~100ms default) which dominates; pure processing is sub-ms.
