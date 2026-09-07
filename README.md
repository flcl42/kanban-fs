# ai-kanban

[![Visual Studio Marketplace Installs](https://badgen.net/vs-marketplace/i/flcl42.kanban-vsix)](https://marketplace.visualstudio.com/items?itemName=flcl42.kanban-vsix)

ai-kanban is a VS Code Kanban board backed by normal folders and Markdown files. It works as a simple local task board by default, and it can optionally run a background agent runner for AI-assisted task execution.

## Preview

![ai-kanban board with cards, tags, columns, and task details](docs/kanban.png)

## Install

Install from the Visual Studio Marketplace:

1. Open VS Code.
2. Open Extensions.
3. Search for `ai-kanban` or `flcl42.kanban-vsix`.
4. Install the extension.

Install from a local VSIX:

```powershell
code --install-extension .\kanban-vsix-<version>.vsix
```

After installation, open the Command Palette with `Ctrl+Shift+P` or `Cmd+Shift+P` and search for `AI Kanban`.

## Create A Board

ai-kanban stores board state in a `.kanban` YAML file. Columns are folders beside that file, and cards are Markdown files inside column folders.

Use one of these commands:

- `AI Kanban: Create Empty Board` creates only a `.kanban` file in the folder you choose.
- `AI Kanban: Create Board with Columns` creates `.kanban` plus the default workflow folders: `new`, `backlog`, `doing`, `done`, `confirmed`.
- `AI Kanban: Create Board with Initialized Runner` creates `tasks/.kanban`, the default workflow folders, a default `tasks/template.md`, and a local `runner.py` script beside `tasks`.
- `AI Kanban: Initialize Runner` adds or refreshes runner support for an existing board by copying the bundled `runner.py` to the runner root. For `tasks/.kanban`, that means beside `tasks`; for a root `.kanban`, that means beside `.kanban`.
- `AI Kanban: Initialize Template` creates the default `template.md` beside the selected board `.kanban` file, or opens the existing non-empty template.
- Runner initialization also creates `template.md` beside `.kanban` plus `projects.md`, `context.md`, and `knowledge/README.md` when those files are missing or empty. New boards start with `blank = https://github.com/flcl42/blank.git` in `projects.md`.

You can also create a `.kanban` file manually and open it in VS Code. If a `template.md` file exists beside `.kanban`, new tickets use it as the card template.

## Use The Board

Each card is a Markdown file. The first `# Heading` becomes the card title. Plain `Key: Value` lines under the title become task properties in the details panel.

Useful board actions:

- Press `Ctrl+F` or `Cmd+F` in the board to search cards by title, body, tags, file name, and properties.
- Drag cards between columns or within a column to reorder them.
- Double-click a column title to rename its display title in `.kanban`.
- Use the bump button on a card to move it to the top of its column.
- Use property actions in the details panel to open local paths, URLs, repositories, or VS Code windows.

The `.kanban` file is YAML. The optional `folders` section controls column order and display names:

```yaml
folders:
  new: new
  backlog: backlog
  doing: doing
  done: done
  confirmed: confirmed
```

Use `ignoreFolders` when directories beside `.kanban` should not appear as columns
or be scanned for cards:

```yaml
ignoreFolders:
  - archive
  - scratch
```

Use `defaultModels` when a board should choose default models per agent for new
runner sessions:

```yaml
defaultModels:
  codex: codex/gpt-5.6-sol/ultra
  claude: claude/sonnet/max
  kimi: kimi/k2
  deepseek: deepseek/deepseek-v4-pro/max
  opencode: opencode/moonshotai/kimi-k3
```

## Optional Agent Runner

The runner is optional. If you never start it, ai-kanban remains a normal Markdown-and-folder Kanban board.

The runner watches `tasks/backlog`, starts Claude Code, Codex, opencode, Kimi, or DeepSeek through Deep Code on cards, moves active cards to `doing`, and moves completed or blocked work to the matching workflow folders. It keeps running in the background after VS Code closes.

To use it:

1. Run `AI Kanban: Create Board with Initialized Runner`, run `AI Kanban: Initialize Runner`, or open an existing board and click `Initialize runner` in the warning panel.
2. Install the required tools if the panel reports them missing.
3. Click `Start runner` in the board warning panel.

Runner prerequisites:

- Python 3.10+.
- Claude Code, Codex CLI, opencode, Kimi CLI, and/or Deep Code.
- DeepSeek through Deep Code requires `pywinpty` in the Python environment used by the runner.

Use `kanban.defaultAgent` to choose `auto`, `claude`, `codex`, `opencode`, `oc`, `kimi`, `deepseek`, or `manual`. Use `auto` to auto-detect Claude first, then Codex, then opencode, then Kimi, then DeepSeek. Use `manual` when new backlog cards should be user-managed unless they explicitly request an agent. Use `kanban.claudeExecutable`, `kanban.codexExecutable`, `kanban.opencodeExecutable`, `kanban.kimiExecutable`, or `kanban.deepseekExecutable` if an executable has a different name or path. You can hide runner warnings from the panel if you want a board-only workflow. The setting is `kanban.runnerPanel.enabled`.

## Runner Task Format

Runner cards use normal Markdown plus a few properties:

```md
# Example task

Project: blank
Tags:
Model: codex/gpt-5.6-sol/ultra
Agent:
Repo:

## Description
Describe the work here.

## Comments
```

`Project:` can name a repository alias from `projects.md`. New runner boards seed `blank = https://github.com/flcl42/blank.git`, so `Project: blank` uses that starter repository. If `Project:` is missing or empty, the runner writes `Project: blank` when starting the task. Use `Project: -` when the task should use a temporary empty workspace instead of a repository.

`Tags:` can override the runner agent per card with values such as `claude`, `codex`, `opencode`, `oc`, `kimi`, `deepseek`, `ds`, `deepcode`, `agent:claude`, `agent:codex`, `agent:opencode`, `agent:oc`, `agent:kimi`, or `agent:deepseek`. Use `manual` or `human` to mark a card as user-managed; the runner leaves those cards in backlog and does not assign an agent.

`Model:` can choose the initial agent model for a new session. Use `agent/model` or `agent/model/effort`, for example `Model: codex/gpt-5.6-luna/max`, `Model: opencode/moonshotai/kimi-k3/minimal`, `Model: opencode/opencode-go/glm-5.3`, or `Model: deepseek/deepseek-v4-pro/max`. Codex maps effort to `model_reasoning_effort`, Claude maps effort to `--effort`, opencode maps effort to `--variant`, DeepSeek maps model and `high` or `max` effort to Deep Code environment settings, and Kimi supports `agent/model` only. Supported Codex and Claude effort values are `ultra`, `max`, `xhigh`, `high`, `medium`, and `low`; opencode variants include `max`, `high`, `medium`, `low`, and `minimal`; Deep Code supports `max` and `high`. If `Model:` is empty, `.kanban` `defaultModels` applies for that board; if the board has no default for that agent, VS Code `kanban.defaultModels` applies; if neither is set, the agent CLI uses its own default. Markdown task files offer completions on `Model:` lines for these formats, values from `kanban.modelCompletions`, and configured defaults, but custom model names are still allowed. Existing sessions keep using `Agent:` and ignore `Model:` changes until you clear `Agent:`.

`Agent:` and `Repo:` are managed by the runner. `Agent:` stores the session id and `Repo:` stores the working-copy path. The runner infers Codex, Claude, opencode, Kimi, or DeepSeek from the session id format and session files when resuming existing sessions, so new cards do not need an `Agent Kind:` line. Clear `Agent:` if you intentionally want a card to start a fresh session with a different agent.

The details pane shows recent agent output for Codex, Claude, opencode, Kimi, or DeepSeek sessions. `Connect` opens the matching CLI: Codex sessions use `codex resume`, Claude sessions use `claude --resume`, opencode sessions use `opencode --session --auto`, Kimi sessions use `kimi --session`, and DeepSeek sessions use `deepcode --resume`.

## Settings

- `kanban.detailsPaneWidth` controls the saved details pane width.
- `kanban.defaultAgent` controls the default runner agent. Defaults to `auto`, which auto-detects Claude first, Codex second, opencode third, Kimi fourth, and DeepSeek fifth. Set it to `manual` to treat unassigned backlog cards as user-managed by default.
- `kanban.defaultModels` controls default model values per agent when a new runner task has no `Model:` value. Board `.kanban` `defaultModels` override this setting per board.
- `kanban.modelCompletions` controls the model values suggested on `Model:` lines. It can be set globally or per workspace.
- `kanban.claudeExecutable` controls the Claude Code executable used by the runner and Claude resume-agent terminals. Defaults to `claude`.
- `kanban.codexExecutable` controls the Codex executable used by the runner and Codex resume-agent terminals. Defaults to `codex`.
- `kanban.opencodeExecutable` controls the opencode executable used by the runner and opencode resume-agent terminals. Defaults to `opencode`.
- `kanban.kimiExecutable` controls the Kimi CLI executable used by the runner and Kimi resume-agent terminals. Defaults to `kimi`.
- `kanban.deepseekExecutable` controls the Deep Code executable used by the runner and DeepSeek resume-agent terminals. Defaults to `deepcode`.
- `kanban.runnerPanel.enabled` shows or hides the optional runner warning panel.
- `kanban.runner.command` controls the command used to start the runner.
- `kanban.runner.args` controls runner startup arguments and supports `${runnerScript}`, `${runnerRoot}`, `${kanbanDir}`, `${workspaceFolder}`, `${defaultAgent}`, `${codexExecutable}`, `${claudeExecutable}`, `${opencodeExecutable}`, `${kimiExecutable}`, and `${deepseekExecutable}`.

## Development

Install dependencies and build:

```powershell
npm install
npm run compile
```

Package a VSIX:

```powershell
npm run package:vsix
```
