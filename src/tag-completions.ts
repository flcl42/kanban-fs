export type TagValueCompletionContext = {
  valueStart: number;
  valueEnd: number;
  prefix: string;
  existingTags: string[];
};

export function getTagValueCompletionContext(
  line: string,
  cursor: number
): TagValueCompletionContext | null {
  const match = /^(\s*Tags?:[ \t]*)(.*)$/i.exec(line);
  if (!match || cursor < match[1].length || cursor > line.length) {
    return null;
  }

  const value = match[2];
  const offset = cursor - match[1].length;
  const previousComma = value.lastIndexOf(",", offset - 1);
  const nextComma = value.indexOf(",", offset);
  const segmentStart = previousComma + 1;
  const segmentEnd = nextComma === -1 ? value.length : nextComma;
  const segmentIndex = value.slice(0, segmentStart).split(",").length - 1;
  const segment = value.slice(segmentStart, segmentEnd);
  const leadingSpace = segment.match(/^[ \t]*/)?.[0].length ?? 0;
  const trailingSpace = segment.match(/[ \t]*$/)?.[0].length ?? 0;
  const start = segmentStart + leadingSpace;
  const end = Math.max(start, segmentEnd - trailingSpace);
  if (offset < start || offset > segmentEnd) {
    return null;
  }

  return {
    valueStart: match[1].length + start,
    valueEnd: match[1].length + end,
    prefix: value.slice(start, offset).trimEnd(),
    existingTags: value
      .split(",")
      .filter((_tag, index) => index !== segmentIndex)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function getMatchingTagCompletions(
  tags: Iterable<string>,
  context: TagValueCompletionContext
): string[] {
  const prefix = context.prefix.toLowerCase();
  const existing = new Set(context.existingTags);
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = tag.toLowerCase();
    if (!tag || !key.startsWith(prefix) || seen.has(key) || existing.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(tag);
  }
  return matches.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}
