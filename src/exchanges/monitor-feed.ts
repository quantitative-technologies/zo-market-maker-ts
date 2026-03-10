// MonitorFeed — read-only data feed for the market monitor (no auth required)

import type {
	BBO,
	MarketInfo,
	MidPrice,
	OrderbookUpdateCallback,
	PriceCallback,
	PublicTradeCallback,
} from "../types.js";

export interface MonitorFeed {
	readonly name: string;
	connect(): Promise<MarketInfo>;
	close(): void;
	onPrice: PriceCallback | null;
	onOrderbookUpdate: OrderbookUpdateCallback | null;
	onTrade: PublicTradeCallback | null;
	getMidPrice(): MidPrice | null;
	getBBO(): BBO | null;
}

export interface CreateMonitorFeedOptions {
	readonly exchange: string;
	readonly symbol: string;
	readonly staleThresholdMs: number;
	readonly staleCheckIntervalMs: number;
	readonly reconnectDelayMs: number;
	readonly maxBookLevels: number;
}

export async function createMonitorFeed(options: CreateMonitorFeedOptions): Promise<MonitorFeed> {
	switch (options.exchange) {
		case "zo": {
			const { ZoMonitorFeed } = await import("./zo/monitor-feed.js");
			return new ZoMonitorFeed(options);
		}
		case "hyperliquid": {
			const { HyperliquidMonitorFeed } = await import("./hyperliquid/monitor-feed.js");
			return new HyperliquidMonitorFeed(options);
		}
		default:
			throw new Error(
				`Unknown exchange: "${options.exchange}". Supported: zo, hyperliquid`,
			);
	}
}
