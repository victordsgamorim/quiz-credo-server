import {
  BONUS_POWER_UP,
  BREAK_POWER_UP,
  FREEZE_POWER_UP,
  STEAL_POWER_UP,
  getPowerUpSettings,
  isAttackBlocked,
} from "./powerUps.js";

// Streak multiplier: same rules as src/lib/scoring.ts in the frontend (quiz-credo), keep both in sync.
// A player's correct answers in a row reach the game's streakThreshold setting: x1.5, then +0.5 per
// further correct answer in a row, up to x3. A wrong (or missing) answer starts the streak again.
export const STREAK_THRESHOLD_LIMITS = { min: 1, max: 10 };
const MAX_STREAK_MULTIPLIER = 3;
const STREAK_MULTIPLIER_STEP = 0.5;

// Every device's points so far, replaying the game's answers, bonuses and steals in the order they
// happened (a steal can take points a bonus gave). A steal takes the game's stealPoints, or all the
// target has when that's less, so nobody goes below zero; a steal the target's shield blocks takes
// nothing. Replaying the whole game keeps it right when a later shield undoes a steal: the steals
// after it are worked out again. It also tells when each device's points last changed: on equal
// points, the ranking keeps the one who got there first ahead.
export const replayScores = (channel) => {
  const { gameState } = channel;
  const { stealPoints, bonusPoints } = getPowerUpSettings(channel);
  const events = [];
  gameState.answers.forEach((answers, deviceId) => {
    answers.forEach((answer) =>
      events.push({ timestamp: answer.timestamp, deviceId, points: answer.points })
    );
  });
  (gameState.powerUps || []).forEach((use) => {
    if (use.powerUpId === STEAL_POWER_UP) {
      events.push({ timestamp: use.timestamp, steal: use });
    } else if (use.powerUpId === BONUS_POWER_UP) {
      events.push({ timestamp: use.timestamp, deviceId: use.deviceId, points: bonusPoints });
    }
  });
  events.sort((a, b) => a.timestamp - b.timestamp);

  const scores = new Map();
  const stolenPoints = new Map(); // steal -> points it took
  const changedAt = new Map(); // deviceId -> when its points last changed
  const scoreOf = (deviceId) => scores.get(deviceId) || 0;
  const addPoints = (deviceId, points, timestamp) => {
    scores.set(deviceId, scoreOf(deviceId) + points);
    if (points !== 0) changedAt.set(deviceId, timestamp);
  };

  events.forEach(({ timestamp, deviceId, points, steal }) => {
    if (!steal) {
      addPoints(deviceId, points, timestamp);
      return;
    }
    const isBlocked = isAttackBlocked(gameState.powerUps, steal);
    const taken = isBlocked ? 0 : Math.min(stealPoints, Math.max(0, scoreOf(steal.targetDeviceId)));
    addPoints(steal.targetDeviceId, -taken, timestamp);
    addPoints(steal.deviceId, taken, timestamp);
    stolenPoints.set(steal, taken);
  });

  return { scores, stolenPoints, changedAt };
};

const getStreakMultiplier = (streak, threshold) => {
  if (streak < threshold) return 1;
  const steps = streak - threshold + 1;
  return Math.min(MAX_STREAK_MULTIPLIER, 1 + steps * STREAK_MULTIPLIER_STEP);
};

// Questions a device's streak is frozen on: each question it used Freeze on, and the ones after it,
// freezeQuestions in all
const getFrozenQuestions = (powerUps, deviceId, freezeQuestions) => {
  const frozen = new Set();
  (powerUps || [])
    .filter((use) => use.deviceId === deviceId && use.powerUpId === FREEZE_POWER_UP)
    .forEach((use) => {
      for (let offset = 0; offset < freezeQuestions; offset++) {
        frozen.add(use.questionIndex + offset);
      }
    });
  return frozen;
};

// The question a device's streak counts from: the last one up to questionIndex that a Break hit
// them on (the shield blocks it; Freeze doesn't), or the first question
const getStreakStart = (powerUps, deviceId, questionIndex) =>
  (powerUps || [])
    .filter(
      (use) =>
        use.powerUpId === BREAK_POWER_UP &&
        use.targetDeviceId === deviceId &&
        use.questionIndex <= questionIndex &&
        !isAttackBlocked(powerUps, use)
    )
    .reduce((start, use) => Math.max(start, use.questionIndex), 0);

// What changes a device's streak on a question: Freeze and Break
const getStreakRules = (channel, deviceId, questionIndex) => ({
  frozenQuestions: getFrozenQuestions(
    channel.gameState.powerUps,
    deviceId,
    getPowerUpSettings(channel).freezeQuestions
  ),
  streakStart: getStreakStart(channel.gameState.powerUps, deviceId, questionIndex),
});

// Correct answers in a row right before the question, since streakStart (a Break resets it); a
// question without an answer, or with a wrong one, breaks the streak, unless the streak was frozen
// on it (then it neither breaks nor adds)
const countStreakBefore = (
  deviceAnswers,
  questionIndex,
  { frozenQuestions = new Set(), streakStart = 0 } = {}
) => {
  let streak = 0;
  for (let index = questionIndex - 1; index >= streakStart; index--) {
    const answer = deviceAnswers.find((a) => a.questionIndex === index);
    if (answer?.isCorrect) {
      streak++;
    } else if (!frozenQuestions.has(index)) {
      break;
    }
  }
  return streak;
};

// Multiplier a device earned for a question. Without streakThreshold (older frontend) there is none,
// so the ranking matches the scores those frontends show.
const getAnswerMultiplier = (gameSettings, deviceAnswers, questionIndex, streakRules) => {
  const threshold = gameSettings?.streakThreshold;
  if (typeof threshold !== "number") return 1;
  return getStreakMultiplier(
    countStreakBefore(deviceAnswers, questionIndex, streakRules),
    threshold
  );
};

// A device's answer to a question of the game: whether it's right, and the points it earns, times
// the multiplier of the device's own streak
export const scoreAnswer = (channel, deviceId, { questionIndex, answerIndex, timeSpent }) => {
  const question = channel.gameState.questions[questionIndex];
  const isCorrect = answerIndex === question.correctAnswer;
  const multiplier = getAnswerMultiplier(
    channel.gameSettings,
    channel.gameState.answers.get(deviceId) || [],
    questionIndex,
    getStreakRules(channel, deviceId, questionIndex)
  );
  return {
    questionIndex,
    answerIndex,
    timeSpent,
    isCorrect,
    points: isCorrect ? Math.round(question.points * multiplier) : 0,
    multiplier,
    timestamp: Date.now(),
  };
};
