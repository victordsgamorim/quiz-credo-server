import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGameState } from "../../src/domain/gameState.js";
import { getLiveRanking } from "../../src/domain/ranking.js";
import { replayScores, scoreAnswer } from "../../src/domain/scoring.js";
import { gameSettings, questionsByLocale } from "../helpers/fixtures.js";

const createChannel = (settings = gameSettings()) => ({
  adminId: "device_admin",
  devices: new Set(["device_admin", "device_ana", "device_bia"]),
  gameSettings: settings,
  gameState: { ...createGameState(), questions: questionsByLocale(6)["pt-BR"] },
});

let clock = 0;
const answer = (channel, deviceId, questionIndex, answerIndex) => {
  const scored = scoreAnswer(channel, deviceId, { questionIndex, answerIndex, timeSpent: 1 });
  scored.timestamp = ++clock;
  channel.gameState.answers.set(deviceId, [
    ...(channel.gameState.answers.get(deviceId) || []),
    scored,
  ]);
};
const answerAll = (channel, deviceId, answers) =>
  answers.forEach((answerIndex, questionIndex) =>
    answer(channel, deviceId, questionIndex, answerIndex)
  );

const usePowerUp = (channel, use) =>
  channel.gameState.powerUps.push({ targetDeviceId: null, ...use, timestamp: ++clock });

const cut = (deviceId, targetDeviceId, questionIndex) => ({
  deviceId,
  powerUpId: "cut",
  questionIndex,
  targetDeviceId,
});

describe("scoring", () => {
  it("multiplies a streak's points from the threshold, up to x3", () => {
    const channel = createChannel();
    // Every answer right: streakThreshold 2 gives x1, x1, x1.5, x2, x2.5, x3
    answerAll(channel, "device_ana", [0, 1, 2, 3, 0, 1]);
    const multipliers = channel.gameState.answers.get("device_ana").map((a) => a.multiplier);
    assert.deepEqual(multipliers, [1, 1, 1.5, 2, 2.5, 3]);
  });

  it("starts the streak again after a wrong answer, unless Freeze keeps it", () => {
    const channel = createChannel();
    answerAll(channel, "device_ana", [0, 1, 3, 3]);
    assert.deepEqual(
      channel.gameState.answers.get("device_ana").map((a) => a.multiplier),
      [1, 1, 1.5, 1]
    );

    const frozen = createChannel();
    usePowerUp(frozen, { deviceId: "device_bia", powerUpId: "freeze", questionIndex: 2 });
    answerAll(frozen, "device_bia", [0, 1, 3, 3]);
    assert.deepEqual(
      frozen.gameState.answers.get("device_bia").map((a) => a.multiplier),
      [1, 1, 1.5, 1.5]
    );
  });

  it("takes a steal's points from its target, unless the target's shield blocks it", () => {
    const channel = createChannel();
    usePowerUp(channel, { deviceId: "device_bia", powerUpId: "bonus", questionIndex: 0 });
    const steal = {
      deviceId: "device_ana",
      powerUpId: "steal",
      questionIndex: 0,
      targetDeviceId: "device_bia",
    };
    usePowerUp(channel, steal);
    assert.deepEqual(Object.fromEntries(replayScores(channel).scores), {
      device_bia: 40,
      device_ana: 20,
    });

    usePowerUp(channel, { deviceId: "device_bia", powerUpId: "shield", questionIndex: 0 });
    assert.deepEqual(Object.fromEntries(replayScores(channel).scores), {
      device_bia: 60,
      device_ana: 0,
    });
  });

  it("never takes the target below zero", () => {
    const channel = createChannel();
    usePowerUp(channel, {
      deviceId: "device_ana",
      powerUpId: "steal",
      questionIndex: 0,
      targetDeviceId: "device_bia",
    });
    assert.deepEqual(Object.fromEntries(replayScores(channel).scores), {
      device_bia: 0,
      device_ana: 0,
    });
  });

  it("leaves a right answer Cut hit with the game's cutPercent of its points, before or after it", () => {
    const channel = createChannel();
    answer(channel, "device_ana", 0, 0);
    answer(channel, "device_bia", 0, 0);
    // Before Bia's answer: her 20 points become 10
    usePowerUp(channel, cut("device_ana", "device_bia", 1));
    answer(channel, "device_ana", 1, 1);
    answer(channel, "device_bia", 1, 1);
    // After Ana's answer: her 45 points (x1.5) become 23 (22.5, rounded)
    answer(channel, "device_ana", 2, 2);
    usePowerUp(channel, cut("device_bia", "device_ana", 2));
    answer(channel, "device_bia", 2, 2);

    assert.deepEqual(Object.fromEntries(replayScores(channel).scores), {
      device_ana: 53,
      device_bia: 65,
    });
    // Cut takes points, not the streak: Bia's x1.5 stays
    assert.equal(channel.gameState.answers.get("device_bia")[2].multiplier, 1.5);
  });

  it("cuts an answer once however many use Cut on it, and never through the target's shield", () => {
    const cutTwice = (channel) => {
      channel.devices.add("device_caio");
      usePowerUp(channel, cut("device_ana", "device_bia", 0));
      usePowerUp(channel, cut("device_caio", "device_bia", 0));
    };
    const hit = createChannel();
    cutTwice(hit);
    answer(hit, "device_bia", 0, 0);
    assert.equal(replayScores(hit).scores.get("device_bia"), 5);

    const shielded = createChannel();
    cutTwice(shielded);
    usePowerUp(shielded, { deviceId: "device_bia", powerUpId: "shield", questionIndex: 0 });
    answer(shielded, "device_bia", 0, 0);
    assert.equal(replayScores(shielded).scores.get("device_bia"), 10);
  });

  it("ranks the players, the one who got there first ahead on equal points", () => {
    const channel = createChannel();
    const devices = new Map(
      ["device_admin", "device_ana", "device_bia"].map((id) => [id, { id, displayName: id }])
    );
    answerAll(channel, "device_bia", [0]);
    answerAll(channel, "device_ana", [0]);
    assert.deepEqual(
      getLiveRanking(channel, devices).map(({ deviceId, totalPoints }) => [deviceId, totalPoints]),
      [
        ["device_bia", 10],
        ["device_ana", 10],
      ]
    );
  });
});
