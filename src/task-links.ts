import { findTaskProperties } from "./task-metadata";

export { parseTaskPropertyLine } from "./task-metadata";
export type { TaskProperty as ParsedTaskPropertyLine } from "./task-metadata";

export type TaskLinkCommand = "resumeAgent" | "openPath" | "openCode";
export type TaskLinkTitle = "Connect" | "Open" | "Code";

export type TaskLinkAction = {
  line: number;
  key: string;
  label: string;
  value: string;
  command: TaskLinkCommand;
  title: TaskLinkTitle;
};

export type TaskPropertyAction = Pick<
  TaskLinkAction,
  "command" | "title" | "value"
>;

export function findTaskLinkActions(content: string): TaskLinkAction[] {
  return findTaskProperties(content)
    .flatMap((property) => {
      return getTaskPropertyLinkActions(property.key, property.value).map(
        (action) => ({
          line: property.line,
          key: property.key,
          label: property.label,
          ...action,
        })
      );
    });
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
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

export function getTaskPropertyAction(
  key: string,
  value: string
): TaskPropertyAction | null {
  const [primaryAction] = getTaskPropertyLinkActions(key, value);
  return primaryAction ?? null;
}

function getTaskPropertyLinkActions(
  key: string,
  value: string
): TaskPropertyAction[] {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = normalizePropertyValue(value);
  if (normalizedKey === "agent" && isGuidValue(normalizedValue)) {
    return [
      {
        command: "resumeAgent",
        title: "Connect",
        value: normalizedValue,
      },
    ];
  }
  if (
    (normalizedKey === "repo"
      || normalizedKey === "path"
      || normalizedKey === "project")
    && isAbsoluteLocalPath(normalizedValue)
  ) {
    return [
      {
        command: "openPath",
        title: "Open",
        value: normalizedValue,
      },
      {
        command: "openCode",
        title: "Code",
        value: normalizedValue,
      },
    ];
  }
  return [];
}
