const s = () => globalThis.__fakeScreen;
const screen = {
  on: (ch, fn) => s().on(ch, fn),
  removeListener: () => {},
  getAllDisplays: () => s().displays(),
  getCursorScreenPoint: () => s().cursor(),
};
module.exports = { screen, default: { screen } };
