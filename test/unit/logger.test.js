import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger } from "../../src/logger.js";

const createSink = () => {
  const lines = [];
  const write = (line) => lines.push(line);
  return { lines, sink: { log: write, warn: write, error: write } };
};

describe("createLogger", () => {
  it("writes one line per entry, whatever a device sent in its details", () => {
    const { lines, sink } = createSink();
    const logger = createLogger({ sink });
    logger.warn("Device joined", { displayName: "Eve\n[2026-01-01] INFO Forged entry\u001b[31m" });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("\n"), false);
    assert.match(
      lines[0],
      /WARN Device joined \{"displayName":"Eve\\n\[2026-01-01\] INFO Forged entry\\u001b\[31m"\}$/
    );
  });

  it("cuts long details, and deep or cyclic ones", () => {
    const { lines, sink } = createSink();
    const logger = createLogger({ sink });
    const cyclic = { name: "x" };
    cyclic.self = cyclic;
    logger.info("Details", { long: "x".repeat(1000), cyclic });
    assert.ok(lines[0].length < 600);
  });

  it("leaves out the levels below its own", () => {
    const { lines, sink } = createSink();
    const logger = createLogger({ level: "warn", sink });
    logger.debug("Debug");
    logger.info("Info");
    logger.warn("Warn");
    assert.equal(lines.length, 1);
  });

  it("writes a message a limited number of times in a row", () => {
    const { lines, sink } = createSink();
    const logger = createLogger({ sink });
    for (let index = 0; index < 500; index++) logger.warn("Refused", { index });
    logger.warn("Another message");
    assert.equal(lines.filter((line) => line.includes("Refused")).length, 50);
    assert.equal(lines.filter((line) => line.includes("Another message")).length, 1);
  });
});
