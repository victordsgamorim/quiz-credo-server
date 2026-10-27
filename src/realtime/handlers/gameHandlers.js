import {
  parseAnswer,
  parseAnswerSelection,
  parseChannelOnly,
  parseLoadQuestions,
  parsePowerUp,
} from "../validation.js";
import { createRequestBinder } from "./bindRequest.js";

/**
 * The room's game: its questions, the players' answers and power-ups, and the admin moving it on
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerGameHandlers = ({ socket, on, context }) => {
  const { game } = context;
  const bind = createRequestBinder({ socket, on, context });

  bind("load-questions", parseLoadQuestions, game.loadQuestions, { isAdminAction: true });
  bind("guest-selected-answer", parseAnswerSelection, game.selectAnswer);
  bind("submit-answer", parseAnswer, game.submitAnswer);
  bind("use-power-up", parsePowerUp, game.usePowerUp);
  bind("next-question", parseChannelOnly, game.nextQuestion, { isAdminAction: true });
  bind("reset-game", parseChannelOnly, game.resetGame, { isAdminAction: true });
};
