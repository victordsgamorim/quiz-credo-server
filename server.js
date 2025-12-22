import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import os from "os";

const app = express();
const httpServer = createServer(app);

app.use(cors());

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",")
  : ["http://localhost:3001", "http://localhost:5173", "http://127.0.0.1:5173"];

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ["websocket", "polling"],
});

const MAX_CATEGORY_SELECTIONS = 5;

const channels = new Map(); // channelId -> { adminId: string, devices: Set<string>, votes: Map<string, Set<string>>, isVotingClosed: boolean, gameSettings: GameSettings }
const connectedDevices = new Map(); // deviceId -> device info
const socketToDevice = new Map();

/**
 * Validates game settings object
 */
const validateGameSettings = (settings) => {
  if (!settings || typeof settings !== "object") {
    return false;
  }

  const limits = {
    questionCount: { min: 10, max: 50 },
    timerDuration: { min: 60, max: 300 },
    maxCategorySelections: { min: 3, max: 10 },
    topCategoriesCount: { min: 5, max: 15 },
    lowTimeThreshold: { min: 5, max: 20 },
    criticalTimeThreshold: { min: 3, max: 10 },
  };

  // Validate timerDuration (can be null)
  if (settings.timerDuration !== null && typeof settings.timerDuration !== "number") {
    return false;
  }

  if (
    settings.timerDuration !== null &&
    (settings.timerDuration < limits.timerDuration.min ||
      settings.timerDuration > limits.timerDuration.max)
  ) {
    return false;
  }

  // Validate other numeric fields
  for (const [key, limit] of Object.entries(limits)) {
    if (key === "timerDuration") continue; // Already validated

    const value = settings[key];
    if (typeof value !== "number" || value < limit.min || value > limit.max) {
      console.warn(`Invalid game setting ${key}: ${value} (expected ${limit.min}-${limit.max})`);
      return false;
    }
  }

  return true;
};

const buildDevicePayload = (device) => ({
  id: device.id,
  connectedAt: device.connectedAt,
  channel: device.channel,
  isActive: device.isActive,
  socketId: device.socketId,
  role: device.role || "guest",
  displayName: device.displayName || device.id,
  isReady: Boolean(device.isReady),
  locale: device.locale || "pt-BR",
});

const sanitizeCategoryName = (name) => {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim().substring(0, 50);
};

const getChannelDevices = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return [];
  }

  return Array.from(channel.devices || [])
    .map((id) => connectedDevices.get(id))
    .filter((device) => device != null)
    .map(buildDevicePayload);
};

const getCategoryTotals = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel || !channel.votes) {
    return [];
  }

  const counts = new Map();
  channel.votes.forEach((selection) => {
    selection.forEach((category) => {
      const key = sanitizeCategoryName(category);
      if (!key) {
        return;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .map(([name, votes]) => ({ name, votes }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }
      return a.name.localeCompare(b.name);
    });
};

const getChannelState = (channelId) => {
  const devices = getChannelDevices(channelId);
  const channel = channels.get(channelId);
  const categoryTotals = getCategoryTotals(channelId).slice(0, 10);

  return {
    channelId,
    devices,
    totalDevices: devices.length,
    adminId: channel?.adminId || null,
    categoryTotals,
    maxCategorySelections: channel?.gameSettings?.maxCategorySelections || MAX_CATEGORY_SELECTIONS,
    gameSettings: channel?.gameSettings || null,
    isVotingClosed: Boolean(channel?.isVotingClosed),
    isGameStarted: Boolean(channel?.isGameStarted),
    gameState: channel?.gameState
      ? {
          questions: channel.gameState.questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options,
            difficulty: q.difficulty,
            points: q.points,
            category: q.category,
            correctAnswer: q.correctAnswer,
          })),
          currentQuestionIndex: channel.gameState.currentQuestionIndex,
          timerRemaining: channel.gameState.timerRemaining,
          isShowingResults: channel.gameState.isShowingResults,
        }
      : null,
  };
};

