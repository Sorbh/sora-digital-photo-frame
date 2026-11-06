const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const localesDir = path.join(publicDir, 'locales');
const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) =>
  child && typeof child === 'object' ? flatten(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]);
const keys = object => flatten(object).map(([key]) => key).sort();
const placeholders = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

describe('browser translations', () => {
  const english = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
  const englishKeys = keys(english);

  test('every catalogue has the English key set and placeholders', () => {
    for (const filename of fs.readdirSync(localesDir).filter(file => file.endsWith('.json'))) {
      const catalogue = JSON.parse(fs.readFileSync(path.join(localesDir, filename), 'utf8'));
      // A language may add the plural forms it needs (Arabic: _zero, _two, _few, _many)
      // to any English _one/_other pair, and nothing else.
      const extra = key => {
        const match = key.match(/^(.*)_(zero|two|few|many)$/);
        return Boolean(match && englishKeys.includes(`${match[1]}_other`));
      };
      expect(keys(catalogue).filter(key => !extra(key))).toEqual(englishKeys);
      for (const [key, value] of flatten(catalogue).filter(([key]) => extra(key))) {
        const base = flatten(english).find(([other]) => other === key.replace(/_(zero|two|few|many)$/, '_other'))[1];
        // Every placeholder must be a real one; {count} may be left out ("two minutes" as one word)
        expect(placeholders(value).filter(name => name !== 'count')).toEqual(placeholders(base).filter(name => name !== 'count'));
      }
      for (const [key, value] of flatten(english)) {
        // A singular may say "a minute" instead of "1 minute"
        const optional = name => key.endsWith('_one') && name === 'count';
        const translated = placeholders(flatten(catalogue).find(([other]) => other === key)[1]).filter(name => !optional(name));
        expect(translated).toEqual(placeholders(value).filter(name => !optional(name)));
      }
    }
  });

  test('HTML data-i18n keys exist in English', () => {
    const available = new Set(englishKeys);
    for (const filename of fs.readdirSync(publicDir).filter(file => file.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(publicDir, filename), 'utf8');
      for (const match of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) expect(available).toContain(match[1]);
      for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        match[1].split(';').forEach(part => expect(available).toContain(part.trim().split(':')[1]));
      }
    }
  });

  test("literal t('key') calls exist in English", () => {
    const available = new Set(englishKeys);
    const jsDirs = [publicDir, path.join(publicDir, 'js')];
    for (const jsDir of jsDirs) {
      const files = fs.readdirSync(jsDir, { recursive: true }).filter(file => String(file).endsWith('.js'));
      for (const file of files) {
        const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
        for (const match of source.matchAll(/(?:\.t|(?<![\w.])t)\(\s*['\"]([^'\"]+)['\"]/g)) {
          const key = match[1];
          expect(available.has(key) || available.has(`${key}_one`) || available.has(`${key}_other`)).toBe(true);
        }
      }
    }
  });
});
