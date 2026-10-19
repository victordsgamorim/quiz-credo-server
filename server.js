import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import os from "os";
import { randomInt } from "crypto";

const app = express();
const httpServer = createServer(app);

app.use(cors());

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",")
  : ["http://localhost:3001", "http://localhost:5173", "http://127.0.0.1:5173"];

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ["websocket", "polling"],
});

const MAX_CATEGORY_SELECTIONS = 5;

// Streak multiplier: same rules as src/lib/scoring.ts in the frontend (quiz-credo), keep both in sync.
// A player's correct answers in a row reach the game's streakThreshold setting: x1.5, then +0.5 per
// further correct answer in a row, up to x3. A wrong (or missing) answer starts the streak again.
const STREAK_THRESHOLD_LIMITS = { min: 1, max: 10 };
const MAX_STREAK_MULTIPLIER = 3;
const STREAK_MULTIPLIER_STEP = 0.5;

const channels = new Map(); // channelId -> { adminId: string, devices: Set<string>, votes: Map<string, Set<string>>, isVotingClosed: boolean, gameSettings: GameSettings }
const connectedDevices = new Map(); // deviceId -> device info
const socketToDevice = new Map();

/**
 * Validates game settings object
 */
const validateGameSettings = (settings) => {
  if (!settings || typeof settings !== "object") {
    return false;
  }

  const limits = {
    questionCount: { min: 10, max: 50 },
    timerDuration: { min: 60, max: 300 },
    maxCategorySelections: { min: 3, max: 10 },
    topCategoriesCount: { min: 5, max: 15 },
    lowTimeThreshold: { min: 5, max: 20 },
    criticalTimeThreshold: { min: 3, max: 10 },
  };

  // Validate timerDuration (can be null)
  if (settings.timerDuration !== null && typeof settings.timerDuration !== "number") {
    return false;
  }

  if (
    settings.timerDuration !== null &&
    (settings.timerDuration < limits.timerDuration.min ||
      settings.timerDuration > limits.timerDuration.max)
  ) {
    return false;
  }

  // Validate other numeric fields
  for (const [key, limit] of Object.entries(limits)) {
    if (key === "timerDuration") continue; // Already validated

    const value = settings[key];
    if (typeof value !== "number" || value < limit.min || value > limit.max) {
      console.warn(`Invalid game setting ${key}: ${value} (expected ${limit.min}-${limit.max})`);
      return false;
    }
  }

  // Optional: frontends from before the power-ups dialog don't send it
  if (settings.powerUps !== undefined && !isValidPowerUpSettings(settings.powerUps)) {
    console.warn("Invalid game setting powerUps:", settings.powerUps);
    return false;
  }

  // Optional: frontends from before the streak multiplier don't send it
  if (settings.streakThreshold !== undefined) {
    const { min, max } = STREAK_THRESHOLD_LIMITS;
    const value = settings.streakThreshold;
    if (typeof value !== "number" || value < min || value > max) {
      console.warn(`Invalid game setting streakThreshold: ${value} (expected ${min}-${max})`);
      return false;
    }
  }

  return true;
};

// Power-ups: same ids and kinds as src/components/quiz/powerUps.tsx in the frontend (quiz-credo),
// keep both in sync. A disadvantage ("attack") is used on another player of the game; an advantage
// ("boost") acts on the player who uses it. Each one works once per game, and one per question.
const POWER_UP_KINDS = {
  freeze: "boost",
  steal: "attack",
  shield: "boost",
  break: "attack",
  bonus: "boost",
};
const SHIELD_POWER_UP = "shield";
const STEAL_POWER_UP = "steal";
const FREEZE_POWER_UP = "freeze";
const BREAK_POWER_UP = "break";
const BONUS_POWER_UP = "bonus";
// The admin's power-up settings (the power-ups dialog), inside the game settings: same defaults
// and limits as src/types/powerUpSettings.ts in the frontend, keep both in sync.
// - isEnabled: whether the game has power-ups at all; off, nobody gets any and none can be used
// - handSize: power-ups each player gets for a game, picked at random among the enabled ones
// - enabled: which power-ups can be dealt
// - freezeQuestions: Freeze keeps the streak through wrong answers on the question it's used on
//   and the next ones, this many in all
// - stealPoints: Steal takes up to this many points from its target, never taking them below zero
// - bonusPoints: Bonus adds this many points to the player who uses it, whatever their answer
const DEFAULT_POWER_UP_SETTINGS = {
  isEnabled: true,
  handSize: 3,
  enabled: { freeze: true, steal: true, shield: true, break: true, bonus: true },
  freezeQuestions: 2,
  stealPoints: 30,
  bonusPoints: 60,
};
const POWER_UP_SETTINGS_LIMITS = {
  handSize: { min: 1, max: 5 },
  freezeQuestions: { min: 1, max: 5 },
  stealPoints: { min: 10, max: 100 },
  bonusPoints: { min: 10, max: 200 },
};

const isValidPowerUpSettings = (settings) => {
  if (!settings || typeof settings !== "object") return false;
  const { enabled } = settings;
  if (!enabled || typeof enabled !== "object") return false;
  return (
    typeof settings.isEnabled === "boolean" &&
    Object.keys(POWER_UP_KINDS).every((id) => typeof enabled[id] === "boolean") &&
    Object.entries(POWER_UP_SETTINGS_LIMITS).every(([key, { min, max }]) => {
      const value = settings[key];
      return Number.isInteger(value) && value >= min && value <= max;
    })
  );
};

