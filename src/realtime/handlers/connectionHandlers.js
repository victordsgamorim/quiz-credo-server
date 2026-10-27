import { DEFAULT_LOCALE } from "../../domain/constants.js";
import { isValidLocale } from "../../domain/locales.js";
import {
  isPlainObject,
  isValidChannelId,
  parseAccessToken,
  parseDeviceStatus,
  parseLocaleChange,
} from "../validation.js";

// The room a reconnecting device says it's in: undefined when it doesn't say (frontends from
// before the admin pause), null when it's in none
const parseClaimedChannelId = (channelId) => {
  if (channelId === undefined) return undefined;
  return isValidChannelId(channelId) ? channelId : null;
};

/**
 * A device's connection: it registers the device (back in its room after a reload or a dropped
 * connection), then follows whether the game is on its screen, its language and its leaving
 *
 * @param options.socket - The device's connection, with its identity (socket.data.identity)
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerConnectionHandlers = ({ socket, on, context }) => {
  const { devices, rooms, notifier, adminSessions, logger } = context;
  const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
  const { deviceId, deviceToken, tokenHash } = socket.data.identity;

  // An admin signed in to Supabase sends their session with the connection
  if (typeof auth.accessToken === "string") {
    adminSessions.setToken(socket, auth.accessToken);
  }

  // A frontend that keeps a device token gets its identity first, before anything about its room
  if (deviceToken) {
    socket.emit("device-session", { deviceId, deviceToken });
  }

  const { channelId } = devices.connectDevice({
    deviceId,
    socketId: socket.id,
    tokenHash,
    locale: isValidLocale(auth.locale) ? auth.locale : DEFAULT_LOCALE,
    // Whether the device has the game on screen; frontends from before the admin pause don't say
    isActive: auth.isActive !== false,
    claimedChannelId: parseClaimedChannelId(auth.channelId),
  });
  logger.info("Device connected", { deviceId, socketId: socket.id, channelId });

  if (channelId) {
    socket.join(channelId);
    // The admin back resumes the game
    rooms.updateAdminPresence(channelId);
    notifier.broadcastChannelUpdate(channelId);
  }

  on("device-status", (status) =>
    devices.setActive(deviceId, socket.id, parseDeviceStatus(status).isActive)
  );

  on("update-locale", (payload) => {
    const request = parseLocaleChange(payload);
    if (request) devices.setLocale(deviceId, request.locale);
  });

  // The admin signing in or out, or their session renewed (Supabase renews it every hour)
  on("update-access-token", (payload) => {
    const request = parseAccessToken(payload);
    if (request) adminSessions.setToken(socket, request.accessToken);
  });

  on("ping", () => socket.emit("pong", { timestamp: Date.now() }));

  socket.on("disconnect", (reason) => {
    logger.info("Device disconnected", { deviceId, socketId: socket.id, reason });
    try {
      devices.disconnectDevice(deviceId, socket.id);
    } catch (error) {
      logger.error("Disconnecting a device failed", { deviceId, error });
    }
  });
};
