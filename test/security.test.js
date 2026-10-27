// What a client other than the frontend can't do: bring the server down with malformed events,
// take another device's identity, read the answers before the question is over, flood the server
// or connect from another website. Every test sends what the frontend never sends.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { closeAll, connect } from "./helpers/client.js";
import {
  gameSettings,
  openRoom,
  questionsByLocale,
  ROOM_ID,
  startGame,
} from "./helpers/fixtures.js";
import { startServer } from "./helpers/server.js";

const findDevice = (state, deviceId) => state.devices.find((device) => device.id === deviceId);

// Whether the server still answers: a new device's ping gets its pong
const assertServerAnswers = async (server) => {
  assert.ok(server.isRunning(), `The server stopped:\n${server.output()}`);
  const device = await connect(server, { auth: { deviceId: "device_probe" } });
  device.mark().emit("ping");
  await device.waitFor("pong");
  device.close();
};

// A device on a frontend that keeps the identity the server gives it (a device token)
const connectWithToken = async (server, auth) => {
  const device = await connect(server, { auth: { deviceToken: null, locale: "pt-BR", ...auth } });
  await device.waitFor("device-session");
  return device;
};

const EVENTS = [
  "create-channel",
  "join-channel",
  "leave-channel",
  "remove-device",
  "device-status",
  "update-locale",
  "update-access-token",
  "update-category-vote",
  "update-ready-state",
  "close-category-vote",
  "update-game-settings",
  "start-game",
  "load-questions",
  "guest-selected-answer",
  "submit-answer",
  "use-power-up",
  "next-question",
  "reset-game",
];

const MALFORMED_PAYLOADS = [
  undefined,
  null,
  42,
  "text",
  [],
  { channelId: {} },
  { channelId: [ROOM_ID] },
  { channelId: ROOM_ID, questionIndex: "0", answerIndex: {}, categories: [{}], settings: [] },
];

describe("malformed events", () => {
  let server;
  let room;

  beforeEach(async () => {
    server = await startServer();
    room = await openRoom(server);
    await startGame(room);
  });
  afterEach(async () => {
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  for (const event of EVENTS) {
    it(`don't bring the server down: "${event}"`, async () => {
      // From a guest and from the admin, who gets further into the handlers
      for (const client of [room.guests[0], room.admin]) {
        for (const payload of MALFORMED_PAYLOADS) {
          if (payload === undefined) client.emit(event);
          else client.emit(event, payload);
        }
      }
      await delay(100);
      await assertServerAnswers(server);
    });
  }

  it("don't bring the server down: questions of the wrong shape", async () => {
    for (const questions of [{ "pt-BR": 5 }, { "pt-BR": [null] }, "questions", null, [{}]]) {
      room.admin.emit("load-questions", { channelId: ROOM_ID, questions });
    }
    // A tick of the question's countdown sends the room whatever questions it kept
    await delay(1200);
    await assertServerAnswers(server);
  });

  it("don't bring the server down: an answer once the game is over", async () => {
    for (let question = 0; question < 3; question++) {
      room.admin.emit("next-question", { channelId: ROOM_ID });
    }
    await room.guests[0].mark().waitFor("game-finished");
    room.guests[0].emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 3,
      answerIndex: 0,
      timeSpent: 1,
    });
    await delay(100);
    await assertServerAnswers(server);
  });

  it("don't bring the server down: languages named like an object's properties", async () => {
    const eve = await connect(server, { auth: { deviceId: "device_eve", locale: "constructor" } });
    eve.emit("join-channel", ROOM_ID, "device_eve", { displayName: "Eve" });
    for (const locale of ["__proto__", "toString", "hasOwnProperty"]) {
      room.guests[0].emit("update-locale", { locale });
    }
    await delay(1200);
    await assertServerAnswers(server);
    eve.close();
  });

  it("don't bring the server down: handshakes of the wrong shape", async () => {
    for (const auth of [{ deviceId: { id: 1 } }, { deviceId: "x".repeat(5000) }, { locale: [] }]) {
      const device = await connect(server, { auth }).catch(() => null);
      device?.emit("join-channel", ROOM_ID, undefined, { displayName: "Eve" });
      await delay(50);
      device?.close();
    }
    await delay(100);
    await assertServerAnswers(server);
  });
});

