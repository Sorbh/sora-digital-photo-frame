/**
 * Things a hosted setup may want to hear about, passed to createApp as
 * `events`. Each handler may be async; it's awaited, and if it throws the
 * action fails (so an index kept by the host never misses a change). The one
 * exception, a device discarded after a late approval, is kept and sent to
 * devicesRemoved again later (see PairingService.reportRemovals and HOOKS.md).
 *
 *   devicePaired({ deviceId, tenantId })      a screen joined (QR code or PIN)
 *   devicesRemoved({ deviceIds, tenantId })   screens were removed or signed out
 *   familyCodeSet({ code, previous, tenantId })  a family code was made or replaced
 */
let handlers = {};

function setEvents(next) {
  handlers = next || {};
}

async function emit(name, payload) {
  if (typeof handlers[name] === 'function') await handlers[name](payload);
}

module.exports = { setEvents, emit };
