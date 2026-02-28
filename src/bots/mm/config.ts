// MarketMaker configuration

import { readFileSync, existsSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { log } from "../../utils/logger.js";

export interface MarketMakerConfig {
  readonly symbol: string // e.g., "BTC" or "ETH"
  readonly spreadBps: number // Spread from fair price (bps)
  readonly takeProfitBps: number // Spread in close mode (bps)
  readonly orderSizeUsd: number // Order size in USD
  readonly closeThresholdUsd: number // Trigger close mode when position >= this
  readonly warmupSeconds: number // Seconds to warm up before quoting
  readonly updateThrottleMs: number // Min interval between quote updates
  readonly orderSyncIntervalMs: number // Interval for syncing orders from API
  readonly statusIntervalMs: number // Interval for status display
  readonly fairPriceWindowMs: number // Window for fair price calculation
  readonly positionSyncIntervalMs: number // Interval for position sync
}

// Default configuration values (symbol must be provided)
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 4,
  takeProfitBps: 5,
  orderSizeUsd: 10,
  closeThresholdUsd: 10,
  warmupSeconds: 10,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000, // 5 minutes
  positionSyncIntervalMs: 5000,
}

// snake_case TOML key → camelCase config field
const KEY_MAP: Record<string, keyof Omit<MarketMakerConfig, 'symbol'>> = {
  spread_bps: 'spreadBps',
  take_profit_bps: 'takeProfitBps',
  order_size_usd: 'orderSizeUsd',
  close_threshold_usd: 'closeThresholdUsd',
  warmup_seconds: 'warmupSeconds',
  update_throttle_ms: 'updateThrottleMs',
  order_sync_interval_ms: 'orderSyncIntervalMs',
  status_interval_ms: 'statusIntervalMs',
  fair_price_window_ms: 'fairPriceWindowMs',
  position_sync_interval_ms: 'positionSyncIntervalMs',
}

// Extract numeric config values from a TOML section, mapping snake_case → camelCase
function extractOverrides(
  section: Record<string, unknown>,
): Partial<Omit<MarketMakerConfig, 'symbol'>> {
  const overrides: Record<string, number> = {};
  for (const [tomlKey, configKey] of Object.entries(KEY_MAP)) {
    const val = section[tomlKey];
    if (val !== undefined) {
      if (typeof val !== "number") {
        throw new Error(`Config key "${tomlKey}" must be a number, got ${typeof val}`);
      }
      overrides[configKey] = val;
    }
  }
  return overrides;
}

// Load config from TOML file with per-symbol overrides
// Merge order: code defaults → TOML globals → TOML [SYMBOL] section
export function loadConfig(symbol: string, configPath?: string): MarketMakerConfig {
  const filePath = configPath ?? process.env.CONFIG_PATH ?? "config.toml";

  if (!existsSync(filePath)) {
    log.info(`No config file at ${filePath}, using defaults`);
    return { symbol, ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(filePath, "utf-8");
  const toml = parseTOML(raw);

  // Global overrides (top-level numeric keys)
  const globalOverrides = extractOverrides(toml as Record<string, unknown>);

  // Per-symbol overrides ([SYMBOL] section)
  const symbolSection = toml[symbol];
  const symbolOverrides = symbolSection && typeof symbolSection === "object" && !Array.isArray(symbolSection)
    ? extractOverrides(symbolSection as Record<string, unknown>)
    : {};

  const config: MarketMakerConfig = {
    symbol,
    ...DEFAULT_CONFIG,
    ...globalOverrides,
    ...symbolOverrides,
  };

  const overrideKeys = [...Object.keys(globalOverrides), ...Object.keys(symbolOverrides)];
  if (overrideKeys.length > 0) {
    log.info(`Config loaded from ${filePath} (overrides: ${overrideKeys.join(", ")})`);
  } else {
    log.info(`Config loaded from ${filePath} (no overrides, using defaults)`);
  }

  return config;
}
