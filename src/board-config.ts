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
  ignoredFolders: Set<string>;
  topCards: Set<string>;
  defaultModels: Record<string, string>;
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
    ignoredFolders: new Set(),
    topCards: new Set(),
    defaultModels: {},
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
  const ignoredFolders = readIgnoredFolders(data);
  const topCards = readTopCards(data);
  const defaultModels = readDefaultModels(data);

  return {
    data,
    folders,
    folderMap: new Map(folders.map((folder) => [folder.id, folder])),
    ignoredFolders,
    topCards,
    defaultModels,
    sourceText: content,
    valid,
  };
}

export function isIgnoredFolder(
  boardConfig: BoardConfig,
  folderId: string
): boolean {
  return boardConfig.ignoredFolders.has(normalizeFolderId(folderId));
}

export function cardTopKey(columnId: string, fileName: string): string {
  return normalizeTopCardKey(`${columnId}/${fileName}`);
}

export function isTopCard(
  boardConfig: BoardConfig,
  columnId: string,
  fileName: string
): boolean {
  return hasMatchingTopCardKey(boardConfig.topCards, columnId, fileName);
}

export function setTopCardInSet(
  topCards: Set<string>,
  columnId: string,
  fileName: string,
  top: boolean
): Set<string> {
  const nextTopCards = new Set(topCards);
  removeMatchingTopCardKeys(nextTopCards, columnId, fileName);
  if (top) {
    nextTopCards.add(cardTopKey(columnId, fileName));
  }
  return nextTopCards;
}

export function moveTopCardInSet(
  topCards: Set<string>,
  sourceColumnId: string,
  sourceFileName: string,
  targetColumnId: string,
  targetFileName: string
): Set<string> {
  const nextTopCards = new Set(topCards);
  const wasTop = removeMatchingTopCardKeys(
    nextTopCards,
    sourceColumnId,
    sourceFileName
  );
  if (wasTop) {
    nextTopCards.add(cardTopKey(targetColumnId, targetFileName));
  }
  return nextTopCards;
}

export function reconcileTopCardsWithColumns(
  topCards: Set<string>,
  columns: { id: string; cards: { fileName: string }[] }[]
): Set<string> {
  if (topCards.size === 0) {
    return new Set();
  }

  const locationsByFileName = new Map<
    string,
    { columnId: string; fileName: string }[]
  >();
  const locationsByKey = new Map<string, { columnId: string; fileName: string }>();

  for (const column of columns) {
    const columnId = String(column?.id ?? "").trim();
    if (!columnId) {
      continue;
    }
    for (const card of column.cards || []) {
      const fileName = coerceString(card?.fileName);
      if (!fileName) {
        continue;
      }
      const location = { columnId, fileName };
      const fileNameKey = normalizeTopCardKey(fileName).toLowerCase();
      const existingLocations = locationsByFileName.get(fileNameKey) ?? [];
      existingLocations.push(location);
      locationsByFileName.set(fileNameKey, existingLocations);
      locationsByKey.set(cardTopKey(columnId, fileName).toLowerCase(), location);
    }
  }

  const reconciledTopCards = new Set<string>();
  for (const cardKey of topCards) {
    const normalizedKey = normalizeTopCardKey(cardKey);
    if (!normalizedKey) {
      continue;
    }
    const existingLocation = locationsByKey.get(normalizedKey.toLowerCase());
    if (existingLocation) {
      reconciledTopCards.add(
        cardTopKey(existingLocation.columnId, existingLocation.fileName)
      );
      continue;
    }

    const fileName = topCardKeyFileName(normalizedKey);
    const matchingLocations =
      locationsByFileName.get(normalizeTopCardKey(fileName).toLowerCase()) ?? [];
    if (matchingLocations.length === 1) {
      const [location] = matchingLocations;
      reconciledTopCards.add(cardTopKey(location.columnId, location.fileName));
      continue;
    }

    reconciledTopCards.add(normalizedKey);
  }

  return reconciledTopCards;
}

export function setTopCardsInConfigData(
  data: Record<string, unknown>,
  topCards: Set<string>
): void {
  const key = getTopCardsConfigKey(data);
  for (const alias of topCardsConfigKeys) {
    if (alias !== key) {
      delete data[alias];
    }
  }
  const serializedTopCards = Array.from(topCards)
    .map(normalizeTopCardKey)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (serializedTopCards.length > 0) {
    data[key] = serializedTopCards;
  } else {
    delete data[key];
  }
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

function readIgnoredFolders(data: Record<string, unknown>): Set<string> {
  const ignoredFolders = new Set<string>();
  for (const key of [
    "ignoreFolders",
    "ignoredFolders",
    "ignoreDirs",
    "ignoredDirs",
    "excludeFolders",
    "excludedFolders",
    "excludeDirs",
    "excludedDirs",
    "ignore",
    "exclude",
  ]) {
    for (const folderId of readStringList(data[key])) {
      ignoredFolders.add(normalizeFolderId(folderId));
    }
  }
  return ignoredFolders;
}

function readDefaultModels(data: Record<string, unknown>): Record<string, string> {
  const raw =
    data.defaultModels ??
    data.defaultAgentModels ??
    data.agentDefaultModels ??
    data.models;
  if (!isPlainObject(raw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || typeof value !== "string") {
      continue;
    }
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      continue;
    }
    result[normalizedKey] = trimmedValue;
  }
  return result;
}

const topCardsConfigKeys = [
  "top",
  "topCards",
  "topItems",
  "pinned",
  "pinnedCards",
];

function readTopCards(data: Record<string, unknown>): Set<string> {
  const topCards = new Set<string>();
  for (const key of topCardsConfigKeys) {
    for (const cardKey of readStringList(data[key])) {
      const normalized = normalizeTopCardKey(cardKey);
      if (normalized) {
        topCards.add(normalized);
      }
    }
  }
  return topCards;
}

function getTopCardsConfigKey(data: Record<string, unknown>): string {
  return topCardsConfigKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(data, key)
  ) ?? "top";
}

function hasMatchingTopCardKey(
  topCards: Set<string>,
  columnId: string,
  fileName: string
): boolean {
  const expectedKey = cardTopKey(columnId, fileName).toLowerCase();
  const expectedLegacyKey = normalizeTopCardKey(fileName).toLowerCase();
  for (const cardKey of topCards) {
    const normalized = normalizeTopCardKey(cardKey).toLowerCase();
    if (normalized === expectedKey) {
      return true;
    }
    if (!normalized.includes("/") && normalized === expectedLegacyKey) {
      return true;
    }
  }
  return false;
}

function removeMatchingTopCardKeys(
  topCards: Set<string>,
  columnId: string,
  fileName: string
): boolean {
  const matchingKeys = Array.from(topCards).filter((cardKey) =>
    isMatchingTopCardKey(cardKey, columnId, fileName)
  );
  for (const cardKey of matchingKeys) {
    topCards.delete(cardKey);
  }
  return matchingKeys.length > 0;
}

function isMatchingTopCardKey(
  cardKey: string,
  columnId: string,
  fileName: string
): boolean {
  const normalized = normalizeTopCardKey(cardKey).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === cardTopKey(columnId, fileName).toLowerCase()) {
    return true;
  }
  return (
    !normalized.includes("/") &&
    normalized === normalizeTopCardKey(fileName).toLowerCase()
  );
}

function topCardKeyFileName(cardKey: string): string {
  const normalized = normalizeTopCardKey(cardKey);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function normalizeTopCardKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => coerceString(item))
    .filter((item): item is string => !!item);
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

function normalizeFolderId(value: string): string {
  return value.trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
