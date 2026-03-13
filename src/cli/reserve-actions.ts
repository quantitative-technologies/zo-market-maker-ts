// CLI script to reserve additional rate limit budget on Hyperliquid
//
// Usage: npm run reserve-actions -- <weight>
// Example: npm run reserve-actions -- 10000
//
// Cost: 0.0005 USDC per unit of weight (10,000 = 5 USDC)

import "dotenv/config";
import type { Hex } from "viem";
import { HyperliquidClient } from "../exchanges/hyperliquid/client.js";

const COST_PER_WEIGHT = 0.0005;

function parseArgs(): { weight: number } {
	const args = process.argv.slice(2);
	const weight = Number(args[0]);
	if (!args[0] || !Number.isInteger(weight) || weight <= 0) {
		console.error("Usage: npm run reserve-actions -- <weight>");
		console.error("Example: npm run reserve-actions -- 10000  (costs 5 USDC)");
		console.error("");
		console.error(`Cost: ${COST_PER_WEIGHT} USDC per request reserved`);
		process.exit(1);
	}
	return { weight };
}

async function main(): Promise<void> {
	const { weight } = parseArgs();
	const cost = weight * COST_PER_WEIGHT;

	const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: HYPERLIQUID_PRIVATE_KEY");
		process.exit(1);
	}

	const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;

	const client = new HyperliquidClient(
		privateKey as Hex,
		walletAddress as Hex | undefined,
	);

	console.log(`Reserving ${weight} request credits (cost: ${cost.toFixed(4)} USDC)...`);
	await client.reserveRequestWeight(weight);
	console.log("Done.");
}

main().catch((err) => {
	console.error("Failed:", err);
	process.exit(1);
});
