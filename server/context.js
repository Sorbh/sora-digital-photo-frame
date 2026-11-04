const { AsyncLocalStorage } = require('async_hooks');

// A self-hosted install has one owner; hosted setups resolve one per request
const DEFAULT_TENANT = Object.freeze({ id: 'default', plan: 'self-hosted' });

const storage = new AsyncLocalStorage();

/**
 * Middleware that works out who the request belongs to and keeps it
 * available to everything the request calls, via currentTenant().
 * resolveTenant(req) may return null to fall back to the default tenant.
 */
function tenantMiddleware(resolveTenant) {
  return async (req, res, next) => {
    try {
      req.tenant = (resolveTenant && await resolveTenant(req)) || DEFAULT_TENANT;
      storage.run(req.tenant, next);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Re-enter the request's tenant. Body parsers such as multer call next()
 * from stream events, which can drop the async context.
 */
function keepTenant(req, res, next) {
  storage.run(req.tenant || DEFAULT_TENANT, next);
}

/**
 * Run fn as `tenant`, e.g. when a frame proves it holds a pairing secret
 * before it has a session.
 */
function runWithTenant(tenant, fn) {
  return storage.run(tenant || DEFAULT_TENANT, fn);
}

function currentTenant() {
  return storage.getStore() || DEFAULT_TENANT;
}

module.exports = { DEFAULT_TENANT, tenantMiddleware, keepTenant, runWithTenant, currentTenant };