describe("device identity", () => {
  let server;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  it("gives a new device an unpredictable id and a secret token", async () => {
    const device = await connectWithToken(server, { deviceId: "device_chosen_by_the_client" });
    assert.match(
      device.deviceId,
      /^device_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    assert.match(device.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    device.close();
  });

  it("keeps the identity, and the room, of a device back with its token", async () => {
    const admin = await connectWithToken(server, { deviceId: "device_admin" });
    admin.mark().emit("create-channel", "SAFE01", admin.deviceId, { displayName: "Host" });
    await admin.waitFor("joined-channel");
    const { deviceId, deviceToken } = admin;
    admin.close();
    await delay(50);

    const back = await connect(server, { auth: { deviceId, deviceToken, channelId: "SAFE01" } });
    assert.equal((await back.waitFor("device-session")).deviceId, deviceId);
    const state = await back.waitFor("channel-update");
    assert.equal(state.adminId, deviceId);
    assert.equal(findDevice(state, deviceId).role, "admin");
    back.close();
  });

  it("refuses an older frontend's connection that claims a device with a token", async () => {
    const victim = await connectWithToken(server, { deviceId: "device_v" });
    victim.mark().emit("create-channel", "SAFE02", victim.deviceId, { displayName: "Victim" });
    await victim.waitFor("joined-channel");

    await assert.rejects(
      connect(server, { auth: { deviceId: victim.deviceId, channelId: "SAFE02" } })
    );
    victim.close();
  });

  it("gives a device with another's id, but not its token, an identity of its own", async () => {
    const victim = await connectWithToken(server, { deviceId: "device_w" });
    victim.mark().emit("create-channel", "SAFE03", victim.deviceId, { displayName: "Victim" });
    await victim.waitFor("joined-channel");

    const attacker = await connect(server, {
      auth: { deviceId: victim.deviceId, deviceToken: "A".repeat(43), channelId: "SAFE03" },
    });
    assert.notEqual((await attacker.waitFor("device-session")).deviceId, victim.deviceId);
    victim.mark();
    attacker.emit("close-category-vote", { channelId: "SAFE03" });
    attacker.emit("leave-channel", "SAFE03");
    await victim.expectNone("channel-update", (state) => state.isVotingClosed);
    await victim.expectNone("force-leave-channel", () => true, 50);
    closeAll(victim, attacker);
  });

  it("acts for the connection's own device, whatever device an event names", async () => {
    const victim = await connect(server, { auth: { deviceId: "device_legacy_victim" } });
    victim.mark().emit("create-channel", "SAFE04", "device_legacy_victim", { displayName: "Host" });
    await victim.waitFor("joined-channel");

    const attacker = await connect(server, { auth: { deviceId: "device_legacy_attacker" } });
    attacker.mark().emit("join-channel", "SAFE04", "device_legacy_victim", { displayName: "Eve" });
    const joined = await attacker.waitFor("joined-channel");
    assert.equal(findDevice(joined, "device_legacy_attacker")?.role, "guest");
    assert.deepEqual(
      [
        findDevice(joined, "device_legacy_victim").role,
        findDevice(joined, "device_legacy_victim").displayName,
      ],
      ["admin", "Host"]
    );
    closeAll(victim, attacker);
  });

  it("refuses older frontends when device tokens are required", async () => {
    const strict = await startServer({ REQUIRE_DEVICE_TOKEN: "true" });
    await assert.rejects(connect(strict, { auth: { deviceId: "device_old" } }));
    const device = await connectWithToken(strict, { deviceId: "device_new" });
    device.close();
    await strict.stop();
  });
});

describe("the questions' right answers", () => {
  let server;
  let room;
  let admin;
  let ana;

  const answersOf = (state) => state.gameState.questions.map((question) => question.correctAnswer);

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

  it("aren't sent to the players before the question is over", () => {
    const [question] = ana.last("channel-update").gameState.questions;
    assert.equal(Object.hasOwn(question, "correctAnswer"), false);
    assert.deepEqual(answersOf(ana.last("channel-update")), [undefined, undefined, undefined]);
  });

  it("are sent to the admin, who loaded them", () => {
    assert.deepEqual(answersOf(admin.last("channel-update")), [0, 1, 2]);
  });

  it("come with the room's update, right before the question's first result", async () => {
    ana.mark();
    admin.emit("submit-answer", {
      channelId: ROOM_ID,
      questionIndex: 0,
      answerIndex: -1,
      timeSpent: 5,
    });
    await ana.waitFor("answer-result");
    const events = ana.events.slice(ana.cursor);
    const resultAt = events.findIndex(({ event }) => event === "answer-result");
    const revealAt = events.findIndex(
      ({ event, args }) =>
        event === "channel-update" && args[0].gameState.questions[0].correctAnswer === 0
    );
    assert.ok(revealAt !== -1 && revealAt < resultAt, "the answer comes before the result");
    assert.deepEqual(answersOf(events[revealAt].args[0]), [0, undefined, undefined]);
  });

  it("stay sent for the questions already played", async () => {
    ana.mark();
    admin.emit("next-question", { channelId: ROOM_ID });
    const state = await ana.waitFor(
      "channel-update",
      (update) => update.gameState.currentQuestionIndex === 1
    );
    assert.deepEqual(answersOf(state), [0, undefined, undefined]);
  });
});

describe("what devices send", () => {
  let server;
  let room;

  before(async () => {
    server = await startServer();
    room = await openRoom(server);
  });
  after(async () => {
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  it("keeps only the game settings the frontend has", async () => {
    const [ana] = room.guests;
    const settings = gameSettings();
    ana.mark();
    room.admin.emit("update-game-settings", {
      channelId: ROOM_ID,
      settings: {
        ...settings,
        injected: "x".repeat(5000),
        powerUps: { ...settings.powerUps, extra: 1 },
      },
    });
    const state = await ana.waitFor("channel-update", (update) => update.gameSettings !== null);
    assert.deepEqual(state.gameSettings, settings);
  });

  it("takes control characters out of display names", async () => {
    const eve = await connect(server, { auth: { deviceId: "device_eve" } });
    eve.mark().emit("join-channel", ROOM_ID, "device_eve", {
      displayName: " Eve\u0000\n\u001b[31m‮evil ",
    });
    const joined = await eve.waitFor("joined-channel");
    assert.equal(findDevice(joined, "device_eve").displayName, "Eve[31mevil");
    eve.close();
  });

  it("doesn't share the devices' connection ids", async () => {
    const eve = await connect(server, { auth: { deviceId: "device_eve_2" } });
    eve.mark().emit("join-channel", ROOM_ID, "device_eve_2", { displayName: "Eve" });
    const joined = await eve.waitFor("joined-channel");
    joined.devices.forEach((device) => assert.equal(Object.hasOwn(device, "socketId"), false));
    eve.close();
  });

  it("refuses room ids that aren't room codes", async () => {
    const eve = await connect(server, { auth: { deviceId: "device_eve_3" } });
    // As many as a connection can create at once
    for (const channelId of [{}, "../etc", "x".repeat(200), "AB CD", "__proto__"]) {
      eve.mark().emit("create-channel", channelId, "device_eve_3", { displayName: "Eve" });
      assert.deepEqual(await eve.waitFor("channel-error"), { error: "invalid_channel_id" });
    }
    eve.close();
  });
});

describe("a game's questions", () => {
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

  it("are refused when they aren't questions", async () => {
    const { admin } = room;
    const [ana] = room.guests;
    ana.emit("update-ready-state", { channelId: ROOM_ID, isReady: true });
    await delay(100);
    admin.mark().emit("start-game", { channelId: ROOM_ID, settings: gameSettings() });
    await admin.waitFor("game-started");

    // As many as the admin can load at once (other shapes: test/unit/questions.test.js)
    const question = { id: "q1", question: "?", options: ["a", "b"], correctAnswer: 0, points: 10 };
    const invalid = [
      { "pt-BR": [{ ...question, correctAnswer: 5 }] },
      { "pt-BR": [{ ...question, options: "ab" }] },
      { "pt-BR": questionsByLocale()["pt-BR"], "en-UK": questionsByLocale(2)["en-UK"] },
      { "pt-BR": [{ ...question, question: "?".repeat(20000) }] },
    ];
    for (const questions of invalid) {
      ana.mark();
      admin.emit("load-questions", { channelId: ROOM_ID, questions });
      await ana.expectNone("power-up-hand", () => true, 150);
    }

    ana.mark();
    admin.emit("load-questions", { channelId: ROOM_ID, questions: questionsByLocale() });
    await ana.waitFor("power-up-hand");
  });
});

describe("abuse limits", () => {
  it("throttle a flood of events, keeping the last state", async () => {
    const server = await startServer();
    const room = await openRoom(server);
    const { admin } = room;
    const [ana] = room.guests;

    admin.mark();
    for (let vote = 0; vote < 300; vote++) {
      ana.emit("update-category-vote", {
        channelId: ROOM_ID,
        categories: [vote % 2 ? "art" : "music"],
      });
    }
    ana.emit("update-category-vote", { channelId: ROOM_ID, categories: ["science"] });
    await admin.waitFor(
      "channel-update",
      (state) => state.categoryTotals.length === 1 && state.categoryTotals[0].name === "science",
      3000
    );
    assert.ok(admin.received("channel-update").length < 60, "far fewer updates than votes");
    await assertServerAnswers(server);
    closeAll(admin, ...room.guests);
    await server.stop();
  });

  it("limit the connections from one address", async () => {
    const server = await startServer({ MAX_CONNECTIONS_PER_IP: "3" });
    const devices = [];
    for (let index = 0; index < 3; index++) {
      devices.push(await connect(server, { auth: { deviceId: `device_${index}` } }));
    }
    await assert.rejects(connect(server, { auth: { deviceId: "device_3" } }));

    devices.shift().close();
    await delay(100);
    devices.push(await connect(server, { auth: { deviceId: "device_4" } }));
    closeAll(...devices);
    await server.stop();
  });

  it("limit the rooms, and the devices in a room", async () => {
    const server = await startServer({ MAX_ROOMS: "1", MAX_DEVICES_PER_ROOM: "2" });
    const room = await openRoom(server, {
      guests: [{ deviceId: "device_ana", locale: "en-UK", displayName: "Ana" }],
    });

    const eve = await connect(server, { auth: { deviceId: "device_eve" } });
    eve.mark().emit("join-channel", ROOM_ID, "device_eve", { displayName: "Eve" });
    assert.deepEqual(await eve.waitFor("channel-error"), { error: "room_full" });
    eve.mark().emit("create-channel", "OTHER1", "device_eve", { displayName: "Eve" });
    assert.deepEqual(await eve.waitFor("channel-error"), { error: "too_many_rooms" });

    closeAll(eve, room.admin, ...room.guests);
    await server.stop();
  });

  it("close the room an admin leaves for a new one", async () => {
    const server = await startServer();
    const room = await openRoom(server);
    const [ana] = room.guests;

    ana.mark();
    room.admin.emit("create-channel", "NEWROOM", "device_admin", { displayName: "Host" });
    assert.deepEqual(await ana.waitFor("force-leave-channel"), {
      channelId: ROOM_ID,
      reason: "admin_left",
    });
    closeAll(room.admin, ...room.guests);
    await server.stop();
  });

  it("drop a connection that sends an oversized message", async () => {
    const server = await startServer();
    const eve = await connect(server, { auth: { deviceId: "device_big" } });
    const disconnected = new Promise((resolve) => eve.socket.once("disconnect", resolve));
    eve.emit("update-category-vote", { channelId: ROOM_ID, categories: ["x".repeat(2_000_000)] });
    await disconnected;
    await assertServerAnswers(server);
    await server.stop();
  });
});

describe("the frontend's origin", () => {
  let server;

  before(async () => {
    server = await startServer({
      FRONTEND_URL: "https://quiz.example/ , https://www.quiz.example",
    });
  });
  after(async () => {
    await server.stop();
  });

  it("is the only website whose pages can connect", async () => {
    await assert.rejects(
      connect(server, { auth: { deviceId: "device_o1" }, origin: "https://evil.example" })
    );
    await assert.rejects(
      connect(server, {
        auth: { deviceId: "device_o2" },
        origin: "https://evil.example",
        transports: ["polling"],
      })
    );
  });

  it("can connect, from each of its addresses", async () => {
    for (const origin of ["https://quiz.example", "https://www.quiz.example"]) {
      const device = await connect(server, { auth: { deviceId: "device_o3" }, origin });
      device.close();
    }
  });

  it("isn't asked of clients that aren't browsers", async () => {
    const device = await connect(server, { auth: { deviceId: "device_o4" } });
    device.close();
  });
});

describe("HTTP", () => {
  let server;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  it("answers health checks", async () => {
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("sends security headers, and doesn't name its framework", async () => {
    const response = await fetch(`${server.url}/`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-powered-by"), null);
  });

  it("doesn't serve the Socket.IO client", async () => {
    const response = await fetch(`${server.url}/socket.io/socket.io.js`);
    assert.notEqual(response.status, 200);
  });
});

describe("configuration", () => {
  it("stops the server from starting with invalid settings", async () => {
    await assert.rejects(startServer({ MAX_ROOMS: "lots" }));
    await assert.rejects(startServer({ FRONTEND_URL: "not a url" }));
  });

  it("closes the room when its admin isn't back in the configured time", async () => {
    const server = await startServer({ ADMIN_AWAY_TIMEOUT_MS: "300" });
    const room = await openRoom(server);
    const [ana] = room.guests;
    ana.mark();
    room.admin.close();
    assert.deepEqual(await ana.waitFor("force-leave-channel"), {
      channelId: ROOM_ID,
      reason: "admin_inactive_timeout",
    });
    closeAll(...room.guests);
    await server.stop();
  });
});