// The power-up settings a channel's game plays with: the admin's, or the defaults (settings from
// before the power-ups dialog, or none)
const getPowerUpSettings = (channel) =>
  isValidPowerUpSettings(channel.gameSettings?.powerUps)
    ? channel.gameSettings.powerUps
    : DEFAULT_POWER_UP_SETTINGS;

// The players of a game: the guests, and the admin when debug mode lets them answer
const isGamePlayer = (channel, device) =>
  Boolean(device) &&
  channel.devices.has(device.id) &&
  (device.role === "guest" ||
    (device.role === "admin" && Boolean(channel.gameSettings?.enableDebugMode)));

// The shield blocks every disadvantage used on its owner during the question it was used on,
// whether the disadvantage came before or after it
const isAttackBlocked = (powerUps, attack) =>
  powerUps.some(
    (use) =>
      use.powerUpId === SHIELD_POWER_UP &&
      use.deviceId === attack.targetDeviceId &&
      use.questionIndex === attack.questionIndex
  );

const isQuestionTimeUp = (channel) =>
  channel.gameSettings?.timerDuration !== null && channel.gameState.timerRemaining <= 0;

// Why a device can't use a power-up now, or null when it can
const getPowerUpRejection = (channel, device, { powerUpId, targetDeviceId }) => {
  const { gameState } = channel;
  const questionIndex = gameState.currentQuestionIndex;

  if (typeof powerUpId !== "string" || !Object.hasOwn(POWER_UP_KINDS, powerUpId)) {
    return "unknown_power_up";
  }
  if (!isGamePlayer(channel, device)) return "not_a_player";
  if (!getPowerUpSettings(channel).isEnabled) return "power_ups_off";
  if (!getPowerUpHand(channel, device.id).includes(powerUpId)) return "not_in_hand";
  if (gameState.isShowingResults || questionIndex >= gameState.questions.length) {
    return "no_question";
  }
  const hasAnswered = (gameState.answers.get(device.id) || []).some(
    (answer) => answer.questionIndex === questionIndex
  );
  if (hasAnswered || isQuestionTimeUp(channel)) return "question_locked";

  const ownUses = gameState.powerUps.filter((use) => use.deviceId === device.id);
  if (ownUses.some((use) => use.powerUpId === powerUpId)) return "already_used";
  if (ownUses.some((use) => use.questionIndex === questionIndex)) return "one_per_question";

  if (POWER_UP_KINDS[powerUpId] === "attack") {
    const target = typeof targetDeviceId === "string" ? connectedDevices.get(targetDeviceId) : null;
    if (targetDeviceId === device.id || !isGamePlayer(channel, target)) return "invalid_target";
  }
  return null;
};

// Deals a hand of handSize power-ups among the enabled ones (the power-up settings), or none when
// the game's power-ups are off. Each one is
// picked at random among those dealt the fewest times in the room's game so far (dealtCounts), so
// the power-ups spread over the players instead of everyone getting the same ones; the hand comes
// in a random order, the bar's order.
const dealPowerUps = (dealtCounts, { isEnabled, handSize, enabled }) => {
  if (!isEnabled) return [];
  const left = Object.keys(POWER_UP_KINDS).filter((id) => enabled[id]);
  const hand = [];
  while (hand.length < handSize && left.length > 0) {
    const fewest = Math.min(...left.map((id) => dealtCounts.get(id) || 0));
    const candidates = left.filter((id) => (dealtCounts.get(id) || 0) === fewest);
    const id = candidates[randomInt(candidates.length)];
    hand.push(id);
    left.splice(left.indexOf(id), 1);
  }
  // Shuffled, so the power-ups dealt last don't always sit at the end of the bar
  for (let index = hand.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [hand[index], hand[other]] = [hand[other], hand[index]];
  }
  return hand;
};

// The device's hand for the current game, dealt the first time it's asked for
const getPowerUpHand = (channel, deviceId) => {
  const { gameState } = channel;
  gameState.powerUpHands = gameState.powerUpHands || new Map();
  if (!gameState.powerUpHands.has(deviceId)) {
    const dealtCounts = new Map();
    gameState.powerUpHands.forEach((hand) =>
      hand.forEach((id) => dealtCounts.set(id, (dealtCounts.get(id) || 0) + 1))
    );
    gameState.powerUpHands.set(deviceId, dealPowerUps(dealtCounts, getPowerUpSettings(channel)));
  }
  return gameState.powerUpHands.get(deviceId);
};

// Sends a player of the game their hand
const emitPowerUpHand = (channel, deviceId) => {
  const device = connectedDevices.get(deviceId);
  if (!device?.socketId || !isGamePlayer(channel, device)) return;
  io.to(device.socketId).emit("power-up-hand", {
    powerUpIds: getPowerUpHand(channel, deviceId),
  });
};

const toPowerUpPlayer = (deviceId) => {
  const device = connectedDevices.get(deviceId);
  return { id: deviceId, name: device?.displayName || deviceId };
};

// Every device's points so far, replaying the game's answers, bonuses and steals in the order they
// happened (a steal can take points a bonus gave). A steal takes the game's stealPoints, or all the
// target has when that's less, so nobody goes below zero; a steal the target's shield blocks takes
// nothing. Replaying the whole game keeps it right when a later shield undoes a steal: the steals
// after it are worked out again.
const replayScores = (channel) => {
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
  const scoreOf = (deviceId) => scores.get(deviceId) || 0;

  events.forEach(({ deviceId, points, steal }) => {
    if (!steal) {
      scores.set(deviceId, scoreOf(deviceId) + points);
      return;
    }
    const isBlocked = isAttackBlocked(gameState.powerUps, steal);
    const taken = isBlocked ? 0 : Math.min(stealPoints, Math.max(0, scoreOf(steal.targetDeviceId)));
    scores.set(steal.targetDeviceId, scoreOf(steal.targetDeviceId) - taken);
    scores.set(steal.deviceId, scoreOf(steal.deviceId) + taken);
    stolenPoints.set(steal, taken);
  });

  return { scores, stolenPoints };
};