const broadcastChannelUpdate = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel) return;

  // If multilingual questions exist, send personalized updates to each device
  if (channel.gameState?.questionsByLocale) {
    console.log(`[${new Date().toISOString()}] Broadcasting multilingual questions to channel ${channelId}`);
    const devices = Array.from(channel.devices || []);
    devices.forEach((deviceId) => {
      const device = connectedDevices.get(deviceId);
      if (device && device.socketId) {
        const deviceLocale = device.locale || "pt-BR";
        console.log(`  - Sending ${deviceLocale} questions to device ${deviceId}`);
        const personalizedState = getChannelStateForLocale(channelId, deviceLocale);
        const socket = io.sockets.sockets.get(device.socketId);
        if (socket) {
          socket.emit("channel-update", personalizedState);
        }
      }
    });
  } else {
    // Legacy: broadcast same state to all
    console.log(`[${new Date().toISOString()}] Broadcasting same state to all devices in channel ${channelId}`);
    io.to(channelId).emit("channel-update", getChannelState(channelId));
  }
};

const getChannelStateForLocale = (channelId, locale) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return null;
  }

  const devices = getChannelDevices(channelId);
  const categoryTotals = getCategoryTotals(channelId);

  // Get questions for the specific locale
  const questionsForLocale =
    channel.gameState?.questionsByLocale?.[locale] || channel.gameState?.questions || [];

  return {
    channelId,
    devices,
    totalDevices: devices.length,
    adminId: channel.adminId,
    categoryTotals,
    maxCategorySelections: channel.gameSettings?.maxCategorySelections || MAX_CATEGORY_SELECTIONS,
    gameSettings: channel.gameSettings || null,
    isVotingClosed: Boolean(channel?.isVotingClosed),
    isGameStarted: Boolean(channel?.isGameStarted),
    gameState: channel?.gameState
      ? {
          questions: questionsForLocale.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options,
            difficulty: q.difficulty,
            points: q.points,
            category: q.category,
            correctAnswer: q.correctAnswer,
          })),
          currentQuestionIndex: channel.gameState.currentQuestionIndex,
          timerRemaining: channel.gameState.timerRemaining,
          isShowingResults: channel.gameState.isShowingResults,
        }
      : null,
  };
};

const removeDeviceFromChannel = (deviceId, reason, options = {}) => {
  const device = connectedDevices.get(deviceId);
  if (!device || !device.channel) {
    return;
  }

  const channelId = device.channel;
  const channel = channels.get(channelId);
  if (!channel) {
    device.channel = null;
    device.role = "guest";
    return;
  }

  channel.devices.delete(deviceId);
  channel.votes?.delete(deviceId);
  device.channel = null;
  device.role = "guest";
  device.isReady = false;

  const socketInstance = io.sockets.sockets.get(device.socketId);
  if (socketInstance) {
    socketInstance.leave(channelId);
  }

  if (reason && device.socketId) {
    io.to(device.socketId).emit("force-leave-channel", {
      channelId,
      reason,
    });
  }

  if (channel.devices.size === 0) {
    channels.delete(channelId);
  } else if (!options.suppressUpdate) {
    broadcastChannelUpdate(channelId);
  }
};

