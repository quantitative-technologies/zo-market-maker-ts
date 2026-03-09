// Colored logger with millisecond precision
// Terminal mode: tslog "pretty" for ANSI-colored output
// TUI mode (setOutput called): plain text formatting (no ANSI codes)

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "tslog";

// Display precision for toFixed() — initialized from exchange MarketInfo at startup.
// BPS is a pure display choice (not exchange-provided).
export const FMT_DECIMALS = {
	PRICE: 0,     // USD prices — set from MarketInfo.priceDecimals
	SIZE: 0,      // Base sizes — set from MarketInfo.sizeDecimals
	QUOTE: 0,     // Quote currency (balances, PnL, fees) — set from MarketInfo.quoteDecimals
	BPS: 1,       // Basis points, rates, milliseconds (display choice)
};

export function initFmtDecimals(marketInfo: {
	priceDecimals: number;
	sizeDecimals: number;
	quoteDecimals: number;
}): void {
	FMT_DECIMALS.PRICE = marketInfo.priceDecimals;
	FMT_DECIMALS.SIZE = marketInfo.sizeDecimals;
	FMT_DECIMALS.QUOTE = marketInfo.quoteDecimals;
}

type LogOutput = (message: string) => void;
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

// tslog uses: 0=silly, 1=trace, 2=debug, 3=info, 4=warn, 5=error, 6=fatal
const TSLOG_LEVEL: Record<LogLevel, number> = {
	debug: 2,
	info: 3,
	warn: 4,
	error: 5,
};

type FileLogWriter = (line: string) => void;

const fileLoggers = new Map<string, FileLogWriter>();

function createFileLogger(filepath: string): FileLogWriter {
	const dir = dirname(filepath);
	mkdirSync(dir, { recursive: true });
	return (line: string) => {
		appendFileSync(filepath, `${line}\n`);
	};
}

let customOutput: LogOutput | null = null;
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

const tsLogger = new Logger({
	type: "pretty",
	hideLogPositionForProduction: true,
	stylePrettyLogs: true,
	prettyLogTimeZone: "UTC",
	prettyLogTemplate:
		"{{yyyy}}-{{mm}}-{{dd}}T{{hh}}:{{MM}}:{{ss}}.{{ms}}Z\t{{logLevelName}}\t",
	minLevel: TSLOG_LEVEL[minLevel],
});

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

// --- Plain text formatting (TUI mode, no ANSI codes) ---

function timestamp(): string {
	return new Date().toISOString();
}

function formatArg(a: unknown): string {
	if (a instanceof Error) {
		return a.stack || a.message;
	}
	if (typeof a === "object") {
		return JSON.stringify(a);
	}
	return String(a);
}

function formatPlain(
	level: string,
	message: string,
	...args: unknown[]
): string {
	const argStr = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
	return `${timestamp()} [${level}] ${message}${argStr}`;
}

function formatMessage(message: string, ...args: unknown[]): string {
	if (args.length === 0) return message;
	return `${message} ${args.map(formatArg).join(" ")}`;
}

