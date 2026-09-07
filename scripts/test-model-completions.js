const assert = require("assert/strict");

const {
  DEFAULT_MODEL_VALUE_COMPLETION_VALUES,
  getMatchingModelValueCompletions,
  getModelValueCompletionContext,
  mergeModelValueCompletionValues,
} = require("../out/model-completions.js");

assert.deepEqual(
  DEFAULT_MODEL_VALUE_COMPLETION_VALUES,
  [
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
  ],
  "default model completion values should match the documented examples"
);

assert.deepEqual(
  getModelValueCompletionContext("Model: ", "Model: ".length),
  {
    prefix: "",
    valueStart: "Model: ".length,
    valueEnd: "Model: ".length,
  },
  "empty Model value should offer completions after the property name"
);

assert.deepEqual(
  getModelValueCompletionContext("  model: cod", "  model: cod".length),
  {
    prefix: "cod",
    valueStart: "  model: ".length,
    valueEnd: "  model: cod".length,
  },
  "Model property matching should be case-insensitive and allow indentation"
);

assert.equal(
  getModelValueCompletionContext("Project: blank", "Project: blank".length),
  null,
  "non-Model task properties should not offer model completions"
);

assert.equal(
  getModelValueCompletionContext("Model: codex", "Model".length),
  null,
  "cursor before the Model value should not offer completions"
);

assert.ok(
  getMatchingModelValueCompletions("").some(
    (completion) => completion.insertText === "codex/${1:model}/${2:max}"
  ),
  "empty Model values should offer the Codex snippet"
);

assert.ok(
  getMatchingModelValueCompletions("").some(
    (completion) => completion.insertText === "deepseek/${1:deepseek-v4-pro}/${2:max}"
  ),
  "empty Model values should offer the DeepSeek snippet"
);

assert.ok(
  getMatchingModelValueCompletions("").some(
    (completion) => completion.insertText === "opencode/${1:provider/model}/${2:max}"
  ),
  "empty Model values should offer the opencode snippet"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-5.6-ter").some(
    (completion) => completion.insertText === "codex/gpt-5.6-terra/max"
  ),
  "partial Codex model values should match documented examples"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-5.6-luna").some(
    (completion) => completion.insertText === "codex/gpt-5.6-luna/max"
  ),
  "Codex Luna model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("codex/custom-model/").some(
    (completion) => completion.insertText === "codex/custom-model/max"
  ),
  "Codex custom model values should offer effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("codex/custom-model/u").some(
    (completion) => completion.insertText === "codex/custom-model/ultra"
  ),
  "Codex custom model values should offer ultra effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("codex/sol/u").some(
    (completion) => completion.insertText === "codex/sol/ultra"
  ),
  "Codex Sol model values should offer ultra effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("claude/sonnet/h").some(
    (completion) => completion.insertText === "claude/sonnet/high"
  ),
  "Claude custom model values should offer filtered effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("kimi/k").some(
    (completion) => completion.insertText === "kimi/k2"
  ),
  "Kimi model values should offer Kimi examples"
);

assert.equal(
  getMatchingModelValueCompletions("kimi/k2/").length,
  0,
  "Kimi completions should not suggest unsupported effort values"
);

assert.ok(
  getMatchingModelValueCompletions("deepseek/deepseek-v4-f").some(
    (completion) => completion.insertText === "deepseek/deepseek-v4-flash/max"
  ),
  "DeepSeek model values should offer Deep Code examples"
);

assert.ok(
  getMatchingModelValueCompletions("deepseek/custom/").some(
    (completion) => completion.insertText === "deepseek/custom/max"
  ),
  "DeepSeek custom model values should offer max effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("deepseek/custom/h").some(
    (completion) => completion.insertText === "deepseek/custom/high"
  ),
  "DeepSeek custom model values should offer high effort completions"
);

assert.equal(
  getMatchingModelValueCompletions("deepseek/custom/u").length,
  0,
  "DeepSeek completions should not suggest unsupported ultra effort values"
);

assert.ok(
  getMatchingModelValueCompletions("opencode/opencode/muse").some(
    (completion) => completion.insertText === "opencode/opencode/muse-spark-1.2-contributor-free"
  ),
  "opencode Muse Spark model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("opencode/opencode-go/glm").some(
    (completion) => completion.insertText === "opencode/opencode-go/glm-5.3"
  ),
  "opencode Go GLM model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("opencode/moonshotai/kimi-k3/m").some(
    (completion) => completion.insertText === "opencode/moonshotai/kimi-k3/max"
  ),
  "opencode model values should offer variant completions"
);

assert.ok(
  getMatchingModelValueCompletions("oc/moonshotai/kimi-k3/mi").some(
    (completion) => completion.insertText === "oc/moonshotai/kimi-k3/minimal"
  ),
  "oc alias model values should offer opencode variant completions"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-6", [
    "codex/gpt-6-aurora/max",
  ]).some((completion) => completion.insertText === "codex/gpt-6-aurora/max"),
  "configured model completion values should be suggested without code changes"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-5.6-sol", [
    "codex/gpt-6-aurora/max",
  ]).some((completion) => completion.insertText === "codex/gpt-5.6-sol/ultra"),
  "built-in model completion values should remain available when custom values are configured"
);

assert.deepEqual(
  mergeModelValueCompletionValues(
    ["codex/gpt-5.6-sol/ultra"],
    ["codex/gpt-5.6-sol/ultra", "codex/custom/ultra"]
  ),
  ["codex/gpt-5.6-sol/ultra", "codex/custom/ultra"],
  "merged model completion values should preserve order and remove duplicates"
);
