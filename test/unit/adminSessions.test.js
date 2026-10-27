import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createAdminSessions } from "../../src/realtime/security/adminSessions.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// A Supabase that answers each token with its user, after the delay the test chose
const createSupabaseAuth = (users, delays = {}) => ({
  calls: [],
  isWellFormed: (token) => typeof token === "string" && token.startsWith("tok-"),
  async getUser(token) {
    this.calls.push(token);
    await delay(delays[token] ?? 0);
    return users[token] ?? null;
  },
});

const FAR = Date.now() + 3600 * 1000;
const USERS = {
  "tok-admin": { id: "user-1", role: "admin", expiresAt: FAR },
  "tok-admin-2": { id: "user-1", role: "admin", expiresAt: FAR },
  "tok-other": { id: "user-2", role: "admin", expiresAt: FAR },
  "tok-member": { id: "user-3", role: null, expiresAt: FAR },
  "tok-expired": { id: "user-1", role: "admin", expiresAt: Date.now() - 1 },
};

const setUp = (delays) => {
  const supabaseAuth = createSupabaseAuth(USERS, delays);
  const store = { channels: new Map([["ROOM23", { adminId: "device-1", adminUserId: "user-1" }]]) };
  const sessions = createAdminSessions({ supabaseAuth, adminRole: "admin", store, logger });
  const socket = () => ({
    data: { deviceId: "device-1", ip: "10.0.0.1" },
    emitted: [],
    emit(...args) {
      this.emitted.push(args);
    },
  });
  return { sessions, supabaseAuth, socket, store };
};

describe("admin sessions", () => {
  it("do nothing when sessions aren't required", async () => {
    const sessions = createAdminSessions({
      supabaseAuth: null,
      adminRole: "admin",
      store: {},
      logger,
    });
    const socket = { data: {} };
    sessions.setToken(socket, "tok-admin");
    assert.equal(sessions.getRefusal(socket), null);
    assert.equal(sessions.getUserId(socket), null);
    let ran = false;
    sessions.runAsAdmin(socket, "ROOM23", () => (ran = true));
    assert.equal(ran, true);
  });

  it("take the user, the role and the expiry from the token, not the token", async () => {
    const { sessions, socket } = setUp();
    const device = socket();
    await sessions.setToken(device, "tok-admin");
    assert.deepEqual(device.data.session, { userId: "user-1", role: "admin", expiresAt: FAR });
    assert.equal(JSON.stringify(device.data).includes("tok-admin"), false);
  });

  it("say why a connection can't take the admin's actions", async () => {
    const { sessions, socket, store } = setUp();
    const device = socket();
    const channel = store.channels.get("ROOM23");
    const refusalFor = async (token) => {
      await sessions.setToken(device, token);
      return sessions.getRefusal(device, channel);
    };

    assert.equal(await refusalFor(undefined), "auth_required");
    assert.equal(await refusalFor("tok-unknown"), "auth_required");
    assert.equal(await refusalFor("tok-member"), "admin_required");
    assert.equal(await refusalFor("tok-other"), "admin_required");
    assert.equal(await refusalFor("tok-expired"), "auth_expired");
    assert.equal(await refusalFor("tok-admin"), null);
    // Creating a room has no room yet: any admin can
    assert.equal(await refusalFor("tok-other"), "admin_required");
    await sessions.setToken(device, "tok-other");
    assert.equal(sessions.getRefusal(device), null);
  });

  it("count the last token sent, whichever check ends first", async () => {
    const { sessions, socket } = setUp({ "tok-member": 60, "tok-admin": 0 });
    const device = socket();
    sessions.setToken(device, "tok-member");
    await sessions.setToken(device, "tok-admin");
    await delay(100);
    assert.equal(device.data.session.userId, "user-1");
    assert.equal(device.data.session.role, "admin");
  });

  it("run an action once the session is checked, in the order the actions came", async () => {
    const { sessions, socket } = setUp({ "tok-admin": 30 });
    const device = socket();
    sessions.setToken(device, "tok-admin");
    const ran = [];
    sessions.runAsAdmin(device, "ROOM23", () => ran.push("first"));
    sessions.runAsAdmin(device, "ROOM23", () => ran.push("second"));
    assert.deepEqual(ran, []);
    await delay(80);
    assert.deepEqual(ran, ["first", "second"]);
    // Nothing being checked: it runs at once
    sessions.runAsAdmin(device, "ROOM23", () => ran.push("third"));
    assert.equal(ran.at(-1), "third");
  });

  it("tell the device why an action is refused, and don't run it", async () => {
    const { sessions, socket } = setUp();
    const device = socket();
    await sessions.setToken(device, "tok-member");
    let ran = false;
    sessions.runAsAdmin(device, "ROOM23", () => (ran = true));
    assert.equal(ran, false);
    assert.deepEqual(device.emitted, [["channel-error", { error: "admin_required" }]]);
  });

  it("leave the actions of other devices, and of rooms that don't exist, to the use cases", async () => {
    const { sessions, socket } = setUp();
    const guest = socket();
    guest.data.deviceId = "device-guest";
    await sessions.setToken(guest, "tok-other");
    const ran = [];
    sessions.runAsAdmin(guest, "ROOM23", () => ran.push("guest"));
    sessions.runAsAdmin(guest, "NOROOM", () => ran.push("no room"));
    assert.deepEqual(ran, ["guest", "no room"]);
    assert.deepEqual(guest.emitted, []);
  });

  it("limit the checks an address can ask of Supabase, and don't ask for what isn't a token", async () => {
    const { sessions, supabaseAuth, socket } = setUp();
    const devices = Array.from({ length: 40 }, socket);
    for (const device of devices) await sessions.setToken(device, "tok-admin");
    for (const device of devices) await sessions.setToken(device, "not a token");
    await sessions.setToken(socket(), null);

    assert.equal(supabaseAuth.calls.length, 30);
    // Past the limit a session isn't granted
    assert.equal(devices.at(-1).data.session, null);
    // Another address has its own
    const other = socket();
    other.data.ip = "10.0.0.2";
    await sessions.setToken(other, "tok-admin");
    assert.equal(other.data.session.userId, "user-1");
  });
});
