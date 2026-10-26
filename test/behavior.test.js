// How the server behaves for the frontend: rooms, votes, settings, a whole game with its power-ups
// and ranking, reconnections and an admin who goes away. The same tests run against older
// versions of the server (QUIZ_SERVER_ENTRY), so a change that keeps them passing keeps the
// behavior the frontend relies on.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { closeAll, connect, markAll } from "./helpers/client.js";
import {
  gameSettings,
  openRoom,
  POWER_UP_IDS,
  questionsByLocale,
  ROOM_ID,
  startGame,
} from "./helpers/fixtures.js";
import { startServer } from "./helpers/server.js";

const pickDevice = ({ id, channel, isActive, role, displayName, isReady, locale }) => ({
  id,
  channel,
  isActive,
  role,
  displayName,
  isReady,
  locale,
});

const findDevice = (state, deviceId) => state.devices.find((device) => device.id === deviceId);

const hasDevice = (deviceId) => (state) => Boolean(findDevice(state, deviceId));

const rankingOf = ({ ranking }) =>
  ranking.map(({ deviceId, totalPoints }) => `${deviceId}:${totalPoints}`).join(" ");

describe("rooms and their lobby", () => {
  let server;
  let admin;
  let ana;
  let bia;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    closeAll(admin, ana, bia);
    await server.stop();
  });

  it("creates a room with its creator as the admin", async () => {
    admin = await connect(server, { auth: { deviceId: "device_admin", locale: "pt-BR" } });
    admin.mark().emit("create-channel", ROOM_ID, "device_admin", { displayName: "  Host  " });
    const state = await admin.waitFor("joined-channel");

    assert.equal(state.channelId, ROOM_ID);
    assert.equal(state.adminId, "device_admin");
    assert.equal(state.totalDevices, 1);
    assert.deepEqual(pickDevice(state.devices[0]), {
      id: "device_admin",
      channel: ROOM_ID,
      isActive: true,
      role: "admin",
      displayName: "Host",
      isReady: false,
      locale: "pt-BR",
    });
    assert.equal(typeof state.devices[0].connectedAt, "number");
    assert.deepEqual(state.categoryTotals, []);
    assert.equal(state.maxCategorySelections, 5);
    assert.equal(state.gameSettings, null);
    assert.equal(state.isVotingClosed, false);
    assert.equal(state.isGameStarted, false);
    assert.equal(state.adminAway, null);
    assert.deepEqual(state.gameState, {
      questions: [],
      currentQuestionIndex: 0,
      timerRemaining: 60,
      isShowingResults: false,
      answeredGuestsCount: 0,
      totalGuests: 0,
      selectedGuestsCount: 0,
    });
  });

  it("refuses a room id that's already taken", async () => {
    const other = await connect(server, { auth: { deviceId: "device_other" } });
    other.mark().emit("create-channel", ROOM_ID, "device_other", { displayName: "Other" });
    assert.deepEqual(await other.waitFor("channel-error"), { error: "channel_already_exists" });
    other.close();
  });

  it("tells a device that the room it joins doesn't exist", async () => {
    const other = await connect(server, { auth: { deviceId: "device_lost" } });
    other.mark().emit("join-channel", "NOROOM", "device_lost", { displayName: "Lost" });
    assert.deepEqual(await other.waitFor("channel-error"), { error: "channel_not_found" });
    other.close();
  });

  it("adds guests to the room and tells everyone", async () => {
    ana = await connect(server, { auth: { deviceId: "device_ana", locale: "en-UK" } });
    admin.mark();
    ana.mark().emit("join-channel", ROOM_ID, "device_ana", { displayName: "Ana" });

    const joined = await ana.waitFor("joined-channel");
    assert.equal(joined.channelId, ROOM_ID);
    assert.equal(joined.totalDevices, 2);
    assert.deepEqual(pickDevice(findDevice(joined, "device_ana")), {
      id: "device_ana",
      channel: ROOM_ID,
      isActive: true,
      role: "guest",
      displayName: "Ana",
      isReady: false,
      locale: "en-UK",
    });
    const update = await admin.waitFor("channel-update", hasDevice("device_ana"));
    assert.equal(update.adminId, "device_admin");
    assert.equal(update.gameState.totalGuests, 1);

    bia = await connect(server, { auth: { deviceId: "device_bia", locale: "pt-BR" } });
    bia.mark().emit("join-channel", ROOM_ID, "device_bia", { displayName: "Bia" });
    await bia.waitFor("joined-channel");
  });

  it("renames a guest who joins the room again", async () => {
    admin.mark();
    ana.emit("join-channel", ROOM_ID, "device_ana", { displayName: "Ana Maria" });
    await admin.waitFor(
      "channel-update",
      (state) => findDevice(state, "device_ana")?.displayName === "Ana Maria"
    );
  });

  it("counts the guests' category votes, most voted first", async () => {
    admin.mark();
    ana.emit("update-category-vote", {
      channelId: ROOM_ID,
      categories: ["science", " history ", "science", "", "art", "music", "cinema", "sports"],
    });
    await admin.waitFor("channel-update", (state) => state.categoryTotals.length === 5);

    admin.mark();
    bia.emit("update-category-vote", { channelId: ROOM_ID, categories: ["science", "art"] });
    const state = await admin.waitFor("channel-update", (update) =>
      update.categoryTotals.some(({ votes }) => votes === 2)
    );
    assert.deepEqual(state.categoryTotals, [
      { name: "art", votes: 2 },
      { name: "science", votes: 2 },
      { name: "cinema", votes: 1 },
      { name: "history", votes: 1 },
      { name: "music", votes: 1 },
    ]);
  });

  it("lets only the admin change the game settings, before the game", async () => {
    markAll(admin, ana);
    ana.emit("update-game-settings", { channelId: ROOM_ID, settings: gameSettings() });
    await admin.expectNone("channel-update", (state) => state.gameSettings !== null);

    admin.emit("update-game-settings", {
      channelId: ROOM_ID,
      settings: gameSettings({ questionCount: 5 }),
    });
    await admin.expectNone("channel-update", (state) => state.gameSettings !== null);

    const settings = gameSettings({ maxCategorySelections: 4 });
    admin.emit("update-game-settings", { channelId: ROOM_ID, settings });
    const state = await ana.waitFor("channel-update", (update) => update.gameSettings !== null);
    assert.deepEqual(state.gameSettings, settings);
    assert.equal(state.maxCategorySelections, 4);
  });

  it("tells everyone when a guest is ready", async () => {
    admin.mark();
    ana.emit("update-ready-state", { channelId: ROOM_ID, isReady: true });
    await admin.waitFor("channel-update", (state) => findDevice(state, "device_ana").isReady);
  });

  it("doesn't start the game while a guest isn't ready", async () => {
    markAll(admin, ana);
    admin.emit("start-game", { channelId: ROOM_ID, settings: gameSettings() });
    await ana.expectNone("game-started");
  });

  it("lets only the admin close the voting", async () => {
    markAll(admin, ana);
    ana.emit("close-category-vote", { channelId: ROOM_ID });
    await admin.expectNone("channel-update", (state) => state.isVotingClosed);

    admin.emit("close-category-vote", { channelId: ROOM_ID });
    await ana.waitFor("channel-update", (state) => state.isVotingClosed);

    markAll(admin);
    bia.emit("update-category-vote", { channelId: ROOM_ID, categories: ["sports"] });
    await admin.expectNone("channel-update", (state) =>
      state.categoryTotals.some(({ name }) => name === "sports")
    );
  });

  it("lets only the admin remove a guest", async () => {
    markAll(admin, ana, bia);
    ana.emit("remove-device", { channelId: ROOM_ID, targetDeviceId: "device_bia" });
    await bia.expectNone("force-leave-channel");

    admin.emit("remove-device", { channelId: ROOM_ID, targetDeviceId: "device_bia" });
    assert.deepEqual(await bia.waitFor("force-leave-channel"), {
      channelId: ROOM_ID,
      reason: "removed_by_admin",
    });
    await admin.waitFor("channel-update", (state) => !findDevice(state, "device_bia"));
  });

  it("tells everyone when a guest leaves", async () => {
    admin.mark();
    bia.mark().emit("join-channel", ROOM_ID, "device_bia", { displayName: "Bia" });
    await bia.waitFor("joined-channel");
    await admin.waitFor("channel-update", hasDevice("device_bia"));

    admin.mark();
    bia.emit("leave-channel", ROOM_ID);
    await admin.waitFor("channel-update", (state) => !findDevice(state, "device_bia"));
  });

  it("closes the room when its admin leaves", async () => {
    ana.mark();
    admin.emit("leave-channel", ROOM_ID);
    assert.deepEqual(await ana.waitFor("force-leave-channel"), {
      channelId: ROOM_ID,
      reason: "admin_left",
    });

    bia.mark().emit("join-channel", ROOM_ID, "device_bia", { displayName: "Bia" });
    assert.deepEqual(await bia.waitFor("channel-error"), { error: "channel_not_found" });
  });
});

