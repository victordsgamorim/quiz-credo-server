import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("has defaults for development", () => {
    const config = loadConfig({});
    assert.equal(config.port, 3001);
    assert.deepEqual(config.allowedOrigins, [
      "http://localhost:3001",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
    assert.equal(config.clientIpHeader, "");
    assert.equal(config.requireDeviceToken, false);
    assert.equal(config.requireAdminAuth, false);
    assert.equal(config.adminRole, "admin");
    assert.equal(config.supabase, null);
  });

  it("takes the frontend's origins, the way browsers send them", () => {
    const { allowedOrigins } = loadConfig({
      FRONTEND_URL: " https://Quiz.example/ ,https://quiz.example/play, http://localhost:5173/,",
    });
    assert.deepEqual(allowedOrigins, ["https://quiz.example", "http://localhost:5173"]);
  });

  it("trusts Cloudflare's client address header on Render", () => {
    assert.equal(loadConfig({ RENDER: "true" }).clientIpHeader, "cf-connecting-ip");
    assert.equal(
      loadConfig({ RENDER: "true", CLIENT_IP_HEADER: "X-Real-IP" }).clientIpHeader,
      "x-real-ip"
    );
  });

  it("needs the Supabase project to require the admins' sessions", () => {
    assert.throws(() => loadConfig({ REQUIRE_ADMIN_AUTH: "true" }), ConfigError);
    assert.throws(
      () =>
        loadConfig({
          REQUIRE_ADMIN_AUTH: "true",
          SUPABASE_URL: "http://project.supabase.co",
          SUPABASE_ANON_KEY: "key",
        }),
      ConfigError,
      "only over HTTPS"
    );
    const { supabase } = loadConfig({
      REQUIRE_ADMIN_AUTH: "true",
      SUPABASE_URL: "https://project.supabase.co/",
      SUPABASE_ANON_KEY: "key",
    });
    assert.deepEqual(supabase, { url: "https://project.supabase.co", anonKey: "key" });
  });

  it("takes the role of the admins, and refuses the option's old name", () => {
    assert.equal(loadConfig({ ADMIN_ROLE: " host " }).adminRole, "host");
    assert.throws(() => loadConfig({ ADMIN_ROLE: "ad min" }), ConfigError);
    assert.throws(() => loadConfig({ REQUIRE_AUTH_TO_CREATE_ROOM: "false" }), /REQUIRE_ADMIN_AUTH/);
  });

  it("refuses invalid values", () => {
    const invalid = [
      { PORT: "http" },
      { PORT: "70000" },
      { MAX_ROOMS: "0" },
      { MAX_ROOMS: "1.5" },
      { REQUIRE_DEVICE_TOKEN: "yes" },
      { LOG_LEVEL: "verbose" },
      { FRONTEND_URL: "not a url" },
      { FRONTEND_URL: "ftp://quiz.example" },
    ];
    invalid.forEach((env) => assert.throws(() => loadConfig(env), ConfigError));
  });
});
