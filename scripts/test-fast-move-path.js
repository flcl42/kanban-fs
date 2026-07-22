const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension.ts"),
  "utf8"
);

assert.doesNotMatch(
  source,
  /\bedit\.renameFile\s*\(/,
  "file moves must not use WorkspaceEdit.renameFile because it runs VS Code file rename participants"
);
assert.match(
  source,
  /vscode\.workspace\.fs\.rename\s*\(/,
  "file moves should use the direct workspace filesystem rename path"
);
const runnerSource = fs.readFileSync(path.join(__dirname, "..", "runner.py"), "utf8");

assert.match(
  runnerSource,
  /"boardRoot":/,
  "runner move bridge requests must use camelCase JSON expected by the extension"
);
assert.match(
  runnerSource,
  /--codex-executable/,
  "runner should expose a CLI option for choosing the Codex executable"
);
assert.match(
  runnerSource,
  /--claude-executable/,
  "runner should expose a CLI option for choosing the Claude executable"
);
assert.match(
  runnerSource,
  /--kimi-executable/,
  "runner should expose a CLI option for choosing the Kimi executable"
);
assert.match(
  runnerSource,
  /--default-agent/,
  "runner should expose a CLI option for choosing the default agent"
);
assert.match(
  runnerSource,
  /kanban\.defaultAgent/,
  "direct runner starts should read the VS Code default agent setting"
);
assert.match(
  runnerSource,
  /\.vscode"[\s\S]*"settings\.json"/,
  "direct runner starts should consider workspace VS Code settings"
);
assert.match(
  runnerSource,
  /for kind in \[AgentKind\.CLAUDE, AgentKind\.CODEX, AgentKind\.KIMI\]/,
  "runner should auto-detect Claude before Codex before Kimi"
);
assert.match(
  runnerSource,
  /agent_kind_from_tags/,
  "runner should allow task tags to override the selected agent kind"
);
assert.match(
  runnerSource,
  /agent_kind_from_agent_id/,
  "runner should infer agent kind from session id format"
);
assert.match(
  source,
  /agentKindFromAgentId/,
  "extension should infer agent kind from session id format"
);
assert.match(
  runnerSource,
  /class ClaudeRunner[\s\S]*"--print"[\s\S]*"--verbose"[\s\S]*"--output-format"[\s\S]*"stream-json"/,
  "Claude stream-json runs should include --verbose because current Claude CLI requires it"
);
assert.match(
  runnerSource,
  /class KimiRunner[\s\S]*"-p"[\s\S]*"--output-format"[\s\S]*"stream-json"[\s\S]*"--session"/,
  "Kimi stream-json runs should use prompt mode and session resume"
);
assert.match(
  runnerSource,
  /parse_model_spec/,
  "runner should parse the task Model property"
);
assert.match(
  runnerSource,
  /codex_model_arguments[\s\S]*model_reasoning_effort/,
  "Codex model effort should map to model_reasoning_effort"
);
assert.match(
  runnerSource,
  /claude_model_arguments[\s\S]*"--effort"/,
  "Claude model effort should map to --effort"
);
assert.match(
  runnerSource,
  /kimi_model_arguments[\s\S]*"--model"/,
  "Kimi model selection should map to --model"
);
assert.match(
  runnerSource,
  /redacted_arg_indexes=\{args\.index\(prompt\)\}/,
  "Kimi runner logs should redact the prompt argument even when model flags are present"
);
assert.match(
  runnerSource,
  /KimiSessions\.find_new_session_id_for_workdir/,
  "Kimi runner should discover the new session id before final stdout"
);
assert.match(
  runnerSource,
  /uses_root_board = os\.path\.exists\(root_kanban_marker\)/,
  "runner should use root-board mode when .kanban is in the root"
);
assert.doesNotMatch(
  runnerSource,
  /move_root_kanban_marker_into_tasks/,
  "runner should not move a root .kanban into tasks"
);
assert.match(
  runnerSource,
  /ToolPaths\.resolve_executable\(.*AgentKind\.CODEX/s,
  "runner should resolve the configured Codex executable instead of always using codex"
);
assert.match(
  runnerSource,
  /def move_file[\s\S]*self\._move_entry\(source_path, destination_path, "file"/,
  "task file moves should still use the VS Code-aware move path"
);
assert.match(
  runnerSource,
  /def move_directory[\s\S]*os\.rename\(source_path, destination_path\)/,
  "repository directory moves should use direct filesystem renames"
);
assert.match(
  source,
  /notifyWorkspaceMove\(root, sourcePath, destinationPath\)/,
  "successful runner bridge moves should directly notify open boards"
);
assert.match(
  source,
  /resolveCurrentCardUri/,
  "card actions should resolve stale card paths after runner moves"
);
assert.match(
  source,
  /findCardByFileName/,
  "selected cards should be recovered by filename after their URI changes"
);
