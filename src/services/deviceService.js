import { quitGame } from "../domain/gameState.js";
import { isValidLocale } from "../domain/locales.js";

/**
 * The devices' connections: a device connecting (for the first time, or back after a reload or a
 * dropped connection), going to the background, and leaving for good
 *
 * @param context.store - The server's state
 * @param context.rooms - Who's in which room
 * @param context.notifier - What the server sends the devices
 * @param context.logger - Where it logs
 * @param context.config - The server's settings
 */
export const createDeviceService = ({ store, rooms, notifier, logger, config }) => {
  const { channels, devices } = store;

  /**
   * Registers a device's new connection. A device back on a new connection (a reload, or a dropped
   * connection coming back) is still in its room, unless it says it isn't: it left it while
   * offline, and the leave got lost with the connection. Frontends from before the admin pause
   * don't say which room they're in (claimedChannelId undefined).
   *
   * @param connection.tokenHash - The hash of the device's token (devices that keep one)
   * @returns The device, and the room it's still in (null when none)
   */
  const connectDevice = ({ deviceId, socketId, tokenHash, locale, isActive, claimedChannelId }) => {
    const previous = devices.get(deviceId);
    const previousChannelId = previous?.channel;
    const previousChannel = previousChannelId ? channels.get(previousChannelId) : null;
    const wasInRoom = Boolean(previousChannel?.devices.has(deviceId));
    const isStillInRoom =
      wasInRoom && (claimedChannelId === undefined || claimedChannelId === previousChannelId);
    if (wasInRoom && !isStillInRoom) {
      if (previousChannel.adminId === deviceId) {
        rooms.forceCloseChannel(previousChannelId, "admin_left");
      } else {
        quitGame(previousChannel, deviceId);
        rooms.removeDeviceFromChannel(deviceId);
      }
    }

    const device = {
      id: deviceId,
      socketId,
      connectedAt: Date.now(),
      channel: isStillInRoom ? previousChannelId : null,
      isActive,
      role: isStillInRoom ? previous.role : "guest",
      displayName: isStillInRoom ? previous.displayName : null,
      isReady: isStillInRoom ? previous.isReady : false,
      locale,
      tokenHash,
    };
    devices.set(deviceId, device);
    return { device, channelId: device.channel };
  };

  // Whether the device has the game on screen; only its current connection can say
  const setActive = (deviceId, socketId, isActive) => {
    const device = devices.get(deviceId);
    if (!device || device.socketId !== socketId) return;
    device.isActive = isActive;

    if (device.channel) {
      // The admin's game in the background pauses it, and back on screen resumes it
      rooms.updateAdminPresence(device.channel);
      notifier.broadcastChannelUpdate(device.channel);
    }
  };

  const setLocale = (deviceId, locale) => {
    const device = devices.get(deviceId);
    if (!device || !isValidLocale(locale)) return;
    device.locale = locale;
    logger.debug("Device changed its language", { deviceId, locale });

    if (device.channel) {
      notifier.broadcastChannelUpdate(device.channel);
    }
  };

  // A device whose connection is gone, and didn't come back in time, leaves its room for good
  const forgetDevice = (deviceId, socketId) => {
    const device = devices.get(deviceId);
    if (!device || device.isActive || device.socketId !== socketId) return;

    logger.info("Removing inactive device", { deviceId });
    if (device.channel) {
      const channel = channels.get(device.channel);
      if (channel && channel.adminId === deviceId) {
        rooms.forceCloseChannel(device.channel, "admin_inactive_timeout");
      } else {
        rooms.removeDeviceFromChannel(deviceId);
      }
    }
    devices.delete(deviceId);
  };

  // A device's connection is gone; it's gone for good only if no newer connection of the device
  // took over (a reload, or a dropped connection that already came back)
  const disconnectDevice = (deviceId, socketId) => {
    const device = devices.get(deviceId);
    if (!device || device.socketId !== socketId) return;
    device.isActive = false;

    if (device.channel) {
      // The admin gone pauses the game, and closes the room if they're not back in time (a reload
      // drops the connection for a moment)
      rooms.updateAdminPresence(device.channel);
      notifier.broadcastChannelUpdate(device.channel);
    }

    setTimeout(() => {
      try {
        forgetDevice(deviceId, socketId);
      } catch (error) {
        logger.error("Removing an inactive device failed", { deviceId, error });
      }
    }, config.inactiveDeviceTimeoutMs);
  };

  return { connectDevice, setActive, setLocale, disconnectDevice };
};
