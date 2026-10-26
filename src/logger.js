const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Longest string a log entry keeps of a detail: a device can send long values, and they'd flood
// the log
const MAX_DETAIL_LENGTH = 200;
const MAX_DETAIL_ITEMS = 20;
const MAX_DETAIL_DEPTH = 4;

// Entries of each message the log writes per window, at most: a client repeating what gets logged
// (an event it isn't allowed to send, say) can't flood it
const ENTRIES_PER_MESSAGE = 50;
const WINDOW_MS = 10000;

const toLoggable = (value, depth = 0) => {
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: toLoggable(value.message), stack: value.stack };
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DETAIL_DEPTH) return "[…]";
    if (Array.isArray(value)) {
      return value.slice(0, MAX_DETAIL_ITEMS).map((item) => toLoggable(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_DETAIL_ITEMS)
        .map(([key, detail]) => [key, toLoggable(detail, depth + 1)])
    );
  }
  return typeof value === "bigint" || typeof value === "function" ? String(value) : value;
};

// The details as JSON: it escapes line breaks and control characters, so what a device sends
// can't forge log lines
const formatFields = (fields) => {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return ` ${JSON.stringify(toLoggable(fields))}`;
  } catch {
    return " [details that can't be logged]";
  }
};

// How many entries of each message the log can still write in the current window; a message's
// first entry in a window tells how many of its entries the last window left out
const createMessageLimit = () => {
  const windows = new Map(); // message -> { startedAt, written, skipped }
  return (message) => {
    const now = Date.now();
    let window = windows.get(message);
    let skippedBefore = 0;
    if (!window || now - window.startedAt >= WINDOW_MS) {
      skippedBefore = window?.skipped || 0;
      window = { startedAt: now, written: 0, skipped: 0 };
      windows.set(message, window);
    }
    if (window.written >= ENTRIES_PER_MESSAGE) {
      window.skipped++;
      return { isAllowed: false };
    }
    window.written++;
    return { isAllowed: true, skippedBefore };
  };
};

/**
 * The server's log: one line per entry, with its time and level, a fixed message and the entry's
 * details as JSON. Messages are fixed text; whatever a device sends goes in the details.
 *
 * @param options.level - The lowest level it writes: debug, info, warn, error or silent
 * @param options.sink - Where the lines go (the console)
 * @returns debug, info, warn and error, each taking a message and its details
 */
export const createLogger = ({ level = "info", sink = console } = {}) => {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const limit = createMessageLimit();
  const log = (levelName, method) => (message, fields) => {
    if (LEVELS[levelName] < threshold) return;
    const { isAllowed, skippedBefore } = limit(message);
    if (!isAllowed) return;
    const details = skippedBefore ? { ...fields, skippedBefore } : fields;
    sink[method](
      `[${new Date().toISOString()}] ${levelName.toUpperCase()} ${message}${formatFields(details)}`
    );
  };

  return {
    debug: log("debug", "log"),
    info: log("info", "log"),
    warn: log("warn", "warn"),
    error: log("error", "error"),
  };
};
