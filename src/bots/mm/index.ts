// MarketMaker - main bot logic

import type { NordUser } from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { DebouncedFunc } from "lodash-es";
import { throttle } from "lodash-es";
import { BinancePriceFeed } from "../../pricing/binance.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
	type FairPriceProvider,
} from "../../pricing/fair-price.js";
import { AccountStream, type FillEvent } from "../../sdk/account.js";
import { createZoClient, type ZoClient } from "../../sdk/client.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import {
	type CachedOrder,
	cancelOrders,
	closePosition,
	updateQuotes,
} from "../../sdk/orders.js";
import type { MidPrice } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { MarketMakerConfig } from "./config.js";
import { type PositionConfig, PositionTracker } from "./position.js";
import { Quoter } from "./quoter.js";

export type { MarketMakerConfig } from "./config.js";

// API order type from SDK
interface ApiOrder {
	orderId: bigint | number;
	marketId: number;
	side: "bid" | "ask";
	price: number | string;
	size: number | string;
}

// Convert API orders to cached orders
function mapApiOrdersToCached(orders: ApiOrder[]): CachedOrder[] {
	return orders.map((o) => ({
		orderId: o.orderId.toString(),
		side: o.side,
		price: new Decimal(o.price),
		size: new Decimal(o.size),
	}));
}

// Derive Binance symbol from market symbol (e.g., "BTC-PERP" → "btcusdt")
function deriveBinanceSymbol(marketSymbol: string): string {
	const baseSymbol = marketSymbol
		.replace(/-PERP$/i, "")
		.replace(/USD$/i, "")
		.toLowerCase();
	return `${baseSymbol}usdt`;
}

export class MarketMaker {
	private client: ZoClient | null = null;
	private marketId = 0;
	private marketSymbol = "";
	private priceDecimals = 2;
	private sizeDecimals = 4;
	private accountStream: AccountStream | null = null;
	private orderbookStream: ZoOrderbookStream | null = null;
	private binanceFeed: BinancePriceFeed | null = null;
	private fairPriceCalc: FairPriceProvider | null = null;
	private positionTracker: PositionTracker | null = null;
	private quoter: Quoter | null = null;
	private isRunning = false;
	private lastLoggedSampleCount = -1;
	private activeOrders: CachedOrder[] = [];
	private isUpdating = false;
	private throttledUpdate: DebouncedFunc<
		(fairPrice: number) => Promise<void>
	> | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;
	private orderSyncInterval: ReturnType<typeof setInterval> | null = null;
	private lastTickTimestamp = 0;
	private lastT2T = 0;
	private t2tSamples: number[] = [];

	constructor(
		private readonly config: MarketMakerConfig,
		private readonly privateKey: string,
	) {}

	private requireClient(): ZoClient {
		if (!this.client) {
			throw new Error("Client not initialized");
		}
		return this.client;
	}

	async run(): Promise<void> {
		log.banner();

		await this.initialize();
		this.setupEventHandlers();
		await this.syncInitialOrders();
		this.startIntervals();
		this.registerShutdownHandlers();

		log.info("Warming up price feeds...");
		await this.waitForever();
	}

	private async initialize(): Promise<void> {
		this.throttledUpdate = throttle(
			(fairPrice: number) => this.executeUpdate(fairPrice),
			this.config.updateThrottleMs,
			{ leading: true, trailing: true },
		);

		this.client = await createZoClient(this.privateKey);
		const { nord, accountId } = this.client;

		// Find market by symbol (e.g., "BTC" matches "BTC-PERP")
		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.config.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(
				`Market "${this.config.symbol}" not found. Available: ${available}`,
			);
		}
		this.marketId = market.marketId;
		this.marketSymbol = market.symbol;
		this.priceDecimals = market.priceDecimals;
		this.sizeDecimals = market.sizeDecimals;

		const binanceSymbol = deriveBinanceSymbol(market.symbol);
		this.logConfig(binanceSymbol);

		// Initialize strategy components
		const fairPriceConfig: FairPriceConfig = {
			windowMs: this.config.fairPriceWindowMs,
			minSamples: this.config.warmupSeconds,
		};
		const positionConfig: PositionConfig = {
			closeThresholdUsd: this.config.closeThresholdUsd,
			syncIntervalMs: this.config.positionSyncIntervalMs,
		};

		this.fairPriceCalc = new FairPriceCalculator(fairPriceConfig);
		this.positionTracker = new PositionTracker(positionConfig);
		this.quoter = new Quoter(
			market.priceDecimals,
			market.sizeDecimals,
			this.config.spreadBps,
			this.config.takeProfitBps,
			this.config.orderSizeUsd,
		);

