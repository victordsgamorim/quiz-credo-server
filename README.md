# quiz-credo-server

The realtime server of [QuizCredo](../quiz-credo): a Socket.IO server that keeps every room's
state (its devices, votes, settings and game) and sends it to the room's devices. The state lives
in memory: a restart starts it over.

## Running it

```sh
npm ci        # installs the exact versions of package-lock.json
npm start     # http://localhost:3001
npm test      # unit, behavior and security tests
```

It needs Node.js 22 or later.

## How it's organized

```
server.js                 entry point (npm start, node server.js): loads src/index.js
src/
  index.js                starts the HTTP and Socket.IO servers
  config.js               the settings, from the environment (invalid ones stop the start)
  logger.js               one-line entries, details as JSON, with a rate per message
  http/                   the HTTP requests that aren't Socket.IO's: /health, and 404
  realtime/               Socket.IO: the server, its security, and the events' handlers
    createSocketServer.js   the server's options, the connection's checks, the handlers
    validation.js           what each event's payload must look like
    handlers/               one module per area: connection, rooms, lobby, game
    security/               origins and connection limits, device identity, event limits,
                            admins' Supabase sessions
  services/               the use cases: rooms, devices, lobby, game, countdown, and what the
                          server sends the devices (notifier)
  domain/                 the game's rules, without I/O: scoring, power-ups, ranking, settings,
                          questions, and the room as each device sees it
  state/store.js          the rooms and devices, in memory
test/
  behavior.test.js        what the frontend relies on (runs against older versions too)
  security.test.js        what other clients can't do
  unit/                   the rules and the security parts, one by one
```

A handler checks the event's payload (`realtime/validation.js`) and calls its use case
(`services/`); the use case applies the game's rules (`domain/`) to the state (`state/`) and sends
the result (`services/notifier.js`).

`test/behavior.test.js` can run against another version of the server, to check that a change
keeps the behavior: `QUIZ_SERVER_ENTRY=path/to/server.js node --test test/behavior.test.js`.

## Configuration

