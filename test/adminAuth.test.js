// With Supabase sessions required, creating a room and running its game need the session of a user
// with the admin role (app_metadata.role); the guests need none. Supabase is a fake here, which
// knows the users by their access tokens.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { closeAll, connect, markAll } from "./helpers/client.js";
import { makeAccessToken, makeUser, startFakeSupabase } from "./helpers/fakeSupabase.js";
import {
  gameSettings,
  openRoom,
  questionsByLocale,
  ROOM_ID,
  startGame,
} from "./helpers/fixtures.js";
import { startServer } from "./helpers/server.js";

const ANA = { deviceId: "device_ana", locale: "en-UK", displayName: "Ana" };

// Whether the server still answers: a new device's ping gets its pong
const assertServerAnswers = async (server) => {
  assert.ok(server.isRunning(), `The server stopped:\n${server.output()}`);
  const device = await connect(server, { auth: { deviceId: "device_probe" } });
  device.mark().emit("ping");
  await device.waitFor("pong");
  device.close();
};

// The admin actions, as the frontend sends them
const adminActions = (settings = gameSettings()) => [
  ["remove-device", { channelId: ROOM_ID, targetDeviceId: ANA.deviceId }],
  ["close-category-vote", { channelId: ROOM_ID }],
  ["update-game-settings", { channelId: ROOM_ID, settings }],
  ["start-game", { channelId: ROOM_ID, settings }],
  ["load-questions", { channelId: ROOM_ID, questions: questionsByLocale() }],
  ["next-question", { channelId: ROOM_ID }],
  ["reset-game", { channelId: ROOM_ID }],
];

