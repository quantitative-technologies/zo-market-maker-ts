// Atomic order operations with immediate order ID tracking

import {
	FillMode,
	type NordUser,
	Side,
	type UserAtomicSubaction,
} from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { Quote } from "../types.js";
import { diffOrders } from "../orders.js";
import { log } from "../utils/logger.js";

const MAX_ATOMIC_ACTIONS = 4;

// Re-export from shared types
export type { CachedOrder } from "../types.js";
import type { CachedOrder } from "../types.js";

// Result type for atomic operations
interface AtomicResult {
	results: Array<{
		inner: {
			case: string;
			value: {
				orderId?: string;
				posted?: {
					orderId: string;
				};
			};
		};
	}>;
}

function formatAction(action: UserAtomicSubaction): string {
	if (action.kind === "cancel") {
		return `X${action.orderId}`;
	}
	const side = action.side === Side.Bid ? "B" : "A";
	const ro = action.isReduceOnly ? "RO" : "";
	const fm =
		action.fillMode === FillMode.PostOnly
			? "PO"
			: action.fillMode === FillMode.Limit
				? "LIM"
				: action.fillMode === FillMode.ImmediateOrCancel
					? "IOC"
					: "FOK";
	return `${side}${ro}[${fm}]@${action.price}x${action.size}`;
}

// Extract placed orders from atomic result
function extractPlacedOrders(
	result: AtomicResult,
	actions: UserAtomicSubaction[],
): CachedOrder[] {
	const orders: CachedOrder[] = [];
	const placeActions = actions.filter((a) => a.kind === "place");
	let placeIdx = 0;

	for (const r of result.results) {
		if (r.inner.case === "placeOrderResult" && r.inner.value.posted?.orderId) {
			const action = placeActions[placeIdx];
			if (action && action.kind === "place") {
				orders.push({
					orderId: r.inner.value.posted.orderId,
					side: action.side === Side.Bid ? "bid" : "ask",
					price: new Decimal(action.price as Decimal.Value),
					size: new Decimal(action.size as Decimal.Value),
				});
			}
			placeIdx++;
		}
	}
	return orders;
}

// Execute atomic operations in chunks of MAX_ATOMIC_ACTIONS
async function executeAtomic(
	user: NordUser,
	actions: UserAtomicSubaction[],
): Promise<CachedOrder[]> {
	if (actions.length === 0) return [];

	const allOrders: CachedOrder[] = [];
	const totalChunks = Math.ceil(actions.length / MAX_ATOMIC_ACTIONS);

	for (let i = 0; i < actions.length; i += MAX_ATOMIC_ACTIONS) {
		const chunkIdx = Math.floor(i / MAX_ATOMIC_ACTIONS) + 1;
		const chunk = actions.slice(i, i + MAX_ATOMIC_ACTIONS);

		log.info(
			`ATOMIC [${chunkIdx}/${totalChunks}]: ${chunk.map(formatAction).join(" ")}`,
		);

		const result = (await user.atomic(chunk)) as AtomicResult;
		log.debug(`ATOMIC: raw result ${JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);

		const placed = extractPlacedOrders(result, chunk);
		allOrders.push(...placed);

		const placeCount = chunk.filter((a) => a.kind === "place").length;
		const cancelCount = chunk.filter((a) => a.kind === "cancel").length;

		if (placeCount > 0) {
			const cancelledStr =
				cancelCount > 0 ? `, ${cancelCount} cancelled` : "";
			if (placed.length === placeCount) {
				log.info(
					`ATOMIC: ${placed.length}/${placeCount} placed${cancelledStr}`,
				);
			} else {
				const rejected = placeCount - placed.length;
				log.warn(
					`ATOMIC: ${placed.length}/${placeCount} placed (${rejected} rejected)${cancelledStr}`,
				);
			}
		} else if (cancelCount > 0) {
			log.info(`ATOMIC: ${cancelCount} cancelled`);
		}

		if (placed.length > 0) {
			log.debug(`ATOMIC: ids [${placed.map((o) => o.orderId).join(", ")}]`);
		}
	}

	return allOrders;
}

// Build place action from quote
function buildPlaceAction(marketId: number, quote: Quote): UserAtomicSubaction {
	const action = {
		kind: "place" as const,
		marketId,
		side: quote.side === "bid" ? Side.Bid : Side.Ask,
		fillMode: FillMode.PostOnly,
		isReduceOnly: false,
		price: quote.price,
		size: quote.size,
	};
	log.debug(`ORDER JSON: ${JSON.stringify(action)}`);
	return action;
}

// Build cancel action from order ID
function buildCancelAction(orderId: string): UserAtomicSubaction {
	return {
		kind: "cancel" as const,
		orderId,
	};
}

// Update quotes: only cancel/place if changed
export async function updateQuotes(
	user: NordUser,
	marketId: number,
	currentOrders: CachedOrder[],
	newQuotes: Quote[],
): Promise<CachedOrder[]> {
	const { kept, toCancel, toPlace } = diffOrders(currentOrders, newQuotes);

	if (toCancel.length === 0 && toPlace.length === 0) {
		return currentOrders;
	}

	const actions: UserAtomicSubaction[] = [
		...toCancel.map((o) => buildCancelAction(o.orderId)),
		...toPlace.map((q) => buildPlaceAction(marketId, q)),
	];

	const placedOrders = await executeAtomic(user, actions);
	return [...kept, ...placedOrders];
}

// Execute pre-computed cancels and places atomically (used by ZoAdapter)
export async function executeQuoteUpdate(
	user: NordUser,
	marketId: number,
	cancels: CachedOrder[],
	places: Quote[],
): Promise<CachedOrder[]> {
	if (cancels.length === 0 && places.length === 0) return [];

	const actions: UserAtomicSubaction[] = [
		...cancels.map((o) => buildCancelAction(o.orderId)),
		...places.map((q) => buildPlaceAction(marketId, q)),
	];

	return executeAtomic(user, actions);
}

// Cancel orders
export async function cancelOrders(
	user: NordUser,
	orders: CachedOrder[],
): Promise<void> {
	if (orders.length === 0) return;
	const actions = orders.map((o) => buildCancelAction(o.orderId));
	await executeAtomic(user, actions);
}

// Close position with an IOC order at the given price
export async function closePosition(
	user: NordUser,
	marketId: number,
	baseSize: number,
	price: string,
): Promise<void> {
	if (Math.abs(baseSize) < 1e-10) return;

	// If long, sell to close. If short, buy to close.
	const side = baseSize > 0 ? Side.Ask : Side.Bid;
	const size = Math.abs(baseSize).toString();

	const action: UserAtomicSubaction = {
		kind: "place" as const,
		marketId,
		side,
		fillMode: FillMode.ImmediateOrCancel,
		isReduceOnly: true,
		price,
		size,
	};

	log.info(`CLOSE POSITION: ${side === Side.Bid ? "BUY" : "SELL"} ${size} @ $${price} [IOC/RO]`);
	await executeAtomic(user, [action]);
}
