import { createGameState, isInGame, quitGame } from "../domain/gameState.js";
import { cleanText } from "../domain/text.js";

const MAX_DISPLAY_NAME_LENGTH = 50;

/**
 * Who's in which room: devices joining and leaving, rooms opening and closing, and the game pausing
 * while the room's admin is away
 *
 * @param context.store - The server's state
 * @param context.notifier - What the server sends the devices
 * @param context.timer - The question's countdown
 * @param context.logger - Where it logs
 * @param context.config - The server's settings
 */
export const createRoomService = ({ store, notifier, timer, logger, config }) => {
  const { channels, devices } = store;

  const createChannel = (channelId, adminId) => {
    const channel = {
      adminId,
      devices: new Set(),
      votes: new Map(),
      isVotingClosed: false,
      isGameStarted: false,
      gameState: createGameState(),
    };
    channels.set(channelId, channel);
    return channel;
  };

  // Puts the device in the room: as its admin when it's the room's, as a guest otherwise
  const addDevice = (channelId, channel, device, socketId) => {
    channel.devices.add(device.id);
    // Back in the room after quitting its game: back in the game's ranking
    channel.gameState?.quitDeviceIds?.delete(device.id);
    device.channel = channelId;
    device.socketId = socketId;
    device.role = channel.adminId === device.id ? "admin" : "guest";
    device.isReady = false;
  };

  const setDisplayName = (device, displayName) => {
    if (displayName && typeof displayName === "string") {
      device.displayName = cleanText(displayName, MAX_DISPLAY_NAME_LENGTH);
    }
  };

  const removeDeviceFromChannel = (deviceId, reason, options = {}) => {
    const device = devices.get(deviceId);
    if (!device || !device.channel) {
      return;
    }

    const channelId = device.channel;
    const channel = channels.get(channelId);
    if (!channel) {
      device.channel = null;
      device.role = "guest";
      return;
    }

    channel.devices.delete(deviceId);
    channel.votes?.delete(deviceId);
    device.channel = null;
    device.role = "guest";
    device.isReady = false;

    notifier.leaveSocketRoom(device, channelId);
    if (reason) {
      notifier.emitToDevice(deviceId, "force-leave-channel", { channelId, reason });
    }

    if (channel.devices.size === 0) {
      closeEmptyChannel(channelId, channel);
    } else if (!options.suppressUpdate) {
      notifier.broadcastChannelUpdate(channelId);
    }
  };

  // The room without anyone in it: its timers stop with it
  const closeEmptyChannel = (channelId, channel) => {
    clearTimeout(channel.adminAwayTimer);
    timer.stop(channel);
    channels.delete(channelId);
  };

  // Closes the room, taking everyone out of it; the admin is told only when notifyAdmin
  const forceCloseChannel = (channelId, reason, { notifyAdmin = false } = {}) => {
    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }

    logger.info("Closing room", { channelId, reason });
    Array.from(channel.devices).forEach((deviceId) => {
      const shouldNotify = deviceId === channel.adminId ? notifyAdmin : true;
      removeDeviceFromChannel(deviceId, shouldNotify ? reason : undefined, {
        suppressUpdate: true,
      });
    });
    closeEmptyChannel(channelId, channel);
  };

  // A device out of its room (the one it's in, or the one it names when it's in none): the admin's
  // leaving closes it; a guest's quitting (not a reload's) takes them out of the game's ranking too
  const leaveChannel = (deviceId, requestedChannelId, { isQuitting = false } = {}) => {
    const device = devices.get(deviceId);
    const channelId = device?.channel || requestedChannelId;
    if (!device || !channelId) {
      logger.debug("Leaving without a room", { deviceId });
      return;
    }

    const channel = channels.get(channelId);
    if (channel && channel.adminId === deviceId) {
      forceCloseChannel(channelId, "admin_left");
      return;
    }
    if (channel && isQuitting) {
      quitGame(channel, deviceId);
    }
    removeDeviceFromChannel(deviceId);
    // Already out of the room (it left offline, and its reconnection took it out): the ranking
    // changes all the same
    notifier.broadcastLiveRanking(channelId);
  };

  // A device going to another room leaves the one it's in (a device is in one room at a time)
  const leaveCurrentChannel = (device, nextChannelId) => {
    if (device.channel && device.channel !== nextChannelId) {
      leaveChannel(device.id, device.channel, { isQuitting: true });
    }
  };

  /**
   * Opens a room with the device as its admin
   *
   * @returns The device and its room, or the error to tell it
   */
  const openRoom = (deviceId, channelId, { displayName } = {}, socketId) => {
    const device = devices.get(deviceId);
    if (!device) {
      logger.warn("Unknown device creating a room", { deviceId });
      return { error: "device_not_found" };
    }
    if (channels.has(channelId)) {
      logger.debug("Room already exists", { channelId });
      return { error: "channel_already_exists" };
    }

    leaveCurrentChannel(device, channelId);
    if (channels.size >= config.maxRooms) {
      logger.warn("Room refused: too many rooms", { rooms: channels.size });
      return { error: "too_many_rooms" };
    }

    setDisplayName(device, displayName);
    const channel = createChannel(channelId, deviceId);
    addDevice(channelId, channel, device, socketId);
    logger.info("Room created", { channelId, adminId: deviceId });
    return { device, channel };
  };

  /**
   * Puts the device in the room; joining it again changes its name
   *
   * @returns The device and its room, or the error to tell it
   */
  const joinRoom = (deviceId, channelId, { displayName } = {}, socketId) => {
    const device = devices.get(deviceId);
    if (!device) {
      logger.warn("Unknown device joining a room", { deviceId });
      return { error: "device_not_found" };
    }
    const channel = channels.get(channelId);
    if (!channel) {
      logger.debug("Room not found", { channelId });
      return { error: "channel_not_found" };
    }
    if (!channel.devices.has(deviceId) && channel.devices.size >= config.maxDevicesPerRoom) {
      logger.warn("Device refused: the room is full", { channelId });
      return { error: "room_full" };
    }

    leaveCurrentChannel(device, channelId);
    setDisplayName(device, displayName);
    addDevice(channelId, channel, device, socketId);
    logger.info("Device joined a room", { channelId, deviceId, devices: channel.devices.size });
    return { device, channel };
  };

  // The admin takes a guest out of the room
  const removeGuest = (adminId, { channelId, targetDeviceId }) => {
    const admin = devices.get(adminId);
    const channel = channels.get(channelId);
    if (!admin || !channel || admin.channel !== channelId) return;
    if (channel.adminId !== adminId) {
      logger.warn("Removing a device without being the room's admin", { adminId, channelId });
      return;
    }
    if (targetDeviceId === channel.adminId || !channel.devices.has(targetDeviceId)) {
      return;
    }

    logger.info("Admin removed a device", { channelId, deviceId: targetDeviceId });
    removeDeviceFromChannel(targetDeviceId, "removed_by_admin");
  };

  // Whether the room's admin is away: their connection is gone or, during a game, the game is in the
  // background on their device. Once a game is over, its results stay up whether the admin is there
  // or not.
  const isAdminAway = (channelId, channel) => {
    if (channel.gameState?.isShowingResults) return false;
    const admin = devices.get(channel.adminId);
    if (!notifier.isConnected(admin) || admin.channel !== channelId) return true;
    return isInGame(channel) && !admin.isActive;
  };

  // Pauses the room's game when its admin goes away, and closes the room if they're not back within
  // the admin away timeout; resumes the game once they're back. Called whenever the admin's
  // connection, their game's visibility or the game's stage changes; the callers then send the room
  // its update.
  const updateAdminPresence = (channelId) => {
    const channel = channels.get(channelId);
    if (!channel) return;
    const isAway = isAdminAway(channelId, channel);
    if (isAway === Boolean(channel.adminAwayUntil)) return;

    if (isAway) {
      logger.info("Room's admin is away: game paused", { channelId });
      channel.adminAwayUntil = Date.now() + config.adminAwayTimeoutMs;
      channel.adminAwayTimer = setTimeout(() => {
        try {
          if (channels.get(channelId) === channel) {
            forceCloseChannel(channelId, "admin_inactive_timeout", { notifyAdmin: true });
          }
        } catch (error) {
          logger.error("Closing the room of an away admin failed", { channelId, error });
        }
      }, config.adminAwayTimeoutMs);
      timer.pause(channel);
    } else {
      logger.info("Room's admin is back: game resumed", { channelId });
      clearTimeout(channel.adminAwayTimer);
      channel.adminAwayTimer = null;
      channel.adminAwayUntil = null;
      timer.resume(channelId, channel);
    }
  };

  return {
    openRoom,
    joinRoom,
    removeGuest,
    removeDeviceFromChannel,
    forceCloseChannel,
    leaveChannel,
    updateAdminPresence,
  };
};
