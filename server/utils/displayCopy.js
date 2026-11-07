const sharp = require('sharp');
const { sharpInput } = require('./heic');

// The copy of a photo that frames show: upright, WebP, sized for screens, with
// no metadata (GPS stays private). Anything that isn't an image fails here, so
// nothing but WebP is ever stored, whatever the upload or import called itself.
async function displayCopy(buffer, { animated = false } = {}) {
  return sharp(...await sharpInput(buffer, { animated }))
    .rotate()
    .resize(
      parseInt(process.env.MAX_RESOLUTION_WIDTH) || 2560,
      parseInt(process.env.MAX_RESOLUTION_HEIGHT) || 2560,
      { fit: 'inside', withoutEnlargement: true }
    )
    .webp({ quality: parseInt(process.env.IMAGE_QUALITY) || 82 })
    .toBuffer();
}

module.exports = { displayCopy };
