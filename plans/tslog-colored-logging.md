# tslog Colored Logging

## Context

The custom logger (`src/utils/logger.ts`) outputs plain uncolored text. Goal: colored, human-readable output like Python's loguru (colored levels, timestamps). Preserve exact public API — zero consumer file changes.

## Approach: Dual Output Path

- **Terminal mode** (default): tslog `type: "pretty"` for ANSI-colored output
- **TUI mode** (when `setOutput()` called): bypass tslog, use plain string formatting (same as current). Blessed TUI widget doesn't render ANSI codes

## tslog Config

`hideLogPositionForProduction: true` (no stack trace capture by default — perf). `stylePrettyLogs: true`. `prettyLogTimeZone: "UTC"`.

## Files to Modify

- **`src/utils/logger.ts`** — complete rewrite, same `export const log` with same API
- **`package.json`** — add `tslog` to dependencies

## No Other Files Change

All 10 consumer files (`src/cli/bot.ts`, `src/cli/monitor.ts`, `src/bots/mm/index.ts`, `config.ts`, `position.ts`, `src/pricing/binance.ts`, `src/sdk/client.ts`, `orderbook.ts`, `account.ts`, `orders.ts`) keep their `import { log }` unchanged.

## Behavioral Note

Domain methods (`quote`, `fill`, `position`) currently bypass `shouldLog()`. New version routes through `this.info()`, so they now respect level filtering. This is correct behavior.

## Verification

1. `npm run bot -- BTC` — colored log levels (green INFO, yellow WARN, red ERROR)
2. `npm run monitor -- BTC` — TUI log panel shows plain text, no ANSI artifacts
3. `LOG_LEVEL=error` filters correctly
4. `npm run build` succeeds
5. `make bench` before/after to compare ops/sec (requires benchmark-regression first)
