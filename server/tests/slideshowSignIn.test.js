const fs = require('fs');
const path = require('path');

// The slideshow's sign-in code, run without a browser: the page's elements are stand-ins
const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
const AuthenticationManager = new Function('i18n',
  `${source.slice(source.indexOf('class AuthenticationManager'), source.indexOf('class PhotoFrameSlideshow'))}; return AuthenticationManager;`
)({ error: () => 'Too many failed attempts' });

const element = () => ({ disabled: false, value: '', classList: { add() {}, remove() {} } });
const signInPage = (answers) => {
  const page = Object.create(AuthenticationManager.prototype);
  let calls = 0;
  return Object.assign(page, {
    pinInput: element(),
    authButton: element(),
    familyCodeRequired: false,
    showError() {}, showErrorKey() {}, clearError() {}, showAuthOverlay() {}, focusPin() {}, renderPinCells() {}, keepScreen() {},
    handleAuthSuccess: jest.fn(),
    requestPin: async () => answers[Math.min(calls++, answers.length - 1)],
    calls: () => calls
  });
};

describe('signing in from the address (a bookmarked PIN)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('after "too many tries", waits and tries again instead of staying stuck', async () => {
    const page = signInPage([
      { success: false, code: 'RATE_LIMITED', error: 'Too many', remainingTime: 1 },
      { success: true, account: { name: 'Living room' } }
    ]);
    await page.signInFromUrl('482913');
    expect(page.pinInput.disabled).toBe(true);
    expect(page.authButton.disabled).toBe(true);

    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(page.pinInput.disabled).toBe(false);
    expect(page.authButton.disabled).toBe(false);
    expect(page.calls()).toBe(2);
    expect(page.handleAuthSuccess).toHaveBeenCalledWith({ name: 'Living room' });
  });

  test('a PIN typed in gets the form back after the wait', async () => {
    const page = signInPage([]);
    page.handleAuthError('Too many', 'RATE_LIMITED', { remainingTime: 2 });
    expect(page.pinInput.disabled).toBe(true);
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(page.pinInput.disabled).toBe(false);
    expect(page.authButton.disabled).toBe(false);
  });
});