describe("a room's game", () => {
  let server;
  let admin;
  let ana;
  let bia;
  let room;

  before(async () => {
    server = await startServer();
    room = await openRoom(server);
    ({ admin } = room);
    [ana, bia] = room.guests;
  });
  after(async () => {
    closeAll(admin, ana, bia);
    await server.stop();
  });

  it("starts, and loads the questions, once every guest is ready", async () => {
    await startGame(room);
    const state = admin.last("channel-update");
    assert.equal(state.isGameStarted, true);
    assert.equal(state.gameState.currentQuestionIndex, 0);
    assert.equal(state.gameState.totalGuests, 2);
    assert.equal(state.gameState.isShowingResults, false);
    assert.equal(state.gameState.questions.length, 3);
  });

  it("sends each device the questions in its language", () => {
    const [anaQuestion] = ana.last("channel-update").gameState.questions;
    const [biaQuestion] = bia.last("channel-update").gameState.questions;
    const { id, question, options, difficulty, points, category } = anaQuestion;
    assert.deepEqual(
      { id, question, options, difficulty, points, category },
      {
        id: "q1",
        question: "en: question 1?",
        options: ["en A1", "en B1", "en C1", "en D1"],
        difficulty: "level1",
        points: 10,
        category: "science",
      }
    );
    assert.equal(biaQuestion.question, "pt: question 1?");
    assert.equal(admin.last("channel-update").gameState.questions[0].question, "pt: question 1?");
  });

  it("deals every player a hand of power-ups, and none to the admin", () => {
    for (const guest of [ana, bia]) {
      const [hand] = guest.events
        .filter(({ event }) => event === "power-up-hand")
        .map(({ args }) => args[0]);
      assert.deepEqual([...hand.powerUpIds].sort(), POWER_UP_IDS);
    }
    assert.equal(admin.events.filter(({ event }) => event === "power-up-hand").length, 0);
  });

  it("starts everyone's ranking at 0", () => {
    assert.deepEqual(ana.last("ranking-update"), {
      ranking: [
        { position: 1, deviceId: "device_ana", displayName: "Ana", totalPoints: 0 },
        { position: 2, deviceId: "device_bia", displayName: "Bia", totalPoints: 0 },
      ],
    });
  });

  it("counts the guests who picked an answer", async () => {
    admin.mark();
    ana.emit("guest-selected-answer", { channelId: ROOM_ID, questionIndex: 0 });
    await admin.waitFor("channel-update", (state) => state.gameState.selectedGuestsCount === 1);

    admin.mark();
    ana.emit("guest-selected-answer", { channelId: ROOM_ID, questionIndex: 0 });
    await admin.expectNone("channel-update", (state) => state.gameState.selectedGuestsCount !== 1);
  });

  it("adds a bonus's points at once", async () => {
    markAll(admin, ana, bia);
    bia.emit("use-power-up", { channelId: ROOM_ID, powerUpId: "bonus" });
    const update = await admin.waitFor("ranking-update");
    assert.equal(rankingOf(update), "device_bia:60 device_ana:0");
  });

  it("tells the attacker and the target what a steal took", async () => {
    markAll(admin, ana, bia);
    ana.emit("use-power-up", {
      channelId: ROOM_ID,
      powerUpId: "steal",
      targetDeviceId: "device_bia",
    });
    const outcome = {
      questionIndex: 0,
      powerUpId: "steal",
      attacker: { id: "device_ana", name: "Ana" },
      target: { id: "device_bia", name: "Bia" },
      isBlocked: false,
      points: 20,
    };
    assert.deepEqual(await ana.waitFor("power-up-outcome"), outcome);
    assert.deepEqual(await bia.waitFor("power-up-outcome"), outcome);
    assert.equal(rankingOf(await admin.waitFor("ranking-update")), "device_bia:40 device_ana:20");
    await admin.expectNone("power-up-outcome", () => true, 100);
  });

  it("lets each power-up work once per game", async () => {
    markAll(admin, ana, bia);
    ana.emit("use-power-up", {
      channelId: ROOM_ID,
      powerUpId: "steal",
      targetDeviceId: "device_bia",
    });
    await ana.expectNone("power-up-outcome");
    await admin.expectNone("ranking-update", () => true, 50);
  });

  it("scores a right answer and tells everyone", async () => {
    markAll(admin, ana, bia);
    ana.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: 0,
      timeSpent: 4,
    });
    const result = { questionIndex: 0, isCorrect: true, points: 10, deviceId: "device_ana" };
    assert.deepEqual(await admin.waitFor("answer-result"), result);
    assert.deepEqual(await bia.waitFor("answer-result"), result);
    await admin.waitFor("channel-update", (state) => state.gameState.answeredGuestsCount === 1);
    assert.equal(rankingOf(await admin.waitFor("ranking-update")), "device_bia:40 device_ana:30");
  });

  it("takes a device's first answer to a question only", async () => {
    markAll(admin);
    ana.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: 1,
      timeSpent: 5,
    });
    await admin.expectNone("answer-result");
  });

  it("ignores answers to a question that isn't the current one", async () => {
    markAll(admin);
    bia.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 1,
      answerIndex: 1,
      timeSpent: 5,
    });
    await admin.expectNone("answer-result");
  });

  it("scores a wrong answer at 0", async () => {
    markAll(admin);
    bia.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: 3,
      timeSpent: 9,
    });
    assert.deepEqual(await admin.waitFor("answer-result"), {
      questionIndex: 0,
      isCorrect: false,
      points: 0,
      deviceId: "device_bia",
    });
  });

  it("refuses a power-up once its player answered the question", async () => {
    markAll(admin);
    ana.emit("use-power-up", { channelId: ROOM_ID, powerUpId: "bonus" });
    await admin.expectNone("ranking-update");
  });

  it("lets only the admin go to the next question", async () => {
    markAll(admin, ana);
    ana.emit("next-question", { channelId: ROOM_ID });
    await admin.expectNone(
      "channel-update",
      (state) => state.gameState.currentQuestionIndex === 1,
      200
    );

    admin.emit("next-question", { channelId: ROOM_ID });
    const state = await ana.waitFor(
      "channel-update",
      (update) => update.gameState.currentQuestionIndex === 1
    );
    assert.equal(state.gameState.timerRemaining, 60);
    assert.equal(state.gameState.selectedGuestsCount, 0);
    assert.equal(state.gameState.answeredGuestsCount, 0);
  });

  it("blocks a disadvantage with the target's shield, even when it came first", async () => {
    markAll(ana, bia);
    ana.emit("use-power-up", {
      channelId: ROOM_ID,
      powerUpId: "break",
      targetDeviceId: "device_bia",
    });
    const outcome = {
      questionIndex: 1,
      powerUpId: "break",
      attacker: { id: "device_ana", name: "Ana" },
      target: { id: "device_bia", name: "Bia" },
      isBlocked: false,
    };
    assert.deepEqual(await bia.waitFor("power-up-outcome"), outcome);

    markAll(ana, bia);
    bia.emit("use-power-up", { channelId: ROOM_ID, powerUpId: "shield" });
    assert.deepEqual(await ana.waitFor("power-up-outcome"), { ...outcome, isBlocked: true });
    assert.deepEqual(await bia.waitFor("power-up-outcome"), { ...outcome, isBlocked: true });
  });

  it("multiplies the points of a streak of right answers", async () => {
    markAll(admin);
    ana.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 1,
      answerIndex: 1,
      timeSpent: 3,
    });
    await admin.waitFor("answer-result", (result) => result.deviceId === "device_ana");
    bia.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 1,
      answerIndex: 1,
      timeSpent: 3,
    });
    await admin.waitFor("answer-result", (result) => result.deviceId === "device_bia");

    markAll(admin);
    admin.emit("next-question", { channelId: ROOM_ID });
    await admin.waitFor("channel-update", (state) => state.gameState.currentQuestionIndex === 2);

    // The last question: no power-up works on it
    markAll(admin);
    ana.emit("use-power-up", { channelId: ROOM_ID, powerUpId: "bonus" });
    await admin.expectNone("ranking-update");

    markAll(admin);
    ana.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 2,
      answerIndex: 2,
      timeSpent: 3,
    });
    assert.deepEqual(await admin.waitFor("answer-result"), {
      questionIndex: 2,
      isCorrect: true,
      points: 45,
      deviceId: "device_ana",
    });
    bia.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 2,
      answerIndex: 0,
      timeSpent: 3,
    });
    await admin.waitFor("answer-result", (result) => result.deviceId === "device_bia");
  });

  it("ends the game after its last question, with the final ranking", async () => {
    markAll(admin, ana, bia);
    admin.emit("next-question", { channelId: ROOM_ID });
    const finished = await bia.waitFor("game-finished");
    assert.deepEqual(finished, {
      ranking: [
        {
          position: 1,
          deviceId: "device_ana",
          displayName: "Ana",
          role: "guest",
          totalPoints: 95,
          correctAnswers: 3,
          totalAnswers: 3,
          accuracy: 100,
        },
        {
          position: 2,
          deviceId: "device_bia",
          displayName: "Bia",
          role: "guest",
          totalPoints: 60,
          correctAnswers: 1,
          totalAnswers: 3,
          accuracy: 33,
        },
      ],
      totalQuestions: 3,
    });
    await ana.waitFor("channel-update", (state) => state.gameState.isShowingResults);
  });

  it("lets only the admin take the room back to the lobby", async () => {
    markAll(admin, ana, bia);
    ana.emit("reset-game", { channelId: ROOM_ID });
    await bia.expectNone("game-reset");

    admin.emit("reset-game", { channelId: ROOM_ID });
    assert.deepEqual(await ana.waitFor("game-reset"), { channelId: ROOM_ID });
    const state = await ana.waitFor("channel-update", (update) => !update.isGameStarted);
    assert.equal(state.isVotingClosed, false);
    assert.equal(findDevice(state, "device_ana").isReady, false);
    assert.deepEqual(state.gameState, {
      questions: [],
      currentQuestionIndex: 0,
      timerRemaining: 60,
      isShowingResults: false,
      answeredGuestsCount: 0,
      totalGuests: 2,
      selectedGuestsCount: 0,
    });
  });

  it("plays a new game with new hands", async () => {
    markAll(ana);
    await startGame(room);
    const hand = ana.received("power-up-hand")[0];
    assert.deepEqual([...hand.powerUpIds].sort(), POWER_UP_IDS);
    assert.equal(rankingOf(ana.last("ranking-update")), "device_ana:0 device_bia:0");
  });
});

