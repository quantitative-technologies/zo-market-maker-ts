// Colored logger with millisecond precision
// Terminal mode: tslog "pretty" for ANSI-colored output
// TUI mode (setOutput called): plain text formatting (no ANSI codes)

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "tslog";

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
		const bidStr = bid !== null ? `$${bid.toFixed(2)}` : "--";
		const askStr = ask !== null ? `$${ask.toFixed(2)}` : "--";
		this.info(
			`QUOTE: BID ${bidStr} | ASK ${askStr} | FAIR $${fair.toFixed(2)} | SPREAD ${spreadBps}bps | ${mode.toUpperCase()}`,
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
		const dir = isLong ? "LONG" : "SHORT";
		const mode = isCloseMode ? " [CLOSE MODE]" : "";
		let extra = "";
		if (avgEntryPrice && avgEntryPrice > 0) {
			extra += ` entry=$${avgEntryPrice.toFixed(2)}`;
		}
		if (unrealizedPnL !== undefined && sizeBase !== 0) {
			const sign = unrealizedPnL >= 0 ? "+" : "";
			extra += ` | uPnL ${sign}$${unrealizedPnL.toFixed(4)}`;
		}
		this.info(
			`POS: ${dir} ${Math.abs(sizeBase).toFixed(6)} ($${Math.abs(sizeUsd).toFixed(2)})${extra}${mode}`,
		);
	},

	fill(
		side: "buy" | "sell",
		price: number,
		size: number,
		fillPnL?: number,
		cumulativeRealizedPnL?: number,
	): void {
		let pnlStr = "";
		if (fillPnL !== undefined && fillPnL !== 0) {
			const sign = fillPnL >= 0 ? "+" : "";
			pnlStr += ` | fillPnL ${sign}$${fillPnL.toFixed(4)}`;
		}
		if (cumulativeRealizedPnL !== undefined) {
			const sign = cumulativeRealizedPnL >= 0 ? "+" : "";
			pnlStr += ` | rPnL ${sign}$${cumulativeRealizedPnL.toFixed(4)}`;
		}
		this.info(
			`FILL: ${side.toUpperCase()} ${size} @ $${price.toFixed(2)}${pnlStr}`,
		);
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

	balanceSummary(summary: {
		startingBalance: number;
		currentBalance: number;
		totalFunding: number;
		totalNetTrading: number;
		totalFees: number;
		netChange: number;
		syncCount: number;
	}): void {
		const fmt = (v: number) => {
			const sign = v >= 0 ? "+" : "";
			return `${sign}$${v.toFixed(4)}`;
		};
		const lines = [
			"═══ BALANCE SUMMARY ═══",
			`  Starting:    $${summary.startingBalance.toFixed(4)}`,
			`  Current:     $${summary.currentBalance.toFixed(4)}`,
			`  Net Change:  ${fmt(summary.netChange)}`,
			`  Funding:     ${fmt(summary.totalFunding)}`,
			`  Net Trading: ${fmt(summary.totalNetTrading)}`,
			`  Est Fees:    ${fmt(summary.totalFees)}`,
			`  Syncs:       ${summary.syncCount}`,
			"═══════════════════════",
		];
		for (const line of lines) {
			this.info(line);
			this.fileLog("balance", line);
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
		const uptimeMin = (summary.uptimeMs / 60000).toFixed(1);
		const fmt = (v: number) => {
			const sign = v >= 0 ? "+" : "";
			return `${sign}$${v.toFixed(4)}`;
		};
		this.info("═══ SESSION SUMMARY ═══");
		this.info(`  Uptime:     ${uptimeMin} min`);
		this.info(`  Fills:      ${summary.fillCount}`);
		this.info(`  Volume:     $${summary.totalVolumeUsd.toFixed(2)}`);
		this.info(`  Realized:   ${fmt(summary.realizedPnL)}`);
		this.info(`  Unrealized: ${fmt(summary.unrealizedPnL)}`);
		this.info(`  Net PnL:    ${fmt(summary.netPnL)}`);
		this.info(`  Avg Spread: ${summary.avgSpreadCapturedBps.toFixed(2)} bps`);
		this.info("═══════════════════════");
	},

	shutdown(): void {
		this.info("Shutting down...");
	},
};
