const assert = require("assert/strict");
const { buildFolderConfigMap, parseBoardConfig } = require("../out/board-config.js");
const { parseTaskMarkdown } = require("../out/task-metadata.js");
const { findTaskLinkActions, getTaskPropertyAction } = require("../out/task-links.js");

const task = `# Example task

Agent: 019d00bc-adea-7442-8438-25433de1aa9b
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
      value: "019d00bc-adea-7442-8438-25433de1aa9b",
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
assert.deepEqual(getTaskPropertyAction("Repo", "C:\\work\\demo"), {
  command: "openPath",
  title: "Open",
  value: "C:\\work\\demo",
});
assert.deepEqual(getTaskPropertyAction("Project", "D:\\"), {
  command: "openPath",
  title: "Open",
  value: "D:\\",
});
assert.equal(
  getTaskPropertyAction("Project Path", "C:\\work\\demo"),
  null,
  "only Repo/Path/Project properties should create open-path actions"
);

const parsed = parseTaskMarkdown(
  `# Example task

This summary paragraph line stays: in the body because it has too many words.
Owner: Jane Doe
Project Path: C:\\work\\demo

## Notes

Body starts here.
`,
  "fallback.md"
);

assert.equal(parsed.title, "Example task");
assert.deepEqual(parsed.properties, [
  { key: "Owner", label: "Owner", value: "Jane Doe" },
  { key: "Project Path", label: "Project Path", value: "C:\\work\\demo" },
]);
assert.match(parsed.body, /This summary paragraph line stays:/);
assert.match(parsed.body, /## Notes/);
assert.doesNotMatch(parsed.body, /^Owner:/m);

const sectionActions = findTaskLinkActions(`# Example task

Agent: 019d0095-6102-7fe2-9fc8-5db0155692e9
Repo: C:\\work\\demo
This body line has five words: so it stays body text

## Links

Agent: 019d0095-6102-7fe2-9fc8-5db0155692ea
`);

assert.deepEqual(
  sectionActions.map((action) => ({
    line: action.line,
    command: action.command,
    value: action.value,
  })),
  [
    {
      line: 2,
      command: "resumeAgent",
      value: "019d0095-6102-7fe2-9fc8-5db0155692e9",
    },
    {
      line: 3,
      command: "openPath",
      value: "C:\\work\\demo",
    },
  ]
);

const boardConfig = parseBoardConfig(`folders:
  Backlog:
    title: Backlog
    priorities:
      old.md: 2
      keep.md: 1
  Doing: In Progress
`);

assert.equal(
  boardConfig.folderMap.get("Backlog")?.cardPriorities.get("keep.md"),
  1
);
assert.equal(
  boardConfig.folderMap.get("Backlog")?.cardPriorities.get("old.md"),
  2
);

const updatedFolders = buildFolderConfigMap(
  [
    { id: "Backlog", name: "Backlog" },
    { id: "Doing", name: "In Progress" },
  ],
  boardConfig,
  new Map([
    [
      "Backlog",
      ["moved.md", "keep.md"],
    ],
    ["Doing", []],
  ])
);

assert.deepEqual(updatedFolders, {
  Backlog: {
    priorities: ["moved.md", "keep.md"],
  },
  Doing: "In Progress",
});
