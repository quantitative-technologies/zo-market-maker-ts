// Integration test: place a limit order far from market, then cancel it.
// Validates that signing, order placement, and cancellation all work end-to-end.
//
// Requires HYPERLIQUID_PRIVATE_KEY and HYPERLIQUID_WALLET_ADDRESS in .env
// Run: npx vitest run test/hyperliquid/live-order.test.ts

import "dotenv/config";
import { describe, it, expect } from "vitest";
import { type Hex } from "viem";
import {
	HyperliquidClient,
	buildOrderWire,
	roundPrice,
	buildCancelWire,
} from "../../src/exchanges/hyperliquid/client.js";

const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY as Hex | undefined;
const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS as Hex | undefined;

describe("Hyperliquid live order", () => {
	it("should place a far-from-market limit order and cancel it", async () => {
		if (!privateKey) {
			console.log("Skipping: HYPERLIQUID_PRIVATE_KEY not set");
			return;
		}

		const client = new HyperliquidClient(privateKey, walletAddress);
		console.log("Signer:", client.account.address);
		console.log("Wallet:", client.walletAddress);

		// Resolve BTC asset index
		const meta = await client.getMeta();
		const btcIdx = meta.universe.findIndex(
			(a) => a.name.toUpperCase() === "BTC",
		);
		expect(btcIdx).toBeGreaterThanOrEqual(0);
		const szDecimals = meta.universe[btcIdx].szDecimals;

		// Fetch L2 book to get a reference price
		const infoRes = await fetch("https://api.hyperliquid.xyz/info", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "l2Book", coin: "BTC" }),
		});
		const book = (await infoRes.json()) as {
			levels: [Array<{ px: string }>, Array<{ px: string }>];
		};
		const bestBid = Number(book.levels[0][0].px);
		const bestAsk = Number(book.levels[1][0].px);
		const mid = (bestBid + bestAsk) / 2;
		console.log("Market mid:", mid);

		// Place at 50% below mid — far enough to never fill, close enough to not be rejected
		const farPrice = roundPrice(mid * 0.5, szDecimals);
		// Minimum order value is $10 — compute size from that
		const MIN_ORDER_VALUE_USD = 11;
		const minSize = Number((MIN_ORDER_VALUE_USD / farPrice).toFixed(szDecimals));
		const orderWire = buildOrderWire(
			btcIdx,
			true, // buy
			farPrice,
			minSize,
			false,
			"Gtc",
		);

		console.log("Placing far-from-market BTC buy at $%d, size %d...", farPrice, minSize);
		const statuses = await client.placeOrders([orderWire]);
		console.log("Place response:", JSON.stringify(statuses));

		expect(statuses.length).toBe(1);
		const status = statuses[0];
		expect(status.resting).toBeDefined();
		const orderId = status.resting!.oid;
		console.log("Order placed, oid:", orderId);

		// Cancel it
		const cancelWire = buildCancelWire(btcIdx, orderId);
		console.log("Cancelling order...");
		await client.cancelOrders([cancelWire]);
		console.log("Order cancelled successfully");

		// Verify it's gone
		const remainingOrders = await client.getOpenOrders();
		const stillOpen = remainingOrders.find((o) => o.oid === orderId);
		expect(stillOpen).toBeUndefined();
	}, 30_000);
});