		// Initialize streams
		this.accountStream = new AccountStream(
			nord, accountId,
			this.config.staleThresholdMs, this.config.staleCheckIntervalMs,
		);
		this.orderbookStream = new ZoOrderbookStream(
			nord, this.marketSymbol, undefined,
			this.config.staleThresholdMs, this.config.staleCheckIntervalMs,
		);
		this.binanceFeed = new BinancePriceFeed(
			binanceSymbol,
			this.config.staleThresholdMs, this.config.staleCheckIntervalMs,
		);

		this.isRunning = true;
	}

	private setupEventHandlers(): void {
		const { user, accountId } = this.requireClient();

		// Account stream - fill events
		this.accountStream?.syncOrders(user, accountId);
		this.accountStream?.setOnFill((fill: FillEvent) => {
			if (fill.marketId !== this.marketId) return;

			const fillPnL =
				this.positionTracker?.applyFill(fill.side, fill.size, fill.price) ?? 0;

			log.fill(
				fill.side === "bid" ? "buy" : "sell",
				fill.price,
				fill.size,
				fillPnL !== 0 ? fillPnL : undefined,
				this.positionTracker?.getRealizedPnL(),
			);

			if (this.positionTracker?.isCloseMode(fill.price)) {
				this.cancelOrdersAsync();
			}
		});

		// Position drift handler — cancel orders if drift puts us in close mode
		this.positionTracker?.setOnDrift((_sizeDelta, _newBaseSize) => {
			const markPrice = this.binanceFeed?.getMidPrice()?.mid ?? 0;
			if (markPrice > 0 && this.positionTracker?.isCloseMode(markPrice)) {
				log.warn("Drift triggered close mode — cancelling orders");
				this.cancelOrdersAsync();
			}
		});

		// Price feeds
		if (this.binanceFeed) {
			this.binanceFeed.onPrice = (price) => this.handleBinancePrice(price);
		}
		if (this.orderbookStream) {
			this.orderbookStream.onPrice = (price) => this.handleZoPrice(price);
		}

		// Start connections
		this.accountStream?.connect();
		this.orderbookStream?.connect();
		this.binanceFeed?.connect();
	}

	private handleBinancePrice(binancePrice: MidPrice): void {
		if (binancePrice.tickTimestamp !== undefined) {
			this.lastTickTimestamp = binancePrice.tickTimestamp;
		}

		const zoPrice = this.orderbookStream?.getMidPrice();
		if (
			zoPrice &&
			Math.abs(binancePrice.timestamp - zoPrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, binancePrice.mid);
		}

		if (!this.isRunning) return;

		const fairPrice = this.fairPriceCalc?.getFairPrice(binancePrice.mid);
		if (!fairPrice) {
			this.logWarmupProgress(binancePrice);
			return;
		}

		// Feed mark price to position tracker for missed-fill PnL
		this.positionTracker?.setMarkPrice(fairPrice);

		// Log ready on first valid fair price
		if (this.lastLoggedSampleCount < this.config.warmupSeconds) {
			this.lastLoggedSampleCount = this.config.warmupSeconds;
			log.info(`Ready! Fair price: $${fairPrice.toFixed(2)}`);
		}

		this.throttledUpdate?.(fairPrice);
	}

	private handleZoPrice(zoPrice: MidPrice): void {
		const binancePrice = this.binanceFeed?.getMidPrice();
		if (
			binancePrice &&
			Math.abs(zoPrice.timestamp - binancePrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, binancePrice.mid);
		}
	}

	private logWarmupProgress(binancePrice: MidPrice): void {
		const state = this.fairPriceCalc?.getState();
		if (!state || state.samples === this.lastLoggedSampleCount) return;

		this.lastLoggedSampleCount = state.samples;
		const zoPrice = this.orderbookStream?.getMidPrice();
		const offsetBps =
			state.offset !== null && binancePrice.mid > 0
				? ((state.offset / binancePrice.mid) * 10000).toFixed(1)
				: "--";
		log.info(
			`Warming up: ${state.samples}/${this.config.warmupSeconds} samples | Binance $${binancePrice.mid.toFixed(2)} | 01 $${zoPrice?.mid.toFixed(2) ?? "--"} | Offset ${offsetBps}bps`,
		);
	}

	private async syncInitialOrders(): Promise<void> {
		const { user, accountId } = this.requireClient();

		await user.fetchInfo();
		const existingOrders = (user.orders[accountId] ?? []) as ApiOrder[];
		const marketOrders = existingOrders.filter(
			(o) => o.marketId === this.marketId,
		);
		this.activeOrders = mapApiOrdersToCached(marketOrders);

		if (this.activeOrders.length > 0) {
			log.info(`Synced ${this.activeOrders.length} existing orders`);
		}

		// Start position sync
		this.positionTracker?.startSync(user, accountId, this.marketId);
	}

	private startIntervals(): void {
		const { user, accountId } = this.requireClient();

		// Status display
		this.statusInterval = setInterval(() => {
			this.logStatus();
		}, this.config.statusIntervalMs);

		// Order sync
		this.orderSyncInterval = setInterval(() => {
			this.syncOrders(user, accountId);
		}, this.config.orderSyncIntervalMs);
	}

	private isShuttingDown = false;

	private registerShutdownHandlers(): void {
		const shutdown = () => this.shutdown();
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) {
			log.warn("SHUTDOWN: already in progress, ignoring duplicate signal");
			return;
		}
		this.isShuttingDown = true;

		log.info("SHUTDOWN: signal received, starting cleanup...");
		this.isRunning = false;
		this.throttledUpdate?.cancel();
		this.positionTracker?.stopSync();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.orderSyncInterval) {
			clearInterval(this.orderSyncInterval);
			this.orderSyncInterval = null;
		}

		// Capture mark price while feeds are still available
		const binancePrice = this.binanceFeed?.getMidPrice();
		const fairPrice = binancePrice
			? this.fairPriceCalc?.getFairPrice(binancePrice.mid)
			: null;
		const markPrice = fairPrice ?? binancePrice?.mid ?? 0;
		log.info(`SHUTDOWN: mark price = ${markPrice}`);

		// Cancel orders — ignore ORDER_NOT_FOUND (already filled/expired)
		try {
			if (this.activeOrders.length > 0 && this.client) {
				log.info(`SHUTDOWN: cancelling ${this.activeOrders.length} orders...`);
				await cancelOrders(this.client.user, this.activeOrders);
				log.info("SHUTDOWN: orders cancelled");
				this.activeOrders = [];
			} else {
				log.info(`SHUTDOWN: no active orders (tracked: ${this.activeOrders.length}, client: ${!!this.client})`);
			}
		} catch (err) {
			log.error("SHUTDOWN: cancel orders failed (continuing):", err);
		}

		// Close open position — independent of order cancellation
		try {
			const baseSize = this.positionTracker?.getBaseSize() ?? 0;
			if (Math.abs(baseSize) > 1e-10 && this.client && markPrice > 0) {
				log.info(`SHUTDOWN: closing position ${baseSize} @ mark ${markPrice}...`);
				const slippage = markPrice * 0.005;
				const closePrice = baseSize > 0
					? (markPrice - slippage).toFixed(this.priceDecimals)
					: (markPrice + slippage).toFixed(this.priceDecimals);
				await closePosition(
					this.client.user,
					this.marketId,
					baseSize,
					closePrice,
				);
				log.info("SHUTDOWN: position closed");
			} else {
				log.info(`SHUTDOWN: no position to close (size: ${baseSize}, client: ${!!this.client}, mark: ${markPrice})`);
			}
		} catch (err) {
			log.error("SHUTDOWN: close position failed:", err);
		}

		// Close feeds after cleanup (SDK may need connection for API calls)
		this.accountStream?.close();
		this.binanceFeed?.close();
		this.orderbookStream?.close();

		if (this.positionTracker) {
			const summary = this.positionTracker.getSessionSummary(markPrice);
			log.sessionSummary(summary);
		}

		log.info("SHUTDOWN: complete");
		process.exit(0);
	}

	private async waitForever(): Promise<void> {
		await new Promise(() => {});
	}

	private async executeUpdate(fairPrice: number): Promise<void> {
		if (this.isUpdating) return;
		this.isUpdating = true;

		try {
			if (!this.positionTracker || !this.quoter || !this.client) {
				return;
			}

			const quotingCtx = this.positionTracker.getQuotingContext(fairPrice);
			const { positionState } = quotingCtx;

			if (positionState.sizeBase !== 0) {
				const uPnL =
					this.positionTracker?.getUnrealizedPnL(fairPrice) ?? 0;
				log.position(
					positionState.sizeBase,
					positionState.sizeUsd,
					positionState.isLong,
					positionState.isCloseMode,
					positionState.avgEntryPrice,
					uPnL,
				);
			}

			const bbo = this.orderbookStream?.getBBO() ?? null;
			const quotes = this.quoter.getQuotes(quotingCtx, bbo);

			if (quotes.length === 0) {
				log.warn("No quotes generated (order size too small)");
				return;
			}

			const bid = quotes.find((q) => q.side === "bid");
			const ask = quotes.find((q) => q.side === "ask");
			const isClose = positionState.isCloseMode;
			const spreadBps = isClose
				? this.config.takeProfitBps
				: this.config.spreadBps;
			log.quote(
				bid?.price.toNumber() ?? null,
				ask?.price.toNumber() ?? null,
				fairPrice,
				spreadBps,
				isClose ? "close" : "normal",
			);

			const prevOrders = this.activeOrders;
			const newOrders = await updateQuotes(
				this.client.user,
				this.marketId,
				this.activeOrders,
				quotes,
			);
			this.activeOrders = newOrders;

			// Record T2T only when orders were actually submitted to the exchange
			if (newOrders !== prevOrders && this.lastTickTimestamp > 0) {
				const t2t = performance.now() - this.lastTickTimestamp;
				this.lastT2T = t2t;
				this.t2tSamples.push(t2t);
				if (this.t2tSamples.length > 100) this.t2tSamples.shift();
			}
		} catch (err) {
			log.error("Update error:", err);
			this.activeOrders = [];
		} finally {
			this.isUpdating = false;
		}
	}

	private logConfig(binanceSymbol: string): void {
		log.config({
			Market: this.marketSymbol,
			Binance: binanceSymbol,
			Spread: `${this.config.spreadBps} bps`,
			"Take Profit": `${this.config.takeProfitBps} bps`,
			"Order Size": `$${this.config.orderSizeUsd}`,
			"Close Mode": `>=$${this.config.closeThresholdUsd}`,
		});
	}

	private cancelOrdersAsync(): void {
		if (this.activeOrders.length === 0 || !this.client) return;
		const orders = this.activeOrders;
		cancelOrders(this.client.user, orders)
			.then(() => {
				this.activeOrders = [];
			})
			.catch((err) => {
				log.error("Failed to cancel orders:", err);
				this.activeOrders = [];
			});
	}

	private syncOrders(user: NordUser, accountId: number): void {
		user
			.fetchInfo()
			.then(() => {
				const apiOrders = (user.orders[accountId] ?? []) as ApiOrder[];
				const marketOrders = apiOrders.filter(
					(o) => o.marketId === this.marketId,
				);
				this.activeOrders = mapApiOrdersToCached(marketOrders);
			})
			.catch((err) => {
				log.error("Order sync error:", err);
			});
	}

	private logStatus(): void {
		if (!this.isRunning) return;

		const pos = this.positionTracker?.getBaseSize() ?? 0;
		const bids = this.activeOrders.filter((o) => o.side === "bid");
		const asks = this.activeOrders.filter((o) => o.side === "ask");

		const formatOrder = (o: CachedOrder) =>
			`$${o.price.toFixed(2)}x${o.size.toString()}`;

		const bidStr = bids.map(formatOrder).join(",") || "-";
		const askStr = asks.map(formatOrder).join(",") || "-";

		const entry = this.positionTracker?.getAvgEntryPrice() ?? 0;
		const rPnL = this.positionTracker?.getRealizedPnL() ?? 0;

		// Get fair price for unrealized PnL
		const binancePrice = this.binanceFeed?.getMidPrice();
		const fairPrice = binancePrice
			? this.fairPriceCalc?.getFairPrice(binancePrice.mid)
			: null;
		const uPnL = fairPrice
			? (this.positionTracker?.getUnrealizedPnL(fairPrice) ?? 0)
			: 0;

		const entryStr = entry > 0 ? ` entry=$${entry.toFixed(2)}` : "";
		const rSign = rPnL >= 0 ? "+" : "";
		const uSign = uPnL >= 0 ? "+" : "";

		let t2tStr = "";
		if (this.lastT2T > 0) {
			const avg =
				this.t2tSamples.reduce((a, b) => a + b, 0) / this.t2tSamples.length;
			t2tStr = ` | t2t=${this.lastT2T.toFixed(1)}ms avg=${avg.toFixed(1)}ms`;
		}

		log.info(
			`STATUS: pos=${pos.toFixed(5)}${entryStr} | uPnL=${uSign}$${uPnL.toFixed(4)} | rPnL=${rSign}$${rPnL.toFixed(4)}${t2tStr} | bid=[${bidStr}] | ask=[${askStr}]`,
		);
	}
}