describe("admin actions, with Supabase sessions required", () => {
  let supabase;
  let server;
  const sessions = {};

  // A user with their session: a token for the fake Supabase to know
  const signUp = (name, user) => {
    sessions[name] = { user, token: makeAccessToken() };
    supabase.users[sessions[name].token] = user;
    return sessions[name].token;
  };

  before(async () => {
    supabase = await startFakeSupabase();
    server = await startServer({
      REQUIRE_ADMIN_AUTH: "true",
      SUPABASE_URL: supabase.url,
      SUPABASE_ANON_KEY: supabase.anonKey,
    });
    signUp("admin", makeUser({ role: "admin" }));
    signUp("otherAdmin", makeUser({ role: "admin" }));
    signUp("member", makeUser());
    // user_metadata is the user's to edit: a role there proves nothing
    signUp("selfMade", makeUser({ userMetadata: { role: "admin" } }));
  });
  after(async () => {
    await server.stop();
    await supabase.close();
  });

  const createRoom = (device, channelId = ROOM_ID) =>
    device.mark().emit("create-channel", channelId, device.deviceId, { displayName: "Host" });

  // A room of the admin's, with Ana in it
  const openAdminRoom = (channelId = ROOM_ID) =>
    openRoom(server, {
      channelId,
      admin: {
        deviceId: `device_admin_${channelId}`,
        locale: "pt-BR",
        accessToken: sessions.admin.token,
      },
      guests: [ANA],
    });

  it("refuses to create a room without a session, with an invalid one or without the admin role", async () => {
    const attempts = [
      ["no session", undefined, "auth_required"],
      ["a token Supabase doesn't know", makeAccessToken(), "auth_required"],
      ["something that isn't a token", "not a token", "auth_required"],
      ["a user without a role", sessions.member.token, "admin_required"],
      ["a role in user_metadata", sessions.selfMade.token, "admin_required"],
    ];
    for (const [index, [name, accessToken, error]] of attempts.entries()) {
      const device = await connect(server, {
        auth: { deviceId: `device_try_${index}`, ...(accessToken ? { accessToken } : {}) },
      });
      createRoom(device, `TRY00${index}`);
      assert.deepEqual(await device.waitFor("channel-error"), { error }, name);
      device.close();
    }
  });

  it("creates the room of an admin whose session came with the connection", async () => {
    const device = await connect(server, {
      auth: { deviceId: "device_host_1", accessToken: sessions.admin.token },
    });
    createRoom(device, "HOST01");
    assert.equal((await device.waitFor("joined-channel")).adminId, "device_host_1");

    const check = supabase.requests.findLast(
      (request) => request.headers.authorization === `Bearer ${sessions.admin.token}`
    );
    assert.equal(check.url, "/auth/v1/user");
    assert.equal(check.headers.apikey, supabase.anonKey);
    device.close();
  });

  it("takes a session sent after connecting, even right before creating the room", async () => {
    // Signing in on the lobby: the connection was open before
    const device = await connect(server, { auth: { deviceId: "device_host_2" } });
    device.mark().emit("update-access-token", { accessToken: sessions.admin.token });
    createRoom(device, "HOST02");
    assert.equal((await device.waitFor("joined-channel")).adminId, "device_host_2");
    device.close();
  });

  it("keeps every admin action from an admin who signed out, and gives them back on signing in", async () => {
    const { admin, guests } = await openAdminRoom("OUT001");
    const [ana] = guests;
    const settings = gameSettings({ enableDebugMode: true });
    markAll(admin, ana);

    admin.emit("update-access-token", { accessToken: null });
    for (const [event, payload] of adminActions(settings)) {
      admin.emit(event, { ...payload, channelId: "OUT001" });
    }
    await delay(300);
    const errors = admin.received("channel-error");
    assert.deepEqual(errors, Array(7).fill({ error: "auth_required" }));
    await ana.expectNone("game-started", () => true, 50);
    await ana.expectNone("force-leave-channel", () => true, 50);
    await admin.expectNone("channel-update", (state) => state.gameSettings !== null, 50);

    markAll(admin, ana);
    admin.emit("update-access-token", { accessToken: sessions.admin.token });
    admin.emit("start-game", { channelId: "OUT001", settings });
    await ana.waitFor("game-started");
    closeAll(admin, ana);
  });

  it("keeps a room's actions for the user who created it", async () => {
    const { admin, guests } = await openAdminRoom("OWN001");
    const [ana] = guests;
    markAll(admin, ana);

    // The room's admin device, signed in as another admin
    admin.emit("update-access-token", { accessToken: sessions.otherAdmin.token });
    admin.emit("start-game", {
      channelId: "OWN001",
      settings: gameSettings({ enableDebugMode: true }),
    });
    assert.deepEqual(await admin.waitFor("channel-error"), { error: "admin_required" });
    await ana.expectNone("game-started", () => true, 100);

    // And the same user signed in again, with a new token
    const renewed = makeAccessToken();
    supabase.users[renewed] = sessions.admin.user;
    admin.emit("update-access-token", { accessToken: renewed });
    admin.emit("start-game", {
      channelId: "OWN001",
      settings: gameSettings({ enableDebugMode: true }),
    });
    await ana.waitFor("game-started");
    closeAll(admin, ana);
  });

  it("drops a role taken away from the user", async () => {
    const user = makeUser({ role: "admin" });
    const token = makeAccessToken();
    supabase.users[token] = user;
    const host = await connect(server, { auth: { deviceId: "device_host_3", accessToken: token } });
    createRoom(host, "ROLE01");
    await host.waitFor("joined-channel");

    // Supabase tells the user as they are now: a role taken away counts at the next token
    supabase.users[token] = { ...user, app_metadata: { provider: "email" } };
    host.mark().emit("update-access-token", { accessToken: token });
    host.emit("close-category-vote", { channelId: "ROLE01" });
    assert.deepEqual(await host.waitFor("channel-error"), { error: "admin_required" });
    host.close();
  });

  it("refuses a session that expired, until a new one comes", async () => {
    const user = makeUser({ role: "admin" });
    const shortLived = makeAccessToken({ expiresInSeconds: 1 });
    supabase.users[shortLived] = user;
    const host = await connect(server, {
      auth: { deviceId: "device_host_4", accessToken: shortLived },
    });
    createRoom(host, "EXP001");
    await host.waitFor("joined-channel");

    await delay(1300);
    const settings = gameSettings({ enableDebugMode: true });
    host.mark().emit("start-game", { channelId: "EXP001", settings });
    assert.deepEqual(await host.waitFor("channel-error"), { error: "auth_expired" });

    const renewed = makeAccessToken();
    supabase.users[renewed] = user;
    host.mark().emit("update-access-token", { accessToken: renewed });
    host.emit("start-game", { channelId: "EXP001", settings });
    await host.waitFor("game-started");
    host.close();
  });

  it("lets the guests play a whole game without a session, and never asks Supabase for them", async () => {
    const requestsBefore = supabase.requests.length;
    const room = await openAdminRoom("GAME01");
    const { admin } = room;
    const [ana] = room.guests;
    await startGame(room);

    markAll(admin, ana);
    ana.emit("guest-selected-answer", { channelId: "GAME01", questionIndex: 0 });
    ana.emit("submit-answer", {
      channelId: "GAME01",
      questionIndex: 0,
      answerIndex: 0,
      timeSpent: 3,
    });
    assert.equal((await admin.waitFor("answer-result")).isCorrect, true);
    ana.emit("use-power-up", { channelId: "GAME01", powerUpId: "bonus" });

    for (let question = 0; question < 3; question++) {
      admin.emit("next-question", { channelId: "GAME01" });
    }
    await ana.waitFor("game-finished");
    admin.emit("reset-game", { channelId: "GAME01" });
    await ana.waitFor("game-reset");

    // Only the admin's token was ever checked
    assert.equal(supabase.requests.length - requestsBefore, 1);
    assert.equal(admin.received("channel-error").length, 0);
    closeAll(admin, ana);
  });

  it("ignores the admin actions of a device that isn't the room's admin, whatever its session", async () => {
    const { admin, guests } = await openAdminRoom("GUEST1");
    const eve = await connect(server, {
      auth: { deviceId: "device_eve", accessToken: sessions.otherAdmin.token },
    });
    eve.mark().emit("join-channel", "GUEST1", "device_eve", { displayName: "Eve" });
    await eve.waitFor("joined-channel");

    markAll(admin, eve);
    for (const [event, payload] of adminActions()) {
      eve.emit(event, { ...payload, channelId: "GUEST1" });
    }
    await delay(300);
    // Nothing happens, and nothing tells Eve who the room's admin is
    assert.equal(eve.received("channel-error").length, 0);
    await admin.expectNone(
      "channel-update",
      (state) => state.isVotingClosed || state.gameSettings,
      50
    );
    closeAll(admin, eve, ...guests);
  });

  it("doesn't bring the server down with malformed tokens", async () => {
    const host = await connect(server, {
      auth: { deviceId: "device_host_5", accessToken: sessions.admin.token },
    });
    const malformed = [
      undefined,
      null,
      42,
      "text",
      [],
      {},
      { accessToken: 42 },
      { accessToken: {} },
    ];
    malformed.push({ accessToken: "x".repeat(9000) }, { accessToken: "not.a.token!" });
    for (const payload of malformed) {
      if (payload === undefined) host.emit("update-access-token");
      else host.emit("update-access-token", payload);
    }
    await connect(server, { auth: { deviceId: "device_odd_1", accessToken: 12345 } }).then(
      (device) => device.close()
    );
    await delay(100);
    await assertServerAnswers(server);
    host.close();
  });
});