export const log = {
	initFileLoggers(symbol: string, logDir = "logs"): void {
		const prefix = join(logDir, symbol.toLowerCase());
		fileLoggers.set("position", createFileLogger(`${prefix}-position.log`));
		fileLoggers.set("balance", createFileLogger(`${prefix}-balance.log`));
	},

	fileLog(name: string, message: string): void {
		const writer = fileLoggers.get(name);
		if (writer) {
			writer(`${timestamp()}\t${message}`);
		}
	},

	setOutput(fn: LogOutput): void {
		customOutput = fn;
	},

	setLevel(level: LogLevel): void {
		minLevel = level;
		tsLogger.settings.minLevel = TSLOG_LEVEL[level];
	},

	info(message: string, ...args: unknown[]): void {
		if (!shouldLog("info")) return;
		if (customOutput) {
			customOutput(formatPlain("INFO", message, ...args));
		} else {
			tsLogger.info(formatMessage(message, ...args));
		}
	},

	warn(message: string, ...args: unknown[]): void {
		if (!shouldLog("warn")) return;
		if (customOutput) {
			customOutput(formatPlain("WARN", message, ...args));
		} else {
			tsLogger.warn(formatMessage(message, ...args));
		}
	},

	error(message: string, ...args: unknown[]): void {
		if (!shouldLog("error")) return;
		if (customOutput) {
			customOutput(formatPlain("ERROR", message, ...args));
		} else {
			tsLogger.error(formatMessage(message, ...args));
		}
	},

	debug(message: string, ...args: unknown[]): void {
		if (!shouldLog("debug")) return;
		if (customOutput) {
			customOutput(formatPlain("DEBUG", message, ...args));
		} else {
			tsLogger.debug(formatMessage(message, ...args));
		}
	},

	// --- Domain-specific methods (route through info) ---

	quote(
		bid: number | null,
		ask: number | null,
		fair: number,
		spreadBps: number,
		mode: "normal" | "close",
	): void {
		const d = FMT_DECIMALS;
		const bidStr = bid !== null ? `$${bid.toFixed(d.PRICE)}` : "--";
		const askStr = ask !== null ? `$${ask.toFixed(d.PRICE)}` : "--";
		this.info(
			`QUOTE: BID ${bidStr} | ASK ${askStr} | FAIR $${fair.toFixed(d.PRICE)} | SPREAD ${spreadBps}bps | ${mode.toUpperCase()}`,
		);
	},

	position(
		sizeBase: number,
		sizeUsd: number,
		isLong: boolean,
		isCloseMode: boolean,
		avgEntryPrice?: number,
		unrealizedPnL?: number,
	): void {
		const d = FMT_DECIMALS;
		const dir = isLong ? "LONG" : "SHORT";
		const mode = isCloseMode ? " [CLOSE MODE]" : "";
		let extra = "";
		if (avgEntryPrice && avgEntryPrice > 0) {
			extra += ` entry=$${avgEntryPrice.toFixed(d.PRICE)}`;
		}
		if (unrealizedPnL !== undefined && sizeBase !== 0) {
			const sign = unrealizedPnL >= 0 ? "+" : "";
			extra += ` | uPnL ${sign}$${unrealizedPnL.toFixed(d.QUOTE)}`;
		}
		const msg = `POS: ${dir} ${Math.abs(sizeBase).toFixed(d.SIZE)} ($${Math.abs(sizeUsd).toFixed(d.PRICE)})${extra}${mode}`;
		this.info(msg);
		this.fileLog("position", msg);
	},

	fill(
		side: "buy" | "sell",
		price: number,
		size: number,
		fillPnL?: number,
		cumulativeRealizedPnL?: number,
	): void {
		const d = FMT_DECIMALS;
		let pnlStr = "";
		if (fillPnL !== undefined && fillPnL !== 0) {
			const sign = fillPnL >= 0 ? "+" : "";
			pnlStr += ` | fillPnL ${sign}$${fillPnL.toFixed(d.QUOTE)}`;
		}
		if (cumulativeRealizedPnL !== undefined) {
			const sign = cumulativeRealizedPnL >= 0 ? "+" : "";
			pnlStr += ` | rPnL ${sign}$${cumulativeRealizedPnL.toFixed(d.QUOTE)}`;
		}
		const msg = `FILL: ${side.toUpperCase()} ${size} @ $${price.toFixed(d.PRICE)}${pnlStr}`;
		this.info(msg);
		this.fileLog("position", msg);
	},

	banner(): void {
		const text = `
╔═══════════════════════════════════════╗
║         ZO MARKET MAKER BOT           ║
╚═══════════════════════════════════════╝
`;
		if (customOutput) {
			customOutput(text);
		} else {
			console.log(text);
		}
	},

	config(cfg: Record<string, unknown>): void {
		this.info("CONFIG:");
		for (const [key, value] of Object.entries(cfg)) {
			if (customOutput) {
				customOutput(`  ${key}: ${value}`);
			} else {
				console.log(`  ${key}: ${value}`);
			}
		}
	},

	sessionSummary(summary: {
		uptimeMs: number;
		fillCount: number;
		totalVolumeUsd: number;
		realizedPnL: number;
		unrealizedPnL: number;
		netPnL: number;
		avgSpreadCapturedBps: number;
	}): void {
		const d = FMT_DECIMALS;
		const uptimeMin = (summary.uptimeMs / 60000).toFixed(d.BPS);
		const fmt = (v: number) => {
			const sign = v >= 0 ? "+" : "";
			return `${sign}$${v.toFixed(d.QUOTE)}`;
		};
		const line = `SESSION: uptime=${uptimeMin}min fills=${summary.fillCount} vol=$${summary.totalVolumeUsd.toFixed(d.PRICE)} rPnL=${fmt(summary.realizedPnL)} uPnL=${fmt(summary.unrealizedPnL)} net=${fmt(summary.netPnL)} spread=${summary.avgSpreadCapturedBps.toFixed(d.PRICE)}bps`;
		this.fileLog("position", line);
		this.info("═══ SESSION SUMMARY ═══");
		this.info(`  Uptime:     ${uptimeMin} min`);
		this.info(`  Fills:      ${summary.fillCount}`);
		this.info(`  Volume:     $${summary.totalVolumeUsd.toFixed(d.PRICE)}`);
		this.info(`  Realized:   ${fmt(summary.realizedPnL)}`);
		this.info(`  Unrealized: ${fmt(summary.unrealizedPnL)}`);
		this.info(`  Net PnL:    ${fmt(summary.netPnL)}`);
		this.info(`  Avg Spread: ${summary.avgSpreadCapturedBps.toFixed(d.PRICE)} bps`);
		this.info("═══════════════════════");
	},

	balanceSummary(summary: {
		startingBalance: number;
		currentBalance: number;
		startingEquity: number;
		currentEquity: number;
		totalFunding: number;
		totalNetTrading: number;
		totalFees: number;
		netChange: number;
		equityChange: number;
		syncCount: number;
	}): void {
		const d = FMT_DECIMALS;
		const fmt = (v: number) => {
			const sign = v >= 0 ? "+" : "";
			return `${sign}$${v.toFixed(d.QUOTE)}`;
		};
		this.info("═══ BALANCE SUMMARY ═══");
		this.info(`  Start Eq:   $${summary.startingEquity.toFixed(d.QUOTE)}`);
		this.info(`  Curr Eq:    $${summary.currentEquity.toFixed(d.QUOTE)}`);
		this.info(`  Eq Change:  ${fmt(summary.equityChange)}`);
		this.info(`  Balance:    ${fmt(summary.netChange)} ($${summary.currentBalance.toFixed(d.QUOTE)})`);
		this.info(`  Funding:    ${fmt(summary.totalFunding)}`);
		this.info(`  Est. Fees:  ${fmt(summary.totalFees)}`);
		this.info(`  Syncs:      ${summary.syncCount}`);
		this.info("═══════════════════════");
	},

	analyticsSummary(summary: {
		markouts: { horizonMs: number; count: number; avgBps: number }[];
		fillRate: number;
		quoteUpdateCount: number;
	}): void {
		const d = FMT_DECIMALS;
		this.info("═══ ANALYTICS ═══");
		for (const m of summary.markouts) {
			const label = m.horizonMs >= 1000 ? `${m.horizonMs / 1000}s` : `${m.horizonMs}ms`;
			const sign = m.avgBps >= 0 ? "+" : "";
			this.info(`  Markout ${label}: ${sign}${m.avgBps.toFixed(d.BPS)}bps (n=${m.count})`);
		}
		this.info(`  Fill Rate:  ${(summary.fillRate * 100).toFixed(d.BPS)}% (${summary.quoteUpdateCount} updates)`);
		this.info("═════════════════");
	},

	shutdown(): void {
		this.info("Shutting down...");
	},
};
