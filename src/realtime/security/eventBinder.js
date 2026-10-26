/**
 * Binds the handlers of a connection's events: each one runs within its event's limit, and an
 * error in one (a bug, a payload nobody thought of) is logged instead of bringing the server down
 * with every room in it
 *
 * @param options.socket - The device's connection
 * @param options.limiter - The connection's event limits
 * @param options.logger - Where it logs
 * @returns on(event, handler): binds the handler (it may be async) to the event
 */
export const createEventBinder = ({ socket, limiter, logger }) => {
  const logFailure = (event, error) =>
    logger.error("Event handler failed", { event, deviceId: socket.data.deviceId, error });

  return (event, handler) => {
    const runHandler = (...args) => {
      try {
        const result = handler(...args);
        if (typeof result?.then === "function") {
          result.catch((error) => logFailure(event, error));
        }
      } catch (error) {
        logFailure(event, error);
      }
    };
    socket.on(event, (...args) => limiter.run(event, args, runHandler));
  };
};
