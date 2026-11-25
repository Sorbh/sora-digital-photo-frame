const fs = require('fs');
const path = require('path');

// Codes, PINs and addresses must stay left-to-right inside Arabic pages,
// or "399-P7H" shows as "P7H-399" and "192.168.1.5:3000/pair" as "pair/...".
const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const tagWithId = (html, id) => (html.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`, 'i')) || [''])[0];

describe('left-to-right codes in right-to-left pages', () => {
  test.each([
    ['slideshow.html', 'pairCode'],
    ['slideshow.html', 'familyCodeInput'],
    ['slideshow.html', 'pinInput'],
    ['pair.html', 'codeShown'],
    ['access-accounts.html', 'familyCodeValue'],
    ['access-accounts.html', 'accountPin']
  ])('%s #%s has dir="ltr"', (file, id) => {
    const tag = tagWithId(read(file), id);
    expect(tag).not.toBe('');
    expect(tag).toMatch(/\sdir="ltr"/);
  });

  test('the PIN cells fill left to right, like the PIN input', () => {
    expect(read('slideshow.html')).toMatch(/<div class="pin-cells"[^>]*\sdir="ltr"/);
  });

  test('the pairing address in the hint is an ltr span', () => {
    const source = read('js/slideshow.js');
    const renderPairHint = source.slice(source.indexOf('renderPairHint() {'), source.indexOf('renderLanguage() {'));
    expect(renderPairHint).toMatch(/url\.id = 'pairUrl'/);
    expect(renderPairHint).toMatch(/url\.dir = 'ltr'/);
  });

  // Rules (selector -> declarations) of a stylesheet, outside media queries
  const rulesOf = css => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[1].trim(), body: m[2] }));

  test('the note spine is placed from the inline start, so it follows the mirrored columns', () => {
    const rules = rulesOf(read('css/notePage.css'));
    const spine = rules.filter(r => /\.note-page[^,]*::before/.test(r.selector) && /inset-inline-start|left|right/.test(r.body));
    expect(spine.length).toBeGreaterThan(0);
    for (const rule of spine) {
      expect(rule.body).not.toMatch(/(^|[\s;])(left|right)\s*:/);
      expect(rule.body).not.toMatch(/translateX/);
    }
    const base = rules.find(r => r.selector === '.note-page:not(.layout-cover)::before');
    expect(base.body).toMatch(/inset-inline-start:\s*40%/);
  });

  test('nested folders indent from the inline start', () => {
    const source = read('js/folderSelector.js');
    expect(source).toMatch(/padding-inline-start: \$\{indentPadding\}px/);
    expect(source).not.toMatch(/padding-left: \$\{indentPadding\}px/);
  });
});
