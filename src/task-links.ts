import { findTaskProperties, type TaskProperty } from "./task-metadata";

export { parseTaskPropertyLine } from "./task-metadata";
export type { TaskProperty as ParsedTaskPropertyLine } from "./task-metadata";

export type TaskLinkCommand =
  | "resumeAgent"
  | "openPath"
  | "openCode"
  | "openUrl"
  | "openLocalPath";
export type TaskLinkTitle = "Connect" | "Terminal" | "Open" | "Code";

export type TaskLinkAction = {
  line: number;
  key: string;
  label: string;
  value: string;
  command: TaskLinkCommand;
  title: TaskLinkTitle;
  agentKind?: string;
  repoPath?: string;
  ticketTitle?: string;
};

export type TaskPropertyAction = Pick<
  TaskLinkAction,
  "command" | "title" | "value" | "agentKind" | "repoPath" | "ticketTitle"
>;

type TaskPropertyActionContext = Pick<TaskLinkAction, "agentKind">;
type TaskPropertyLike = Pick<TaskProperty, "key" | "value">;

export function findTaskLinkActions(content: string): TaskLinkAction[] {
  const properties = findTaskProperties(content);
  const taskContext = getTaskActionContext(content, properties);
  return properties
    .flatMap((property) => {
      return getTaskPropertyLinkActions(
        property.key,
        property.value,
        taskContext
      ).map(
        (action) => ({
          line: property.line,
          key: property.key,
          label: property.label,
          ...(action.command === "resumeAgent" ? taskContext : {}),
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
  const normalized = normalizePropertyValue(value);
  if (/^ses_[a-z0-9]+$/i.test(normalized)) {
    return true;
  }
  if (isDevinSessionValue(normalized)) {
    return true;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalized
  ) || /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalized
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
  const [primaryAction] = getTaskPropertyActions(key, value);
  return primaryAction ?? null;
}

export function getTaskPropertyActions(
  key: string,
  value: string,
  context: TaskPropertyActionContext = {}
): TaskPropertyAction[] {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = normalizePropertyValue(value);
  if (
    normalizedKey === "agent" &&
    (
      isGuidValue(normalizedValue) ||
      isContextualDevinSessionValue(normalizedValue, context.agentKind)
    )
  ) {
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
        title: "Terminal",
        value: normalizedValue,
      },
      {
        command: "openCode",
        title: "Code",
        value: normalizedValue,
      },
    ];
  }
  if (isExternalUrlValue(normalizedValue)) {
    return [
      {
        command: "openUrl",
        title: "Open",
        value: normalizedValue,
      },
    ];
  }
  return [];
}

function getTaskPropertyLinkActions(
  key: string,
  value: string,
  context: TaskPropertyActionContext
): TaskPropertyAction[] {
  return getTaskPropertyActions(key, value, context);
}

function getTaskActionContext(
  content: string,
  properties: ReturnType<typeof findTaskProperties>
): Pick<TaskLinkAction, "agentKind" | "repoPath" | "ticketTitle"> {
  const repoProperty = properties.find(
    (property) => property.key.trim().toLowerCase() === "repo"
  );
  return {
    agentKind: findAgentKindHint(properties) ?? undefined,
    repoPath: repoProperty ? normalizePropertyValue(repoProperty.value) : undefined,
    ticketTitle: findTicketTitle(content) ?? undefined,
  };
}

function findAgentKindHint(
  properties: ReturnType<typeof findTaskProperties>
): string | null {
  return getTaskAgentKindHint(properties);
}

export function getTaskAgentKindHint(
  properties: readonly TaskPropertyLike[]
): string | null {
  for (const property of properties) {
    const normalizedKey = property.key.trim().toLowerCase();
    if (normalizedKey === "agent kind" || normalizedKey === "agentkind") {
      const kind = normalizeAgentKindHint(property.value);
      if (kind) {
        return kind;
      }
    }
  }

  const tagsProperty = properties.find(
    (property) => property.key.trim().toLowerCase() === "tags"
  );
  if (tagsProperty) {
    for (const tag of tagsProperty.value.split(/[,;\s]+/)) {
      const kind = normalizeAgentKindHint(tag);
      if (kind) {
        return kind;
      }
    }
  }

  for (const property of properties) {
    const normalizedKey = property.key.trim().toLowerCase();
    if (normalizedKey !== "model") {
      continue;
    }
    const kind = normalizeModelAgentKindHint(property.value);
    if (kind) {
      return kind;
    }
  }
  return null;
}

function normalizeAgentKindHint(value: string): string | null {
  const normalized = normalizePropertyValue(value).trim().replace(/^#/, "").toLowerCase();
  if (normalized === "claude" || normalized === "agent:claude") {
    return "claude";
  }
  if (normalized === "codex" || normalized === "agent:codex") {
    return "codex";
  }
  if (normalized === "kimi" || normalized === "agent:kimi") {
    return "kimi";
  }
  if (normalized === "devin" || normalized === "agent:devin" || normalized === "agent=devin") {
    return "devin";
  }
  if (
    normalized === "opencode" ||
    normalized === "oc" ||
    normalized === "agent:opencode" ||
    normalized === "agent:oc"
  ) {
    return "opencode";
  }
  if (
    normalized === "deepseek" ||
    normalized === "deepcode" ||
    normalized === "ds" ||
    normalized === "agent:deepseek" ||
    normalized === "agent:deepcode" ||
    normalized === "agent:ds"
  ) {
    return "deepseek";
  }
  return null;
}

function normalizeModelAgentKindHint(value: string): string | null {
  const normalized = normalizePropertyValue(value).trim();
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return normalizeAgentKindHint(normalized.slice(0, slashIndex));
}

function isContextualDevinSessionValue(
  value: string,
  agentKind: string | undefined
): boolean {
  return normalizeAgentKindHint(agentKind ?? "") === "devin"
    && isDevinSessionValue(value, true);
}

function isDevinSessionValue(value: string, allowBare = false): boolean {
  const normalized = normalizePropertyValue(value);
  if (/^devin[:_-][a-z0-9][a-z0-9._-]{5,127}$/i.test(normalized)) {
    return true;
  }
  return allowBare && isBareDevinSessionValue(normalized);
}

function isBareDevinSessionValue(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(value);
}

function findTicketTitle(content: string): string | null {
  const match = /^#\s+(.+)$/m.exec(content);
  const title = match?.[1]?.trim();
  return title || null;
}

export function isExternalUrlValue(value: string): boolean {
  const normalized = normalizePropertyValue(value);
  if (!/^https?:\/\//i.test(normalized)) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
