import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const toBase64Url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An access token shaped like Supabase's (a JWT: header.payload.signature) that expires in
 * `expiresInSeconds`. Every call gives a different token.
 */
export const makeAccessToken = ({ expiresInSeconds = 3600 } = {}) =>
  [
    toBase64Url({ alg: "HS256", typ: "JWT" }),
    toBase64Url({ jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
    "signature",
  ].join(".");

/**
 * A stand-in for Supabase's Auth API: GET /auth/v1/user answers with the user of a known access
 * token (and the project's anon key), 401 otherwise. Tests add users to `users`, by access token.
 *
 * @param options.users - The users, by access token
 * @param options.anonKey - The project's anon key
 * @returns Its URL, the users, the requests it got, and a way to close it
 */
export const startFakeSupabase = async ({ users = {}, anonKey = "anon-key" } = {}) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const user = req.headers.apikey === anonKey ? users[token] : undefined;
    if (req.method === "GET" && req.url === "/auth/v1/user" && user) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(user));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid JWT" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey,
    users,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

/** A Supabase user, as the Auth API describes them: the role is app_metadata's (the owner's) */
export const makeUser = ({ role = null, userMetadata = {} } = {}) => ({
  id: randomUUID(),
  email: `${randomUUID().slice(0, 8)}@example.com`,
  app_metadata: { provider: "email", ...(role ? { role } : {}) },
  user_metadata: userMetadata,
});
