const path = require('path');
const fs = require('fs-extra');

const photoInfo = require('./photoInfoService');

const SETTINGS_FILE = '.sora-folder.json';
const ORDERS = ['shuffle', 'newest', 'oldest', 'custom'];

/**
 * How a folder plays on the frame. Kept in a hidden ".sora-folder.json" in
 * the folder itself, so it moves and is deleted along with the folder.
 *
 *   shuffle  random, never repeating recent photos (the default)
 *   newest   newest taken first      oldest  oldest taken first
 *   custom   the order set by dragging in the library ("sequence" holds
 *            file names; anything not listed plays after, by name)
 */
class PlayOrderService {
  async read(dirPath) {
    const saved = await fs.readJson(path.join(dirPath, SETTINGS_FILE)).catch(() => ({}));
    return {
      order: ORDERS.includes(saved.order) ? saved.order : 'shuffle',
      sequence: Array.isArray(saved.sequence) ? saved.sequence.filter(n => typeof n === 'string') : []
    };
  }

  async write(dirPath, settings) {
    const current = await this.read(dirPath);
    const next = { ...current, ...settings };
    await fs.writeJson(path.join(dirPath, SETTINGS_FILE), next, { spaces: 2 });
    return next;
  }

  /**
   * items ({ path, relativePath }) under baseDir, sorted for the given
   * order. Shuffle keeps them as they are (by name).
   */
  async sort(baseDir, items, order) {
    if (order === 'newest' || order === 'oldest') {
      const infos = await photoInfo.getMany(items);
      const dated = items.map((item, i) => ({ item, at: photoInfo.sortDate(infos[i]) }));
      const sign = order === 'newest' ? -1 : 1;
      dated.sort((a, b) => sign * (a.at - b.at) || a.item.path.localeCompare(b.item.path));
      return dated.map(d => d.item);
    }
    if (order === 'custom') return this.sortCustom(baseDir, items);
    return [...items].sort((a, b) => a.path.localeCompare(b.path));
  }

  // A folder's own photos in its saved sequence, then each subfolder's, in
  // name order, each using its own sequence if it has one
  async sortCustom(baseDir, items) {
    const ranks = new Map();
    for (const dir of new Set(items.map(item => path.dirname(item.path)))) {
      const { sequence } = await this.read(dir);
      ranks.set(dir, new Map(sequence.map((name, i) => [name, i])));
    }

    const parts = item => path.relative(baseDir, item.path).split(path.sep);
    return [...items].sort((a, b) => {
      const pa = parts(a);
      const pb = parts(b);
      let i = 0;
      while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
      const aFile = i === pa.length - 1;
      const bFile = i === pb.length - 1;
      if (aFile !== bFile) return aFile ? -1 : 1; // a folder's photos before its subfolders
      if (!aFile) return pa[i].localeCompare(pb[i]);

      const rank = ranks.get(path.dirname(a.path));
      const ra = rank.has(pa[i]) ? rank.get(pa[i]) : Infinity;
      const rb = rank.has(pb[i]) ? rank.get(pb[i]) : Infinity;
      return ra - rb || pa[i].localeCompare(pb[i]);
    });
  }
}

module.exports = new PlayOrderService();
module.exports.ORDERS = ORDERS;
module.exports.SETTINGS_FILE = SETTINGS_FILE;
