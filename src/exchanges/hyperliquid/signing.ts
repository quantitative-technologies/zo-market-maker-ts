// Hyperliquid EIP-712 phantom agent signing
// Translated from Python SDK: https://github.com/hyperliquid-dex/hyperliquid-python-sdk

import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
	type Hex,
	type LocalAccount,
	keccak256,
	toHex,
} from "viem";
import Decimal from "decimal.js";
import type { ExchangeAction } from "./types.js";

// EIP-712 domain for Hyperliquid Exchange (mainnet)
const DOMAIN = {
	name: "Exchange",
	version: "1",
	chainId: 1337,
	verifyingContract: "0x0000000000000000000000000000000000000000" as Hex,
} as const;

// EIP-712 types for phantom agent
const AGENT_TYPES = {
	Agent: [
		{ name: "source", type: "string" },
		{ name: "connectionId", type: "bytes32" },
	],
} as const;

export interface Signature {
	r: Hex;
	s: Hex;
	v: number;
}

/**
 * Sign an exchange action using the phantom agent pattern.
 *
 * 1. msgpack(action) → actionBytes
 * 2. concat: actionBytes + nonce(8 bytes BE) + vaultFlag(1 byte)
 * 3. keccak256(concat) → connectionId
 * 4. Sign EIP-712 Agent { source: "a", connectionId }
 */
export async function signAction(
	account: LocalAccount,
	action: ExchangeAction,
	nonce: number,
	vaultAddress?: Hex,
): Promise<Signature> {
	const actionBytes = msgpackEncode(action);

	// Build concat: actionBytes + nonce(8 bytes BE) + vaultFlag
	const nonceBuf = new Uint8Array(8);
	const view = new DataView(nonceBuf.buffer);
	// Write nonce as uint64 big-endian
	view.setUint32(0, Math.floor(nonce / 0x100000000));
	view.setUint32(4, nonce >>> 0);

	const vaultFlag = new Uint8Array([vaultAddress ? 1 : 0]);

	// Concatenate all parts
	const parts: Uint8Array[] = [new Uint8Array(actionBytes), nonceBuf, vaultFlag];
	if (vaultAddress) {
		const vaultBytes = hexToBytes(vaultAddress);
		parts.push(vaultBytes);
	}

	const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
	const concat = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		concat.set(part, offset);
		offset += part.length;
	}

	const connectionId = keccak256(concat);

	const sig = await account.signTypedData({
		domain: DOMAIN,
		types: AGENT_TYPES,
		primaryType: "Agent",
		message: {
			source: "a", // "a" = mainnet
			connectionId,
		},
	});

	return splitSignature(sig);
}

function splitSignature(sig: Hex): Signature {
	// sig is 65 bytes: r(32) + s(32) + v(1)
	const bytes = hexToBytes(sig);
	const r = toHex(bytes.slice(0, 32));
	const s = toHex(bytes.slice(32, 64));
	const v = bytes[64];
	return { r, s, v };
}

function hexToBytes(hex: Hex): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * Format a number for the Hyperliquid wire format.
 * Python SDK: float_to_wire → Decimal(f"{x:.8f}").normalize()
 * Must have at least one decimal place, no trailing zeros otherwise.
 */
export function floatToWire(x: number): string {
	const d = new Decimal(x.toFixed(8));
	const normalized = d.toFixed();
	// Ensure at least one decimal place
	if (!normalized.includes(".")) {
		return normalized + ".0";
	}
	return normalized;
}
