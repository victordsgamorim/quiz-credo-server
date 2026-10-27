import { parseChannelOnly, parseReadyState, parseSettings, parseVote } from "../validation.js";
import { createRequestBinder } from "./bindRequest.js";

/**
 * The room's lobby: the guests' votes and readiness, the admin's settings and the game's start
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerLobbyHandlers = ({ socket, on, context }) => {
  const { lobby } = context;
  const bind = createRequestBinder({ socket, on, context });

  bind("update-category-vote", parseVote, lobby.voteCategories);
  bind("update-ready-state", parseReadyState, lobby.setReady);
  bind("close-category-vote", parseChannelOnly, lobby.closeVoting, { isAdminAction: true });
  bind("update-game-settings", parseSettings, lobby.updateSettings, { isAdminAction: true });
  bind("start-game", parseSettings, lobby.startGame, { isAdminAction: true });
};
