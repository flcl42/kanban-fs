export type ModelValueCompletionKind = "snippet" | "value";

export type ModelValueCompletion = {
  label: string;
  insertText: string;
  kind: ModelValueCompletionKind;
  detail: string;
  documentation: string;
  sortText: string;
};

export type ModelValueCompletionContext = {
  prefix: string;
  valueStart: number;
  valueEnd: number;
};

const MODEL_EFFORT_AGENTS = new Set(["codex", "claude", "deepseek", "opencode", "oc"]);
const MODEL_EFFORT_LEVELS = ["ultra", "max", "xhigh", "high", "medium", "low"];
const DEEPSEEK_MODEL_EFFORT_LEVELS = ["max", "high"];
const OPENCODE_MODEL_VARIANTS = ["max", "high", "medium", "low", "minimal"];

export const DEFAULT_MODEL_VALUE_COMPLETION_VALUES = [
  "codex/gpt-5.6-sol/ultra",
  "codex/gpt-5.6-sol/max",
  "codex/sol/ultra",
  "codex/gpt-5.6-luna/ultra",
  "codex/gpt-5.6-luna/max",
  "codex/gpt-5.6-luna/high",
  "codex/gpt-5.6-terra/max",
  "codex/gpt-5.6-terra/ultra",
  "codex/gpt-5.6-terra/high",
  "claude/sonnet/ultra",
  "claude/sonnet/max",
  "claude/sonnet/high",
  "claude/opus/ultra",
  "kimi/k2",
  "opencode/opencode/muse-spark-1.2-contributor-free",
  "opencode/opencode/muse-spark-1.3-contributor-free",
  "opencode/opencode/big-pickle",
  "opencode/opencode/hy3-free",
  "opencode/opencode/ling-3.0-flash-fin-free",
  "opencode/opencode/mimo-v2.5-free",
  "opencode/opencode/nemotron-3-ultra-free",
  "opencode/opencode/nemotron-3.5-lightning-free",
  "opencode/opencode/x-preview-f-free",
  "opencode/opencode-go/deepseek-v4-flash",
  "opencode/opencode-go/deepseek-v4-flash-vision-exp",
  "opencode/opencode-go/deepseek-v4-pro",
  "opencode/opencode-go/glm-5.1",
  "opencode/opencode-go/glm-5.2",
  "opencode/opencode-go/glm-5.3",
  "opencode/opencode-go/glm-5.3-flash",
  "opencode/opencode-go/gpt-5.6-luna",
  "opencode/opencode-go/grok-4.6",
  "opencode/opencode-go/hy3",
  "opencode/opencode-go/hy4-preview",
  "opencode/opencode-go/kimi-k2.6",
  "opencode/opencode-go/kimi-k2.7-code",
  "opencode/opencode-go/kimi-k3",
  "opencode/opencode-go/longcat-2.0",
  "opencode/opencode-go/mimo-v2.5",
  "opencode/opencode-go/mimo-v2.5-pro",
  "opencode/opencode-go/minimax-m2.7",
  "opencode/opencode-go/minimax-m3",
  "opencode/opencode-go/muse-spark-1.2-contributor",
  "opencode/opencode-go/muse-spark-1.3-contributor",
  "opencode/opencode-go/qwen3.6-plus",
  "opencode/opencode-go/qwen3.7-max",
  "opencode/opencode-go/qwen3.7-plus",
  "opencode/opencode-go/qwen3.8-flash",
  "opencode/opencode-go/qwen3.8-max",
  "opencode/moonshotai/kimi-k3",
  "opencode/deepseek/deepseek-v4-pro/max",
  "opencode/deepseek/deepseek-v4-flash/high",
  "deepseek/deepseek-v4-pro/max",
  "deepseek/deepseek-v4-pro/high",
  "deepseek/deepseek-v4-flash/max",
  "deepseek/deepseek-v4-flash/high",
] as const;

const MODEL_VALUE_SNIPPET_COMPLETIONS: readonly ModelValueCompletion[] = [
  {
    label: "codex/model/effort",
    insertText: "codex/${1:model}/${2:max}",
    kind: "snippet",
    detail: "Codex model with reasoning effort",
    documentation: "Use codex/model/effort. The runner maps effort to model_reasoning_effort.",
    sortText: "0-codex-template",
  },
  {
    label: "claude/model/effort",
    insertText: "claude/${1:model}/${2:max}",
    kind: "snippet",
    detail: "Claude model with effort",
    documentation: "Use claude/model/effort. The runner passes effort to Claude as --effort.",
    sortText: "0-claude-template",
  },
  {
    label: "kimi/model",
    insertText: "kimi/${1:model}",
    kind: "snippet",
    detail: "Kimi model",
    documentation: "Use kimi/model. Kimi model values do not accept an effort segment.",
    sortText: "0-kimi-template",
  },
  {
    label: "deepseek/model/effort",
    insertText: "deepseek/${1:deepseek-v4-pro}/${2:max}",
    kind: "snippet",
    detail: "DeepSeek model with Deep Code reasoning effort",
    documentation: "Use deepseek/model/effort. The runner maps model and effort to Deep Code settings.",
    sortText: "0-deepseek-template",
  },
  {
    label: "opencode/provider/model/variant",
    insertText: "opencode/${1:provider/model}/${2:max}",
    kind: "snippet",
    detail: "opencode model with variant",
    documentation: "Use opencode/provider/model/variant. The runner passes variant to opencode as --variant.",
    sortText: "0-opencode-template",
  },
];

