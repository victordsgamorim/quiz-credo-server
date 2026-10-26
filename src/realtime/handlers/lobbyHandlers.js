import { parseChannelOnly, parseReadyState, parseSettings, parseVote } from "../validation.js";

/**
 * The room's lobby: the guests' votes and readiness, the admin's settings and the game's start
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerLobbyHandlers = ({ socket, on, context }) => {
  const { lobby } = context;
  const { deviceId } = socket.data;

  // Each event's payload, checked, then its use case; a payload of the wrong shape is ignored
  const bind = (event, parse, handle) =>
    on(event, (payload) => {
      const request = parse(payload);
      if (request) handle(deviceId, request);
    });

  bind("update-category-vote", parseVote, lobby.voteCategories);
  bind("update-ready-state", parseReadyState, lobby.setReady);
  bind("close-category-vote", parseChannelOnly, lobby.closeVoting);
  bind("update-game-settings", parseSettings, lobby.updateSettings);
  bind("start-game", parseSettings, lobby.startGame);
};
