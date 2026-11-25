const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Runs the slideshow's sign-in class in a bare sandbox opened at the given address
function openSlideshow(href) {
  const element = () => new Proxy({}, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'classList') return { add() {}, remove() {}, contains: () => true };
      if (prop === 'dataset' || prop === 'style') return {};
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
      return () => {};
    },
    set: (target, prop, value) => { target[prop] = value; return true; }
  });
  const requests = [];
  const sandbox = {
    URL,
    URLSearchParams,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { href, search: new URL(href).search },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
      documentElement: { dataset: {} }
    },
    fetch: (url, options) => {
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      return new Promise(() => {}); // never answers: only the request is checked
    },
    t: key => key
  };
  sandbox.window = sandbox;
  sandbox.history = {
    state: null,
    replaceState(state, title, url) {
      const next = new URL(url, sandbox.location.href);
      sandbox.location.href = next.href;
      sandbox.location.search = next.search;
    }
  };
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
  const auth = source.slice(0, source.indexOf('class PhotoFrameSlideshow'));
  vm.runInContext(`${auth}\nthis.manager = new AuthenticationManager();`, context);
  return { location: sandbox.location, requests, manager: sandbox.manager };
}

describe('Slideshow sign-in from the address', () => {
  test('signs in with the PIN and family code, then takes them out of the address', () => {
    const { location, requests } = openSlideshow('https://frame.example/slideshow?pin=123456&family=ABCD-EFGH&lang=de#x');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/auth/pin');
    expect(requests[0].body).toMatchObject({ pin: '123456', familyCode: 'ABCD-EFGH' });
    expect(location.href).toBe('https://frame.example/slideshow?lang=de#x');
  });

  test('keeps the family code for a later typed PIN', () => {
    const { manager } = openSlideshow('https://frame.example/slideshow?family=ABCD-EFGH');
    expect(manager.familyCodeValue()).toBe('ABCD-EFGH');
  });

  test('leaves an address without sign-in details as it is', () => {
    const { location } = openSlideshow('https://frame.example/slideshow?lang=de');
    expect(location.href).toBe('https://frame.example/slideshow?lang=de');
  });
});
