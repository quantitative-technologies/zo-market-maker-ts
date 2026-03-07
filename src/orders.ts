// Exchange-agnostic order diff logic

import type { CachedOrder, Quote } from "./types.js";

export interface OrderDiff {
	kept: CachedOrder[];
	toCancel: CachedOrder[];
	toPlace: Quote[];
}

// Check if order matches quote (same side, price, size)
function orderMatchesQuote(order: CachedOrder, quote: Quote): boolean {
	return (
		order.side === quote.side &&
		order.price.eq(quote.price) &&
		order.size.eq(quote.size)
	);
}

// Diff current orders against desired quotes
export function diffOrders(
	current: CachedOrder[],
	desired: Quote[],
): OrderDiff {
	const kept: CachedOrder[] = [];
	const toPlace: Quote[] = [];

	for (const quote of desired) {
		const match = current.find((o) => orderMatchesQuote(o, quote));
		if (match) {
			kept.push(match);
		} else {
			toPlace.push(quote);
		}
	}

	const toCancel = current.filter((o) => !kept.includes(o));

	return { kept, toCancel, toPlace };
}
