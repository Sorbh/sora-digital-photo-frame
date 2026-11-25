/**
 * Long press on a library tile: hold a photo for a moment to select it.
 *
 * Uses Pointer Events, so a mouse, a finger and a pen behave the same, and
 * never cancels the touch itself: a plain tap still clicks, and a swipe still
 * scrolls the page. The press is dropped when the pointer moves or the browser
 * takes it over (pointercancel, as when it starts scrolling). Only the click
 * that ends a finished long press is swallowed.
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

  function attach(element, options) {
    var delay = options.delay || DELAY;
    var slop = options.slop == null ? SLOP : options.slop;
    var timer = null;
    var press = null; // { id, x, y, type } while a pointer is down
    var held = false; // a long press finished; swallow the click that follows
    var lastType = '';

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
      if (press && e.pointerId === press.id) end();
    }

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('pointerleave', up);

    // Capture phase, so the tile's own click handler never sees it
    element.addEventListener('click', function (e) {
      if (!held) return;
      held = false;
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

  var api = { attach: attach, DELAY: DELAY, SLOP: SLOP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoraLongPress = api;
})(typeof self !== 'undefined' ? self : this);
