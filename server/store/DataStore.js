/**
 * JSON document storage. Names are logical identifiers; implementations choose
 * their locations. get returns fallback for a missing document. set writes
 * atomically. update applies fn to the current value and serialises calls for
 * the same name, so concurrent changes cannot overwrite one another.
 *
 * "folder-settings:<folder>" documents belong to a photo folder (its play
 * order): set and update must not create that folder. When it is gone they
 * throw a 404 FOLDER_NOT_FOUND error (utils/httpError folderNotFoundError).
 */
class DataStore {
  async get(name, fallback) { throw new Error('not implemented'); }
  async set(name, value) { throw new Error('not implemented'); }
  async update(name, fallback, fn) { throw new Error('not implemented'); }
}

module.exports = DataStore;
