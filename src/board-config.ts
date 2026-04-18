import YAML from "yaml";

const defaultWorkflowColumnOrder = new Map<string, number>([
  ["new", 1],
  ["backlog", 2],
  ["doing", 3],
  ["blocked", 4],
  ["done", 5],
  ["confirmed", 6],
]);

export type BoardFolderConfig = {
  id: string;
  title: string | null;
  order: number;
  rawValue: unknown;
  cardPriorities: Map<string, number>;
};

export type BoardConfig = {
  data: Record<string, unknown>;
  folders: BoardFolderConfig[];
  folderMap: Map<string, BoardFolderConfig>;
  sourceText: string;
  valid: boolean;
};

export function createEmptyBoardConfig(
  sourceText: string,
  valid = true
): BoardConfig {
  return {
    data: {},
    folders: [],
    folderMap: new Map(),
    sourceText,
    valid,
  };
}

export function parseBoardConfig(content: string): BoardConfig {
  let data: Record<string, unknown> = {};
  let valid = true;
  try {
    const parsed = YAML.parse(content);
    if (isPlainObject(parsed)) {
      data = { ...parsed };
    }
  } catch {
    data = {};
    valid = false;
  }

  const folders: BoardFolderConfig[] = [];
  const rawFolders = data.folders;

  if (Array.isArray(rawFolders)) {
    let order = 1;
    for (const entry of rawFolders) {
      if (typeof entry === "string") {
        const id = entry.trim();
        if (!id) {
          continue;
        }
        folders.push({
          id,
          title: id,
          order,
          rawValue: entry,
          cardPriorities: new Map(),
        });
        order += 1;
        continue;
      }
      if (!isPlainObject(entry)) {
        continue;
      }
      const id = coerceString(
        entry.id ?? entry.folder ?? entry.path ?? entry.name
      );
      if (!id) {
        continue;
      }
      folders.push({
        id,
        title: coerceString(entry.title) ?? id,
        order,
        rawValue: entry,
        cardPriorities: readFolderCardPriorities(entry),
      });
      order += 1;
    }
  } else if (isPlainObject(rawFolders)) {
    let order = 1;
    for (const [id, value] of Object.entries(rawFolders)) {
      const folderId = id.trim();
      if (!folderId) {
        continue;
      }
      folders.push({
        id: folderId,
        title: readFolderTitle(value) ?? folderId,
        order,
        rawValue: value,
        cardPriorities: readFolderCardPriorities(value),
      });
      order += 1;
    }
  }

  return {
    data,
    folders,
    folderMap: new Map(folders.map((folder) => [folder.id, folder])),
    sourceText: content,
    valid,
  };
}

export function serializeBoardConfig(
  data: Record<string, unknown>,
  existingText = ""
): string {
  const eol = detectLineEnding(existingText);
  if (Object.keys(data).length === 0) {
    return "";
  }
  const serialized = YAML.stringify(data).trim();
  return serialized ? `${serialized}${eol}` : "";
}

export function buildFolderConfigMap(
  columns: { id: string; name: string }[],
  boardConfig: BoardConfig,
  cardPriorityOverrides?: Map<string, string[]>
): Record<string, unknown> {
  const folders: Record<string, unknown> = {};
  for (const column of columns) {
    const existing = boardConfig.folderMap.get(column.id);
    const priorities = cardPriorityOverrides?.has(column.id)
      ? cardPriorityOverrides.get(column.id) ?? null
      : toPriorityList(existing?.cardPriorities);
    folders[column.id] = buildFolderConfigValue(
      column.id,
      column.name,
      existing?.rawValue,
      priorities
    );
  }
  return folders;
}

export function buildFolderCardPriorityOverrides(
  columns: { id: string; cards: { fileName: string }[] }[],
  boardConfig: BoardConfig
): Map<string, string[]> {
  const previousColumnsByFileName = new Map<string, Set<string>>();

  for (const folder of boardConfig.folders) {
    for (const fileName of toPriorityList(folder.cardPriorities) ?? []) {
      const ids = previousColumnsByFileName.get(fileName) ?? new Set<string>();
      ids.add(folder.id);
      previousColumnsByFileName.set(fileName, ids);
    }
  }

  const overrides = new Map<string, string[]>();

  for (const column of columns) {
    const currentFileNames = column.cards.map((card) => card.fileName);
    const currentFileNameSet = new Set(currentFileNames);
    const existingPriorityFileNames =
      toPriorityList(boardConfig.folderMap.get(column.id)?.cardPriorities) ?? [];
    const keptFileNames = existingPriorityFileNames.filter((fileName) =>
      currentFileNameSet.has(fileName)
    );
    const keptFileNameSet = new Set(keptFileNames);
    const movedInFileNames: string[] = [];
    const newFileNames: string[] = [];

    for (const fileName of currentFileNames) {
      if (keptFileNameSet.has(fileName)) {
        continue;
      }
      const previousColumns = previousColumnsByFileName.get(fileName);
      const movedFromAnotherColumn =
        !!previousColumns &&
        Array.from(previousColumns).some((columnId) => columnId !== column.id);
      if (movedFromAnotherColumn) {
        movedInFileNames.push(fileName);
      } else {
        newFileNames.push(fileName);
      }
    }

    overrides.set(column.id, [
      ...movedInFileNames,
      ...keptFileNames,
      ...newFileNames,
    ]);
  }

  return overrides;
}

