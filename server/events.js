/**
 * Things a hosted setup may want to hear about, passed to createApp as
 * `events`. Each handler may be async; it's awaited, and if it throws the
 * action fails (so an index kept by the host never misses a change).
 *
 *   devicePaired({ deviceId, tenantId })      a frame was paired
 *   devicesRemoved({ deviceIds, tenantId })   frames were unpaired
 */
let handlers = {};

function setEvents(next) {
  handlers = next || {};
}

async function emit(name, payload) {
  if (typeof handlers[name] === 'function') await handlers[name](payload);
}

module.exports = { setEvents, emit };
