import { connect, markAll } from "./client.js";

export const POWER_UP_IDS = ["bonus", "break", "freeze", "shield", "steal"];

// Game settings as the frontend's settings dialogs send them. Every power-up is enabled and each
// player gets all of them, so the tests know every hand
export const gameSettings = (overrides = {}) => ({
  questionCount: 10,
  timerDuration: 60,
  maxCategorySelections: 5,
  topCategoriesCount: 10,
  lowTimeThreshold: 10,
  criticalTimeThreshold: 5,
  streakThreshold: 2,
  enableQuestionCache: true,
  enableDebugMode: false,
  powerUps: {
    isEnabled: true,
    handSize: 5,
    enabled: { freeze: true, steal: true, shield: true, break: true, bonus: true },
    freezeQuestions: 2,
    stealPoints: 20,
    bonusPoints: 60,
  },
  ...overrides,
});

// Question n (from 1) has its right answer at index (n - 1) % 4, and is worth 10 * n points
const makeQuestions = (lang, count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`,
    question: `${lang}: question ${index + 1}?`,
    options: ["A", "B", "C", "D"].map((letter) => `${lang} ${letter}${index + 1}`),
    correctAnswer: index % 4,
    difficulty: `level${(index % 5) + 1}`,
    points: 10 * ((index % 5) + 1),
    category: "science",
  }));

// The game's questions in every locale, as the admin's frontend loads them
export const questionsByLocale = (count = 3) => ({
  "pt-BR": makeQuestions("pt", count),
  "en-UK": makeQuestions("en", count),
  "es-BO": makeQuestions("es", count),
});

export const ROOM_ID = "ROOM23";

/**
 * Opens a room: its admin creates it, then each guest joins it
 *
 * @param server - The server, from startServer
 * @param options - The room's id, its admin's handshake auth, and its guests'
 * @returns The connected admin and guests
 */
export const openRoom = async (
  server,
  {
    channelId = ROOM_ID,
    admin = { deviceId: "device_admin", locale: "pt-BR" },
    guests = [
      { deviceId: "device_ana", locale: "en-UK", displayName: "Ana" },
      { deviceId: "device_bia", locale: "pt-BR", displayName: "Bia" },
    ],
  } = {}
) => {
  const adminClient = await connect(server, { auth: admin });
  adminClient.mark().emit("create-channel", channelId, admin.deviceId, { displayName: "Host" });
  await adminClient.waitFor("joined-channel");

  const guestClients = [];
  for (const { displayName, ...auth } of guests) {
    const guest = await connect(server, { auth });
    guest.mark().emit("join-channel", channelId, auth.deviceId, { displayName });
    await guest.waitFor("joined-channel");
    guestClients.push(guest);
  }
  return { channelId, admin: adminClient, guests: guestClients };
};

/**
 * Gets every guest ready, starts the room's game and loads its questions
 *
 * @param room - The room, from openRoom
 * @param options - The game's settings and questions
 */
export const startGame = async (
  { channelId, admin, guests },
  { settings = gameSettings(), questions = questionsByLocale() } = {}
) => {
  for (const guest of guests) {
    admin.mark();
    guest.emit("update-ready-state", { channelId, isReady: true });
    await admin.waitFor("channel-update", (state) =>
      state.devices.some((device) => device.id === guest.deviceId && device.isReady)
    );
  }

  markAll(admin, ...guests);
  admin.emit("start-game", { channelId, settings });
  await Promise.all([admin, ...guests].map((client) => client.waitFor("game-started")));

  markAll(admin, ...guests);
  admin.emit("load-questions", { channelId, questions });
  await Promise.all(
    [admin, ...guests].map((client) =>
      client.waitFor("channel-update", (state) => state.gameState?.questions.length > 0)
    )
  );
};
