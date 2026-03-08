// Position Tracker with optimistic updates + periodic sync

import type { TradeRecord } from "../../exchanges/adapter.js";
import { FMT_DECIMALS, log } from "../../utils/logger.js";

// Floating point epsilon for position size zero-comparison.
// Workaround until position sizes migrate to Decimal (see TODO-decimal-migration.md).
export const POSITION_EPSILON = 1e-10;

export interface PositionState {
	readonly sizeBase: number;
	readonly sizeUsd: number;
	readonly isLong: boolean;
	readonly isCloseMode: boolean;
	readonly avgEntryPrice: number;
}

export interface QuotingContext {
	readonly fairPrice: number;
	readonly positionState: PositionState;
	readonly allowedSides: readonly ("bid" | "ask")[];
}

export interface PnLState {
	readonly avgEntryPrice: number;
	readonly realizedPnL: number;
	readonly unrealizedPnL: number;
	readonly fillCount: number;
	readonly totalVolumeUsd: number;
}

export interface SessionSummary {
	readonly uptimeMs: number;
	readonly fillCount: number;
	readonly totalVolumeUsd: number;
	readonly realizedPnL: number;
	readonly unrealizedPnL: number;
	readonly netPnL: number;
	readonly avgSpreadCapturedBps: number;
}

export interface RecoveredTrade {
	readonly side: "bid" | "ask";
	readonly size: number;
	readonly price: number;
	readonly realizedPnL: number;
	readonly fee: number;
	readonly isMaker: boolean;
	readonly tradeId: number;
}

export interface FillRecoveryResult {
	readonly trades: RecoveredTrade[];
	readonly totalRealizedPnL: number;
	readonly totalFees: number;
}

type DriftCallback = (sizeDelta: number, newBaseSize: number) => void;
type FetchPosition = () => Promise<{ baseSize: number }>;
type FetchTrades = (since: string) => Promise<TradeRecord[]>;

export interface PositionConfig {
	readonly closeThresholdUsd: number; // Trigger close mode when position >= this
	readonly syncIntervalMs: number;
}

export class PositionTracker {
	private baseSize = 0;
	private isRunning = false;
	private avgEntryPrice = 0;
	private realizedPnL = 0;
	private fillCount = 0;
	private totalVolumeUsd = 0;
	private sessionStartTime = Date.now();
	private onDrift: DriftCallback | null = null;
	private lastMarkPrice = 0;
	private lastSyncTime: string | null = null;
	private lastTradeId = 0;
	private fetchTrades: FetchTrades | null = null;
	private makerFeePpm = 0;
	private takerFeePpm = 0;

	constructor(private readonly config: PositionConfig) {}

	setOnDrift(callback: DriftCallback): void {
		this.onDrift = callback;
	}

	setMarkPrice(price: number): void {
		this.lastMarkPrice = price;
	}

	setFeeRates(makerFeePpm: number, takerFeePpm: number): void {
		this.makerFeePpm = makerFeePpm;
		this.takerFeePpm = takerFeePpm;
	}

	startSync(
		fetchPosition: FetchPosition,
		fetchTrades?: FetchTrades,
	): void {
		this.isRunning = true;
		this.fetchTrades = fetchTrades ?? null;
		this.lastSyncTime = new Date().toISOString();
		this.syncLoop(fetchPosition);
	}

	stopSync(): void {
		this.isRunning = false;
	}

	async reconcileWithExchange(fetchPosition: FetchPosition): Promise<void> {
		await this.syncFromServer(fetchPosition);
	}

