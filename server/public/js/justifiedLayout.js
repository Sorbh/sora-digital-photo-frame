/**
 * Justified rows for the library's photo grid: each photo keeps its own shape,
 * every row is the same height across, and the rows fill the width edge to edge
 * (like a photo album, not a file manager). Pure maths, no page: given the photos'
 * shapes and the width, it says which photos go in each row and how big each is.
 *
 *   SoraJustified.layout(shapes, {
 *     width,              // px the rows fill
 *     rowHeight: 230,     // the height a row aims for
 *     gap: 4,             // px between photos and between rows
 *     maxRowHeight,       // a row never gets taller than this (default 1.6 × rowHeight)
 *     minAspect: 0.5,     // shapes beyond these are cropped a little, never squashed:
 *     maxAspect: 3        //   a tall screenshot shows as 1:2, a panorama as 3:1
 *   }) -> { rows: [{ top, height, items: [{ index, left, width, height }] }], height }
 *
 * shapes: an aspect ratio (width / height) per photo, or { width, height }.
 * Unknown shapes (0, null) count as 4:3 until they are measured.
 * The last row stays at about rowHeight, left-aligned, rather than being blown
 * up to fill the width.
 */
(function (root) {
  var FALLBACK_ASPECT = 4 / 3;

  function aspectOf(shape, minAspect, maxAspect) {
    var aspect = typeof shape === 'number' ? shape
      : shape && shape.width > 0 && shape.height > 0 ? shape.width / shape.height : 0;
    if (!(aspect > 0) || !isFinite(aspect)) aspect = FALLBACK_ASPECT;
    return Math.min(maxAspect, Math.max(minAspect, aspect));
  }

  // The height that makes these photos exactly fill the width
  function fillHeight(aspects, width, gap) {
    var sum = 0;
    for (var i = 0; i < aspects.length; i++) sum += aspects[i];
    return (width - gap * (aspects.length - 1)) / sum;
  }

  // Whole-pixel widths that add up to the row's width exactly, so the right edge is straight
  function placeRow(indexes, aspects, height, width, gap, fill) {
    var items = [];
    var left = 0;
    var exact = 0;
    for (var i = 0; i < indexes.length; i++) {
      exact += aspects[i] * height;
      // Where this photo's right edge falls exactly, rounded; a full row ends at the width
      var right = fill && i === indexes.length - 1 ? width : Math.round(exact + gap * i);
      var w = Math.max(1, right - left);
      items.push({ index: indexes[i], left: left, width: w, height: height });
      left += w + gap;
    }
    return items;
  }

  function layout(shapes, options) {
    options = options || {};
    var width = Math.max(0, Math.floor(options.width || 0));
    var target = options.rowHeight > 0 ? options.rowHeight : 230;
    var gap = options.gap >= 0 ? options.gap : 4;
    var maxRow = options.maxRowHeight > 0 ? options.maxRowHeight : target * 1.6;
    var minAspect = options.minAspect > 0 ? options.minAspect : 0.5;
    var maxAspect = options.maxAspect > 0 ? options.maxAspect : 3;
    var list = shapes || [];
    var rows = [];
    var top = 0;
    if (!width || !list.length) return { rows: rows, height: 0 };

    var aspects = [];
    for (var a = 0; a < list.length; a++) aspects.push(aspectOf(list[a], minAspect, maxAspect));

    function close(start, end, fill) {
      var rowAspects = aspects.slice(start, end);
      var indexes = [];
      for (var k = start; k < end; k++) indexes.push(k);
      var height = fill ? fillHeight(rowAspects, width, gap) : target;
      if (fill) height = Math.min(height, maxRow);
      // A row that can't fill the width at its capped height (one very tall photo): left-aligned
      var fills = fill && Math.abs(fillHeight(rowAspects, width, gap) - height) < 0.5;
      height = Math.max(1, Math.round(height));
      // Not filled: never wider than the space (a lone panorama on a phone)
      if (!fills) {
        var natural = 0;
        for (var n = 0; n < rowAspects.length; n++) natural += rowAspects[n] * height;
        natural += gap * (rowAspects.length - 1);
        if (natural > width) {
          height = Math.max(1, Math.floor(fillHeight(rowAspects, width, gap)));
          fills = true;
        }
      }
      rows.push({ top: top, height: height, items: placeRow(indexes, rowAspects, height, width, gap, fills) });
      top += height + gap;
    }

    var start = 0;
    for (var i = 0; i < aspects.length; i++) {
      var withThis = fillHeight(aspects.slice(start, i + 1), width, gap);
      if (withThis > target) continue; // still too tall: room for more
      // Too short now: keep this photo, or end the row before it, whichever is nearer the aim
      var without = i > start ? fillHeight(aspects.slice(start, i), width, gap) : Infinity;
      if (i > start && Math.abs(Math.log(without / target)) < Math.abs(Math.log(withThis / target))) {
        close(start, i, true);
        start = i;
        i--; // this photo starts the next row
      } else {
        close(start, i + 1, true);
        start = i + 1;
      }
    }
    if (start < aspects.length) {
      // The last row: full only if it nearly is anyway
      var lastFill = fillHeight(aspects.slice(start), width, gap);
      close(start, aspects.length, lastFill <= target * 1.15);
    }
    return { rows: rows, height: Math.max(0, top - gap) };
  }

  // Row height for a grid this wide: smaller on phones, so three or four fit across
  function rowHeightFor(width) {
    if (width < 480) return 118;
    if (width < 760) return 150;
    if (width < 1100) return 200;
    return 236;
  }

  // "2019-03-12T18:04:00" (camera time, no zone) or an ISO time -> a local Date
  function dateOf(value) {
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  /**
   * Photos (in the order given, already sorted by date) in groups with a date
   * heading: by month, or by day when they all fall in one month. Photos without
   * a date go in a group with no heading. Nothing dated at all: one group.
   *   groupByDate(files, { locale }) -> [{ label, key, files }]
   */
  function groupByDate(files, options) {
    options = options || {};
    var list = files || [];
    var dates = list.map(function (file) { return dateOf(file && file.date); });
    if (!dates.some(Boolean)) return [{ label: null, key: null, files: list.slice() }];

    function keyOf(date, unit) {
      if (!date) return '';
      var key = date.getFullYear() + '-' + (date.getMonth() + 1);
      return unit === 'day' ? key + '-' + date.getDate() : key;
    }
    function split(unit) {
      var groups = [];
      list.forEach(function (file, i) {
        var key = keyOf(dates[i], unit);
        var last = groups[groups.length - 1];
        if (last && last.key === key) last.files.push(file);
        else groups.push({ key: key, date: dates[i], files: [file] });
      });
      return groups;
    }

    var unit = 'month';
    var groups = split('month');
    if (groups.filter(function (group) { return group.key; }).length === 1) {
      var days = split('day');
      if (days.length > 1) { unit = 'day'; groups = days; }
    }

    var locale = options.locale || 'en';
    var thisYear = (options.now || new Date()).getFullYear();
    var format = function (date) {
      var parts = unit === 'month'
        ? { month: 'long', year: 'numeric' }
        : { weekday: 'short', day: 'numeric', month: 'short' };
      if (unit === 'day' && date.getFullYear() !== thisYear) parts.year = 'numeric';
      try { return new Intl.DateTimeFormat(locale, parts).format(date); }
      catch (_) { return new Intl.DateTimeFormat('en', parts).format(date); }
    };
    return groups.map(function (group) {
      return { label: group.key ? format(group.date) : null, key: group.key || null, files: group.files };
    });
  }

  var api = { layout: layout, rowHeightFor: rowHeightFor, groupByDate: groupByDate, FALLBACK_ASPECT: FALLBACK_ASPECT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoraJustified = api;
})(typeof window !== 'undefined' ? window : this);
