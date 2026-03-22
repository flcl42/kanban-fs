const assert = require("assert/strict");

const {
  buildFolderConfigMap,
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
