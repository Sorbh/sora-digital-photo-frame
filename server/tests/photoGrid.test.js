// The library's photo grid: the justified rows (js/justifiedLayout.js), the date
// groups, and selection mode (js/selectionMode.js), as pure code.
const { layout, rowHeightFor, groupByDate } = require('../public/js/justifiedLayout');
const { create } = require('../public/js/selectionMode');

const rowWidth = row => {
  const last = row.items[row.items.length - 1];
  return last.left + last.width;
};

describe('justified rows', () => {
  const shapes = [1.5, 0.75, 1, 4 / 3, 16 / 9, 2 / 3, 1.5, 1.5, 9 / 16, 1, 4 / 3, 16 / 9, 3, 1];

  test('every row but the last fills the width exactly, at one height', () => {
    for (const width of [380, 760, 1200, 1350]) {
      const { rows } = layout(shapes, { width, rowHeight: rowHeightFor(width), gap: 4 });
      rows.slice(0, -1).forEach(row => {
        expect(rowWidth(row)).toBe(width);
        row.items.forEach(item => expect(item.height).toBe(row.height));
      });
      // Gaps of 4px between neighbours, nothing overlapping
      rows.forEach(row => row.items.slice(1).forEach((item, i) => expect(item.left).toBe(row.items[i].left + row.items[i].width + 4)));
    }
  });

  test('keeps each photo\'s shape: no crop beyond a rounding pixel', () => {
    const { rows } = layout(shapes, { width: 1200, rowHeight: 230, gap: 4 });
    rows.flatMap(row => row.items).forEach(item => {
      expect(Math.abs(item.width - shapes[item.index] * item.height)).toBeLessThanOrEqual(item.height * 0.02 + 2);
    });
  });

  test('puts every photo in once, in order', () => {
    const { rows } = layout(shapes, { width: 900, rowHeight: 200, gap: 4 });
    expect(rows.flatMap(row => row.items.map(item => item.index))).toEqual(shapes.map((_, i) => i));
  });

  test('rows stay near the aimed height; the last one is not blown up', () => {
    const { rows } = layout(shapes, { width: 1200, rowHeight: 230, gap: 4 });
    rows.forEach(row => {
      expect(row.height).toBeGreaterThan(230 * 0.6);
      expect(row.height).toBeLessThanOrEqual(230 * 1.6);
    });
    const one = layout([1.5], { width: 1200, rowHeight: 230, gap: 4 });
    expect(one.rows[0].height).toBe(230);
    expect(one.rows[0].items[0].width).toBe(345);
  });

  test('rows stack with the gap between them', () => {
    const { rows, height } = layout(shapes, { width: 800, rowHeight: 180, gap: 4 });
    rows.slice(1).forEach((row, i) => expect(row.top).toBe(rows[i].top + rows[i].height + 4));
    const last = rows[rows.length - 1];
    expect(height).toBe(last.top + last.height);
  });

  test('a panorama or a tall screenshot is cropped only to 3:1 or 1:2; one never overflows a phone', () => {
    const { rows } = layout([8, 0.2], { width: 380, rowHeight: 118, gap: 3 });
    const [pano] = rows[0].items;
    expect(pano.width / pano.height).toBeCloseTo(3, 0);
    rows.forEach(row => expect(rowWidth(row)).toBeLessThanOrEqual(380));
  });

  test('unknown shapes count as 4:3; sizes may be given as width and height', () => {
    const a = layout([null, 0, { width: 400, height: 300 }], { width: 2000, rowHeight: 300, gap: 0 });
    a.rows[0].items.forEach(item => expect(item.width).toBe(400));
  });

  test('nothing to lay out, or no width: no rows', () => {
    expect(layout([], { width: 1000 }).rows).toEqual([]);
    expect(layout([1, 2], { width: 0 }).rows).toEqual([]);
  });

  test('smaller rows on phones', () => {
    expect(rowHeightFor(380)).toBeLessThan(rowHeightFor(1350));
  });
});

