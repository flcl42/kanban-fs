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
    "codex/gpt-6.1-sol/ultra",
    "codex/gpt-6.1-sol/max",
    "codex/gpt-6.1-sol/xhigh",
    "codex/gpt-6.1-sol/high",
    "codex/gpt-6.1-sol/medium",
    "codex/gpt-6.1-sol/low",
    "codex/gpt-6-astra/ultra",
    "codex/gpt-6-astra/max",
    "codex/gpt-6-astra/xhigh",
    "codex/gpt-6-astra/high",
    "codex/gpt-6-astra/medium",
    "codex/gpt-6-astra/low",
    "codex/gpt-6-sol/ultra",
    "codex/gpt-6-sol/max",
    "codex/gpt-6-sol/xhigh",
    "codex/gpt-6-sol/high",
    "codex/gpt-6-sol/medium",
    "codex/gpt-6-sol/low",
    "codex/gpt-6-luna/max",
    "codex/gpt-6-luna/xhigh",
    "codex/gpt-6-luna/high",
    "codex/gpt-6-luna/medium",
    "codex/gpt-6-luna/low",
    "codex/gpt-reserve/max",
    "codex/gpt-reserve/xhigh",
    "codex/gpt-reserve/high",
    "codex/gpt-reserve/medium",
    "codex/gpt-reserve/low",
    "codex/gpt-5.6-sol/ultra",
    "codex/gpt-5.6-sol/max",
    "codex/gpt-5.6-sol/xhigh",
    "codex/gpt-5.6-sol/high",
    "codex/gpt-5.6-sol/medium",
    "codex/gpt-5.6-sol/low",
    "codex/gpt-5.6-terra/ultra",
    "codex/gpt-5.6-terra/max",
    "codex/gpt-5.6-terra/xhigh",
    "codex/gpt-5.6-terra/high",
    "codex/gpt-5.6-terra/medium",
    "codex/gpt-5.6-terra/low",
    "codex/gpt-5.6-luna/ultra",
    "codex/gpt-5.6-luna/max",
    "codex/gpt-5.6-luna/xhigh",
    "codex/gpt-5.6-luna/high",
    "codex/gpt-5.6-luna/medium",
    "codex/gpt-5.6-luna/low",
    "codex/sol/ultra",
    "claude/sonnet/ultra",
    "claude/sonnet/max",
    "claude/sonnet/xhigh",
    "claude/sonnet/high",
    "claude/sonnet/medium",
    "claude/sonnet/low",
    "claude/opus/ultra",
    "claude/opus/max",
    "claude/opus/xhigh",
    "claude/opus/high",
    "claude/opus/medium",
    "claude/opus/low",
    "claude/fable/ultra",
    "claude/fable/max",
    "claude/fable/xhigh",
    "claude/fable/high",
    "claude/fable/medium",
    "claude/fable/low",
    "claude/haiku/ultra",
    "claude/haiku/max",
    "claude/haiku/xhigh",
    "claude/haiku/high",
    "claude/haiku/medium",
    "claude/haiku/low",
    "claude/claude-mythos-5-1/ultra",
    "claude/claude-mythos-5-1/max",
    "claude/claude-mythos-5-1/xhigh",
    "claude/claude-mythos-5-1/high",
    "claude/claude-mythos-5-1/medium",
    "claude/claude-mythos-5-1/low",
    "kimi/k2",
    "opencode/opencode-go/cat-jam-free",
    "opencode/opencode-go/claude-haiku-5-5",
    "opencode/opencode-go/deepseek-v4-pro",
    "opencode/opencode-go/deepseek-v4.1-flash",
    "opencode/opencode-go/gemini-4-argon-contributor",
    "opencode/opencode-go/glm-5.2",
    "opencode/opencode-go/glm-5.3",
    "opencode/opencode-go/glm-5.3-flash",
    "opencode/opencode-go/gpt-5.6-luna",
    "opencode/opencode-go/gpt-6-luna",
    "opencode/opencode-go/grok-4.6",
    "opencode/opencode-go/grok-4.7",
    "opencode/opencode-go/hy3",
    "opencode/opencode-go/hy4-preview",
    "opencode/opencode-go/kimi-k2.7-code",
    "opencode/opencode-go/kimi-k3",
    "opencode/opencode-go/longcat-2.0",
    "opencode/opencode-go/longcat-2.5-preview-free",
    "opencode/opencode-go/mimo-v2.5",
    "opencode/opencode-go/mimo-v2.5-pro",
    "opencode/opencode-go/mimo-v2.6-flash",
    "opencode/opencode-go/mimo-v2.6-pro",
    "opencode/opencode-go/minimax-m2.7",
    "opencode/opencode-go/minimax-m3",
    "opencode/opencode-go/muse-spark-1.2-contributor",
    "opencode/opencode-go/muse-spark-1.3-contributor",
    "opencode/opencode-go/qwen3.7-plus",
    "opencode/opencode-go/qwen3.8-flash",
    "opencode/opencode-go/qwen3.8-max",
    "opencode/opencode-go/space-bunny",
    "opencode/opencode-go/step-5-preview-free",
    "opencode/opencode/big-pickle",
    "opencode/opencode/cat-jam-free",
    "opencode/opencode/longcat-2.5-preview-free",
    "opencode/opencode/mimo-v2.6-flash-free",
    "opencode/opencode/muse-spark-1.3-contributor-free",
    "opencode/opencode/nemotron-3-ultra-free",
    "opencode/opencode/nemotron-3.5-lightning-free",
    "opencode/opencode/space-bunny-free",
    "opencode/opencode/step-5-preview-free",
    "opencode/deepseek/deepseek-v4-pro/max",
    "opencode/deepseek/deepseek-v4-flash/high",
    "deepseek/deepseek-v4-pro/max",
    "deepseek/deepseek-v4-pro/high",
    "deepseek/deepseek-v4-flash/max",
    "deepseek/deepseek-v4-flash/high",
    "devin/swe-2/max",
    "devin/swe-2/high",
    "devin/swe-2/medium",
    "devin/swe",
    "devin/swe-1-7-lightning",
    "devin/opus",
    "devin/sonnet",
    "devin/gpt",
    "devin/codex",
    "devin/gemini",
    "devin/kimi",
    "devin/deepseek",
    "devin/glm",
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
  getMatchingModelValueCompletions("").some(
    (completion) => completion.insertText === "devin/${1:swe-2}/${2:max}"
  ),
  "empty Model values should offer the Devin snippet"
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
  getMatchingModelValueCompletions("devin/swe-2/").some(
    (completion) => completion.insertText === "devin/swe-2/max"
  ),
  "Devin model values should offer max effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("devin/swe-2/h").some(
    (completion) => completion.insertText === "devin/swe-2/high"
  ),
  "Devin model values should offer filtered high effort completions"
);

