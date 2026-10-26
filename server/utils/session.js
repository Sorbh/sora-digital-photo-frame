/**
 * Give the session a new id at sign-in, keeping what's already in it (a
 * signed-in admin, Google Photos tokens...). Stops session fixation: an id
 * planted before sign-in is worthless after it.
 */
function rotateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) return resolve();
    const { cookie, ...kept } = req.session;
    req.session.regenerate((error) => {
      if (error) return reject(error);
      Object.assign(req.session, kept);
      resolve();
    });
  });
}

module.exports = { rotateSession };
