// MarketMaker configuration — all values must be specified in config.toml

import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { log } from "../../utils/logger.js";

export interface MarketMakerConfig {
  readonly symbol: string // e.g., "BTC" or "ETH"

  // Strategy parameters
  readonly spreadBps: number // Spread from fair price (bps)
  readonly takeProfitBps: number // Spread in close mode (bps)
  readonly orderSizeUsd: number // Order size in USD
  readonly closeThresholdUsd: number // Trigger close mode when position >= this
  readonly warmupSeconds: number // Seconds to warm up before quoting

  // Operational parameters
  readonly updateThrottleMs: number // Min interval between quote updates
  readonly orderSyncIntervalMs: number // Interval for syncing orders from API
  readonly statusIntervalMs: number // Interval for status display
  readonly fairPriceWindowMs: number // Window for fair price calculation
  readonly positionSyncIntervalMs: number // Interval for position sync
  readonly staleThresholdMs: number // Consider stream stale after this many ms
  readonly staleCheckIntervalMs: number // How often to check for staleness
}

// snake_case TOML key → camelCase config field
const KEY_MAP: Record<string, keyof Omit<MarketMakerConfig, 'symbol'>> = {
  // Strategy
  spread_bps: 'spreadBps',
  take_profit_bps: 'takeProfitBps',
  order_size_usd: 'orderSizeUsd',
  close_threshold_usd: 'closeThresholdUsd',
  warmup_seconds: 'warmupSeconds',
  // Operational
  update_throttle_ms: 'updateThrottleMs',
  order_sync_interval_ms: 'orderSyncIntervalMs',
  status_interval_ms: 'statusIntervalMs',
  fair_price_window_ms: 'fairPriceWindowMs',
  position_sync_interval_ms: 'positionSyncIntervalMs',
  stale_threshold_ms: 'staleThresholdMs',
  stale_check_interval_ms: 'staleCheckIntervalMs',
}

// All TOML keys that must be present (globally or per-symbol)
const REQUIRED_KEYS = Object.keys(KEY_MAP);

// Extract numeric config values from a TOML section, mapping snake_case → camelCase
function extractValues(
  section: Record<string, unknown>,
): Partial<Omit<MarketMakerConfig, 'symbol'>> {
  const values: Record<string, number> = {};
  for (const [tomlKey, configKey] of Object.entries(KEY_MAP)) {
    const val = section[tomlKey];
    if (val !== undefined) {
      if (typeof val !== "number") {
        throw new Error(`Config key "${tomlKey}" must be a number, got ${typeof val}`);
      }
      values[configKey] = val;
    }
  }
  return values;
}

// Load config from TOML file with per-symbol overrides
// Merge order: TOML globals → TOML [SYMBOL] section
// All keys must be present after merge — missing keys are an error.
export function loadConfig(symbol: string, configPath?: string): MarketMakerConfig {
  const filePath = configPath ?? process.env.CONFIG_PATH ?? "config.toml";

  const raw = readFileSync(filePath, "utf-8");
  const toml = parseTOML(raw);

  // Global values (top-level numeric keys)
  const globalValues = extractValues(toml as Record<string, unknown>);

  // Per-symbol overrides ([SYMBOL] section)
  const symbolSection = toml[symbol];
  const symbolValues = symbolSection && typeof symbolSection === "object" && !Array.isArray(symbolSection)
    ? extractValues(symbolSection as Record<string, unknown>)
    : {};

  const merged = { ...globalValues, ...symbolValues };

  // Validate all required keys are present
  const missing = REQUIRED_KEYS.filter(
    (tomlKey) => merged[KEY_MAP[tomlKey]] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required config keys in ${filePath}: ${missing.join(", ")}`,
    );
  }

  const config = { symbol, ...merged } as MarketMakerConfig;

  const symbolKeys = Object.keys(symbolValues);
  if (symbolKeys.length > 0) {
    log.info(`Config loaded from ${filePath} (symbol overrides: ${symbolKeys.join(", ")})`);
  } else {
    log.info(`Config loaded from ${filePath}`);
  }

  return config;
}
