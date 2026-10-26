import { isGameUnderWay } from "../../domain/gameState.js";
import { parseLeave, parseRemoveDevice, parseRoomRequest } from "../validation.js";

/**
 * Rooms: creating one, joining one, leaving it, and the admin removing a guest. The deviceId the
 * frontend sends with create-channel and join-channel is ignored: a connection only acts for its
 * own device.
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerRoomHandlers = ({ socket, on, context }) => {
  const { rooms, notifier, logger, roomCreationAuth, failedJoins } = context;
  const { deviceId, ip } = socket.data;

  const sendError = (error) => socket.emit("channel-error", { error });

  on("create-channel", async (channelId, _deviceId, options) => {
    const request = parseRoomRequest(channelId, options);
    if (request.error) {
      sendError(request.error);
      return;
    }

    // Only an admin signed in to Supabase creates a room (when the server requires it)
    if (roomCreationAuth) {
      const user = await roomCreationAuth.getUser(request.accessToken);
      if (!user) {
        logger.warn("Room refused: no valid Supabase session", { deviceId });
        sendError("auth_required");
        return;
      }
      if (!socket.connected) return;
    }

    const result = rooms.openRoom(deviceId, request.channelId, request, socket.id);
    if (result.error) {
      sendError(result.error);
      return;
    }
    socket.join(request.channelId);
    notifier.sendJoinedChannel(socket, request.channelId, result.device);
  });

  on("join-channel", (channelId, _deviceId, options) => {
    // Too many rooms not found from this address: someone's guessing room codes
    if (failedJoins.isExhausted(ip)) {
      sendError("rate_limited");
      return;
    }
    const request = parseRoomRequest(channelId, options);
    const result = request.error
      ? { error: "channel_not_found" }
      : rooms.joinRoom(deviceId, request.channelId, request, socket.id);
    if (result.error) {
      if (result.error === "channel_not_found") failedJoins.take(ip);
      sendError(result.error);
      return;
    }

    const { channel, device } = result;
    socket.join(request.channelId);
    // The admin back (a reload) resumes the game
    rooms.updateAdminPresence(request.channelId);
    notifier.broadcastChannelUpdate(request.channelId);
    notifier.sendJoinedChannel(socket, request.channelId, device);
    // Back in a game under way (a reload): the same hand as before, and the ranking so far
    if (channel.isGameStarted && channel.gameState?.questions?.length) {
      notifier.emitPowerUpHand(channel, deviceId);
    }
    if (isGameUnderWay(channel)) {
      notifier.sendLiveRanking(socket, channel);
    }
  });

  // isQuitting: the player's own leave (the leave button), not a reload's; it takes them out of the
  // game's ranking too
  on("leave-channel", (channelId, options) => {
    const request = parseLeave(channelId, options);
    rooms.leaveChannel(deviceId, request.channelId, { isQuitting: request.isQuitting });
  });

  on("remove-device", (payload) => {
    const request = parseRemoveDevice(payload);
    if (request) rooms.removeGuest(deviceId, request);
  });
};
