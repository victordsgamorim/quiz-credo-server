import { createThrottledLog } from "./throttledLog.js";
import { createKeyedLimiter } from "./tokenBucket.js";

/**
 * Who can open a connection (Socket.IO's allowRequest, on every handshake): pages of the
 * frontend's origins only, within the limits of open connections in all and per address, and of
 * new connections per address per minute.
 *
 * Browsers send the page's origin with every handshake, the WebSocket's included (which CORS
 * doesn't cover), so a page from another website can't connect. Clients that aren't browsers
 * don't send one, and could send any: the limits are what holds them.
 *
 * @param options.config - The server's settings
 * @param options.logger - Where it logs
 * @param options.getClientIp - The address of a request's caller
 * @returns allowRequest, and track(engine), which counts the engine's open connections
 */
export const createConnectionGuard = ({ config, logger, getClientIp }) => {
  const openByIp = new Map(); // ip -> open connections
  let openTotal = 0;
  const newConnections = createKeyedLimiter({
    capacity: config.connectionsPerIpPerMinute,
    refillPerSecond: config.connectionsPerIpPerMinute / 60,
  });
  const logRefusal = createThrottledLog(logger.warn);

  const refuse = (callback, reason, details) => {
    logRefusal(reason, "Connection refused", { reason, ...details });
    callback(reason, false);
  };

  const allowRequest = (req, callback) => {
    const { origin } = req.headers;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      refuse(callback, "origin_not_allowed", { origin });
      return;
    }

    const ip = getClientIp(req);
    if (openTotal >= config.maxConnections) {
      refuse(callback, "server_busy", { ip });
    } else if ((openByIp.get(ip) || 0) >= config.maxConnectionsPerIp) {
      refuse(callback, "too_many_connections", { ip });
    } else if (!newConnections.take(ip)) {
      refuse(callback, "too_many_new_connections", { ip });
    } else {
      callback(null, true);
    }
  };

  const track = (engine) => {
    engine.on("connection", (rawSocket) => {
      const ip = getClientIp(rawSocket.request);
      openTotal++;
      openByIp.set(ip, (openByIp.get(ip) || 0) + 1);
      rawSocket.once("close", () => {
        openTotal--;
        const open = (openByIp.get(ip) || 1) - 1;
        if (open > 0) {
          openByIp.set(ip, open);
        } else {
          openByIp.delete(ip);
        }
      });
    });
  };

  return { allowRequest, track };
};
