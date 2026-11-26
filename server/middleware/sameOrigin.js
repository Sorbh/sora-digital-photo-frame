// Changes (POST, PUT, PATCH, DELETE) only from this site's own pages. Cookies
// are SameSite=Lax, which still lets another site on the same host or network
// (a router page, a NAS, another app on a different port) send a plain form
// here as the signed-in admin. Browsers say where a request came from, in
// Sec-Fetch-Site or, in older ones, Origin. Requests with neither (scripts,
// curl, webhooks) don't come from a page, so they carry no one's cookies by
// accident and pass.
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Scheme, host and port, as a browser writes them in Origin (lower case, no default port)
const originOf = (url) => {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

function sameOrigin(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();

  const site = req.get('sec-fetch-site');
  if (site) {
    if (site === 'same-origin' || site === 'none') return next();
    return refuse(res);
  }

  const origin = req.get('origin');
  if (!origin) return next();
  // The whole origin, so an http:// page can't send changes to the https:// site.
  // The scheme is req.protocol, which believes X-Forwarded-Proto only from a
  // trusted proxy (TRUST_PROXY); the host is only Host: X-Forwarded-Host could
  // be sent by the page itself. (Behind a proxy that rewrites Host, such old
  // browsers need the proxy to keep it.)
  const host = req.get('host');
  const sent = originOf(origin);
  if (host && sent && sent === originOf(`${req.protocol}://${host}`)) return next();
  return refuse(res);
}

function refuse(res) {
  return res.status(403).json({ message: 'This request has to come from this site', code: 'CROSS_SITE' });
}

module.exports = sameOrigin;
