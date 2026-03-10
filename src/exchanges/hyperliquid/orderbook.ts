// Hyperliquid L2 orderbook stream — full snapshot per message (no deltas)

import WebSocket from "ws";
import type { BBO, MidPrice, PriceCallback } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { WsL2BookMsg } from "./types.js";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

class OrderbookSide {
	private levels = new Map<number, number>();
	private sortedPrices: number[] = [];

	constructor(
		private readonly isAsk: boolean,
		private readonly maxLevels: number,
	) {}

	setSnapshot(entries: { px: string; sz: string }[]): void {
		this.levels.clear();
		for (const { px, sz } of entries) {
			const price = Number(px);
			const size = Number(sz);
			if (size > 0) {
				this.levels.set(price, size);
			}
		}
		this.rebuildSortedPrices();
	}

	getBest(): number | null {
		return this.sortedPrices.length > 0 ? this.sortedPrices[0] : null;
	}

	clear(): void {
		this.levels.clear();
		this.sortedPrices = [];
	}

	size(): number {
		return this.levels.size;
	}

	private rebuildSortedPrices(): void {
		this.sortedPrices = Array.from(this.levels.keys());
		if (this.isAsk) {
			this.sortedPrices.sort((a, b) => a - b);
		} else {
			this.sortedPrices.sort((a, b) => b - a);
		}
		if (this.sortedPrices.length > this.maxLevels) {
			const removed = this.sortedPrices.splice(this.maxLevels);
			for (const price of removed) {
				this.levels.delete(price);
			}
		}
	}
}

export class HyperliquidOrderbookStream {
	private ws: WebSocket | null = null;
	private bids: OrderbookSide;
	private asks: OrderbookSide;
	private latestPrice: MidPrice | null = null;
	private lastUpdateTime = 0;
	private isClosing = false;
	private staleCheckInterval: NodeJS.Timeout | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private consecutiveFailures = 0;

	onPrice: PriceCallback | null = null;

	constructor(
		private readonly coin: string,
		private readonly staleThresholdMs: number,
		private readonly staleCheckIntervalMs: number,
		private readonly reconnectDelayMs: number,
		private readonly maxBookLevels: number,
	) {
		this.bids = new OrderbookSide(false, this.maxBookLevels);
		this.asks = new OrderbookSide(true, this.maxBookLevels);
	}

	async connect(): Promise<void> {
		if (this.ws) return;

		log.info(`Subscribing to Hyperliquid orderbook (${this.coin})...`);
		this.resetState();
		this.openWebSocket();
		this.startStaleCheck();

		// Wait for first book snapshot
		await this.waitForFirstSnapshot();

		log.info(
			`Hyperliquid orderbook active (${this.bids.size()} bids, ${this.asks.size()} asks)`,
		);
	}

	getMidPrice(): MidPrice | null {
		return this.latestPrice;
	}

	getBBO(): BBO | null {
		const bestBid = this.bids.getBest();
		const bestAsk = this.asks.getBest();
		if (bestBid === null || bestAsk === null) return null;
		return { bestBid, bestAsk };
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
		this.resetState();
	}

	private openWebSocket(): void {
		this.ws = new WebSocket(WS_URL);

		this.ws.on("open", () => {
			this.ws!.send(
				JSON.stringify({
					method: "subscribe",
					subscription: { type: "l2Book", coin: this.coin },
				}),
			);
		});

		this.ws.on("message", (raw: Buffer) => {
			this.lastUpdateTime = Date.now();
			try {
				const msg = JSON.parse(raw.toString()) as WsL2BookMsg;
				if (msg.channel === "l2Book") {
					this.handleBookSnapshot(msg);
				}
			} catch (err) {
				log.error("Hyperliquid orderbook parse error:", err);
			}
		});

		this.ws.on("error", (err: Error) => {
			log.error("Hyperliquid orderbook WS error:", err.message);
		});

		this.ws.on("close", () => {
			if (!this.isClosing) {
				log.warn("Hyperliquid orderbook disconnected");
				this.ws = null;
				this.scheduleReconnect();
			}
		});
	}

	private handleBookSnapshot(msg: WsL2BookMsg): void {
		const [bids, asks] = msg.data.levels;
		this.bids.setSnapshot(bids);
		this.asks.setSnapshot(asks);
		this.emitPrice();
	}

	private emitPrice(): void {
		const bestBid = this.bids.getBest();
		const bestAsk = this.asks.getBest();
		if (bestBid === null || bestAsk === null) return;

		const mid = (bestBid + bestAsk) / 2;
		this.latestPrice = {
			mid,
			bid: bestBid,
			ask: bestAsk,
			timestamp: Date.now(),
		};

		this.onPrice?.(this.latestPrice);
	}

	private waitForFirstSnapshot(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(
					new Error(
						"Timeout waiting for Hyperliquid orderbook snapshot",
					),
				);
			}, 30_000);

			const check = setInterval(() => {
				if (this.latestPrice) {
					clearInterval(check);
					clearTimeout(timeout);
					resolve();
				}
			}, 50);
		});
	}

	private startStaleCheck(): void {
		if (this.staleCheckInterval) return;
		this.staleCheckInterval = setInterval(() => {
			if (this.isClosing) return;
			const timeSinceUpdate = Date.now() - this.lastUpdateTime;
			if (
				this.lastUpdateTime > 0 &&
				timeSinceUpdate > this.staleThresholdMs
			) {
				log.warn(
					`Hyperliquid orderbook stale (${timeSinceUpdate}ms since last update). Reconnecting...`,
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
			log.info(`Reconnecting to Hyperliquid orderbook in ${delay}ms...`);
		}
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			try {
				this.resetState();
				this.openWebSocket();
				this.consecutiveFailures = 0;
				log.info("Hyperliquid orderbook reconnected");
			} catch (err) {
				this.consecutiveFailures++;
				log.error("Hyperliquid orderbook reconnect failed:", err);
				this.scheduleReconnect();
			}
		}, delay);
	}

	private resetState(): void {
		this.bids = new OrderbookSide(false, this.maxBookLevels);
		this.asks = new OrderbookSide(true, this.maxBookLevels);
		this.latestPrice = null;
		this.lastUpdateTime = 0;
	}
}
