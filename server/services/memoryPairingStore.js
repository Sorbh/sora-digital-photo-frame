// Each change is synchronous in memory, so it has the same atomicity as a
// shared store's transaction or conditional update.
class MemoryPairingStore {
  constructor() {
    this.rows = new Map();
  }

  list(now) {
    for (const [code, pairing] of this.rows) {
      if (pairing.expiresAt <= now) this.rows.delete(code);
    }
    return [...this.rows.values()];
  }

  get(code, now) {
    const pairing = this.rows.get(code);
    if (!pairing) return null;
    if (pairing.expiresAt > now) return pairing;
    this.rows.delete(code);
    return null;
  }

  enqueue(choose) {
    const now = Date.now();
    const { pairing, evict } = choose(this.list(now), now);
    for (const code of evict) this.rows.delete(code);
    if (pairing) this.rows.set(pairing.code, pairing);
    return pairing;
  }

  claim(code, claimId, now) {
    const pairing = this.get(code, now);
    if (!pairing || pairing.claimId || pairing.approved) return null;
    pairing.claimId = claimId;
    return { ...pairing };
  }

  release({ code, claimId }) {
    const pairing = this.rows.get(code);
    if (pairing && pairing.claimId === claimId && !pairing.approved) pairing.claimId = null;
  }

  approve({ code, claimId }, approved, now) {
    const pairing = this.get(code, now);
    if (!pairing || pairing.claimId !== claimId || pairing.approved) return false;
    pairing.approved = approved;
    return true;
  }

  touch({ code, secretHash }, field, now) {
    const pairing = this.get(code, now);
    if (pairing?.secretHash === secretHash) pairing[field] = Math.max(pairing[field] || 0, now);
  }

  cancel({ code, secretHash }, now) {
    const pairing = this.get(code, now);
    if (pairing?.secretHash === secretHash && !pairing.claimId && !pairing.approved) this.rows.delete(code);
  }

  take({ code, secretHash }, now) {
    const pairing = this.get(code, now);
    if (!pairing?.approved || pairing.secretHash !== secretHash) return null;
    this.rows.delete(code);
    return pairing.approved;
  }

  restore(pairing, now) {
    if (pairing.expiresAt > now && !this.get(pairing.code, now)) this.rows.set(pairing.code, pairing);
  }
}

module.exports = MemoryPairingStore;
