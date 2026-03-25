const DEFAULT_CARD_TITLE = "New ticket";
const TITLE_PLACEHOLDER = "{{TITLE}}";
export const CURSOR_PLACEHOLDER = "{{CURSOR}}";

export const CARD_TEMPLATE_FILE_NAME = "template.md";

export function buildNewCardContent(
  title: string,
  templateContent?: string | null
): string {
  const safeTitle = title.trim() || DEFAULT_CARD_TITLE;
  if (templateContent !== undefined && templateContent !== null) {
    if (templateContent.includes(TITLE_PLACEHOLDER)) {
      return templateContent.split(TITLE_PLACEHOLDER).join(safeTitle);
    }
    return appendTitleToFirstLine(templateContent, safeTitle);
  }

  return `# ${safeTitle}\n\n`;
}

export function resolveCursorPlaceholder(content: string): {
  content: string;
  cursorOffset: number | null;
} {
  const cursorOffset = content.indexOf(CURSOR_PLACEHOLDER);
  if (cursorOffset === -1) {
    return { content, cursorOffset: null };
  }

  return {
    content: content.split(CURSOR_PLACEHOLDER).join(""),
    cursorOffset,
  };
}

function appendTitleToFirstLine(content: string, title: string): string {
  if (!content) {
    return `# ${title}\n\n`;
  }

  const newlineIndex = content.indexOf("\n");
  if (newlineIndex === -1) {
    return appendTitleSegment(content, title);
  }

  const firstLineEnd =
    newlineIndex > 0 && content[newlineIndex - 1] === "\r"
      ? newlineIndex - 1
      : newlineIndex;
  const firstLine = content.slice(0, firstLineEnd);
  const rest = content.slice(firstLineEnd);
  return appendTitleSegment(firstLine, title) + rest;
}

function appendTitleSegment(line: string, title: string): string {
  const trimmedLine = line.replace(/\s+$/, "");
  const withTitle = trimmedLine ? `${trimmedLine} ${title}` : title;
  if (/^#{1,6}\s+\S/.test(withTitle)) {
    return withTitle;
  }
  return `# ${withTitle}`.trimEnd();
}
