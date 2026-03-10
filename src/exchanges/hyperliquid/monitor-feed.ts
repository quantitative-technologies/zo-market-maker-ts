// Hyperliquid MonitorFeed — read-only data feed (no auth)

import type { CreateMonitorFeedOptions, MonitorFeed } from "../monitor-feed.js";
import { HyperliquidOrderbookStream } from "./orderbook.js";
import { HyperliquidTradeStream } from "./trades.js";
import type {
	BBO,
	MarketInfo,
	MidPrice,
	OrderbookUpdateCallback,
	PriceCallback,
	PublicTradeCallback,
} from "../../types.js";

const BASE_URL = "https://api.hyperliquid.xyz";
const MAX_PRICE_DECIMALS_PERP = 6;

export class HyperliquidMonitorFeed implements MonitorFeed {
	readonly name = "hyperliquid";

	onPrice: PriceCallback | null = null;
	onOrderbookUpdate: OrderbookUpdateCallback | null = null;
	onTrade: PublicTradeCallback | null = null;

	private orderbookStream: HyperliquidOrderbookStream | null = null;
	private tradeStream: HyperliquidTradeStream | null = null;

	constructor(private readonly options: CreateMonitorFeedOptions) {}

	async connect(): Promise<MarketInfo> {
		// Fetch meta to resolve symbol
		const res = await fetch(`${BASE_URL}/info`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "meta" }),
		});
		if (!res.ok) {
			throw new Error(`Hyperliquid meta failed (${res.status})`);
		}
		const meta = (await res.json()) as { universe: Array<{ name: string; szDecimals: number }> };

		const idx = meta.universe.findIndex(
			(a) => a.name.toUpperCase() === this.options.symbol.toUpperCase(),
		);
		if (idx === -1) {
			const available = meta.universe.map((a) => a.name).join(", ");
			throw new Error(`Market "${this.options.symbol}" not found. Available: ${available}`);
		}

		const asset = meta.universe[idx];
		const priceDecimals = MAX_PRICE_DECIMALS_PERP - asset.szDecimals;

		// Start streams
		this.orderbookStream = new HyperliquidOrderbookStream(
			this.options.symbol,
			this.options.staleThresholdMs,
			this.options.staleCheckIntervalMs,
			this.options.reconnectDelayMs,
			this.options.maxBookLevels,
		);
		this.orderbookStream.onPrice = (price) => this.onPrice?.(price);
		this.orderbookStream.onOrderbookUpdate = (bids, asks) => this.onOrderbookUpdate?.(bids, asks);

		this.tradeStream = new HyperliquidTradeStream(
			this.options.symbol,
			this.options.reconnectDelayMs,
		);
		this.tradeStream.onTrade = (trades) => this.onTrade?.(trades);

		this.tradeStream.connect();
		await this.orderbookStream.connect();

		return {
			symbol: asset.name,
			priceDecimals,
			sizeDecimals: asset.szDecimals,
			quoteDecimals: 2,
		};
	}

	close(): void {
		this.orderbookStream?.close();
		this.tradeStream?.close();
	}

	getMidPrice(): MidPrice | null {
		return this.orderbookStream?.getMidPrice() ?? null;
	}

	getBBO(): BBO | null {
		return this.orderbookStream?.getBBO() ?? null;
	}
}
