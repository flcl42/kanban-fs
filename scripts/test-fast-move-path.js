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
const runnerSource = fs.readFileSync(path.join(__dirname, "..", "codex_runner.csx"), "utf8");

assert.match(
  runnerSource,
  /PropertyNamingPolicy\s*=\s*JsonNamingPolicy\.CamelCase/,
  "runner move bridge requests must use camelCase JSON expected by the extension"
);
assert.match(
  runnerSource,
  /--codex-executable/,
  "runner should expose a CLI option for choosing the Codex executable"
);
assert.match(
  runnerSource,
  /ToolPaths\.ResolveCodexExecutable\(settings\.CodexExecutable\)/,
  "runner should resolve the configured Codex executable instead of always using codex"
);
