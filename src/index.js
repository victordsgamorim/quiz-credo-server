import { createServer } from "node:http";

import { ConfigError, loadConfig } from "./config.js";
import { handleHttpRequest } from "./http/handleHttpRequest.js";
import { createLogger } from "./logger.js";
import { createSocketServer } from "./realtime/createSocketServer.js";

const STATS_INTERVAL_MS = 30000;
// A client gets this long to send a request's headers, and the whole request (a WebSocket's
// upgrade, a polling request): a slow client can't hold connections open for minutes
const HEADERS_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;

const loadConfigOrExit = () => {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`Invalid configuration: ${error.message}`);
    process.exit(1);
  }
};

const config = loadConfigOrExit();
const logger = createLogger({ level: config.logLevel });

process.on("unhandledRejection", (error) => logger.error("Unhandled rejection", { error }));
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception: the server stops", { error });
  process.exit(1);
});

const httpServer = createServer(handleHttpRequest);
httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
const { store } = createSocketServer(httpServer, { config, logger });

httpServer.listen(config.port, config.host, () => {
  logger.info("Socket.IO server running", {
    port: httpServer.address().port,
    environment: config.environment,
    allowedOrigins: config.allowedOrigins,
    clientIpHeader: config.clientIpHeader || null,
    requireDeviceToken: config.requireDeviceToken,
    requireAuthToCreateRoom: config.requireAuthToCreateRoom,
  });
});

setInterval(() => {
  logger.info("Server stats", {
    channels: store.channels.size,
    devices: store.devices.size,
  });
}, STATS_INTERVAL_MS);
