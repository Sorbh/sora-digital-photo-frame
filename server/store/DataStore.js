/**
 * JSON document storage. Names are logical identifiers; implementations choose
 * their locations. get returns fallback for a missing document. set writes
 * atomically. update applies fn to the current value and serialises calls for
 * the same name, so concurrent changes cannot overwrite one another.
 */
class DataStore {
  async get(name, fallback) { throw new Error('not implemented'); }
  async set(name, value) { throw new Error('not implemented'); }
  async update(name, fallback, fn) { throw new Error('not implemented'); }
}

module.exports = DataStore;
