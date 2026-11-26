/* Toasts in front of everything, open dialogs included.
 *
 * A modal dialog and its backdrop sit in the browser's top layer, which no
 * z-index can reach, so a toast behind it can't be read (an upload refused
 * while the upload dialog is open, say). The toast holder is a
 * popover="manual" element instead:
 *   - while a modal dialog is open, it moves into the topmost one, so it isn't
 *     cut off from the page the dialog makes inert, and back to <body> once the
 *     dialog closes;
 *   - each toast shows it again as a popover, which puts it on top of the top
 *     layer, above the dialog's backdrop and the phone's tab bar.
 * Browsers without popovers still get it inside the open dialog.
 *
 *   SoraToastLayer.raise(holder)   before adding a toast to holder
 *   SoraToastLayer.follow(holder)  once: keeps it in sight as dialogs close
 */
(function (global) {
    function isModal(dialog) {
        try {
            return dialog.matches(':modal');
        } catch (_) {
            return true; // no :modal: an open dialog is the best guess
        }
    }

    function topDialog(doc) {
        const open = Array.from(doc.querySelectorAll('dialog[open]')).filter(isModal);
        return open[open.length - 1] || null;
    }

    function raise(holder, doc = global.document) {
        if (!holder) return;
        const home = topDialog(doc) || doc.body;
        if (holder.parentNode !== home) home.appendChild(holder);
        if (typeof holder.showPopover !== 'function') return;
        try {
            // Shown again, it is the newest in the top layer, so on top
            if (holder.matches(':popover-open')) holder.hidePopover();
            holder.showPopover();
        } catch (_) { /* not connected, or no popover support after all */ }
    }

    function follow(holder, doc = global.document) {
        if (!holder) return;
        // A closing dialog would take its toasts with it: back to the page, or the dialog under it
        doc.addEventListener('close', (event) => {
            if (event.target && typeof event.target.contains === 'function' && event.target.contains(holder)) raise(holder, doc);
        }, true);
    }

    const api = { raise, follow, topDialog };
    global.SoraToastLayer = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
