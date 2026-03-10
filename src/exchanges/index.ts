// Exchange adapter factory

import type { ExchangeAdapter } from "./adapter.js";
import { HyperliquidAdapter, type HyperliquidAdapterConfig } from "./hyperliquid/adapter.js";
import { ZoAdapter, type ZoAdapterConfig } from "./zo/adapter.js";

export type { ExchangeAdapter } from "./adapter.js";

export interface CreateAdapterOptions {
	readonly exchange: string;
	readonly privateKey: string;
	readonly walletAddress?: string;
	readonly symbol: string;
	readonly staleThresholdMs: number;
	readonly staleCheckIntervalMs: number;
	readonly reconnectDelayMs: number;
	readonly maxBookLevels: number;
}

export function createAdapter(options: CreateAdapterOptions): ExchangeAdapter {
	switch (options.exchange) {
		case "zo": {
			const config: ZoAdapterConfig = {
				symbol: options.symbol,
				staleThresholdMs: options.staleThresholdMs,
				staleCheckIntervalMs: options.staleCheckIntervalMs,
				reconnectDelayMs: options.reconnectDelayMs,
				maxBookLevels: options.maxBookLevels,
			};
			return new ZoAdapter(options.privateKey, config);
		}
		case "hyperliquid": {
			const config: HyperliquidAdapterConfig = {
				symbol: options.symbol,
				staleThresholdMs: options.staleThresholdMs,
				staleCheckIntervalMs: options.staleCheckIntervalMs,
				reconnectDelayMs: options.reconnectDelayMs,
				maxBookLevels: options.maxBookLevels,
			};
			return new HyperliquidAdapter(options.privateKey, options.walletAddress, config);
		}
		default:
			throw new Error(
				`Unknown exchange: "${options.exchange}". Supported: zo, hyperliquid`,
			);
	}
}
