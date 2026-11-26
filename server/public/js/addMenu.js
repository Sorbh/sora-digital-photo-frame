/**
 * The library's Upload button (and the phone tab bar's round + button): a small
 * menu with "From this device" and "From Google Photos".
 *
 * Google Photos follows the rules it always had: only the library's owner can
 * connect it, only someone who can edit can import, and only when the server
 * has it turned on (/api/features googlePhotosEnabled). When it isn't offered,
 * the button goes straight to the upload dialog, with no menu of one.
 *
 *   SoraAddMenu.choices({ features, canEdit, isOwner }) -> ['device', 'googlePhotos']
 *
 * On a phone it is a sheet with big rows, centred above the tab bar's + button
 * (sheetSpot), and Back closes it like tapping outside or Escape.
 *
 *   SoraAddMenu.sheetSpot({ anchor, bar, width, height, viewport }) -> { left, top }
 */
(function (root) {
  function choices({ features = null, canEdit = true, isOwner = true } = {}) {
    if (canEdit === false) return [];
    const list = ['device'];
    if (isOwner !== false && features && features.googlePhotosEnabled === true) list.push('googlePhotos');
    return list;
  }

  // Centred on the + button, just above the tab bar (bar: its rect, or null), on screen
  const SHEET_MARGIN = 12;
  function sheetSpot({ anchor, bar = null, width, height, viewport }) {
    const centre = (anchor.left + anchor.right) / 2;
    const left = Math.max(SHEET_MARGIN, Math.min(centre - width / 2, viewport.width - SHEET_MARGIN - width));
    const above = (bar ? Math.min(bar.top, anchor.top) : anchor.top) - SHEET_MARGIN;
    return { left: Math.round(left), top: Math.round(Math.max(SHEET_MARGIN, above - height)) };
  }

  const api = { choices, sheetSpot };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  root.SoraAddMenu = api;

  const doc = root.document;
  let offered = ['device']; // until /api/features answers: Upload opens the dialog
  let opener = null;
  let inHistory = false; // the phone sheet put a step in history, so Back closes it
  const phone = () => Boolean(root.matchMedia && root.matchMedia('(max-width: 640px)').matches);

  const menu = () => doc.getElementById('addMenu');
  const items = () => [...menu().querySelectorAll('.menu-item')].filter(item => !item.hidden);
  const isOpen = () => Boolean(menu()?.matches(':popover-open'));

  function setOffered(list) {
    offered = list;
    const google = doc.getElementById('googlePhotosBtn');
    if (google) google.hidden = !list.includes('googlePhotos');
  }

  function close({ returnFocus = true } = {}) {
    const popover = menu();
    if (!popover) return;
    const hadFocus = popover.contains(doc.activeElement);
    if (isOpen()) popover.hidePopover();
    popover.classList.remove('is-sheet');
    if (inHistory) {
      inHistory = false;
      root.history.back();
    }
    if (opener) {
      opener.setAttribute('aria-expanded', 'false');
      if (returnFocus && hadFocus && opener.isConnected) opener.focus({ preventScroll: true });
    }
    opener = null;
  }

  function open(button) {
    const popover = menu();
    opener = button;
    button.setAttribute('aria-expanded', 'true');
    popover.style.position = 'fixed';
    popover.style.margin = '0';
    popover.style.maxHeight = '';
    popover.style.overflowY = '';
    const sheet = phone();
    popover.classList.toggle('is-sheet', sheet);
    if (!isOpen()) popover.showPopover();
    if (sheet) {
      const bar = doc.querySelector('.tabbar');
      const spot = sheetSpot({
        anchor: button.getBoundingClientRect(),
        bar: bar ? bar.getBoundingClientRect() : null,
        width: popover.offsetWidth,
        height: popover.offsetHeight,
        viewport: { width: root.innerWidth, height: root.innerHeight }
      });
      popover.style.left = `${spot.left}px`;
      popover.style.top = `${spot.top}px`;
      if (!inHistory) {
        root.history.pushState({ ...(root.history.state || {}), addMenu: true }, '');
        inHistory = true;
      }
      items()[0]?.focus({ preventScroll: true });
      return;
    }
    const spot = root.SoraPlaceMenu.place({
      anchor: button.getBoundingClientRect(),
      width: popover.offsetWidth,
      height: popover.offsetHeight,
      viewport: { width: root.innerWidth, height: root.innerHeight }
    });
    popover.style.left = `${spot.left}px`;
    popover.style.top = `${spot.top}px`;
    if (spot.maxHeight !== null) {
      popover.style.maxHeight = `${spot.maxHeight}px`;
      popover.style.overflowY = 'auto';
    }
    items()[0]?.focus({ preventScroll: true });
  }

  function fromDevice() {
    root.photoFrameAdmin?.showUploadModal();
  }

  function trigger(event) {
    const button = event.currentTarget;
    if (isOpen() && opener === button) return close();
    if (offered.length < 2) return fromDevice();
    close({ returnFocus: false });
    open(button);
  }

  function bind() {
    const popover = menu();
    if (!popover) return;
    doc.querySelectorAll('[data-add-menu]').forEach(button => {
      button.setAttribute('aria-controls', 'addMenu');
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', trigger);
    });
    // "From Google Photos" is handled by js/googlePhotosSync.js, which listens to the same item
    doc.getElementById('addFromDeviceBtn').addEventListener('click', () => { close({ returnFocus: false }); fromDevice(); });
    doc.getElementById('googlePhotosBtn')?.addEventListener('click', () => close({ returnFocus: false }));
    popover.addEventListener('keydown', event => {
      const list = items();
      const at = list.indexOf(doc.activeElement);
      const to = { ArrowDown: (at + 1) % list.length, ArrowUp: (at <= 0 ? list.length : at) - 1, Home: 0, End: list.length - 1 }[event.key];
      if (to !== undefined) {
        event.preventDefault();
        list[to].focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        close({ returnFocus: false });
      }
    });
    // A click anywhere else closes it. On a phone that tap only closes the sheet: it
    // doesn't also press what was under it (caught before the page sees it)
    doc.addEventListener('click', event => {
      if (!isOpen()) return;
      if (popover.contains(event.target) || (opener && opener.contains(event.target))) return;
      if (popover.classList.contains('is-sheet')) {
        event.preventDefault();
        event.stopPropagation();
      }
      close({ returnFocus: false });
    }, true);
    root.addEventListener('resize', () => close({ returnFocus: false }));
    // Back on a phone: the step the sheet added is gone already, so only close
    root.addEventListener('popstate', () => {
      if (!inHistory) return;
      inHistory = false;
      close();
    });

    const scope = root.SoraScope;
    if (scope && scope.ready) {
      scope.ready.then(features => setOffered(choices({ features, canEdit: scope.canEdit(), isOwner: scope.isOwner() })));
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
  else bind();
})(typeof window !== 'undefined' ? window : globalThis);