| Variable                        | Default                                                                   | What it does                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                          | `3001`                                                                    | The port it listens on (Render sets it).                                                                                                         |
| `FRONTEND_URL`                  | `http://localhost:3001`, `http://localhost:8080`, `http://127.0.0.1:8080`, `http://localhost:5173`, `http://127.0.0.1:5173` | The frontend's origins, comma-separated: **the only websites whose pages can connect**. List every domain the frontend is served from.           |
| `CLIENT_IP_HEADER`              | `cf-connecting-ip` on Render, none elsewhere                              | The header a trusted proxy writes the caller's address in (a single address). Without one, the connection's address.                             |
| `REQUIRE_DEVICE_TOKEN`          | `false`                                                                   | Refuses frontends that don't keep a device token (see [Device identity](#device-identity)).                                                      |
| `REQUIRE_ADMIN_AUTH`            | `false`                                                                   | Creating a room and running its game need a Supabase session of an admin (see [Admin sessions](#admin-sessions)). Needs the two variables below. |
| `ADMIN_ROLE`                    | `admin`                                                                   | The role (`app_metadata.role` of the Supabase user) that can run games.                                                                          |
| `SUPABASE_URL`                  |                                                                           | The Supabase project (the frontend's `VITE_SUPABASE_URL`).                                                                                       |
| `SUPABASE_ANON_KEY`             |                                                                           | The project's anon (public) key (the frontend's `VITE_SUPABASE_ANON_KEY`).                                                                       |
| `MAX_CONNECTIONS`               | `5000`                                                                    | Open connections, in all.                                                                                                                        |
| `MAX_CONNECTIONS_PER_IP`        | `100`                                                                     | Open connections from one address (a classroom on the same Wi-Fi shares one).                                                                    |
| `CONNECTIONS_PER_IP_PER_MINUTE` | `120`                                                                     | New connections from one address per minute (all at once, then evenly).                                                                          |
| `MAX_ROOMS`                     | `1000`                                                                    | Rooms open at once.                                                                                                                              |
| `MAX_DEVICES_PER_ROOM`          | `100`                                                                     | Devices in a room.                                                                                                                               |
| `MAX_MESSAGE_BYTES`             | `524288`                                                                  | The largest message a device can send (a game's questions in every language take far less).                                                      |
| `ADMIN_AWAY_TIMEOUT_MS`         | `60000`                                                                   | How long a room waits for an admin who went away before it closes.                                                                               |
| `INACTIVE_DEVICE_TIMEOUT_MS`    | `600000`                                                                  | How long a device whose connection is gone stays in its room.                                                                                    |
| `LOG_LEVEL`                     | `info`                                                                    | `debug`, `info`, `warn`, `error` or `silent`.                                                                                                    |

`.env.example` has them all. The server doesn't read `.env` files: set them in the environment
(Render's Environment tab).

## Deploying on Render

- **Build command:** `npm ci --omit=dev`
- **Start command:** `npm start`
- **Health check path:** `/health`
- **Environment:** `FRONTEND_URL` with the frontend's address(es), e.g.
  `https://your-app.vercel.app,https://www.your-domain.com` (scheme and domain). A page from any other origin
  can't connect, so check it before deploying: the server logs every origin it refuses
  (`Connection refused {"reason":"origin_not_allowed",...}`).

On Render, Cloudflare is in front of every web service and writes the caller's address in
`CF-Connecting-IP`, overwriting whatever the caller sent; the server uses it for its per-address
limits. Don't use `X-Forwarded-For`: the caller controls its first entry.

## Security

What the server does so that a client other than the frontend can't harm the game or the server:

- **Malformed events don't bring it down.** Every payload is checked before its handler runs
  (`realtime/validation.js`), and an error in a handler is logged instead of stopping the process
  (before, one malformed event stopped the server, and every room with it).
- **Only the frontend's pages connect.** The handshake's `Origin` must be one of `FRONTEND_URL`'s,
  for WebSocket connections too (CORS only covers polling).
- **Limits.** Connections in all and per address, new connections per address, rooms, devices per
  room, message size, and how often a connection can send each event. Past an event's limit it's
  dropped, except the ones that set a state (a vote, a setting): their last one waits until the
  limit lets it through. A connection far over its limits is dropped. Rooms not found from an
  address are limited too, so room codes can't be guessed.
- **A connection acts for its own device only.** The `deviceId` that `create-channel` and
  `join-channel` send is ignored. See [Device identity](#device-identity) for the device itself.
- **Admin actions need an admin's Supabase session** (opt-in with `REQUIRE_ADMIN_AUTH`, see
  [Admin sessions](#admin-sessions)): creating a room and running its game are the signed-in
  admin's, checked with Supabase on every token, not just when the room is created.
- **The answers stay on the server until the question is over.** The other devices only get a
  question's `correctAnswer` once someone answered it, its time is up, or the game moved past it
  (the admin, who loaded the questions, gets them all).
- **Only what the frontend has goes to the room.** Game settings keep their known fields only,
  questions are checked (shape and size), names and categories lose control characters, and the
  devices' connection ids stay on the server.
- **A device moves to another room by leaving its own**, so a device can't fill the server with
  rooms.
- **The log can't be forged or flooded.** Messages are fixed text, details are JSON (line breaks
  are escaped), long values are cut, and each message has a rate.
- **Dependencies.** Only `socket.io` (`npm audit`: no known vulnerabilities); `node_modules` isn't
  in the repository.
- **HTTP.** Security headers on every response, no framework banner, no Socket.IO client served.

### Device identity

Every device in a room sees the others' ids, so an id alone can't prove who a device is: any guest
could connect with the admin's id and take over the room. A frontend that keeps a **device token**
can't be impersonated:

1. On every connection it sends `deviceToken` in the handshake's `auth` (`null` the first time),
   with the `deviceId` it has.
2. The server answers with `device-session`: `{ deviceId, deviceToken }`. The device keeps both
   (a new device gets a random id from the server) and sends them on its next connections.
3. A device with a token can only be that device's: a connection without its token gets an
   identity of its own, and one from a frontend without tokens is refused.

Frontends without device tokens (no `deviceToken` key) keep working as before, with their own ids,
until `REQUIRE_DEVICE_TOKEN=true`; turn it on once every device runs a frontend that keeps tokens.

### Admin sessions

With `REQUIRE_ADMIN_AUTH=true`, only a signed-in admin creates a room and runs its game; the
guests need no session. The admin is a Supabase user whose `app_metadata.role` is `admin`
(`ADMIN_ROLE`). That field is only editable with the project's service role or SQL, never by the
user: `user_metadata` and a signed-up account prove nothing.

1. The device sends its Supabase access token (`session.access_token`) in the handshake's `auth`
   (`accessToken`), and again with `update-access-token` (`{ accessToken }`, `null` when it signed
   out) whenever the token changes: signing in, signing out, and Supabase's renewal every hour.
2. The server checks the token with Supabase's Auth API (`GET /auth/v1/user`, whatever keys the
   project signs tokens with), so a role taken away counts at the next token. It keeps the user,
   the role and the token's expiry on the connection, never the token, and never logs it.
3. `create-channel` needs a session of a user with the role, and the room belongs to that user.
4. The room's **admin actions** need the owner's session: `update-game-settings`, `start-game`,
   `close-category-vote`, `load-questions`, `next-question`, `reset-game` and `remove-device`. The
   admin's device must also be the room's (as before).

A refused action changes nothing and the device gets `channel-error`: `auth_required` (no valid
session), `auth_expired` (the token expired: Supabase's client renews it, and the frontend sends
the new one), or `admin_required` (a session without the role, or of another user than the room's
owner). Checks are limited per address (30 at once, then one every two seconds), and a value that
isn't shaped like a token is never sent to Supabase.

Before turning it on, make sure the Supabase project can't hand out admin sessions to anyone: the
database's user-management functions must not be callable with the public key, and new sign-ups
should be closed (or at least unable to get the role). The frontend must send the sessions
first (turning it on before refuses every room creation).

### Errors the frontend can get

Besides `device_not_found`, `channel_not_found` and `channel_already_exists`, `channel-error` can
be `invalid_channel_id`, `auth_required`, `auth_expired`, `admin_required`, `room_full`,
`too_many_rooms` and `rate_limited`. A
connection can be refused (`connect_error`) with `origin_not_allowed`, `too_many_connections`,
`too_many_new_connections`, `server_busy` and `device_token_required`.

### What it doesn't cover

- **Answers after the reveal.** The frontend shows every device the feedback once someone answered
  (usually the admin), and the guests send their answers right after. A modified client could wait
  for the right answer and send it then; preventing it needs the guests to send their pick with
  `guest-selected-answer`, before the reveal.
- **The state is in memory**: a restart closes every room. Running more than one instance would
  need a shared store and a Socket.IO adapter.
- **Clients that aren't browsers** can send any `Origin`: the limits are what holds them.
