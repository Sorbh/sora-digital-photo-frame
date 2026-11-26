/**
 * Where to put a pop-up menu so all of it stays on screen.
 *
 *   SoraPlaceMenu.place({
 *     anchor: { left, top, right, bottom },  // the button it opens from, or
 *     point: { x, y },                       // where the right-click was
 *     width, height,                          // the menu's size
 *     viewport: { width, height }
 *   }) -> { left, top, maxHeight }            // maxHeight is null when it fits
 *
 * Under the button (lined up with its end), else above it. A right-click menu
 * opens at the pointer and flips left or up when it would run off. A menu
 * taller than the screen fits neither way: it is pinned to the top and
 * scrolls (maxHeight).
 */
(function (root) {
  var MARGIN = 8;
  var GAP = 4;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function place(options) {
    var vw = options.viewport.width;
    var vh = options.viewport.height;
    var w = options.width;
    var h = options.height;
    var anchor = options.anchor;
    var left;
    var top;

    if (anchor) {
      left = anchor.right - w;
      var below = anchor.bottom + GAP;
      var above = anchor.top - GAP - h;
      if (below + h <= vh - MARGIN) top = below;
      else if (above >= MARGIN) top = above;
    } else {
      var x = options.point.x;
      var y = options.point.y;
      left = x + w > vw - MARGIN ? x - w : x;
      if (y + h <= vh - MARGIN) top = y;
      else if (y - h >= MARGIN) top = y - h;
      else top = clamp(y, MARGIN, vh - MARGIN - h);
    }

    left = Math.max(MARGIN, clamp(left, MARGIN, vw - MARGIN - w));
    var maxHeight = null;
    if (top === undefined || h > vh - 2 * MARGIN) {
      // Fits neither below nor above: from the top of the screen, scrolling if needed
      top = MARGIN;
      if (h > vh - 2 * MARGIN) maxHeight = vh - 2 * MARGIN;
    }
    return { left: left, top: top, maxHeight: maxHeight };
  }

  var api = { place: place, MARGIN: MARGIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoraPlaceMenu = api;
})(typeof self !== 'undefined' ? self : this);
