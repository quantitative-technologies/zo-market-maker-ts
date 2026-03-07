// MarketMaker - main bot logic

import type { DebouncedFunc } from "lodash-es";
import { throttle } from "lodash-es";
import { BinancePriceFeed } from "../../pricing/binance.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
	type FairPriceProvider,
} from "../../pricing/fair-price.js";
import type { ExchangeAdapter } from "../../exchanges/adapter.js";
import { diffOrders } from "../../orders.js";
import type { CachedOrder, FillEvent, MidPrice } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { MarketMakerConfig } from "./config.js";
import { type PositionConfig, PositionTracker } from "./position.js";
import { Quoter } from "./quoter.js";

export type { MarketMakerConfig } from "./config.js";

// Classify atomic errors by inspecting SDK cause chain.
// Positively identifies known-safe cases; everything else is a network error
// where exchange state is unknown.
// SDK paths:
//   Exchange rejection: NordError("Atomic operation failed") → cause: Error("Could not execute ...")
//   HTTP error:         NordError("Atomic operation failed") → cause: Error("Failed to ...")
//   Client validation:  NordError("Account ID is undefined" | "Market X not found") — no wrapping
//   Network error:      NordError("Atomic operation failed") → cause: native Error (fetch failure)
type AtomicErrorKind = "exchange_rejection" | "http_error" | "client_error" | "network_error";

