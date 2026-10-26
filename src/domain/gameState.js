import { DEFAULT_TIMER_SECONDS } from "./constants.js";

// A room's game before its questions load: a new room's, or one back in the lobby
export const createGameState = () => ({
  questions: [],
  currentQuestionIndex: 0,
  questionStartTime: null,
  timerRemaining: DEFAULT_TIMER_SECONDS,
  timerInterval: null,
  answers: new Map(),
  powerUps: [],
  powerUpHands: new Map(),
  isShowingResults: false,
});

// Seconds to answer each question of the room's game
export const getTimerDuration = (channel) =>
  channel.gameSettings?.timerDuration || DEFAULT_TIMER_SECONDS;

// The players of a game: the guests, and the admin when debug mode lets them answer
export const isGamePlayer = (channel, device) =>
  Boolean(device) &&
  channel.devices.has(device.id) &&
  (device.role === "guest" ||
    (device.role === "admin" && Boolean(channel.gameSettings?.enableDebugMode)));

export const isQuestionTimeUp = (channel) =>
  channel.gameSettings?.timerDuration !== null && channel.gameState.timerRemaining <= 0;

// From the game's start to its results: the rules, then the questions
export const isInGame = (channel) =>
  Boolean(channel.isGameStarted && !channel.gameState?.isShowingResults);

export const isGameUnderWay = (channel) =>
  Boolean(
    channel?.isGameStarted &&
    channel.gameState?.questions?.length &&
    !channel.gameState.isShowingResults
  );

export const hasAnswered = (channel, deviceId, questionIndex) =>
  (channel.gameState.answers.get(deviceId) || []).some(
    (answer) => answer.questionIndex === questionIndex
  );

// The question the players are on, while there's one
export const getCurrentQuestion = (channel) =>
  channel.gameState.isShowingResults
    ? undefined
    : channel.gameState.questions[channel.gameState.currentQuestionIndex];

/**
 * Whether the question is over for the room, so that its right answer can be shown: the frontend
 * shows it once someone answered the question (every device shows the feedback then), once its
 * time is up, and for the questions already played
 *
 * @param channel - The room
 * @param questionIndex - The question's index in the game
 * @returns Whether every device can know the question's right answer
 */
export const isQuestionRevealed = (channel, questionIndex) => {
  const { gameState } = channel;
  if (gameState.isShowingResults || questionIndex < gameState.currentQuestionIndex) return true;
  if (questionIndex > gameState.currentQuestionIndex) return false;
  return (
    isQuestionTimeUp(channel) ||
    [...gameState.answers.keys()].some((deviceId) => hasAnswered(channel, deviceId, questionIndex))
  );
};

// A player who quits the game (the leave button, not a reload) is out of its ranking too, until they
// join the room again. What they did in the game stays: a steal still took its points
export const quitGame = (channel, deviceId) => {
  if (!channel.gameState) return;
  channel.gameState.quitDeviceIds = channel.gameState.quitDeviceIds || new Set();
  channel.gameState.quitDeviceIds.add(deviceId);
};

// The guests in the room, and how many of them answered the question
export const getAnsweredGuestsCount = (channel, questionIndex, devices) => {
  if (!channel || !channel.gameState || !channel.gameState.answers) {
    return { answeredCount: 0, totalGuests: 0 };
  }

  let answeredCount = 0;
  let totalGuests = 0;
  Array.from(channel.devices || []).forEach((deviceId) => {
    const device = devices.get(deviceId);
    if (device && device.role === "guest") {
      totalGuests++;
      if (hasAnswered(channel, deviceId, questionIndex)) {
        answeredCount++;
      }
    }
  });

  return { answeredCount, totalGuests };
};

// The guests in the room who picked an answer to the current question: one who left no longer
// counts
export const getSelectedGuestsCount = (channel) =>
  [...(channel?.gameState?.guestSelections || [])].filter((deviceId) =>
    channel.devices.has(deviceId)
  ).length;
