// Zo Exchange adapter — wraps existing src/sdk/* modules

import Decimal from "decimal.js";
import type { BalanceSnapshot, ExchangeAdapter, FeeRateInfo, TradeRecord } from "../adapter.js";
import { AccountStream } from "../../sdk/account.js";
import { createZoClient, type ZoClient } from "../../sdk/client.js";
import {
	cancelOrders as zoCancel,
	closePosition as zoClose,
	executeQuoteUpdate as zoExecuteQuoteUpdate,
} from "../../sdk/orders.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import type {
	BBO,
	CachedOrder,
	FillCallback,
	FillEvent,
	MarketInfo,
	MidPrice,
	PriceCallback,
	Quote,
} from "../../types.js";

// API order type from SDK
interface ApiOrder {
	orderId: bigint | number;
	marketId: number;
	side: "bid" | "ask";
	price: number | string;
	size: number | string;
}

function mapApiOrdersToCached(orders: ApiOrder[]): CachedOrder[] {
	return orders.map((o) => ({
		orderId: o.orderId.toString(),
		side: o.side,
		price: new Decimal(o.price),
		size: new Decimal(o.size),
	}));
}

export interface ZoAdapterConfig {
	readonly symbol: string;
	readonly staleThresholdMs: number;
	readonly staleCheckIntervalMs: number;
	readonly reconnectDelayMs: number;
	readonly maxBookLevels: number;
}

export class ZoAdapter implements ExchangeAdapter {
	readonly name = "zo";

	onFill: FillCallback | null = null;
	onPrice: PriceCallback | null = null;

	private client: ZoClient | null = null;
	private marketId = 0;
	private sizeDecimals = 0;
	private accountStream: AccountStream | null = null;
	private orderbookStream: ZoOrderbookStream | null = null;

	constructor(
		private readonly privateKey: string,
		private readonly adapterConfig: ZoAdapterConfig,
	) {}

	async connect(): Promise<MarketInfo> {
		this.client = await createZoClient(this.privateKey);
		const { nord, accountId } = this.client;

		// Find market by symbol prefix match
		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.adapterConfig.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(
				`Market "${this.adapterConfig.symbol}" not found. Available: ${available}`,
			);
		}
		this.marketId = market.marketId;
		this.sizeDecimals = market.sizeDecimals;

		// Look up quote token precision
		const quoteToken = nord.tokens.find((t) => t.tokenId === market.quoteTokenId);
		if (!quoteToken) {
			throw new Error(`Quote token ID ${market.quoteTokenId} not found in exchange token list`);
		}
		const quoteDecimals = quoteToken.decimals;

		// Initialize streams
		this.accountStream = new AccountStream(
			nord,
			accountId,
			this.adapterConfig.staleThresholdMs,
			this.adapterConfig.staleCheckIntervalMs,
			this.adapterConfig.reconnectDelayMs,
		);
		this.orderbookStream = new ZoOrderbookStream(
			nord,
			market.symbol,
			undefined,
			this.adapterConfig.staleThresholdMs,
			this.adapterConfig.staleCheckIntervalMs,
			this.adapterConfig.reconnectDelayMs,
			this.adapterConfig.maxBookLevels,
		);

		// Wire fill callback
		this.accountStream.syncOrders(this.client.user, accountId);
		this.accountStream.setOnFill((fill: FillEvent) => {
			if (fill.marketId !== this.marketId) return;
			this.onFill?.(fill);
		});

		// Wire orderbook price callback
		this.orderbookStream.onPrice = (price: MidPrice) => {
			this.onPrice?.(price);
		};

		// Start connections
		this.accountStream.connect();
		await this.orderbookStream.connect();

