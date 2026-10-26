import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createEventLimiter } from "../../src/realtime/security/eventLimiter.js";
import { TokenBucket } from "../../src/realtime/security/tokenBucket.js";

const LIMITS = {
  vote: { burst: 2, perSecond: 20, keepLatest: true },
  answer: { burst: 2, perSecond: 20 },
};

describe("TokenBucket", () => {
  it("allows a burst, then its rate", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now });
    assert.deepEqual([bucket.take(), bucket.take(), bucket.take()], [true, true, false]);
    assert.equal(bucket.msUntilNext(), 1000);
    now = 1000;
    assert.equal(bucket.take(), true);
  });
});

describe("createEventLimiter", () => {
  it("drops an event over its limit", () => {
    const limiter = createEventLimiter({ limits: LIMITS, onAbuse: () => {} });
    const runs = [];
    for (let index = 0; index < 5; index++)
      limiter.run("answer", [index], (value) => runs.push(value));
    assert.deepEqual(runs, [0, 1]);
    limiter.close();
  });

  it("runs the last of a state's events over its limit, once the limit allows", async () => {
    const limiter = createEventLimiter({ limits: LIMITS, onAbuse: () => {} });
    const runs = [];
    for (let index = 0; index < 10; index++)
      limiter.run("vote", [index], (value) => runs.push(value));
    assert.deepEqual(runs, [0, 1]);
    await delay(150);
    assert.deepEqual(runs, [0, 1, 9]);
    limiter.close();
  });

  it("knows only its events", () => {
    const limiter = createEventLimiter({ limits: LIMITS, onAbuse: () => {} });
    assert.deepEqual(["vote", "answer", "toString", "__proto__", 42].map(limiter.isKnown), [
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("gives up on a connection that keeps going over the limits", () => {
    let abuses = 0;
    const limiter = createEventLimiter({ limits: LIMITS, onAbuse: () => abuses++ });
    for (let index = 0; index < 1000; index++) limiter.run("answer", [], () => {});
    assert.equal(abuses, 1);
    // Closed: nothing runs anymore
    let ran = false;
    limiter.run("answer", [], () => (ran = true));
    assert.equal(ran, false);
  });

  it("drops the waiting events of a connection that closed", async () => {
    const limiter = createEventLimiter({ limits: LIMITS, onAbuse: () => {} });
    const runs = [];
    for (let index = 0; index < 5; index++)
      limiter.run("vote", [index], (value) => runs.push(value));
    limiter.close();
    await delay(150);
    assert.deepEqual(runs, [0, 1]);
  });
});
