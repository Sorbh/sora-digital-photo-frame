const fs = require('fs');
const path = require('path');

// The slideshow dock has seven 44px buttons. From 320px up to the width where
// the dividers come back, it must fit on one row, or it wraps over the date
// and weather.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'slideshow.css'), 'utf8');

describe('slideshow dock on small phones', () => {
  const slim = [...css.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)]
    .find(m => /\.dock-divider\s*\{\s*display:\s*none/.test(m[2]));

  test('dividers are hidden up to at least 360px', () => {
    expect(slim).toBeDefined();
    expect(Number(slim[1])).toBeGreaterThanOrEqual(360);
  });

  test('seven 44px buttons and the slim frame fit a 320px screen with its 8px margin', () => {
    const padding = /\.controls\s*\{[^}]*padding:\s*(\d+)px\s+(\d+)px/.exec(slim[2]);
    expect(padding).not.toBeNull();
    const width = 7 * 44 + 2 * Number(padding[2]);
    expect(width).toBeLessThanOrEqual(320 - 8);
  });

  test('above that width the dividers and frame still fit (360px plus one)', () => {
    // 7 x 44 + 2 dividers (1px + 2 x 4px margin) + 2 x 6px frame
    const width = 7 * 44 + 2 * (1 + 8) + 2 * 6;
    expect(width).toBeLessThanOrEqual(Number(slim[1]) + 1 - 8);
  });
});