		return {
			symbol: market.symbol,
			priceDecimals: market.priceDecimals,
			sizeDecimals: market.sizeDecimals,
			quoteDecimals,
		};
	}

	async close(): Promise<void> {
		this.accountStream?.close();
		this.orderbookStream?.close();
	}

	async syncOrders(): Promise<CachedOrder[]> {
		const { user, accountId } = this.requireClient();
		await user.fetchInfo();
		const existingOrders = (user.orders[accountId] ?? []) as ApiOrder[];
		return mapApiOrdersToCached(
			existingOrders.filter((o) => o.marketId === this.marketId),
		);
	}

	async updateQuotes(
		cancels: CachedOrder[],
		places: Quote[],
	): Promise<CachedOrder[]> {
		const { user } = this.requireClient();
		return zoExecuteQuoteUpdate(user, this.marketId, cancels, places);
	}

	async cancelOrders(orders: CachedOrder[]): Promise<void> {
		const { user } = this.requireClient();
		await zoCancel(user, orders);
	}

	async closePosition(baseSize: number, price: string): Promise<void> {
		const { user } = this.requireClient();
		await zoClose(user, this.marketId, baseSize, price);
	}

	async fetchPosition(): Promise<{ baseSize: number }> {
		const { user, accountId } = this.requireClient();
		await user.fetchInfo();

		const positions = user.positions[accountId] || [];
		const pos = positions.find(
			(p: { marketId: number }) => p.marketId === this.marketId,
		);

		const baseSize = pos?.perp
			? pos.perp.isLong
				? pos.perp.baseSize
				: -pos.perp.baseSize
			: 0;

		return { baseSize };
	}

	async fetchTrades(since: string): Promise<TradeRecord[]> {
		const { nord, accountId } = this.requireClient();

		// Query for trades where we are the maker or taker
		const [makerResponse, takerResponse] = await Promise.all([
			nord.getTrades({
				makerId: accountId,
				marketId: this.marketId,
				since,
			}),
			nord.getTrades({
				takerId: accountId,
				marketId: this.marketId,
				since,
			}),
		]);

		// Merge and deduplicate by tradeId
		const allTrades = new Map<number, (typeof makerResponse.items)[number]>();
		for (const trade of makerResponse.items) {
			allTrades.set(trade.tradeId, trade);
		}
		for (const trade of takerResponse.items) {
			allTrades.set(trade.tradeId, trade);
		}

		// Sort by tradeId (chronological) and map to TradeRecord
		return [...allTrades.values()]
			.sort((a, b) => a.tradeId - b.tradeId)
			.map((trade) => {
				const isMaker = trade.makerId === accountId;
				// Our side: if we're the maker, our side is opposite of takerSide
				const side: "bid" | "ask" = isMaker
					? (trade.takerSide === "bid" ? "ask" : "bid")
					: trade.takerSide;
				return {
					tradeId: trade.tradeId,
					side,
					baseSize: trade.baseSize,
					price: trade.price,
					isMaker,
				};
			});
	}

	async fetchBalanceSnapshot(): Promise<BalanceSnapshot> {
		const { user, accountId } = this.requireClient();
		await user.fetchInfo();

		const balanceEntries = user.balances[accountId] ?? [];
		const balance = balanceEntries.length > 0 ? balanceEntries[0].balance : 0;

		const fundingPnlByMarket = new Map<number, number>();
		const positions = user.positions[accountId] ?? [];
		for (const pos of positions) {
			if (pos.perp) {
				fundingPnlByMarket.set(pos.marketId, pos.perp.fundingPaymentPnl);
			}
		}

		return { balance, fundingPnlByMarket };
	}

	async fetchFeeRates(): Promise<FeeRateInfo> {
		const { nord, accountId } = this.requireClient();

		const [tierId, brackets] = await Promise.all([
			nord.getAccountFeeTier(accountId),
			nord.getFeeBrackets(),
		]);
		const bracket = brackets.find(([id]) => id === tierId);
		if (!bracket) {
			throw new Error(`Fee tier ${tierId} not found in brackets`);
		}
		const [, config] = bracket;
		return {
			feeTierId: tierId,
			makerFeePpm: config.maker_fee_ppm,
			takerFeePpm: config.taker_fee_ppm,
		};
	}

	getMidPrice(): MidPrice | null {
		return this.orderbookStream?.getMidPrice() ?? null;
	}

	getBBO(): BBO | null {
		return this.orderbookStream?.getBBO() ?? null;
	}

	private requireClient(): ZoClient {
		if (!this.client) {
			throw new Error("ZoAdapter not connected");
		}
		return this.client;
	}
}
