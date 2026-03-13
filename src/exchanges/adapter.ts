// Exchange adapter interface — implemented per exchange

import type {
	BBO,
	CachedOrder,
	FillCallback,
	MarketInfo,
	MidPrice,
	OrderbookUpdateCallback,
	PriceCallback,
	PublicTradeCallback,
	Quote,
} from "../types.js";

export interface BalanceSnapshot {
	readonly balance: number;
	readonly fundingPnlByMarket: Map<number, number>;
	readonly unrealizedPnlByMarket: Map<number, number>;
}

export interface FeeRateInfo {
	readonly feeTierId: number;
	readonly makerFeePpm: number;
	readonly takerFeePpm: number;
}

export interface TradeRecord {
	readonly tradeId: number;
	readonly side: "bid" | "ask"; // Our side
	readonly baseSize: number;
	readonly price: number;
	readonly isMaker: boolean;
}

export interface ExchangeAdapter {
	readonly name: string;

	// Lifecycle
	connect(): Promise<MarketInfo>;
	close(): Promise<void>;

	// Data feeds — adapter calls these callbacks when data arrives
	onFill: FillCallback | null;
	onOrderCanceled: ((orderId: string) => void) | null;
	onPrice: PriceCallback | null;
	onOrderbookUpdate: OrderbookUpdateCallback | null;
	onTrade: PublicTradeCallback | null;

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
	fetchTrades(since: string): Promise<TradeRecord[]>;

	// Balance
	fetchBalanceSnapshot(): Promise<BalanceSnapshot>;
	fetchFeeRates(): Promise<FeeRateInfo>;

	// Orderbook state (synchronous reads of cached state)
	getMidPrice(): MidPrice | null;
	getBBO(): BBO | null;
}
