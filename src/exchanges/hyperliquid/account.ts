// Hyperliquid account WebSocket stream — userFills + orderUpdates

import WebSocket from "ws";
import type { FillCallback, FillEvent, OrderCanceledCallback } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { WsOrderUpdate, WsOrderUpdatesMsg, WsUserFill, WsUserFillMsg } from "./types.js";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

function hlSideToBidAsk(side: "A" | "B"): "bid" | "ask" {
	return side === "B" ? "bid" : "ask";
}

export class HyperliquidAccountStream {
	private ws: WebSocket | null = null;
	private isClosing = false;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private consecutiveFailures = 0;
	private lastMessageTime = 0;
	private staleCheckInterval: NodeJS.Timeout | null = null;

	onFill: FillCallback | null = null;
	onOrderCanceled: OrderCanceledCallback | null = null;

	constructor(
		private readonly address: string,
		private readonly coin: string,
		private readonly staleThresholdMs: number,
		private readonly staleCheckIntervalMs: number,
		private readonly reconnectDelayMs: number,
	) {}

	connect(): void {
		if (this.ws) return;

		log.info(`Subscribing to Hyperliquid account updates (${this.address.slice(0, 10)}...)...`);
		this.openWebSocket();
		this.startStaleCheck();
		log.info("Hyperliquid account subscription active");
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.staleCheckInterval) {
			clearInterval(this.staleCheckInterval);
			this.staleCheckInterval = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	private openWebSocket(): void {
		this.ws = new WebSocket(WS_URL);

		this.ws.on("open", () => {
			// Subscribe to both channels on the same connection
			this.ws!.send(
				JSON.stringify({
					method: "subscribe",
					subscription: { type: "userFills", user: this.address },
				}),
			);
			this.ws!.send(
				JSON.stringify({
					method: "subscribe",
					subscription: { type: "orderUpdates", user: this.address },
				}),
			);
		});

		this.ws.on("message", (raw: Buffer) => {
			this.lastMessageTime = Date.now();
			try {
				const msg = JSON.parse(raw.toString());
				if (msg.channel === "userFills") {
					this.handleUserFills(msg as WsUserFillMsg);
				} else if (msg.channel === "orderUpdates") {
					this.handleOrderUpdates(msg as WsOrderUpdatesMsg);
				}
			} catch (err) {
				log.error("Hyperliquid account parse error:", err);
			}
		});

		this.ws.on("error", (err: Error) => {
			log.error("Hyperliquid account WS error:", err.message);
		});

		this.ws.on("close", () => {
			if (!this.isClosing) {
				log.warn("Hyperliquid account stream disconnected");
				this.ws = null;
				this.scheduleReconnect();
			}
		});
	}

	private handleUserFills(msg: WsUserFillMsg): void {
		if (msg.data.isSnapshot) return;

		for (const fill of msg.data.fills) {
			if (fill.coin !== this.coin) continue;

			const fillEvent: FillEvent = {
				orderId: String(fill.oid),
				side: hlSideToBidAsk(fill.side),
				size: Number(fill.sz),
				price: Number(fill.px),
				remaining: 0, // Hyperliquid fills don't include remaining — adapter tracks via open orders
				marketId: 0, // Single-market per adapter, not used for routing
			};

			this.onFill?.(fillEvent);
		}
	}

	private handleOrderUpdates(msg: WsOrderUpdatesMsg): void {
		for (const update of msg.data) {
			if (update.order.coin !== this.coin) continue;

			const status = update.status;
			if (status === "open" || status === "filled") continue;

			const orderId = String(update.order.oid);
			log.debug(`Order ${orderId} ${status} (${update.order.side} ${update.order.sz}@${update.order.limitPx})`);
			this.onOrderCanceled?.(orderId);
		}
	}

	private startStaleCheck(): void {
		if (this.staleCheckInterval) return;
		this.staleCheckInterval = setInterval(() => {
			if (this.isClosing) return;
			const timeSinceUpdate = Date.now() - this.lastMessageTime;
			if (
				this.lastMessageTime > 0 &&
				timeSinceUpdate > this.staleThresholdMs
			) {
				log.warn(
					`Hyperliquid account stream stale (${timeSinceUpdate}ms since last update). Reconnecting...`,
				);
				this.scheduleReconnect();
			}
		}, this.staleCheckIntervalMs);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		// Immediate first attempt, then configurable backoff
		const delay = this.consecutiveFailures === 0 ? 0 : this.reconnectDelayMs;
		if (delay > 0) {
			log.info(`Reconnecting to Hyperliquid account stream in ${delay}ms...`);
		}
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			try {
				this.openWebSocket();
				this.consecutiveFailures = 0;
				log.info("Hyperliquid account stream reconnected");
			} catch (err) {
				this.consecutiveFailures++;
				log.error("Hyperliquid account stream reconnect failed:", err);
				this.scheduleReconnect();
			}
		}, delay);
	}
}
