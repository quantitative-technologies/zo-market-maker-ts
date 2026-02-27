# Phase 1: Fill & PnL Logging — Implementation Plan

## Context

When orders get filled, the bot only logs `FILL: BUY 0.00015 @ $63047.50` and updates
net position size. The fill price is passed to `applyFill()` but ignored (`_price`).
There is no tracking of entry price, cost basis, realized PnL, or unrealized PnL.

## Branch

`feature/pnl-tracking` (off `main`)

## Approach

- Extend existing classes — no new files
- Average cost basis for PnL calculation
- Session-scoped only (no persistence across restarts)
- `applyFill()` returns per-fill realized PnL

**PnL logic:**
- Fill that *increases* position → update weighted average entry price
- Fill that *reduces* position → realize PnL: `(fillPrice - entry) * size` (long) or `(entry - fillPrice) * size` (short)
- Fill that *flips* position → split: close existing portion (realize PnL) + open remainder at fill price

---

## File 1: `src/bots/mm/position.ts`

### Add interfaces (after line 17)

```typescript
export interface PnLState {
  readonly avgEntryPrice: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly fillCount: number;
  readonly totalVolumeUsd: number;
}

export interface SessionSummary {
  readonly uptimeMs: number;
  readonly fillCount: number;
  readonly totalVolumeUsd: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly netPnL: number;
  readonly avgSpreadCapturedBps: number;
}
```

### Add `avgEntryPrice` to `PositionState` (line 6-11)

```typescript
export interface PositionState {
  readonly sizeBase: number;
  readonly sizeUsd: number;
  readonly isLong: boolean;
  readonly isCloseMode: boolean;
  readonly avgEntryPrice: number;  // ADD THIS
}
```

### Add private fields to `PositionTracker` (after line 25)

```typescript
private avgEntryPrice = 0;
private realizedPnL = 0;
private fillCount = 0;
private totalVolumeUsd = 0;
private sessionStartTime = Date.now();
```

### Rewrite `applyFill` (lines 85-94) — return per-fill realized PnL

```typescript
applyFill(side: "bid" | "ask", size: number, price: number): number {
  const previousBase = this.baseSize;
  const fillSign = side === "bid" ? 1 : -1;

  this.fillCount++;
  this.totalVolumeUsd += size * price;

  const isIncreasing =
    previousBase === 0 ||
    (previousBase > 0 && fillSign > 0) ||
    (previousBase < 0 && fillSign < 0);

  let fillRealizedPnL = 0;

  if (isIncreasing) {
    // Opening or adding: update weighted avg entry
    const previousCost = Math.abs(previousBase) * this.avgEntryPrice;
    const fillCost = size * price;
    const newAbsSize = Math.abs(previousBase) + size;
    this.avgEntryPrice = newAbsSize > 0 ? (previousCost + fillCost) / newAbsSize : price;
  } else {
    // Reducing or flipping
    const reducingSize = Math.min(size, Math.abs(previousBase));
    const remainingSize = size - reducingSize;

    if (previousBase > 0) {
      fillRealizedPnL = (price - this.avgEntryPrice) * reducingSize;
    } else {
      fillRealizedPnL = (this.avgEntryPrice - price) * reducingSize;
    }
    this.realizedPnL += fillRealizedPnL;

    if (remainingSize > 0) {
      // Flipped: remainder opens new position at fill price
      this.avgEntryPrice = price;
    } else if (Math.abs(previousBase + size * fillSign) < 1e-10) {
      // Fully closed
      this.avgEntryPrice = 0;
    }
    // Partially reduced: avgEntryPrice stays the same
  }

  this.baseSize = previousBase + size * fillSign;

  log.debug(
    `Position updated: ${this.baseSize.toFixed(6)} (${side} ${size} @ $${price.toFixed(2)}) | entry=$${this.avgEntryPrice.toFixed(2)} | rPnL=$${this.realizedPnL.toFixed(4)}`,
  );

  return fillRealizedPnL;
}
```

### Add new public methods

```typescript
getUnrealizedPnL(markPrice: number): number {
  if (this.baseSize === 0 || this.avgEntryPrice === 0) return 0;
  if (this.baseSize > 0) {
    return (markPrice - this.avgEntryPrice) * this.baseSize;
  }
  return (this.avgEntryPrice - markPrice) * Math.abs(this.baseSize);
}

getRealizedPnL(): number {
  return this.realizedPnL;
}

getAvgEntryPrice(): number {
  return this.avgEntryPrice;
}

getSessionSummary(markPrice: number): SessionSummary {
  const uptimeMs = Date.now() - this.sessionStartTime;
  const unrealizedPnL = this.getUnrealizedPnL(markPrice);
  return {
    uptimeMs,
    fillCount: this.fillCount,
    totalVolumeUsd: this.totalVolumeUsd,
    realizedPnL: this.realizedPnL,
    unrealizedPnL,
    netPnL: this.realizedPnL + unrealizedPnL,
    avgSpreadCapturedBps:
      this.totalVolumeUsd > 0
        ? (this.realizedPnL / this.totalVolumeUsd) * 10000
        : 0,
  };
}
```

