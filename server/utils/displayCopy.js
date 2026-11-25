const sharp = require('sharp');
const { sharpInput } = require('./heic');

// Most pixels decoded for one upload, all animation frames together (100 MP:
// a 48 MP phone photo or a long panorama fits), and most animation frames
const MAX_PIXELS = parseInt(process.env.MAX_IMAGE_PIXELS) || 100 * 1000 * 1000;
const MAX_FRAMES = 500;

function tooLarge() {
  const error = new Error('Image too large. Use a smaller photo or a shorter animation.');
  error.status = 400;
  error.code = 'IMAGE_TOO_LARGE';
  return error;
}

// Checked from the file's header, before anything is decoded
async function checkSize(input, options) {
  let meta;
  try {
    meta = await sharp(input, { ...options, limitInputPixels: false }).metadata(); // reads the header only
  } catch {
    return; // not an image: the conversion below says so
  }
  const frames = options.animated ? (meta.pages || 1) : 1;
  const frameHeight = options.animated && meta.pageHeight ? meta.pageHeight : meta.height;
  if (frames > MAX_FRAMES || meta.width * frameHeight * frames > MAX_PIXELS) throw tooLarge();
}

// The copy of a photo that frames show: upright, WebP, sized for screens, with
// no metadata (GPS stays private). Anything that isn't an image fails here, so
// nothing but WebP is ever stored, whatever the upload or import called itself.
async function displayCopy(buffer, { animated = false } = {}) {
  const [input, options] = await sharpInput(buffer, { animated, limitInputPixels: MAX_PIXELS }, { maxPixels: MAX_PIXELS, tooLarge });
  await checkSize(input, options);
  return sharp(input, options)
    .rotate()
    .resize(
      parseInt(process.env.MAX_RESOLUTION_WIDTH) || 2560,
      parseInt(process.env.MAX_RESOLUTION_HEIGHT) || 2560,
      { fit: 'inside', withoutEnlargement: true }
    )
    .webp({ quality: parseInt(process.env.IMAGE_QUALITY) || 82 })
    .toBuffer();
}

// The same size check for a photo already in the library, before decoding it again
async function assertImageSize(buffer) {
  await checkSize(buffer, {});
}

module.exports = { displayCopy, assertImageSize, MAX_PIXELS, MAX_FRAMES };
