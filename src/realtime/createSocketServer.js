import { Server } from "socket.io";

import { createDeviceService } from "../services/deviceService.js";
import { createGameService } from "../services/gameService.js";
import { createLobbyService } from "../services/lobbyService.js";
import { createNotifier } from "../services/notifier.js";
import { createQuestionTimer } from "../services/questionTimer.js";
import { createRoomService } from "../services/roomService.js";
import { createStore } from "../state/store.js";
import { registerConnectionHandlers } from "./handlers/connectionHandlers.js";
import { registerGameHandlers } from "./handlers/gameHandlers.js";
import { registerLobbyHandlers } from "./handlers/lobbyHandlers.js";
import { registerRoomHandlers } from "./handlers/roomHandlers.js";
import { createAdminSessions } from "./security/adminSessions.js";
import { createClientIpResolver } from "./security/clientIp.js";
import { createConnectionGuard } from "./security/connectionGuard.js";
import { createDeviceIdentity } from "./security/deviceIdentity.js";
import { createEventBinder } from "./security/eventBinder.js";
import { createEventLimiter } from "./security/eventLimiter.js";
import { createSupabaseAuth } from "./security/supabaseAuth.js";
import { createThrottledLog } from "./security/throttledLog.js";
import { createKeyedLimiter } from "./security/tokenBucket.js";
import { isPlainObject } from "./validation.js";

// Time a client has, after its connection opens, to join (with its handshake's auth)
const CONNECT_TIMEOUT_MS = 10000;
// Rooms not found an address can ask for at once, then one a second: a whole classroom on the
// same Wi-Fi rejoining after a restart fits, someone guessing room codes doesn't
const FAILED_JOINS_PER_IP = { capacity: 100, refillPerSecond: 1 };
// Devices the server keeps per connection it allows: a device stays for a while after its
// connection is gone (to come back to its room), and new ones wait when the server is that full
const DEVICES_PER_CONNECTION = 4;

/**
 * The Socket.IO server the frontend's devices connect to, with the services behind its events
 *
 * @param httpServer - The HTTP server it shares
 * @param options.config - The server's settings
 * @param options.logger - Where it logs
 * @returns The Socket.IO server and the server's state
 */
export const createSocketServer = (httpServer, { config, logger }) => {
  const getClientIp = createClientIpResolver(config.clientIpHeader);
  const guard = createConnectionGuard({ config, logger, getClientIp });
  const logAbuse = createThrottledLog(logger.warn);

  const io = new Server(httpServer, {
    // Polling's CORS; the WebSocket's origin, which CORS doesn't cover, is the guard's
    cors: { origin: [...config.allowedOrigins], methods: ["GET", "POST"], credentials: false },
    allowRequest: guard.allowRequest,
    maxHttpBufferSize: config.maxMessageBytes,
    connectTimeout: CONNECT_TIMEOUT_MS,
    pingInterval: 10000,
    pingTimeout: 5000,
    // The frontend bundles its client: nothing to serve
    serveClient: false,
    transports: ["websocket", "polling"],
  });
  guard.track(io.engine);
  io.engine.on("headers", (headers) => {
    headers["X-Content-Type-Options"] = "nosniff";
  });

  const store = createStore();
  const notifier = createNotifier({ io, store, logger, config });
  const timer = createQuestionTimer({ store, notifier, logger });
  const rooms = createRoomService({ store, notifier, timer, logger, config });
  const identity = createDeviceIdentity({ store, config });
  const context = {
    notifier,
    rooms,
    devices: createDeviceService({ store, rooms, notifier, logger, config }),
    lobby: createLobbyService({ store, rooms, notifier, logger }),
    game: createGameService({ store, rooms, notifier, timer, logger }),
    adminSessions: createAdminSessions({
      supabaseAuth: config.requireAdminAuth
        ? createSupabaseAuth({ ...config.supabase, logger })
        : null,
      adminRole: config.adminRole,
      store,
      logger,
    }),
    failedJoins: createKeyedLimiter(FAILED_JOINS_PER_IP),
    logger,
  };

  // Who the connection is: its device's identity, from the handshake's auth
  const maxDevices = config.maxConnections * DEVICES_PER_CONNECTION;
  io.use((socket, next) => {
    const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
    let resolved = identity.resolve(auth, socket.id);
    socket.data.ip = getClientIp(socket.request);
    if (
      !resolved.error &&
      !store.devices.has(resolved.deviceId) &&
      store.devices.size >= maxDevices
    ) {
      resolved = { error: "server_busy" };
    }
    if (resolved.error) {
      logAbuse(resolved.error, "Connection refused", {
        reason: resolved.error,
        ip: socket.data.ip,
      });
      next(new Error(resolved.error));
      return;
    }
    socket.data.identity = resolved;
    socket.data.deviceId = resolved.deviceId;
    next();
  });

  io.on("connection", (socket) => {
    const limiter = createEventLimiter({
      onAbuse: () => {
        logAbuse("too_many_events", "Connection dropped: too many events", {
          deviceId: socket.data.deviceId,
          ip: socket.data.ip,
        });
        socket.disconnect(true);
      },
    });
    // Events the server doesn't have are dropped before any handler
    socket.use(([event], next) => (limiter.isKnown(event) ? next() : limiter.dropUnknown()));
    socket.on("disconnect", () => limiter.close());

    const handlers = { socket, on: createEventBinder({ socket, limiter, logger }), context };
    try {
      registerConnectionHandlers(handlers);
      registerRoomHandlers(handlers);
      registerLobbyHandlers(handlers);
      registerGameHandlers(handlers);
    } catch (error) {
      logger.error("Setting up a connection failed", { deviceId: socket.data.deviceId, error });
      socket.disconnect(true);
    }
  });

  return { io, store };
};
