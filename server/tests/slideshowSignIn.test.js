const fs = require('fs');
const path = require('path');

// The slideshow's sign-in code, run without a browser: the page and its elements are stand-ins
const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
const browser = {
  i18n: { error: () => 'Too many failed attempts' },
  document: { dispatchEvent() {} },
  CustomEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
  sessionStorage: { setItem() {}, removeItem() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  window: {},
  fetch: async () => ({ json: async () => ({}) }),
  DEVICE_TOKEN_KEY: 'photoframe_device_token',
  FAMILY_CODE_KEY: 'photoframe_family_code'
};
const AuthenticationManager = new Function(...Object.keys(browser),
  `${source.slice(source.indexOf('class AuthenticationManager'), source.indexOf('class PhotoFrameSlideshow'))}; return AuthenticationManager;`
)(...Object.values(browser));

const element = () => ({ disabled: false, value: '', classList: { add() {}, remove() {} } });
const signInPage = (answers) => {
  const page = Object.create(AuthenticationManager.prototype);
  let calls = 0;
  return Object.assign(page, {
    pinInput: element(),
    authButton: element(),
    authLoading: element(),
    familyCodeRequired: false,
    showError() {}, showErrorKey() {}, clearError() {}, clearErrorState() {}, showAuthOverlay() {}, hideAuthOverlay() {},
    focusPin() {}, renderPinCells() {}, keepScreen() {},
    requestPin: async () => answers[Math.min(calls++, answers.length - 1)],
    calls: () => calls
  });
};
const tooMany = { success: false, code: 'RATE_LIMITED', error: 'Too many', remainingTime: 1 };
const welcome = name => ({ success: true, account: { name } });

describe('after "too many tries" on the PIN screen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a bookmarked PIN waits and tries again instead of staying stuck', async () => {
    const page = signInPage([tooMany, welcome('Living room')]);
    await page.signInFromUrl('482913');
    expect(page.pinInput.disabled).toBe(true);
    expect(page.authButton.disabled).toBe(true);

    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(page.pinInput.disabled).toBe(false);
    expect(page.authButton.disabled).toBe(false);
    expect(page.calls()).toBe(2);
    expect(page.userAccount).toEqual({ name: 'Living room' });
  });

  test('a typed PIN keeps the form off for the wait, then gets it back', async () => {
    const page = signInPage([tooMany]);
    page.pinInput.value = '482913';
    await page.authenticate();
    expect(page.pinInput.disabled).toBe(true);
    expect(page.authButton.disabled).toBe(true);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(page.pinInput.disabled).toBe(false);
    expect(page.authButton.disabled).toBe(false);
  });

  test('the bookmarked PIN is not tried again once the frame is paired by QR code meanwhile', async () => {
    const page = signInPage([tooMany, welcome('Bookmark')]);
    await page.signInFromUrl('482913');
    page.handleAuthSuccess({ name: 'Paired by QR' });
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(page.calls()).toBe(1);
    expect(page.userAccount).toEqual({ name: 'Paired by QR' });
  });

  test('the bookmarked PIN is not tried again after signing out', async () => {
    const page = signInPage([tooMany, welcome('Bookmark')]);
    page.clearForm = () => {};
    await page.signInFromUrl('482913');
    await page.logout();
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(page.calls()).toBe(1);
    expect(page.isAuthenticated).toBe(false);
  });
});