// Tells the attacker and the target how each disadvantage of the question turned out, when it's
// new or it changed: a later shield blocks it, or undoing a steal changes what a later one took
const emitPowerUpOutcomes = (channel, questionIndex) => {
  const { gameState } = channel;
  const { stolenPoints } = replayScores(channel);

  gameState.powerUps
    .filter((use) => use.targetDeviceId && use.questionIndex === questionIndex)
    .forEach((attack) => {
      const outcome = {
        questionIndex,
        powerUpId: attack.powerUpId,
        attacker: toPowerUpPlayer(attack.deviceId),
        target: toPowerUpPlayer(attack.targetDeviceId),
        isBlocked: isAttackBlocked(gameState.powerUps, attack),
        ...(stolenPoints.has(attack) ? { points: stolenPoints.get(attack) } : {}),
      };
      const key = `${outcome.isBlocked}:${outcome.points ?? ""}`;
      if (attack.lastOutcomeKey === key) return;
      attack.lastOutcomeKey = key;

      [attack.deviceId, attack.targetDeviceId].forEach((deviceId) => {
        const socketId = connectedDevices.get(deviceId)?.socketId;
        if (socketId) io.to(socketId).emit("power-up-outcome", outcome);
      });
    });
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

const buildDevicePayload = (device) => ({
  id: device.id,
  connectedAt: device.connectedAt,
  channel: device.channel,
  isActive: device.isActive,
  socketId: device.socketId,
  role: device.role || "guest",
  displayName: device.displayName || device.id,
  isReady: Boolean(device.isReady),
  locale: device.locale || "pt-BR",
});

const getAnsweredGuestsCount = (channel, questionIndex) => {
  if (!channel || !channel.gameState || !channel.gameState.answers) {
    return { answeredCount: 0, totalGuests: 0 };
  }

  let answeredCount = 0;
  let totalGuests = 0;

  // Contar total de guests no canal
  Array.from(channel.devices || []).forEach((deviceId) => {
    const device = connectedDevices.get(deviceId);
    if (device && device.role === "guest") {
      totalGuests++;

      // Verificar se este guest respondeu a pergunta atual
      const deviceAnswers = channel.gameState.answers.get(deviceId) || [];
      const hasAnswered = deviceAnswers.some((a) => a.questionIndex === questionIndex);
      if (hasAnswered) {
        answeredCount++;
      }
    }
  });

  return { answeredCount, totalGuests };
};

const sanitizeCategoryName = (name) => {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim().substring(0, 50);
};

const getChannelDevices = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return [];
  }

  return Array.from(channel.devices || [])
    .map((id) => connectedDevices.get(id))
    .filter((device) => device != null)
    .map(buildDevicePayload);
};

const getCategoryTotals = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel || !channel.votes) {
    return [];
  }

  const counts = new Map();
  channel.votes.forEach((selection) => {
    selection.forEach((category) => {
      const key = sanitizeCategoryName(category);
      if (!key) {
        return;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .map(([name, votes]) => ({ name, votes }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }
      return a.name.localeCompare(b.name);
    });
};

const getChannelState = (channelId) => {
  const devices = getChannelDevices(channelId);
  const channel = channels.get(channelId);
  const categoryTotals = getCategoryTotals(channelId).slice(0, 10);

  const answerStats = channel?.gameState
    ? getAnsweredGuestsCount(channel, channel.gameState.currentQuestionIndex)
    : { answeredCount: 0, totalGuests: 0 };

  const selectedGuestsCount = channel?.gameState?.guestSelections?.size || 0;

  return {
    channelId,
    devices,
    totalDevices: devices.length,
    adminId: channel?.adminId || null,
    categoryTotals,
    maxCategorySelections: channel?.gameSettings?.maxCategorySelections || MAX_CATEGORY_SELECTIONS,
    gameSettings: channel?.gameSettings || null,
    isVotingClosed: Boolean(channel?.isVotingClosed),
    isGameStarted: Boolean(channel?.isGameStarted),
    gameState: channel?.gameState
      ? {
          questions: channel.gameState.questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options,
            difficulty: q.difficulty,
            points: q.points,
            category: q.category,
            correctAnswer: q.correctAnswer,
          })),
          currentQuestionIndex: channel.gameState.currentQuestionIndex,
          timerRemaining: channel.gameState.timerRemaining,
          isShowingResults: channel.gameState.isShowingResults,
          answeredGuestsCount: answerStats.answeredCount,
          totalGuests: answerStats.totalGuests,
          selectedGuestsCount,
        }
      : null,
  };
};

const broadcastChannelUpdate = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel) return;

  // If multilingual questions exist, send personalized updates to each device
  if (channel.gameState?.questionsByLocale) {
    console.log(`[${new Date().toISOString()}] Broadcasting multilingual questions to channel ${channelId}`);
    const devices = Array.from(channel.devices || []);
    devices.forEach((deviceId) => {
      const device = connectedDevices.get(deviceId);
      if (device && device.socketId) {
        const deviceLocale = device.locale || "pt-BR";
        console.log(`  - Sending ${deviceLocale} questions to device ${deviceId}`);
        const personalizedState = getChannelStateForLocale(channelId, deviceLocale);
        const socket = io.sockets.sockets.get(device.socketId);
        if (socket) {
          socket.emit("channel-update", personalizedState);
        }
      }
    });
  } else {
    // Legacy: broadcast same state to all
    console.log(`[${new Date().toISOString()}] Broadcasting same state to all devices in channel ${channelId}`);
    io.to(channelId).emit("channel-update", getChannelState(channelId));
  }
};

