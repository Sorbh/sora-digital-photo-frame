const libheif = require('libheif-js/wasm-bundle');

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

// The first image's RGBA pixels. Measured before decoding: a bigger one than
// maxPixels throws tooLarge(). libheif's memory is given back on every path,
// a file it cannot read included.
async function decodeHeic(buffer, maxPixels, tooLarge) {
  await libheif.ready;
  const decoder = new libheif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(buffer) || [];
    const [image] = images;
    if (!image) throw new Error('HEIF image not found');
    const width = image.get_width();
    const height = image.get_height();
    if (width * height > maxPixels) throw tooLarge();
    const data = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (shown) => {
        if (shown) resolve(shown.data);
        else reject(new Error('HEIF processing error'));
      });
    });
    return { width, height, data };
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) decoder.decoder.delete();
  }
}

// Arguments for sharp(): raw RGBA pixels for HEIC, the file itself otherwise.
// libheif applies the photo's rotation while decoding.
async function sharpInput(buffer, options = {}, { maxPixels = Infinity, tooLarge = () => new Error('Image too large') } = {}) {
  if (!isHeic(buffer)) return [buffer, options];
  const { width, height, data } = await decodeHeic(buffer, maxPixels, tooLarge);
  const raw = { raw: { width, height, channels: 4 } };
  if (options.limitInputPixels) raw.limitInputPixels = options.limitInputPixels;
  return [Buffer.from(data.buffer, data.byteOffset, data.byteLength), raw];
}

module.exports = { isHeic, sharpInput, libheif };
