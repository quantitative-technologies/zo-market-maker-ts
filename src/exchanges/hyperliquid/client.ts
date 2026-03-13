// Hyperliquid HTTP client — info (public) + exchange (signed) endpoints

import { type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "../../utils/logger.js";
import { signAction, floatToWire } from "./signing.js";
import type {
	BatchModifyAction,
	BatchModifyResponseSuccess,
	CancelAction,
	CancelResponseSuccess,
	CancelWire,
	ClearinghouseState,
	ExchangeResponse,
	MetaResponse,
	ModifyWire,
	SpotMetaResponse,
	OpenOrder,
	OrderAction,
	OrderResponseSuccess,
	OrderStatus,
	OrderWire,
	ReserveRequestWeightAction,
	UserFees,
	UserFill,
} from "./types.js";

const BASE_URL = "https://api.hyperliquid.xyz";

export class HyperliquidClient {
	readonly account: LocalAccount;
	readonly walletAddress: Hex;

	constructor(privateKey: Hex, walletAddress?: Hex) {
		this.account = privateKeyToAccount(privateKey);
		// API wallet: queries and vault operations use the main wallet address
		// Direct wallet: use the derived address
		this.walletAddress = walletAddress ?? this.account.address;
	}

	// ── Info endpoints (no auth) ──

	async getMeta(): Promise<MetaResponse> {
		return this.postInfo<MetaResponse>("meta");
	}

	async getSpotMeta(): Promise<SpotMetaResponse> {
		return this.postInfo<SpotMetaResponse>("spotMeta");
	}

	async getClearinghouseState(): Promise<ClearinghouseState> {
		return this.postInfo<ClearinghouseState>("clearinghouseState", {
			user: this.walletAddress,
		});
	}

	async getOpenOrders(): Promise<OpenOrder[]> {
		return this.postInfo<OpenOrder[]>("openOrders", {
			user: this.walletAddress,
		});
	}

	async getUserFills(startTime?: number): Promise<UserFill[]> {
		if (startTime !== undefined) {
			return this.postInfo<UserFill[]>("userFillsByTime", {
				user: this.walletAddress,
				startTime,
			});
		}
		return this.postInfo<UserFill[]>("userFills", {
			user: this.walletAddress,
		});
	}

	async getUserFees(): Promise<UserFees> {
		return this.postInfo<UserFees>("userFees", {
			user: this.walletAddress,
		});
	}

	// ── Exchange endpoints (signed) ──

	async placeOrders(orders: OrderWire[]): Promise<OrderStatus[]> {
		const action: OrderAction = {
			type: "order",
			orders,
			grouping: "na",
		};

		const response = await this.postExchange(action);
		if (response.status === "err") {
			throw new Error(`Place orders failed: ${response.response}`);
		}
		const success = response as OrderResponseSuccess;
		return success.response.data.statuses;
	}

	async cancelOrders(cancels: CancelWire[]): Promise<void> {
		const action: CancelAction = {
			type: "cancel",
			cancels,
		};

		const response = await this.postExchange(action);
		if (response.status === "err") {
			throw new Error(`Cancel orders failed: ${response.response}`);
		}

		const success = response as CancelResponseSuccess;
		const errors = success.response.data.statuses.filter(
			(s) => typeof s === "object" && "error" in s,
		);
		if (errors.length > 0) {
			log.warn(`Cancel had ${errors.length} errors:`, errors);
		}
	}

	async batchModify(modifies: ModifyWire[]): Promise<OrderStatus[]> {
		const action: BatchModifyAction = {
			type: "batchModify",
			modifies,
		};

		const response = await this.postExchange(action);
		if (response.status === "err") {
			throw new Error(`Batch modify failed: ${response.response}`);
		}
		const success = response as BatchModifyResponseSuccess;
		return success.response.data.statuses;
	}

	async reserveRequestWeight(weight: number): Promise<void> {
		const action: ReserveRequestWeightAction = {
			type: "reserveRequestWeight",
			weight,
		};

		const response = await this.postExchange(action);
		if (response.status === "err") {
			throw new Error(`Reserve request weight failed: ${response.response}`);
		}
	}

	// ── Private helpers ──

	private async postInfo<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
		const body = payload ? { type, ...payload } : { type };
		const res = await fetch(`${BASE_URL}/info`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Hyperliquid info/${type} failed (${res.status}): ${text}`);
		}

		return res.json() as Promise<T>;
	}

	private async postExchange(action: OrderAction | CancelAction | BatchModifyAction | ReserveRequestWeightAction): Promise<ExchangeResponse> {
		const nonce = Date.now();
		// API wallets sign directly — no vaultAddress needed
		const signature = await signAction(this.account, action, nonce);

		const body = {
			action,
			nonce,
			signature,
		};

		const res = await fetch(`${BASE_URL}/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Hyperliquid exchange/${action.type} failed (${res.status}): ${text}`);
		}

		return res.json() as Promise<ExchangeResponse>;
	}
}

// ── Price/size rounding ──

const MAX_SIGNIFICANT_FIGURES = 5;
export const MAX_PRICE_DECIMALS_PERP = 6;

/**
 * Round price per Hyperliquid rules: 5 significant figures, max 6 - szDecimals decimal places.
 * Mirrors Python SDK: round(float(f"{px:.5g}"), 6 - sz_decimals)
 */
export function roundPrice(price: number, szDecimals: number): number {
	const sigFigRounded = Number(price.toPrecision(MAX_SIGNIFICANT_FIGURES));
	return Number(sigFigRounded.toFixed(MAX_PRICE_DECIMALS_PERP - szDecimals));
}

// ── Wire format helpers ──

export function buildOrderWire(
	assetIndex: number,
	isBuy: boolean,
	price: number,
	size: number,
	reduceOnly: boolean,
	tif: "Alo" | "Gtc" | "Ioc",
): OrderWire {
	return {
		a: assetIndex,
		b: isBuy,
		p: floatToWire(price),
		s: floatToWire(size),
		r: reduceOnly,
		t: { limit: { tif } },
	};
}

export function buildCancelWire(assetIndex: number, orderId: number): CancelWire {
	return { a: assetIndex, o: orderId };
}

export function buildModifyWire(orderId: number, order: OrderWire): ModifyWire {
	return { oid: orderId, order };
}
