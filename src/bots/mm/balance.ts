// Balance tracker — logs starting balance, fee rates, and attributed balance changes
//
// Empirically verified balance model (01 Exchange):
//   While position is open: Δbalance = realizedPnL - fees
//     (funding accrues on position via fundingPaymentPnl but does NOT touch balance)
//   On position close: Δbalance = closingPnL - closingFee + accumulatedFunding
//     (everything settles into balance at once)
//
// Therefore: netTrading = Δbalance (includes realized PnL, fees, and funding on close)
// Funding is tracked separately for reporting only.

import type { Nord, NordUser } from "@n1xyz/nord-ts";
import { log } from "../../utils/logger.js";

export interface BalanceConfig {
	readonly syncIntervalMs: number;
}

export interface FeeRateInfo {
	readonly feeTierId: number;
	readonly makerFeePpm: number;
	readonly takerFeePpm: number;
}

interface BalanceSnapshot {
	readonly balance: number;
	// marketId → cumulative funding PnL from REST position data
	readonly fundingPnlByMarket: Map<number, number>;
}

export interface BalanceSummary {
	readonly startingBalance: number;
	readonly currentBalance: number;
	readonly totalFunding: number;
	readonly totalNetTrading: number;
	readonly totalFees: number;
	readonly netChange: number;
	readonly syncCount: number;
}

export class BalanceTracker {
	private isRunning = false;
	private startingBalance = 0;
	private currentBalance = 0;
	private previousSnapshot: BalanceSnapshot | null = null;
	private feeRate: FeeRateInfo | null = null;
	private pendingFeeAccumulator = 0;
	private syncCount = 0;

	// Last-known funding per market — survives position close
	private lastKnownFunding = new Map<number, number>();

	// Cumulative totals across all syncs
	private totalFunding = 0;
	private totalNetTrading = 0; // = Δbalance (includes realizedPnL - fees, and funding on close)
	private totalFees = 0; // estimated from WebSocket fills

	constructor(private readonly config: BalanceConfig) {}

	async initialize(
		nord: Nord,
		user: NordUser,
		accountId: number,
	): Promise<void> {
		await user.fetchInfo();

		// Read starting balance
		const balanceEntries = user.balances[accountId] ?? [];
		if (balanceEntries.length === 0) {
			log.warn("BALANCE: no balance entries found for account");
			return;
		}
		this.startingBalance = balanceEntries[0].balance;
		this.currentBalance = this.startingBalance;
		log.fileLog(
			"balance",
			`BALANCE_INIT: balance=$${this.startingBalance.toFixed(6)}`,
		);
		log.info(
			`BALANCE: starting balance $${this.startingBalance.toFixed(6)}`,
		);

		// Fetch fee rates
		const [tierId, brackets] = await Promise.all([
			nord.getAccountFeeTier(accountId),
			nord.getFeeBrackets(),
		]);
		const bracket = brackets.find(([id]) => id === tierId);
		if (bracket) {
			const [, config] = bracket;
			this.feeRate = {
				feeTierId: tierId,
				makerFeePpm: config.maker_fee_ppm,
				takerFeePpm: config.taker_fee_ppm,
			};
			const makerBps = config.maker_fee_ppm / 100;
			const takerBps = config.taker_fee_ppm / 100;
			log.fileLog(
				"balance",
				`FEE_RATE: tier=${tierId} maker=${makerBps}bps taker=${takerBps}bps`,
			);
			log.info(
				`BALANCE: fee tier ${tierId} — maker ${makerBps}bps, taker ${takerBps}bps`,
			);
		} else {
			log.warn(`BALANCE: fee tier ${tierId} not found in brackets`);
		}

		// Take initial snapshot
		this.previousSnapshot = this.takeSnapshot(user, accountId);
	}

	startSync(user: NordUser, accountId: number): void {
		this.isRunning = true;
		this.syncLoop(user, accountId);
	}

	stopSync(): void {
		this.isRunning = false;
	}

