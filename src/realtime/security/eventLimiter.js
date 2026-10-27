import { TokenBucket } from "./tokenBucket.js";

/**
 * How often a connection can send each event: `burst` at once, then `perSecond`. The frontend
 * stays far below them. Past its limit an event is dropped, except the ones that only set a state
 * (keepLatest: a vote, a setting, a slider dragged across its range): the last one waits until the
 * limit lets it through, so the state ends up the one the device chose.
 */
export const EVENT_LIMITS = Object.freeze({
  ping: { burst: 5, perSecond: 1 },
  "device-status": { burst: 10, perSecond: 5, keepLatest: true },
  "update-locale": { burst: 5, perSecond: 1, keepLatest: true },
  "update-access-token": { burst: 5, perSecond: 0.2, keepLatest: true },
  "create-channel": { burst: 5, perSecond: 0.2 },
  "join-channel": { burst: 10, perSecond: 1 },
  "leave-channel": { burst: 10, perSecond: 2 },
  "remove-device": { burst: 20, perSecond: 5 },
  "update-category-vote": { burst: 20, perSecond: 10, keepLatest: true },
  "update-ready-state": { burst: 10, perSecond: 5, keepLatest: true },
  "close-category-vote": { burst: 5, perSecond: 1 },
  "update-game-settings": { burst: 40, perSecond: 20, keepLatest: true },
  "start-game": { burst: 5, perSecond: 1 },
  "load-questions": { burst: 5, perSecond: 0.5 },
  "guest-selected-answer": { burst: 10, perSecond: 5 },
  "submit-answer": { burst: 10, perSecond: 5 },
  "use-power-up": { burst: 10, perSecond: 5 },
  "next-question": { burst: 10, perSecond: 2 },
  "reset-game": { burst: 5, perSecond: 1 },
});

// Events over their limit a connection can send before it's dropped: a client sending them that
// fast isn't the frontend
const STRIKES = { burst: 500, perSecond: 50 };

/**
 * One connection's event limits
 *
 * @param options.onAbuse - Called once the connection sent too many events over their limits
 * @param options.limits - Each event's limit
 * @returns run(event, args, handler), isKnown(event), and close() for when the connection ends
 */
export const createEventLimiter = ({ onAbuse, limits = EVENT_LIMITS }) => {
  const buckets = new Map();
  const waiting = new Map(); // event -> { args } of a keepLatest event over its limit
  const timers = new Set();
  const strikes = new TokenBucket({ capacity: STRIKES.burst, refillPerSecond: STRIKES.perSecond });
  let isClosed = false;

  const getBucket = (event) => {
    if (!buckets.has(event)) {
      const { burst, perSecond } = limits[event];
      buckets.set(event, new TokenBucket({ capacity: burst, refillPerSecond: perSecond }));
    }
    return buckets.get(event);
  };

  const strike = () => {
    if (strikes.take() || isClosed) return;
    close();
    onAbuse();
  };

  const isKnown = (event) => typeof event === "string" && Object.hasOwn(limits, event);

  // Runs the event's handler now, later (the last of a keepLatest event over its limit) or never
  const run = (event, args, handler) => {
    if (isClosed) return;
    const pending = waiting.get(event);
    if (pending) {
      pending.args = args;
      strike();
      return;
    }

    const bucket = getBucket(event);
    if (bucket.take()) {
      handler(...args);
      return;
    }
    strike();
    if (!limits[event].keepLatest) return;

    const entry = { args };
    waiting.set(event, entry);
    const timer = setTimeout(() => {
      timers.delete(timer);
      waiting.delete(event);
      if (isClosed) return;
      bucket.take();
      handler(...entry.args);
    }, bucket.msUntilNext());
    timers.add(timer);
  };

  const close = () => {
    isClosed = true;
    timers.forEach(clearTimeout);
    timers.clear();
    waiting.clear();
  };

  // An event the server doesn't have: dropped, and counted against the connection
  const dropUnknown = () => strike();

  return { run, isKnown, dropUnknown, close };
};
