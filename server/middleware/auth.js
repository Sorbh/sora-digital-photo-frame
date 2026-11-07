const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rotateSession } = require('../utils/session');
const AttemptLimiter = require('../utils/attemptLimiter');
const { DATA_DIR } = require('../config/paths');

// The admin password: ADMIN_PASSWORD, unless it's missing or the old default
// (admin123). Then the server makes up one, keeps it in DATA_DIR/admin-password
// and prints it at start, so no frame ever runs with a password anyone can guess.
const WEAK_PASSWORDS = new Set(['admin123']);
const GENERATED_FILE = path.join(DATA_DIR, 'admin-password');
let generatedPassword = null;

function generatedAdminPassword() {
  if (generatedPassword) return generatedPassword;
  try {
    generatedPassword = fs.readFileSync(GENERATED_FILE, 'utf8').trim() || null;
  } catch { /* not made yet */ }
  if (!generatedPassword) {
    generatedPassword = crypto.randomBytes(12).toString('base64url');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(GENERATED_FILE, generatedPassword + '\n', { mode: 0o600 });
    } catch (error) {
      console.warn(`⚠️  Could not save the admin password to ${GENERATED_FILE} (${error.message}); it changes on every restart.`);
    }
  }
  return generatedPassword;
}

const adminPassword = () => {
  const set = process.env.ADMIN_PASSWORD;
  return set && !WEAK_PASSWORDS.has(set) ? set : generatedAdminPassword();
};

// Called once at start by a server that uses the admin password sign-in
const announceAdminPassword = () => {
  const set = process.env.ADMIN_PASSWORD;
  if (set && !WEAK_PASSWORDS.has(set)) return;
  const why = set ? 'ADMIN_PASSWORD is the old default (admin123), which anyone could guess' : 'ADMIN_PASSWORD is not set';
  console.warn(`⚠️  ${why}. Sign in to /admin with this password: ${generatedAdminPassword()}`);
  console.warn(`   It is kept in ${GENERATED_FILE}. Set ADMIN_PASSWORD to choose your own.`);
};

// Same length for both sides, so the comparison takes the same time whatever was typed
const sameText = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest()
);

// Wrong admin passwords: 5 per address, and 20 across everyone, before a lockout
// that doubles each time, so the password can't be guessed by brute force
const loginLimiter = new AttemptLimiter();
const ADMIN_KEY = 'admin';
const adminLimiter = new AttemptLimiter({ maxAttempts: 20, attemptWindow: 15 * 60 * 1000 });

// Check if user is authenticated (default: the admin password session)
const sessionRequireAuth = (req, res, next) => {
  console.log('🔐 Auth Check:', {
    hasSession: !!req.session,
    authenticated: req.session?.authenticated,
    path: req.path,
    cookies: req.headers.cookie ? 'present' : 'missing'
  });

  if (req.session && req.session.authenticated) {
    // Check if session has expired based on login time and maxAge
    const sessionMaxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const loginTime = req.session.loginTime ? new Date(req.session.loginTime) : null;

    if (loginTime && (Date.now() - loginTime.getTime()) > sessionMaxAge) {
      // Session expired, destroy it
      req.session.destroy((err) => {
        if (err) console.error('Error destroying expired session:', err);
      });

      // Check both req.path and req.originalUrl for API requests
      const isApiRequest = req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/');
      
      // If it's an API request, return JSON error with session expired flag
      if (isApiRequest) {
        return res.status(401).json({
          message: 'Session expired',
          code: 'SESSION_EXPIRED',
          redirect: '/login'
        });
      }

      // For HTML requests, redirect to login
      return res.redirect('/login?expired=true');
    }

    return next();
  }

  console.log('❌ Authentication failed for:', req.path);

  // Check both req.path and req.originalUrl for API requests
  const isApiRequest = req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/');
  
  // If it's an API request, return JSON error
  if (isApiRequest) {
    return res.status(401).json({
      message: 'Authentication required',
      code: 'AUTH_REQUIRED',
      redirect: '/login'
    });
  }

  // For HTML requests, redirect to login
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
};

// A path on this site to return to after signing in, or null
const safeNext = (value) => (typeof value === 'string' && /^\/(?![\/\\])/.test(value) ? value : null);

// Check if user is NOT authenticated (for login page)
const sessionRequireGuest = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return res.redirect(safeNext(req.query.next) || '/admin');
  }
  next();
};

// Login handler
const login = async (req, res) => {
  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ message: 'Password is required' });
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const limit = [loginLimiter.check(ip), adminLimiter.check(ADMIN_KEY)].find(check => !check.allowed);
  if (limit) {
    return res.status(429).json({ message: limit.message, code: 'RATE_LIMITED', remainingTime: limit.remainingTime });
  }
  // Counted before checking, cleared on success, so a burst can't all get in
  loginLimiter.fail(ip);
  adminLimiter.fail(ADMIN_KEY);

  // A bcrypt hash ($2...) or the password itself
  const expected = adminPassword();
  const isValidPassword = expected.startsWith('$2')
    ? await bcrypt.compare(String(password), expected)
    : sameText(password, expected);

  if (isValidPassword) {
    loginLimiter.clear(ip);
    adminLimiter.clear(ADMIN_KEY);
    await rotateSession(req);
    req.session.authenticated = true;
    req.session.loginTime = new Date();

    console.log('🔓 Login successful');

    // If it's an API request, return JSON success
    if (req.is('application/json')) {
      return res.json({ message: 'Login successful', redirect: '/admin' });
    }

    // For form submissions, redirect to admin
    return res.redirect('/admin');
  }

  // Invalid password
  if (req.is('application/json')) {
    return res.status(401).json({ message: 'Invalid password' });
  }

  return res.redirect('/login?error=invalid');
};

// Logout handler
const logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
};

// Get authentication status
const getAuthStatus = (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    loginTime: req.session?.loginTime || null
  });
};

// Someone allowed to watch the slideshow: the admin, a PIN account or a paired frame
const sessionRequireViewer = (req, res, next) => {
  if (req.session && (req.session.authenticated || req.session.accessAccount)) return next();
  return res.status(401).json({ message: 'Authentication required', code: 'AUTH_REQUIRED' });
};

// A hosted setup can swap in its own sign-in, e.g. Google accounts.
// provider: { requireAuth, requireGuest, requireViewer } middleware, all optional.
let provider = {};

const setAuthProvider = (next) => {
  provider = next || {};
};

const requireAuth = (req, res, next) => (provider.requireAuth || sessionRequireAuth)(req, res, next);
const requireGuest = (req, res, next) => (provider.requireGuest || sessionRequireGuest)(req, res, next);
const requireViewer = (req, res, next) => (provider.requireViewer || sessionRequireViewer)(req, res, next);

// Photos, thumbnails, folders and notes are for viewers only: the admin, a PIN
// account or a paired frame. PUBLIC_PHOTOS=true (or createApp({ publicPhotos }))
// keeps the old open behaviour for setups that load photos without signing in,
// e.g. a home dashboard that shows /api/images/random.
let publicPhotos = false;
const setPublicPhotos = (value) => { publicPhotos = value === true; };
const requirePhotoViewer = (req, res, next) => (publicPhotos ? next() : requireViewer(req, res, next));

module.exports = {
  requireAuth,
  requireGuest,
  requireViewer,
  requirePhotoViewer,
  announceAdminPassword,
  setAuthProvider,
  setPublicPhotos,
  login,
  logout,
  getAuthStatus
};