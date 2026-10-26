import { replayScores } from "./scoring.js";

// The devices a game ranks: its players (the guests, and the admin when debug mode lets them
// answer), with the ones who answered and then left (a reload leaves the room for a moment), but
// not the ones who quit the game
const getRankedDeviceIds = (channel, devices) => {
  const isDebugMode = Boolean(channel.gameSettings?.enableDebugMode);
  const { answers, quitDeviceIds } = channel.gameState;
  const deviceIds = new Set([...channel.devices, ...answers.keys()]);
  return [...deviceIds].filter(
    (deviceId) =>
      devices.has(deviceId) &&
      !quitDeviceIds?.has(deviceId) &&
      (deviceId !== channel.adminId || isDebugMode)
  );
};

// The game's players by points (the answers', with the bonuses and the steals), most first. On
// equal points, the one who got there first stays ahead, so a player has to pass another to
// overtake them; before anyone scores, the room's order
const rankPlayers = (channel, devices) => {
  const { scores, changedAt } = replayScores(channel);
  return getRankedDeviceIds(channel, devices)
    .map((deviceId, order) => ({
      deviceId,
      order,
      totalPoints: scores.get(deviceId) || 0,
      changedAt: changedAt.get(deviceId) || 0,
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints || a.changedAt - b.changedAt || a.order - b.order)
    .map(({ deviceId, totalPoints }, index) => ({ position: index + 1, deviceId, totalPoints }));
};

// The ranking while the game's questions play: the final ranking's order, with only the points
export const getLiveRanking = (channel, devices) =>
  rankPlayers(channel, devices).map(({ position, deviceId, totalPoints }) => ({
    position,
    deviceId,
    displayName: devices.get(deviceId)?.displayName || deviceId,
    totalPoints,
  }));

// The final ranking, when the game ends: the live ranking with each player's answers
export const getFinalRanking = (channel, devices) =>
  rankPlayers(channel, devices).map(({ position, deviceId, totalPoints }) => {
    const device = devices.get(deviceId);
    const answers = channel.gameState.answers.get(deviceId) || [];
    const correctAnswers = answers.filter((a) => a.isCorrect).length;
    const totalAnswers = answers.length;
    const accuracy = totalAnswers > 0 ? (correctAnswers / totalAnswers) * 100 : 0;

    return {
      position,
      deviceId,
      displayName: device.displayName,
      role: device.role,
      totalPoints,
      correctAnswers,
      totalAnswers,
      accuracy: Math.round(accuracy),
    };
  });
