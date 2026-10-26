const LocalPhotoLibrary = require('./LocalPhotoLibrary');

let library;
function getLibrary() {
  if (!library) library = new LocalPhotoLibrary();
  return library;
}
function setLibrary(next) { library = next; }

module.exports = { getLibrary, setLibrary };
