/**
 * The server's state, in memory (a restart starts it over):
 * - channels: channelId -> the room: { adminId, devices: Set<deviceId>, votes: Map<deviceId,
 *   Set<category>>, isVotingClosed, isGameStarted, gameSettings, gameState, adminAwayUntil,
 *   adminAwayTimer }
 * - devices: deviceId -> the device: { id, socketId, connectedAt, channel, isActive, role,
 *   displayName, isReady, locale }
 */
export const createStore = () => ({
  channels: new Map(),
  devices: new Map(),
});
