const assert = require("assert/strict");

const {
  buildFolderCardPriorityOverrides,
  buildFolderConfigMap,
  isIgnoredFolder,
  orderColumnsByConfig,
  parseBoardConfig,
  serializeBoardConfig,
} = require("../out/board-config.js");

const sourceText = `folders:
  Doing:
    title: In progress
  Backlog: Backlog
  Done: Done
`;

const boardConfig = parseBoardConfig(sourceText);
assert.equal(boardConfig.valid, true, "valid .kanban YAML should be marked valid");
const ignoredConfig = parseBoardConfig(`ignoreFolders:
  - Archive
ignoreDirs:
  - scratch
excludeFolders: trash
`);
assert.equal(
  isIgnoredFolder(ignoredConfig, "archive"),
  true,
  "ignoreFolders should mark matching directory names as ignored"
);
assert.equal(
  isIgnoredFolder(ignoredConfig, "Scratch"),
  true,
  "ignoreDirs alias should mark matching directory names as ignored"
);
assert.equal(
  isIgnoredFolder(ignoredConfig, "trash"),
  true,
  "excludeFolders string values should mark matching directory names as ignored"
);
assert.equal(
  isIgnoredFolder(ignoredConfig, "doing"),
  false,
  "unlisted directory names should not be ignored"
);
const columns = [
  { id: "Backlog", name: "Backlog", order: 2 },
  { id: "Archive", name: "Archive", order: null },
  { id: "Done", name: "Done", order: 3 },
  { id: "Doing", name: "In progress", order: 1 },
];

const orderedColumns = orderColumnsByConfig(columns, boardConfig);

assert.deepEqual(
  orderedColumns.map((column) => column.id),
  ["Doing", "Backlog", "Done", "Archive"],
  "configured folders should keep .kanban order and append extras after them"
);

const nextData = {
  ...boardConfig.data,
  folders: buildFolderConfigMap(
    orderedColumns,
    boardConfig,
    new Map([["Doing", ["ship-it.md"]]])
  ),
};
const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
const nextConfig = parseBoardConfig(serialized);

assert.equal(
  serializeBoardConfig({}, ""),
  "",
  "empty .kanban YAML should remain empty instead of being serialized as {}"
);

assert.deepEqual(
  orderColumnsByConfig(
    [
      { id: "done", name: "done", order: null },
      { id: "backlog", name: "backlog", order: null },
      { id: "confirmed", name: "confirmed", order: null },
      { id: "new", name: "new", order: null },
      { id: "doing", name: "doing", order: null },
      { id: "blocked", name: "blocked", order: null },
    ],
    parseBoardConfig("")
  ).map((column) => column.id),
  ["new", "backlog", "doing", "blocked", "done", "confirmed"],
  "empty .kanban boards should use workflow order for runner-style columns"
);

assert.deepEqual(
  nextConfig.folders.map((folder) => folder.id),
  ["Doing", "Backlog", "Done", "Archive"],
  "serializing updated card priorities should preserve configured folder order"
);
assert.deepEqual(
  Array.from(nextConfig.folderMap.get("Doing")?.cardPriorities.keys() ?? []),
  ["ship-it.md"],
  "priority overrides should still be applied to the updated folder config"
);

const moveSourceText = `folders:
  Doing:
    priorities:
      - moved-task.md
      - existing-doing.md
  Done:
    priorities:
      - done-task.md
`;

const moveBoardConfig = parseBoardConfig(moveSourceText);
const movePriorityOverrides = buildFolderCardPriorityOverrides(
  [
    {
      id: "Doing",
      cards: [{ fileName: "existing-doing.md" }],
    },
    {
      id: "Done",
      cards: [
        { fileName: "done-task.md" },
        { fileName: "moved-task.md" },
      ],
    },
  ],
  moveBoardConfig
);

assert.deepEqual(
  movePriorityOverrides.get("Doing"),
  ["existing-doing.md"],
  "priority overrides should remove files that physically left a column"
);
assert.deepEqual(
  movePriorityOverrides.get("Done"),
  ["moved-task.md", "done-task.md"],
  "files moved into another column should be prepended ahead of the destination column's existing order"
);

assert.equal(
  parseBoardConfig("folders: [").valid,
  false,
  "invalid .kanban YAML should be detectable so refreshes do not persist fallback ordering"
);
