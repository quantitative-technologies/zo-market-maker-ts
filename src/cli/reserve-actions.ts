// CLI script to reserve additional rate limit budget on Hyperliquid
//
// Usage: MASTER_KEY=0x... npm run reserve-actions -- <weight>
// Make:  MASTER_KEY=0x... make reserve-actions-1000
//
// Cost: 0.0005 USDC per unit of weight (10,000 = 5 USDC)
//
// NOTE: This action must be signed by the master wallet, not an API wallet.
// Pass the master private key via MASTER_KEY env var on the command line
// (not stored in .env for security).

import type { Hex } from "viem";
import { HyperliquidClient } from "../exchanges/hyperliquid/client.js";

const COST_PER_WEIGHT = 0.0005;

function parseArgs(): { weight: number } {
	const args = process.argv.slice(2);
	const weight = Number(args[0]);
	if (!args[0] || !Number.isInteger(weight) || weight <= 0) {
		console.error("Usage: MASTER_KEY=0x... npm run reserve-actions -- <weight>");
		console.error("Example: MASTER_KEY=0x... npm run reserve-actions -- 10000  (costs 5 USDC)");
		console.error("");
		console.error(`Cost: ${COST_PER_WEIGHT} USDC per request reserved`);
		process.exit(1);
	}
	return { weight };
}

async function main(): Promise<void> {
	const { weight } = parseArgs();
	const cost = weight * COST_PER_WEIGHT;

	const rawKey = process.env.MASTER_KEY;
	if (!rawKey) {
		console.error("MASTER_KEY env var is required (master wallet private key).");
		console.error("Usage: MASTER_KEY=0x... npm run reserve-actions -- <weight>");
		process.exit(1);
	}

	const privateKey: Hex = rawKey.startsWith("0x") ? rawKey as Hex : `0x${rawKey}`;
	const client = new HyperliquidClient(privateKey);

	console.log(`Reserving ${weight} request credits (cost: ${cost.toFixed(4)} USDC)...`);
	await client.reserveRequestWeight(weight);
	console.log("Done.");
}

main().catch((err) => {
	console.error("Failed:", err);
	process.exit(1);
});
