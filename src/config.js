// The frontend's development servers, allowed when FRONTEND_URL doesn't say
const DEVELOPMENT_ORIGINS = [
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];

// The role (app_metadata.role of a Supabase user) that can run games; the project's own admins
// have it (see create_admin_user and update_user_role in its database)
const DEFAULT_ADMIN_ROLE = "admin";
const ADMIN_ROLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Node's timers take up to 2^31 - 1 ms: a longer timeout would fire at once
const TIMEOUT_LIMITS = { min: 100, max: 2 ** 31 - 1 };

// On Render, Cloudflare sits in front of every web service and writes the caller's address in
// this header, overwriting whatever the caller sent (X-Forwarded-For keeps the caller's own value
// first, so it can't be trusted)
const RENDER_CLIENT_IP_HEADER = "cf-connecting-ip";

export class ConfigError extends Error {}

const readInteger = (env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  }
  return value;
};

const readBoolean = (env, name, fallback) => {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be true or false (got "${env[name]}")`);
};

// An http(s) URL's origin (scheme, host and port), the form browsers send in the Origin header
const toOrigin = (name, value) => {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`${name} must hold URLs (got "${value}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${name} must hold http(s) URLs (got "${value}")`);
  }
  return url.origin;
};

const readOrigins = (env) => {
  const raw = env.FRONTEND_URL?.trim();
  if (!raw) return DEVELOPMENT_ORIGINS;
  return [
    ...new Set(
      raw
        .split(",")
        .filter((entry) => entry.trim())
        .map((entry) => toOrigin("FRONTEND_URL", entry))
    ),
  ];
};

const isLocalHost = (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

// The Supabase project that signs the admins in: only needed to require a session to create a room
const readSupabase = (env, isRequired) => {
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    if (isRequired) {
      throw new ConfigError(
        "REQUIRE_ADMIN_AUTH needs SUPABASE_URL and SUPABASE_ANON_KEY (the frontend's VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)"
      );
    }
    return null;
  }

  const origin = toOrigin("SUPABASE_URL", url);
  // The access tokens travel to it: only over HTTPS, but on this machine (tests, a local Supabase)
  if (!origin.startsWith("https:") && !isLocalHost(new URL(origin).hostname)) {
    throw new ConfigError("SUPABASE_URL must be an https URL");
  }
  return { url: origin, anonKey };
};

/**
 * The server's settings, from its environment variables (see README.md). Invalid values stop the
 * server from starting, rather than running it with settings nobody chose.
 *
 * @param env - The environment variables
 * @returns The settings
 * @throws ConfigError when a variable is invalid
 */
export const loadConfig = (env = process.env) => {
  const logLevel = env.LOG_LEVEL?.trim().toLowerCase() || "info";
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }
  if (env.REQUIRE_AUTH_TO_CREATE_ROOM !== undefined) {
    // Silently ignoring it would leave the admin actions open
    throw new ConfigError("REQUIRE_AUTH_TO_CREATE_ROOM was renamed to REQUIRE_ADMIN_AUTH");
  }
  const requireAdminAuth = readBoolean(env, "REQUIRE_ADMIN_AUTH", false);
  const adminRole = env.ADMIN_ROLE?.trim() || DEFAULT_ADMIN_ROLE;
  if (!ADMIN_ROLE_PATTERN.test(adminRole)) {
    throw new ConfigError("ADMIN_ROLE must be a role name (letters, digits, - and _)");
  }
  const clientIpHeader = (
    env.CLIENT_IP_HEADER?.trim() || (env.RENDER ? RENDER_CLIENT_IP_HEADER : "")
  ).toLowerCase();

  return Object.freeze({
    port: readInteger(env, "PORT", 3001, { min: 0, max: 65535 }),
    host: env.HOST?.trim() || "0.0.0.0",
    environment: env.NODE_ENV || "development",
    logLevel,
    // The frontend's origins (comma-separated): the only websites whose pages can connect
    allowedOrigins: Object.freeze(readOrigins(env)),
    // The header a trusted proxy writes the caller's address in; without it, the connection's own
    // address (behind a proxy, the proxy's)
    clientIpHeader,

    // Devices on frontends that keep a device token can't be impersonated; requiring it refuses
    // the frontends that don't (turn it on once every device runs the new frontend)
    requireDeviceToken: readBoolean(env, "REQUIRE_DEVICE_TOKEN", false),
    // Creating a room and running its game need the session of a Supabase user with the admin role
    // (the frontend asks for a login too); the guests need none
    requireAdminAuth,
    adminRole,
    supabase: readSupabase(env, requireAdminAuth),

    // Limits, so that no client can take the server's memory or bandwidth
    maxConnections: readInteger(env, "MAX_CONNECTIONS", 5000, { min: 1 }),
    // Generous: a whole classroom on the same Wi-Fi shares one address
    maxConnectionsPerIp: readInteger(env, "MAX_CONNECTIONS_PER_IP", 100, { min: 1 }),
    connectionsPerIpPerMinute: readInteger(env, "CONNECTIONS_PER_IP_PER_MINUTE", 120, { min: 1 }),
    maxRooms: readInteger(env, "MAX_ROOMS", 1000, { min: 1 }),
    maxDevicesPerRoom: readInteger(env, "MAX_DEVICES_PER_ROOM", 100, { min: 2 }),
    // The largest message a device can send: a game's questions in every language fit many times
    maxMessageBytes: readInteger(env, "MAX_MESSAGE_BYTES", 512 * 1024, { min: 16 * 1024 }),

    // An admin who goes away pauses the game; the room closes if they're not back in this time
    adminAwayTimeoutMs: readInteger(env, "ADMIN_AWAY_TIMEOUT_MS", 60000, TIMEOUT_LIMITS),
    // A device whose connection is gone leaves its room for good after this time
    inactiveDeviceTimeoutMs: readInteger(env, "INACTIVE_DEVICE_TIMEOUT_MS", 600000, TIMEOUT_LIMITS),
  });
};
