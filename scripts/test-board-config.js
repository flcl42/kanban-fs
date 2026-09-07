const assert = require("assert/strict");

const {
  buildFolderCardPriorityOverrides,
  buildFolderConfigMap,
  isIgnoredFolder,
  isTopCard,
  moveTopCardInSet,
  orderColumnsByConfig,
  parseBoardConfig,
  reconcileTopCardsWithColumns,
  serializeBoardConfig,
  setTopCardInSet,
  setTopCardsInConfigData,
} = require("../out/board-config.js");

const sourceText = `folders:
  Doing:
    title: In progress
  Backlog: Backlog
  Done: Done
`;

const boardConfig = parseBoardConfig(sourceText);
assert.equal(boardConfig.valid, true, "valid .kanban YAML should be marked valid");
const defaultModelsConfig = parseBoardConfig(`defaultModels:
  codex: codex/gpt-5.6-sol/ultra
  claude: sonnet/max
  kimi: kimi/k2
  deepseek: deepseek-v4-pro/max
`);
assert.deepEqual(
  defaultModelsConfig.defaultModels,
  {
    codex: "codex/gpt-5.6-sol/ultra",
    claude: "sonnet/max",
    kimi: "kimi/k2",
    deepseek: "deepseek-v4-pro/max",
  },
  "defaultModels should parse per-agent board model defaults"
);
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

const topConfig = parseBoardConfig(`top:
  - Doing/task.md
  - Backlog\\existing.md
  - shared.md
`);
assert.equal(
  isTopCard(topConfig, "Doing", "task.md"),
  true,
  "top entries should mark matching column card paths"
);
assert.equal(
  isTopCard(topConfig, "Backlog", "existing.md"),
  true,
  "top entries should accept Windows-style separators"
);
assert.equal(
  isTopCard(topConfig, "Done", "shared.md"),
  true,
  "legacy file-only top entries should match by file name"
);
let nextTopCards = setTopCardInSet(topConfig.topCards, "Doing", "task.md", false);
nextTopCards = setTopCardInSet(nextTopCards, "Done", "review.md", true);
nextTopCards = moveTopCardInSet(nextTopCards, "Backlog", "existing.md", "Done", "existing.md");
const topData = { ...topConfig.data };
setTopCardsInConfigData(topData, nextTopCards);
const serializedTopConfig = parseBoardConfig(
  serializeBoardConfig(topData, topConfig.sourceText)
);
assert.equal(
  isTopCard(serializedTopConfig, "Doing", "task.md"),
  false,
  "clearing a top card should remove its .kanban entry"
);
assert.equal(
  isTopCard(serializedTopConfig, "Done", "review.md"),
  true,
  "setting a top card should store its column-qualified .kanban entry"
);
assert.equal(
  isTopCard(serializedTopConfig, "Done", "existing.md"),
  true,
  "moving a top card should rewrite its column-qualified .kanban entry"
);
const externallyMovedTopCards = reconcileTopCardsWithColumns(
  new Set(["Doing/moved.md", "legacy.md", "Doing/duplicate.md"]),
  [
    { id: "Doing", cards: [] },
    { id: "Done", cards: [{ fileName: "moved.md" }] },
    { id: "Backlog", cards: [{ fileName: "legacy.md" }, { fileName: "duplicate.md" }] },
    { id: "Blocked", cards: [{ fileName: "duplicate.md" }] },
  ]
);
assert.deepEqual(
  Array.from(externallyMovedTopCards).sort(),
  ["Backlog/legacy.md", "Doing/duplicate.md", "Done/moved.md"],
  "top entries should follow externally moved cards when the file name is unique"
);
const externallyMovedConfig = parseBoardConfig(
  serializeBoardConfig(
    { top: Array.from(externallyMovedTopCards).sort() },
    topConfig.sourceText
  )
);
assert.equal(
  isTopCard(externallyMovedConfig, "Done", "moved.md"),
  true,
  "reconciled external moves should keep the moved card in the top section"
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
const renamedWithPriorities = parseBoardConfig(
  serializeBoardConfig(
    {
      ...moveBoardConfig.data,
      folders: buildFolderConfigMap(
        [
          { id: "Doing", name: "Active" },
          { id: "Done", name: "Done" },
        ],
        moveBoardConfig
      ),
    },
    moveBoardConfig.sourceText
  )
);
assert.equal(
  renamedWithPriorities.folderMap.get("Doing")?.title,
  "Active",
  "renaming a folder with priorities should store the custom display title"
);
assert.deepEqual(
  Array.from(renamedWithPriorities.folderMap.get("Doing")?.cardPriorities.keys() ?? []),
  ["moved-task.md", "existing-doing.md"],
  "renaming a folder should preserve existing card priorities"
);
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