const getChannelStateForLocale = (channelId, locale) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return null;
  }

  const devices = getChannelDevices(channelId);
  const categoryTotals = getCategoryTotals(channelId);

  // Get questions for the specific locale
  const questionsForLocale =
    channel.gameState?.questionsByLocale?.[locale] || channel.gameState?.questions || [];

  const answerStats = channel?.gameState
    ? getAnsweredGuestsCount(channel, channel.gameState.currentQuestionIndex)
    : { answeredCount: 0, totalGuests: 0 };

  const selectedGuestsCount = channel?.gameState?.guestSelections?.size || 0;

  return {
    channelId,
    devices,
    totalDevices: devices.length,
    adminId: channel.adminId,
    categoryTotals,
    maxCategorySelections: channel.gameSettings?.maxCategorySelections || MAX_CATEGORY_SELECTIONS,
    gameSettings: channel.gameSettings || null,
    isVotingClosed: Boolean(channel?.isVotingClosed),
    isGameStarted: Boolean(channel?.isGameStarted),
    gameState: channel?.gameState
      ? {
          questions: questionsForLocale.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options,
            difficulty: q.difficulty,
            points: q.points,
            category: q.category,
            correctAnswer: q.correctAnswer,
          })),
          currentQuestionIndex: channel.gameState.currentQuestionIndex,
          timerRemaining: channel.gameState.timerRemaining,
          isShowingResults: channel.gameState.isShowingResults,
          answeredGuestsCount: answerStats.answeredCount,
          totalGuests: answerStats.totalGuests,
          selectedGuestsCount,
        }
      : null,
  };
};

const removeDeviceFromChannel = (deviceId, reason, options = {}) => {
  const device = connectedDevices.get(deviceId);
  if (!device || !device.channel) {
    return;
  }

  const channelId = device.channel;
  const channel = channels.get(channelId);
  if (!channel) {
    device.channel = null;
    device.role = "guest";
    return;
  }

  channel.devices.delete(deviceId);
  channel.votes?.delete(deviceId);
  device.channel = null;
  device.role = "guest";
  device.isReady = false;

  const socketInstance = io.sockets.sockets.get(device.socketId);
  if (socketInstance) {
    socketInstance.leave(channelId);
  }

  if (reason && device.socketId) {
    io.to(device.socketId).emit("force-leave-channel", {
      channelId,
      reason,
    });
  }

  if (channel.devices.size === 0) {
    channels.delete(channelId);
  } else if (!options.suppressUpdate) {
    broadcastChannelUpdate(channelId);
  }
};