export function orderColumnsByConfig<
  T extends { id: string; name: string; order: number | null }
>(columns: T[], boardConfig: BoardConfig): T[] {
  if (boardConfig.folders.length === 0) {
    return [...columns].sort(compareColumns);
  }

  const configured = boardConfig.folders
    .map((folder) => columns.find((column) => column.id === folder.id))
    .filter((column): column is T => !!column);
  const extras = columns
    .filter((column) => !boardConfig.folderMap.has(column.id))
    .sort(compareColumns);
  return [...configured, ...extras];
}

export function compareColumns(
  a: { id?: string; name: string; order: number | null },
  b: { id?: string; name: string; order: number | null }
): number {
  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  const workflowOrderA = readDefaultWorkflowColumnOrder(a);
  const workflowOrderB = readDefaultWorkflowColumnOrder(b);
  if (workflowOrderA !== workflowOrderB) {
    return workflowOrderA - workflowOrderB;
  }
  return a.name.localeCompare(b.name);
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function buildFolderConfigValue(
  folderId: string,
  title: string,
  rawValue: unknown,
  priorities: string[] | null
): unknown {
  const updated = isPlainObject(rawValue) ? { ...rawValue } : {};
  if (title === folderId) {
    delete updated.title;
  } else {
    updated.title = title;
  }

  if (priorities && priorities.length > 0) {
    updated.priorities = priorities;
  } else {
    delete updated.priorities;
  }

  const keys = Object.keys(updated);
  if (keys.length === 0) {
    return title;
  }
  if (keys.length === 1 && keys[0] === "title") {
    return title;
  }
  return updated;
}

function readFolderTitle(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (isPlainObject(value)) {
    return coerceString(value.title);
  }
  return null;
}

function readFolderCardPriorities(value: unknown): Map<string, number> {
  const priorities = new Map<string, number>();
  if (!isPlainObject(value)) {
    return priorities;
  }

  const rawPriorities = value.priorities;
  if (Array.isArray(rawPriorities)) {
    let order = 1;
    for (const entry of rawPriorities) {
      if (typeof entry !== "string") {
        continue;
      }
      const fileName = entry.trim();
      if (!fileName || priorities.has(fileName)) {
        continue;
      }
      priorities.set(fileName, order);
      order += 1;
    }
    return priorities;
  }

  if (!isPlainObject(rawPriorities)) {
    return priorities;
  }

  const entries = Object.entries(rawPriorities)
    .map(([fileName, rawPriority]) => {
      const trimmedName = fileName.trim();
      const priority =
        typeof rawPriority === "number"
          ? rawPriority
          : Number(coerceString(rawPriority) ?? "");
      return [trimmedName, priority] as const;
    })
    .filter(
      ([fileName, priority]) => fileName.length > 0 && Number.isFinite(priority)
    )
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  for (const [fileName, priority] of entries) {
    priorities.set(fileName, priority);
  }

  return priorities;
}

function toPriorityList(
  priorities: Map<string, number> | undefined
): string[] | null {
  if (!priorities || priorities.size === 0) {
    return null;
  }
  return Array.from(priorities.entries())
    .sort(
    (a, b) => a[1] - b[1] || a[0].localeCompare(b[0])
    )
    .map(([fileName]) => fileName);
}

function readDefaultWorkflowColumnOrder(column: {
  id?: string;
  name: string;
}): number {
  const idOrder = column.id
    ? defaultWorkflowColumnOrder.get(column.id.trim().toLowerCase())
    : undefined;
  if (idOrder !== undefined) {
    return idOrder;
  }
  return (
    defaultWorkflowColumnOrder.get(column.name.trim().toLowerCase()) ??
    Number.POSITIVE_INFINITY
  );
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
