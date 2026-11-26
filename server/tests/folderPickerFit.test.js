const fs = require('fs');
const path = require('path');

// The slideshow folder picker hangs above the dock. Its whole panel (header,
// list, loading and error blocks) must fit between the dock and the top of the
// screen, or an error under the list pushes the header and close button off
// screen on a phone on its side (#60). There is no browser in the test run, so
// this reads the CSS and does the sums; it is not a real layout test.
const picker = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'folderSelector.js'), 'utf8');
const slideshow = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'slideshow.css'), 'utf8');

const REM = 16;
const rule = (source, selector, from = 0) => {
  const at = source.indexOf(`${selector} {`, from);
  if (at < 0) return null;
  return source.slice(at, source.indexOf('}', at));
};
const mediaBlock = (source, query) => {
  const at = source.indexOf(`@media ${query} {`);
  return at < 0 ? '' : source.slice(at, source.indexOf('\n            }\n', source.indexOf('{', at) + 1) + 1);
};
// "calc(100dvh - 8rem - ...)": the rem taken off the visible height
const capRem = block => {
  const m = /max-height:\s*calc\(100dvh - ([\d.]+)rem/.exec(block);
  return m ? Number(m[1]) : null;
};
const gapPx = block => Number(/bottom:\s*calc\(100% \+ (\d+)px\)/.exec(block)[1]);

describe('slideshow folder picker fits above the dock', () => {
  const panel = rule(picker, '.folder-dropdown');
  const shortScreens = mediaBlock(picker, '(max-height: 520px)');
  const shortPanel = rule(shortScreens, '.folder-dropdown');

  // The dock: 44px buttons inside its padding
  const controls = rule(slideshow, '.controls');
  const dockPadding = Number(/padding:\s*(\d+)px/.exec(controls)[1]);
  const dockHeight = 44 + 2 * dockPadding;
  // bottom: calc(clamp(1.25rem, 4vh, 2.5rem) + inset) on most screens, 1rem on narrow ones
  const [, lo, vh, hi] = /bottom:\s*calc\(clamp\(([\d.]+)rem,\s*([\d.]+)vh,\s*([\d.]+)rem\)/.exec(controls).map(Number);
  const dockBottom = height => Math.min(hi * REM, Math.max(lo * REM, (vh / 100) * height));

  test('the whole panel is capped and scrolls, not just the list', () => {
    expect(panel).toMatch(/display:\s*flex/);
    expect(panel).toMatch(/flex-direction:\s*column/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(capRem(panel)).not.toBeNull();
    expect(capRem(shortPanel)).not.toBeNull();
    // Both caps leave out the safe areas
    for (const block of [panel, shortPanel]) {
      expect(block).toMatch(/env\(safe-area-inset-top/);
      expect(block).toMatch(/env\(safe-area-inset-bottom/);
    }
  });

  test('the list gives way to the header and error block', () => {
    const list = rule(picker, '.folder-options');
    expect(list).toMatch(/min-height:\s*0/);
    expect(list).toMatch(/flex:\s*0 1 auto/);
    expect(picker).toMatch(/\.folder-dropdown-header,\s*\.folder-loading,\s*\.folder-error\s*\{\s*flex-shrink:\s*0/);
  });

  // [width, height, narrow (<= 640px), short (<= 520px)]
  const screens = [
    ['phone on its side', 667, 260, false, true],
    ['small phone on its side', 568, 320, true, true],
    ['phone upright', 360, 640, true, false],
    ['laptop', 1280, 800, false, false]
  ];

  test.each(screens)('the top of the panel stays on screen: %s, %ix%i', (name, width, height, narrow, short) => {
    const bottom = narrow ? 1 * REM : dockBottom(height);
    const gap = short ? gapPx(shortPanel) : (width <= 600 ? 12 : gapPx(panel));
    const cap = height - (short ? capRem(shortPanel) : capRem(panel)) * REM;
    const top = height - bottom - dockHeight - gap - cap;
    expect(top).toBeGreaterThanOrEqual(4);
    // and still leaves room for the header, one folder row and the error block
    expect(cap).toBeGreaterThanOrEqual(150);
  });
});
