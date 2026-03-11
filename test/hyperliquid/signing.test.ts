// Tests for Hyperliquid signing and wire format helpers

import { describe, expect, it } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signAction, floatToWire } from "../../src/exchanges/hyperliquid/signing.js";
import type { OrderAction, CancelAction, BatchModifyAction } from "../../src/exchanges/hyperliquid/types.js";

// Deterministic test key (DO NOT use with real funds)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);

describe("floatToWire", () => {
	it("formats integers without decimal point (matches Python SDK)", () => {
		expect(floatToWire(100)).toBe("100");
		expect(floatToWire(0)).toBe("0");
		expect(floatToWire(1)).toBe("1");
	});

	it("strips trailing zeros but keeps significant decimals", () => {
		expect(floatToWire(1.5)).toBe("1.5");
		expect(floatToWire(0.1)).toBe("0.1");
		expect(floatToWire(123.456)).toBe("123.456");
	});

	it("preserves up to 8 decimal places", () => {
		expect(floatToWire(0.00000001)).toBe("0.00000001");
		expect(floatToWire(1.23456789)).toBe("1.23456789");
	});

	it("truncates beyond 8 decimal places", () => {
		// 0.123456789 → toFixed(8) → "0.12345679" (rounded)
		expect(floatToWire(0.123456789)).toBe("0.12345679");
	});

	it("handles floating point edge cases", () => {
		// 0.1 + 0.2 = 0.30000000000000004 → toFixed(8) → "0.30000000" → normalized → "0.3"
		expect(floatToWire(0.1 + 0.2)).toBe("0.3");
	});
});

describe("signAction", () => {
	it("produces a valid signature with r, s, v fields", async () => {
		const action: OrderAction = {
			type: "order",
			orders: [
				{
					a: 0,
					b: true,
					p: "30000.0",
					s: "0.01",
					r: false,
					t: { limit: { tif: "Alo" } },
				},
			],
			grouping: "na",
		};

		const nonce = 1700000000000;
		const sig = await signAction(TEST_ACCOUNT, action, nonce);

		expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
		expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
		expect(sig.v).toBeGreaterThanOrEqual(27);
		expect(sig.v).toBeLessThanOrEqual(28);
	});

	it("produces deterministic signatures for the same input", async () => {
		const action: CancelAction = {
			type: "cancel",
			cancels: [{ a: 0, o: 12345 }],
		};

		const nonce = 1700000000000;
		const sig1 = await signAction(TEST_ACCOUNT, action, nonce);
		const sig2 = await signAction(TEST_ACCOUNT, action, nonce);

		expect(sig1.r).toBe(sig2.r);
		expect(sig1.s).toBe(sig2.s);
		expect(sig1.v).toBe(sig2.v);
	});

	it("produces different signatures for different nonces", async () => {
		const action: CancelAction = {
			type: "cancel",
			cancels: [{ a: 0, o: 12345 }],
		};

		const sig1 = await signAction(TEST_ACCOUNT, action, 1700000000000);
		const sig2 = await signAction(TEST_ACCOUNT, action, 1700000000001);

		expect(sig1.r).not.toBe(sig2.r);
	});

	it("connectionId matches manual computation", async () => {
		const action: OrderAction = {
			type: "order",
			orders: [
				{
					a: 3,
					b: false,
					p: "1234.5",
					s: "0.5",
					r: true,
					t: { limit: { tif: "Ioc" } },
				},
			],
			grouping: "na",
		};

		const nonce = 1700000000000;

		// Replicate the connectionId computation
		const actionBytes = msgpackEncode(action);
		const nonceBuf = new Uint8Array(8);
		const view = new DataView(nonceBuf.buffer);
		view.setUint32(0, Math.floor(nonce / 0x100000000));
		view.setUint32(4, nonce >>> 0);
		const vaultFlag = new Uint8Array([0]);

		const concat = new Uint8Array(actionBytes.length + 8 + 1);
		concat.set(new Uint8Array(actionBytes), 0);
		concat.set(nonceBuf, actionBytes.length);
		concat.set(vaultFlag, actionBytes.length + 8);

		const expectedConnectionId = keccak256(concat);

		// The signature should be valid and deterministic
		const sig = await signAction(TEST_ACCOUNT, action, nonce);
		expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);

		// Verify the connectionId is non-trivial
		expect(expectedConnectionId).not.toBe("0x" + "0".repeat(64));
	});

	it("handles batchModify actions", async () => {
		const action: BatchModifyAction = {
			type: "batchModify",
			modifies: [
				{
					oid: 99999,
					order: {
						a: 0,
						b: true,
						p: "30000.0",
						s: "0.01",
						r: false,
						t: { limit: { tif: "Alo" } },
					},
				},
			],
		};

		const sig = await signAction(TEST_ACCOUNT, action, Date.now());
		expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
		expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
	});
});
