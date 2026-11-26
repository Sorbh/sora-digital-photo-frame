// Request logging keeps to a short list of harmless facts: time, method, path,
// status and duration. Query strings and bodies never reach the logs, since they
// can hold PINs, family codes, passwords, folder names and note text.

// Paths that name a family's photos or folders (album and file names): only the
// route is logged. Express matches routes ignoring case, so these do too.
const PRIVATE_PATHS = [
  [/^\/uploads\/./i, '/uploads/[photo]'],
  [/^\/api\/images\/[^/]+\/thumbnail\/?$/i, '/api/images/[photo]/thumbnail'],
  [/^\/api\/folders\/.+\/thumbnail\/?$/i, '/api/folders/[folder]/thumbnail'],
  [/^\/api\/folders\/./i, '/api/folders/[folder]']
];

// The path alone, as Express routes it. A request can name the whole address
// (GET http://frame.example/uploads/...), which Express routes by its path too.
const pathOf = (url) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.split('?')[0];
  try {
    return new URL(url).pathname;
  } catch (error) {
    return '[unreadable]';
  }
};

// The path without its query, with guest link tokens (/g/<token>/...) hidden,
// and photo and folder names left out
const safePath = (url) => {
  let path = pathOf(url);
  let prefix = '';
  const guest = /^\/g\/[^/]+/.exec(path);
  if (guest) {
    prefix = '/g/[redacted]';
    path = path.slice(guest[0].length);
  }
  const hidden = PRIVATE_PATHS.find(([pattern]) => pattern.test(path));
  return prefix + (hidden ? hidden[1] : path);
};

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
