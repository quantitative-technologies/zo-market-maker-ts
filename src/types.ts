// Shared types across the codebase

import type Decimal from "decimal.js";

export interface MidPrice {
	mid: number;
	bid: number;
	ask: number;
	timestamp: number;
	tickTimestamp?: number; // performance.now() at tick receipt
}

export type PriceCallback = (price: MidPrice) => void;

// Quote for order placement
export interface Quote {
	side: "bid" | "ask";
	price: Decimal;
	size: Decimal;
}

// Best Bid/Offer for clamping order prices
export interface BBO {
	bestBid: number;
	bestAsk: number;
}

// Fill event data
export interface FillEvent {
	orderId: string;
	side: "bid" | "ask";
	size: number;
	price: number;
	remaining: number;
	marketId: number;
}

export type FillCallback = (fill: FillEvent) => void;

export type OrderCanceledCallback = (orderId: string) => void;

// Cached order info
export interface CachedOrder {
	orderId: string;
	side: "bid" | "ask";
	price: Decimal;
	size: Decimal;
}

// Orderbook depth update (price → size per side)
export type OrderbookUpdateCallback = (
	bids: Map<number, number>,
	asks: Map<number, number>,
) => void;

// Public trade from exchange trade stream
export interface PublicTrade {
	time: number;
	side: "buy" | "sell";
	price: number;
	size: number;
}

export type PublicTradeCallback = (trades: PublicTrade[]) => void;

// Market metadata returned by exchange adapter on connect
export interface MarketInfo {
	symbol: string;
	priceDecimals: number;
	sizeDecimals: number;
	quoteDecimals: number; // Quote token precision (e.g. 6 for USDC)
	minOrderNotionalUsd: number; // Minimum order value in USD
}
