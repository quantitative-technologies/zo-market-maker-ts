// Diagnostic tool: poll fetchInfo() and log position + balance fields
// Usage: npx tsx src/cli/inspect-position.ts SOL

import "dotenv/config";
import { createZoClient } from "../sdk/client.js";

const POLL_INTERVAL_MS = 2000;

interface Snapshot {
	balance: number;
	baseSize: number;
	entryPrice: number;
	sizePricePnl: number;
	fundingPnl: number;
}

function main(): void {
	const symbol = process.argv[2]?.toUpperCase();
	if (!symbol) {
		console.error("Usage: npx tsx src/cli/inspect-position.ts <symbol>");
		console.error("Example: npx tsx src/cli/inspect-position.ts SOL");
		process.exit(1);
	}

	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	run(symbol, privateKey).catch((err) => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}

async function run(symbol: string, privateKey: string): Promise<void> {
	const client = await createZoClient(privateKey);
	const { user, accountId, nord } = client;

	const market = nord.markets.find((m) =>
		m.symbol.toUpperCase().startsWith(symbol),
	);
	if (!market) {
		const available = nord.markets.map((m) => m.symbol).join(", ");
		console.error(`Market "${symbol}" not found. Available: ${available}`);
		process.exit(1);
	}

	const marketId = market.marketId;
	console.log(`Inspecting ${market.symbol} (marketId=${marketId}), account=${accountId}`);
	console.log(`Polling every ${POLL_INTERVAL_MS}ms. Trade on the exchange UI and watch the output.\n`);

	// Header
	console.log(
		"time".padEnd(12) +
		"balance".padStart(12) +
		"Δbal".padStart(10) +
		"  │ " +
		"baseSize".padStart(12) +
		"entry".padStart(10) +
		"sizePricePnl".padStart(14) +
		"Δpnl".padStart(10) +
		"fundingPnl".padStart(12) +
		"Δfund".padStart(10),
	);
	console.log("─".repeat(112));

	let prev: Snapshot | null = null;

	while (true) {
		await user.fetchInfo();

		const balanceEntries = user.balances[accountId] ?? [];
		const balance = balanceEntries.length > 0 ? balanceEntries[0].balance : 0;

		const positions = user.positions[accountId] ?? [];
		const pos = positions.find((p) => p.marketId === marketId);
		const perp = pos?.perp;

		const snap: Snapshot = {
			balance,
			baseSize: perp ? (perp.isLong ? perp.baseSize : -perp.baseSize) : 0,
			entryPrice: perp?.price ?? 0,
			sizePricePnl: perp?.sizePricePnl ?? 0,
			fundingPnl: perp?.fundingPaymentPnl ?? 0,
		};

		const dBal = prev ? snap.balance - prev.balance : 0;
		const dPnl = prev ? snap.sizePricePnl - prev.sizePricePnl : 0;
		const dFund = prev ? snap.fundingPnl - prev.fundingPnl : 0;

		const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

		const fmt = (v: number, w: number) => {
			const s = v.toFixed(4);
			return s.padStart(w);
		};
		const fmtDelta = (v: number, w: number) => {
			if (v === 0) return "".padStart(w);
			const sign = v > 0 ? "+" : "";
			return (sign + v.toFixed(4)).padStart(w);
		};

		console.log(
			time.padEnd(12) +
			fmt(snap.balance, 12) +
			fmtDelta(dBal, 10) +
			"  │ " +
			fmt(snap.baseSize, 12) +
			fmt(snap.entryPrice, 10) +
			fmt(snap.sizePricePnl, 14) +
			fmtDelta(dPnl, 10) +
			fmt(snap.fundingPnl, 12) +
			fmtDelta(dFund, 10),
		);

		prev = snap;
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

main();
