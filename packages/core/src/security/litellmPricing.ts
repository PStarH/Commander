/**
 * LiteLLMPricing — Real-time model pricing from the LiteLLM pricing JSON.
 *
 * Fetches and caches `model_prices_and_context_window.json` from the
 * BerriAI/litellm GitHub repo. Provides a synchronous lookup API so
 * CostGuard can get accurate per-model pricing without hardcoding.
 *
 * LiteLLM's JSON maps 4000+ model IDs to per-token costs. This module
 * converts per-token costs to per-1K-tokens (matching CostGuard's format)
 * using a blended average of input + output rates.
 *
 * The first access triggers a background fetch (does not block). Until
 * data arrives, lookups return undefined and callers fall back to
 * hardcoded defaults. Refreshes daily (24h).
 *
 * Usage:
 *   import { getLiteLLMPricing } from './litellmPricing';
 *   const pricing = getLiteLLMPricing();
 *   const rate = pricing.getCostPer1KTokens('gpt-4o'); // 0.0025 etc.
 */

// ============================================================================
// Types matching LiteLLM's JSON schema
// ============================================================================

interface LiteLLMModelPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  supports_function_calling?: boolean;
}

type LiteLLMPricingData = Record<string, LiteLLMModelPrice>;

// ============================================================================
// LiteLLMPricing
// ============================================================================

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class LiteLLMPricing {
  private data: LiteLLMPricingData | null = null;
  private lastFetched = 0;
  private fetchPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Ensure pricing data has been fetched (or is being fetched).
   * Safe to call multiple times — only the first call triggers a fetch.
   * Does NOT await — the fetch runs in the background so synchronous
   * callers (CostGuard.estimateCost) are never blocked.
   *
   * Network failures are expected in offline / sandboxed / test
   * environments, so the rejected promise is swallowed to prevent
   * `unhandledRejection` from firing the process-crash handler and
   * blocking the calling test (see #6421).
   */
  ensureLoaded(): void {
    if (this.data) return; // already have data
    if (this.fetchPromise) return; // already fetching
    this.fetchPromise = this.doFetch()
      .catch(() => {
        /* background fetch failure is non-fatal — hardcoded fallback applies */
      })
      .finally(() => {
        this.fetchPromise = null;
      });
  }

  /**
   * Get blended cost per 1M tokens for a model.
   *
   * Returns the average of input + output per-token cost × 1_000_000.
   * Returns `undefined` if:
   *   - Data hasn't loaded yet (caller should use hardcoded fallback)
   *   - Model ID is not found in LiteLLM's registry
   *   - The entry has no cost data (both input/output missing)
   */
  getCostPer1MTokens(modelId: string): number | undefined {
    if (!this.data) {
      this.ensureLoaded(); // fire background fetch
      return undefined;
    }

    const entry = this.data[modelId];
    if (!entry) return undefined;

    const inp = entry.input_cost_per_token;
    const out = entry.output_cost_per_token;
    if (inp == null && out == null) return undefined;

    // Blended rate: average of input and output per-token costs,
    // multiplied by 1_000_000 for per-1M-tokens format.
    const avgPerToken = ((inp ?? 0) + (out ?? 0)) / 2;
    return avgPerToken * 1_000_000;
  }

  /**
   * Get cache-read cost per 1M tokens for a model.
   *
   * Returns the cache_read_input_token_cost × 1_000_000.
   * Returns `undefined` if data hasn't loaded or model has no cached pricing.
   */
  getCacheReadCostPer1MTokens(modelId: string): number | undefined {
    if (!this.data) {
      this.ensureLoaded();
      return undefined;
    }

    const entry = this.data[modelId];
    if (!entry) return undefined;

    const cacheRead = entry.cache_read_input_token_cost;
    if (cacheRead == null) return undefined;

    return cacheRead * 1_000_000;
  }

  /**
   * Get the LiteLLM provider string for a model (e.g. "openai", "anthropic").
   */
  getProvider(modelId: string): string | undefined {
    return this.data?.[modelId]?.litellm_provider;
  }

  /**
   * Check if pricing data is available (loaded and not stale).
   */
  isLoaded(): boolean {
    return this.data !== null;
  }

  /**
   * Time since last successful fetch in ms. -1 if never fetched.
   */
  getAge(): number {
    return this.lastFetched > 0 ? Date.now() - this.lastFetched : -1;
  }

  /**
   * Count of models currently in the pricing cache.
   */
  getModelCount(): number {
    return this.data ? Object.keys(this.data).length : 0;
  }

  /**
   * Force a fresh fetch now. Returns a promise that resolves on success
   * or rejects on failure. Useful for explicit initialization at startup.
   */
  async refreshNow(): Promise<void> {
    await this.doFetch();
  }

  /**
   * Stop the periodic refresh timer.
   */
  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Reset all state (for test isolation).
   */
  reset(): void {
    this.stopRefresh();
    this.data = null;
    this.lastFetched = 0;
    this.fetchPromise = null;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async doFetch(): Promise<void> {
    // Skip the network call entirely in test environments — there is no
    // benefit to attempting a 30s+ DNS timeout for a pricing file the
    // tests never read. Hardcoded fallback is always sufficient.
    if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
      return;
    }
    try {
      // Hard cap the fetch at 10s so a slow/blocked DNS lookup cannot
      // stall callers that call ensureLoaded() in the background.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      if (typeof timer.unref === 'function') timer.unref();
      const resp = await fetch(LITELLM_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      const json = (await resp.json()) as LiteLLMPricingData;
      this.data = json;
      this.lastFetched = Date.now();
      this.startRefresh();
    } catch (err) {
      // If we already have cached data, keep it. Otherwise log the warning.
      // The caller (CostGuard) will fall back to hardcoded prices.
      if (!this.data) {
        console.warn(
          '[LiteLLMPricing] Initial fetch failed — using hardcoded pricing fallback.',
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err; // propagate so refreshNow() callers can handle
    }
  }

  private startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.doFetch().catch(() => {
        /* background refresh failures are non-fatal */
      });
    }, REFRESH_INTERVAL_MS);
    // Don't prevent Node.js from exiting
    if (typeof this.refreshTimer?.unref === 'function') {
      this.refreshTimer.unref();
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: LiteLLMPricing | null = null;

/** Get the global LiteLLMPricing singleton. */
export function getLiteLLMPricing(): LiteLLMPricing {
  if (!instance) {
    instance = new LiteLLMPricing();
    instance.ensureLoaded(); // eager: start background fetch immediately
  }
  return instance;
}

/** Reset the singleton (for test isolation). */
export function resetLiteLLMPricing(): void {
  if (instance) {
    instance.reset();
    instance = null;
  }
}
