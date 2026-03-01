# zo-market-maker-ts — Improvement Roadmap

## Current State

Functional market maker for 01 Exchange (Solana) supporting BTC and ETH perps.
Uses Binance Futures as reference price, calculates fair price via median offset,
and places two-sided PostOnly orders with automatic close mode when position exceeds threshold.

**Working features:** order placement/cancellation, position tracking, fair price calc,
close mode risk management, Binance + 01 orderbook WebSocket feeds with stale detection
and reconnection, account/fill monitoring, Docker deployment, monitor TUI, structured logging.

---

## Phase 1: Observability & Logging

### 1.1 Fill & PnL Logging
- Log explicit FILL events with price, size, side, and timestamp
- Track realized PnL per fill (entry price vs exit price)
- Log cumulative session PnL on each fill and periodically
- Log unrealized PnL based on current fair price vs position entry

### 1.2 Metrics & Reporting
- Track fill count, volume, and average spread captured
- Session summary on shutdown (total fills, net PnL, uptime)
- Optional: export metrics to file or stdout in structured format

### 1.3 Tick-to-Trade Latency
- Capture `performance.now()` on Binance tick receipt (`src/pricing/binance.ts`)
- Thread timestamp through `MidPrice` → `handleBinancePrice` → `executeUpdate`
- Measure T2T after `updateQuotes` returns in `executeUpdate`
- Track rolling stats (last, avg over ~100 samples)
- Append to STATUS log line: `t2t=Xms avg=Xms`
- Files: `src/types.ts`, `src/pricing/binance.ts`, `src/bots/mm/index.ts`
- Note: T2T includes throttle delay (~100ms default) which dominates; pure processing is sub-ms

---

## Phase 2: Configuration & Deployment

### 2.1 Runtime Configuration
- Accept config overrides via CLI flags or environment variables
  (spreadBps, orderSizeUsd, closeThresholdUsd, etc.)
- Per-symbol config support (different params for BTC vs ETH)

### 2.2 Multi-Symbol Docker Compose
- Extend docker-compose.yml with services for each symbol
- Shared .env with per-symbol overrides (e.g., SPREAD_BPS_BTC=4)

---

## Phase 3: Risk Management

### 3.1 Loss Limits
- Max drawdown limit — stop quoting if session loss exceeds threshold
- Max position size limit — hard cap beyond close mode threshold
- Cooldown period after consecutive losses

### 3.2 Inventory Management
- Skew quotes based on inventory (widen on side with exposure)
- Gradual position reduction instead of binary close mode

---

## Phase 4: Strategy Improvements

### 4.1 Dynamic Spread
- Adjust spread based on volatility (wider in volatile markets)
- Tighten spread when orderbook is thick, widen when thin

### 4.2 Order Sizing
- Volatility-adjusted sizing
- Scale size based on account equity

### 4.3 Multi-Level Quoting
- Place orders at multiple price levels (e.g., 2-3 levels per side)
- Configurable level count and spacing

---

## Phase 5: Infrastructure

### 5.1 Backtesting
- Record price feeds to replay later
- Simulate fills against historical orderbook data

### 5.2 Alerting
- Telegram/Discord notifications for fills, errors, and position changes
- Alert on connection drops or extended downtime

### 5.3 Dashboard
- Simple web UI showing live position, PnL, and order status
- Historical PnL chart