	private async syncLoop(
		fetchPosition: () => Promise<{ baseSize: number }>,
	): Promise<void> {
		await this.syncFromServer(fetchPosition);

		while (this.isRunning) {
			await this.sleep(this.config.syncIntervalMs);
			if (!this.isRunning) break;
			await this.syncFromServer(fetchPosition);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async syncFromServer(
		fetchPosition: FetchPosition,
	): Promise<void> {
		try {
			const { baseSize: serverSize } = await fetchPosition();
			const d = FMT_DECIMALS;

			const sizeDiscrepancy = Math.abs(serverSize - this.baseSize) > 0.0001;

			if (sizeDiscrepancy) {
				log.warn(
					`Position sync: size mismatch — local=${this.baseSize.toFixed(d.SIZE)}, server=${serverSize.toFixed(d.SIZE)}`,
				);

				// Attempt fill recovery via getTrades()
				const recovery = await this.recoverMissedFills();
				if (recovery && recovery.trades.length > 0) {
					for (const trade of recovery.trades) {
						log.fill(
							trade.side === "bid" ? "buy" : "sell",
							trade.price,
							trade.size,
							trade.realizedPnL !== 0 ? trade.realizedPnL : undefined,
							this.realizedPnL,
						);
						log.warn(
							`Recovered fill: ${trade.side} ${trade.size} @ $${trade.price.toFixed(d.PRICE)} (${trade.isMaker ? "maker" : "taker"}, fee=$${trade.fee.toFixed(d.QUOTE)})`,
						);
					}
				}

				// After recovery, force-overwrite local state from exchange truth
				if (this.baseSize !== serverSize) {
					log.warn(
						`Position sync: overwriting local state — size ${this.baseSize.toFixed(d.SIZE)} → ${serverSize.toFixed(d.SIZE)}`,
					);
					this.baseSize = serverSize;
				}

				// Notify bot about drift (e.g., to enter close mode)
				if (this.onDrift) {
					this.onDrift(serverSize - this.baseSize, this.baseSize);
				}
			}

			this.lastSyncTime = new Date().toISOString();
		} catch (err) {
			log.error("Position sync error:", err);
		}
	}

	private async recoverMissedFills(): Promise<FillRecoveryResult | null> {
		if (!this.fetchTrades || !this.lastSyncTime) return null;

		try {
			const trades = await this.fetchTrades(this.lastSyncTime);

			// Filter to trades we haven't seen
			const newTrades = trades.filter((t) => t.tradeId > this.lastTradeId);
			if (newTrades.length === 0) return { trades: [], totalRealizedPnL: 0, totalFees: 0 };

			const recovered: RecoveredTrade[] = [];
			let totalRealizedPnL = 0;
			let totalFees = 0;

			for (const trade of newTrades) {
				const feePpm = trade.isMaker ? this.makerFeePpm : this.takerFeePpm;
				const fee = (trade.baseSize * trade.price * feePpm) / 1_000_000;

				const fillRealizedPnL = this.applyFill(
					trade.side,
					trade.baseSize,
					trade.price,
				);

				recovered.push({
					side: trade.side,
					size: trade.baseSize,
					price: trade.price,
					realizedPnL: fillRealizedPnL,
					fee,
					isMaker: trade.isMaker,
					tradeId: trade.tradeId,
				});

				totalRealizedPnL += fillRealizedPnL;
				totalFees += fee;
				this.lastTradeId = trade.tradeId;
			}

			const d = FMT_DECIMALS;
			log.info(
				`Fill recovery: ${recovered.length} trades recovered, rPnL=$${totalRealizedPnL.toFixed(d.QUOTE)}, fees=$${totalFees.toFixed(d.QUOTE)}`,
			);

			return { trades: recovered, totalRealizedPnL, totalFees };
		} catch (err) {
			log.error("Fill recovery via getTrades() failed:", err);
			return null;
		}
	}

	applyFill(side: "bid" | "ask", size: number, price: number): number {
		const previousBase = this.baseSize;
		const fillSign = side === "bid" ? 1 : -1;

		this.fillCount++;
		this.totalVolumeUsd += size * price;

		const isIncreasing =
			previousBase === 0 ||
			(previousBase > 0 && fillSign > 0) ||
			(previousBase < 0 && fillSign < 0);

		let fillRealizedPnL = 0;

		if (isIncreasing) {
			// Opening or adding: update weighted avg entry
			const previousCost = Math.abs(previousBase) * this.avgEntryPrice;
			const fillCost = size * price;
			const newAbsSize = Math.abs(previousBase) + size;
			this.avgEntryPrice =
				newAbsSize > 0 ? (previousCost + fillCost) / newAbsSize : price;
		} else {
			// Reducing or flipping
			const reducingSize = Math.min(size, Math.abs(previousBase));
			const remainingSize = size - reducingSize;

			if (previousBase > 0) {
				fillRealizedPnL = (price - this.avgEntryPrice) * reducingSize;
			} else {
				fillRealizedPnL = (this.avgEntryPrice - price) * reducingSize;
			}
			this.realizedPnL += fillRealizedPnL;

			if (remainingSize > 0) {
				// Flipped: remainder opens new position at fill price
				this.avgEntryPrice = price;
			} else if (Math.abs(previousBase + size * fillSign) < POSITION_EPSILON) {
				// Fully closed
				this.avgEntryPrice = 0;
			}
			// Partially reduced: avgEntryPrice stays the same
		}

		this.baseSize = previousBase + size * fillSign;

		const d = FMT_DECIMALS;
		log.debug(
			`Position updated: ${this.baseSize.toFixed(d.SIZE)} (${side} ${size} @ $${price.toFixed(d.PRICE)}) | entry=$${this.avgEntryPrice.toFixed(d.PRICE)} | rPnL=$${this.realizedPnL.toFixed(d.QUOTE)}`,
		);

		return fillRealizedPnL;
	}

	getQuotingContext(fairPrice: number): QuotingContext {
		const positionState = this.getState(fairPrice);
		const allowedSides = this.getAllowedSides(positionState);
		return {
			fairPrice,
			positionState,
			allowedSides,
		};
	}

	private getState(fairPrice: number): PositionState {
		const sizeBase = this.baseSize;
		const sizeUsd = sizeBase * fairPrice;
		const isLong = sizeBase > 0;
		const isCloseMode = Math.abs(sizeUsd) >= this.config.closeThresholdUsd;

		return {
			sizeBase,
			sizeUsd,
			isLong,
			isCloseMode,
			avgEntryPrice: this.avgEntryPrice,
		};
	}

	private getAllowedSides(state: PositionState): ("bid" | "ask")[] {
		// Close mode: only allow reducing
		if (state.isCloseMode) {
			return state.isLong ? ["ask"] : ["bid"];
		}

		// Normal: both sides
		return ["bid", "ask"];
	}

	getUnrealizedPnL(markPrice: number): number {
		if (this.baseSize === 0 || this.avgEntryPrice === 0) return 0;
		if (this.baseSize > 0) {
			return (markPrice - this.avgEntryPrice) * this.baseSize;
		}
		return (this.avgEntryPrice - markPrice) * Math.abs(this.baseSize);
	}

	getRealizedPnL(): number {
		return this.realizedPnL;
	}

	getAvgEntryPrice(): number {
		return this.avgEntryPrice;
	}

	getSessionSummary(markPrice: number): SessionSummary {
		const uptimeMs = Date.now() - this.sessionStartTime;
		const unrealizedPnL = this.getUnrealizedPnL(markPrice);
		return {
			uptimeMs,
			fillCount: this.fillCount,
			totalVolumeUsd: this.totalVolumeUsd,
			realizedPnL: this.realizedPnL,
			unrealizedPnL,
			netPnL: this.realizedPnL + unrealizedPnL,
			avgSpreadCapturedBps:
				this.totalVolumeUsd > 0
					? (this.realizedPnL / this.totalVolumeUsd) * 10000
					: 0,
		};
	}

	getBaseSize(): number {
		return this.baseSize;
	}

	isCloseMode(fairPrice: number): boolean {
		const sizeUsd = Math.abs(this.baseSize * fairPrice);
		return sizeUsd >= this.config.closeThresholdUsd;
	}
}
