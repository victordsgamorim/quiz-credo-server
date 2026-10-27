// A Supabase access token is a JWT: three base64url parts
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_ACCESS_TOKEN_LENGTH = 8192;
const TIMEOUT_MS = 5000;
// How long a session counts when its token doesn't say, and the longest it can count
const FALLBACK_SESSION_MS = 5 * 60 * 1000;
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

const isWellFormed = (accessToken) =>
  typeof accessToken === "string" &&
  accessToken.length <= MAX_ACCESS_TOKEN_LENGTH &&
  ACCESS_TOKEN_PATTERN.test(accessToken);

// When the token expires (its `exp` claim, in milliseconds). Supabase already checked the token, so
// this only reads it
const readExpiry = (accessToken, now) => {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    if (Number.isFinite(payload.exp)) return Math.min(payload.exp * 1000, now + MAX_SESSION_MS);
  } catch {
    // Not readable: it counts for a few minutes
  }
  return now + FALLBACK_SESSION_MS;
};

/**
 * Checks the admins' Supabase sessions with Supabase's Auth API: GET /auth/v1/user answers with
 * the user of a valid, unexpired access token, as they are now (a role changed a moment ago
 * counts). Supabase checks the token's signature itself, whatever keys the project signs them with.
 *
 * @param options.url - The Supabase project's URL
 * @param options.anonKey - The project's anon (public) key
 * @param options.logger - Where it logs
 * @returns isWellFormed(accessToken), whether a value looks like an access token (anything else
 *   never needs asking Supabase), and getUser(accessToken): the session's user ({ id, role,
 *   expiresAt }), or null when it isn't a valid session. The role is the user's app_metadata.role, which only the project's
 *   owner can set (user_metadata, which the user edits, never counts)
 */
export const createSupabaseAuth = ({ url, anonKey, logger }) => ({
  isWellFormed,
  getUser: async (accessToken) => {
    if (!isWellFormed(accessToken)) return null;

    try {
      const response = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const user = await response.json();
      if (typeof user?.id !== "string") return null;
      const role = user.app_metadata?.role;
      return {
        id: user.id,
        role: typeof role === "string" ? role : null,
        expiresAt: readExpiry(accessToken, Date.now()),
      };
    } catch (error) {
      logger.warn("Couldn't check a Supabase session", { error: error.message });
      return null;
    }
  },
});
