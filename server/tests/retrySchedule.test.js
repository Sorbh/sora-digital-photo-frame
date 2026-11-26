const RetrySchedule = require('../public/js/retrySchedule');

describe('A frame that could not show a photo tries again', () => {
  test('soon at first, then waiting twice as long each time, up to five minutes', () => {
    const retry = new RetrySchedule();
    const waits = Array.from({ length: 9 }, () => retry.next() / 1000);
    expect(waits).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300]);
  });

  test('starts from the shortest wait again once a photo shows', () => {
    const retry = new RetrySchedule({ first: 1000, max: 8000 });
    retry.next();
    retry.next();
    retry.next();
    retry.reset();
    expect(retry.next()).toBe(1000);
  });

  test('never waits longer than five minutes, however long the network stays down', () => {
    const retry = new RetrySchedule();
    for (let i = 0; i < 10000; i++) retry.next();
    expect(retry.next()).toBe(5 * 60 * 1000);
    expect(retry.tries).toBeLessThan(10);
  });
});
