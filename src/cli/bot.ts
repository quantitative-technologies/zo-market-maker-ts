// CLI entry point for market maker bot

import "dotenv/config";
import { loadConfig } from "../bots/mm/config.js";
import { MarketMaker } from "../bots/mm/index.js";
import { createAdapter } from "../exchanges/index.js";
import { log } from "../utils/logger.js";

function parseArgs(): {
	symbol: string;
	configPath?: string;
	closePosition: boolean;
} {
	const args = process.argv.slice(2);
	let configPath: string | undefined;
	let closePosition = false;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config" && i + 1 < args.length) {
			configPath = args[++i];
		} else if (args[i] === "--close-position") {
			closePosition = true;
		} else if (!args[i].startsWith("--")) {
			positional.push(args[i]);
		}
	}

	const symbol = positional[0]?.toUpperCase();
	if (!symbol) {
		console.error(
			"Usage: npm run bot -- <symbol> [--config <path>] [--close-position]",
		);
		console.error("Example: npm run bot -- BTC");
		console.error("         npm run bot -- SOL --config custom.toml");
		console.error(
			"         npm run bot -- BTC --close-position  # close existing position before trading",
		);
		process.exit(1);
	}

	return { symbol, configPath, closePosition };
}

function main(): void {
	const { symbol, configPath, closePosition } = parseArgs();

	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const config = loadConfig(symbol, configPath);

	const adapter = createAdapter({
		exchange: config.exchange,
		privateKey,
		symbol: config.symbol,
		staleThresholdMs: config.staleThresholdMs,
		staleCheckIntervalMs: config.staleCheckIntervalMs,
		reconnectDelayMs: config.reconnectDelayMs,
		maxBookLevels: config.maxBookLevels,
	});

	const bot = new MarketMaker(config, adapter, { closePosition });

	bot.run().catch((err) => {
		log.error("Fatal error:", err);
		process.exit(1);
	});
}

main();
