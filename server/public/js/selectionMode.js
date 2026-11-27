/**
 * Selection mode for the library's photo grid. Ticking one photo (or holding one
 * on a phone) starts it: every tile shows its check and a tap ticks instead of
 * opening, until nothing is ticked any more, or Escape, Cancel or the phone's
 * Back ends it.
 *
 * Back: starting selection adds a history entry (same address, state
 * { selecting: true }), so Back ends selection instead of leaving the folder.
 * Ending it any other way takes that entry off again.
 *
 *   const selection = SoraSelection.create({ history, onChange(selection) {} });
 *   selection.toggle(key)          tick or untick one; starts or ends selection
 *   selection.set(key, on)
 *   selection.selectAll(keys)      tick all of these (starts selection)
 *   selection.clear()              end selection
 *   selection.onKey(event)         Escape ends it; true when the key was used
 *   selection.onPopState(state)    Back ended it; true when it did
 *   selection.forget()             end it without touching history (the folder changed)
 *   selection.active, .size, .has(key), .keys()
 */
(function (root) {
  function create(options) {
    options = options || {};
    var history = options.history || null;
    var onChange = options.onChange || function () {};
    var items = new Set();
    var entry = false; // our history entry is on top

    function started() {
      if (entry || !history) return;
      try {
        var state = Object.assign({}, history.state || {}, { selecting: true });
        history.pushState(state, '');
        entry = true;
      } catch (_) { /* no history: Escape and Cancel still work */ }
    }

    function ended(fromHistory) {
      if (!entry) return;
      entry = false;
      // Take our entry off, unless Back already did
      if (!fromHistory && history && history.state && history.state.selecting) history.back();
    }

    function changed(wasActive, fromHistory) {
      var active = items.size > 0;
      if (active && !wasActive) started();
      if (!active && wasActive) ended(fromHistory);
      onChange(api);
    }

    var api = {
      get active() { return items.size > 0; },
      get size() { return items.size; },
      has: function (key) { return items.has(key); },
      keys: function () { return Array.from(items); },
      set: function (key, on) {
        var was = items.size > 0;
        if (on === items.has(key)) return;
        if (on) items.add(key); else items.delete(key);
        changed(was, false);
      },
      toggle: function (key) { api.set(key, !items.has(key)); },
      selectAll: function (keys) {
        var was = items.size > 0;
        (keys || []).forEach(function (key) { items.add(key); });
        changed(was, false);
      },
      clear: function () {
        if (!items.size) return;
        items.clear();
        changed(true, false);
      },
      // The folder changed (or was redrawn without these photos): nothing is selected,
      // and our history entry is left for Back to step over
      forget: function () {
        if (!items.size && !entry) return;
        items.clear();
        entry = false;
        onChange(api);
      },
      // Keep only keys still shown (after a redraw)
      keep: function (keys) {
        var shown = new Set(keys);
        var was = items.size > 0;
        Array.from(items).forEach(function (key) { if (!shown.has(key)) items.delete(key); });
        if (was) changed(was, false);
      },
      onKey: function (event) {
        if (!event || event.key !== 'Escape' || !items.size) return false;
        api.clear();
        return true;
      },
      onPopState: function (state) {
        if (!entry || (state && state.selecting)) return false;
        entry = false;
        var was = items.size > 0;
        items.clear();
        if (was) onChange(api);
        return was;
      },
      // Whether our entry is the one on top (navigating then replaces it rather than adding one)
      get ownsEntry() { return entry; }
    };
    return api;
  }

  var exported = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.SoraSelection = exported;
})(typeof window !== 'undefined' ? window : this);
