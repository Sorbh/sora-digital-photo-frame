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

  test('the pairing address in the hint is an ltr span', () => {
    const source = read('js/slideshow.js');
    const renderPairHint = source.slice(source.indexOf('renderPairHint() {'), source.indexOf('renderLanguage() {'));
    expect(renderPairHint).toMatch(/url\.id = 'pairUrl'/);
    expect(renderPairHint).toMatch(/url\.dir = 'ltr'/);
  });

  test('nested folders indent from the inline start', () => {
    const source = read('js/folderSelector.js');
    expect(source).toMatch(/padding-inline-start: \$\{indentPadding\}px/);
    expect(source).not.toMatch(/padding-left: \$\{indentPadding\}px/);
  });
});
