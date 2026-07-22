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
- `AI Kanban: Initialize Runner` adds runner support to an existing board by copying the bundled `runner.py` to the runner root. For `tasks/.kanban`, that means beside `tasks`; for a root `.kanban`, that means beside `.kanban`.
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

## Optional Agent Runner

The runner is optional. If you never start it, ai-kanban remains a normal Markdown-and-folder Kanban board.

The runner watches `tasks/backlog`, starts Claude Code, Codex, or Kimi on cards, moves active cards to `doing`, and moves completed or blocked work to the matching workflow folders. It keeps running in the background after VS Code closes.

To use it:

1. Run `AI Kanban: Create Board with Initialized Runner`, run `AI Kanban: Initialize Runner`, or open an existing board and click `Initialize runner` in the warning panel.
2. Install the required tools if the panel reports them missing.
3. Click `Start runner` in the board warning panel.

Runner prerequisites:

- Python 3.10+.
- Claude Code, Codex CLI, and/or Kimi CLI.

Use `kanban.defaultAgent` to choose `claude`, `codex`, or `kimi`. Leave it `null` to auto-detect Claude first, then Codex, then Kimi. Use `kanban.claudeExecutable`, `kanban.codexExecutable`, or `kanban.kimiExecutable` if an executable has a different name or path. You can hide runner warnings from the panel if you want a board-only workflow. The setting is `kanban.runnerPanel.enabled`.

## Runner Task Format

Runner cards use normal Markdown plus a few properties:

```md
# Example task

Project: blank
Tags:
Model: codex/gpt-5.6-terra/max
Agent:
Repo:

## Description
Describe the work here.

## Comments
```

`Project:` can name a repository alias from `projects.md`. New runner boards seed `blank = https://github.com/flcl42/blank.git`, so `Project: blank` uses that starter repository. If `Project:` is missing or empty, the runner writes `Project: blank` when starting the task. Use `Project: -` when the task should use a temporary empty workspace instead of a repository.

`Tags:` can override the runner agent per card with values such as `claude`, `codex`, `kimi`, `agent:claude`, `agent:codex`, or `agent:kimi`.

`Model:` can choose the initial agent model for a new session. Use `agent/model` or `agent/model/effort`, for example `Model: codex/gpt-5.6-terra/max`. Codex maps effort to `model_reasoning_effort`, Claude maps effort to `--effort`, and Kimi supports `agent/model` only. Existing sessions keep using `Agent:` and ignore `Model:` changes until you clear `Agent:`.

`Agent:` and `Repo:` are managed by the runner. `Agent:` stores the session id and `Repo:` stores the working-copy path. The runner infers Codex, Claude, or Kimi from the session id format when resuming existing sessions, so new cards do not need an `Agent Kind:` line. Clear `Agent:` if you intentionally want a card to start a fresh session with a different agent.

The details pane shows recent agent output for Codex, Claude, or Kimi sessions. `Connect` opens the matching CLI: Codex sessions use `codex resume`, Claude sessions use `claude --resume`, and Kimi sessions use `kimi --session`.

## Settings

- `kanban.detailsPaneWidth` controls the saved details pane width.
- `kanban.defaultAgent` controls the default runner agent. Defaults to `null`, which auto-detects Claude first, Codex second, and Kimi third.
- `kanban.claudeExecutable` controls the Claude Code executable used by the runner and Claude resume-agent terminals. Defaults to `claude`.
- `kanban.codexExecutable` controls the Codex executable used by the runner and Codex resume-agent terminals. Defaults to `codex`.
- `kanban.kimiExecutable` controls the Kimi CLI executable used by the runner and Kimi resume-agent terminals. Defaults to `kimi`.
- `kanban.runnerPanel.enabled` shows or hides the optional runner warning panel.
- `kanban.runner.command` controls the command used to start the runner.
- `kanban.runner.args` controls runner startup arguments and supports `${runnerScript}`, `${runnerRoot}`, `${kanbanDir}`, `${workspaceFolder}`, `${defaultAgent}`, `${codexExecutable}`, `${claudeExecutable}`, and `${kimiExecutable}`.

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
