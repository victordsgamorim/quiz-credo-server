/**
 * A rate limit: it holds up to `capacity` tokens, and gets `refillPerSecond` back every second.
 * Each action takes a token; with none left, the action comes too soon.
 */
export class TokenBucket {
  constructor({ capacity, refillPerSecond, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  refill() {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
    this.updatedAt = now;
  }

  // Takes a token, when there's one
  take() {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // Milliseconds until there's a token
  msUntilNext() {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  // Whether nothing took a token lately
  isFull() {
    this.refill();
    return this.tokens >= this.capacity;
  }
}

/**
 * A rate limit for each key (an address, say), forgetting the keys that went quiet
 *
 * @param options.capacity - The bucket's capacity, for each key
 * @param options.refillPerSecond - The tokens each key gets back every second
 * @returns take(key), which takes a token of the key's bucket; isExhausted(key), whether the
 *   key's bucket has none left; and stop()
 */
export const createKeyedLimiter = ({ capacity, refillPerSecond, cleanupIntervalMs = 60000 }) => {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    buckets.forEach((bucket, key) => {
      if (bucket.isFull()) buckets.delete(key);
    });
  }, cleanupIntervalMs);
  cleanup.unref();

  return {
    take: (key) => {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new TokenBucket({ capacity, refillPerSecond });
        buckets.set(key, bucket);
      }
      return bucket.take();
    },
    isExhausted: (key) => (buckets.get(key)?.msUntilNext() ?? 0) > 0,
    stop: () => clearInterval(cleanup),
  };
};
