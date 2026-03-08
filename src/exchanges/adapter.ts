// Exchange adapter interface — implemented per exchange

import type {
	BBO,
	CachedOrder,
	FillCallback,
	MarketInfo,
	MidPrice,
	PriceCallback,
	Quote,
} from "../types.js";

export interface BalanceSnapshot {
	readonly balance: number;
	readonly fundingPnlByMarket: Map<number, number>;
}

export interface FeeRateInfo {
	readonly feeTierId: number;
	readonly makerFeePpm: number;
	readonly takerFeePpm: number;
}

export interface ExchangeAdapter {
	readonly name: string;

	// Lifecycle
	connect(): Promise<MarketInfo>;
	close(): Promise<void>;

	// Data feeds — adapter calls these callbacks when data arrives
	onFill: FillCallback | null;
	onPrice: PriceCallback | null;

	// Orders
	syncOrders(): Promise<CachedOrder[]>;
	updateQuotes(
		cancels: CachedOrder[],
		places: Quote[],
	): Promise<CachedOrder[]>;
	cancelOrders(orders: CachedOrder[]): Promise<void>;
	closePosition(baseSize: number, price: string): Promise<void>;

	// Position
	fetchPosition(): Promise<{ baseSize: number }>;

	// Balance
	fetchBalanceSnapshot(): Promise<BalanceSnapshot>;
	fetchFeeRates(): Promise<FeeRateInfo>;

	// Orderbook state (synchronous reads of cached state)
	getMidPrice(): MidPrice | null;
	getBBO(): BBO | null;
}
