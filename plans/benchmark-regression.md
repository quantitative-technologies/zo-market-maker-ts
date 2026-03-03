# Benchmark Performance Regression Testing

## Context

The project has zero testing infrastructure. Before making changes (logger swap, risk management, strategy improvements), we need a way to measure whether performance regressed. Vitest bench provides microbenchmarks with ops/sec metrics. This should be the first thing implemented so all subsequent roadmap changes can be regression-tested.

## Files to Create

- **`vitest.config.ts`** — minimal config, points at `bench/**/*.bench.ts`
- **`bench/logger.bench.ts`** — logger throughput (info, quote, fill, position, debug-filtered). Use `log.setOutput(() => {})` to isolate formatting from I/O
- **`bench/fair-price.bench.ts`** — `FairPriceCalculator` (`src/pricing/fair-price.ts`) with pre-filled 300-sample buffer: `getFairPrice()`, `getMedianOffset()`, `addSample()`
- **`bench/quoter.bench.ts`** — `Quoter.getQuotes()` (`src/bots/mm/quoter.ts`) with Decimal arithmetic: normal mode, close mode, no-BBO
- **`bench/orders.bench.ts`** — replicate unexported `orderMatchesQuote` from `src/sdk/orders.ts`, benchmark Decimal.eq comparisons and order diffing

## Files to Modify

- **`package.json`** — add `vitest` devDep, add `"bench"` and `"bench:run"` scripts
- **`Makefile`** — add `bench` target

## Verification

- `npm run bench:run` prints ops/sec table
- `make bench` works
- `npm run build` unaffected (bench files outside `src/`)
