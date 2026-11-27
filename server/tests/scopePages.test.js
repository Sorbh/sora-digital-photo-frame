// The pages hide what a person a library is shared with can't use: js/scope.js
// reads their scope from /api/features and marks the page; elements marked
// data-edit-only or data-owner-only are then hidden by css/sora.css.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8');
// A page as the browser gets it, with the shared header and tab bar (views/pages.js)
const { renderPage } = require('../views/pages');

// The opening tag of the element with this id, or of the first match of a pattern
const tag = (html, idOrPattern) => {
  const pattern = typeof idOrPattern === 'string' ? new RegExp(`<[a-z]+[^>]*\\bid="${idOrPattern}"[^>]*>`) : idOrPattern;
  const found = html.match(pattern);
  if (!found) throw new Error(`No element for ${idOrPattern}`);
  return found[0];
};

// Runs js/scope.js with /api/features answering features (or failing)
async function runScope(features) {
  const classes = new Set();
  const events = [];
  const context = {
    document: { documentElement: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } } },
    fetch: async () => (features ? { ok: true, json: async () => features } : { ok: false, json: async () => ({}) }),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    window: null
  };
  context.window = context;
  context.dispatchEvent = (event) => events.push(event);
  vm.createContext(context);
  vm.runInContext(read('js/scope.js'), context);
  const answered = await context.SoraScope.ready;
  return { classes, events, answered, SoraScope: context.SoraScope };
}

describe('js/scope.js', () => {
  test('"can view" marks the page view-only, and not the owner\'s', async () => {
    const { classes, SoraScope, events } = await runScope({ googlePhotosEnabled: true, scope: { folders: ['Family'], canEdit: false, isOwner: false } });
    expect([...classes].sort()).toEqual(['not-owner', 'view-only']);
    expect(SoraScope.canEdit()).toBe(false);
    expect(SoraScope.isOwner()).toBe(false);
    expect(events.map(event => event.type)).toEqual(['sora:scope']);
  });

  test('an editor who isn\'t the owner can edit, without Access', async () => {
    const { classes, SoraScope } = await runScope({ scope: { folders: ['Family'], canEdit: true, isOwner: false } });
    expect([...classes]).toEqual(['not-owner']);
    expect(SoraScope.canEdit()).toBe(true);
  });

  test('no scope (self-hosted), or no answer, hides nothing', async () => {
    for (const features of [{ googlePhotosEnabled: false, scope: null }, null]) {
      const { classes, answered, SoraScope } = await runScope(features);
      expect([...classes]).toEqual([]);
      expect(answered).toEqual(features);
      expect(SoraScope.canEdit() && SoraScope.isOwner()).toBe(true);
    }
  });
});

describe('what each page hides', () => {
  test('sora.css hides marked elements', () => {
    const css = read('css/sora.css');
    expect(css).toMatch(/\.view-only \[data-edit-only\],\s*\.read-only-folder \[data-edit-only\],\s*\.not-owner \[data-owner-only\]\s*\{\s*display: none !important;/);
  });

  test('the library: edit controls for viewers, Access for the owner', () => {
    const html = renderPage('admin.html');
    expect(html).toContain('<script src="/js/scope.js"></script>');
    for (const id of ['createFolderBtn', 'createSnapBtn', 'createNoteBtn', 'uploadBtn', 'selectionFab', 'dropZone', 'dropHint', 'addTabBtn']) {
      expect(tag(html, id)).toContain('data-edit-only');
    }
    expect(tag(html, /<label class="play-order"[^>]*>/)).toContain('data-edit-only');
    expect(tag(html, /<a [^>]*data-header-item="access"[^>]*>/)).toContain('data-owner-only');
    expect(tag(html, /<a href="\/access-accounts" class="tab"[^>]*>/)).toContain('data-owner-only');
    // Connecting Google Photos is the owner's, importing is a change
    expect(tag(html, 'googlePhotosBtn')).toMatch(/data-owner-only data-edit-only/);

    // Grid tiles: the options menu and selecting (viewers click a photo to view it, nothing else)
    const admin = read('admin.js');
    expect(admin).toContain('class="folder-more" data-edit-only');
    expect(admin).toContain('class="photo-grid-checkbox" data-edit-only');
    expect(admin).toContain('class="btn-icon photo-more" data-edit-only');
    // The selection bar's actions sit inside the edit-only bar
    for (const id of ['bulkDeleteBtn', 'bulkMoveBtn', 'selectAllBtn']) {
      expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(html.indexOf('id="selectionFab"'));
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(html.indexOf('</div>', html.indexOf('id="selectionFab"')));
    }
  });

  test('notes and snaps: no saving, adding or changing for viewers', () => {
    const notes = renderPage('notes.html');
    expect(notes).toContain('<script src="/js/scope.js"></script>');
    for (const id of ['createNoteBtn', 'saveNoteBtn']) expect(tag(notes, id)).toContain('data-edit-only');
    expect(tag(notes, /<button type="button" class="tab-fab" data-proxy="createNoteBtn"[^>]*>/)).toContain('data-edit-only');
    for (const link of notes.match(/<a href="\/access-accounts"[^>]*>/g)) expect(link).toContain('data-owner-only');
    expect(read('css/notes.css')).toMatch(/\.view-only \.note-card-actions,\s*\.view-only \.note-toggle\s*\{\s*display: none !important;/);

    const snap = renderPage('snap.html');
    expect(snap).toContain('<script src="/js/scope.js"></script>');
    expect(tag(snap, 'saveSnapBtn')).toContain('data-edit-only');

    const folders = read('folder-selection.html');
    for (const link of folders.match(/<a href="\/access-accounts"[^>]*>/g)) expect(link).toContain('data-owner-only');
  });
});
