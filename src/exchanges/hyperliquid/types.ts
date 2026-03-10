// Hyperliquid API types

// ── Meta endpoint ──

export interface AssetMeta {
	name: string;
	szDecimals: number;
}

export interface MetaResponse {
	universe: AssetMeta[];
}

// ── Clearinghouse state ──

export interface AssetPosition {
	position: {
		coin: string;
		szi: string; // Signed size (negative = short)
		entryPx: string;
		positionValue: string;
		unrealizedPnl: string;
		returnOnEquity: string;
		liquidationPx: string | null;
		leverage: {
			type: string;
			value: number;
		};
		cumFunding: {
			sinceOpen: string;
			sinceChange: string;
			allTime: string;
		};
	};
	type: "oneWay";
}

export interface ClearinghouseState {
	assetPositions: AssetPosition[];
	crossMarginSummary: {
		accountValue: string;
		totalMarginUsed: string;
		totalNtlPos: string;
		totalRawUsd: string;
	};
	marginSummary: {
		accountValue: string;
		totalMarginUsed: string;
		totalNtlPos: string;
		totalRawUsd: string;
	};
	withdrawable: string;
}

// ── Open orders ──

export interface OpenOrder {
	coin: string;
	limitPx: string;
	oid: number;
	side: "A" | "B"; // A = ask/sell, B = bid/buy
	sz: string;
	timestamp: number;
}

// ── User fills ──

export interface UserFill {
	coin: string;
	px: string;
	sz: string;
	side: "A" | "B";
	time: number;
	startPosition: string;
	dir: string;
	closedPnl: string;
	hash: string;
	oid: number;
	crossed: boolean; // true = taker
	fee: string;
	tid: number;
}

// ── User fees ──

export interface UserFees {
	activeReferralDiscount: string;
	dailyUserVlm: {
		date: string;
		userAdd: string;
		userCross: string;
		exchange: string;
	}[];
	feeSchedule: {
		add: string;
		cross: string;
		referralDiscount: string;
		tiers: {
			ntlAdd: string;
			ntlCross: string;
			vip: string;
			mm: string;
		};
	};
	userAdd: string;
	userCross: string;
}

// ── Order wire format ──

export interface OrderWire {
	a: number; // Asset index
	b: boolean; // true = buy (bid), false = sell (ask)
	p: string; // Price
	s: string; // Size
	r: boolean; // Reduce-only
	t: OrderType;
}

export interface OrderTypeLimit {
	limit: {
		tif: "Alo" | "Gtc" | "Ioc";
	};
}

export interface OrderTypeTrigger {
	trigger: {
		triggerPx: string;
		isMarket: boolean;
		tpsl: "tp" | "sl";
	};
}

export type OrderType = OrderTypeLimit | OrderTypeTrigger;

// ── Modify wire format ──

export interface ModifyWire {
	oid: number;
	order: OrderWire;
}

// ── Cancel wire format ──

export interface CancelWire {
	a: number; // Asset index
	o: number; // Order ID
}

// ── Exchange action types ──

export interface OrderAction {
	type: "order";
	orders: OrderWire[];
	grouping: "na";
}

export interface CancelAction {
	type: "cancel";
	cancels: CancelWire[];
}

export interface BatchModifyAction {
	type: "batchModify";
	modifies: ModifyWire[];
}

export type ExchangeAction = OrderAction | CancelAction | BatchModifyAction;

// ── Exchange response ──

export interface OrderResponseSuccess {
	status: "ok";
	response: {
		type: "order";
		data: {
			statuses: OrderStatus[];
		};
	};
}

export interface OrderStatus {
	resting?: { oid: number };
	filled?: { totalSz: string; avgPx: string; oid: number };
	error?: string;
}

export interface CancelResponseSuccess {
	status: "ok";
	response: {
		type: "cancel";
		data: {
			statuses: ("success" | { error: string })[];
		};
	};
}

export interface BatchModifyResponseSuccess {
	status: "ok";
	response: {
		type: "order";
		data: {
			statuses: OrderStatus[];
		};
	};
}

export interface ExchangeResponseError {
	status: "err";
	response: string;
}

export type ExchangeResponse =
	| OrderResponseSuccess
	| CancelResponseSuccess
	| BatchModifyResponseSuccess
	| ExchangeResponseError;

// ── WebSocket messages ──

export interface WsL2BookMsg {
	channel: "l2Book";
	data: {
		coin: string;
		time: number;
		levels: [L2Level[], L2Level[]]; // [bids, asks]
	};
}

export interface L2Level {
	px: string;
	sz: string;
	n: number; // Number of orders
}

export interface WsUserFillMsg {
	channel: "userFills";
	data: WsUserFill[];
}

export interface WsUserFill {
	coin: string;
	px: string;
	sz: string;
	side: "A" | "B";
	time: number;
	hash: string;
	oid: number;
	crossed: boolean;
	fee: string;
	tid: number;
	startPosition: string;
	dir: string;
	closedPnl: string;
}

export interface WsOrderUpdate {
	order: {
		coin: string;
		side: "A" | "B";
		limitPx: string;
		sz: string;
		oid: number;
		timestamp: number;
		origSz: string;
	};
	status: "open" | "filled" | "canceled" | "triggered" | "rejected" | "marginCanceled";
	statusTimestamp: number;
}

export interface WsOrderUpdatesMsg {
	channel: "orderUpdates";
	data: WsOrderUpdate[];
}

export type WsMessage = WsL2BookMsg | WsUserFillMsg | WsOrderUpdatesMsg;
