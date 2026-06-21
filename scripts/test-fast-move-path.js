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
  /--default-agent/,
  "runner should expose a CLI option for choosing the default agent"
);
assert.match(
  runnerSource,
  /for kind in \[AgentKind\.CLAUDE, AgentKind\.CODEX\]/,
  "runner should auto-detect Claude before Codex"
);
assert.match(
  runnerSource,
  /agent_kind_from_tags/,
  "runner should allow task tags to override the selected agent kind"
);
assert.match(
  runnerSource,
  /ToolPaths\.resolve_executable\(.*AgentKind\.CODEX/s,
  "runner should resolve the configured Codex executable instead of always using codex"
);
