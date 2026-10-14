const assert = require("assert/strict");
const {
  getMatchingTagCompletions,
  getTagValueCompletionContext,
} = require("../out/tag-completions.js");
const { parseTaskMarkdown } = require("../out/task-metadata.js");

const tags = parseTaskMarkdown(
  "# Ticket\nTags: runner, UX\nTag: manual\n\n## Description\nTag: not-metadata\n",
  "ticket.md"
).tags;
assert.deepEqual(tags, ["runner", "UX", "manual"]);

const first = getTagValueCompletionContext("Tags: ru", 8);
assert.deepEqual(first, {
  valueStart: 6,
  valueEnd: 8,
  prefix: "ru",
  existingTags: [],
});
assert.deepEqual(getMatchingTagCompletions(["runner", "UX"], first), ["runner"]);

const middleLine = "Tag: runner, ux, manual";
const middle = getTagValueCompletionContext(middleLine, middleLine.indexOf("ux") + 2);
assert.deepEqual(middle, {
  valueStart: 13,
  valueEnd: 15,
  prefix: "ux",
  existingTags: ["runner", "manual"],
});
assert.deepEqual(
  getMatchingTagCompletions(["Runner", "UX", "ux", "manual", "ui"], middle),
  ["UX"],
  "the active tag should be suggested without duplicating tags elsewhere on the line"
);

const afterComma = getTagValueCompletionContext("Tags: runner, ", 14);
assert.deepEqual(afterComma, {
  valueStart: 14,
  valueEnd: 14,
  prefix: "",
  existingTags: ["runner"],
});
assert.deepEqual(
  getMatchingTagCompletions(["runner", "UX", "ux", "manual"], afterComma),
  ["manual", "UX"]
);
assert.equal(getTagValueCompletionContext("Model: codex", 12), null);
assert.equal(getTagValueCompletionContext("Tags: runner", 3), null);
