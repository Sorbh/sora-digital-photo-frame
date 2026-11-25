/**
 * Arrow keys move focus between buttons, for TV remotes that have no Tab key
 * and browsers without spatial navigation of their own.
 *
 * The next button is picked by where it sits on screen, not by its place in
 * the page, so grids, rows and right-to-left layouts all follow the arrow.
 *
 *   SoraArrowFocus.next(buttons, current, 'ArrowDown') -> the button to focus, or null
 *   SoraArrowFocus.pick(fromRect, rects, 'down')       -> its index, or -1 (no DOM needed)
 *
 * Written without newer syntax so it parses on old TVs.
 */
(function (root) {
  var DIRECTIONS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  // Gap between two ranges on one axis; 0 when they overlap
  function gap(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, bStart - aEnd, aStart - bEnd);
  }

  /**
   * Of `rects`, which lies next from `from` in `direction`: its centre must be
   * past ours that way. Nearest along the arrow wins; being out of line
   * (sideways gap) counts double, so the same row or column comes first.
   */
  function pick(from, rects, direction) {
    var fx = (from.left + from.right) / 2;
    var fy = (from.top + from.bottom) / 2;
    var best = -1;
    var bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var x = (r.left + r.right) / 2;
      var y = (r.top + r.bottom) / 2;
      var along, aside, ahead;
      if (direction === 'down' || direction === 'up') {
        ahead = direction === 'down' ? y - fy : fy - y;
        along = direction === 'down' ? r.top - from.bottom : from.top - r.bottom;
        aside = gap(from.left, from.right, r.left, r.right);
      } else {
        ahead = direction === 'right' ? x - fx : fx - x;
        along = direction === 'right' ? r.left - from.right : from.left - r.right;
        aside = gap(from.top, from.bottom, r.top, r.bottom);
      }
      if (ahead <= 1) continue;
      var score = Math.max(0, along) + 2 * aside + 0.001 * Math.abs(direction === 'up' || direction === 'down' ? x - fx : y - fy);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** The button to focus after pressing `key` on `current`, or null */
  function next(buttons, current, key) {
    var direction = DIRECTIONS[key];
    if (!direction || !current) return null;
    var shown = [];
    var rects = [];
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] === current) continue;
      var r = buttons[i].getBoundingClientRect();
      if (!r.width && !r.height) continue; // hidden
      shown.push(buttons[i]);
      rects.push(r);
    }
    var index = pick(current.getBoundingClientRect(), rects, direction);
    return index < 0 ? null : shown[index];
  }

  var api = { pick: pick, next: next, DIRECTIONS: DIRECTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoraArrowFocus = api;
})(typeof self !== 'undefined' ? self : this);
