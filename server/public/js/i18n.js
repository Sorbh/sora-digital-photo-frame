/* Small, dependency-free translations for every browser page. */
(function (global) {
  const supported = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'nl', 'hi', 'ja', 'zh-CN', 'ar'];
  const names = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', 'pt-BR': 'Português (Brasil)', it: 'Italiano', nl: 'Nederlands', hi: 'हिन्दी', ja: '日本語', 'zh-CN': '简体中文', ar: 'العربية' };
  const cache = new Map();
  const get = (object, key) => key.split('.').reduce((value, part) => value && value[part], object);
  const match = (value) => {
    if (!value) return null;
    const lower = value.toLowerCase();
    return supported.find(code => code.toLowerCase() === lower) || supported.find(code => lower.split('-')[0] === code.toLowerCase().split('-')[0]) || null;
  };
  async function load(code) {
    code = match(code) || 'en';
    if (!cache.has(code)) cache.set(code, fetch(`/locales/${code}.json`).then(r => r.ok ? r.json() : {}).catch(() => ({})));
    return cache.get(code);
  }
  function configuredLanguage() {
    return document.documentElement.dataset.screenLanguage || null;
  }
  function choose() {
    const query = match(new URLSearchParams(location.search).get('lang'));
    const saved = match(localStorage.getItem('sora.lang'));
    const screen = match(configuredLanguage());
    const browser = (navigator.languages || [navigator.language]).map(match).find(Boolean);
    return query || saved || screen || browser || 'en';
  }
  const api = {
    supported, names, locale: 'en', messages: {}, fallback: {},
    t(key, vars = {}) {
      let value = get(this.messages, key) || get(this.fallback, key) || key;
      if (Object.prototype.hasOwnProperty.call(vars, 'count')) {
        const suffix = new Intl.PluralRules(this.locale).select(Number(vars.count));
        // Languages with more plural forms (ar: zero/two/few/many) fall back to their own _other
        value = get(this.messages, `${key}_${suffix}`) || get(this.messages, `${key}_other`)
          || get(this.fallback, `${key}_${suffix}`) || get(this.fallback, `${key}_other`) || value;
      }
      return String(value).replace(/\{(\w+)\}/g, (_, name) => vars[name] == null ? `{${name}}` : vars[name]);
    },
    error(payload, fallback = 'errors.unknown') {
      const code = typeof payload === 'object' && payload ? payload.code : null;
      const message = typeof payload === 'object' && payload ? (payload.message || payload.error) : payload;
      const translated = code && this.t(`errors.${code}`);
      return translated && translated !== `errors.${code}` ? translated : (message || this.t(fallback));
    },
    apply(root = document) {
      root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = this.t(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = this.t(el.dataset.i18nHtml); });
      root.querySelectorAll('[data-i18n-attr]').forEach(el => el.dataset.i18nAttr.split(';').forEach(part => {
        const [attribute, key] = part.split(':').map(s => s.trim());
        if (attribute && key) el.setAttribute(attribute, this.t(key));
      }));
      document.title = document.querySelector('title[data-i18n]') ? this.t(document.querySelector('title[data-i18n]').dataset.i18n) : document.title;
    },
    async setLanguage(code, persist = true) {
      this.locale = match(code) || 'en';
      if (persist) localStorage.setItem('sora.lang', this.locale);
      [this.messages, this.fallback] = await Promise.all([load(this.locale), load('en')]);
      document.documentElement.lang = this.locale;
      document.documentElement.dir = this.locale === 'ar' ? 'rtl' : 'ltr';
      this.apply();
      document.documentElement.classList.remove('i18n-pending');
      global.dispatchEvent(new CustomEvent('sora:languagechange', { detail: { locale: this.locale } }));
      return this.locale;
    },
    init() { return this.setLanguage(choose(), false); }
  };
  global.i18n = api;
  global.t = api.t.bind(api);
  document.documentElement.classList.add('i18n-pending');
  setTimeout(() => document.documentElement.classList.remove('i18n-pending'), 1500);
  document.addEventListener('DOMContentLoaded', () => api.init());
})(window);
