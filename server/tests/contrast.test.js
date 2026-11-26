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

// Top-level rules of a stylesheet, by exact selector
const parseRules = css => [...css.matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map(m => ({
  selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(s => s.trim()),
  decl: Object.fromEntries([...m[2].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(d => [d[1], d[2].trim()]))
}));
const declaredIn = rules => (selector, prop) => rules
  .filter(rule => rule.selectors.includes(selector) && rule.decl[prop] !== undefined)
  .map(rule => rule.decl[prop]).pop();
const declared = declaredIn(parseRules(admin));
const soraDeclared = declaredIn(parseRules(sora));
// The folder browser on /folder-selection keeps its styles in a <style> it adds itself
const browserJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'folderBrowser.js'), 'utf8');
const browserDeclared = declaredIn(parseRules(browserJs.slice(browserJs.indexOf('styles.textContent = `'), browserJs.indexOf('`;', browserJs.indexOf('styles.textContent = `')))));

// rgb(255 255 255 / 0.85) or #ffd98f as { color, alpha }
const plainColor = value => {
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/.exec(value.trim());
  if (m) return { color: [m[1], m[2], m[3]].map(Number), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return { color: rgb(value.trim()), alpha: 1 };
  if (value.trim() === '#fff') return { color: [255, 255, 255], alpha: 1 };
  throw new Error(`Unhandled colour: ${value}`);
};

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
      // The drop zone's berry wash and the hint's own radial glow, both read from admin.css
      const berryShare = value => Number((value || '').match(/var\(--berry\)\s+(\d+(?:\.\d+)?)%/)?.[1]);
      const wash = berryShare(declared('.drop-zone', 'background'));
      const glow = berryShare((declared('.drop-hint', 'background') || '').match(/radial-gradient\(.*/)?.[0]);
      expect(wash).toBeGreaterThan(0);
      expect(glow).toBeGreaterThan(0);
      const tint = dragging ? Math.max(0.12, (wash + glow) / 100) : glow / 100;
      const background = blend(rgb(token(t, 'berry')), page, tint);
      expect(ratio(blend(color, background, alpha * opacity), background)).toBeGreaterThanOrEqual(4.5);
    });
  });

  // The library banner's breadcrumbs: small white text on the berry gradient,
  // over a dark chip. Checked over each gradient stop, with and without the
  // warm glow in the banner's corner (the crumbs sit under it in RTL).
  describe('library breadcrumbs', () => {
    const gradientOf = block => /--berry-gradient:\s*([^;]+);/.exec(block)?.[1];
    const gradients = [
      ['light', gradientOf(sora.slice(sora.indexOf(':root'), sora.indexOf('html.dark:root')))],
      ['dark', gradientOf(sora.slice(sora.indexOf('html.dark:root'), sora.indexOf('/* ---------- Base')))
        || gradientOf(sora.slice(sora.indexOf(':root'), sora.indexOf('html.dark:root')))]
    ];
    const head = soraDeclared('.library-head', 'background');
    const warm = /radial-gradient\([^,]+,\s*(rgb\([^)]+\))/.exec(head);
    const chip = plainColor(soraDeclared('.library-head .breadcrumb', 'background'));
    const labels = [
      ['parent crumb', soraDeclared('.breadcrumb', 'color')],
      ['current crumb', soraDeclared('.library-head .breadcrumb li:last-child .breadcrumb-item', 'color')],
      ['hovered crumb', soraDeclared('.breadcrumb .breadcrumb-item.cursor-pointer:hover', 'color').replace(/\s*!important/, '')]
    ];
    const cases = gradients.flatMap(([mode, gradient]) => labels.map(([label, value]) => [`${label}, ${mode}`, gradient, value]));

    test('the banner, glow and chip are found', () => {
      expect(warm).not.toBeNull();
      expect(chip.alpha).toBeGreaterThan(0);
      for (const [, gradient] of gradients) expect(gradient).toMatch(/#[0-9a-f]{6}/i);
    });

    test.each(cases)('%s is at least 4.5:1', (_, gradient, value) => {
      const glow = plainColor(warm[1]);
      const { color, alpha } = plainColor(value);
      for (const stop of gradient.match(/#[0-9a-f]{6}/gi).map(rgb)) {
        for (const banner of [stop, blend(glow.color, stop, glow.alpha)]) {
          const background = blend(chip.color, banner, chip.alpha);
          expect(ratio(blend(color, background, alpha), background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  });

  // /folder-selection: the current crumb sits on a blush chip, a hovered one on the page
  describe('folder picker breadcrumbs', () => {
    const colorOf = (t, value) => rgb(token(t, /var\(--([\w-]+)\)/.exec(value)[1]));
    test.each([['light', lightTokens], ['dark', darkTokens]])('current and hovered crumbs are at least 4.5:1 (%s)', (mode, t) => {
      const dark = mode === 'dark';
      const current = (dark && browserDeclared('html.dark .breadcrumb-item:last-child', 'color')) || browserDeclared('.breadcrumb-item:last-child', 'color');
      const hovered = (dark && browserDeclared('html.dark .breadcrumb-item:hover', 'color')) || browserDeclared('.breadcrumb-item:hover', 'color');
      const chipBg = browserDeclared('.breadcrumb-item:last-child', 'background');
      expect(ratio(colorOf(t, current), colorOf(t, chipBg))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colorOf(t, hovered), rgb(token(t, 'paper')))).toBeGreaterThanOrEqual(4.5);
      // Parents at rest use the muted ink
      expect(ratio(colorOf(t, browserDeclared('.breadcrumb-item', 'color')), rgb(token(t, 'paper')))).toBeGreaterThanOrEqual(4.5);
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