### Update `getState` (lines 106-118) — include avgEntryPrice

```typescript
private getState(fairPrice: number): PositionState {
  const sizeBase = this.baseSize;
  const sizeUsd = sizeBase * fairPrice;
  const isLong = sizeBase > 0;
  const isCloseMode = Math.abs(sizeUsd) >= this.config.closeThresholdUsd;
  return { sizeBase, sizeUsd, isLong, isCloseMode, avgEntryPrice: this.avgEntryPrice };
}
```

### Update `syncFromServer` drift handling (lines 74-78)

```typescript
if (Math.abs(this.baseSize - serverSize) > 0.0001) {
  log.warn(
    `Position drift: local=${this.baseSize.toFixed(6)}, server=${serverSize.toFixed(6)}`,
  );
  // Reset entry price if direction changed (we lost track)
  if ((this.baseSize > 0 && serverSize < 0) || (this.baseSize < 0 && serverSize > 0)) {
    log.warn("Position direction changed during sync - resetting entry price");
    this.avgEntryPrice = 0;
  }
  this.baseSize = serverSize;
}
```

---

## File 2: `src/utils/logger.ts`

### Extend `fill()` (lines 105-112) — add optional PnL params

```typescript
fill(
  side: "buy" | "sell",
  price: number,
  size: number,
  fillPnL?: number,
  cumulativeRealizedPnL?: number,
): void {
  let pnlStr = "";
  if (fillPnL !== undefined && fillPnL !== 0) {
    const sign = fillPnL >= 0 ? "+" : "";
    pnlStr += ` | fillPnL ${sign}$${fillPnL.toFixed(4)}`;
  }
  if (cumulativeRealizedPnL !== undefined) {
    const sign = cumulativeRealizedPnL >= 0 ? "+" : "";
    pnlStr += ` | rPnL ${sign}$${cumulativeRealizedPnL.toFixed(4)}`;
  }
  outputFn(
    format(
      "INFO",
      `FILL: ${side.toUpperCase()} ${size} @ $${price.toFixed(2)}${pnlStr}`,
    ),
  );
},
```

### Extend `position()` (lines 89-103) — add optional entry price & uPnL

```typescript
position(
  sizeBase: number,
  sizeUsd: number,
  isLong: boolean,
  isCloseMode: boolean,
  avgEntryPrice?: number,
  unrealizedPnL?: number,
): void {
  const dir = isLong ? "LONG" : "SHORT";
  const mode = isCloseMode ? " [CLOSE MODE]" : "";
  let extra = "";
  if (avgEntryPrice && avgEntryPrice > 0) {
    extra += ` entry=$${avgEntryPrice.toFixed(2)}`;
  }
  if (unrealizedPnL !== undefined && sizeBase !== 0) {
    const sign = unrealizedPnL >= 0 ? "+" : "";
    extra += ` | uPnL ${sign}$${unrealizedPnL.toFixed(4)}`;
  }
  outputFn(
    format(
      "INFO",
      `POS: ${dir} ${Math.abs(sizeBase).toFixed(6)} ($${Math.abs(sizeUsd).toFixed(2)})${extra}${mode}`,
    ),
  );
},
```

### Add `sessionSummary()` method (after `shutdown()`, before closing `}`)

```typescript
sessionSummary(summary: {
  uptimeMs: number;
  fillCount: number;
  totalVolumeUsd: number;
  realizedPnL: number;
  unrealizedPnL: number;
  netPnL: number;
  avgSpreadCapturedBps: number;
}): void {
  const uptimeMin = (summary.uptimeMs / 60000).toFixed(1);
  const fmt = (v: number) => {
    const sign = v >= 0 ? "+" : "";
    return `${sign}$${v.toFixed(4)}`;
  };
  outputFn(format("INFO", "═══ SESSION SUMMARY ═══"));
  outputFn(format("INFO", `  Uptime:     ${uptimeMin} min`));
  outputFn(format("INFO", `  Fills:      ${summary.fillCount}`));
  outputFn(format("INFO", `  Volume:     $${summary.totalVolumeUsd.toFixed(2)}`));
  outputFn(format("INFO", `  Realized:   ${fmt(summary.realizedPnL)}`));
  outputFn(format("INFO", `  Unrealized: ${fmt(summary.unrealizedPnL)}`));
  outputFn(format("INFO", `  Net PnL:    ${fmt(summary.netPnL)}`));
  outputFn(format("INFO", `  Avg Spread: ${summary.avgSpreadCapturedBps.toFixed(2)} bps`));
  outputFn(format("INFO", "═══════════════════════"));
},
```

