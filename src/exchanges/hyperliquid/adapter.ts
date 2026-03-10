// Hyperliquid Exchange adapter

import Decimal from "decimal.js";
import type { Hex } from "viem";
import type { BalanceSnapshot, ExchangeAdapter, FeeRateInfo, TradeRecord } from "../adapter.js";
import {
	HyperliquidClient,
	buildCancelWire,
	buildModifyWire,
	buildOrderWire,
	roundPrice,
} from "./client.js";
import { HyperliquidAccountStream } from "./account.js";
import { HyperliquidOrderbookStream } from "./orderbook.js";
import { floatToWire } from "./signing.js";
import { HyperliquidTradeStream } from "./trades.js";
import type {
	BBO,
	CachedOrder,
	FillCallback,
	FillEvent,
	MarketInfo,
	MidPrice,
	OrderbookUpdateCallback,
	PriceCallback,
	PublicTradeCallback,
	Quote,
} from "../../types.js";
import { log } from "../../utils/logger.js";

// Hyperliquid fee rates are returned as decimal strings (e.g., "0.00035")
// Convert to PPM (parts per million) to match ExchangeAdapter interface
const FEE_DECIMAL_TO_PPM = 1_000_000;

export interface HyperliquidAdapterConfig {
	readonly symbol: string;
	readonly staleThresholdMs: number;
	readonly staleCheckIntervalMs: number;
	readonly reconnectDelayMs: number;
	readonly maxBookLevels: number;
}

export class HyperliquidAdapter implements ExchangeAdapter {
	readonly name = "hyperliquid";

	onFill: FillCallback | null = null;
	onPrice: PriceCallback | null = null;
	onOrderbookUpdate: OrderbookUpdateCallback | null = null;
	onTrade: PublicTradeCallback | null = null;

	private client: HyperliquidClient | null = null;
	private assetIndex = -1;
	private szDecimals = 0;
	private accountStream: HyperliquidAccountStream | null = null;
	private orderbookStream: HyperliquidOrderbookStream | null = null;
	private tradeStream: HyperliquidTradeStream | null = null;

	constructor(
		private readonly privateKey: string,
		private readonly walletAddress: string | undefined,
		private readonly adapterConfig: HyperliquidAdapterConfig,
	) {}

	async connect(): Promise<MarketInfo> {
		this.client = new HyperliquidClient(
			this.privateKey as Hex,
			this.walletAddress as Hex | undefined,
		);

		// Resolve symbol → asset index + size decimals
		const meta = await this.client.getMeta();
		const idx = meta.universe.findIndex(
			(a) => a.name.toUpperCase() === this.adapterConfig.symbol.toUpperCase(),
		);
		if (idx === -1) {
			const available = meta.universe.map((a) => a.name).join(", ");
			throw new Error(
				`Market "${this.adapterConfig.symbol}" not found on Hyperliquid. Available: ${available}`,
			);
		}
		this.assetIndex = idx;
		this.szDecimals = meta.universe[idx].szDecimals;

		// Hyperliquid perps: max decimal places = 6 - szDecimals, max 5 significant figures
		const MAX_PRICE_DECIMALS_PERP = 6;
		const priceDecimals = MAX_PRICE_DECIMALS_PERP - this.szDecimals;
		// Quote token is always USD on Hyperliquid (no separate quote token)
		const quoteDecimals = 2;

		// Initialize streams
		this.orderbookStream = new HyperliquidOrderbookStream(
			this.adapterConfig.symbol,
			this.adapterConfig.staleThresholdMs,
			this.adapterConfig.staleCheckIntervalMs,
			this.adapterConfig.reconnectDelayMs,
			this.adapterConfig.maxBookLevels,
		);
		this.orderbookStream.onPrice = (price: MidPrice) => {
			this.onPrice?.(price);
		};
		this.orderbookStream.onOrderbookUpdate = (bids, asks) => {
			this.onOrderbookUpdate?.(bids, asks);
		};

		this.tradeStream = new HyperliquidTradeStream(
			this.adapterConfig.symbol,
			this.adapterConfig.reconnectDelayMs,
		);
		this.tradeStream.onTrade = (trades) => {
			this.onTrade?.(trades);
		};

		this.accountStream = new HyperliquidAccountStream(
			this.client.walletAddress,
			this.adapterConfig.symbol,
			this.adapterConfig.staleThresholdMs,
			this.adapterConfig.staleCheckIntervalMs,
			this.adapterConfig.reconnectDelayMs,
		);
		this.accountStream.onFill = (fill: FillEvent) => {
			this.onFill?.(fill);
		};

		// Start connections
		this.accountStream.connect();
		this.tradeStream.connect();
		await this.orderbookStream.connect();

		return {
			symbol: meta.universe[idx].name,
			priceDecimals,
			sizeDecimals: this.szDecimals,
			quoteDecimals,
		};
	}

