// Hyperliquid public trades WebSocket stream

import WebSocket from "ws";
import type { PublicTrade, PublicTradeCallback } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { WsTradesMsg } from "./types.js";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

export class HyperliquidTradeStream {
	private ws: WebSocket | null = null;
	private isClosing = false;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private consecutiveFailures = 0;

	onTrade: PublicTradeCallback | null = null;

	constructor(
		private readonly coin: string,
		private readonly reconnectDelayMs: number,
	) {}

	connect(): void {
		if (this.ws) return;

		log.info(`Subscribing to Hyperliquid trades (${this.coin})...`);
		this.openWebSocket();
		log.info("Hyperliquid trade stream active");
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	private openWebSocket(): void {
		this.ws = new WebSocket(WS_URL);

		this.ws.on("open", () => {
			this.ws!.send(
				JSON.stringify({
					method: "subscribe",
					subscription: { type: "trades", coin: this.coin },
				}),
			);
		});

		this.ws.on("message", (raw: Buffer) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (msg.channel === "trades") {
					this.handleTrades(msg as WsTradesMsg);
				}
			} catch (err) {
				log.error("Hyperliquid trades parse error:", err);
			}
		});

		this.ws.on("error", (err: Error) => {
			log.error("Hyperliquid trades WS error:", err.message);
		});

		this.ws.on("close", () => {
			if (!this.isClosing) {
				log.warn("Hyperliquid trade stream disconnected");
				this.ws = null;
				this.scheduleReconnect();
			}
		});
	}

	private handleTrades(msg: WsTradesMsg): void {
		const trades: PublicTrade[] = msg.data.map((t) => ({
			time: t.time,
			// A = taker sold (hit bid) → "sell", B = taker bought (hit ask) → "buy"
			side: t.side === "B" ? "buy" as const : "sell" as const,
			price: Number(t.px),
			size: Number(t.sz),
		}));

		if (trades.length > 0) {
			this.onTrade?.(trades);
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;

		const delay = this.consecutiveFailures === 0 ? 0 : this.reconnectDelayMs;
		if (delay > 0) {
			log.info(`Reconnecting to Hyperliquid trade stream in ${delay}ms...`);
		}
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			try {
				this.openWebSocket();
				this.consecutiveFailures = 0;
				log.info("Hyperliquid trade stream reconnected");
			} catch (err) {
				this.consecutiveFailures++;
				log.error("Hyperliquid trade stream reconnect failed:", err);
				this.scheduleReconnect();
			}
		}, delay);
	}
}
