export type ParsedTaskPropertyLine = {
  key: string;
  label: string;
  value: string;
};

export type TaskLinkAction = {
  line: number;
  key: string;
  label: string;
  value: string;
  command: "resumeAgent" | "openPath";
  title: "Connect" | "Open";
};

export function findTaskLinkActions(content: string): TaskLinkAction[] {
  const lines = content.split(/\r?\n/);
  let titleIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("# ")) {
      titleIndex = i;
      break;
    }
  }

  const metadataStart = titleIndex === -1 ? 0 : titleIndex + 1;
  const properties = extractPropertyBlock(lines, metadataStart);

  return properties
    .map((property) => {
      const action = getTaskLinkAction(property.key, property.value);
      if (!action) {
        return null;
      }
      return {
        line: property.line,
        key: property.key,
        label: property.label,
        value: normalizePropertyValue(property.value),
        command: action.command,
        title: action.title,
      };
    })
    .filter((action): action is TaskLinkAction => !!action);
}

export function parseTaskPropertyLine(
  line: string
): ParsedTaskPropertyLine | null {
  const match = line.match(/^\s*([^:\r\n][^:\r\n]*?)\s*:\s*(.*?)\s*$/);
  if (!match) {
    return null;
  }
  const label = match[1].trim();
  if (!label) {
    return null;
  }
  return {
    key: label,
    label,
    value: match[2].trim(),
  };
}

export function normalizePropertyValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function isGuidValue(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizePropertyValue(value)
  );
}

export function isAbsoluteLocalPath(value: string): boolean {
  const normalized = normalizePropertyValue(value);
  if (!normalized || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return false;
  }
  return /^[a-zA-Z]:[\\/]/.test(normalized)
    || normalized.startsWith("\\\\")
    || normalized.startsWith("/");
}

function getTaskLinkAction(
  key: string,
  value: string
): Pick<TaskLinkAction, "command" | "title"> | null {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = normalizePropertyValue(value);
  if (normalizedKey === "agent" && isGuidValue(normalizedValue)) {
    return { command: "resumeAgent", title: "Connect" };
  }
  if (isAbsoluteLocalPath(normalizedValue)) {
    return { command: "openPath", title: "Open" };
  }
  return null;
}

function extractPropertyBlock(
  lines: string[],
  startIndex: number
): Array<ParsedTaskPropertyLine & { line: number }> {
  let index = startIndex;
  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }
  const firstContentIndex = index;

  const properties: Array<ParsedTaskPropertyLine & { line: number }> = [];
  while (index < lines.length) {
    const property = parseTaskPropertyLine(lines[index]);
    if (!property) {
      break;
    }
    properties.push({ ...property, line: index });
    index += 1;
  }

  if (
    properties.length === 0 ||
    (index < lines.length && lines[index].trim() !== "")
  ) {
    return [];
  }

  if (firstContentIndex >= lines.length) {
    return [];
  }

  return properties;
}
