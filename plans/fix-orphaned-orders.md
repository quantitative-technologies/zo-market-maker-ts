# Fix: Orphaned Orders on Atomic Failure

## Problem

When `executeUpdate()` catches an exception, it sets `activeOrders = []`. This orphans any surviving orders on the exchange. The next cycle places new orders without cancelling orphans, causing duplicate accumulation.

## Root Cause

The catch block in `executeUpdate()` blindly clears `activeOrders` on any exception. The most common exception path is an exchange-level rejection of the entire atomic batch (e.g., `POST_ONLY_MUST_NOT_FILL_ANY_OPPOSITE_ORDERS`). The atomic is all-or-nothing: no actions executed, old orders are still live. Clearing `activeOrders` loses track of them.

## Exception Paths (verified in SDK source)

All exceptions from `user.atomic()` are wrapped as `NordError("Atomic operation failed", { cause })`. The cause distinguishes the path:

| Path | Cause message pattern | Exchange state | Frequency |
|------|----------------------|----------------|-----------|
| 1. Exchange rejection | `"Could not execute atomic, reason: ..."` | Unchanged | Common |
| 2. HTTP error | `"Failed to atomic, HTTP status ..."` | Unchanged | Rare |
| 3. Network error | Native Error (TypeError, connection refused, etc.) | Unknown | Rare |
| 4. Client-side validation | NordError directly (e.g. `"Account ID is undefined"`) | Unchanged | Bug, not transient |

In paths 1, 2, and 4: nothing happened on the exchange, `activeOrders` is correct.
In path 3: unknown, but keeping `activeOrders` is still better than clearing (clearing guarantees orphans, keeping causes harmless stale cancel attempts until the periodic 3s sync corrects state).

## Fix

Remove `this.activeOrders = []` from the catch block. Replace with classified logging that positively identifies known-safe cases (exchange rejection, HTTP error) and flags everything else as unknown state.

**File**: `src/bots/mm/index.ts`

1. Added `classifyAtomicError()` helper that inspects the SDK cause message prefix
2. Replaced catch block: no longer clears `activeOrders`, logs at appropriate level per error kind
