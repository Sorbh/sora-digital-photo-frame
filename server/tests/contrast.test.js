const fs = require('fs');
const path = require('path');

// Muted help text uses --ink-faint (= --muted-foreground). WCAG asks 4.5:1 for normal text.
const cssDir = path.join(__dirname, '..', 'public', 'css');
const sora = fs.readFileSync(path.join(cssDir, 'sora.css'), 'utf8');
const admin = fs.readFileSync(path.join(cssDir, 'admin.css'), 'utf8');

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = c => {
  const [r, g, b] = c.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Colour `c` drawn at `alpha` over `bg`
const blend = (c, bg, alpha) => c.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));

// Custom properties of a block: hex values and var() references
const tokens = block => Object.fromEntries(
  [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}|var\(--[\w-]+\))\s*;/gi)].map(m => [m[1], m[2]]));
const lightTokens = tokens(sora.slice(sora.indexOf(':root'), sora.indexOf('html.dark:root')));
const darkTokens = { ...lightTokens, ...tokens(sora.slice(sora.indexOf('html.dark:root'), sora.indexOf('/* ---------- Base'))) };
const token = (t, name) => {
  const value = t[name];
  const ref = /^var\(--([\w-]+)\)$/.exec(value || '');
  return ref ? token(t, ref[1]) : value;
};

// A CSS colour value as { color, alpha }; color-mix with transparent becomes alpha
const resolveColor = (value, t) => {
  const mix = /color-mix\(in \w+,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*transparent\)/.exec(value);
  if (mix) return { color: rgb(token(t, mix[1])), alpha: Number(mix[2]) / 100 };
  const v = /var\(--([\w-]+)\)/.exec(value);
  if (v) return { color: rgb(token(t, v[1])), alpha: 1 };
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return { color: rgb(value.trim()), alpha: 1 };
  throw new Error(`Unhandled colour: ${value}`);
};

// Top-level rules of admin.css, by exact selector
const rules = [...admin.matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map(m => ({
  selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(s => s.trim()),
  decl: Object.fromEntries([...m[2].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(d => [d[1], d[2].trim()]))
}));
const declared = (selector, prop) => rules
  .filter(rule => rule.selectors.includes(selector) && rule.decl[prop] !== undefined)
  .map(rule => rule.decl[prop]).pop();

describe('muted text contrast', () => {
  test.each([['light', lightTokens], ['dark', darkTokens]])('%s mode: --ink-faint is at least 4.5:1 on every surface', (_, t) => {
    for (const surface of ['paper', 'paper-raised', 'paper-sunk', 'blush']) {
      expect(ratio(rgb(token(t, 'ink-faint')), rgb(token(t, surface)))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('muted text is not faded with color-mix transparency', () => {
    for (const file of fs.readdirSync(cssDir).filter(f => f.endsWith('.css') && f !== 'tailwind.css')) {
      const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
      expect(css).not.toMatch(/color-mix\([^)]*var\(--(muted-foreground|ink-faint)\)[^)]*transparent\)/);
    }
  });

  // The library drop hints: colour, colour-mix alpha and opacity together, at
  // rest and while files are dragged over the page (when the page and the
  // hint pick up a berry tint, taken here as 12% berry over the page).
  describe('library drop hints', () => {
    const lines = [
      ['main line', ['.drop-hint', '.drop-hint p']],
      ['second line', ['.drop-hint', '.drop-hint p', '.drop-hint .drop-hint-sub']]
    ];
    const states = [
      ['light', lightTokens, false], ['dark', darkTokens, false],
      ['light, dragging', lightTokens, true], ['dark, dragging', darkTokens, true]
    ];
    const cases = states.flatMap(([state, t, dragging]) => lines.map(([line, chain]) => [`${line}, ${state}`, t, dragging, chain]));

    test('the hint rules are found', () => {
      expect(declared('.drop-hint', 'color')).toBeDefined();
      expect(declared('.app.file-dragging .drop-hint', 'color')).toBeDefined();
    });

    test.each(cases)('%s is at least 4.5:1', (_, t, dragging, chain) => {
      const dark = t === darkTokens;
      const colorValue = (dark && dragging && declared('html.dark .app.file-dragging .drop-hint', 'color'))
        || (dragging && declared('.app.file-dragging .drop-hint', 'color'))
        || chain.map(sel => declared(sel, 'color')).filter(Boolean).pop();
      const { color, alpha } = resolveColor(colorValue, t);
      const opacity = chain.reduce((product, sel) => product * Number(declared(sel, 'opacity') ?? 1), 1);
      const page = rgb(token(t, 'paper'));
      // The drop zone's berry wash, read from admin.css, plus a margin for the soft glow around it
      const wash = Number((declared('.drop-zone', 'background') || '').match(/var\(--berry\)\s+(\d+(?:\.\d+)?)%/)?.[1]);
      expect(wash).toBeGreaterThan(0);
      const background = dragging ? blend(rgb(token(t, 'berry')), page, Math.max(0.12, wash / 100 + 0.07)) : page;
      expect(ratio(blend(color, background, alpha * opacity), background)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('phone tab bar', () => {
    test.each([['light', lightTokens], ['dark', darkTokens]])('labels stay readable over any photo (%s)', (_, t) => {
      const block = sora.slice(sora.indexOf('    .tabbar {', sora.indexOf('@media (max-width: 640px)')));
      const background = block.slice(0, block.indexOf('}')).match(/\n\s*background:\s*([^;]+);/)[1].trim();
      // Must be solid: a see-through bar lets a white or black photo shift the label contrast
      expect(background).toBe('var(--paper-raised)');
      expect(ratio(rgb(token(t, 'ink-faint')), rgb(token(t, 'paper-raised')))).toBeGreaterThanOrEqual(4.5);
    });
  });
});
