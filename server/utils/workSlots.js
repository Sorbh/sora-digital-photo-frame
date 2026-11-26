// How many photos are held in memory and converted at the same time, for all
// families together (TOTAL) and for one family. A slot is given back only when
// the work is done, not when the browser goes away.
//
// Two kinds of work share TOTAL:
// - 'upload': uploads and rotations, what people wait for. PER_FAMILY each, so
//   two phones of one family (or the admin page's two parallel sends) fit.
// - 'import': Google Photos imports, one photo after another in the background.
//   Their own IMPORTS_PER_FAMILY, so an import never uses up a family's uploads.
//
// Work with no free slot waits in a queue, first come first served across
// families, so a family that uploads a lot can't keep others out: each slot it
// gives back goes to whoever has waited longest. Uploads wait a bounded time in
// a bounded queue (settings) and are answered "busy" only after that.
const TOTAL = parseInt(process.env.UPLOADS_AT_ONCE) || 4;
const PER_FAMILY = 2;
const IMPORTS_PER_FAMILY = 1;

const settings = {
  // Longest an upload waits for a slot before it is answered 503 BUSY
  waitMs: parseInt(process.env.UPLOAD_WAIT_MS) || 60 * 1000,
  // Longest an upload that has its slot may send nothing before it is dropped
  idleMs: 30 * 1000,
  // Most uploads waiting, for all families and for one. Waiting ones aren't read
  // yet, so they cost no memory; the caps only stop a flood from queueing forever.
  maxWaiting: 8 * TOTAL,
  maxWaitingPerFamily: 4 * PER_FAMILY
};

const running = { total: 0, byFamily: new Map() };
const waiting = [];

const KINDS = { upload: PER_FAMILY, import: IMPORTS_PER_FAMILY };
const keyOf = (family, kind) => `${kind}:${family}`;
const hasRoom = (family, kind) => running.total < TOTAL && (running.byFamily.get(keyOf(family, kind)) || 0) < KINDS[kind];

function take(family, kind) {
  const key = keyOf(family, kind);
  running.total += 1;
  running.byFamily.set(key, (running.byFamily.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.total -= 1;
    const left = running.byFamily.get(key) - 1;
    if (left > 0) running.byFamily.set(key, left);
    else running.byFamily.delete(key);
    wake();
  };
}

function wake() {
  for (let i = 0; i < waiting.length && running.total < TOTAL; i += 1) {
    const next = waiting[i];
    if (!hasRoom(next.family, next.kind)) continue;
    waiting.splice(i, 1);
    i -= 1;
    next.resolve(take(next.family, next.kind));
  }
}

function queueFull(family) {
  const uploads = waiting.filter(w => w.kind === 'upload');
  return uploads.length >= settings.maxWaiting
    || uploads.filter(w => w.family === family).length >= settings.maxWaitingPerFamily;
}

/**
 * A slot for one piece of work: resolves to a release function, to call once
 * the work is done. kind is 'upload' (the default) or 'import'.
 *
 * For uploads someone is waiting on:
 * - timeoutMs: give up after this long, resolving null
 * - signal: an AbortSignal; aborting gives up the place in the queue, resolving null
 * - bounded: resolve null at once when the queue is full
 */
function acquire(family, { kind = 'upload', timeoutMs, signal, bounded = false } = {}) {
  if (!KINDS[kind]) throw new Error(`Unknown kind of work: ${kind}`);
  if (signal && signal.aborted) return Promise.resolve(null);
  if (hasRoom(family, kind)) return Promise.resolve(take(family, kind));
  if (bounded && queueFull(family)) return Promise.resolve(null);
  return new Promise(resolve => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', giveUp);
    };
    const entry = { family, kind, resolve: release => { cleanup(); resolve(release); } };
    function giveUp() {
      const at = waiting.indexOf(entry);
      if (at === -1) return; // already given a slot
      waiting.splice(at, 1);
      cleanup();
      resolve(null);
    }
    if (timeoutMs !== undefined) timer = setTimeout(giveUp, timeoutMs);
    if (signal) signal.addEventListener('abort', giveUp, { once: true });
    waiting.push(entry);
  });
}

// A release function, or null when there is no free slot now
function tryAcquire(family, kind = 'upload') {
  return hasRoom(family, kind) ? take(family, kind) : null;
}

module.exports = { acquire, tryAcquire, running, waiting, settings, TOTAL, PER_FAMILY, IMPORTS_PER_FAMILY };
