/**
 * Logs an entry at most once per interval for each key, with how many it left out since: an
 * attacker's flood shouldn't flood the log too
 *
 * @param log - The logger's function (logger.warn, say)
 * @param intervalMs - The shortest time between two entries of a key
 * @returns A function taking the entry's key, its message and its details
 */
export const createThrottledLog = (log, intervalMs = 10000) => {
  const lastEntries = new Map(); // key -> { at, skipped }
  return (key, message, fields) => {
    const now = Date.now();
    const last = lastEntries.get(key);
    if (last && now - last.at < intervalMs) {
      last.skipped++;
      return;
    }
    log(message, last?.skipped ? { ...fields, skipped: last.skipped } : fields);
    lastEntries.set(key, { at: now, skipped: 0 });
  };
};