export const MODEL_VALUE_COMPLETIONS: readonly ModelValueCompletion[] = [
  ...MODEL_VALUE_SNIPPET_COMPLETIONS,
  ...buildConfiguredModelValueCompletions(DEFAULT_MODEL_VALUE_COMPLETION_VALUES),
];

export function getModelValueCompletionContext(
  lineText: string,
  character: number
): ModelValueCompletionContext | null {
  const match = /^(\s*Model\s*:\s*)(.*)$/i.exec(lineText);
  if (!match) {
    return null;
  }

  const valueStart = match[1].length;
  if (character < valueStart) {
    return null;
  }

  const safeCharacter = Math.min(character, lineText.length);
  return {
    prefix: lineText.slice(valueStart, safeCharacter),
    valueStart,
    valueEnd: lineText.length,
  };
}

export function getMatchingModelValueCompletions(
  prefix: string,
  configuredValues: readonly string[] = DEFAULT_MODEL_VALUE_COMPLETION_VALUES
): ModelValueCompletion[] {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const modelValues = mergeModelValueCompletionValues(
    DEFAULT_MODEL_VALUE_COMPLETION_VALUES,
    configuredValues
  );
  const completions = [
    ...getDynamicEffortCompletions(normalizedPrefix),
    ...MODEL_VALUE_SNIPPET_COMPLETIONS,
    ...buildConfiguredModelValueCompletions(modelValues),
  ];
  const seen = new Set<string>();

  return completions.filter((completion) => {
    const key = completion.insertText.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);

    if (!normalizedPrefix) {
      return true;
    }

    return (
      key.startsWith(normalizedPrefix) ||
      completion.label.toLowerCase().startsWith(normalizedPrefix)
    );
  });
}

export function mergeModelValueCompletionValues(
  ...valueGroups: readonly (readonly string[])[]
): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const group of valueGroups) {
    for (const rawValue of group) {
      const value = rawValue.trim();
      if (!value) {
        continue;
      }
      const key = value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      values.push(value);
    }
  }
  return values;
}

function buildConfiguredModelValueCompletions(
  values: readonly string[]
): ModelValueCompletion[] {
  const seen = new Set<string>();
  const completions: ModelValueCompletion[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    completions.push({
      label: value,
      insertText: value,
      kind: "value",
      detail: getConfiguredModelDetail(value),
      documentation: "Configured Model: completion value.",
      sortText: `1-configured-${String(completions.length).padStart(4, "0")}-${key}`,
    });
  }
  return completions;
}

function getDynamicEffortCompletions(prefix: string): ModelValueCompletion[] {
  const parts = prefix.split("/");
  if (parts.length < 2) {
    return [];
  }

  const agent = parts[0];
  if (!MODEL_EFFORT_AGENTS.has(agent)) {
    return [];
  }

  const modelParts = parts.length === 2 ? [parts[1]] : parts.slice(1, -1);
  const model = modelParts.join("/");
  const effortPrefix = parts.length >= 3 && !prefix.endsWith("/")
    ? parts[parts.length - 1]
    : "";
  if (!model) {
    return [];
  }

  const effortLevels = agent === "deepseek"
    ? DEEPSEEK_MODEL_EFFORT_LEVELS
    : agent === "opencode" || agent === "oc"
      ? OPENCODE_MODEL_VARIANTS
      : MODEL_EFFORT_LEVELS;
  return effortLevels
    .filter((effort) => effort.startsWith(effortPrefix))
    .map((effort, index) => ({
      label: `${agent}/${model}/${effort}`,
      insertText: `${agent}/${model}/${effort}`,
      kind: "value",
      detail: `${capitalizeAgent(agent)} effort`,
      documentation: `Use ${effort} effort for ${agent}/${model}.`,
      sortText: `0-effort-${index}-${effort}`,
    }));
}

function getConfiguredModelDetail(value: string): string {
  const agent = value.split("/", 1)[0]?.trim().toLowerCase();
  if (agent === "codex") {
    return "Codex configured model";
  }
  if (agent === "claude") {
    return "Claude configured model";
  }
  if (agent === "kimi") {
    return "Kimi configured model";
  }
  if (agent === "deepseek") {
    return "DeepSeek configured model";
  }
  if (agent === "opencode" || agent === "oc") {
    return "opencode configured model";
  }
  return "Configured model";
}

function capitalizeAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}