const forceCloseChannel = (channelId, reason, { notifyAdmin = false } = {}) => {
  const channel = channels.get(channelId);
  if (!channel) {
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Force closing channel ${channelId} (reason: ${reason})`
  );

  // Limpar timer do jogo se existir
  if (channel.gameState?.timerInterval) {
    clearInterval(channel.gameState.timerInterval);
  }

  const members = Array.from(channel.devices);

  members.forEach((deviceId) => {
    const shouldNotify = deviceId === channel.adminId ? notifyAdmin : true;
    removeDeviceFromChannel(deviceId, shouldNotify ? reason : undefined, { suppressUpdate: true });
  });

  channels.delete(channelId);
};

const startQuestionTimer = (channelId) => {
  const channel = channels.get(channelId);
  if (!channel || !channel.gameState) return;

  // Limpar timer anterior se existir
  if (channel.gameState.timerInterval) {
    clearInterval(channel.gameState.timerInterval);
  }

  // Se timerDuration é null, não iniciar timer (sem limite de tempo)
  const timerDuration = channel.gameSettings?.timerDuration;
  if (timerDuration === null) {
    console.log(`[${new Date().toISOString()}] No timer for channel ${channelId} (unlimited time)`);
    return;
  }

  // Timer de 1 segundo
  channel.gameState.timerInterval = setInterval(() => {
    if (!channels.has(channelId)) {
      clearInterval(channel.gameState.timerInterval);
      return;
    }

    const currentChannel = channels.get(channelId);
    if (currentChannel.gameState.timerRemaining > 0) {
      currentChannel.gameState.timerRemaining--;
      broadcastChannelUpdate(channelId);
    } else {
      // Timer expirou
      clearInterval(currentChannel.gameState.timerInterval);
      currentChannel.gameState.timerInterval = null;

      // Emitir evento de timeout
      io.to(channelId).emit("question-timeout", {
        questionIndex: currentChannel.gameState.currentQuestionIndex,
      });
    }
  }, 1000);
};

const calculateRanking = (channel) => {
  const ranking = [];

  console.log(
    `[${new Date().toISOString()}] Calculating ranking for ${channel.gameState.answers.size} devices`
  );

  channel.gameState.answers.forEach((answers, deviceId) => {
    const device = connectedDevices.get(deviceId);
    if (!device) {
      console.warn(`Device ${deviceId} not found in connectedDevices`);
      return;
    }

    const totalPoints = answers.reduce((sum, a) => sum + a.points, 0);
    const correctAnswers = answers.filter((a) => a.isCorrect).length;
    const totalAnswers = answers.length;
    const accuracy = totalAnswers > 0 ? (correctAnswers / totalAnswers) * 100 : 0;

    console.log(
      `  ${device.displayName} (${device.role}): ${totalPoints} pts, ${correctAnswers}/${totalAnswers} correct`
    );

    ranking.push({
      deviceId,
      displayName: device.displayName,
      role: device.role,
      totalPoints,
      correctAnswers,
      totalAnswers,
      accuracy: Math.round(accuracy),
    });
  });

  // Ordenar por pontos (maior para menor)
  ranking.sort((a, b) => b.totalPoints - a.totalPoints);

  // Adicionar posição
  ranking.forEach((entry, index) => {
    entry.position = index + 1;
  });

  console.log(`[${new Date().toISOString()}] Final ranking:`, JSON.stringify(ranking, null, 2));

  return ranking;
};

io.on("connection", (socket) => {
  const persistentDeviceId = socket.handshake.auth.deviceId || socket.id;
  const deviceLocale = socket.handshake.auth.locale || "pt-BR";

  console.log(
    `[${new Date().toISOString()}] Device connected: ${persistentDeviceId} (socket: ${socket.id}, locale: ${deviceLocale})`
  );

  socketToDevice.set(socket.id, persistentDeviceId);

  connectedDevices.set(persistentDeviceId, {
    id: persistentDeviceId,
    socketId: socket.id,
    connectedAt: Date.now(),
    channel: null,
    isActive: true,
    role: "guest",
    displayName: null,
    isReady: false,
    locale: deviceLocale,
  });

  socket.on("create-channel", (channelId, deviceId, options = {}) => {
    const actualDeviceId = deviceId || persistentDeviceId;
    console.log(
      `[${new Date().toISOString()}] Device ${actualDeviceId} creating channel: ${channelId}`
    );

    const device = connectedDevices.get(actualDeviceId);
    if (!device) {
      console.warn(
        `[${new Date().toISOString()}] Unknown device tried to create channel: ${actualDeviceId}`
      );
      socket.emit("channel-error", { error: "device_not_found" });
      return;
    }

    // Check if channel already exists
    if (channels.has(channelId)) {
      console.warn(`[${new Date().toISOString()}] Channel ${channelId} already exists`);
      socket.emit("channel-error", { error: "channel_already_exists" });
      return;
    }

    const { displayName } = options || {};
    if (displayName && typeof displayName === "string") {
      device.displayName = displayName.trim().substring(0, 50);
    }

    // Create new channel
    const channel = {
      adminId: actualDeviceId,
      devices: new Set(),
      votes: new Map(),
      isVotingClosed: false,
      isGameStarted: false,
      gameState: {
        questions: [],
        currentQuestionIndex: 0,
        questionStartTime: null,
        timerRemaining: 60,
        timerInterval: null,
        answers: new Map(),
        isShowingResults: false,
      },
    };
    channels.set(channelId, channel);

    channel.devices.add(actualDeviceId);
    device.channel = channelId;
    device.socketId = socket.id;
    device.role = "admin";
    device.isReady = false;

    socket.join(channelId);

    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} created with admin ${actualDeviceId}`
    );

    const deviceLocale = device.locale || "pt-BR";
    socket.emit("joined-channel", getChannelStateForLocale(channelId, deviceLocale));
  });

  socket.on("join-channel", (channelId, deviceId, options = {}) => {
    const actualDeviceId = deviceId || persistentDeviceId;
    console.log(
      `[${new Date().toISOString()}] Device ${actualDeviceId} joining channel: ${channelId}`
    );

    const device = connectedDevices.get(actualDeviceId);
    if (!device) {
      console.warn(`[${new Date().toISOString()}] Unknown device tried to join: ${actualDeviceId}`);
      socket.emit("channel-error", { error: "device_not_found" });
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      console.warn(`[${new Date().toISOString()}] Channel ${channelId} does not exist`);
      socket.emit("channel-error", { error: "channel_not_found" });
      return;
    }

    const { displayName } = options || {};
    if (displayName && typeof displayName === "string") {
      device.displayName = displayName.trim().substring(0, 50);
    }

    channel.votes = channel.votes || new Map();
    channel.isVotingClosed = Boolean(channel.isVotingClosed);
    channel.isGameStarted = Boolean(channel.isGameStarted);

    channel.devices.add(actualDeviceId);
    device.channel = channelId;
    device.socketId = socket.id;
    device.role = channel.adminId === actualDeviceId ? "admin" : "guest";
    device.isReady = false;

    socket.join(channelId);

    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} now has ${channel.devices.size} devices:`,
      Array.from(channel.devices).map(
        (id) => `${id} (${connectedDevices.get(id)?.role || "guest"})`
      )
    );

    broadcastChannelUpdate(channelId);

    const deviceLocale = device.locale || "pt-BR";
    socket.emit("joined-channel", getChannelStateForLocale(channelId, deviceLocale));
  });

  socket.on("leave-channel", (channelId) => {
    const device = connectedDevices.get(persistentDeviceId);
    const activeChannel = device?.channel || channelId;

    if (!device || !activeChannel) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to leave but no active channel`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} leaving channel: ${activeChannel}`
    );

    const channel = channels.get(activeChannel);
    if (channel && channel.adminId === persistentDeviceId) {
      forceCloseChannel(activeChannel, "admin_left");
    } else {
      removeDeviceFromChannel(persistentDeviceId);
    }
  });

  socket.on("device-status", (status) => {
    const device = connectedDevices.get(persistentDeviceId);
    if (device) {
      device.isActive = status.isActive;

      if (device.channel) {
        broadcastChannelUpdate(device.channel);
      }
    }
  });

  socket.on("update-category-vote", ({ channelId, categories }) => {
    if (!channelId || !Array.isArray(categories)) {
      return;
    }

    const device = connectedDevices.get(persistentDeviceId);
    if (!device || device.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} attempted category vote without channel`
      );
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }

    if (channel.isVotingClosed) {
      console.warn(
        `[${new Date().toISOString()}] Vote ignored because channel ${channelId} voting closed`
      );
      return;
    }

    const sanitizedSelections = [];
    const used = new Set();

    for (const rawCategory of categories) {
      if (sanitizedSelections.length >= MAX_CATEGORY_SELECTIONS) {
        break;
      }
      const cleanName = sanitizeCategoryName(rawCategory);
      if (!cleanName || used.has(cleanName)) {
        continue;
      }
      sanitizedSelections.push(cleanName);
      used.add(cleanName);
    }

    channel.votes = channel.votes || new Map();
    channel.votes.set(persistentDeviceId, new Set(sanitizedSelections));
    broadcastChannelUpdate(channelId);
  });

  socket.on("update-ready-state", ({ channelId, isReady }) => {
    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} updating ready state to ${isReady} in channel ${channelId}`
    );

    if (!channelId) {
      console.warn(`[${new Date().toISOString()}] No channelId provided`);
      return;
    }

    const device = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!device || !channel || device.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid device or channel state for ${persistentDeviceId}`
      );
      return;
    }

    if (channel.isGameStarted) {
      console.warn(`[${new Date().toISOString()}] Game already started, cannot update ready state`);
      return;
    }

    device.isReady = Boolean(isReady);
    console.log(
      `[${new Date().toISOString()}] Device ${persistentDeviceId} (${device.displayName}) is now ${device.isReady ? "READY" : "NOT READY"}`
    );
    broadcastChannelUpdate(channelId);
  });

  socket.on("close-category-vote", ({ channelId }) => {
    if (!channelId) {
      return;
    }

    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid close-category-vote attempt by ${persistentDeviceId}`
      );
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to close voting without admin role`
      );
      return;
    }

    if (channel.isVotingClosed) {
      return;
    }

    channel.isVotingClosed = true;
    console.log(
      `[${new Date().toISOString()}] Channel ${channelId} voting closed by admin ${persistentDeviceId}`
    );
    broadcastChannelUpdate(channelId);
  });

  socket.on("start-game", ({ channelId, settings }) => {
    if (!channelId) {
      return;
    }
    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to start game without admin role`
      );
      return;
    }

    const devices = getChannelDevices(channelId);
    const guestDevices = devices.filter((device) => device.role === "guest");
    if (guestDevices.length === 0) {
      console.warn(
        `[${new Date().toISOString()}] Admin ${persistentDeviceId} tried to start game without any guests`
      );
      return;
    }
    const allGuestsReady = guestDevices.every((device) => device.isReady);
    if (!allGuestsReady) {
      console.warn(
        `[${new Date().toISOString()}] Admin ${persistentDeviceId} tried to start game but not all guests are ready`
      );
      return;
    }

    // Validate and store game settings
    if (settings && validateGameSettings(settings)) {
      channel.gameSettings = settings;
      console.log(`[${new Date().toISOString()}] Game settings configured for channel ${channelId}:`, settings);
    } else if (settings) {
      console.warn(`[${new Date().toISOString()}] Invalid game settings provided, using defaults`);
      channel.gameSettings = null;
    }

    channel.isGameStarted = true;
    io.to(channelId).emit("game-started", { channelId, devices });
    broadcastChannelUpdate(channelId);
  });

  // Update game settings in real-time (before game starts)
  socket.on("update-game-settings", ({ channelId, settings }) => {
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      console.warn(`Device ${persistentDeviceId} tried to update settings but is not in channel ${channelId}`);
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      console.warn(`Channel ${channelId} not found`);
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin ${persistentDeviceId} tried to update game settings`);
      return;
    }

    if (channel.isGameStarted) {
      console.warn(`Cannot update settings after game started in channel ${channelId}`);
      return;
    }

    // Validate and update settings
    if (settings && validateGameSettings(settings)) {
      channel.gameSettings = settings;
      console.log(`[${new Date().toISOString()}] Game settings updated for channel ${channelId}:`, settings);
      // Broadcast updated settings to all clients in the channel
      broadcastChannelUpdate(channelId);
    } else {
      console.warn(`[${new Date().toISOString()}] Invalid game settings provided:`, settings);
    }
  });

  socket.on("load-questions", (payload) => {
    const { channelId, questions } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin tried to load questions: ${persistentDeviceId}`);
      return;
    }

    if (!channel.isGameStarted) {
      console.warn(`Game not started yet`);
      return;
    }

    // Check if questions is multilingual (object with locale keys) or single locale array
    const isMultilingual =
      typeof questions === "object" &&
      !Array.isArray(questions) &&
      questions["pt-BR"] !== undefined;

    if (isMultilingual) {
      // Store multilingual questions
      channel.gameState.questionsByLocale = questions;
      // Use pt-BR as default for validation
      channel.gameState.questions = questions["pt-BR"];
      console.log(
        `Multilingual questions loaded for channel ${channelId}: ${questions["pt-BR"].length} questions`
      );
    } else {
      // Legacy: single locale questions
      channel.gameState.questions = questions;
      console.log(`Questions loaded for channel ${channelId}: ${questions.length} questions`);
    }

    channel.gameState.currentQuestionIndex = 0;
    channel.gameState.questionStartTime = Date.now();
    channel.gameState.timerRemaining = channel.gameSettings?.timerDuration || 60;

    // Iniciar timer sincronizado
    startQuestionTimer(channelId);

    // Broadcast estado atualizado
    broadcastChannelUpdate(channelId);
  });

  socket.on("submit-answer", (payload) => {
    const { channelId, questionIndex, answerIndex, timeSpent } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || !channel.isGameStarted) {
      return;
    }

    // Verificar se é a pergunta atual
    if (questionIndex !== channel.gameState.currentQuestionIndex) {
      console.warn(`Device ${persistentDeviceId} answered wrong question`);
      return;
    }

    // Verificar se já respondeu esta pergunta
    const deviceAnswers = channel.gameState.answers.get(persistentDeviceId) || [];
    const alreadyAnswered = deviceAnswers.some((a) => a.questionIndex === questionIndex);

    if (alreadyAnswered) {
      console.warn(
        `Device ${persistentDeviceId} already answered question ${questionIndex}`
      );
      return;
    }

    // Obter pergunta e verificar resposta
    const question = channel.gameState.questions[questionIndex];
    const isCorrect = answerIndex === question.correctAnswer;

    // Salvar resposta
    const answerData = {
      questionIndex,
      answerIndex,
      timeSpent,
      isCorrect,
      points: isCorrect ? question.points : 0,
      timestamp: Date.now(),
    };

    if (!channel.gameState.answers.has(persistentDeviceId)) {
      channel.gameState.answers.set(persistentDeviceId, []);
    }
    channel.gameState.answers.get(persistentDeviceId).push(answerData);

    console.log(
      `[${new Date().toISOString()}] Device ${device.displayName} (${device.role}) answered Q${questionIndex}: ${
        isCorrect ? "CORRECT" : "WRONG"
      } (+${answerData.points} pts)`
    );

    // Notificar TODOS os dispositivos do canal sobre o resultado (para sincronizar feedback)
    io.to(channelId).emit("answer-result", {
      questionIndex,
      isCorrect,
      points: answerData.points,
      deviceId: persistentDeviceId,
    });
  });

  socket.on("next-question", (payload) => {
    const { channelId } = payload;
    const device = connectedDevices.get(persistentDeviceId);

    if (!device || device.channel !== channelId) {
      return;
    }

    const channel = channels.get(channelId);
    if (!channel || channel.adminId !== persistentDeviceId) {
      console.warn(`Non-admin tried to advance question`);
      return;
    }

    if (!channel.isGameStarted) {
      return;
    }

    // Limpar timer atual
    if (channel.gameState.timerInterval) {
      clearInterval(channel.gameState.timerInterval);
      channel.gameState.timerInterval = null;
    }

    // Avançar para próxima pergunta
    channel.gameState.currentQuestionIndex++;

    // Verificar se acabaram as perguntas
    if (
      channel.gameState.currentQuestionIndex >= channel.gameState.questions.length
    ) {
      // Jogo terminou - mostrar resultados
      channel.gameState.isShowingResults = true;

      // Calcular ranking
      const ranking = calculateRanking(channel);

      // Emitir resultados
      io.to(channelId).emit("game-finished", {
        ranking,
        totalQuestions: channel.gameState.questions.length,
      });

      console.log(`Game finished in channel ${channelId}`);
    } else {
      // Próxima pergunta
      channel.gameState.questionStartTime = Date.now();
      channel.gameState.timerRemaining = channel.gameSettings?.timerDuration || 60;

      // Reiniciar timer
      startQuestionTimer(channelId);

      console.log(
        `Channel ${channelId} advanced to question ${
          channel.gameState.currentQuestionIndex + 1
        }`
      );
    }

    // Broadcast estado atualizado
    broadcastChannelUpdate(channelId);
  });

  socket.on("reset-game", ({ channelId }) => {
    if (!channelId) {
      return;
    }
    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to reset game without admin role`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Admin ${persistentDeviceId} reset game in channel ${channelId}`
    );

    // Limpar timer se existir
    if (channel.gameState?.timerInterval) {
      clearInterval(channel.gameState.timerInterval);
    }

    // Reset game state but keep categories and ready states
    channel.isGameStarted = false;

    // Resetar estado do jogo
    channel.gameState = {
      questions: [],
      currentQuestionIndex: 0,
      questionStartTime: null,
      timerRemaining: 60,
      timerInterval: null,
      answers: new Map(),
      isShowingResults: false,
    };

    // Reset all guests ready state to false so they can prepare again
    Array.from(channel.devices || []).forEach((deviceId) => {
      const device = connectedDevices.get(deviceId);
      if (device && device.role === "guest") {
        device.isReady = false;
      }
    });

    // Notify all devices in the channel to return to lobby
    io.to(channelId).emit("game-reset", { channelId });

    broadcastChannelUpdate(channelId);
  });

  socket.on("remove-device", ({ channelId, targetDeviceId }) => {
    if (!channelId || !targetDeviceId) {
      return;
    }

    const requester = connectedDevices.get(persistentDeviceId);
    const channel = channels.get(channelId);

    if (!requester || !channel || requester.channel !== channelId) {
      console.warn(
        `[${new Date().toISOString()}] Invalid remove-device attempt by ${persistentDeviceId}`
      );
      return;
    }

    if (channel.adminId !== persistentDeviceId) {
      console.warn(
        `[${new Date().toISOString()}] Device ${persistentDeviceId} tried to remove without admin role`
      );
      return;
    }

    if (targetDeviceId === channel.adminId || !channel.devices.has(targetDeviceId)) {
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Admin ${persistentDeviceId} removing device ${targetDeviceId} from channel ${channelId}`
    );
    removeDeviceFromChannel(targetDeviceId, "removed_by_admin");
  });

  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  socket.on("update-locale", (payload) => {
    const { locale } = payload;
    const device = connectedDevices.get(persistentDeviceId);
    if (device && locale) {
      device.locale = locale;
      console.log(`[${new Date().toISOString()}] Device ${persistentDeviceId} updated locale to ${locale}`);

      // Broadcast channel update if device is in a channel
      if (device.channel) {
        broadcastChannelUpdate(device.channel);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(
      `[${new Date().toISOString()}] Socket disconnected: ${
        socket.id
      } (Device: ${persistentDeviceId})`
    );

    socketToDevice.delete(socket.id);

    const device = connectedDevices.get(persistentDeviceId);
    if (device) {
      device.isActive = false;

      if (device.channel) {
        const channel = channels.get(device.channel);
        if (channel && channel.adminId === persistentDeviceId) {
          forceCloseChannel(device.channel, "admin_disconnected");
        } else {
          broadcastChannelUpdate(device.channel);
        }
      }

      setTimeout(() => {
        const stillConnected = connectedDevices.get(persistentDeviceId);
        if (stillConnected && !stillConnected.isActive && stillConnected.socketId === socket.id) {
          console.log(
            `[${new Date().toISOString()}] Removing inactive device: ${persistentDeviceId}`
          );

          if (stillConnected.channel) {
            const channel = channels.get(stillConnected.channel);
            if (channel && channel.adminId === persistentDeviceId) {
              forceCloseChannel(stillConnected.channel, "admin_inactive_timeout");
            } else {
              removeDeviceFromChannel(persistentDeviceId);
            }
          }

          connectedDevices.delete(persistentDeviceId);
        }
      }, 600000); // 10 minutos (600000ms)
    }
  });
});

const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  const environment = process.env.NODE_ENV || "development";
  const frontendUrl = Array.isArray(allowedOrigins) ? allowedOrigins.join(', ') : allowedOrigins;

  console.log(`
╔══════════════════════════════════════════╗
║   Socket.IO Server Running               ║
║   Port: ${PORT}                          ║
║   Environment: ${environment.toUpperCase().padEnd(21)}║
╚══════════════════════════════════════════╝

✅ STATUS: PRONTO PARA PRODUÇÃO
   - URL do Servidor: Porta ${PORT} (Acessível via domínio público do Railway)
   - ORIGENS CORS PERMITIDAS: ${frontendUrl}

⚠️ AÇÃO NECESSÁRIA NO VERCEL/FRONT-END:
   Altere a constante SOCKET_URL no seu front-end (ex: src/hooks/useSocket.ts)
   para a URL pública do Railway (ex: https://seu-app-railway.up.railway.app).
`);
});

setInterval(() => {
  console.log(
    `[${new Date().toISOString()}] Active channels: ${channels.size}, Connected devices: ${
      connectedDevices.size
    }`
  );
}, 30000);
