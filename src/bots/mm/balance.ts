// Balance tracker — logs starting balance, fee rates, and attributed balance changes

import type { Nord, NordUser } from "@n1xyz/nord-ts";
import { log } from "../../utils/logger.js";

export interface BalanceConfig {
	readonly syncIntervalMs: number;
}

interface FeeRateInfo {
	readonly feeTierId: number;
	readonly makerFeePpm: number;
	readonly takerFeePpm: number;
}

interface BalanceSnapshot {
	readonly balance: number;
	// marketId → cumulative PnL from REST position data
	readonly fundingPnlByMarket: Map<number, number>;
	readonly tradingPnlByMarket: Map<number, number>;
}

export interface BalanceSummary {
	readonly startingBalance: number;
	readonly currentBalance: number;
	readonly totalFunding: number;
	readonly totalTradingPnl: number;
	readonly totalFees: number;
	readonly totalUnexplained: number;
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

	// Cumulative totals across all syncs
	private totalFunding = 0;
	private totalTradingPnl = 0;
	private totalFees = 0;
	private totalUnexplained = 0;

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
			`BALANCE_INIT: balance=$${this.startingBalance.toFixed(4)}`,
		);
		log.info(
			`BALANCE: starting balance $${this.startingBalance.toFixed(4)}`,
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
			log.fileLog(
				"balance",
				`FEE_RATE: tier=${tierId} maker=${config.maker_fee_ppm}ppm taker=${config.taker_fee_ppm}ppm`,
			);
			log.info(
				`BALANCE: fee tier ${tierId} — maker ${config.maker_fee_ppm}ppm, taker ${config.taker_fee_ppm}ppm`,
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

	recordFill(side: "bid" | "ask", size: number, price: number): void {
		if (!this.feeRate) return;
		const fee = (size * price * this.feeRate.makerFeePpm) / 1_000_000;
		this.pendingFeeAccumulator += fee;
		log.fileLog(
			"balance",
			`FILL_FEE: ${side} ${size}@${price.toFixed(2)} fee=$${fee.toFixed(6)}`,
		);
	}

	getMakerFeePpm(): number | null {
		return this.feeRate?.makerFeePpm ?? null;
	}

	getSessionSummary(): BalanceSummary {
		return {
			startingBalance: this.startingBalance,
			currentBalance: this.currentBalance,
			totalFunding: this.totalFunding,
			totalTradingPnl: this.totalTradingPnl,
			totalFees: this.totalFees,
			totalUnexplained: this.totalUnexplained,
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

				// Compute funding delta across all markets
				let fundingDelta = 0;
				for (const [marketId, currentFunding] of newSnapshot.fundingPnlByMarket) {
					const prevFunding =
						this.previousSnapshot.fundingPnlByMarket.get(marketId) ?? 0;
					fundingDelta += currentFunding - prevFunding;
				}

				// Compute trading PnL delta across all markets
				let tradingDelta = 0;
				for (const [marketId, currentTrading] of newSnapshot.tradingPnlByMarket) {
					const prevTrading =
						this.previousSnapshot.tradingPnlByMarket.get(marketId) ?? 0;
					tradingDelta += currentTrading - prevTrading;
				}

				// Capture accumulated fees from fills since last sync
				const feesDelta = this.pendingFeeAccumulator;
				this.pendingFeeAccumulator = 0;

				const unexplained =
					balanceChange - fundingDelta - tradingDelta + feesDelta;

				// Accumulate session totals
				this.totalFunding += fundingDelta;
				this.totalTradingPnl += tradingDelta;
				this.totalFees += feesDelta;
				this.totalUnexplained += unexplained;

				const fmt = (v: number) => {
					const sign = v >= 0 ? "+" : "";
					return `${sign}$${v.toFixed(4)}`;
				};

				if (Math.abs(balanceChange) > 0.0001) {
					log.fileLog(
						"balance",
						`BALANCE_SYNC: bal=$${newSnapshot.balance.toFixed(4)} | delta=${fmt(balanceChange)} | funding=${fmt(fundingDelta)} | trading=${fmt(tradingDelta)} | fees=${fmt(feesDelta)} | unexplained=${fmt(unexplained)}`,
					);
				}
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
		const tradingPnlByMarket = new Map<number, number>();

		const positions = user.positions[accountId] ?? [];
		for (const pos of positions) {
			if (pos.perp) {
				fundingPnlByMarket.set(pos.marketId, pos.perp.fundingPaymentPnl);
				tradingPnlByMarket.set(pos.marketId, pos.perp.sizePricePnl);
			}
		}

		return { balance, fundingPnlByMarket, tradingPnlByMarket };
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
