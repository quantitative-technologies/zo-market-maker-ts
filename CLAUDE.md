# Project Guidelines

## API Data Handling

- Use strict property access for API response fields, not optional chaining with fallbacks.
- Never add fallback chains or guesswork for field names.
- If a field is documented in the API, access it directly. If it's missing at runtime, let it throw so the issue is visible.
- Only use optional chaining for fields that are explicitly documented as optional/nullable, and add a comment noting that.

## Configuration

- Never hardcode constants (intervals, thresholds, sizes, slippage, etc.) without explicit approval. All tuneable values must be loaded from `config.toml`.
- Never use magic numbers in constructor calls, function arguments, or default parameter values. All tuneable values must either come from config or be defined as named constants.
- No hardcoded default values for config keys. All config values must be explicitly specified in `config.toml`. Missing keys must cause a startup error, not silently fall back to a default.
- Strategy parameters (spread, size, thresholds) come first in config.toml, followed by operational parameters (intervals, timeouts). New config keys must follow this ordering.

## Error Handling

- No swallowed exceptions allowed. All caught exceptions must be logged or re-raised.
- Never assume an API call succeeded based solely on the call not throwing. Verify the expected outcome (e.g., after submitting a close order, verify the position is actually closed).

## Debugging & Diagnosis

- Never guess at root causes. Every assumption must be confirmed with evidence (logs, data, code trace).
- Do not say "likely" or "probably" when diagnosing issues. Either verify the hypothesis or state clearly that it is unverified.

## Code Style

- Avoid defensive programming. Do not add fallbacks, guards, or alternative paths for scenarios that cannot happen in practice. If uncertain whether a code path is reachable, ask the user before adding a guard.

## Git

- Push to `origin` (quantitative-technologies/zo-market-maker-ts). Never push to `upstream`.
