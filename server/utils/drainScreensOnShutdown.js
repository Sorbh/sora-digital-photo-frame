/** Stop accepting HTTP requests, then flush screen activity before closing storage. */
module.exports = function drainScreensOnShutdown(server, app, closeStorage = async () => {}) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async error => {
      try {
        await app.locals.pairingService.drainSeen();
      } catch (error) {
        console.error('Could not save screen activity during shutdown:', error.message);
        process.exitCode = 1;
      } finally {
        await closeStorage().catch(error => {
          console.error('Could not close storage during shutdown:', error.message);
          process.exitCode = 1;
        });
      }
      if (error) process.exitCode = 1;
      // Hosts can have other background jobs (such as the plan-end check).
      process.exit(process.exitCode || 0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};
