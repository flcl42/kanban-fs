const assert = require("assert/strict");
const { findTaskLinkActions } = require("../out/task-links.js");

const task = `# Example task

Agent: 123e4567-e89b-12d3-a456-426614174000
Project: C:\\work\\demo
Relative: docs\\readme.md

Body starts here.
`;

const actions = findTaskLinkActions(task);

assert.equal(actions.length, 2, "expected two task link actions");
assert.deepEqual(
  actions.map((action) => ({
    line: action.line,
    title: action.title,
    command: action.command,
    value: action.value,
  })),
  [
    {
      line: 2,
      title: "Connect",
      command: "resumeAgent",
      value: "123e4567-e89b-12d3-a456-426614174000",
    },
    {
      line: 3,
      title: "Open",
      command: "openPath",
      value: "C:\\work\\demo",
    },
  ]
);

const noActions = findTaskLinkActions(`# Title

Intro: this is body text without a separating blank line
still body text
`);

assert.equal(noActions.length, 0, "body text should not be treated as task metadata");
