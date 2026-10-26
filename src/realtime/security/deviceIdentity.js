import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { isValidDeviceId } from "../validation.js";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The server keeps the token's hash only: the token itself is the device's secret
const hashToken = (token) => createHash("sha256").update(token).digest();

const matchesToken = (token, tokenHash) =>
  typeof token === "string" &&
  TOKEN_PATTERN.test(token) &&
  timingSafeEqual(hashToken(token), tokenHash);

// A new identity: a random id (the given one, for a device from before device tokens) and a
// secret token
const issueIdentity = (deviceId = `device_${randomUUID()}`) => {
  const deviceToken = randomBytes(TOKEN_BYTES).toString("base64url");
  return { deviceId, deviceToken, tokenHash: hashToken(deviceToken) };
};

/**
 * Who a new connection is, from its handshake's auth.
 *
 * Every device in a room sees the other devices' ids, so an id alone can't prove who a device is.
 * A frontend that keeps a device token (it sends the deviceToken key, null the first time) gets
 * its identity from the server: a random id and a secret token, which it sends back on every
 * connection. A device with a token can only be that device's: a connection without its token
 * gets an identity of its own.
 *
 * Frontends from before device tokens (no deviceToken key) choose their own id, as they did,
 * unless device tokens are required; they can't take the id of a device with a token.
 *
 * @param options.store - The server's state, for the devices' token hashes
 * @param options.config - The server's settings
 * @returns resolve(auth, fallbackId): { deviceId, deviceToken?, tokenHash? }, or { error }
 */
export const createDeviceIdentity = ({ store, config }) => {
  const resolve = (auth, fallbackId) => {
    const claimedId = isValidDeviceId(auth.deviceId) ? auth.deviceId : null;
    const known = claimedId ? store.devices.get(claimedId) : undefined;

    if (!Object.hasOwn(auth, "deviceToken")) {
      if (config.requireDeviceToken || known?.tokenHash) return { error: "device_token_required" };
      return { deviceId: claimedId || fallbackId };
    }

    if (known?.tokenHash) {
      return matchesToken(auth.deviceToken, known.tokenHash)
        ? { deviceId: claimedId, deviceToken: auth.deviceToken, tokenHash: known.tokenHash }
        : issueIdentity();
    }
    // A device from before device tokens, now on a frontend that keeps them: it keeps its id (and
    // its room)
    if (known && !config.requireDeviceToken) return issueIdentity(claimedId);
    return issueIdentity();
  };

  return { resolve };
};