describe("the session checks", () => {
  it("are limited per address, so tokens can't make the server flood Supabase", async () => {
    const supabase = await startFakeSupabase();
    const server = await startServer({
      REQUIRE_ADMIN_AUTH: "true",
      SUPABASE_URL: supabase.url,
      SUPABASE_ANON_KEY: supabase.anonKey,
    });

    // 8 connections of 5 tokens each: the connection's limit allows them
    const devices = [];
    for (let index = 0; index < 8; index++) {
      const device = await connect(server, {
        auth: { deviceId: `device_flood_${index}`, accessToken: makeAccessToken() },
      });
      for (let token = 0; token < 4; token++) {
        device.emit("update-access-token", { accessToken: makeAccessToken() });
      }
      devices.push(device);
    }
    await delay(500);
    assert.ok(supabase.requests.length <= 32, `${supabase.requests.length} checks`);
    assert.ok(supabase.requests.length >= 25);

    await assertServerAnswers(server);
    closeAll(...devices);
    await server.stop();
    await supabase.close();
  });

  it("never reach the log with their tokens", async () => {
    const supabase = await startFakeSupabase();
    const token = makeAccessToken();
    supabase.users[token] = makeUser({ role: "admin" });
    const server = await startServer({
      LOG_LEVEL: "debug",
      REQUIRE_ADMIN_AUTH: "true",
      SUPABASE_URL: supabase.url,
      SUPABASE_ANON_KEY: supabase.anonKey,
    });

    const host = await connect(server, { auth: { deviceId: "device_host_6", accessToken: token } });
    host.mark().emit("create-channel", "LOG001", "device_host_6", { displayName: "Host" });
    await host.waitFor("joined-channel");
    host.emit("update-access-token", { accessToken: makeAccessToken() });
    host.emit("update-access-token", { accessToken: null });
    await delay(200);

    const [, payload] = token.split(".");
    assert.equal(server.output().includes(token), false);
    assert.equal(server.output().includes(payload), false);
    host.close();
    await server.stop();
    await supabase.close();
  });

  it("can't be asked of a project the server doesn't know", async () => {
    await assert.rejects(startServer({ REQUIRE_ADMIN_AUTH: "true" }));
    await assert.rejects(
      startServer({
        REQUIRE_ADMIN_AUTH: "true",
        SUPABASE_URL: "http://project.supabase.co",
        SUPABASE_ANON_KEY: "key",
      })
    );
  });

  it("stop the server from starting under the option's old name", async () => {
    await assert.rejects(startServer({ REQUIRE_AUTH_TO_CREATE_ROOM: "true" }));
  });
});