describe('date groups', () => {
  const at = (date, name = date) => ({ name, date });

  test('by month, in the order given', () => {
    const groups = groupByDate([at('2026-10-05T10:00:00'), at('2026-10-01T09:00:00'), at('2026-08-12T10:00:00')], { locale: 'en' });
    expect(groups.map(group => [group.label, group.files.length])).toEqual([['October 2026', 2], ['August 2026', 1]]);
  });

  test('by day when they are all in one month', () => {
    const groups = groupByDate([at('2026-10-05T10:00:00'), at('2026-10-05T08:00:00'), at('2026-10-01T09:00:00')], { locale: 'en', now: new Date(2026, 10, 27) });
    expect(groups.map(group => group.files.length)).toEqual([2, 1]);
    expect(groups[0].label).toMatch(/Oct/);
    expect(groups[0].label).toMatch(/5/);
  });

  test('in the page\'s language', () => {
    expect(groupByDate([at('2026-10-05T10:00:00'), at('2026-08-01T10:00:00')], { locale: 'de' })[0].label).toBe('Oktober 2026');
  });

  test('nothing dated: one list with no heading', () => {
    expect(groupByDate([{ name: 'a' }, { name: 'b' }])).toEqual([{ label: null, key: null, files: [{ name: 'a' }, { name: 'b' }] }]);
  });
});

describe('selection mode', () => {
  // A history with entries and Back
  function fakeHistory() {
    const entries = [{ state: null }];
    let index = 0;
    const popped = [];
    const history = {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      pushState(state) { entries.splice(index + 1); entries.push({ state }); index++; },
      back() { if (index > 0) { index--; popped.push(entries[index].state); } }
    };
    return { history, at: () => index, popped };
  }

  test('ticking one starts it; toggling ticks and unticks; the last one off ends it', () => {
    const changes = [];
    const selection = create({ onChange: s => changes.push(s.size) });
    expect(selection.active).toBe(false);
    selection.toggle('a');
    expect(selection.active).toBe(true);
    selection.toggle('b');
    selection.toggle('a');
    expect(selection.keys()).toEqual(['b']);
    selection.toggle('b');
    expect(selection.active).toBe(false);
    expect(changes).toEqual([1, 2, 1, 0]);
  });

  test('select all adds every photo once', () => {
    const selection = create({});
    selection.toggle('a');
    selection.selectAll(['a', 'b', 'c']);
    expect(selection.keys()).toEqual(['a', 'b', 'c']);
  });

  test('Escape ends it, and only when something is selected', () => {
    const selection = create({});
    expect(selection.onKey({ key: 'Escape' })).toBe(false);
    selection.selectAll(['a', 'b']);
    expect(selection.onKey({ key: 'Enter' })).toBe(false);
    expect(selection.onKey({ key: 'Escape' })).toBe(true);
    expect(selection.active).toBe(false);
  });

  test('one history entry for the whole selection; Back ends it', () => {
    const { history, at } = fakeHistory();
    const selection = create({ history });
    selection.toggle('a');
    selection.toggle('b');
    expect(at()).toBe(1);
    expect(history.state).toEqual({ selecting: true });
    history.back();
    expect(selection.onPopState(history.state)).toBe(true);
    expect(selection.active).toBe(false);
    expect(at()).toBe(0);
  });

  test('ending it another way takes its entry off', () => {
    const { history, at } = fakeHistory();
    const selection = create({ history });
    selection.toggle('a');
    selection.clear();
    expect(at()).toBe(0);
    // Back from there was the page's own, not selection's
    expect(selection.onPopState(null)).toBe(false);
  });

  test('forget() clears without touching history (the folder changed)', () => {
    const { history, at } = fakeHistory();
    const selection = create({ history });
    selection.toggle('a');
    expect(selection.ownsEntry).toBe(true);
    selection.forget();
    expect(selection.active).toBe(false);
    expect(selection.ownsEntry).toBe(false);
    expect(at()).toBe(1);
  });
});