	async close(): Promise<void> {
		this.accountStream?.close();
		this.orderbookStream?.close();
		this.tradeStream?.close();
	}

	async syncOrders(): Promise<CachedOrder[]> {
		const client = this.requireClient();
		const openOrders = await client.getOpenOrders();

		return openOrders
			.filter((o) => o.coin.toUpperCase() === this.adapterConfig.symbol.toUpperCase())
			.map((o) => ({
				orderId: String(o.oid),
				side: hlSideToBidAsk(o.side),
				price: new Decimal(o.limitPx),
				size: new Decimal(o.sz),
			}));
	}

	async updateQuotes(
		cancels: CachedOrder[],
		places: Quote[],
	): Promise<CachedOrder[]> {
		const client = this.requireClient();

		// Pair cancels with places → batchModify for optimal execution
		const pairCount = Math.min(cancels.length, places.length);
		const pairedCancels = cancels.slice(0, pairCount);
		const pairedPlaces = places.slice(0, pairCount);
		const unpairedCancels = cancels.slice(pairCount);
		const unpairedPlaces = places.slice(pairCount);

		const newOrders: CachedOrder[] = [];

		// 1. batchModify paired orders (ALO for post-only, high priority tier)
		if (pairCount > 0) {
			const modifies = pairedCancels.map((cancel, i) => {
				const place = pairedPlaces[i];
				const orderWire = buildOrderWire(
					this.assetIndex,
					place.side === "bid",
					roundPrice(place.price.toNumber(), this.szDecimals),
					place.size.toNumber(),
					false,
					"Alo",
				);
				return buildModifyWire(Number(cancel.orderId), orderWire);
			});

			const statuses = await client.batchModify(modifies);
			for (let i = 0; i < statuses.length; i++) {
				const status = statuses[i];
				const place = pairedPlaces[i];
				if (status.resting) {
					newOrders.push({
						orderId: String(status.resting.oid),
						side: place.side,
						price: place.price,
						size: place.size,
					});
				} else if (status.error) {
					log.warn(`batchModify order ${i} error: ${status.error}`);
				}
			}
		}

		// 2. Cancel unpaired orders
		if (unpairedCancels.length > 0) {
			const cancelWires = unpairedCancels.map((c) =>
				buildCancelWire(this.assetIndex, Number(c.orderId)),
			);
			await client.cancelOrders(cancelWires);
		}

		// 3. Place unpaired new orders (ALO)
		if (unpairedPlaces.length > 0) {
			const orderWires = unpairedPlaces.map((place) =>
				buildOrderWire(
					this.assetIndex,
					place.side === "bid",
					roundPrice(place.price.toNumber(), this.szDecimals),
					place.size.toNumber(),
					false,
					"Alo",
				),
			);

			const statuses = await client.placeOrders(orderWires);
			for (let i = 0; i < statuses.length; i++) {
				const status = statuses[i];
				const place = unpairedPlaces[i];
				if (status.resting) {
					newOrders.push({
						orderId: String(status.resting.oid),
						side: place.side,
						price: place.price,
						size: place.size,
					});
				} else if (status.error) {
					log.warn(`Place order ${i} error: ${status.error}`);
				}
			}
		}

		return newOrders;
	}

