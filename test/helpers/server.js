import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The server the tests run: this project's, or another entry point given by QUIZ_SERVER_ENTRY (a
// copy of an older version, to check that it behaves the same)
export const SERVER_ENTRY = process.env.QUIZ_SERVER_ENTRY
  ? path.resolve(process.env.QUIZ_SERVER_ENTRY)
  : path.join(ROOT, "server.js");

const STARTUP_TIMEOUT_MS = 5000;

// The servers still running, stopped when the tests' process exits (a failed test doesn't get to
// stop its server)
const running = new Set();
process.on("exit", () => running.forEach((child) => child.kill("SIGKILL")));

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const waitUntilListening = async (url, child) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      await fetch(url);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Server didn't start (exit code ${child.exitCode})`);
};

/**
 * Starts the server in its own process, on a free port
 *
 * @param {Record<string, string>} env - Environment variables for the server, on top of PORT
 * @returns The server's URL, its output so far, whether it still runs, and a way to stop it
 */
export const startServer = async (env = {}) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, NODE_ENV: "test", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitUntilListening(url, child);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${output}`);
  }

  return {
    url,
    output: () => output,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
};
