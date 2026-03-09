# Bug: Orderbook reconnect crash (unhandled promise rejection)

## What happened
- **Date**: 2026-03-08, mm-btc container crashed after ~9 minutes
- Exchange API (`zo-mainnet.n1.xyz`) started returning `"internal assertion violation"` on all REST calls
- Bot survived ~69s of API downtime (executeAtomic failures were caught), but then the orderbook WebSocket reconnected and crashed the process

## Root cause
`ZoOrderbookStream.reconnect()` in `src/sdk/orderbook.ts:249` has no try/catch. It is called fire-and-forget via `void this.reconnect()` from `scheduleReconnect()` (line 245). When `fetchSnapshot()` throws (line 258), the rejected promise is unhandled, killing the Node.js process.

## Fix
Wrap the body of `reconnect()` in a try/catch. On failure, log the error and call `this.scheduleReconnect()` to retry after the delay.

`scheduleReconnect()` (line 233) already has a guard against duplicate timers (`if (this.reconnectTimeout) return`), and `reconnectTimeout` is set to `null` before `reconnect()` runs (line 244), so the re-entry path works correctly.

```typescript
private async reconnect(): Promise<void> {
    try {
        // existing body unchanged
        this.resetState();
        this.subscription = this.nord.subscribeOrderbook(this.symbol);
        this.setupEventHandlers();
        await this.fetchSnapshot();
        this.applyBufferedDeltas();
        log.info("Zo orderbook reconnected");
    } catch (err) {
        log.error("Orderbook reconnect failed:", err);
        this.scheduleReconnect();
    }
}
```

## Delete this file after fixing.
