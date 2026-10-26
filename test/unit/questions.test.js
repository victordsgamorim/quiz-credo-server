import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGameQuestions } from "../../src/domain/questions.js";
import { questionsByLocale } from "../helpers/fixtures.js";

const question = { id: "q1", question: "?", options: ["a", "b"], correctAnswer: 1, points: 10 };

describe("parseGameQuestions", () => {
  it("takes every language's questions, the default language's for the game", () => {
    const game = parseGameQuestions(questionsByLocale());
    assert.equal(game.questions.length, 3);
    assert.deepEqual([...game.questionsByLocale.keys()], ["pt-BR", "en-UK", "es-BO"]);
    assert.equal(game.questions, game.questionsByLocale.get("pt-BR"));
    assert.equal(game.questionsByLocale.get("en-UK")[0].question, "en: question 1?");
  });

  it("takes one language's questions (older frontends)", () => {
    const game = parseGameQuestions([question]);
    assert.deepEqual(game, {
      questions: [{ ...question, difficulty: undefined, category: undefined }],
      questionsByLocale: null,
    });
  });

  it("keeps only what the game uses of a question", () => {
    const [kept] = parseGameQuestions([
      { ...question, html: "<img>", __proto__: { x: 1 } },
    ]).questions;
    assert.deepEqual(Object.keys(kept).sort(), [
      "category",
      "correctAnswer",
      "difficulty",
      "id",
      "options",
      "points",
      "question",
    ]);
  });

  const invalidGames = {
    nothing: undefined,
    "a number": 5,
    "a string": "questions",
    "no questions": [],
    "too many questions": Array.from({ length: 101 }, () => question),
    "a question that isn't an object": [null],
    "a right answer out of the options": [{ ...question, correctAnswer: 2 }],
    "a right answer that isn't a whole number": [{ ...question, correctAnswer: 0.5 }],
    "a single option": [{ ...question, options: ["a"], correctAnswer: 0 }],
    "options that aren't a list": [{ ...question, options: "ab" }],
    "an option that isn't text": [{ ...question, options: ["a", {}] }],
    "too long a question": [{ ...question, question: "?".repeat(2001) }],
    "an empty question": [{ ...question, question: "" }],
    "an id that isn't one": [{ ...question, id: { id: 1 } }],
    "too many points": [{ ...question, points: 1e9 }],
    "negative points": [{ ...question, points: -10 }],
    "points that aren't a number": [{ ...question, points: "10" }],
    "a category that isn't text": [{ ...question, category: ["science"] }],
    "languages without the default one": { "en-UK": [question] },
    "a language code that isn't one": { "pt-BR": [question], __proto__x: [question] },
    "too many languages": Object.fromEntries(
      ["pt-BR", "aa", "ab", "ac", "ad", "ae", "af", "ag", "ah", "ai", "aj"].map((locale) => [
        locale,
        [question],
      ])
    ),
    "languages with different questions": {
      "pt-BR": [question],
      "en-UK": [{ ...question, correctAnswer: 0 }],
    },
    "languages with a different number of questions": {
      "pt-BR": [question],
      "en-UK": [question, question],
    },
  };
  for (const [name, input] of Object.entries(invalidGames)) {
    it(`refuses ${name}`, () => {
      assert.equal(parseGameQuestions(input), null);
    });
  }

  it("doesn't take the default language from an object's prototype", () => {
    assert.equal(parseGameQuestions(Object.create({ "pt-BR": [question] })), null);
  });
});
