import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getGameSettingsError,
  getUnknownSettings,
  isValidGameSettings,
  pickGameSettings,
} from "../../src/domain/gameSettings.js";
import { gameSettings } from "../helpers/fixtures.js";

describe("game settings", () => {
  it("are valid as the frontend sends them", () => {
    assert.equal(getGameSettingsError(gameSettings()), null);
    assert.equal(isValidGameSettings(gameSettings({ timerDuration: null })), true);
  });

  it("are valid without the fields older frontends don't send", () => {
    const { streakThreshold, powerUps, enableQuestionCache, enableDebugMode, ...older } =
      gameSettings();
    void [streakThreshold, powerUps, enableQuestionCache, enableDebugMode];
    assert.equal(isValidGameSettings(older), true);
    assert.deepEqual(pickGameSettings(older), older);
  });

  it("are invalid out of their limits, or of another type", () => {
    const invalid = [
      null,
      [],
      "settings",
      gameSettings({ questionCount: 5 }),
      gameSettings({ timerDuration: 30 }),
      gameSettings({ timerDuration: "60" }),
      gameSettings({ streakThreshold: 11 }),
      gameSettings({ enableDebugMode: "yes" }),
      gameSettings({ enableQuestionCache: 1 }),
      gameSettings({ powerUps: { ...gameSettings().powerUps, stealPoints: 1000 } }),
    ];
    invalid.forEach((settings) => assert.equal(isValidGameSettings(settings), false));
  });

  it("keep only the fields the frontend has", () => {
    const settings = gameSettings();
    const withExtras = {
      ...settings,
      injected: "<script>",
      powerUps: { ...settings.powerUps, extra: 1, enabled: { ...settings.powerUps.enabled, x: 1 } },
    };
    assert.deepEqual(getUnknownSettings(withExtras), ["injected"]);
    assert.deepEqual(pickGameSettings(withExtras), settings);
  });
});
