import { SECURITY_HEADERS } from "./securityHeaders.js";

const sendJson = (req, res, status, body) => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(req.method === "HEAD" ? undefined : json);
};

/**
 * The server's HTTP requests that aren't Socket.IO's (Socket.IO answers its own): a health check
 * for the hosting (GET /health), and 404 for anything else
 *
 * @param req - The request
 * @param res - Its response
 */
export const handleHttpRequest = (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if ((req.method === "GET" || req.method === "HEAD") && path === "/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }
  sendJson(req, res, 404, { error: "not_found" });
};
