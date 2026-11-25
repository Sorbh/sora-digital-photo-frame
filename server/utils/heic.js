const decode = require('heic-decode');

// HEVC-coded HEIF (iPhone photos). AVIF uses the same container but sharp
// reads it itself; the bundled libvips has no HEVC decoder, so these go
// through libheif compiled to WebAssembly instead.
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

function isHeic(buffer) {
  if (!buffer || buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const end = Math.min(buffer.readUInt32BE(0), buffer.length);
  if (HEVC_BRANDS.has(buffer.toString('ascii', 8, 12))) return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (HEVC_BRANDS.has(buffer.toString('ascii', offset, offset + 4))) return true;
  }
  return false;
}

// Arguments for sharp(): raw RGBA pixels for HEIC, the file itself otherwise.
// libheif applies the photo's rotation while decoding. With maxPixels, a bigger
// HEIC throws tooLarge() before its pixels are decoded.
async function sharpInput(buffer, options = {}, { maxPixels = Infinity, tooLarge = () => new Error('Image too large') } = {}) {
  if (!isHeic(buffer)) return [buffer, options];
  const images = await decode.all({ buffer });
  try {
    const [image] = images;
    if (image.width * image.height > maxPixels) throw tooLarge();
    const { width, height, data } = await image.decode();
    const raw = { raw: { width, height, channels: 4 } };
    if (options.limitInputPixels) raw.limitInputPixels = options.limitInputPixels;
    return [Buffer.from(data.buffer, data.byteOffset, data.byteLength), raw];
  } finally {
    images.dispose();
  }
}

module.exports = { isHeic, sharpInput };
