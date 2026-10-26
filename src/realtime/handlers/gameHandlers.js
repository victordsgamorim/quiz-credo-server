import {
  parseAnswer,
  parseAnswerSelection,
  parseChannelOnly,
  parseLoadQuestions,
  parsePowerUp,
} from "../validation.js";

/**
 * The room's game: its questions, the players' answers and power-ups, and the admin moving it on
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 */
export const registerGameHandlers = ({ socket, on, context }) => {
  const { game } = context;
  const { deviceId } = socket.data;

  // Each event's payload, checked, then its use case; a payload of the wrong shape is ignored
  const bind = (event, parse, handle) =>
    on(event, (payload) => {
      const request = parse(payload);
      if (request) handle(deviceId, request);
    });

  bind("load-questions", parseLoadQuestions, game.loadQuestions);
  bind("guest-selected-answer", parseAnswerSelection, game.selectAnswer);
  bind("submit-answer", parseAnswer, game.submitAnswer);
  bind("use-power-up", parsePowerUp, game.usePowerUp);
  bind("next-question", parseChannelOnly, game.nextQuestion);
  bind("reset-game", parseChannelOnly, game.resetGame);
};
