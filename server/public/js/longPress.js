/**
 * Long press on a library tile: hold a photo for a moment to select it.
 *
 * Uses Pointer Events, so a mouse, a finger and a pen behave the same, and
 * never cancels the touch itself: a plain tap still clicks, and a swipe still
 * scrolls the page. The press is dropped when the pointer moves or the browser
 * takes it over (pointercancel, as when it starts scrolling). Only the click
 * that ends a finished long press is swallowed: never a keyboard click, and
 * not one that comes after the press was cancelled or long after it ended.
 *
 *   SoraLongPress.attach(element, {
 *     onLongPress(event) {},   // the press was held long enough
 *     onStart(event) {},       // optional: a press began
 *     onEnd() {},              // optional: the press ended, held or not
 *     ignore: '.btn',          // optional: presses that start here are left alone
 *     delay: 500, slop: 10     // optional: ms to hold, px the pointer may wander
 *   }) -> { cancel() }
 */
(function (root) {
  var DELAY = 500;
  var SLOP = 10;
  var CLICK_WINDOW = 600; // ms after letting go in which the hold's own click arrives

  function attach(element, options) {
    var delay = options.delay || DELAY;
    var slop = options.slop == null ? SLOP : options.slop;
    var timer = null;
    var press = null; // { id, x, y, type } while a pointer is down
    var held = false; // a long press finished; swallow the click that follows
    var heldTimer = null;
    var lastType = '';

    function release() {
      // Some browsers send no click after a hold: don't keep waiting for one
      clearTimeout(heldTimer);
      heldTimer = held ? setTimeout(function () { held = false; }, CLICK_WINDOW) : null;
    }

    function end() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (press) {
        press = null;
        if (options.onEnd) options.onEnd();
      }
    }

    function down(e) {
      held = false;
      clearTimeout(heldTimer);
      lastType = e.pointerType || '';
      end();
      if (e.isPrimary === false || e.button > 0) return;
      if (options.ignore && e.target && e.target.closest && e.target.closest(options.ignore)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
      if (options.onStart) options.onStart(e);
      timer = setTimeout(function () {
        timer = null;
        held = true;
        options.onLongPress(e);
      }, delay);
    }

    function move(e) {
      if (!timer || !press || e.pointerId !== press.id) return;
      var dx = e.clientX - press.x;
      var dy = e.clientY - press.y;
      if (dx * dx + dy * dy > slop * slop) end();
    }

    function up(e) {
      if (!press || e.pointerId !== press.id) return;
      end();
      release();
    }

    function cancel(e) {
      // The browser took the pointer over (a scroll): no click is coming
      held = false;
      clearTimeout(heldTimer);
      if (press && e.pointerId === press.id) end();
    }

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('pointerleave', up);

    // Capture phase, so the tile's own click handler never sees it
    element.addEventListener('click', function (e) {
      if (!held) return;
      held = false;
      clearTimeout(heldTimer);
      if (e.detail === 0) return; // Enter or Space on a button: always goes through
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // Holding a finger is the long press itself, not a request for the menu
    // (some browsers fire contextmenu for it, others show a callout)
    element.addEventListener('contextmenu', function (e) {
      if (lastType !== 'touch' && lastType !== 'pen') return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    return { cancel: end };
  }

  var api = { attach: attach, DELAY: DELAY, SLOP: SLOP, CLICK_WINDOW: CLICK_WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoraLongPress = api;
})(typeof self !== 'undefined' ? self : this);
