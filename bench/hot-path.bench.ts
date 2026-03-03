import { bench, describe } from "vitest";
import Decimal from "decimal.js";
import { FairPriceCalculator } from "../src/pricing/fair-price.js";
import { PositionTracker } from "../src/bots/mm/position.js";
import { Quoter } from "../src/bots/mm/quoter.js";
import type { CachedOrder } from "../src/sdk/orders.js";
import type { BBO } from "../src/sdk/orderbook.js";
import type { Quote } from "../src/types.js";
import { log } from "../src/utils/logger.js";

// Suppress all output (PositionTracker.applyFill calls log.debug)
log.setOutput(() => {});

// --- Replicated unexported functions from src/sdk/orders.ts ---

// orderMatchesQuote: lines 135-141
function orderMatchesQuote(order: CachedOrder, quote: Quote): boolean {
	return (
		order.side === quote.side &&
		order.price.eq(quote.price) &&
		order.size.eq(quote.size)
	);
}

// buildPlaceAction: lines 112-124 (object construction only, no SDK call)
function buildPlaceAction(marketId: number, quote: Quote) {
	return {
		kind: "place" as const,
		marketId,
		side: quote.side === "bid" ? 0 : 1,
		fillMode: 1, // PostOnly
		isReduceOnly: false,
		price: quote.price,
		size: quote.size,
	};
}

// buildCancelAction: lines 127-132
function buildCancelAction(orderId: string) {
	return {
		kind: "cancel" as const,
		orderId,
	};
}

// --- Setup ---

const SAMPLE_COUNT = 300;
const REFERENCE_MID = 150.15;
const LOCAL_MID = 150.18;
const MARKET_ID = 1;

function createPrefilledCalculator(): FairPriceCalculator {
	const calc = new FairPriceCalculator({
		windowMs: 600_000,
		minSamples: 10,
	});

	const nowSecond = Math.floor(Date.now() / 1000);
	const internals = calc as unknown as {
		samples: Array<{ offset: number; second: number }>;
		head: number;
		count: number;
		lastSecond: number;
	};

	for (let i = 0; i < SAMPLE_COUNT; i++) {
		const offset = (Math.random() - 0.5) * 0.1;
		const second = nowSecond - (SAMPLE_COUNT - i);
		internals.samples[i] = { offset, second };
	}
	internals.head = SAMPLE_COUNT % 500;
	internals.count = SAMPLE_COUNT;
	internals.lastSecond = nowSecond;

	return calc;
}

function createPositionTracker(): PositionTracker {
	const tracker = new PositionTracker({
		closeThresholdUsd: 100,
		syncIntervalMs: 60_000,
	});
	// Give it a small long position
	tracker.applyFill("bid", 0.1, 150.0);
	return tracker;
}

const calc = createPrefilledCalculator();
const position = createPositionTracker();
const quoter = new Quoter(2, 6, 10, 5, 10);
const bbo: BBO = { bestBid: 150.1, bestAsk: 150.2 };

// Stale orders at slightly different prices than what getQuotes will produce,
// so the diff finds mismatches (this is when T2T is measured — orders need updating)
const staleOrders: CachedOrder[] = [
	{
		orderId: "stale-bid",
		side: "bid",
		price: new Decimal(149.9),
		size: new Decimal(0.066),
	},
	{
		orderId: "stale-ask",
		side: "ask",
		price: new Decimal(150.3),
		size: new Decimal(0.066),
	},
];

// Throttle state (replicates handleBinancePrice gate)
let lastUpdateTime = 0;
// Set to 0 so throttle check always passes — we still measure performance.now()
// call cost but don't skip iterations. In production this is ~100ms.
const UPDATE_INTERVAL_MS = 0;

describe("T2T hot path end-to-end (info level)", () => {
	bench("tick → fair price → quotes → diff → actions", () => {
		// Step 1: Throttle check (handleBinancePrice gate)
		const now = performance.now();
		if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
		lastUpdateTime = now;

		// Step 2: Add price sample (dedup fast-path — same second)
		calc.addSample(LOCAL_MID, REFERENCE_MID);

		// Step 3: Compute fair price
		const fairPrice = calc.getFairPrice(REFERENCE_MID);
		if (fairPrice === null) return;

		// Step 4: Build quoting context
		const ctx = position.getQuotingContext(fairPrice);

		// Step 5: Compute quotes
		const quotes = quoter.getQuotes(ctx, bbo);

		// Step 6: Log quote
		const bid = quotes.find((q) => q.side === "bid");
		const ask = quotes.find((q) => q.side === "ask");
		log.quote(
			bid?.price.toNumber() ?? null,
			ask?.price.toNumber() ?? null,
			fairPrice,
			10,
			"normal",
		);

		// Step 7: Diff orders vs quotes
		const keptOrders: CachedOrder[] = [];
		const quotesToPlace: Quote[] = [];
		for (const quote of quotes) {
			const match = staleOrders.find((o) => orderMatchesQuote(o, quote));
			if (match) {
				keptOrders.push(match);
			} else {
				quotesToPlace.push(quote);
			}
		}
		const ordersToCancel = staleOrders.filter(
			(o) => !keptOrders.includes(o),
		);

		// Step 8: Build atomic actions
		const _actions = [
			...ordersToCancel.map((o) => buildCancelAction(o.orderId)),
			...quotesToPlace.map((q) => buildPlaceAction(MARKET_ID, q)),
		];
	});
});

describe("T2T hot path end-to-end (debug level)", () => {
	bench("tick → fair price → quotes → diff → actions", () => {
		log.setLevel("debug");

		const now = performance.now();
		if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
		lastUpdateTime = now;

		calc.addSample(LOCAL_MID, REFERENCE_MID);

		const fairPrice = calc.getFairPrice(REFERENCE_MID);
		if (fairPrice === null) return;

		const ctx = position.getQuotingContext(fairPrice);
		const quotes = quoter.getQuotes(ctx, bbo);

		const bid = quotes.find((q) => q.side === "bid");
		const ask = quotes.find((q) => q.side === "ask");
		log.quote(
			bid?.price.toNumber() ?? null,
			ask?.price.toNumber() ?? null,
			fairPrice,
			10,
			"normal",
		);

		const keptOrders: CachedOrder[] = [];
		const quotesToPlace: Quote[] = [];
		for (const quote of quotes) {
			const match = staleOrders.find((o) => orderMatchesQuote(o, quote));
			if (match) {
				keptOrders.push(match);
			} else {
				quotesToPlace.push(quote);
			}
		}
		const ordersToCancel = staleOrders.filter(
			(o) => !keptOrders.includes(o),
		);

		const _actions = [
			...ordersToCancel.map((o) => buildCancelAction(o.orderId)),
			...quotesToPlace.map((q) => buildPlaceAction(MARKET_ID, q)),
		];

		log.setLevel("info");
	});
});