	async cancelOrders(orders: CachedOrder[]): Promise<void> {
		const client = this.requireClient();
		const cancelWires = orders.map((o) =>
			buildCancelWire(this.assetIndex, Number(o.orderId)),
		);
		await client.cancelOrders(cancelWires);
	}

	async closePosition(baseSize: number, price: string): Promise<void> {
		const client = this.requireClient();
		// IOC reduce-only order to close position
		const isBuy = baseSize < 0; // If short, buy to close
		const orderWire = buildOrderWire(
			this.assetIndex,
			isBuy,
			roundPrice(Number(price), this.szDecimals),
			Math.abs(baseSize),
			true, // reduceOnly
			"Ioc",
		);
		await client.placeOrders([orderWire]);
	}

	async fetchPosition(): Promise<{ baseSize: number }> {
		const client = this.requireClient();
		const state = await client.getClearinghouseState();

		const pos = state.assetPositions.find(
			(p) => p.position.coin.toUpperCase() === this.adapterConfig.symbol.toUpperCase(),
		);

		const baseSize = pos ? Number(pos.position.szi) : 0;
		return { baseSize };
	}

	async fetchTrades(since: string): Promise<TradeRecord[]> {
		const client = this.requireClient();
		const startTime = new Date(since).getTime();
		const fills = await client.getUserFills(startTime);

		return fills
			.filter((f) => f.coin.toUpperCase() === this.adapterConfig.symbol.toUpperCase())
			.map((f) => ({
				tradeId: f.tid,
				side: hlSideToBidAsk(f.side),
				baseSize: Number(f.sz),
				price: Number(f.px),
				isMaker: !f.crossed, // crossed = taker
			}));
	}

	async fetchBalanceSnapshot(): Promise<BalanceSnapshot> {
		const client = this.requireClient();
		const state = await client.getClearinghouseState();

		const balance = Number(state.crossMarginSummary.accountValue);

		// Extract cumulative funding and unrealized PnL per position
		const fundingPnlByMarket = new Map<number, number>();
		const unrealizedPnlByMarket = new Map<number, number>();
		for (const ap of state.assetPositions) {
			// We don't have a numeric market ID on Hyperliquid — use 0 for the active market
			if (ap.position.coin.toUpperCase() === this.adapterConfig.symbol.toUpperCase()) {
				fundingPnlByMarket.set(0, Number(ap.position.cumFunding.allTime));
				unrealizedPnlByMarket.set(0, Number(ap.position.unrealizedPnl));
			}
		}

		return { balance, fundingPnlByMarket, unrealizedPnlByMarket };
	}

	async fetchFeeRates(): Promise<FeeRateInfo> {
		const client = this.requireClient();
		const fees = await client.getUserFees();

		// userAdd = maker rate, userCross = taker rate (decimal strings like "0.00035")
		const makerFeePpm = Math.round(Number(fees.userAdd) * FEE_DECIMAL_TO_PPM);
		const takerFeePpm = Math.round(Number(fees.userCross) * FEE_DECIMAL_TO_PPM);

		return {
			feeTierId: 0, // Hyperliquid doesn't expose a numeric tier ID
			makerFeePpm,
			takerFeePpm,
		};
	}

	getMidPrice(): MidPrice | null {
		return this.orderbookStream?.getMidPrice() ?? null;
	}

	getBBO(): BBO | null {
		return this.orderbookStream?.getBBO() ?? null;
	}

	private requireClient(): HyperliquidClient {
		if (!this.client) {
			throw new Error("HyperliquidAdapter not connected");
		}
		return this.client;
	}
}

function hlSideToBidAsk(side: "A" | "B"): "bid" | "ask" {
	return side === "B" ? "bid" : "ask";
}
