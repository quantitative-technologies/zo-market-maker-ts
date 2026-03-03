import { bench, describe } from "vitest";
import Decimal from "decimal.js";
import type { CachedOrder } from "../src/sdk/orders.js";
import type { Quote } from "../src/types.js";

// Replicate orderMatchesQuote from src/sdk/orders.ts lines 135-141 (unexported)
function orderMatchesQuote(order: CachedOrder, quote: Quote): boolean {
	return (
		order.side === quote.side &&
		order.price.eq(quote.price) &&
		order.size.eq(quote.size)
	);
}

function makeOrder(
	side: "bid" | "ask",
	price: number,
	size: number,
): CachedOrder {
	return {
		orderId: `order-${side}-${price}`,
		side,
		price: new Decimal(price),
		size: new Decimal(size),
	};
}

function makeQuote(side: "bid" | "ask", price: number, size: number): Quote {
	return {
		side,
		price: new Decimal(price),
		size: new Decimal(size),
	};
}

// Matching pair (same values)
const matchingOrder = makeOrder("bid", 150.1, 0.066);
const matchingQuote = makeQuote("bid", 150.1, 0.066);

// Non-matching pair (different price)
const mismatchOrder = makeOrder("bid", 150.1, 0.066);
const mismatchQuote = makeQuote("bid", 150.12, 0.066);

// Simulate updateQuotes diffing: 2 current orders vs 2 new quotes
const currentOrders: CachedOrder[] = [
	makeOrder("bid", 150.1, 0.066),
	makeOrder("ask", 150.2, 0.066),
];

const sameQuotes: Quote[] = [
	makeQuote("bid", 150.1, 0.066),
	makeQuote("ask", 150.2, 0.066),
];

const changedQuotes: Quote[] = [
	makeQuote("bid", 150.08, 0.066),
	makeQuote("ask", 150.22, 0.066),
];

describe("orderMatchesQuote", () => {
	bench("matching (true)", () => {
		orderMatchesQuote(matchingOrder, matchingQuote);
	});

	bench("non-matching (false, price differs)", () => {
		orderMatchesQuote(mismatchOrder, mismatchQuote);
	});
});

describe("Order diffing (2 orders vs 2 quotes)", () => {
	bench("all matching (no changes needed)", () => {
		const keptOrders: CachedOrder[] = [];
		for (const quote of sameQuotes) {
			const match = currentOrders.find((o) => orderMatchesQuote(o, quote));
			if (match) {
				keptOrders.push(match);
			}
		}
	});

	bench("all changed (full cancel + place)", () => {
		const keptOrders: CachedOrder[] = [];
		for (const quote of changedQuotes) {
			const match = currentOrders.find((o) => orderMatchesQuote(o, quote));
			if (match) {
				keptOrders.push(match);
			}
		}
	});
});