const forceCloseChannel = (channelId, reason, { notifyAdmin = false } = {}) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Force closing channel ${channelId} (reason: ${reason})`
  );

  // Limpar timer do jogo se existir
  if (channel.gameState?.timerInterval) {
    clearInterval(channel.gameState.timerInterval);
  }

  const members = Array.from(channel.devices);

  members.forEach((deviceId) => {
    const shouldNotify = deviceId === channel.adminId ? notifyAdmin : true;
    removeDeviceFromChannel(deviceId, shouldNotify ? reason : undefined, { suppressUpdate: true });
  });

  channels.delete(channelId);
};

const startQuestionTimer = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel || !channel.gameState) return;

  // Limpar timer anterior se existir
  if (channel.gameState.timerInterval) {
    clearInterval(channel.gameState.timerInterval);
  }

  // Se timerDuration é null, não iniciar timer (sem limite de tempo)
  const timerDuration = channel.gameSettings?.timerDuration;
  if (timerDuration === null) {
    console.log(`[${new Date().toISOString()}] No timer for channel ${channelId} (unlimited time)`);
    return;
  }

  // Timer de 1 segundo
  channel.gameState.timerInterval = setInterval(() => {
    if (!channels.has(channelId)) {
      clearInterval(channel.gameState.timerInterval);
      return;
    }

    const currentChannel = channels.get(channelId);
    if (currentChannel.gameState.timerRemaining > 0) {
      currentChannel.gameState.timerRemaining--;
      broadcastChannelUpdate(channelId);
    } else {
      // Timer expirou
      clearInterval(currentChannel.gameState.timerInterval);
      currentChannel.gameState.timerInterval = null;

      // Emitir evento de timeout
      io.to(channelId).emit("question-timeout", {
        questionIndex: currentChannel.gameState.currentQuestionIndex,
      });
    }
  }, 1000);
};

const calculateRanking = (channel) => {
  const ranking = [];
  // The answers' points, with the steals taken out of and given to each device
  const { scores } = replayScores(channel);

  console.log(
    `[${new Date().toISOString()}] Calculating ranking for ${channel.gameState.answers.size} devices`
  );

  channel.gameState.answers.forEach((answers, deviceId) => {
    const device = connectedDevices.get(deviceId);
    if (!device) {
      console.warn(`Device ${deviceId} not found in connectedDevices`);
      return;
    }

    const totalPoints = scores.get(deviceId) || 0;
    const correctAnswers = answers.filter((a) => a.isCorrect).length;
    const totalAnswers = answers.length;
    const accuracy = totalAnswers > 0 ? (correctAnswers / totalAnswers) * 100 : 0;

    console.log(
      `  ${device.displayName} (${device.role}): ${totalPoints} pts, ${correctAnswers}/${totalAnswers} correct`
    );

    ranking.push({
      deviceId,
      displayName: device.displayName,
      role: device.role,
      totalPoints,
      correctAnswers,
      totalAnswers,
      accuracy: Math.round(accuracy),
    });
  });

  // Ordenar por pontos (maior para menor)
  ranking.sort((a, b) => b.totalPoints - a.totalPoints);

  // Adicionar posição
  ranking.forEach((entry, index) => {
    entry.position = index + 1;
  });

  console.log(`[${new Date().toISOString()}] Final ranking:`, JSON.stringify(ranking, null, 2));

  return ranking;
};

io.on("connection", (socket) => {
  const persistentDeviceId = socket.handshake.auth.deviceId || socket.id;
  const deviceLocale = socket.handshake.auth.locale || "pt-BR";

  console.log(
    `[${new Date().toISOString()}] Device connected: ${persistentDeviceId} (socket: ${socket.id}, locale: ${deviceLocale})`
  );

  socketToDevice.set(socket.id, persistentDeviceId);

  connectedDevices.set(persistentDeviceId, {
    id: persistentDeviceId,
    socketId: socket.id,
    connectedAt: Date.now(),
    channel: null,
    isActive: true,
    role: "guest",
    displayName: null,
    isReady: false,
    locale: deviceLocale,
  });

  socket.on("create-channel", (channelId, deviceId, options = {}) => {
    const actualDeviceId = deviceId || persistentDeviceId;
    console.log(
      `[${new Date().toISOString()}] Device ${actualDeviceId} creating channel: ${channelId}`
    );

    const device = connectedDevices.get(actualDeviceId);
    if (!device) {
      console.warn(
        `[${new Date().toISOString()}] Unknown device tried to create channel: ${actualDeviceId}`
      );
      socket.emit("channel-error", { error: "device_not_found" });
      return;
    }

    // Check if channel already exists
    if (channels.has(channelId)) {
      console.warn(`[${new Date().toISOString()}] Channel ${channelId} already exists`);
      socket.emit("channel-error", { error: "channel_already_exists" });
      return;
    }

    const { displayName } = options || {};
    if (displayName && typeof displayName === "string") {
      device.displayName = displayName.trim().substring(0, 50);
    }

    // Create new channel
    const channel = {
      adminId: actualDeviceId,
      devices: new Set(),
      votes: new Map(),
      isVotingClosed: false,
      isGameStarted: false,
      gameState: {
        questions: [],
        currentQuestionIndex: 0,
        questionStartTime: null,
        timerRemaining: 60,
        timerInterval: null,
        answers: new Map(),
        powerUps: [],
        powerUpHands: new Map(),
        isShowingResults: false,
      },
    };
    channels.set(channelId, channel);

    channel.devices.add(actualDeviceId);
    device.channel = channelId;
    device.socketId = socket.id;
    device.role = "admin";
    device.isReady = false;

    socket.join(channelId);

    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} created with admin ${actualDeviceId}`
    );

    const deviceLocale = device.locale || "pt-BR";
    socket.emit("joined-channel", getChannelStateForLocale(channelId, deviceLocale));
  });

  socket.on("join-channel", (channelId, deviceId, options = {}) => {
    const actualDeviceId = deviceId || persistentDeviceId;
    console.log(
      `[${new Date().toISOString()}] Device ${actualDeviceId} joining channel: ${channelId}`
    );

    const device = connectedDevices.get(actualDeviceId);
    if (!device) {
      console.warn(`[${new Date().toISOString()}] Unknown device tried to join: ${actualDeviceId}`);
      socket.emit("channel-error", { error: "device_not_found" });
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      console.warn(`[${new Date().toISOString()}] Channel ${channelId} does not exist`);
      socket.emit("channel-error", { error: "channel_not_found" });
      return;
    }

    const { displayName } = options || {};
    if (displayName && typeof displayName === "string") {
      device.displayName = displayName.trim().substring(0, 50);
    }

    channel.votes = channel.votes || new Map();
    channel.isVotingClosed = Boolean(channel.isVotingClosed);
    channel.isGameStarted = Boolean(channel.isGameStarted);

    channel.devices.add(actualDeviceId);
    device.channel = channelId;
    device.socketId = socket.id;
    device.role = channel.adminId === actualDeviceId ? "admin" : "guest";
    device.isReady = false;

    socket.join(channelId);

    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} now has ${channel.devices.size} devices:`,
      Array.from(channel.devices).map(
        (id) => `${id} (${connectedDevices.get(id)?.role || "guest"})`
      )
    );

    broadcastChannelUpdate(channelId);

    const deviceLocale = device.locale || "pt-BR";
    socket.emit("joined-channel", getChannelStateForLocale(channelId, deviceLocale));
    // Back in a game under way (a reload): the same hand as before
    if (channel.isGameStarted && channel.gameState?.questions?.length) {
      emitPowerUpHand(channel, actualDeviceId);
    }
  });

  socket.on("leave-channel", (channelId) => {
    const device = connectedDevices.get(persistentDeviceId);
    const activeChannel = device?.channel || channelId;

    if (!device || !activeChannel) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to leave but no active channel`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} leaving channel: ${activeChannel}`
    );

    const channel = channels.get(activeChannel);
    if (channel && channel.adminId === persistentDeviceId) {
      forceCloseChannel(activeChannel, "admin_left");
    } else {
      removeDeviceFromChannel(persistentDeviceId);
    }
  });

  socket.on("device-status", (status) => {
    const device = connectedDevices.get(persistentDeviceId);
    if (device) {
      device.isActive = status.isActive;

      if (device.channel) {
        broadcastChannelUpdate(device.channel);
      }
    }
  });

  socket.on("update-category-vote", ({ channelId, categories }) => {
    if (!channelId || !Array.isArray(categories)) {
      return;
    }

    const device = connectedDevices.get(persistentDeviceId);
    if (!device || device.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} attempted category vote without channel`
      );
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }

    if (channel.isVotingClosed) {
      console.warn(
        `[${new Date().toISOString()}] Vote ignored because channel ${channelId} voting closed`
      );
      return;
    }

    const sanitizedSelections = [];
    const used = new Set();

    for (const rawCategory of categories) {
      if (sanitizedSelections.length >= MAX_CATEGORY_SELECTIONS) {
        break;
      }
      const cleanName = sanitizeCategoryName(rawCategory);
      if (!cleanName || used.has(cleanName)) {
        continue;
      }
      sanitizedSelections.push(cleanName);
      used.add(cleanName);
    }

    channel.votes = channel.votes || new Map();
    channel.votes.set(persistentDeviceId, new Set(sanitizedSelections));
    broadcastChannelUpdate(channelId);
  });

  socket.on("update-ready-state", ({ channelId, isReady }) => {
    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} updating ready state to ${isReady} in channel ${channelId}`
    );

    if (!channelId) {
      console.warn(`[${new Date().toISOString()}] No channelId provided`);
      return;
    }

    const device = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!device || !channel || device.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid device or channel state for ${persistentDeviceId}`
      );
      return;
    }

    if (channel.isGameStarted) {
      console.warn(`[${new Date().toISOString()}] Game already started, cannot update ready state`);
      return;
    }

    device.isReady = Boolean(isReady);
    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} (${device.displayName}) is now ${device.isReady ? "READY" : "NOT READY"}`
    );
    broadcastChannelUpdate(channelId);
  });

  socket.on("close-category-vote", ({ channelId }) => {
    if (!channelId) {
      return;
    }

    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid close-category-vote attempt by ${persistentDeviceId}`
      );
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to close voting without admin role`
      );
      return;
    }

    if (channel.isVotingClosed) {
      return;
    }

    channel.isVotingClosed = true;
    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} voting closed by admin ${persistentDeviceId}`
    );
    broadcastChannelUpdate(channelId);
  });

  socket.on("start-game", ({ channelId, settings }) => {
    if (!channelId) {
      return;
    }
    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to start game without admin role`
      );
      return;
    }

    const devices = getChannelDevices(channelId);
    const guestDevices = devices.filter((device) => device.role === "guest");
    // Debug mode lets the admin start and play alone, without guests
    const isDebugMode = Boolean(settings?.enableDebugMode) && validateGameSettings(settings);
    if (isDebugMode) {
      console.log(
        `[${new Date().toISOString()}] Admin ${persistentDeviceId} starting game in debug mode (guest checks skipped)`
      );
    }
    if (!isDebugMode && guestDevices.length === 0) {
      console.warn(
        `[${new Date().toISOString()}] Admin ${persistentDeviceId} tried to start game without any guests`
      );
      return;
    }
    const allGuestsReady = guestDevices.every((device) => device.isReady);
    if (!isDebugMode && !allGuestsReady) {
      console.warn(
        `[${new Date().toISOString()}] Admin ${persistentDeviceId} tried to start game but not all guests are ready`
      );
      return;
    }

    // Validate and store game settings
    if (settings && validateGameSettings(settings)) {
      channel.gameSettings = settings;
      console.log(`[${new Date().toISOString()}] Game settings configured for channel ${channelId}:`, settings);
    } else if (settings) {
      console.warn(`[${new Date().toISOString()}] Invalid game settings provided, using defaults`);
      channel.gameSettings = null;
    }

    channel.isGameStarted = true;
    io.to(channelId).emit("game-started", { channelId, devices });
    broadcastChannelUpdate(channelId);
  });

  // Update game settings in real-time (before game starts)
  socket.on("update-game-settings", ({ channelId, settings }) => {
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      console.warn(`Device ${persistentDeviceId} tried to update settings but is not in channel ${channelId}`);
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      console.warn(`Channel ${channelId} not found`);
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin ${persistentDeviceId} tried to update game settings`);
      return;
    }

    if (channel.isGameStarted) {
      console.warn(`Cannot update settings after game started in channel ${channelId}`);
      return;
    }

    // Validate and update settings
    if (settings && validateGameSettings(settings)) {
      channel.gameSettings = settings;
      console.log(`[${new Date().toISOString()}] Game settings updated for channel ${channelId}:`, settings);
      // Broadcast updated settings to all clients in the channel
      broadcastChannelUpdate(channelId);
    } else {
      console.warn(`[${new Date().toISOString()}] Invalid game settings provided:`, settings);
    }
  });

  socket.on("load-questions", (payload) => {
    const { channelId, questions } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin tried to load questions: ${persistentDeviceId}`);
      return;
    }

    if (!channel.isGameStarted) {
      console.warn(`Game not started yet`);
      return;
    }

    // Check if questions is multilingual (object with locale keys) or single locale array
    const isMultilingual =
      typeof questions === "object" &&
      !Array.isArray(questions) &&
      questions["pt-BR"] !== undefined;

    if (isMultilingual) {
      // Store multilingual questions
      channel.gameState.questionsByLocale = questions;
      // Use pt-BR as default for validation
      channel.gameState.questions = questions["pt-BR"];
      console.log(
        `Multilingual questions loaded for channel ${channelId}: ${questions["pt-BR"].length} questions`
      );
    } else {
      // Legacy: single locale questions
      channel.gameState.questions = questions;
      console.log(`Questions loaded for channel ${channelId}: ${questions.length} questions`);
    }

    channel.gameState.currentQuestionIndex = 0;
    channel.gameState.questionStartTime = Date.now();
    channel.gameState.timerRemaining = channel.gameSettings?.timerDuration || 60;
    channel.gameState.guestSelections = new Set();
    // A new game gives every power-up back, and deals each player a new hand
    channel.gameState.powerUps = [];
    channel.gameState.powerUpHands = new Map();
    channel.devices.forEach((deviceId) => emitPowerUpHand(channel, deviceId));

    // Iniciar timer sincronizado
    startQuestionTimer(channelId);

    // Broadcast estado atualizado
    broadcastChannelUpdate(channelId);
  });

  socket.on("submit-answer", (payload) => {
    const { channelId, questionIndex, answerIndex, timeSpent } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || !channel.isGameStarted) {
      return;
    }

    // Verificar se é a pergunta atual
    if (questionIndex !== channel.gameState.currentQuestionIndex) {
      console.warn(`Device ${persistentDeviceId} answered wrong question`);
      return;
    }

    // Verificar se já respondeu esta pergunta
    const deviceAnswers = channel.gameState.answers.get(persistentDeviceId) || [];
    const alreadyAnswered = deviceAnswers.some((a) => a.questionIndex === questionIndex);

    if (alreadyAnswered) {
      console.warn(
        `Device ${persistentDeviceId} already answered question ${questionIndex}`
      );
      return;
    }

    // Obter pergunta e verificar resposta
    const question = channel.gameState.questions[questionIndex];
    const isCorrect = answerIndex === question.correctAnswer;
    // Each device has its own streak, so its own multiplier
    const multiplier = getAnswerMultiplier(
      channel.gameSettings,
      deviceAnswers,
      questionIndex,
      getStreakRules(channel, persistentDeviceId, questionIndex)
    );

    // Salvar resposta
    const answerData = {
      questionIndex,
      answerIndex,
      timeSpent,
      isCorrect,
      points: isCorrect ? Math.round(question.points * multiplier) : 0,
      multiplier,
      timestamp: Date.now(),
    };

    if (!channel.gameState.answers.has(persistentDeviceId)) {
      channel.gameState.answers.set(persistentDeviceId, []);
    }
    channel.gameState.answers.get(persistentDeviceId).push(answerData);

    console.log(
      `[${new Date().toISOString()}] Device ${device.displayName} (${device.role}) answered Q${questionIndex}: ${
        isCorrect ? "CORRECT" : "WRONG"
      } (+${answerData.points} pts, x${multiplier})`
    );

    // Broadcast updated channel state to show answer count in real-time
    broadcastChannelUpdate(channelId);

    // Notificar TODOS os dispositivos do canal sobre o resultado (para sincronizar feedback)
    io.to(channelId).emit("answer-result", {
      questionIndex,
      isCorrect,
      points: answerData.points,
      deviceId: persistentDeviceId,
    });
  });

  socket.on("guest-selected-answer", (payload) => {
    const { channelId, questionIndex } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    // Only guests should send this event
    if (device.role !== "guest") {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || !channel.isGameStarted) {
      return;
    }

    // Verificar se é a pergunta atual
    if (questionIndex !== channel.gameState.currentQuestionIndex) {
      return;
    }

    // Initialize selections set if it doesn't exist
    if (!channel.gameState.guestSelections) {
      channel.gameState.guestSelections = new Set();
    }

    // Add this guest to the set of guests who have selected an answer
    // (Set automatically handles duplicates, so multiple selections don't count)
    channel.gameState.guestSelections.add(persistentDeviceId);

    console.log(
      `[${new Date().toISOString()}] Guest ${device.displayName} selected an answer for Q${questionIndex} (${channel.gameState.guestSelections.size} guests selected)`
    );

    // Broadcast updated channel state
    broadcastChannelUpdate(channelId);
  });

  socket.on("use-power-up", (payload = {}) => {
    const { channelId, powerUpId, targetDeviceId } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || !channel.isGameStarted || !channel.gameState) {
      return;
    }
    channel.gameState.powerUps = channel.gameState.powerUps || [];

    const rejection = getPowerUpRejection(channel, device, { powerUpId, targetDeviceId });
    if (rejection) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} can't use power-up ${String(powerUpId)}: ${rejection}`
      );
      return;
    }

    const questionIndex = channel.gameState.currentQuestionIndex;
    const isAttack = POWER_UP_KINDS[powerUpId] === "attack";
    const use = {
      deviceId: persistentDeviceId,
      powerUpId,
      questionIndex,
      targetDeviceId: isAttack ? targetDeviceId : null,
      timestamp: Date.now(),
    };
    channel.gameState.powerUps.push(use);

    console.log(
      `[${new Date().toISOString()}] Device ${device.displayName} used ${powerUpId} on Q${questionIndex}${
        isAttack ? ` against ${targetDeviceId}` : ""
      }`
    );

    // A disadvantage is told at once; a shield blocks the ones already used on the player too
    emitPowerUpOutcomes(channel, questionIndex);
  });

  socket.on("next-question", (payload) => {
    const { channelId } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin tried to advance question`);
      return;
    }

    if (!channel.isGameStarted) {
      return;
    }

    // Limpar timer atual
    if (channel.gameState.timerInterval) {
      clearInterval(channel.gameState.timerInterval);
      channel.gameState.timerInterval = null;
    }

    // Avançar para próxima pergunta
    channel.gameState.currentQuestionIndex++;

    // Reset guest selections for the new question
    channel.gameState.guestSelections = new Set();

    // Verificar se acabaram as perguntas
    if (
      channel.gameState.currentQuestionIndex >= channel.gameState.questions.length
    ) {
      // Jogo terminou - mostrar resultados
      channel.gameState.isShowingResults = true;

      // Calcular ranking
      const ranking = calculateRanking(channel);

      // Emitir resultados
      io.to(channelId).emit("game-finished", {
        ranking,
        totalQuestions: channel.gameState.questions.length,
      });

      console.log(`Game finished in channel ${channelId}`);
    } else {
      // Próxima pergunta
      channel.gameState.questionStartTime = Date.now();
      channel.gameState.timerRemaining = channel.gameSettings?.timerDuration || 60;

      // Reiniciar timer
      startQuestionTimer(channelId);

      console.log(
        `Channel ${channelId} advanced to question ${
          channel.gameState.currentQuestionIndex + 1
        }`
      );
    }

    // Broadcast estado atualizado
    broadcastChannelUpdate(channelId);
  });

  socket.on("reset-game", ({ channelId }) => {
    if (!channelId) {
      return;
    }
    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to reset game without admin role`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Admin ${persistentDeviceId} reset game in channel ${channelId}`
    );

    // Limpar timer se existir
    if (channel.gameState?.timerInterval) {
      clearInterval(channel.gameState.timerInterval);
    }

    // Reset game state but keep categories and ready states
    channel.isGameStarted = false;

    // Resetar estado do jogo
    channel.gameState = {
      questions: [],
      currentQuestionIndex: 0,
      questionStartTime: null,
      timerRemaining: 60,
      timerInterval: null,
      answers: new Map(),
      powerUps: [],
      powerUpHands: new Map(),
      isShowingResults: false,
    };

    // Reset all guests ready state to false so they can prepare again
    Array.from(channel.devices || []).forEach((deviceId) => {
      const device = connectedDevices.get(deviceId);
      if (device && device.role === "guest") {
        device.isReady = false;
      }
    });

    // Notify all devices in the channel to return to lobby
    io.to(channelId).emit("game-reset", { channelId });

    broadcastChannelUpdate(channelId);
  });

  socket.on("remove-device", ({ channelId, targetDeviceId }) => {
    if (!channelId || !targetDeviceId) {
      return;
    }

    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid remove-device attempt by ${persistentDeviceId}`
      );
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to remove without admin role`
      );
      return;
    }

    if (targetDeviceId === channel.adminId || !channel.devices.has(targetDeviceId)) {
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Admin ${persistentDeviceId} removing device ${targetDeviceId} from channel ${channelId}`
    );
    removeDeviceFromChannel(targetDeviceId, "removed_by_admin");
  });

  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  socket.on("update-locale", (payload) => {
    const { locale } = payload;
    const device = connectedDevices.get(persistentDeviceId);
    if (device && locale) {
      device.locale = locale;
      console.log(`[${new Date().toISOString()}] Device ${persistentDeviceId} updated locale to ${locale}`);

      // Broadcast channel update if device is in a channel
      if (device.channel) {
        broadcastChannelUpdate(device.channel);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(
      `[${new Date().toISOString()}] Socket disconnected: ${
        socket.id
      } (Device: ${persistentDeviceId})`
    );

    socketToDevice.delete(socket.id);

    const device = connectedDevices.get(persistentDeviceId);
    if (device) {
      device.isActive = false;

      if (device.channel) {
        const channel = channels.get(device.channel);
        if (channel && channel.adminId === persistentDeviceId) {
          forceCloseChannel(device.channel, "admin_disconnected");
        } else {
          broadcastChannelUpdate(device.channel);
        }
      }

      setTimeout(() => {
        const stillConnected = connectedDevices.get(persistentDeviceId);
        if (stillConnected && !stillConnected.isActive && stillConnected.socketId === socket.id) {
          console.log(
            `[${new Date().toISOString()}] Removing inactive device: ${persistentDeviceId}`
          );

          if (stillConnected.channel) {
            const channel = channels.get(stillConnected.channel);
            if (channel && channel.adminId === persistentDeviceId) {
              forceCloseChannel(stillConnected.channel, "admin_inactive_timeout");
            } else {
              removeDeviceFromChannel(persistentDeviceId);
            }
          }

          connectedDevices.delete(persistentDeviceId);
        }
      }, 600000); // 10 minutos (600000ms)
    }
  });
});

const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  const environment = process.env.NODE_ENV || "development";
  const frontendUrl = Array.isArray(allowedOrigins) ? allowedOrigins.join(', ') : allowedOrigins;

  console.log(`
╔══════════════════════════════════════════╗
║   Socket.IO Server Running               ║
║   Port: ${PORT}                          ║
║   Environment: ${environment.toUpperCase().padEnd(21)}║
╚══════════════════════════════════════════╝

✅ STATUS: PRONTO PARA PRODUÇÃO
   - URL do Servidor: Porta ${PORT} (Acessível via domínio público do Railway)
   - ORIGENS CORS PERMITIDAS: ${frontendUrl}

⚠️ AÇÃO NECESSÁRIA NO VERCEL/FRONT-END:
   Altere a constante SOCKET_URL no seu front-end (ex: src/hooks/useSocket.ts)
   para a URL pública do Railway (ex: https://seu-app-railway.up.railway.app).
`);
});

setInterval(() => {
  console.log(
    `[${new Date().toISOString()}] Active channels: ${channels.size}, Connected devices: ${
      connectedDevices.size
    }`
  );
}, 30000);
