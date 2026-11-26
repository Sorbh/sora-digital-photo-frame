// What an end-to-end run on phones found on the pages themselves:
// - a refused upload's message sat behind the upload dialog's backdrop and the
//   phone's tab bar, and was shown once per press of a button that stayed live
// - "Add a screen" and /pair put their errors under the button kept at the bottom
// - the library page came back from the back/forward cache with another
//   library's folders after switching libraries
// Run on the real page scripts with a small stand-in for the browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SoraToastLayer = require('../public/js/toastLayer');

const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

// An element with what these scripts touch, and a record of focus and scrolling
function element(id, tag = 'div') {
  const classes = new Set();
  const listeners = {};
  const el = {
    id, tagName: tag.toUpperCase(), textContent: '', innerHTML: '', value: '', disabled: false, open: false,
    dataset: {}, style: {}, children: [], parentNode: null, focused: 0, scrolled: 0, popoverOpen: false, shown: 0,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, on) => ((on === undefined ? !classes.has(name) : on) ? classes.add(name) : classes.delete(name))
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type, event = {}) => (listeners[type] || []).forEach(fn => fn({ type, target: el, preventDefault() {}, ...event })),
    focus() { el.focused += 1; },
    scrollIntoView() { el.scrolled += 1; },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child);
      child.parentNode = el;
      el.children.push(child);
      // Leaving its place hides a popover, as in a browser
      child.popoverOpen = false;
      return child;
    },
    contains: other => other === el || el.children.some(child => child.contains(other)),
    matches: selector => (selector === ':modal' ? el.open : selector === ':popover-open' ? el.popoverOpen : false),
    showPopover() { el.popoverOpen = true; el.shown += 1; },
    showModal() { el.open = true; },
    close() { el.open = false; },
    hidePopover() { el.popoverOpen = false; },
    remove() {}
  };
  return el;
}

// A page: elements by id, open dialogs, document events
function fakeDocument() {
  const elements = {};
  const listeners = {};
  const document = {
    body: element('body', 'body'),
    dialogs: [],
    getElementById: id => (elements[id] ||= element(id)),
    querySelector: () => element('any'),
    querySelectorAll: selector => (selector === 'dialog[open]' ? document.dialogs.filter(d => d.open) : []),
    addEventListener: (type, fn, capture) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent: event => { (listeners[event.type] || []).forEach(fn => fn(event)); return true; },
    events: [],
    fire: (type, event) => (listeners[type] || []).forEach(fn => fn(event))
  };
  return { document, el: document.getElementById };
}

