const assert = require("assert/strict");
const {
  makeUniqueFileName,
  slugifyFileName,
} = require("../out/file-names.js");

assert.equal(slugifyFileName("Привет мир"), "привет-мир");
assert.equal(slugifyFileName("Zażółć gęślą jaźń"), "zażółć-gęślą-jaźń");
assert.equal(slugifyFileName("任务 №1"), "任务-1");
assert.equal(slugifyFileName("bad:/\\name?"), "bad-name");
assert.equal(slugifyFileName("   "), "");

assert.equal(makeUniqueFileName("task.md", []), "task.md");
assert.equal(makeUniqueFileName("task.md", ["task.md"]), "task-2.md");
assert.equal(
  makeUniqueFileName("task.md", ["task.md", "task-2.md"]),
  "task-3.md"
);
assert.equal(makeUniqueFileName("task-2.md", ["task-2.md"]), "task-3.md");
assert.equal(makeUniqueFileName("task-09.md", ["task-09.md"]), "task-10.md");
assert.equal(makeUniqueFileName("Привет.md", ["привет.md"]), "Привет-2.md");
