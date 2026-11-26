/**
 * API answers are never kept by the browser: Cache-Control: no-store, and no
 * ETag. Someone who switches to another library and presses Back must not get
 * the other library's folders (and its edit controls) from the browser's cache.
 *
 * Routes that send image bytes set their own Cache-Control afterwards
 * (thumbnails: private, no-cache with an ETag) and keep it. Photos under
 * /uploads are not touched by this.
 */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const stored = () => !/\bno-store\b/.test(String(res.get('Cache-Control') || ''));

  // Express gives every res.send() an ETag, and answers 304 when the browser
  // sends a matching If-None-Match (a copy kept from before this). Neither for
  // an answer that must not be kept.
  const send = res.send;
  res.send = function sendUnstored(body) {
    if (!stored()) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
    }
    return send.call(this, body);
  };
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadUnstored(...args) {
    if (!stored()) this.removeHeader('ETag');
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = noStore;
