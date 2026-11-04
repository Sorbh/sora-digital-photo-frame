// Fields whose values never reach the logs, matched case-insensitively at any depth
const SENSITIVE_KEY = /^(password|pass|passwd|pin|token|idtoken|accesstoken|refreshtoken|secret|code|authorization|apikey|key|keys|cookie)$/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

// A copy of a request body with secrets replaced
const redact = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
};

// The URL with secret query values (?pin=, ?token=...) and guest link tokens hidden
const redactUrl = (url) => {
  const [pathname, query] = url.split('?');
  const safePath = pathname.replace(/^\/g\/[^/]+/, '/g/' + REDACTED);
  if (!query) return safePath;
  const params = query.split('&').map((pair) => {
    const [key] = pair.split('=');
    let name = key;
    try { name = decodeURIComponent(key); } catch { /* keep as is */ }
    return SENSITIVE_KEY.test(name) ? `${key}=${REDACTED}` : pair;
  });
  return `${safePath}?${params.join('&')}`;
};

// Simple logging middleware
const logger = (req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = redactUrl(req.originalUrl);
  const ip = req.ip || req.connection.remoteAddress;

  console.log(`[${timestamp}] ${method} ${url} - ${ip}`);

  // Log request body for POST/PUT requests (excluding file uploads)
  if ((method === 'POST' || method === 'PUT') && !req.is('multipart/form-data')) {
    console.log('Request body:', JSON.stringify(redact(req.body), null, 2));
  }

  next();
};

module.exports = logger;
module.exports.redact = redact;
module.exports.redactUrl = redactUrl;
