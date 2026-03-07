// Position Tracker with optimistic updates + periodic sync

import type { Nord, NordUser } from "@n1xyz/nord-ts";
import { log } from "../../utils/logger.js";

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

export interface PositionConfig {
	readonly closeThresholdUsd: number; // Trigger close mode when position >= this
	readonly syncIntervalMs: number;
}

export interface FillRecoveryResult {
	readonly trades: RecoveredTrade[];
	readonly totalRealizedPnL: number;
	readonly totalFees: number;
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

export class PositionTracker {
	private baseSize = 0;
	private isRunning = false;
	private avgEntryPrice = 0;
	private realizedPnL = 0;
	private fillCount = 0;
	private totalVolumeUsd = 0;
	private sessionStartTime = Date.now();

	// For getTrades() fill recovery
	private nord: Nord | null = null;
	private accountId = 0;
	private marketId = 0;
	private lastSyncTime: string | null = null;
	private lastTradeId = 0;
	private makerFeePpm = 0;
	private takerFeePpm = 0;

	constructor(private readonly config: PositionConfig) {}

	startSync(
		user: NordUser,
		accountId: number,
		marketId: number,
		nord: Nord,
		makerFeePpm: number,
		takerFeePpm: number,
	): void {
		this.isRunning = true;
		this.nord = nord;
		this.accountId = accountId;
		this.marketId = marketId;
		this.makerFeePpm = makerFeePpm;
		this.takerFeePpm = takerFeePpm;
		this.lastSyncTime = new Date().toISOString();
		this.syncLoop(user, accountId, marketId);
	}

	stopSync(): void {
		this.isRunning = false;
	}

	private async syncLoop(
		user: NordUser,
		accountId: number,
		marketId: number,
	): Promise<void> {
		await this.syncFromServer(user, accountId, marketId);

		while (this.isRunning) {
			await this.sleep(this.config.syncIntervalMs);
			if (!this.isRunning) break;
			await this.syncFromServer(user, accountId, marketId);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async syncFromServer(
		user: NordUser,
		accountId: number,
		marketId: number,
	): Promise<void> {
		try {
			await user.fetchInfo();

			const positions = user.positions[accountId] ?? [];
			const pos = positions.find((p) => p.marketId === marketId);

			const serverSize = pos?.perp
				? pos.perp.isLong
					? pos.perp.baseSize
					: -pos.perp.baseSize
				: 0;
			const serverEntryPrice = pos?.perp?.price ?? 0;

			const sizeDiscrepancy = serverSize !== this.baseSize;
			const priceDiscrepancy =
				serverSize !== 0 && serverEntryPrice !== this.avgEntryPrice;

			if (sizeDiscrepancy || priceDiscrepancy) {
				if (sizeDiscrepancy) {
					log.warn(
						`Position sync: size mismatch — local=${this.baseSize} server=${serverSize}`,
					);
				}
				if (priceDiscrepancy) {
					log.warn(
						`Position sync: entry price mismatch — local=${this.avgEntryPrice} server=${serverEntryPrice}`,
					);
				}

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
							`Recovered fill: ${trade.side} ${trade.size} @ $${trade.price.toFixed(2)} (${trade.isMaker ? "maker" : "taker"}, fee=$${trade.fee.toFixed(6)})`,
						);
					}
				}

				// After recovery, force-overwrite local state from exchange truth
				const postRecoverySize = this.baseSize;
				if (postRecoverySize !== serverSize) {
					log.warn(
						`Position sync: overwriting local state — size ${postRecoverySize} → ${serverSize}, entry ${this.avgEntryPrice} → ${serverEntryPrice}`,
					);
				}
				this.baseSize = serverSize;
				this.avgEntryPrice = serverEntryPrice;
			}

			this.lastSyncTime = new Date().toISOString();
		} catch (err) {
			log.error("Position sync error:", err);
		}
	}

	private async recoverMissedFills(): Promise<FillRecoveryResult | null> {
		if (!this.nord || !this.lastSyncTime) return null;

		try {
			// Query for trades where we are the maker
			const makerResponse = await this.nord.getTrades({
				makerId: this.accountId,
				marketId: this.marketId,
				since: this.lastSyncTime,
			});

			// Query for trades where we are the taker
			const takerResponse = await this.nord.getTrades({
				takerId: this.accountId,
				marketId: this.marketId,
				since: this.lastSyncTime,
			});

			// Merge and deduplicate by tradeId
			const allTrades = new Map<number, (typeof makerResponse.items)[number]>();
			for (const trade of makerResponse.items) {
				if (trade.tradeId > this.lastTradeId) {
					allTrades.set(trade.tradeId, trade);
				}
			}
			for (const trade of takerResponse.items) {
				if (trade.tradeId > this.lastTradeId) {
					allTrades.set(trade.tradeId, trade);
				}
			}

			if (allTrades.size === 0) return { trades: [], totalRealizedPnL: 0, totalFees: 0 };

			// Sort by tradeId (chronological order)
			const sorted = [...allTrades.values()].sort(
				(a, b) => a.tradeId - b.tradeId,
			);

			const recovered: RecoveredTrade[] = [];
			let totalRealizedPnL = 0;
			let totalFees = 0;

			for (const trade of sorted) {
				const isMaker = trade.makerId === this.accountId;
				// Our side: if we're the maker, our side is opposite of takerSide
				// If we're the taker, our side is the takerSide
				const side: "bid" | "ask" = isMaker
					? (trade.takerSide === "bid" ? "ask" : "bid")
					: trade.takerSide;

				const feePpm = isMaker ? this.makerFeePpm : this.takerFeePpm;
				const fee = (trade.baseSize * trade.price * feePpm) / 1_000_000;

				const fillRealizedPnL = this.applyFill(
					side,
					trade.baseSize,
					trade.price,
				);

				recovered.push({
					side,
					size: trade.baseSize,
					price: trade.price,
					realizedPnL: fillRealizedPnL,
					fee,
					isMaker,
					tradeId: trade.tradeId,
				});

				totalRealizedPnL += fillRealizedPnL;
				totalFees += fee;
				this.lastTradeId = trade.tradeId;
			}

			log.info(
				`Fill recovery: ${recovered.length} trades recovered, rPnL=$${totalRealizedPnL.toFixed(4)}, fees=$${totalFees.toFixed(6)}`,
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
			} else if (Math.abs(previousBase + size * fillSign) < 1e-10) {
				// Fully closed
				this.avgEntryPrice = 0;
			}
			// Partially reduced: avgEntryPrice stays the same
		}

		this.baseSize = previousBase + size * fillSign;

		log.debug(
			`Position updated: ${this.baseSize.toFixed(6)} (${side} ${size} @ $${price.toFixed(2)}) | entry=$${this.avgEntryPrice.toFixed(2)} | rPnL=$${this.realizedPnL.toFixed(4)}`,
		);

		return fillRealizedPnL;
	}

	getLastFillRecovery(): { lastTradeId: number } {
		return { lastTradeId: this.lastTradeId };
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
