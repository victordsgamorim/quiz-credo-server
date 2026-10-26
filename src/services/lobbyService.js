import { sanitizeCategoryVote } from "../domain/categories.js";
import { getChannelDevices } from "../domain/channelState.js";
import {
  getGameSettingsError,
  getUnknownSettings,
  isValidGameSettings,
  pickGameSettings,
} from "../domain/gameSettings.js";

/**
 * The room's lobby, before its game: the guests' votes and readiness, the admin's settings, and
 * the game's start
 *
 * @param context.store - The server's state
 * @param context.rooms - Who's in which room
 * @param context.notifier - What the server sends the devices
 * @param context.logger - Where it logs
 */
export const createLobbyService = ({ store, rooms, notifier, logger }) => {
  const { channels, devices } = store;

  // The room the device is in, when it's the one it names
  const getOwnChannel = (deviceId, channelId) => {
    const device = devices.get(deviceId);
    if (!channelId || !device || device.channel !== channelId) return null;
    return channels.get(channelId) || null;
  };

  // The room the device is the admin of, when it's the one it names
  const getAdminChannel = (deviceId, channelId) => {
    const channel = getOwnChannel(deviceId, channelId);
    return channel?.adminId === deviceId ? channel : null;
  };

  // The settings the room keeps, and sends every device: only the fields the frontend has
  const keepSettings = (channelId, settings) => {
    const unknown = getUnknownSettings(settings);
    if (unknown.length > 0) {
      logger.debug("Game settings the server doesn't know left out", { channelId, unknown });
    }
    return pickGameSettings(settings);
  };

  const voteCategories = (deviceId, { channelId, categories }) => {
    if (!Array.isArray(categories)) return;
    const channel = getOwnChannel(deviceId, channelId);
    if (!channel) {
      logger.warn("Category vote outside the device's room", { deviceId, channelId });
      return;
    }
    if (channel.isVotingClosed) {
      logger.debug("Category vote after the voting closed", { deviceId, channelId });
      return;
    }

    channel.votes = channel.votes || new Map();
    channel.votes.set(deviceId, new Set(sanitizeCategoryVote(categories)));
    notifier.broadcastChannelUpdate(channelId);
  };

  const setReady = (deviceId, { channelId, isReady }) => {
    const channel = getOwnChannel(deviceId, channelId);
    if (!channel) {
      logger.warn("Ready state outside the device's room", { deviceId, channelId });
      return;
    }
    if (channel.isGameStarted) {
      logger.debug("Ready state after the game started", { deviceId, channelId });
      return;
    }

    devices.get(deviceId).isReady = Boolean(isReady);
    notifier.broadcastChannelUpdate(channelId);
  };

  const closeVoting = (deviceId, { channelId }) => {
    const channel = getAdminChannel(deviceId, channelId);
    if (!channel) {
      logger.warn("Closing the voting without being the room's admin", { deviceId, channelId });
      return;
    }
    if (channel.isVotingClosed) return;

    channel.isVotingClosed = true;
    logger.info("Voting closed", { channelId });
    notifier.broadcastChannelUpdate(channelId);
  };

  // The admin's settings, in real time, before the game starts
  const updateSettings = (deviceId, { channelId, settings }) => {
    const channel = getAdminChannel(deviceId, channelId);
    if (!channel) {
      logger.warn("Game settings from a device that isn't the room's admin", {
        deviceId,
        channelId,
      });
      return;
    }
    if (channel.isGameStarted) {
      logger.warn("Game settings after the game started", { channelId });
      return;
    }
    const error = getGameSettingsError(settings);
    if (error) {
      logger.warn("Invalid game settings", { channelId, setting: error });
      return;
    }

    channel.gameSettings = keepSettings(channelId, settings);
    logger.debug("Game settings updated", { channelId });
    notifier.broadcastChannelUpdate(channelId);
  };

  // The admin starts the game once every guest is ready; debug mode lets them start and play alone
  const startGame = (deviceId, { channelId, settings }) => {
    const channel = getOwnChannel(deviceId, channelId);
    if (!channel) return;
    if (channel.adminId !== deviceId) {
      logger.warn("Starting the game without being the room's admin", { deviceId, channelId });
      return;
    }

    const channelDevices = getChannelDevices(channel, devices);
    const guests = channelDevices.filter((device) => device.role === "guest");
    const isDebugMode = Boolean(settings?.enableDebugMode) && isValidGameSettings(settings);
    if (!isDebugMode && guests.length === 0) {
      logger.warn("Starting the game without guests", { channelId });
      return;
    }
    if (!isDebugMode && !guests.every((device) => device.isReady)) {
      logger.warn("Starting the game before every guest is ready", { channelId });
      return;
    }

    if (settings && isValidGameSettings(settings)) {
      channel.gameSettings = keepSettings(channelId, settings);
    } else if (settings) {
      logger.warn("Invalid game settings: playing with the defaults", { channelId });
      channel.gameSettings = null;
    }

    channel.isGameStarted = true;
    logger.info("Game started", { channelId, isDebugMode });
    // From now on, the admin's game in the background pauses it
    rooms.updateAdminPresence(channelId);
    notifier.emitToChannel(channelId, "game-started", { channelId, devices: channelDevices });
    notifier.broadcastChannelUpdate(channelId);
  };

  return { voteCategories, setReady, closeVoting, updateSettings, startGame };
};
