/**
 * Library limits. Self-hosted installs have none; a hosted setup can pass its
 * own quota to createApp, with a canAdd(request) that answers for the current
 * tenant (see context.js).
 *
 * canAdd({ items, bytes, screens }, context?) -> { ok, message? }
 *   items    countable things being added (ITEMS below): a photo is 1, an animated
 *            one 5, a new snap or note 1. Rotating, renaming, moving or editing is 0.
 *   bytes    how much the library grows, counted before encryption at rest
 *   screens  1 when a new screen (frame) joins the library, else 0
 * The core always passes all three, as numbers. context is optional extra
 * facts the core has in hand: { screensInUse } with screen requests, the
 * number already in use under the account or device lock. Hooks written for the old
 * canAdd(bytes) must change (see HOOKS.md).
 */
const unlimited = {
  async canAdd() {
    return { ok: true };
  }
};

const { currentTenant } = require('../context');

// What each thing counts as, in items
const ITEMS = Object.freeze({ photo: 1, animated: 5, snap: 1, note: 1 });

let quota = unlimited;

function setQuota(next) {
  quota = next || unlimited;
}

function getQuota() {
  return quota;
}

// { items, bytes, screens }, each a number (missing or not a number: 0)
function normalize(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('canAdd takes { items, bytes, screens }');
  }
  const count = value => (Number.isFinite(value) ? value : 0);
  return { items: count(request.items), bytes: count(request.bytes), screens: count(request.screens) };
}

// Something is added when any of the three grows
const addsAnything = ({ items, bytes, screens }) => items > 0 || bytes > 0 || screens > 0;

// The quota hook's answer for this request (normalized). context, when given,
// goes to the hook unchanged as its second argument (e.g. { screensInUse })
async function ask(request, context) {
  const normalized = normalize(request);
  return context === undefined ? quota.canAdd(normalized) : quota.canAdd(normalized, context);
}

// Called inside the update that takes a slot, for code-only screen accounts
// or for devices when PIN sign-in is enabled.
async function assertCanAddScreen(screensInUse) {
  const limit = parseInt(process.env.MAX_SCREENS, 10) || 0;
  if (limit && screensInUse >= limit) {
    throw Object.assign(new Error(`This family already has ${limit} screens. Remove one you no longer use to add this one.`),
      { status: 403, code: 'SCREEN_LIMIT', vars: { limit } });
  }
  const answer = await ask({ screens: 1 }, { screensInUse });
  if (!answer || !answer.ok) {
    throw Object.assign(new Error(answer?.message || 'This family has no room for another screen.'),
      { status: 403, code: 'SCREEN_LIMIT' });
  }
}

/**
 * Throws a 413 QUOTA_EXCEEDED error when the current tenant cannot add
 * `request` ({ items, bytes, screens }; missing fields are 0).
 */
async function assertCanAdd(request, context) {
  const result = await ask(request, context);
  if (!result || !result.ok) {
    const error = new Error((result && result.message) || 'Storage limit reached');
    error.status = 413;
    error.code = 'QUOTA_EXCEEDED';
    throw error;
  }
}

/**
 * For things counted only in items, such as a new note: assertCanAddItems(1).
 * To also hold the tenant's turn while saving (so two can't both pass at the
 * limit), use addWithinQuota({ items: 1, bytes }, write) instead.
 */
function assertCanAddItems(items) {
  return assertCanAdd({ items });
}

// How many items a stored photo counts as: an animated one (more than one frame) is 5
async function photoItems(buffer) {
  const sharp = require('sharp');
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata().catch(() => ({}));
  return (meta.pages || 1) > 1 ? ITEMS.animated : ITEMS.photo;
}

/**
 * Check there is room for `request` ({ items, bytes, screens }) and run write(),
 * one at a time per tenant, so two additions can't both pass the check before
 * either is stored. (Within this process; the quota hook itself is unchanged.)
 * `request` may be a function, measured in the tenant's turn: what a replaced
 * file adds (e.g. a snap that grew, or one that didn't exist yet). Nothing is
 * checked when nothing is added (no new items, no growth, no screens).
 * context, when given, reaches the hook unchanged (see ask).
 */
const queues = new Map();

async function addWithinQuota(request, write, context) {
  const id = currentTenant().id;
  const previous = queues.get(id) || Promise.resolve();
  let done;
  const mine = new Promise(resolve => { done = resolve; });
  const turn = previous.then(() => mine);
  queues.set(id, turn);
  await previous;
  try {
    const wanted = normalize(typeof request === 'function' ? await request() : request);
    if (addsAnything(wanted)) await assertCanAdd(wanted, context);
    return await write();
  } finally {
    done();
    if (queues.get(id) === turn) queues.delete(id);
  }
}

module.exports = { ITEMS, setQuota, getQuota, ask, assertCanAddScreen, assertCanAdd, assertCanAddItems, addWithinQuota, photoItems };
