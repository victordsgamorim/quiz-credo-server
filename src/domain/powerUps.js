import { randomInt } from "node:crypto";

import { hasAnswered, isGamePlayer, isQuestionTimeUp } from "./gameState.js";

// Power-ups: same ids and kinds as src/components/quiz/powerUps.tsx in the frontend (quiz-credo),
// keep both in sync. A disadvantage ("attack") is used on another player of the game; an advantage
// ("boost") acts on the player who uses it. Each one works once per game, and one per question.
export const POWER_UP_KINDS = {
  freeze: "boost",
  steal: "attack",
  shield: "boost",
  break: "attack",
  bonus: "boost",
};
export const SHIELD_POWER_UP = "shield";
export const STEAL_POWER_UP = "steal";
export const FREEZE_POWER_UP = "freeze";
export const BREAK_POWER_UP = "break";
export const BONUS_POWER_UP = "bonus";

// The admin's power-up settings (the power-ups dialog), inside the game settings: same defaults
// and limits as src/types/powerUpSettings.ts in the frontend, keep both in sync.
// - isEnabled: whether the game has power-ups at all; off, nobody gets any and none can be used
// - handSize: power-ups each player gets for a game, picked at random among the enabled ones
// - enabled: which power-ups can be dealt
// - freezeQuestions: Freeze keeps the streak through wrong answers on the question it's used on
//   and the next ones, this many in all
// - stealPoints: Steal takes up to this many points from its target, never taking them below zero
// - bonusPoints: Bonus adds this many points to the player who uses it, whatever their answer
export const DEFAULT_POWER_UP_SETTINGS = {
  isEnabled: true,
  handSize: 3,
  enabled: { freeze: true, steal: true, shield: true, break: true, bonus: true },
  freezeQuestions: 2,
  stealPoints: 30,
  bonusPoints: 60,
};
export const POWER_UP_SETTINGS_LIMITS = {
  handSize: { min: 1, max: 5 },
  freezeQuestions: { min: 1, max: 5 },
  stealPoints: { min: 10, max: 100 },
  bonusPoints: { min: 10, max: 200 },
};

export const isAttack = (powerUpId) => POWER_UP_KINDS[powerUpId] === "attack";

export const isValidPowerUpSettings = (settings) => {
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
export const getPowerUpSettings = (channel) =>
  isValidPowerUpSettings(channel.gameSettings?.powerUps)
    ? channel.gameSettings.powerUps
    : DEFAULT_POWER_UP_SETTINGS;

// The shield blocks every disadvantage used on its owner during the question it was used on,
// whether the disadvantage came before or after it
export const isAttackBlocked = (powerUps, attack) =>
  powerUps.some(
    (use) =>
      use.powerUpId === SHIELD_POWER_UP &&
      use.deviceId === attack.targetDeviceId &&
      use.questionIndex === attack.questionIndex
  );

// Deals a hand of handSize power-ups among the enabled ones (the power-up settings), or none when
// the game's power-ups are off. Each one is picked at random among those dealt the fewest times in
// the room's game so far (dealtCounts), so the power-ups spread over the players instead of
// everyone getting the same ones; the hand comes in a random order, the bar's order.
export const dealPowerUps = (dealtCounts, { isEnabled, handSize, enabled }) => {
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
export const getPowerUpHand = (channel, deviceId) => {
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

// Why a device can't use a power-up now, or null when it can
export const getPowerUpRejection = (channel, device, { powerUpId, targetDeviceId }, devices) => {
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
  // Power-ups only work up to the second-to-last question
  if (questionIndex === gameState.questions.length - 1) return "last_question";
  if (hasAnswered(channel, device.id, questionIndex) || isQuestionTimeUp(channel)) {
    return "question_locked";
  }

  const ownUses = gameState.powerUps.filter((use) => use.deviceId === device.id);
  if (ownUses.some((use) => use.powerUpId === powerUpId)) return "already_used";
  if (ownUses.some((use) => use.questionIndex === questionIndex)) return "one_per_question";

  if (isAttack(powerUpId)) {
    const target = typeof targetDeviceId === "string" ? devices.get(targetDeviceId) : null;
    if (targetDeviceId === device.id || !isGamePlayer(channel, target)) return "invalid_target";
  }
  return null;
};
