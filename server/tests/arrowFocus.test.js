const SoraArrowFocus = require('../public/js/arrowFocus');

const box = (left, top, width = 100, height = 60) => ({ left, top, right: left + width, bottom: top + height });

describe('arrow key focus (TV remotes)', () => {
  // A 3 x 2 grid of folder cards, 20px apart
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 80), box(120, 80), box(240, 80)];
  const from = i => [grid[i], grid.filter((_, j) => j !== i), j => grid.indexOf(grid.filter((_, k) => k !== i)[j])];

  test.each([
    [0, 'right', 1], [1, 'right', 2], [1, 'left', 0],
    [0, 'down', 3], [4, 'up', 1], [5, 'left', 4]
  ])('from card %i, %s goes to card %i', (start, direction, expected) => {
    const [rect, others, original] = from(start);
    expect(original(SoraArrowFocus.pick(rect, others, direction))).toBe(expected);
  });

  test('nothing that way gives -1, so the page can scroll', () => {
    const [rect, others] = from(2);
    expect(SoraArrowFocus.pick(rect, others, 'right')).toBe(-1);
    expect(SoraArrowFocus.pick(rect, others, 'up')).toBe(-1);
  });

  test('down prefers the card below over a nearer one off to the side', () => {
    const cards = [box(240, 70), box(0, 100)];
    expect(SoraArrowFocus.pick(box(0, 0), cards, 'down')).toBe(1);
  });

  test('a button on the same row (the browse arrow) is right of its card, not below', () => {
    const card = box(0, 0, 240, 80);
    const browse = box(250, 22, 36, 36);
    const below = box(0, 100, 240, 80);
    expect(SoraArrowFocus.pick(card, [browse, below], 'right')).toBe(0);
    expect(SoraArrowFocus.pick(card, [browse, below], 'down')).toBe(1);
  });

  test('a dock row: left and right walk the buttons, up and down find none', () => {
    const dock = [box(0, 0, 44, 44), box(50, 0, 44, 44), box(100, 0, 120, 44), box(230, 0, 44, 44)];
    expect(SoraArrowFocus.pick(dock[1], [dock[0], dock[2], dock[3]], 'right')).toBe(1);
    expect(SoraArrowFocus.pick(dock[1], [dock[0], dock[2], dock[3]], 'left')).toBe(0);
    expect(SoraArrowFocus.pick(dock[1], [dock[0], dock[2], dock[3]], 'down')).toBe(-1);
  });

  test('next() skips hidden buttons and unknown keys', () => {
    const el = rect => ({ getBoundingClientRect: () => rect });
    const current = el(box(0, 0));
    const hidden = el({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    const right = el({ ...box(120, 0), width: 100, height: 60 });
    expect(SoraArrowFocus.next([current, hidden, right], current, 'ArrowRight')).toBe(right);
    expect(SoraArrowFocus.next([current, hidden, right], current, 'Enter')).toBe(null);
  });
});
