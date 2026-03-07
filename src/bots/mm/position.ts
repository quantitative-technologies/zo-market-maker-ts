// Position Tracker with optimistic updates + periodic sync

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

type DriftCallback = (sizeDelta: number, newBaseSize: number) => void;

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

	constructor(private readonly config: PositionConfig) {}

	setOnDrift(callback: DriftCallback): void {
		this.onDrift = callback;
	}

	setMarkPrice(price: number): void {
		this.lastMarkPrice = price;
	}

	startSync(
		fetchPosition: () => Promise<{ baseSize: number }>,
	): void {
		this.isRunning = true;
		this.syncLoop(fetchPosition);
	}

	stopSync(): void {
		this.isRunning = false;
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
		fetchPosition: () => Promise<{ baseSize: number }>,
	): Promise<void> {
		try {
			const { baseSize: serverSize } = await fetchPosition();

			const sizeDelta = serverSize - this.baseSize;

			if (Math.abs(sizeDelta) > 0.0001) {
				log.warn(
					`Position drift detected: local=${this.baseSize.toFixed(6)}, server=${serverSize.toFixed(6)}, delta=${sizeDelta.toFixed(6)}`,
				);

				// Process as a synthetic fill so PnL tracking stays correct
				const fillSide: "bid" | "ask" =
					sizeDelta > 0 ? "bid" : "ask";
				const fillSize = Math.abs(sizeDelta);
				const approxPrice = this.lastMarkPrice || 0;

				if (approxPrice > 0) {
					const fillPnL = this.applyFill(
						fillSide,
						fillSize,
						approxPrice,
					);

					log.fill(
						fillSide === "bid" ? "buy" : "sell",
						approxPrice,
						fillSize,
						fillPnL !== 0 ? fillPnL : undefined,
						this.realizedPnL,
					);
					log.warn(
						`Missed fill recovered via sync: ${fillSide} ${fillSize.toFixed(6)} @ ~$${approxPrice.toFixed(2)} (approx)`,
					);
				} else {
					// No price available — force-correct position without PnL
					log.warn(
						"No mark price available for missed fill PnL — forcing position sync",
					);
					const previousBase = this.baseSize;
					this.baseSize = serverSize;
					if (
						(previousBase > 0 && serverSize < 0) ||
						(previousBase < 0 && serverSize > 0) ||
						serverSize === 0
					) {
						this.avgEntryPrice = 0;
					}
				}

				// Notify bot about drift (e.g., to enter close mode)
				if (this.onDrift) {
					this.onDrift(sizeDelta, this.baseSize);
				}
			}
		} catch (err) {
			log.error("Position sync error:", err);
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
