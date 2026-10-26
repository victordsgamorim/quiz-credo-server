const TICK_MS = 1000;

/**
 * The question's countdown: it ticks every second, sending the room the time left, and tells the
 * room when the time is up
 *
 * @param context.store - The server's state
 * @param context.notifier - What the server sends the devices
 * @param context.logger - Where it logs
 */
export const createQuestionTimer = ({ store, notifier, logger }) => {
  const { channels } = store;

  const stop = (channel) => {
    if (channel.gameState?.timerInterval) {
      clearInterval(channel.gameState.timerInterval);
      channel.gameState.timerInterval = null;
    }
  };

  const tick = (channelId, channel, intervalId) => {
    const { gameState } = channel;
    // The room closed (another one may have its id now), or its game went back to the lobby
    if (channels.get(channelId) !== channel || gameState.timerInterval !== intervalId) {
      clearInterval(intervalId);
      return;
    }

    if (gameState.timerRemaining > 0) {
      gameState.timerRemaining--;
      notifier.broadcastChannelUpdate(channelId);
    } else {
      stop(channel);
      notifier.emitToChannel(channelId, "question-timeout", {
        questionIndex: gameState.currentQuestionIndex,
      });
    }
  };

  const start = (channelId) => {
    const channel = channels.get(channelId);
    if (!channel || !channel.gameState) return;

    stop(channel);
    channel.gameState.isTimerPaused = false;

    // Without a time limit, nothing counts down
    if (channel.gameSettings?.timerDuration === null) {
      logger.debug("Question without a time limit", { channelId });
      return;
    }

    // The admin is away: the time runs once they're back
    if (channel.adminAwayUntil) {
      channel.gameState.isTimerPaused = true;
      return;
    }

    const intervalId = setInterval(() => {
      try {
        tick(channelId, channel, intervalId);
      } catch (error) {
        clearInterval(intervalId);
        logger.error("The question's countdown failed", { channelId, error });
      }
    }, TICK_MS);
    channel.gameState.timerInterval = intervalId;
  };

  // While the admin is away the question's time stands still: the countdown stops, and goes on from
  // where it stopped once they're back
  const pause = (channel) => {
    const { gameState } = channel;
    if (!gameState?.timerInterval) return;
    stop(channel);
    gameState.isTimerPaused = true;
  };

  const resume = (channelId, channel) => {
    if (!channel.gameState?.isTimerPaused) return;
    start(channelId);
  };

  return { start, stop, pause, resume };
};
