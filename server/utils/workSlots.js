// How many photos are held in memory and converted at the same time: uploads and
// imports together, for all families and for one family. A slot is given back
// only when the work is done, not when the browser goes away.
const TOTAL = parseInt(process.env.UPLOADS_AT_ONCE) || 4;
const PER_FAMILY = 2;

const running = { total: 0, byFamily: new Map() };
const waiting = [];

const hasRoom = family => running.total < TOTAL && (running.byFamily.get(family) || 0) < PER_FAMILY;

function take(family) {
  running.total += 1;
  running.byFamily.set(family, (running.byFamily.get(family) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.total -= 1;
    const left = running.byFamily.get(family) - 1;
    if (left > 0) running.byFamily.set(family, left);
    else running.byFamily.delete(family);
    wake();
  };
}

function wake() {
  for (let i = 0; i < waiting.length; i += 1) {
    if (!hasRoom(waiting[i].family)) continue;
    const [next] = waiting.splice(i, 1);
    i -= 1;
    next.resolve(take(next.family));
  }
}

// A release function, or null when there is no free slot now
function tryAcquire(family) {
  return hasRoom(family) ? take(family) : null;
}

// Waits for a free slot (background work such as imports)
function acquire(family) {
  if (hasRoom(family)) return Promise.resolve(take(family));
  return new Promise(resolve => waiting.push({ family, resolve }));
}

module.exports = { tryAcquire, acquire, running, TOTAL, PER_FAMILY };
