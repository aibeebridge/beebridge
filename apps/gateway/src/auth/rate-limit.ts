interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class AuthRateLimit {
  private readonly memory = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxAttempts = 300,
    private readonly windowMs = 60_000,
  ) {}

  public consume(identity: string): boolean {
    const now = Date.now();
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
}
