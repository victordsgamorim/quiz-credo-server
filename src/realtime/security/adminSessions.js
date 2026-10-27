import { createThrottledLog } from "./throttledLog.js";
import { createKeyedLimiter } from "./tokenBucket.js";

// Session checks an address can ask Supabase for at once, then one every two seconds: signing in,
// and a token renewed every hour, are far below it; someone sending tokens to make the server ask
// Supabase isn't
const CHECKS_PER_IP = { capacity: 30, refillPerSecond: 0.5 };

/**
 * The admins' Supabase sessions: who can create a room and run a game.
 *
 * A device sends its Supabase access token with its connection (the handshake's auth) and again
 * whenever the token changes (update-access-token: signing in, signing out, the hourly renewal).
 * The server checks the token with Supabase and keeps what it learns on the connection (socket.data
 * .session: the user, their role and when the token expires), not the token itself.
 *
 * With sessions required, creating a room needs a session of a user with the admin role, and the
 * room belongs to that user: its admin actions (settings, start, questions, next question, reset,
 * removing a guest, closing the votes) need their session. The guests never need one.
 *
 * @param options.supabaseAuth - Checks an access token (createSupabaseAuth); null when sessions
 *   aren't required, and then nothing here does anything
 * @param options.adminRole - The role (app_metadata.role) of the users who can run games
 * @param options.store - The server's state
 * @param options.logger - Where it logs
 */
export const createAdminSessions = ({ supabaseAuth, adminRole, store, logger }) => {
  if (!supabaseAuth) {
    return {
      isRequired: false,
      setToken: () => {},
      whenReady: (socket, action) => action(),
      getRefusal: () => null,
      getUserId: () => null,
      runAsAdmin: (socket, channelId, action) => action(),
    };
  }

  const checks = createKeyedLimiter(CHECKS_PER_IP);
  const logRefusal = createThrottledLog(logger.warn);

  const check = async (accessToken, ip) => {
    // A value that isn't an access token (or none: signed out) needs no asking Supabase
    if (!supabaseAuth.isWellFormed(accessToken)) return null;
    if (!checks.take(ip)) {
      logRefusal("checks", "Supabase session checks limited", { ip });
      return null;
    }
    const user = await supabaseAuth.getUser(accessToken);
    return user && { userId: user.id, role: user.role, expiresAt: user.expiresAt };
  };

  /**
   * Sets the connection's session from an access token (null: signed out). The last token sent is
   * the one that counts, whichever check ends first.
   */
  const setToken = (socket, accessToken) => {
    const version = (socket.data.sessionVersion ?? 0) + 1;
    socket.data.sessionVersion = version;
    const pending = check(accessToken, socket.data.ip)
      .catch((error) => {
        logger.error("Checking a Supabase session failed", { error });
        return null;
      })
      .then((session) => {
        if (socket.data.sessionVersion === version) socket.data.session = session;
      })
      .finally(() => {
        if (socket.data.sessionPending === pending) socket.data.sessionPending = null;
      });
    socket.data.sessionPending = pending;
    return pending;
  };

  // Runs the action once the connection's session is checked (at once when nothing is being checked)
  const whenReady = (socket, action) => {
    const { sessionPending } = socket.data;
    return sessionPending ? sessionPending.then(action) : action();
  };

  // Why the connection can't run a room's admin actions, or null when it can. Without a room
  // (creating one), any user with the admin role can
  const getRefusal = (socket, channel) => {
    const { session } = socket.data;
    if (!session) return "auth_required";
    if (session.expiresAt <= Date.now()) return "auth_expired";
    if (session.role !== adminRole) return "admin_required";
    if (channel && channel.adminUserId !== session.userId) return "admin_required";
    return null;
  };

  const getUserId = (socket) => socket.data.session?.userId ?? null;

  // Runs an admin action of the room if the connection's session allows it; otherwise tells the
  // device why. An action from a device that isn't the room's admin, or on a room that doesn't
  // exist, goes on to the use case, which refuses it as it always did
  const runAsAdmin = (socket, channelId, action) =>
    whenReady(socket, () => {
      const channel = store.channels.get(channelId);
      if (!channel || channel.adminId !== socket.data.deviceId) return action();

      const refusal = getRefusal(socket, channel);
      if (refusal) {
        logRefusal(refusal, "Admin action refused", {
          deviceId: socket.data.deviceId,
          reason: refusal,
        });
        socket.emit("channel-error", { error: refusal });
        return undefined;
      }
      return action();
    });

  return { isRequired: true, setToken, whenReady, getRefusal, getUserId, runAsAdmin };
};