describe('Toasts in front of dialogs (js/toastLayer.js)', () => {
  test('with no dialog open, the holder is on the page and shown in the top layer', () => {
    const { document } = fakeDocument();
    const holder = element('toaster');
    SoraToastLayer.raise(holder, document);
    expect(holder.parentNode).toBe(document.body);
    expect(holder.popoverOpen).toBe(true);
  });

  test('with a dialog open, it goes into the top one, and is shown again on top of it each time', () => {
    const { document } = fakeDocument();
    const holder = element('toaster');
    document.body.appendChild(holder);
    const lower = element('uploadModal', 'dialog');
    const upper = element('confirm', 'dialog');
    document.dialogs.push(lower, upper);
    lower.open = true;
    SoraToastLayer.raise(holder, document);
    expect(holder.parentNode).toBe(lower);
    expect(holder.popoverOpen).toBe(true);

    upper.open = true;
    SoraToastLayer.raise(holder, document);
    expect(holder.parentNode).toBe(upper);

    // Already there and shown: hidden and shown again, so it is the newest on top
    const before = holder.shown;
    SoraToastLayer.raise(holder, document);
    expect(holder.shown).toBe(before + 1);
    expect(holder.popoverOpen).toBe(true);
  });

  test('when its dialog closes it comes back to the page, still shown', () => {
    const { document } = fakeDocument();
    const holder = element('toaster');
    const dialog = element('uploadModal', 'dialog');
    document.dialogs.push(dialog);
    dialog.open = true;
    SoraToastLayer.follow(holder, document);
    SoraToastLayer.raise(holder, document);
    expect(holder.parentNode).toBe(dialog);

    dialog.open = false;
    document.fire('close', { target: dialog });
    expect(holder.parentNode).toBe(document.body);
    expect(holder.popoverOpen).toBe(true);
  });

  test('browsers without popovers still get it inside the open dialog', () => {
    const { document } = fakeDocument();
    const holder = element('toaster');
    delete holder.showPopover;
    const dialog = element('uploadModal', 'dialog');
    document.dialogs.push(dialog);
    dialog.open = true;
    expect(() => SoraToastLayer.raise(holder, document)).not.toThrow();
    expect(holder.parentNode).toBe(dialog);
  });

  test.each([['admin.html', 'toaster'], ['access-accounts.html', 'toastContainer']])('%s: the toast holder is a manual popover, and the layer script loads', (file, id) => {
    const html = read(file);
    expect(html).toMatch(new RegExp(`<div id="${id}"[^>]*popover="manual"`));
    expect(html).toContain('<script src="/js/toastLayer.js"></script>');
  });

  test('on phones the library toasts sit above the tab bar', () => {
    const css = read('css/admin.css');
    expect(css).toMatch(/@media \(max-width: 640px\)\s*{\s*body:has\(\.tabbar\) #toaster\s*{\s*bottom: calc\(78px/);
  });
});

// ---------------------------------------------------------------------------
// The library page (admin.js)

function loadAdmin({ uploadAll } = {}) {
  const { document, el } = fakeDocument();
  const windowListeners = {};
  const events = [];
  document.dispatchEvent = event => { events.push(event); return true; };
  const sandbox = {
    document,
    console: { log() {}, error() {}, warn() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    i18n: { error: (data, fallback) => (data && data.message) || fallback },
    PhotoUpload: { uploadAll, offerInstall() {} },
    location: { reloads: 0, reload() { sandbox.location.reloads += 1; } },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/toastLayer.js'), sandbox);
  vm.runInContext(`${read('admin.js')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, sandbox);
  const toasts = () => events.filter(e => e.type === 'basecoat:toast').map(e => e.detail.config);
  return { sandbox, document, el, events, toasts, windowListeners };
}

describe('A refused upload (the library full, say)', () => {
  const refusal = { ok: false, files: [], status: 413, data: { code: 'QUOTA_EXCEEDED', message: "You've reached 100 photos", files: [] } };

  function openUpload() {
    let answer;
    const calls = [];
    const page = loadAdmin({ uploadAll: (files, target) => { calls.push({ files, target }); return new Promise(resolve => { answer = resolve; }); } });
    const admin = Object.create(page.sandbox.PhotoFrameAdmin.prototype);
    Object.assign(admin, { selectedFiles: [{ name: 'beach.jpg', size: 1 }], currentPath: 'uploads/Family', loadFolderContents() {} });
    const dialog = page.el('uploadModal');
    dialog.open = true;
    page.document.dialogs.push(dialog);
    page.el('uploadError').classList.add('hidden');
    return { ...page, admin, calls, answer: value => answer(value), dialog };
  }

  test('is said once, in front of the dialog, and stays in the dialog', async () => {
    const page = openUpload();
    const upload = page.admin.uploadFiles();
    // While it's on its way the button can't send the photos again
    expect(page.el('confirmUploadBtn').disabled).toBe(true);
    page.admin.uploadFiles();
    page.admin.uploadFiles();
    expect(page.calls).toHaveLength(1);

    page.answer(refusal);
    await upload;
    await flush();

    const errors = page.toasts().filter(toast => toast.category === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].description).toBe('You&#39;ve reached 100 photos');
    // The toast holder went into the open dialog, in the top layer
    expect(page.el('toaster').parentNode).toBe(page.dialog);
    expect(page.el('toaster').popoverOpen).toBe(true);

    const inDialog = page.el('uploadError');
    expect(inDialog.classList.contains('hidden')).toBe(false);
    expect(inDialog.textContent).toBe(`admin.uploadNotAdded ${JSON.stringify({ message: "You've reached 100 photos" })}`);
    expect(inDialog.focused).toBe(1);
    // Free to try again (other photos, a bigger plan)
    expect(page.el('confirmUploadBtn').disabled).toBe(false);
  });

  test('when some photos were saved first, the dialog says how many', async () => {
    const page = openUpload();
    page.admin.selectedFiles = [{ name: 'a.jpg' }, { name: 'b.jpg' }];
    const upload = page.admin.uploadFiles();
    page.answer({ ...refusal, files: [{ name: 'a.jpg' }] });
    await upload;
    expect(page.el('uploadError').textContent).toBe(`admin.uploadPartial ${JSON.stringify({ done: 1, total: 2, message: "You've reached 100 photos" })}`);
  });

  test('closing the dialog clears it', async () => {
    const page = openUpload();
    const upload = page.admin.uploadFiles();
    page.answer(refusal);
    await upload;
    expect(page.el('uploadError').classList.contains('hidden')).toBe(false);
    page.admin.hideUploadModal();
    expect(page.el('uploadError').classList.contains('hidden')).toBe(true);
    expect(page.el('uploadError').textContent).toBe('');
  });

  test('the dialog has the place for it, read out when it appears', () => {
    const html = read('admin.html');
    const dialog = html.slice(html.indexOf('<dialog id="uploadModal"'), html.indexOf('</dialog>', html.indexOf('<dialog id="uploadModal"')));
    expect(dialog).toMatch(/<p id="uploadError" class="upload-error hidden" role="alert" tabindex="-1"><\/p>/);
  });

  test('toast text is never read as HTML (a folder name, the server\'s words)', () => {
    const page = loadAdmin();
    page.sandbox.showToast('<img src=x onerror=alert(1)> added to <b>Family</b>', 'success');
    expect(page.toasts()[0].description).toBe('&lt;img src=x onerror=alert(1)&gt; added to &lt;b&gt;Family&lt;/b&gt;');
  });
});

describe('The library page back from the back/forward cache', () => {
  function started() {
    const page = loadAdmin();
    // Without building the whole page
    vm.runInContext('PhotoFrameAdmin = class {};', page.sandbox);
    page.document.fire('DOMContentLoaded', {});
    return page;
  }

  test('restored from the cache (another library may be open now), it loads afresh', () => {
    const page = started();
    (page.windowListeners.pageshow || []).forEach(fn => fn({ persisted: true }));
    expect(page.sandbox.location.reloads).toBe(1);
  });

  test('an ordinary load is left alone', () => {
    const page = started();
    expect(page.windowListeners.pageshow).toHaveLength(1);
    page.windowListeners.pageshow.forEach(fn => fn({ persisted: false }));
    expect(page.sandbox.location.reloads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "Add a screen" on Access, and /pair

describe('Errors when adding a screen are seen on a phone', () => {
  test('"Add a screen": the error is at the top of the form, not under the buttons kept at the bottom', () => {
    const html = read('access-accounts.html');
    const form = html.slice(html.indexOf('<form id="screenPairForm"'), html.indexOf('</form>', html.indexOf('<form id="screenPairForm"')));
    const error = form.indexOf('id="screenPairError"');
    expect(error).toBeGreaterThan(-1);
    expect(error).toBeLessThan(form.indexOf('id="screenAccountList"'));
    expect(error).toBeLessThan(form.indexOf('class="add-screen-buttons"'));
  });

  test('"Add a screen": the plan\'s refusal is brought into view and focused', async () => {
    const { document, el } = fakeDocument();
    const sandbox = {
      document,
      window: {
        addEventListener() {},
        SoraPairFlow: {
          approve: async () => ({ state: 'failed', data: { code: 'SCREEN_LIMIT', message: 'Your plan allows 1 screen. Upgrade to add more.' } })
        }
      },
      console: { log() {}, error() {} },
      t: key => key,
      i18n: { error: data => data.message }
    };
    vm.createContext(sandbox);
    vm.runInContext(`${read('access-accounts.js')}\nthis.AddScreenDialog = AddScreenDialog;`, sandbox);
    const dialog = Object.create(sandbox.AddScreenDialog.prototype);
    Object.assign(dialog, { $: el, code: 'K7P4QX', choices: { body: name => ({ body: { name, accountId: 'acc_1' } }) } });
    el('screenName').value = 'Hall TV';
    el('screenPairError').classList.add('hidden');

    await dialog.approve();
    const error = el('screenPairError');
    expect(error.textContent).toBe('Your plan allows 1 screen. Upgrade to add more.');
    expect(error.classList.contains('hidden')).toBe(false);
    expect(error.scrolled).toBe(1);
    expect(error.focused).toBe(1);
  });

  test('"Add a screen": a missing name keeps the focus on the name field', async () => {
    const { document, el } = fakeDocument();
    const sandbox = { document, window: { addEventListener() {} }, console, t: key => key, i18n: {} };
    vm.createContext(sandbox);
    vm.runInContext(`${read('access-accounts.js')}\nthis.AddScreenDialog = AddScreenDialog;`, sandbox);
    const dialog = Object.create(sandbox.AddScreenDialog.prototype);
    Object.assign(dialog, { $: el });
    await dialog.approve();
    expect(el('screenPairError').textContent).toBe('accessAccounts.screenNameRequired');
    expect(el('screenPairError').scrolled).toBe(1);
    expect(el('screenPairError').focused).toBe(0);
    expect(el('screenName').focused).toBe(1);
  });

  test('/pair: the error is at the top of the form too', () => {
    const html = read('pair.html');
    const form = html.slice(html.indexOf('<form class="pair-state hidden" id="pairForm"'), html.indexOf('</form>', html.indexOf('id="pairForm"')));
    const error = form.indexOf('id="pairError"');
    expect(error).toBeGreaterThan(-1);
    expect(error).toBeLessThan(form.indexOf('id="accountList"'));
    expect(error).toBeLessThan(form.indexOf('id="pairButton"'));
  });
});
