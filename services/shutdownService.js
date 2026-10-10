/** A single deadline covers HTTP, upgraded sockets, jobs and clients together. */
function createShutdownCoordinator({ server, io, stopJobs = [], closeClients = [],
  timeoutMs = 8000, markStopping = () => {}, log = () => {} }) {
  let pending;
  return function shutdown() {
    if (pending) return pending;
    markStopping();
    pending = (async () => {
      const failures = [];
      const safely = async (action) => {
        try { await action(); } catch (_) { failures.push('RESOURCE_CLOSE_FAILED'); }
      };
      // Close HTTP and Socket.IO concurrently: upgraded sockets otherwise keep
      // server.close waiting until PM2's hard-kill deadline.
      let deadline;
      const timedOut = new Promise((resolve) => {
        deadline = setTimeout(() => {
          server.closeAllConnections?.();
          io?.disconnectSockets?.(true);
          resolve(false);
        }, timeoutMs);
      });
      const stoppedJobs = Promise.all(stopJobs.map((stop) => safely(stop)));
      const drained = Promise.all([
        safely(() => new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          server.closeIdleConnections?.();
        })),
        safely(() => new Promise((resolve) => {
          if (!io) return resolve();
          io.close(() => resolve());
        })),
        stoppedJobs.then(() => Promise.all(closeClients.map((close) => safely(close)))),
      ]).then(() => true);
      const clean = await Promise.race([drained, timedOut]);
      clearTimeout(deadline);
      const successful = clean && failures.length === 0;
      log({ event: 'shutdown_complete', clean: successful, failures: failures.length });
      return { clean: successful, failures: failures.length };
    })();
    return pending;
  };
}
module.exports = { createShutdownCoordinator };