describe("players leaving a game", () => {
  let server;
  let room;

  before(async () => {
    server = await startServer();
    room = await openRoom(server);
    await startGame(room);
  });
  after(async () => {
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  it("keeps a player who answered and then reloaded in the ranking", async () => {
    const { admin } = room;
    const [ana] = room.guests;
    admin.mark();
    ana.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: 0,
      timeSpent: 2,
    });
    await admin.waitFor("ranking-update", (update) => rankingOf(update).includes("device_ana:10"));

    markAll(admin);
    ana.emit("leave-channel", ROOM_ID);
    await admin.waitFor("channel-update", (state) => !findDevice(state, "device_ana"));
    await admin.expectNone("ranking-update", (update) => !rankingOf(update).includes("device_ana"));
  });

  it("takes a player who quits out of the ranking", async () => {
    const { admin } = room;
    const [, bia] = room.guests;
    markAll(admin);
    bia.emit("leave-channel", ROOM_ID, { isQuitting: true });
    const update = await admin.waitFor("ranking-update");
    assert.equal(rankingOf(update), "device_ana:10");
  });
});

describe("devices reconnecting", () => {
  let server;
  let room;
  let admin;
  let ana;

  before(async () => {
    server = await startServer();
    room = await openRoom(server, {
      guests: [{ deviceId: "device_ana", locale: "en-UK", displayName: "Ana" }],
    });
    ({ admin } = room);
  });
  after(async () => {
    closeAll(admin, ana);
    await server.stop();
  });

  it("shows a guest whose connection dropped as inactive", async () => {
    admin.mark();
    room.guests[0].close();
    await admin.waitFor(
      "channel-update",
      (state) => findDevice(state, "device_ana")?.isActive === false
    );
  });

  it("keeps a guest coming back in their room", async () => {
    admin.mark();
    ana = await connect(server, {
      auth: { deviceId: "device_ana", locale: "en-UK", channelId: ROOM_ID },
    });
    await admin.waitFor(
      "channel-update",
      (state) => findDevice(state, "device_ana")?.isActive === true
    );
    const state = await ana.waitFor("channel-update");
    assert.equal(findDevice(state, "device_ana").role, "guest");
  });

  it("takes out of the room a guest who left it while offline", async () => {
    ana.close();
    admin.mark();
    ana = await connect(server, {
      auth: { deviceId: "device_ana", locale: "en-UK", channelId: null },
    });
    await admin.waitFor("channel-update", (state) => !findDevice(state, "device_ana"));
  });
});

