export function slugifyFileName(value: string): string {
  const trimmed = value.normalize("NFC").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makeUniqueFileName(
  desiredFileName: string,
  existingFileNames: Iterable<string>
): string {
  const existing = new Set(
    Array.from(existingFileNames, (fileName) => normalizeFileNameKey(fileName))
  );
  if (!existing.has(normalizeFileNameKey(desiredFileName))) {
    return desiredFileName;
  }

  const { stem, extension } = splitFileName(desiredFileName);
  const suffixMatch = stem.match(/^(.+)-(\d+)$/u);
  const baseStem = suffixMatch?.[1] ?? stem;
  const suffixWidth = suffixMatch?.[2]?.length ?? 0;
  let counter = suffixMatch ? Number(suffixMatch[2]) + 1 : 2;

  while (counter < Number.MAX_SAFE_INTEGER) {
    const suffix =
      suffixWidth > 1
        ? String(counter).padStart(suffixWidth, "0")
        : String(counter);
    const candidate = `${baseStem}-${suffix}${extension}`;
    if (!existing.has(normalizeFileNameKey(candidate))) {
      return candidate;
    }
    counter += 1;
  }

  throw new Error(`Could not generate a unique filename for ${desiredFileName}.`);
}

function normalizeFileNameKey(value: string): string {
  return value.toLowerCase();
}

function splitFileName(fileName: string): { stem: string; extension: string } {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return { stem: fileName, extension: "" };
  }
  return {
    stem: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
}
