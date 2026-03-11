// Zo MonitorFeed — read-only data feed (no auth)

import { Nord } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import type { CreateMonitorFeedOptions, MonitorFeed } from "../monitor-feed.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import type {
	BBO,
	MarketInfo,
	MidPrice,
	OrderbookUpdateCallback,
	PriceCallback,
	PublicTrade,
	PublicTradeCallback,
} from "../../types.js";

export class ZoMonitorFeed implements MonitorFeed {
	readonly name = "zo";

	onPrice: PriceCallback | null = null;
	onOrderbookUpdate: OrderbookUpdateCallback | null = null;
	onTrade: PublicTradeCallback | null = null;

	private orderbookStream: ZoOrderbookStream | null = null;
	private tradeSubscription: ReturnType<Nord["subscribeTrades"]> | null = null;

	constructor(private readonly options: CreateMonitorFeedOptions) {}

	async connect(): Promise<MarketInfo> {
		const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
		const connection = new Connection(rpcUrl, "confirmed");

		const nord = await Nord.new({
			webServerUrl: "https://zo-mainnet.n1.xyz",
			app: "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
			solanaConnection: connection,
		});

		// Find market
		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.options.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(`Market "${this.options.symbol}" not found. Available: ${available}`);
		}

		// Look up quote token precision
		const quoteToken = nord.tokens.find((t) => t.tokenId === market.quoteTokenId);
		if (!quoteToken) {
			throw new Error(`Quote token ID ${market.quoteTokenId} not found`);
		}

		// Start orderbook stream
		this.orderbookStream = new ZoOrderbookStream(
			nord,
			market.symbol,
			undefined,
			this.options.staleThresholdMs,
			this.options.staleCheckIntervalMs,
			this.options.reconnectDelayMs,
			this.options.maxBookLevels,
		);
		this.orderbookStream.onPrice = (price) => this.onPrice?.(price);
		this.orderbookStream.onOrderbookUpdate = (bids, asks) => this.onOrderbookUpdate?.(bids, asks);

		// Subscribe to public trades
		this.tradeSubscription = nord.subscribeTrades(market.symbol);
		this.tradeSubscription.on("message", (data: unknown) => {
			const msg = data as { trades?: Array<{ side: string; price: number; size: number }> };
			if (!msg.trades) return;
			const trades: PublicTrade[] = msg.trades.map((t) => ({
				time: Date.now(),
				side: t.side === "ask" ? "buy" as const : "sell" as const,
				price: t.price,
				size: t.size,
			}));
			this.onTrade?.(trades);
		});

		await this.orderbookStream.connect();

		return {
			symbol: market.symbol,
			priceDecimals: market.priceDecimals,
			sizeDecimals: market.sizeDecimals,
			quoteDecimals: quoteToken.decimals,
			minOrderNotionalUsd: 0,
		};
	}

	close(): void {
		this.orderbookStream?.close();
		this.tradeSubscription?.close();
	}

	getMidPrice(): MidPrice | null {
		return this.orderbookStream?.getMidPrice() ?? null;
	}

	getBBO(): BBO | null {
		return this.orderbookStream?.getBBO() ?? null;
	}
}
