/**
 * Sliding-window rate limiter for the Mission Control API.
 *
 * In-memory, zero-dependency, keyed by client (remote address + bearer token
 * fingerprint). Intended to shed abusive load cheaply before authentication
 * and routing work happens. A process restart resets all windows.
 */

export interface RateLimitOptions {
  /** Maximum requests allowed per window. 0 disables the limiter. */
  readonly maxRequests: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Safety cap on tracked clients to bound memory under address churn. */
  readonly maxTrackedClients?: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds after which the client may retry (only meaningful when denied). */
  readonly retryAfterSec: number;
  readonly remaining: number;
}

const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly options: RateLimitOptions & { maxTrackedClients: number };

  public constructor(options: RateLimitOptions) {
    this.options = { maxTrackedClients: DEFAULT_MAX_TRACKED_CLIENTS, ...options };
  }

  /** Record one request for `key` and decide whether it is allowed. */
  public check(key: string, now: number = Date.now()): RateLimitVerdict {
    const { maxRequests, windowMs } = this.options;
    if (maxRequests <= 0 || windowMs <= 0) {
      return { allowed: true, retryAfterSec: 0, remaining: Number.POSITIVE_INFINITY };
    }

    // Prune stale clients first so the memory cap cannot be exhausted by
    // expired windows.
    if (this.hits.size >= this.options.maxTrackedClients) {
      for (const [k, stamps] of this.hits) {
        const last = stamps.at(-1) ?? 0;
        if (now - last > windowMs) this.hits.delete(k);
      }
      while (this.hits.size >= this.options.maxTrackedClients) {
        // Still full: evict an arbitrary client (Map insertion order ≈ oldest).
        const oldest = this.hits.keys().next();
        if (oldest.done) break;
        this.hits.delete(oldest.value);
      }
    }

    const stamps = this.hits.get(key) ?? [];
    while (stamps.length > 0 && now - stamps[0]! >= windowMs) {
      stamps.shift();
    }

    if (stamps.length >= maxRequests) {
      const retryAfterMs = Math.max(1, stamps[0]! + windowMs - now);
      // The denied request is not recorded: retrying as soon as the window
      // slides must genuinely succeed.
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000), remaining: 0 };
    }

    stamps.push(now);
    this.hits.set(key, stamps);
    return { allowed: true, retryAfterSec: 0, remaining: maxRequests - stamps.length };
  }

  /** Forget all tracked clients (used on server close in tests). */
  public reset(): void {
    this.hits.clear();
  }
}
