import { isValidPowerUpSettings, POWER_UP_KINDS, POWER_UP_SETTINGS_LIMITS } from "./powerUps.js";
import { STREAK_THRESHOLD_LIMITS } from "./scoring.js";

// The admin's game settings (the settings dialog): same fields and limits as
// src/types/gameSettings.ts in the frontend (quiz-credo), keep both in sync
const GAME_SETTINGS_LIMITS = {
  questionCount: { min: 10, max: 50 },
  timerDuration: { min: 60, max: 300 },
  maxCategorySelections: { min: 3, max: 10 },
  topCategoriesCount: { min: 5, max: 15 },
  lowTimeThreshold: { min: 5, max: 20 },
  criticalTimeThreshold: { min: 3, max: 10 },
};
// Optional, for the frontends from before them
const OPTIONAL_FLAGS = ["enableQuestionCache", "enableDebugMode"];
const OPTIONAL_SETTINGS = ["streakThreshold", "powerUps", ...OPTIONAL_FLAGS];
const KNOWN_SETTINGS = [...Object.keys(GAME_SETTINGS_LIMITS), ...OPTIONAL_SETTINGS];

// Why the game settings can't be used, or null when they can
export const getGameSettingsError = (settings) => {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return "not_an_object";
  }

  // timerDuration can be null: no time limit
  if (settings.timerDuration !== null && typeof settings.timerDuration !== "number") {
    return "timerDuration";
  }
  if (
    settings.timerDuration !== null &&
    (settings.timerDuration < GAME_SETTINGS_LIMITS.timerDuration.min ||
      settings.timerDuration > GAME_SETTINGS_LIMITS.timerDuration.max)
  ) {
    return "timerDuration";
  }

  for (const [key, limit] of Object.entries(GAME_SETTINGS_LIMITS)) {
    if (key === "timerDuration") continue;
    const value = settings[key];
    if (typeof value !== "number" || value < limit.min || value > limit.max) {
      return key;
    }
  }

  // Optional: frontends from before the power-ups dialog don't send it
  if (settings.powerUps !== undefined && !isValidPowerUpSettings(settings.powerUps)) {
    return "powerUps";
  }

  // Optional: frontends from before the streak multiplier don't send it
  if (settings.streakThreshold !== undefined) {
    const { min, max } = STREAK_THRESHOLD_LIMITS;
    const value = settings.streakThreshold;
    if (typeof value !== "number" || value < min || value > max) {
      return "streakThreshold";
    }
  }

  const invalidFlag = OPTIONAL_FLAGS.find(
    (flag) => settings[flag] !== undefined && typeof settings[flag] !== "boolean"
  );
  return invalidFlag ?? null;
};

export const isValidGameSettings = (settings) => getGameSettingsError(settings) === null;

// The settings the frontend doesn't have: they're left out (keep both in sync)
export const getUnknownSettings = (settings) =>
  Object.keys(settings).filter((key) => !KNOWN_SETTINGS.includes(key));

const pickPowerUpSettings = (powerUps) => ({
  isEnabled: powerUps.isEnabled,
  ...Object.fromEntries(Object.keys(POWER_UP_SETTINGS_LIMITS).map((key) => [key, powerUps[key]])),
  enabled: Object.fromEntries(Object.keys(POWER_UP_KINDS).map((id) => [id, powerUps.enabled[id]])),
});

/**
 * Valid game settings with only the fields the frontend has: the room sends them to every device,
 * so nothing else a device adds goes with them
 *
 * @param settings - Settings that are valid (isValidGameSettings)
 * @returns A copy of the settings, without unknown fields
 */
export const pickGameSettings = (settings) =>
  Object.fromEntries(
    KNOWN_SETTINGS.filter((key) => settings[key] !== undefined).map((key) => [
      key,
      key === "powerUps" ? pickPowerUpSettings(settings.powerUps) : settings[key],
    ])
  );
