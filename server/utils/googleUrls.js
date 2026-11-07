// Google Photos hands out photo addresses on googleusercontent.com. Only those
// are fetched with the admin's Google token: any other address would get the
// token sent to whoever runs it, or let the server be pointed at the local network.
function isGooglePhotoUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'));
}

module.exports = { isGooglePhotoUrl };

// Fetch a Google Photos address with the token. Redirects are followed by hand,
// so every hop is checked and the token never goes anywhere else.
async function fetchGooglePhoto(value, accessToken, { maxRedirects = 3 } = {}) {
  let url = String(value);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isGooglePhotoUrl(url)) {
      const error = new Error('Not a Google Photos address');
      error.code = 'INVALID_URL';
      throw error;
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 && response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url).href;
  }
  const error = new Error('Too many redirects');
  error.code = 'INVALID_URL';
  throw error;
}

module.exports.fetchGooglePhoto = fetchGooglePhoto;
