interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class AuthRateLimit {
  private readonly memory = new Map<string, RateLimitEntry>();
  private consumeCount = 0;

  constructor(
    private readonly maxAttempts = 300,
    private readonly windowMs = 60_000,
    private readonly cleanupEvery = 1_000,
    private readonly now = Date.now,
  ) {}

  public consume(identity: string): boolean {
    const now = this.now();
    this.consumeCount += 1;
    if (this.consumeCount >= this.cleanupEvery) {
      this.consumeCount = 0;
      this.deleteExpired(now);
    }

    const current = this.memory.get(identity);

    if (!current || now - current.windowStart > this.windowMs) {
      this.memory.set(identity, { count: 1, windowStart: now });
      return true;
    }

    if (current.count >= this.maxAttempts) {
      return false;
    }

    current.count += 1;
    return true;
  }

  private deleteExpired(now: number): void {
    for (const [identity, entry] of this.memory) {
      if (now - entry.windowStart > this.windowMs) {
        this.memory.delete(identity);
      }
    }
  }
}
