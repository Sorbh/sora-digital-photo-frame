const { isHeic } = require('../utils/heic');

const ftyp = (major, ...compatible) => {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const box = Buffer.alloc(8 + brands.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(brands, 8, 'latin1');
  return Buffer.concat([box, Buffer.alloc(16)]);
};

describe('isHeic', () => {
  test('finds HEVC photos by major or compatible brand', () => {
    expect(isHeic(ftyp('heic', 'mif1', 'heic'))).toBe(true);
    expect(isHeic(ftyp('mif1', 'mif1', 'heic'))).toBe(true);
  });

  test('leaves AVIF and other files to sharp', () => {
    expect(isHeic(ftyp('avif', 'mif1', 'avif'))).toBe(false);
    expect(isHeic(ftyp('mif1', 'mif1', 'avif'))).toBe(false);
    expect(isHeic(Buffer.from('not an image at all'))).toBe(false);
    expect(isHeic(undefined)).toBe(false);
  });
});