describe("the question's countdown and an admin who goes away", () => {
  let server;
  let room;
  let admin;
  let ana;

  before(async () => {
    server = await startServer();
    room = await openRoom(server, {
      guests: [{ deviceId: "device_ana", locale: "en-UK", displayName: "Ana" }],
    });
    ({ admin } = room);
    [ana] = room.guests;
    await startGame(room);
  });
  after(async () => {
    closeAll(admin, ana);
    await server.stop();
  });

  it("counts the question's time down every second", async () => {
    ana.mark();
    await ana.waitFor("channel-update", (state) => state.gameState.timerRemaining === 59, 2500);
  });

  it("pauses the game while the admin's game is in the background", async () => {
    ana.mark();
    admin.emit("device-status", { isActive: false });
    const state = await ana.waitFor("channel-update", (update) => update.adminAway !== null);
    assert.equal(state.adminAway.timeoutMs, 60000);
    assert.ok(state.adminAway.closesInMs > 55000 && state.adminAway.closesInMs <= 60000);

    const pausedAt = ana.last("channel-update").gameState.timerRemaining;
    ana.mark();
    await delay(1500);
    assert.equal(
      ana.received("channel-update").filter((update) => update.gameState.timerRemaining < pausedAt)
        .length,
      0
    );
  });

  it("resumes the game once the admin is back", async () => {
    const pausedAt = ana.last("channel-update").gameState.timerRemaining;
    ana.mark();
    admin.emit("device-status", { isActive: true });
    await ana.waitFor("channel-update", (update) => update.adminAway === null);
    await ana.waitFor(
      "channel-update",
      (update) => update.gameState.timerRemaining === pausedAt - 1,
      2500
    );
  });

  it("pauses the game while the admin's connection is gone, until they're back", async () => {
    ana.mark();
    admin.close();
    await ana.waitFor("channel-update", (update) => update.adminAway !== null);

    ana.mark();
    admin = await connect(server, {
      auth: { deviceId: "device_admin", locale: "pt-BR", channelId: ROOM_ID },
    });
    await ana.waitFor("channel-update", (update) => update.adminAway === null);
    const state = await admin.waitFor("channel-update");
    assert.equal(findDevice(state, "device_admin").role, "admin");
  });
});

