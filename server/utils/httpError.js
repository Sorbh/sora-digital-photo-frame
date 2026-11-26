/**
 * Answer with the error's own status when it is a client error, e.g. a
 * hosted library throwing 401 AUTH_REQUIRED for a signed-out request.
 * Returns true when it answered, so a catch block can stop there.
 */
function passClientError(res, error) {
  const status = error && error.status;
  if (!Number.isInteger(status) || status < 400 || status > 499 || res.headersSent) return false;
  res.status(status).json({ message: error.expose === false ? 'Request failed' : error.message, ...(error.code && { code: error.code }), ...(error.vars && { ...error.vars }) });
  return true;
}

/**
 * The same answer as passClientError, with extra fields (e.g. the photos already
 * saved), and Connection: close for a request whose body wasn't read.
 */
function clientErrorResponse(res, error, extra = {}) {
  const status = error && error.status;
  if (!Number.isInteger(status) || status < 400 || status > 499 || res.headersSent) return false;
  res.status(status).set('Connection', 'close').json({
    message: error.expose === false ? 'Request failed' : error.message,
    ...(error.code && { code: error.code }),
    ...(error.vars && { ...error.vars }),
    ...extra
  });
  return true;
}

/**
 * The error for saving into a folder that isn't there (deleted while a photo was
 * still being saved into it, say). Saving never brings a folder back: only
 * creating it on purpose does (see PhotoLibrary).
 */
function folderNotFoundError() {
  return Object.assign(new Error('Folder not found'), { status: 404, code: 'FOLDER_NOT_FOUND' });
}

module.exports = { passClientError, clientErrorResponse, folderNotFoundError };
