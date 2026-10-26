// What the server takes from each event's payload. The frontend always sends these shapes;
// anything else comes from another client, and the event is ignored (null).

// The frontend's room codes: 6 characters among 2-9 and A-Z (typed ones are made uppercase)
const CHANNEL_ID_PATTERN = /^[A-Z0-9]{4,16}$/;
// The frontend's device ids (device_<random>_<time>), the server's (device_<uuid>), and the
// connection's id the server falls back to
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_POWER_UP_ID_LENGTH = 32;
const MAX_QUESTION_INDEX = 1000;
const MAX_ANSWER_INDEX = 100;
const MAX_VOTED_CATEGORIES = 50;
const MAX_TIME_SPENT_SECONDS = 86400;

export const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isValidChannelId = (value) =>
  typeof value === "string" && CHANNEL_ID_PATTERN.test(value);

export const isValidDeviceId = (value) =>
  typeof value === "string" && DEVICE_ID_PATTERN.test(value);

const isIndex = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

// A payload that names a room: the event's own room, the one the device is in
const parseChannelPayload = (payload) =>
  isPlainObject(payload) && isValidChannelId(payload.channelId) ? payload : null;

/**
 * create-channel and join-channel: (channelId, deviceId, options). The deviceId argument is
 * ignored: a connection acts for its own device only.
 *
 * @returns { channelId, displayName, accessToken }, or { error } for a room id that isn't a code
 */
export const parseRoomRequest = (channelId, options) => {
  if (!isValidChannelId(channelId)) return { error: "invalid_channel_id" };
  const { displayName, accessToken } = isPlainObject(options) ? options : {};
  return {
    channelId,
    displayName: typeof displayName === "string" ? displayName : undefined,
    accessToken: typeof accessToken === "string" ? accessToken : undefined,
  };
};

// leave-channel: (channelId, { isQuitting }); the room only counts when the device is in none
export const parseLeave = (channelId, options) => ({
  channelId: isValidChannelId(channelId) ? channelId : undefined,
  isQuitting: isPlainObject(options) && Boolean(options.isQuitting),
});

export const parseChannelOnly = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && { channelId: parsed.channelId };
};

export const parseRemoveDevice = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && isValidDeviceId(parsed.targetDeviceId)
    ? { channelId: parsed.channelId, targetDeviceId: parsed.targetDeviceId }
    : null;
};

export const parseDeviceStatus = (status) => ({
  isActive: isPlainObject(status) && Boolean(status.isActive),
});

export const parseLocaleChange = (payload) =>
  isPlainObject(payload) && typeof payload.locale === "string" ? { locale: payload.locale } : null;

export const parseVote = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed &&
    Array.isArray(parsed.categories) &&
    parsed.categories.length <= MAX_VOTED_CATEGORIES
    ? { channelId: parsed.channelId, categories: parsed.categories }
    : null;
};

export const parseReadyState = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && { channelId: parsed.channelId, isReady: Boolean(parsed.isReady) };
};

// update-game-settings and start-game: the settings themselves are the game's to check
export const parseSettings = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && { channelId: parsed.channelId, settings: parsed.settings };
};

// load-questions: the questions themselves are the game's to check
export const parseLoadQuestions = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && { channelId: parsed.channelId, questions: parsed.questions };
};

export const parseAnswerSelection = (payload) => {
  const parsed = parseChannelPayload(payload);
  return parsed && isIndex(parsed.questionIndex, MAX_QUESTION_INDEX)
    ? { channelId: parsed.channelId, questionIndex: parsed.questionIndex }
    : null;
};

// submit-answer: answerIndex -1 is no answer (the time ran out before the player picked one)
export const parseAnswer = (payload) => {
  const parsed = parseChannelPayload(payload);
  if (
    !parsed ||
    !isIndex(parsed.questionIndex, MAX_QUESTION_INDEX) ||
    !(parsed.answerIndex === -1 || isIndex(parsed.answerIndex, MAX_ANSWER_INDEX))
  ) {
    return null;
  }
  const { timeSpent } = parsed;
  return {
    channelId: parsed.channelId,
    questionIndex: parsed.questionIndex,
    answerIndex: parsed.answerIndex,
    timeSpent: Number.isFinite(timeSpent)
      ? Math.min(Math.max(timeSpent, 0), MAX_TIME_SPENT_SECONDS)
      : 0,
  };
};

export const parsePowerUp = (payload) => {
  const parsed = parseChannelPayload(payload);
  if (
    !parsed ||
    typeof parsed.powerUpId !== "string" ||
    parsed.powerUpId.length > MAX_POWER_UP_ID_LENGTH
  ) {
    return null;
  }
  return {
    channelId: parsed.channelId,
    powerUpId: parsed.powerUpId,
    targetDeviceId: isValidDeviceId(parsed.targetDeviceId) ? parsed.targetDeviceId : undefined,
  };
};
