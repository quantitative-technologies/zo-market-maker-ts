// Simple logger with millisecond precision
// Format: timestamp [LEVEL] CATEGORY: message

type LogOutput = (message: string) => void;
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let outputFn: LogOutput = (msg) => console.log(msg);
let errorFn: LogOutput = (msg) => console.error(msg);
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

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

function format(level: string, message: string, ...args: unknown[]): string {
	const argStr = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
	return `${timestamp()} [${level}] ${message}${argStr}`;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

export const log = {
	setOutput(fn: LogOutput): void {
		outputFn = fn;
		errorFn = fn;
	},

	setLevel(level: LogLevel): void {
		minLevel = level;
	},

	info(message: string, ...args: unknown[]): void {
		if (!shouldLog("info")) return;
		outputFn(format("INFO", message, ...args));
	},

	warn(message: string, ...args: unknown[]): void {
		if (!shouldLog("warn")) return;
		outputFn(format("WARN", message, ...args));
	},

	error(message: string, ...args: unknown[]): void {
		if (!shouldLog("error")) return;
		errorFn(format("ERROR", message, ...args));
	},

	debug(message: string, ...args: unknown[]): void {
		if (!shouldLog("debug")) return;
		outputFn(format("DEBUG", message, ...args));
	},

	// MM specific logs - all use INFO level with category prefix
	quote(
		bid: number | null,
		ask: number | null,
		fair: number,
		spreadBps: number,
		mode: "normal" | "close",
	): void {
		const bidStr = bid !== null ? `$${bid.toFixed(2)}` : "--";
		const askStr = ask !== null ? `$${ask.toFixed(2)}` : "--";
		outputFn(
			format(
				"INFO",
				`QUOTE: BID ${bidStr} | ASK ${askStr} | FAIR $${fair.toFixed(2)} | SPREAD ${spreadBps}bps | ${mode.toUpperCase()}`,
			),
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
		outputFn(
			format(
				"INFO",
				`POS: ${dir} ${Math.abs(sizeBase).toFixed(6)} ($${Math.abs(sizeUsd).toFixed(2)})${extra}${mode}`,
			),
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
		outputFn(
			format(
				"INFO",
				`FILL: ${side.toUpperCase()} ${size} @ $${price.toFixed(2)}${pnlStr}`,
			),
		);
	},

	banner(): void {
		outputFn(`
╔═══════════════════════════════════════╗
║         ZO MARKET MAKER BOT           ║
╚═══════════════════════════════════════╝
`);
	},

	config(cfg: Record<string, unknown>): void {
		outputFn(format("INFO", "CONFIG:"));
		for (const [key, value] of Object.entries(cfg)) {
			outputFn(`  ${key}: ${value}`);
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
		outputFn(format("INFO", "═══ SESSION SUMMARY ═══"));
		outputFn(format("INFO", `  Uptime:     ${uptimeMin} min`));
		outputFn(format("INFO", `  Fills:      ${summary.fillCount}`));
		outputFn(format("INFO", `  Volume:     $${summary.totalVolumeUsd.toFixed(2)}`));
		outputFn(format("INFO", `  Realized:   ${fmt(summary.realizedPnL)}`));
		outputFn(format("INFO", `  Unrealized: ${fmt(summary.unrealizedPnL)}`));
		outputFn(format("INFO", `  Net PnL:    ${fmt(summary.netPnL)}`));
		outputFn(format("INFO", `  Avg Spread: ${summary.avgSpreadCapturedBps.toFixed(2)} bps`));
		outputFn(format("INFO", "═══════════════════════"));
	},

	shutdown(): void {
		outputFn(format("INFO", "Shutting down..."));
	},
};
