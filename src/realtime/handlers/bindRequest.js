/**
 * Binds the events whose payload is a request to a use case: the payload is checked first (one of
 * a wrong shape is ignored), and then the use case runs for the connection's device. An admin
 * action also needs the connection's admin session, when the server requires sessions.
 *
 * @param options.socket - The device's connection
 * @param options.on - Binds a handler to one of the connection's events
 * @param options.context - The server's services
 * @returns bind(event, parse, handle, { isAdminAction })
 */
export const createRequestBinder = ({ socket, on, context }) => {
  const { adminSessions } = context;
  const { deviceId } = socket.data;

  return (event, parse, handle, { isAdminAction = false } = {}) =>
    on(event, (payload) => {
      const request = parse(payload);
      if (!request) return undefined;
      const run = () => handle(deviceId, request);
      return isAdminAction ? adminSessions.runAsAdmin(socket, request.channelId, run) : run();
    });
};