function classifyAtomicError(err: unknown): AtomicErrorKind {
	if (!(err instanceof Error)) return "network_error";

	const cause = (err as { cause?: unknown }).cause;

	// Client-side validation errors are thrown directly (not wrapped as "Atomic operation failed")
	if (err.message !== "Atomic operation failed") return "client_error";

	if (cause instanceof Error) {
		const msg = cause.message;
		if (msg.startsWith("Could not execute")) return "exchange_rejection";
		if (msg.startsWith("Failed to")) return "http_error";
	}

	return "network_error";
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
	private marketSymbol = "";
	private priceDecimals = 2;
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
		private readonly adapter: ExchangeAdapter,
	) {}

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

		const marketInfo = await this.adapter.connect();
		this.marketSymbol = marketInfo.symbol;
		this.priceDecimals = marketInfo.priceDecimals;

		const binanceSymbol = deriveBinanceSymbol(marketInfo.symbol);
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
			marketInfo.priceDecimals,
			marketInfo.sizeDecimals,
			this.config.spreadBps,
			this.config.takeProfitBps,
			this.config.orderSizeUsd,
		);

		// Initialize Binance reference feed
		this.binanceFeed = new BinancePriceFeed(
			binanceSymbol,
			this.config.staleThresholdMs, this.config.staleCheckIntervalMs,
		);

		this.isRunning = true;
	}

	private setupEventHandlers(): void {
		// Exchange adapter fill events
		this.adapter.onFill = (fill: FillEvent) => {
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
		};

		// Exchange adapter orderbook price
		this.adapter.onPrice = (price: MidPrice) => this.handleExchangePrice(price);

		// Position drift handler — cancel orders if drift puts us in close mode
		this.positionTracker?.setOnDrift((_sizeDelta, _newBaseSize) => {
			const markPrice = this.binanceFeed?.getMidPrice()?.mid ?? 0;
			if (markPrice > 0 && this.positionTracker?.isCloseMode(markPrice)) {
				log.warn("Drift triggered close mode — cancelling orders");
				this.cancelOrdersAsync();
			}
		});

		// Binance reference price feed
		if (this.binanceFeed) {
			this.binanceFeed.onPrice = (price) => this.handleBinancePrice(price);
		}

		// Start Binance feed (exchange adapter streams started in connect())
		this.binanceFeed?.connect();
	}

	private handleBinancePrice(binancePrice: MidPrice): void {
		if (binancePrice.tickTimestamp !== undefined) {
			this.lastTickTimestamp = binancePrice.tickTimestamp;
		}

		const exchangePrice = this.adapter.getMidPrice();
		if (
			exchangePrice &&
			Math.abs(binancePrice.timestamp - exchangePrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(exchangePrice.mid, binancePrice.mid);
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

	private handleExchangePrice(exchangePrice: MidPrice): void {
		const binancePrice = this.binanceFeed?.getMidPrice();
		if (
			binancePrice &&
			Math.abs(exchangePrice.timestamp - binancePrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(exchangePrice.mid, binancePrice.mid);
		}
	}

	private logWarmupProgress(binancePrice: MidPrice): void {
		const state = this.fairPriceCalc?.getState();
		if (!state || state.samples === this.lastLoggedSampleCount) return;

		this.lastLoggedSampleCount = state.samples;
		const exchangePrice = this.adapter.getMidPrice();
		const offsetBps =
			state.offset !== null && binancePrice.mid > 0
				? ((state.offset / binancePrice.mid) * 10000).toFixed(1)
				: "--";
		log.info(
			`Warming up: ${state.samples}/${this.config.warmupSeconds} samples | Binance $${binancePrice.mid.toFixed(2)} | ${this.adapter.name} $${exchangePrice?.mid.toFixed(2) ?? "--"} | Offset ${offsetBps}bps`,
		);
	}

	private async syncInitialOrders(): Promise<void> {
		this.activeOrders = await this.adapter.syncOrders();
		log.info(`Synced ${this.activeOrders.length} existing orders`);

		// Start position sync
		this.positionTracker?.startSync(() => this.adapter.fetchPosition());
	}

	private startIntervals(): void {
		// Status display
		this.statusInterval = setInterval(() => {
			this.logStatus();
		}, this.config.statusIntervalMs);

		// Order sync
		this.orderSyncInterval = setInterval(() => {
			this.syncOrders();
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

		// Cancel orders
		try {
			if (this.activeOrders.length > 0) {
				log.info(`SHUTDOWN: cancelling ${this.activeOrders.length} orders...`);
				await this.adapter.cancelOrders(this.activeOrders);
				log.info("SHUTDOWN: orders cancelled");
				this.activeOrders = [];
			} else {
				log.info("SHUTDOWN: no active orders");
			}
		} catch (err) {
			log.error("SHUTDOWN: cancel orders failed (continuing):", err);
		}

		// Close open position
		try {
			const baseSize = this.positionTracker?.getBaseSize() ?? 0;
			if (Math.abs(baseSize) > 1e-10 && markPrice > 0) {
				log.info(`SHUTDOWN: closing position ${baseSize} @ mark ${markPrice}...`);
				const slippage = markPrice * 0.005;
				const closePrice = baseSize > 0
					? (markPrice - slippage).toFixed(this.priceDecimals)
					: (markPrice + slippage).toFixed(this.priceDecimals);
				await this.adapter.closePosition(baseSize, closePrice);
				log.info("SHUTDOWN: position closed");
			} else {
				log.info(`SHUTDOWN: no position to close (size: ${baseSize}, mark: ${markPrice})`);
			}
		} catch (err) {
			log.error("SHUTDOWN: close position failed:", err);
		}

		// Close feeds after cleanup
		this.binanceFeed?.close();
		await this.adapter.close();

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
			if (!this.positionTracker || !this.quoter) {
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

			const bbo = this.adapter.getBBO();
			const quotes = this.quoter.getQuotes(quotingCtx, bbo);

			if (quotes.length === 0) {
				log.debug("No quotes generated (order size too small)");
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

			const { kept, toCancel, toPlace } = diffOrders(this.activeOrders, quotes);

			if (toCancel.length === 0 && toPlace.length === 0) {
				return;
			}

			const prevOrders = this.activeOrders;
			const placedOrders = await this.adapter.updateQuotes(toCancel, toPlace);
			this.activeOrders = [...kept, ...placedOrders];

			// Record T2T only when orders were actually submitted to the exchange
			if (this.activeOrders !== prevOrders && this.lastTickTimestamp > 0) {
				const t2t = performance.now() - this.lastTickTimestamp;
				this.lastT2T = t2t;
				this.t2tSamples.push(t2t);
				if (this.t2tSamples.length > 100) this.t2tSamples.shift();
			}
		} catch (err) {
			const kind = classifyAtomicError(err);
			switch (kind) {
				case "exchange_rejection":
					log.warn("Atomic rejected by exchange, will retry next cycle:", err);
					break;
				case "http_error":
					log.error("HTTP error in atomic — exchange state unchanged:", err);
					break;
				case "client_error":
					log.error("Client-side error — nothing sent to exchange:", err);
					break;
				case "network_error":
					log.error("NETWORK ERROR in update — exchange state unknown, awaiting periodic sync:", err);
					break;
			}
		} finally {
			this.isUpdating = false;
		}
	}

	private logConfig(binanceSymbol: string): void {
		log.config({
			Exchange: this.adapter.name,
			Market: this.marketSymbol,
			Binance: binanceSymbol,
			Spread: `${this.config.spreadBps} bps`,
			"Take Profit": `${this.config.takeProfitBps} bps`,
			"Order Size": `$${this.config.orderSizeUsd}`,
			"Close Mode": `>=$${this.config.closeThresholdUsd}`,
		});
	}

	private cancelOrdersAsync(): void {
		if (this.activeOrders.length === 0) return;
		const orders = this.activeOrders;
		this.adapter.cancelOrders(orders)
			.then(() => {
				this.activeOrders = [];
			})
			.catch((err) => {
				log.error("Failed to cancel orders:", err);
				// Preserve activeOrders — next syncOrders will reconcile with exchange state
			});
	}

	private syncOrders(): void {
		this.adapter.syncOrders()
			.then((orders) => {
				this.activeOrders = orders;
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
