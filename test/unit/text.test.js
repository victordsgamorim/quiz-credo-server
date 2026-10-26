import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeCategoryVote } from "../../src/domain/categories.js";
import { cleanText } from "../../src/domain/text.js";

describe("cleanText", () => {
  it("keeps names as they are", () => {
    assert.equal(cleanText("Ana Maria 🎉", 50), "Ana Maria 🎉");
    assert.equal(cleanText("👨‍👩‍👧 família", 50), "👨‍👩‍👧 família");
  });

  it("takes out control characters and the marks that reorder text", () => {
    assert.equal(cleanText("A\u0000n\na\u001b[31m", 50), "Ana[31m");
    assert.equal(cleanText("Ana‮evil⁦", 50), "Anaevil");
  });

  it("trims, and cuts at the length without splitting an emoji", () => {
    assert.equal(cleanText("  Ana  ", 50), "Ana");
    assert.equal(cleanText("abcdefgh", 4), "abcd");
    assert.equal(cleanText("abc🎉", 4), "abc");
  });

  it("is empty for anything that isn't text", () => {
    for (const value of [undefined, null, 42, {}, ["Ana"]]) {
      assert.equal(cleanText(value, 50), "");
    }
  });
});

describe("sanitizeCategoryVote", () => {
  it("keeps the first five categories, once each, without blank ones", () => {
    assert.deepEqual(
      sanitizeCategoryVote([
        "science",
        " history ",
        "science",
        "",
        "art",
        42,
        "music",
        "cinema",
        "x",
      ]),
      ["science", "history", "art", "music", "cinema"]
    );
  });
});
