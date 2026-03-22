const DEFAULT_CARD_TITLE = "New ticket";

export const CARD_TEMPLATE_FILE_NAME = "template.md";

export function buildNewCardContent(
  title: string,
  templateContent?: string | null
): string {
  if (templateContent !== undefined && templateContent !== null) {
    return templateContent;
  }

  const safeTitle = title.trim() || DEFAULT_CARD_TITLE;
  return `# ${safeTitle}\n\n`;
}
