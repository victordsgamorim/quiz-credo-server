import { buildChannelState } from "../domain/channelState.js";
import { DEFAULT_LOCALE } from "../domain/constants.js";
import { isGamePlayer, isGameUnderWay } from "../domain/gameState.js";
import { getPowerUpHand, isAttackBlocked } from "../domain/powerUps.js";
import { getLiveRanking } from "../domain/ranking.js";
import { replayScores } from "../domain/scoring.js";

// The room-wide update without every language's questions shows this many categories
const ROOM_UPDATE_CATEGORY_LIMIT = 10;

/**
 * Everything the server sends the devices: to one device, or to everyone in a room
 *
 * @param context.io - The Socket.IO server
 * @param context.store - The server's state
 * @param context.logger - Where it logs
 * @param context.config - The server's settings
 */
export const createNotifier = ({ io, store, logger, config }) => {
  const { channels, devices } = store;

  const emitToDevice = (deviceId, event, payload) => {
    const socketId = devices.get(deviceId)?.socketId;
    if (socketId) io.to(socketId).emit(event, payload);
  };

  const emitToChannel = (channelId, event, payload) => io.to(channelId).emit(event, payload);

  const getDeviceLocale = (device) => device.locale || DEFAULT_LOCALE;

  // How a device sees the room: the questions in its language, and every right answer for the
  // admin, who loaded them
  const getView = (channel, device) => ({
    locale: getDeviceLocale(device),
    showAllAnswers: device.id === channel.adminId,
  });

  const buildStateFor = (channelId, channel, view, categoryLimit = Infinity) =>
    buildChannelState(channelId, channel, devices, {
      ...view,
      categoryLimit,
      adminAwayTimeoutMs: config.adminAwayTimeoutMs,
    });

  // Sends the room the live ranking when it changed: answers, power-ups, players joining or leaving
  const broadcastLiveRanking = (channelId) => {
    const channel = channels.get(channelId);
    if (!isGameUnderWay(channel)) return;
    const ranking = getLiveRanking(channel, devices);
    const key = JSON.stringify(ranking);
    if (channel.gameState.liveRankingKey === key) return;
    channel.gameState.liveRankingKey = key;
    emitToChannel(channelId, "ranking-update", { ranking });
  };

  const broadcastChannelUpdate = (channelId) => {
    const channel = channels.get(channelId);
    if (!channel) return;
    const { gameState } = channel;

    if (gameState?.questionsByLocale || gameState?.questions.length > 0) {
      // A game with questions: each device gets the room as it sees it (its language's questions,
      // the right answers it can know). Every language's questions show every category voted
      // (one language's, from older frontends, the room update's)
      const categoryLimit = gameState.questionsByLocale ? Infinity : ROOM_UPDATE_CATEGORY_LIMIT;
      const states = new Map(); // view -> the room as that view sees it
      channel.devices.forEach((deviceId) => {
        const device = devices.get(deviceId);
        if (!device?.socketId) return;
        const view = getView(channel, device);
        const key = `${view.locale}:${view.showAllAnswers}`;
        if (!states.has(key)) {
          states.set(key, buildStateFor(channelId, channel, view, categoryLimit));
        }
        emitToDevice(deviceId, "channel-update", states.get(key));
      });
    } else {
      emitToChannel(
        channelId,
        "channel-update",
        buildStateFor(channelId, channel, {}, ROOM_UPDATE_CATEGORY_LIMIT)
      );
    }

    // Answers and players joining or leaving come with a room update, and can change the ranking
    broadcastLiveRanking(channelId);
  };

  // Sends a device the room it just created or joined
  const sendJoinedChannel = (socket, channelId, device) => {
    const channel = channels.get(channelId);
    if (!channel) return;
    socket.emit("joined-channel", buildStateFor(channelId, channel, getView(channel, device)));
  };

  const sendLiveRanking = (socket, channel) =>
    socket.emit("ranking-update", { ranking: getLiveRanking(channel, devices) });

  // Sends a player of the game their hand
  const emitPowerUpHand = (channel, deviceId) => {
    const device = devices.get(deviceId);
    if (!device?.socketId || !isGamePlayer(channel, device)) return;
    emitToDevice(deviceId, "power-up-hand", { powerUpIds: getPowerUpHand(channel, deviceId) });
  };

  const toPowerUpPlayer = (deviceId) => ({
    id: deviceId,
    name: devices.get(deviceId)?.displayName || deviceId,
  });

  // Tells the attacker and the target how each disadvantage of the question turned out, when it's
  // new or it changed: a later shield blocks it, or undoing a steal changes what a later one took
  const emitPowerUpOutcomes = (channel, questionIndex) => {
    const { gameState } = channel;
    const { stolenPoints } = replayScores(channel);

    gameState.powerUps
      .filter((use) => use.targetDeviceId && use.questionIndex === questionIndex)
      .forEach((attack) => {
        const outcome = {
          questionIndex,
          powerUpId: attack.powerUpId,
          attacker: toPowerUpPlayer(attack.deviceId),
          target: toPowerUpPlayer(attack.targetDeviceId),
          isBlocked: isAttackBlocked(gameState.powerUps, attack),
          ...(stolenPoints.has(attack) ? { points: stolenPoints.get(attack) } : {}),
        };
        const key = `${outcome.isBlocked}:${outcome.points ?? ""}`;
        if (attack.lastOutcomeKey === key) return;
        attack.lastOutcomeKey = key;

        [attack.deviceId, attack.targetDeviceId].forEach((deviceId) =>
          emitToDevice(deviceId, "power-up-outcome", outcome)
        );
      });
  };

  // Takes a device's connection out of the room's broadcasts
  const leaveSocketRoom = (device, channelId) => {
    io.sockets.sockets.get(device.socketId)?.leave(channelId);
  };

  const isConnected = (device) =>
    Boolean(device?.socketId && io.sockets.sockets.has(device.socketId));

  return {
    emitToDevice,
    emitToChannel,
    broadcastChannelUpdate,
    broadcastLiveRanking,
    sendJoinedChannel,
    sendLiveRanking,
    emitPowerUpHand,
    emitPowerUpOutcomes,
    leaveSocketRoom,
    isConnected,
  };
};
