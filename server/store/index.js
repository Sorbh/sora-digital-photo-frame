const LocalDataStore = require('./LocalDataStore');

let dataStore;
function getDataStore() {
  if (!dataStore) dataStore = new LocalDataStore();
  return dataStore;
}
function setDataStore(next) { dataStore = next; }

module.exports = { getDataStore, setDataStore };
