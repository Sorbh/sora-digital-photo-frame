const fs = require('fs');
const path = require('path');

// Muted help text uses --ink-faint (= --muted-foreground). WCAG asks 4.5:1 for normal text.
const cssDir = path.join(__dirname, '..', 'public', 'css');
const sora = fs.readFileSync(path.join(cssDir, 'sora.css'), 'utf8');

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(m => [m[1], m[2]]));

describe('muted text contrast', () => {
  const light = tokens(sora.slice(sora.indexOf(':root'), sora.indexOf('html.dark:root')));
  const dark = { ...light, ...tokens(sora.slice(sora.indexOf('html.dark:root'), sora.indexOf('/* ---------- Base'))) };

  test.each([['light', light], ['dark', dark]])('%s mode: --ink-faint is at least 4.5:1 on every surface', (_, t) => {
    for (const surface of ['paper', 'paper-raised', 'paper-sunk', 'blush']) {
      expect(ratio(t['ink-faint'], t[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('muted text is not faded with opacity or transparency', () => {
    for (const file of fs.readdirSync(cssDir).filter(f => f.endsWith('.css') && f !== 'tailwind.css')) {
      const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
      expect(css).not.toMatch(/color-mix\([^)]*var\(--(muted-foreground|ink-faint)\)[^)]*transparent\)/);
    }
  });
});
