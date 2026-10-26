import { createServer } from "node:http";

/**
 * A stand-in for Supabase's Auth API: GET /auth/v1/user answers with the user of a known access
 * token (and the project's anon key), 401 otherwise
 *
 * @param options.users - The users, by access token
 * @param options.anonKey - The project's anon key
 * @returns Its URL, the requests it got, and a way to close it
 */
export const startFakeSupabase = async ({
  users = { "header.valid.token": { id: "user-1", email: "host@example.com" } },
  anonKey = "anon-key",
} = {}) => {
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
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
