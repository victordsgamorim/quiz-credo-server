import { DEFAULT_LOCALE } from "./constants.js";
import { isValidLocale } from "./locales.js";

// Far above what the frontend sends (at most 50 questions, 4 options each, in 3 languages), and
// low enough that a game's questions can't take the server's memory
const LIMITS = {
  questions: 100,
  locales: 10,
  idLength: 128,
  textLength: 2000,
  options: { min: 2, max: 10 },
  optionLength: 1000,
  labelLength: 64,
  points: 1000,
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isText = (value, maxLength, minLength = 1) =>
  typeof value === "string" && value.length >= minLength && value.length <= maxLength;

const isOptionalText = (value, maxLength) =>
  value === undefined || value === null || isText(value, maxLength);

const isQuestion = (question) => {
  if (!isPlainObject(question)) return false;
  const { id, options, correctAnswer, points } = question;
  return (
    (isText(id, LIMITS.idLength) || Number.isSafeInteger(id)) &&
    isText(question.question, LIMITS.textLength) &&
    Array.isArray(options) &&
    options.length >= LIMITS.options.min &&
    options.length <= LIMITS.options.max &&
    options.every((option) => isText(option, LIMITS.optionLength, 0)) &&
    Number.isInteger(correctAnswer) &&
    correctAnswer >= 0 &&
    correctAnswer < options.length &&
    Number.isFinite(points) &&
    points >= 0 &&
    points <= LIMITS.points &&
    isOptionalText(question.difficulty, LIMITS.labelLength) &&
    isOptionalText(question.category, LIMITS.labelLength)
  );
};

// The question with only what the game uses
const pickQuestion = ({ id, question, options, correctAnswer, difficulty, points, category }) => ({
  id,
  question,
  options: [...options],
  correctAnswer,
  difficulty,
  points,
  category,
});

const toQuestionList = (list) =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.length <= LIMITS.questions &&
  list.every(isQuestion)
    ? list.map(pickQuestion)
    : null;

// Every language has the same questions, in the same order, with the same right answers: the
// answers are checked against the default language's (the frontend checks it too)
const isSameGame = (lists, base) =>
  lists.every(
    (questions) =>
      questions.length === base.length &&
      questions.every(
        (question, index) =>
          question.correctAnswer === base[index].correctAnswer &&
          question.options.length === base[index].options.length
      )
  );

/**
 * A game's questions, as the admin's frontend sends them: every language's ({ [locale]: questions
 * }, the default language's among them), or one language's (an array, from older frontends)
 *
 * @param input - What the frontend sent
 * @returns The game's questions (the default language's) and every language's (a Map, null for
 *   one language), or null when they aren't a game's questions
 */
export const parseGameQuestions = (input) => {
  if (Array.isArray(input)) {
    const questions = toQuestionList(input);
    return questions && { questions, questionsByLocale: null };
  }
  if (!isPlainObject(input) || !Object.hasOwn(input, DEFAULT_LOCALE)) return null;

  const entries = Object.entries(input);
  if (entries.length > LIMITS.locales || !entries.every(([locale]) => isValidLocale(locale))) {
    return null;
  }
  const questionsByLocale = new Map();
  for (const [locale, list] of entries) {
    const questions = toQuestionList(list);
    if (!questions) return null;
    questionsByLocale.set(locale, questions);
  }

  const questions = questionsByLocale.get(DEFAULT_LOCALE);
  return isSameGame([...questionsByLocale.values()], questions)
    ? { questions, questionsByLocale }
    : null;
};