assert.equal(
  getMatchingModelValueCompletions("devin/swe-2/u").length,
  0,
  "Devin completions should not suggest unsupported ultra effort values"
);

assert.ok(
  getMatchingModelValueCompletions("opencode/opencode/muse").some(
    (completion) => completion.insertText === "opencode/opencode/muse-spark-1.3-contributor-free"
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
  getMatchingModelValueCompletions("opencode/opencode-go/kimi-k3/m").some(
    (completion) => completion.insertText === "opencode/opencode-go/kimi-k3/max"
  ),
  "opencode model values should offer variant completions"
);

assert.ok(
  getMatchingModelValueCompletions("oc/opencode-go/kimi-k3/mi").some(
    (completion) => completion.insertText === "oc/opencode-go/kimi-k3/minimal"
  ),
  "oc alias model values should offer opencode variant completions"
);

assert.ok(
  getMatchingModelValueCompletions("opencode/opencode-go/kimi-k3/x").some(
    (completion) => completion.insertText === "opencode/opencode-go/kimi-k3/xhigh"
  ),
  "opencode model values should offer xhigh variant completions"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-6.1-sol/").some(
    (completion) => completion.insertText === "codex/gpt-6.1-sol/ultra"
  ),
  "Codex GPT-6.1 Sol model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-6.1-sol/x").some(
    (completion) => completion.insertText === "codex/gpt-6.1-sol/xhigh"
  ),
  "Codex GPT-6.1 Sol model values should offer xhigh effort completions"
);

assert.ok(
  getMatchingModelValueCompletions("codex/gpt-6-luna/").some(
    (completion) => completion.insertText === "codex/gpt-6-luna/max"
  ),
  "Codex GPT-6 Luna model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("claude/fable/").some(
    (completion) => completion.insertText === "claude/fable/max"
  ),
  "Claude Fable model values should be built in"
);

assert.ok(
  getMatchingModelValueCompletions("claude/opus/m").some(
    (completion) => completion.insertText === "claude/opus/medium"
  ),
  "Claude Opus model values should offer every effort completion"
);

assert.ok(
  getMatchingModelValueCompletions("claude/claude-mythos").some(
    (completion) => completion.insertText === "claude/claude-mythos-5-1/xhigh"
  ),
  "Claude Mythos model values should be built in"
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
