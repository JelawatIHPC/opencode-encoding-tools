// Per-test scratch directory under the OS temp dir, so the suite runs from any
// checkout and never touches a fixed developer path.
const os = require("os");
const path = require("path");

module.exports = function tmp(name) {
  return path.join(os.tmpdir(), "enctools-tests", name);
};
