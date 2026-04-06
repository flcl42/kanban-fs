# Kanban-fs (VS Code Extension)

[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/flcl42.kanban-vsix)](https://marketplace.visualstudio.com/items?itemName=flcl42.kanban-vsix)

Kanban-fs is a VS Code extension that turns a `.kanban` file into a live Kanban board. Columns are sibling directories, cards are Markdown files, the first `# H1` becomes the card title, and the details panel renders task metadata plus the Markdown body.

If `template.md` exists beside the board's `.kanban` file, `+ Add ticket` seeds new card files with that template content.

Press `Ctrl+F` (or `Cmd+F` on macOS) in the board view to filter cards by title, body text, tags, file name, and task properties.

`.kanban` is a YAML file. The optional `folders` section controls column titles and column order:

```yaml
folders:
  Doing: In Progress
  Backlog: Backlog
  Done: Done!
```

Legacy `folder.md` files are still read as a fallback, but new boards should keep column metadata in `.kanban`.

## Run (Dev)

1. Install deps: `npm install`
2. Build: `npm run compile`
3. Debug: run the launch config `Run Extension (Example)` in `.vscode/launch.json`
4. In the Extension Development Host, open a folder containing a `.kanban` file.

## Build a VSIX

1. Install deps: `npm install`
2. Package: `npm run package:vsix`,  the `.vsix` file will be created in the project root.
3. Install locally: `code --install-extension .\kanban-vsix-<version>.vsix`

## Contributing / Feature Requests

Feature requests and contributions are welcome, but please keep as much configuration and state as possible in ticket Markdown files. Use `.kanban` for board-level settings that cannot live in a task file, for example:

- Fixed color for a tag
- Mapping a directory name to a friendly column name
- Other board-level settings that cannot live in card Markdown

If you propose a feature that needs configuration, prefer putting it in the card Markdown first and only introduce `.kanban` parameters when there is no reasonable alternative.

Task properties are plain `Key: Value` lines directly under the title block. Special handling:

- `Agent: <guid>` shows a `Connect` action that runs `codex resume <guid>` in a terminal.
- Absolute local paths show an `Open` action that opens a terminal in that folder (or the file's parent folder).
