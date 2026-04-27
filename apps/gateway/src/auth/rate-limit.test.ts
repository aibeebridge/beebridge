import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthRateLimit } from "./rate-limit.js";

test("AuthRateLimit deletes expired entries during periodic cleanup", () => {
  let now = 0;
  const limiter = new AuthRateLimit(1, 10, 1, () => now);

  assert.equal(limiter.consume("a"), true);
  assert.equal(limiter.consume("a"), false);

  now = 11;
  assert.equal(limiter.consume("b"), true);

  const memory = (limiter as unknown as { memory: Map<string, unknown> }).memory;
  assert.equal(memory.has("a"), false);
  assert.equal(memory.has("b"), true);
});
