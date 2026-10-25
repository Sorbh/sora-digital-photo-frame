const bcrypt = require('bcryptjs');

// Check if user is authenticated (default: the admin password session)
const sessionRequireAuth = (req, res, next) => {
  console.log('🔐 Auth Check:', {
    sessionId: req.sessionID,
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
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: 'Password is required' });
  }

  // Secure password comparison using bcrypt
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  ADMIN_PASSWORD environment variable not set. Using default password "admin123". Please set ADMIN_PASSWORD environment variable for security!');
  }

  // For bcrypt hashed passwords, use bcrypt.compare()
  // For plain text passwords (development only), use direct comparison
  const isValidPassword = adminPassword.startsWith('$2')
    ? await bcrypt.compare(password, adminPassword)
    : password === adminPassword;

  if (isValidPassword) {
    req.session.authenticated = true;
    req.session.loginTime = new Date();

    console.log('🔓 Login successful:', {
      sessionId: req.sessionID,
      sessionData: req.session,
      cookies: req.headers.cookie ? 'present' : 'missing'
    });

    // If it's an API request, return JSON success
    if (req.headers['content-type'] === 'application/json') {
      return res.json({ message: 'Login successful', redirect: '/admin' });
    }

    // For form submissions, redirect to admin
    return res.redirect('/admin');
  }

  // Invalid password
  if (req.headers['content-type'] === 'application/json') {
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

// A hosted setup can swap in its own sign-in, e.g. Google accounts.
// provider: { requireAuth(req, res, next), requireGuest(req, res, next) }, both optional.
let provider = {};

const setAuthProvider = (next) => {
  provider = next || {};
};

const requireAuth = (req, res, next) => (provider.requireAuth || sessionRequireAuth)(req, res, next);
const requireGuest = (req, res, next) => (provider.requireGuest || sessionRequireGuest)(req, res, next);

module.exports = {
  requireAuth,
  requireGuest,
  setAuthProvider,
  login,
  logout,
  getAuthStatus
};