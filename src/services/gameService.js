import {
  createGameState,
  getCurrentQuestion,
  getTimerDuration,
  hasAnswered,
} from "../domain/gameState.js";
import { getPowerUpRejection, isAttack } from "../domain/powerUps.js";
import { parseGameQuestions } from "../domain/questions.js";
import { getFinalRanking } from "../domain/ranking.js";
import { scoreAnswer } from "../domain/scoring.js";

/**
 * The room's game: its questions, the players' answers and power-ups, the admin moving it from one
 * question to the next, and back to the lobby
 *
 * @param context.store - The server's state
 * @param context.rooms - Who's in which room
 * @param context.notifier - What the server sends the devices
 * @param context.timer - The question's countdown
 * @param context.logger - Where it logs
 */
export const createGameService = ({ store, rooms, notifier, timer, logger }) => {
  const { channels, devices } = store;

  // The room the device is in, when it's the one it names and its game started
  const getGameChannel = (deviceId, channelId) => {
    const device = devices.get(deviceId);
    if (!device || device.channel !== channelId) return null;
    const channel = channels.get(channelId);
    return channel?.isGameStarted ? channel : null;
  };

  // The game's questions, from the admin's frontend: every language's (each device gets its own
  // language's, the default language's are the ones the answers are checked against), or one
  // language's (older frontends)
  const loadQuestions = (deviceId, { channelId, questions }) => {
    const device = devices.get(deviceId);
    if (!device || device.channel !== channelId) return;
    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== deviceId) {
      logger.warn("Questions from a device that isn't the room's admin", { deviceId, channelId });
      return;
    }
    if (!channel.isGameStarted) {
      logger.warn("Questions before the game started", { channelId });
      return;
    }

    const game = parseGameQuestions(questions);
    if (!game) {
      logger.warn("Invalid questions refused", { channelId });
      return;
    }

    const { gameState } = channel;
    gameState.questions = game.questions;
    gameState.questionsByLocale = game.questionsByLocale;
    logger.info("Questions loaded", {
      channelId,
      count: game.questions.length,
      locales: game.questionsByLocale ? [...game.questionsByLocale.keys()] : null,
    });

    gameState.currentQuestionIndex = 0;
    gameState.questionStartTime = Date.now();
    gameState.timerRemaining = getTimerDuration(channel);
    gameState.guestSelections = new Set();
    // A new game gives every power-up back, and deals each player a new hand
    gameState.powerUps = [];
    gameState.powerUpHands = new Map();
    channel.devices.forEach((memberId) => notifier.emitPowerUpHand(channel, memberId));

    timer.start(channelId);

    // Everyone starts the ranking at 0, sent before the first question shows
    gameState.liveRankingKey = null;
    notifier.broadcastLiveRanking(channelId);
    notifier.broadcastChannelUpdate(channelId);
  };

  // A guest picked an answer (not sent yet): the admin sees how many guests did
  const selectAnswer = (deviceId, { channelId, questionIndex }) => {
    const device = devices.get(deviceId);
    if (!device || device.channel !== channelId || device.role !== "guest") return;
    const channel = getGameChannel(deviceId, channelId);
    if (!channel || questionIndex !== channel.gameState.currentQuestionIndex) return;

    channel.gameState.guestSelections = channel.gameState.guestSelections || new Set();
    channel.gameState.guestSelections.add(deviceId);
    logger.debug("Guest picked an answer", {
      channelId,
      deviceId,
      questionIndex,
      selected: channel.gameState.guestSelections.size,
    });
    notifier.broadcastChannelUpdate(channelId);
  };

  const submitAnswer = (deviceId, { channelId, questionIndex, answerIndex, timeSpent }) => {
    const channel = getGameChannel(deviceId, channelId);
    if (!channel) return;
    const { gameState } = channel;
    if (questionIndex !== gameState.currentQuestionIndex || !getCurrentQuestion(channel)) {
      logger.debug("Answer to a question that isn't the current one", { deviceId, questionIndex });
      return;
    }
    if (hasAnswered(channel, deviceId, questionIndex)) {
      logger.debug("Question already answered", { deviceId, questionIndex });
      return;
    }

    const answer = scoreAnswer(channel, deviceId, { questionIndex, answerIndex, timeSpent });
    if (!gameState.answers.has(deviceId)) {
      gameState.answers.set(deviceId, []);
    }
    gameState.answers.get(deviceId).push(answer);
    logger.debug("Answer", {
      channelId,
      deviceId,
      questionIndex,
      isCorrect: answer.isCorrect,
      points: answer.points,
      multiplier: answer.multiplier,
    });

    // The room's update shows how many answered; every device shows the answer's feedback
    notifier.broadcastChannelUpdate(channelId);
    notifier.emitToChannel(channelId, "answer-result", {
      questionIndex,
      isCorrect: answer.isCorrect,
      points: answer.points,
      deviceId,
    });
  };

  const usePowerUp = (deviceId, { channelId, powerUpId, targetDeviceId }) => {
    const channel = getGameChannel(deviceId, channelId);
    if (!channel || !channel.gameState) return;
    const { gameState } = channel;
    gameState.powerUps = gameState.powerUps || [];

    const device = devices.get(deviceId);
    const rejection = getPowerUpRejection(channel, device, { powerUpId, targetDeviceId }, devices);
    if (rejection) {
      logger.debug("Power-up refused", { deviceId, powerUpId: String(powerUpId), rejection });
      return;
    }

    const questionIndex = gameState.currentQuestionIndex;
    gameState.powerUps.push({
      deviceId,
      powerUpId,
      questionIndex,
      targetDeviceId: isAttack(powerUpId) ? targetDeviceId : null,
      timestamp: Date.now(),
    });
    logger.debug("Power-up used", { channelId, deviceId, powerUpId, questionIndex });

    // A disadvantage is told at once; a shield blocks the ones already used on the player too
    notifier.emitPowerUpOutcomes(channel, questionIndex);
    // A bonus or a steal changes the points at once, and a shield can undo a steal
    notifier.broadcastLiveRanking(channelId);
  };

  const finishGame = (channelId, channel) => {
    const { gameState } = channel;
    gameState.isShowingResults = true;
    // The results stay up, whether the admin is there or not
    rooms.updateAdminPresence(channelId);

    const ranking = getFinalRanking(channel, devices);
    logger.info("Game finished", { channelId, players: ranking.length });
    notifier.emitToChannel(channelId, "game-finished", {
      ranking,
      totalQuestions: gameState.questions.length,
    });
  };

  const nextQuestion = (deviceId, { channelId }) => {
    const device = devices.get(deviceId);
    if (!device || device.channel !== channelId) return;
    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== deviceId) {
      logger.warn("Next question from a device that isn't the room's admin", { deviceId });
      return;
    }
    if (!channel.isGameStarted) return;

    const { gameState } = channel;
    timer.stop(channel);
    gameState.currentQuestionIndex++;
    gameState.guestSelections = new Set();

    if (gameState.currentQuestionIndex >= gameState.questions.length) {
      finishGame(channelId, channel);
    } else {
      gameState.questionStartTime = Date.now();
      gameState.timerRemaining = getTimerDuration(channel);
      timer.start(channelId);
      logger.debug("Next question", { channelId, question: gameState.currentQuestionIndex + 1 });
    }

    notifier.broadcastChannelUpdate(channelId);
  };

  // Back to the lobby: the votes stay, the voting opens again (the guests can change their votes for
  // the next game, and a guest who joins now can vote) and every guest gets ready again
  const resetGame = (deviceId, { channelId }) => {
    const device = devices.get(deviceId);
    const channel = channelId ? channels.get(channelId) : null;
    if (!device || !channel || device.channel !== channelId) return;
    if (channel.adminId !== deviceId) {
      logger.warn("Resetting the game without being the room's admin", { deviceId, channelId });
      return;
    }

    logger.info("Game reset", { channelId });
    timer.stop(channel);
    channel.isGameStarted = false;
    channel.isVotingClosed = false;
    channel.gameState = createGameState();
    channel.devices.forEach((memberId) => {
      const member = devices.get(memberId);
      if (member && member.role === "guest") {
        member.isReady = false;
      }
    });

    // Back in the lobby, the admin's game in the background no longer pauses anything
    rooms.updateAdminPresence(channelId);
    notifier.emitToChannel(channelId, "game-reset", { channelId });
    notifier.broadcastChannelUpdate(channelId);
  };

  return { loadQuestions, selectAnswer, submitAnswer, usePowerUp, nextQuestion, resetGame };
};
