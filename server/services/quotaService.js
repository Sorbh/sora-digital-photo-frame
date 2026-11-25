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

const { currentTenant } = require('../context');

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

/**
 * Check there is room for `bytes` more and run write(), one at a time per
 * tenant, so two uploads can't both pass the check before either is stored.
 * (Within this process; the quota hook itself is unchanged.) `bytes` may be a
 * function, measured in the tenant's turn: how much a replaced file grows.
 * Nothing is checked when it doesn't grow.
 */
const queues = new Map();

async function addWithinQuota(bytes, write) {
  const id = currentTenant().id;
  const previous = queues.get(id) || Promise.resolve();
  let done;
  const mine = new Promise(resolve => { done = resolve; });
  const turn = previous.then(() => mine);
  queues.set(id, turn);
  await previous;
  try {
    const growth = typeof bytes === 'function' ? await bytes() : bytes;
    if (typeof bytes !== 'function' || growth > 0) await assertCanAdd(growth);
    return await write();
  } finally {
    done();
    if (queues.get(id) === turn) queues.delete(id);
  }
}

module.exports = { setQuota, getQuota, assertCanAdd, addWithinQuota };
