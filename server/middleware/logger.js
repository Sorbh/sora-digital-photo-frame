// Request logging keeps to a short list of harmless facts: time, method, path,
// status and duration. Query strings and bodies never reach the logs, since they
// can hold PINs, family codes, passwords, folder names and note text.

// The path without its query, and with guest link tokens (/g/<token>/...) hidden
const safePath = (url) => url.split('?')[0].replace(/^\/g\/[^/]+/, '/g/[redacted]');

const logger = (req, res, next) => {
  const started = process.hrtime.bigint();
  const method = req.method;
  const url = safePath(req.originalUrl);
  const ip = req.ip || req.connection.remoteAddress;

  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    const status = res.headersSent ? res.statusCode : '-';
    console.log(`[${new Date().toISOString()}] ${method} ${url} ${status} ${ms}ms - ${ip}`);
  };
  res.once('finish', log);
  res.once('close', log);
  next();
};

module.exports = logger;
module.exports.safePath = safePath;
