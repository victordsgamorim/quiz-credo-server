import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChannelState } from "../../src/domain/channelState.js";
import { createGameState, isQuestionRevealed } from "../../src/domain/gameState.js";
import { questionsByLocale } from "../helpers/fixtures.js";

const createChannel = (overrides = {}) => {
  const gameState = { ...createGameState(), questions: questionsByLocale()["pt-BR"] };
  return {
    adminId: "device_admin",
    devices: new Set(["device_admin", "device_ana"]),
    votes: new Map(),
    isGameStarted: true,
    gameSettings: null,
    ...overrides,
    gameState: { ...gameState, ...overrides.gameState },
  };
};

const answer = (questionIndex) => ({ questionIndex, isCorrect: false, points: 0, timestamp: 1 });

describe("isQuestionRevealed", () => {
  it("keeps the current question's answer until someone answers it", () => {
    const channel = createChannel();
    assert.equal(isQuestionRevealed(channel, 0), false);
    channel.gameState.answers.set("device_admin", [answer(0)]);
    assert.equal(isQuestionRevealed(channel, 0), true);
  });

  it("shows the current question's answer once its time is up", () => {
    assert.equal(isQuestionRevealed(createChannel({ gameState: { timerRemaining: 0 } }), 0), true);
    // Without a time limit, the time is never up
    const unlimited = createChannel({
      gameSettings: { timerDuration: null },
      gameState: { timerRemaining: 0 },
    });
    assert.equal(isQuestionRevealed(unlimited, 0), false);
  });

  it("shows the answers of the questions played, and of every question once the game is over", () => {
    const channel = createChannel({ gameState: { currentQuestionIndex: 1 } });
    assert.deepEqual(
      [0, 1, 2].map((index) => isQuestionRevealed(channel, index)),
      [true, false, false]
    );
    channel.gameState.isShowingResults = true;
    assert.deepEqual(
      [0, 1, 2].map((index) => isQuestionRevealed(channel, index)),
      [true, true, true]
    );
  });
});

describe("buildChannelState", () => {
  const devices = new Map([
    ["device_admin", { id: "device_admin", role: "admin", socketId: "s1", displayName: "Host" }],
    ["device_ana", { id: "device_ana", role: "guest", socketId: "s2", displayName: "Ana" }],
  ]);

  it("shows the admin every right answer, and the others only the revealed ones", () => {
    const channel = createChannel({ gameState: { currentQuestionIndex: 1 } });
    const answersFor = (showAllAnswers) =>
      buildChannelState("ROOM23", channel, devices, { showAllAnswers }).gameState.questions.map(
        (question) => question.correctAnswer
      );
    assert.deepEqual(answersFor(true), [0, 1, 2]);
    assert.deepEqual(answersFor(false), [0, undefined, undefined]);
  });

  it("doesn't show the devices' connection ids", () => {
    const state = buildChannelState("ROOM23", createChannel(), devices, {});
    state.devices.forEach((device) => assert.equal(Object.hasOwn(device, "socketId"), false));
  });
});
