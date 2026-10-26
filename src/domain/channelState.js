import { getCategoryTotals } from "./categories.js";
import { DEFAULT_LOCALE, MAX_CATEGORY_SELECTIONS } from "./constants.js";
import { getAnsweredGuestsCount, getSelectedGuestsCount, isQuestionRevealed } from "./gameState.js";

// What the room's devices see of a device (its connection's id stays on the server)
export const buildDevicePayload = (device) => ({
  id: device.id,
  connectedAt: device.connectedAt,
  channel: device.channel,
  isActive: device.isActive,
  role: device.role || "guest",
  displayName: device.displayName || device.id,
  isReady: Boolean(device.isReady),
  locale: device.locale || DEFAULT_LOCALE,
});

export const getChannelDevices = (channel, devices) =>
  Array.from(channel?.devices || [])
    .map((id) => devices.get(id))
    .filter((device) => device != null)
    .map(buildDevicePayload);

// While the admin is away: how long until the room closes. Every device counts down from it, so
// their clocks don't need to match the server's
export const getAdminAway = (channel, timeoutMs) =>
  channel?.adminAwayUntil
    ? {
        closesInMs: Math.max(0, channel.adminAwayUntil - Date.now()),
        timeoutMs,
      }
    : null;

// A question as a device sees it: its right answer only once the device can know it
const buildQuestionPayload = (question, showAnswer) => ({
  id: question.id,
  question: question.question,
  options: question.options,
  difficulty: question.difficulty,
  points: question.points,
  category: question.category,
  ...(showAnswer ? { correctAnswer: question.correctAnswer } : {}),
});

// The questions a device gets: the ones in its language when the game has every language's, the
// game's otherwise
const getQuestionsFor = (gameState, locale) =>
  (locale && gameState.questionsByLocale?.get(locale)) || gameState.questions || [];

/**
 * The room as a device sees it (channel-update, joined-channel)
 *
 * @param channelId - The room's id
 * @param channel - The room
 * @param devices - Every device, by id
 * @param options.locale - The language of the questions; without it, the game's questions
 * @param options.showAllAnswers - Whether the device sees every question's right answer (the
 *   admin, who loaded them), or only the ones of the questions that are over
 * @param options.categoryLimit - The most voted categories it shows, at most
 * @param options.adminAwayTimeoutMs - How long the room waits for an admin who went away
 */
export const buildChannelState = (
  channelId,
  channel,
  devices,
  { locale, showAllAnswers = false, categoryLimit = Infinity, adminAwayTimeoutMs }
) => {
  const channelDevices = getChannelDevices(channel, devices);
  const { gameState } = channel;
  const answerStats = gameState
    ? getAnsweredGuestsCount(channel, gameState.currentQuestionIndex, devices)
    : { answeredCount: 0, totalGuests: 0 };

  return {
    channelId,
    devices: channelDevices,
    totalDevices: channelDevices.length,
    adminId: channel.adminId || null,
    categoryTotals: getCategoryTotals(channel).slice(0, categoryLimit),
    maxCategorySelections: channel.gameSettings?.maxCategorySelections || MAX_CATEGORY_SELECTIONS,
    gameSettings: channel.gameSettings || null,
    isVotingClosed: Boolean(channel.isVotingClosed),
    isGameStarted: Boolean(channel.isGameStarted),
    adminAway: getAdminAway(channel, adminAwayTimeoutMs),
    gameState: gameState
      ? {
          questions: getQuestionsFor(gameState, locale).map((question, index) =>
            buildQuestionPayload(question, showAllAnswers || isQuestionRevealed(channel, index))
          ),
          currentQuestionIndex: gameState.currentQuestionIndex,
          timerRemaining: gameState.timerRemaining,
          isShowingResults: gameState.isShowingResults,
          answeredGuestsCount: answerStats.answeredCount,
          totalGuests: answerStats.totalGuests,
          selectedGuestsCount: getSelectedGuestsCount(channel),
        }
      : null,
  };
};
