import { bench, describe } from "vitest";
import { Quoter } from "../src/bots/mm/quoter.js";
import type { QuotingContext } from "../src/bots/mm/position.js";
import type { BBO } from "../src/sdk/orderbook.js";

// SOL-like instrument: 2 price decimals, 6 size decimals, 10bps spread, 5bps TP, $10 order
const quoter = new Quoter(2, 6, 10, 5, 10);

const FAIR_PRICE = 150.15;

const normalCtx: QuotingContext = {
	fairPrice: FAIR_PRICE,
	positionState: {
		sizeBase: 0.1,
		sizeUsd: 15.015,
		isLong: true,
		isCloseMode: false,
		avgEntryPrice: 149.8,
	},
	allowedSides: ["bid", "ask"],
};

const closeCtx: QuotingContext = {
	fairPrice: FAIR_PRICE,
	positionState: {
		sizeBase: 0.2,
		sizeUsd: 30.03,
		isLong: true,
		isCloseMode: true,
		avgEntryPrice: 149.8,
	},
	allowedSides: ["ask"],
};

const bbo: BBO = {
	bestBid: 150.1,
	bestAsk: 150.2,
};

describe("Quoter.getQuotes()", () => {
	bench("normal mode with BBO", () => {
		quoter.getQuotes(normalCtx, bbo);
	});

	bench("close mode with BBO", () => {
		quoter.getQuotes(closeCtx, bbo);
	});

	bench("normal mode without BBO (null)", () => {
		quoter.getQuotes(normalCtx, null);
	});
});
