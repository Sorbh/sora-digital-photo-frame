/**
 * Answer with the error's own status when it is a client error, e.g. a
 * hosted library throwing 401 AUTH_REQUIRED for a signed-out request.
 * Returns true when it answered, so a catch block can stop there.
 */
function passClientError(res, error) {
  const status = error && error.status;
  if (!Number.isInteger(status) || status < 400 || status > 499 || res.headersSent) return false;
  res.status(status).json({ message: error.expose === false ? 'Request failed' : error.message, ...(error.code && { code: error.code }) });
  return true;
}

module.exports = { passClientError };
