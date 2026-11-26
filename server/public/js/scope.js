/* What the signed-in person may do here. A hosted library shared with someone can
   limit them to viewing, or keep Access for its owner (see the server's
   middleware/scope.js, which refuses the rest anyway). Self-hosted, the scope is
   null and nothing changes.
   Sets <html class="view-only"> and <html class="not-owner">: elements marked
   data-edit-only or data-owner-only are then hidden (css/sora.css). */
(function (global) {
  const root = document.documentElement;
  const api = {
    scope: null,
    canEdit() { return !this.scope || this.scope.canEdit !== false; },
    isOwner() { return !this.scope || this.scope.isOwner !== false; },
    apply(scope) {
      this.scope = scope && typeof scope === 'object' ? scope : null;
      root.classList.toggle('view-only', !this.canEdit());
      root.classList.toggle('not-owner', !this.isOwner());
      global.dispatchEvent(new CustomEvent('sora:scope', { detail: { scope: this.scope } }));
      return this.scope;
    }
  };
  // The feature flags, with the scope in them; null when they couldn't be read
  // (signed out, or a frame: then nothing is hidden)
  api.ready = fetch('/api/features', { credentials: 'same-origin' })
    .then(response => (response.ok ? response.json() : null))
    .catch(() => null)
    .then(features => {
      api.apply(features && features.scope);
      return features;
    });
  global.SoraScope = api;
})(window);
