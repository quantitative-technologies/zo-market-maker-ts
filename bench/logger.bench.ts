import { bench, describe } from "vitest";
import { log } from "../src/utils/logger.js";

// Redirect all output to a no-op to isolate formatting from I/O
log.setOutput(() => {});

describe("Logger formatting (info level)", () => {
	bench("info() with string message", () => {
		log.info("Test message for benchmarking");
	});

	bench("info() with object arg", () => {
		log.info("Event:", { orderId: "abc123", price: 150.25, size: 1.5 });
	});

	bench("quote()", () => {
		log.quote(150.1, 150.2, 150.15, 10, "normal");
	});

	bench("fill() with PnL", () => {
		log.fill("buy", 150.15, 0.5, 0.0025, 0.015);
	});

	bench("position() with entry and uPnL", () => {
		log.position(0.5, 75.0, true, false, 149.8, 0.175);
	});

	bench("debug() filtered out (level=info)", () => {
		log.debug("This should not format");
	});
});

describe("Logger formatting (debug level)", () => {
	bench("debug() with formatting enabled", () => {
		log.setLevel("debug");
		log.debug("Debug message:", { orderId: "abc123", price: 150.25 });
		log.setLevel("info");
	});
});
