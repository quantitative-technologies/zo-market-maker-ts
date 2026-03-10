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
	OpenOrder,
	OrderAction,
	OrderResponseSuccess,
	OrderStatus,
	OrderWire,
	UserFees,
	UserFill,
} from "./types.js";

const BASE_URL = "https://api.hyperliquid.xyz";

export class HyperliquidClient {
	readonly account: LocalAccount;
	readonly address: Hex;

	constructor(privateKey: Hex) {
		this.account = privateKeyToAccount(privateKey);
		this.address = this.account.address;
	}

	// ── Info endpoints (no auth) ──

	async getMeta(): Promise<MetaResponse> {
		return this.postInfo<MetaResponse>("meta");
	}

	async getClearinghouseState(): Promise<ClearinghouseState> {
		return this.postInfo<ClearinghouseState>("clearinghouseState", {
			user: this.address,
		});
	}

	async getOpenOrders(): Promise<OpenOrder[]> {
		return this.postInfo<OpenOrder[]>("openOrders", {
			user: this.address,
		});
	}

	async getUserFills(startTime?: number): Promise<UserFill[]> {
		if (startTime !== undefined) {
			return this.postInfo<UserFill[]>("userFillsByTime", {
				user: this.address,
				startTime,
			});
		}
		return this.postInfo<UserFill[]>("userFills", {
			user: this.address,
		});
	}

	async getUserFees(): Promise<UserFees> {
		return this.postInfo<UserFees>("userFees", {
			user: this.address,
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

	private async postExchange(action: OrderAction | CancelAction | BatchModifyAction): Promise<ExchangeResponse> {
		const nonce = Date.now();
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
