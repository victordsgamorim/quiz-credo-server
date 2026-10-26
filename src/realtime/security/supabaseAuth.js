// A Supabase access token is a JWT: three base64url parts
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_ACCESS_TOKEN_LENGTH = 8192;
const TIMEOUT_MS = 5000;

/**
 * Checks the admins' Supabase sessions with Supabase's Auth API: GET /auth/v1/user answers with
 * the user of a valid, unexpired access token. Supabase checks the token's signature itself,
 * whatever keys the project signs them with.
 *
 * @param options.url - The Supabase project's URL
 * @param options.anonKey - The project's anon (public) key
 * @param options.logger - Where it logs
 * @returns getUser(accessToken): the session's user ({ id }), or null when it isn't a valid session
 */
export const createSupabaseAuth = ({ url, anonKey, logger }) => ({
  getUser: async (accessToken) => {
    if (
      typeof accessToken !== "string" ||
      accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
      !ACCESS_TOKEN_PATTERN.test(accessToken)
    ) {
      return null;
    }

    try {
      const response = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const user = await response.json();
      return typeof user?.id === "string" ? { id: user.id } : null;
    } catch (error) {
      logger.warn("Couldn't check a Supabase session", { error: error.message });
      return null;
    }
  },
});