describe("debug mode", () => {
  let server;
  let admin;

  before(async () => {
    server = await startServer();
    ({ admin } = await openRoom(server, { guests: [] }));
  });
  after(async () => {
    closeAll(admin);
    await server.stop();
  });

  it("lets the admin play alone", async () => {
    admin.mark();
    admin.emit("start-game", {
      channelId: ROOM_ID,
      settings: gameSettings({ enableDebugMode: true }),
    });
    assert.equal((await admin.waitFor("game-started")).channelId, ROOM_ID);

    admin.mark();
    admin.emit("load-questions", { channelId: ROOM_ID, questions: questionsByLocale() });
    const hand = await admin.waitFor("power-up-hand");
    assert.deepEqual([...hand.powerUpIds].sort(), POWER_UP_IDS);
    assert.deepEqual(await admin.waitFor("ranking-update"), {
      ranking: [{ position: 1, deviceId: "device_admin", displayName: "Host", totalPoints: 0 }],
    });

    admin.mark();
    admin.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: 0,
      timeSpent: 1,
    });
    assert.equal(rankingOf(await admin.waitFor("ranking-update")), "device_admin:10");
  });
});

describe("languages", () => {
  let server;
  let room;

  before(async () => {
    server = await startServer();
    room = await openRoom(server, {
      guests: [{ deviceId: "device_ana", locale: "en-UK", displayName: "Ana" }],
    });
  });
  after(async () => {
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  it("sends a device the questions in the language it changes to", async () => {
    await startGame(room);
    const [ana] = room.guests;
    ana.mark().emit("update-locale", { locale: "es-BO" });
    const state = await ana.waitFor("channel-update", (update) =>
      update.gameState.questions[0].question.startsWith("es:")
    );
    assert.equal(findDevice(state, "device_ana").locale, "es-BO");
  });
});

describe("questions in a single language (older frontends)", () => {
  let server;
  let room;

  before(async () => {
    server = await startServer();
    room = await openRoom(server, {
      guests: [{ deviceId: "device_ana", locale: "en-UK", displayName: "Ana" }],
    });
  });
  after(async () => {
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  it("sends every device the same questions", async () => {
    await startGame(room, { questions: questionsByLocale()["pt-BR"] });
    const [ana] = room.guests;
    assert.equal(ana.last("channel-update").gameState.questions[0].question, "pt: question 1?");
    assert.equal(ana.last("channel-update").gameState.questions.length, 3);
  });
});

describe("keepalive", () => {
  let server;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  it("answers a ping with a pong", async () => {
    const device = await connect(server, { auth: { deviceId: "device_ping" } });
    device.mark().emit("ping");
    const pong = await device.waitFor("pong");
    assert.equal(typeof pong.timestamp, "number");
    device.close();
  });
});
