// What a screen says about itself when it asks for a pairing code
// (POST /api/pair/start): { name, kind, platform, app }, every field optional.
// It comes from whoever asked, so it is a hint only: plain text, cut short,
// shown with textContent and never as HTML, and never trusted for anything.

const KINDS = ['tv', 'phone', 'tablet', 'browser', 'frame'];
const LIMITS = { name: 40, platform: 30, app: 40 };
// Control characters, and the invisible ones that reorder or hide text (bidi
// overrides and isolates, zero-width characters, BOM)
const UNSAFE = /[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu;

// Plain text of at most max characters, or null for nothing (or not text)
function plainText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return Array.from(text).slice(0, max).join('').trim() || null;
}

function deviceInfo(body) {
  const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const kind = typeof given.kind === 'string' ? given.kind.trim().toLowerCase() : null;
  return {
    name: plainText(given.name, LIMITS.name),
    kind: KINDS.includes(kind) ? kind : null,
    platform: plainText(given.platform, LIMITS.platform),
    app: plainText(given.app, LIMITS.app)
  };
}

module.exports = { deviceInfo, KINDS, LIMITS };
