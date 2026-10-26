import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeviceIdentity } from "../../src/realtime/security/deviceIdentity.js";

const SERVER_ID = /^device_[0-9a-f-]{36}$/;

const setUp = ({ requireDeviceToken = false } = {}) => {
  const store = { devices: new Map() };
  const identity = createDeviceIdentity({ store, config: { requireDeviceToken } });
  // A device the server knows, as connectDevice keeps it
  const register = ({ deviceId, tokenHash }) =>
    store.devices.set(deviceId, { id: deviceId, tokenHash });
  return { identity, register };
};

describe("device identity", () => {
  it("lets an older frontend choose its id, or falls back to the connection's", () => {
    const { identity } = setUp();
    assert.deepEqual(identity.resolve({ deviceId: "device_abc_123" }, "socket1"), {
      deviceId: "device_abc_123",
    });
    assert.deepEqual(identity.resolve({ deviceId: { id: 1 } }, "socket1"), { deviceId: "socket1" });
    assert.deepEqual(identity.resolve({}, "socket1"), { deviceId: "socket1" });
  });

  it("gives a frontend that keeps a token a random id of the server's, and a token", () => {
    const { identity } = setUp();
    const issued = identity.resolve({ deviceId: "device_mine", deviceToken: null }, "socket1");
    assert.match(issued.deviceId, SERVER_ID);
    assert.match(issued.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.tokenHash.length, 32);
  });

  it("gives a device back its identity with its token, and another one without it", () => {
    const { identity, register } = setUp();
    const issued = identity.resolve({ deviceToken: null }, "socket1");
    register(issued);

    const back = identity.resolve(
      { deviceId: issued.deviceId, deviceToken: issued.deviceToken },
      "s2"
    );
    assert.equal(back.deviceId, issued.deviceId);

    for (const deviceToken of [null, "A".repeat(43), issued.deviceToken.slice(1), 42]) {
      const other = identity.resolve({ deviceId: issued.deviceId, deviceToken }, "s3");
      assert.notEqual(other.deviceId, issued.deviceId);
    }
    assert.deepEqual(identity.resolve({ deviceId: issued.deviceId }, "s4"), {
      error: "device_token_required",
    });
  });

  it("lets a device from before tokens keep its id once it gets one", () => {
    const { identity, register } = setUp();
    register({ deviceId: "device_old_1" });
    const upgraded = identity.resolve({ deviceId: "device_old_1", deviceToken: null }, "s1");
    assert.equal(upgraded.deviceId, "device_old_1");
    assert.ok(upgraded.deviceToken);
  });

  it("refuses frontends without a token when tokens are required", () => {
    const { identity, register } = setUp({ requireDeviceToken: true });
    assert.deepEqual(identity.resolve({ deviceId: "device_x" }, "s1"), {
      error: "device_token_required",
    });
    register({ deviceId: "device_old_2" });
    const issued = identity.resolve({ deviceId: "device_old_2", deviceToken: null }, "s2");
    assert.match(issued.deviceId, SERVER_ID);
  });
});
