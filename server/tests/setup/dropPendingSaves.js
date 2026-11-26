// The photo info cache saves 2 s after a change. A save still waiting when a
// test file ends would land after its afterAll removed the throwaway folders,
// bringing them back with stale data for the next run (#72). Drop it.
afterAll(() => {
  require('../../services/photoInfoService').discard();
});
