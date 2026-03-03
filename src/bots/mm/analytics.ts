// Markout and fill rate analytics

import { writeFileSync } from "node:fs";
import { log } from "../../utils/logger.js";

type MarkPriceGetter = () => number | null;

interface FillRecord {
	timestamp: number;
	side: "bid" | "ask";
	size: number;
	price: number;
	fairPriceAtFill: number;
	markouts: Record<number, number | null>;
}

export interface MarkoutStats {
	readonly horizonMs: number;
	readonly count: number;
	readonly avgBps: number;
}

export interface AnalyticsSummary {
	readonly markouts: MarkoutStats[];
	readonly fillRate: number;
	readonly quoteUpdateCount: number;
}

export class AnalyticsTracker {
	private fills: FillRecord[] = [];
	private quoteUpdateCount = 0;

	constructor(
		private readonly getMarkPrice: MarkPriceGetter,
		private readonly horizonsMs: readonly number[],
	) {}

	recordFill(
		side: "bid" | "ask",
		size: number,
		price: number,
		fairPriceAtFill: number,
	): void {
		const markouts: Record<number, number | null> = {};
		for (const h of this.horizonsMs) markouts[h] = null;

		const record: FillRecord = {
			timestamp: Date.now(),
			side,
			size,
			price,
			fairPriceAtFill,
			markouts,
		};
		this.fills.push(record);

		const fillIndex = this.fills.length - 1;
		for (const horizonMs of this.horizonsMs) {
			const timer = setTimeout(() => {
				this.observeMarkout(fillIndex, horizonMs);
			}, horizonMs);
			timer.unref();
		}
	}

	private observeMarkout(fillIndex: number, horizonMs: number): void {
		const fill = this.fills[fillIndex];
		if (!fill) return;

		const currentFairPrice = this.getMarkPrice();
		if (currentFairPrice === null) return;

		const markoutBps =
			fill.side === "bid"
				? ((currentFairPrice - fill.price) / fill.price) * 10_000
				: ((fill.price - currentFairPrice) / fill.price) * 10_000;

		fill.markouts[horizonMs] = markoutBps;

		const label = horizonMs >= 1000 ? `${horizonMs / 1000}s` : `${horizonMs}ms`;
		const sign = markoutBps >= 0 ? "+" : "";
		log.debug(`MARKOUT: fill #${fillIndex} ${label} = ${sign}${markoutBps.toFixed(2)}bps`);
	}

	recordQuoteUpdate(): void {
		this.quoteUpdateCount++;
	}

	getSummary(fillCount: number): AnalyticsSummary {
		const markouts: MarkoutStats[] = this.horizonsMs.map((horizonMs) => {
			const observed = this.fills
				.map((f) => f.markouts[horizonMs])
				.filter((v): v is number => v !== null);
			return {
				horizonMs,
				count: observed.length,
				avgBps:
					observed.length > 0
						? observed.reduce((a, b) => a + b, 0) / observed.length
						: 0,
			};
		});

		return {
			markouts,
			fillRate: this.quoteUpdateCount > 0 ? fillCount / this.quoteUpdateCount : 0,
			quoteUpdateCount: this.quoteUpdateCount,
		};
	}

	writeFillsToFile(filepath: string): void {
		if (this.fills.length === 0) return;

		const lines = this.fills
			.map((f) => JSON.stringify(f))
			.join("\n");
		writeFileSync(filepath, lines + "\n");
		log.info(`Wrote ${this.fills.length} fill records to ${filepath}`);
	}
}