---

## File 3: `src/bots/mm/index.ts`

### Update fill handler (lines 161-168)

```typescript
this.accountStream?.setOnFill((fill: FillEvent) => {
  const fillPnL = this.positionTracker?.applyFill(fill.side, fill.size, fill.price) ?? 0;

  log.fill(
    fill.side === "bid" ? "buy" : "sell",
    fill.price,
    fill.size,
    fillPnL !== 0 ? fillPnL : undefined,
    this.positionTracker?.getRealizedPnL(),
  );

  if (this.positionTracker?.isCloseMode(fill.price)) {
    this.cancelOrdersAsync();
  }
});
```

### Update position logging in `executeUpdate` (lines 323-329)

```typescript
if (positionState.sizeBase !== 0) {
  const uPnL = this.positionTracker?.getUnrealizedPnL(fairPrice) ?? 0;
  log.position(
    positionState.sizeBase,
    positionState.sizeUsd,
    positionState.isLong,
    positionState.isCloseMode,
    positionState.avgEntryPrice,
    uPnL,
  );
}
```

### Update `logStatus` (lines 408-424) — add PnL to status line

```typescript
private logStatus(): void {
  if (!this.isRunning) return;

  const pos = this.positionTracker?.getBaseSize() ?? 0;
  const bids = this.activeOrders.filter((o) => o.side === "bid");
  const asks = this.activeOrders.filter((o) => o.side === "ask");

  const formatOrder = (o: CachedOrder) =>
    `$${o.price.toFixed(2)}x${o.size.toString()}`;

  const bidStr = bids.map(formatOrder).join(",") || "-";
  const askStr = asks.map(formatOrder).join(",") || "-";

  const entry = this.positionTracker?.getAvgEntryPrice() ?? 0;
  const rPnL = this.positionTracker?.getRealizedPnL() ?? 0;

  // Get fair price for unrealized PnL
  const binancePrice = this.binanceFeed?.getMidPrice();
  const fairPrice = binancePrice ? this.fairPriceCalc?.getFairPrice(binancePrice.mid) : null;
  const uPnL = fairPrice ? (this.positionTracker?.getUnrealizedPnL(fairPrice) ?? 0) : 0;

  const entryStr = entry > 0 ? ` entry=$${entry.toFixed(2)}` : "";
  const rSign = rPnL >= 0 ? "+" : "";
  const uSign = uPnL >= 0 ? "+" : "";

  log.info(
    `STATUS: pos=${pos.toFixed(5)}${entryStr} | uPnL=${uSign}$${uPnL.toFixed(4)} | rPnL=${rSign}$${rPnL.toFixed(4)} | bid=[${bidStr}] | ask=[${askStr}]`,
  );
}
```

### Update `shutdown` (lines 273-305) — add session summary before exit

Insert after `this.accountStream?.close();` (line 290) and before the `try` block (line 292):

```typescript
// Log session summary
const binancePrice = this.binanceFeed?.getMidPrice();
const fairPrice = binancePrice ? this.fairPriceCalc?.getFairPrice(binancePrice.mid) : null;
const markPrice = fairPrice ?? binancePrice?.mid ?? 0;

if (this.positionTracker) {
  const summary = this.positionTracker.getSessionSummary(markPrice);
  log.sessionSummary(summary);
}
```

Note: move `this.binanceFeed?.close()` and `this.orderbookStream?.close()` AFTER the summary
so price feeds are still available for mark price lookup.

---

## Expected Log Output

```
FILL: BUY 0.00015 @ $63047.50 | rPnL +$0.0000
FILL: SELL 0.00015 @ $63055.00 | fillPnL +$0.0011 | rPnL +$0.0011
POS: LONG 0.000150 ($9.46) entry=$63047.50 | uPnL +$0.0008
STATUS: pos=0.00015 entry=$63047.50 | uPnL=+$0.0008 | rPnL=+$0.0011 | bid=[...] | ask=[...]

═══ SESSION SUMMARY ═══
  Uptime:     120.0 min
  Fills:      47
  Volume:     $297.12
  Realized:   +$0.1234
  Unrealized: -$0.0045
  Net PnL:    +$0.1189
  Avg Spread: 4.15 bps
═══════════════════════
```

---

## Verification

1. `npx tsc --noEmit` — compiles without errors
2. `docker compose build` — builds successfully
3. Run with `npm run bot -- BTC`, observe:
   - FILL lines show per-fill PnL when position reduces
   - STATUS lines show entry price, uPnL, rPnL
   - Ctrl+C triggers session summary
4. Edge case: position flip (long → short in one fill) splits PnL correctly
