/**
 * Storage limits. Self-hosted installs have none; a hosted setup can pass
 * its own quota to createApp, with a canAdd(bytes) that answers for the
 * current tenant (see context.js).
 */
const unlimited = {
  async canAdd() {
    return { ok: true };
  }
};

let quota = unlimited;

function setQuota(next) {
  quota = next || unlimited;
}

function getQuota() {
  return quota;
}

/**
 * Throws a 413 error when the current tenant cannot store `bytes` more.
 */
async function assertCanAdd(bytes) {
  const result = await quota.canAdd(bytes);
  if (!result || !result.ok) {
    const error = new Error((result && result.message) || 'Storage limit reached');
    error.status = 413;
    error.code = 'QUOTA_EXCEEDED';
    throw error;
  }
}

module.exports = { setQuota, getQuota, assertCanAdd };
