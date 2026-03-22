export type TaskProperty = {
  key: string;
  label: string;
  value: string;
};

export type TaskPropertyWithLine = TaskProperty & {
  line: number;
};

export function parseTaskPropertyLine(line: string): TaskProperty | null {
  const match = line.match(/^([^:\r\n\s]+(?: +[^:\r\n\s]+){0,3}\s*): ([^\r\n]+)$/);
  if (!match) {
    return null;
  }
  const label = match[1].trim().replace(/\s+/g, " ");
  const value = match[2].trim();
  if (!label || !value) {
    return null;
  }
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return null;
  }
  if (!/^[A-Za-z0-9]/.test(words[0])) {
    return null;
  }
  return {
    key: label,
    label,
    value,
  };
}

export function findTaskProperties(content: string): TaskPropertyWithLine[] {
  const lines = content.split(/\r?\n/);
  const { titleIndex } = findTitle(lines, "");
  const metadataStart = titleIndex === -1 ? 0 : titleIndex + 1;
  return extractTaskProperties(lines, metadataStart);
}

export function parseTaskMarkdown(
  content: string,
  fallbackTitle: string
): {
  title: string;
  body: string;
  properties: TaskProperty[];
  tags: string[];
} {
  const lines = content.split(/\r?\n/);
  const { title, titleIndex } = findTitle(
    lines,
    fallbackTitle.replace(/\.md$/i, "")
  );
  const metadataStart = titleIndex === -1 ? 0 : titleIndex + 1;
  const metadataEnd = findNextMarkdownSectionIndex(lines, metadataStart);
  const properties: TaskProperty[] = [];
  const bodyLines: string[] = [];
  const tags = new Set<string>();

  for (let index = metadataStart; index < lines.length; index += 1) {
    if (index < metadataEnd) {
      const property = parseTaskPropertyLine(lines[index]);
      if (property) {
        properties.push(property);
        if (property.key.toLowerCase() === "tags") {
          for (const tag of property.value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)) {
            tags.add(tag);
          }
        }
        continue;
      }
    }
    bodyLines.push(lines[index]);
  }

  return {
    title,
    body: trimBlankEdges(bodyLines).join("\n"),
    properties,
    tags: Array.from(tags),
  };
}

function findTitle(
  lines: string[],
  fallbackTitle: string
): { title: string; titleIndex: number } {
  let title = fallbackTitle;
  let titleIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("# ")) {
      continue;
    }
    title = line.replace(/^#\s+/, "").trim() || title;
    titleIndex = index;
    break;
  }

  return { title, titleIndex };
}

function extractTaskProperties(
  lines: string[],
  startIndex: number
): TaskPropertyWithLine[] {
  const endIndex = findNextMarkdownSectionIndex(lines, startIndex);
  const properties: TaskPropertyWithLine[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const property = parseTaskPropertyLine(lines[index]);
    if (!property) {
      continue;
    }
    properties.push({ ...property, line: index });
  }

  return properties;
}

function findNextMarkdownSectionIndex(
  lines: string[],
  startIndex: number
): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isMarkdownSectionHeading(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function isMarkdownSectionHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}