	async finalSync(user: NordUser, accountId: number): Promise<void> {
		await this.syncFromServer(user, accountId);
	}

	recordFill(side: "bid" | "ask", size: number, price: number): void {
		if (!this.feeRate) return;
		const fee = (size * price * this.feeRate.makerFeePpm) / 1_000_000;
		this.pendingFeeAccumulator += fee;
		log.fileLog(
			"balance",
			`FILL_FEE: ${side} ${size}@${price.toFixed(2)} fee=$${fee.toFixed(6)}`,
		);
	}

	getFeeRate(): FeeRateInfo | null {
		return this.feeRate;
	}

	getSessionSummary(): BalanceSummary {
		return {
			startingBalance: this.startingBalance,
			currentBalance: this.currentBalance,
			totalFunding: this.totalFunding,
			totalNetTrading: this.totalNetTrading,
			totalFees: this.totalFees,
			netChange: this.currentBalance - this.startingBalance,
			syncCount: this.syncCount,
		};
	}

	private async syncLoop(
		user: NordUser,
		accountId: number,
	): Promise<void> {
		while (this.isRunning) {
			await this.sleep(this.config.syncIntervalMs);
			if (!this.isRunning) break;
			await this.syncFromServer(user, accountId);
		}
	}

	private async syncFromServer(
		user: NordUser,
		accountId: number,
	): Promise<void> {
		try {
			await user.fetchInfo();

			const newSnapshot = this.takeSnapshot(user, accountId);
			this.currentBalance = newSnapshot.balance;
			this.syncCount++;

			if (this.previousSnapshot) {
				const balanceChange =
					newSnapshot.balance - this.previousSnapshot.balance;

				// Compute funding delta across all markets (for reporting only)
				// Funding does NOT affect balance while position is open;
				// it settles into balance on position close
				const allMarketIds = new Set<number>([
					...this.lastKnownFunding.keys(),
					...newSnapshot.fundingPnlByMarket.keys(),
				]);

				let fundingDelta = 0;
				for (const marketId of allMarketIds) {
					const prevFunding =
						this.lastKnownFunding.get(marketId) ?? 0;
					// If position closed, funding disappears from snapshot (resets to 0)
					const currentFunding =
						newSnapshot.fundingPnlByMarket.get(marketId) ?? 0;
					fundingDelta += currentFunding - prevFunding;
				}

				// netTrading = Δbalance (the balance IS the source of truth)
				const netTradingDelta = balanceChange;

				// Capture accumulated fees from WebSocket fills since last sync
				const feesDelta = this.pendingFeeAccumulator;
				this.pendingFeeAccumulator = 0;

				// Accumulate session totals
				this.totalFunding += fundingDelta;
				this.totalNetTrading += netTradingDelta;
				this.totalFees += feesDelta;

				const fmt = (v: number) => {
					const sign = v >= 0 ? "+" : "";
					return `${sign}$${v.toFixed(6)}`;
				};

				if (balanceChange !== 0) {
					log.fileLog(
						"balance",
						`BALANCE_SYNC: bal=$${newSnapshot.balance.toFixed(6)} | delta=${fmt(balanceChange)} | funding=${fmt(fundingDelta)} | estFees=${fmt(feesDelta)}`,
					);
				}
			}

			// Update last-known funding from current snapshot
			// When position closes, the market disappears — reset to 0
			// so the next open starts fresh
			for (const marketId of this.lastKnownFunding.keys()) {
				if (!newSnapshot.fundingPnlByMarket.has(marketId)) {
					this.lastKnownFunding.set(marketId, 0);
				}
			}
			for (const [marketId, funding] of newSnapshot.fundingPnlByMarket) {
				this.lastKnownFunding.set(marketId, funding);
			}

			this.previousSnapshot = newSnapshot;
		} catch (err) {
			log.error("Balance sync error:", err);
		}
	}

	private takeSnapshot(
		user: NordUser,
		accountId: number,
	): BalanceSnapshot {
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

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
