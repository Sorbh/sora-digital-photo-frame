const crypto = require('crypto');
const { getDataStore } = require('../store');
const { currentTenant } = require('../context');
const { emit } = require('../events');

// Same letters as pairing codes: no 0/O, 1/I/L, since it's typed on a TV remote
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

const normalize = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A hosted server holds many families, so a PIN alone can't say whose frame
 * it is. A frame signing in with a PIN also gives its family code: the host
 * finds the family from it (the familyCodeSet event keeps its index), and the
 * code adds about 40 bits a stranger would have to guess along with the PIN.
 * Self-hosted installs have one library and never use it.
 */
class FamilyCodeService {
  newCode() {
    return Array.from(crypto.randomBytes(LENGTH), b => ALPHABET[b % ALPHABET.length]).join('');
  }

  // This family's code, made the first time it's asked for
  async get() {
    let created = null;
    const doc = await getDataStore().update('family-code', null, current => {
      if (current?.code) return current;
      created = { code: this.newCode(), createdAt: new Date().toISOString() };
      return created;
    });
    if (created) await this.announce(created.code, null);
    return doc.code;
  }

  // A new code, e.g. when the old one was shared too widely. Frames already
  // signed in stay signed in; only new PIN sign-ins need the new code.
  async renew() {
    const next = { code: this.newCode(), createdAt: new Date().toISOString() };
    let previous = null;
    await getDataStore().update('family-code', null, current => {
      previous = current;
      return next;
    });
    await this.announce(next.code, previous?.code || null, previous);
    return next.code;
  }

  async announce(code, previous, restore) {
    try {
      await emit('familyCodeSet', { code, previous, tenantId: currentTenant().id });
    } catch (error) {
      // As with devices: the host's index must never point at a code we don't hold
      await getDataStore().set('family-code', restore || null);
      throw error;
    }
  }

  async matches(code) {
    const given = normalize(code);
    if (given.length !== LENGTH) return false;
    const doc = await getDataStore().get('family-code', null);
    return Boolean(doc?.code) && crypto.timingSafeEqual(Buffer.from(doc.code), Buffer.from(given));
  }
}

module.exports = new FamilyCodeService();
module.exports.normalizeFamilyCode = normalize;
module.exports.FAMILY_CODE_LENGTH = LENGTH;
