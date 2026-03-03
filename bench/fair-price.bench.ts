import { bench, describe } from "vitest";
import { FairPriceCalculator } from "../src/pricing/fair-price.js";

const SAMPLE_COUNT = 300;
const BASE_PRICE = 150.0;

function createPrefilledCalculator(): FairPriceCalculator {
	const calc = new FairPriceCalculator({
		windowMs: 600_000, // 10 min to prevent sample expiry during bench
		minSamples: 10,
	});

	// Directly fill the circular buffer to bypass per-second deduplication.
	// FairPriceCalculator.addSample() gates on Date.now() seconds, so we
	// cannot call it 300 times in a tight loop. Instead, write the private
	// fields directly. This is a bench-only technique.
	// Source: src/pricing/fair-price.ts lines 35-38
	const nowSecond = Math.floor(Date.now() / 1000);
	const internals = calc as unknown as {
		samples: Array<{ offset: number; second: number }>;
		head: number;
		count: number;
		lastSecond: number;
	};

	for (let i = 0; i < SAMPLE_COUNT; i++) {
		const offset = (Math.random() - 0.5) * 0.1;
		const second = nowSecond - (SAMPLE_COUNT - i);
		internals.samples[i] = { offset, second };
	}
	internals.head = SAMPLE_COUNT % 500; // MAX_SAMPLES = 500
	internals.count = SAMPLE_COUNT;
	internals.lastSecond = nowSecond;

	return calc;
}

describe("FairPriceCalculator", () => {
	const calc = createPrefilledCalculator();
	const referenceMid = BASE_PRICE;

	bench("getFairPrice()", () => {
		calc.getFairPrice(referenceMid);
	});

	bench("getMedianOffset()", () => {
		calc.getMedianOffset();
	});

	bench("addSample() deduplicated (same second)", () => {
		calc.addSample(BASE_PRICE + 0.05, BASE_PRICE);
	});
});
