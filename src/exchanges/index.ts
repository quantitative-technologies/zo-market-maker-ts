// Exchange adapter factory

import type { ExchangeAdapter } from "./adapter.js";
import { ZoAdapter, type ZoAdapterConfig } from "./zo/adapter.js";

export type { ExchangeAdapter } from "./adapter.js";

export interface CreateAdapterOptions {
	readonly exchange: string;
	readonly privateKey: string;
	readonly symbol: string;
	readonly staleThresholdMs: number;
	readonly staleCheckIntervalMs: number;
}

export function createAdapter(options: CreateAdapterOptions): ExchangeAdapter {
	switch (options.exchange) {
		case "zo": {
			const config: ZoAdapterConfig = {
				symbol: options.symbol,
				staleThresholdMs: options.staleThresholdMs,
				staleCheckIntervalMs: options.staleCheckIntervalMs,
			};
			return new ZoAdapter(options.privateKey, config);
		}
		default:
			throw new Error(
				`Unknown exchange: "${options.exchange}". Supported: zo`,
			);
	}
}
