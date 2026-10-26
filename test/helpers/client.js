import { io } from "socket.io-client";

const DEFAULT_TIMEOUT_MS = 2000;

const describeEvents = (events) => events.map(({ event }) => event).join(", ") || "none";

/**
 * A connected test device: it records every event the server sends it, so a test can wait for
 * one or check that none came. Call mark() before an action, then wait for what it sends: only
 * the events received since the last mark count.
 */
export class TestClient {
  constructor(socket, deviceId) {
    this.socket = socket;
    this.deviceId = deviceId;
    this.deviceToken = undefined;
    this.events = [];
    this.cursor = 0;
    this.listeners = new Set();
    socket.onAny((event, ...args) => {
      // The identity the server gives the device (a client that keeps a device token)
      if (event === "device-session") {
        this.deviceId = args[0].deviceId;
        this.deviceToken = args[0].deviceToken;
      }
      this.events.push({ event, args });
      this.listeners.forEach((listener) => listener());
    });
  }

  mark() {
    this.cursor = this.events.length;
    return this;
  }

  emit(event, ...args) {
    this.socket.emit(event, ...args);
    return this;
  }

  // The payloads of the events named `event` received since the last mark
  received(event) {
    return this.events
      .slice(this.cursor)
      .filter((entry) => entry.event === event)
      .map((entry) => entry.args[0]);
  }

  // The latest payload of the events named `event`, whenever it came
  last(event) {
    const entry = this.events.findLast((candidate) => candidate.event === event);
    return entry?.args[0];
  }

  find(event, predicate) {
    return this.events
      .slice(this.cursor)
      .find((entry) => entry.event === event && predicate(entry.args[0]))?.args[0];
  }

  // The first event named `event` since the last mark whose payload matches the predicate
  waitFor(event, predicate = () => true, timeout = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const payload = this.find(event, predicate);
        if (payload === undefined) return false;
        cleanUp();
        resolve(payload);
        return true;
      };
      const timer = setTimeout(() => {
        cleanUp();
        const since = this.events.slice(this.cursor);
        reject(new Error(`No matching "${event}" in ${timeout}ms (got: ${describeEvents(since)})`));
      }, timeout);
      const cleanUp = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      if (!check()) this.listeners.add(check);
    });
  }

  // Fails if an event named `event` matching the predicate comes within `ms`
  async expectNone(event, predicate = () => true, ms = 300) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const payload = this.find(event, predicate);
    if (payload !== undefined) {
      throw new Error(`Unexpected "${event}": ${JSON.stringify(payload)}`);
    }
  }

  close() {
    this.socket.close();
  }
}

/**
 * Connects a device to the server, the way the frontend does (its handshake's auth)
 *
 * @param server - The server, from startServer
 * @param options - The handshake's auth, and the Origin and transport to connect with
 * @returns The connected device
 */
export const connect = (server, { auth = {}, origin, transports = ["websocket"] } = {}) =>
  new Promise((resolve, reject) => {
    const socket = io(server.url, {
      auth,
      transports,
      forceNew: true,
      reconnection: false,
      timeout: DEFAULT_TIMEOUT_MS,
      ...(origin ? { extraHeaders: { origin } } : {}),
    });
    const client = new TestClient(socket, auth.deviceId);
    socket.once("connect", () => resolve(client));
    socket.once("connect_error", (error) => {
      socket.close();
      reject(error);
    });
  });

export const markAll = (...clients) => clients.forEach((client) => client.mark());

export const closeAll = (...clients) => clients.forEach((client) => client?.close());
