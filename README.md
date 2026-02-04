# Kanban-fs (VS Code Extension)

Kanban-fs is a VS Code extension that turns a `.kanban` file into a live Kanban board. Columns are sibling directories, and cards are Markdown files. The first `# H1` becomes the card title, creation time is shown, and details render in the right panel.

## Run (Dev)

1. Install deps: `npm install`
2. Build: `npm run compile`
3. Debug: run the launch config `Run Extension (Example)` in `.vscode/launch.json`
4. In the Extension Development Host, open a folder containing a `.kanban` file (see `example/`).

## Build a VSIX

1. Install the VS Code extension packaging tool: `npm install -g @vscode/vsce`
2. Build: `npm run compile`
3. Package: `vsce package`

The `.vsix` file will be created in the project root.

## Contributing / Feature Requests

Feature requests and contributions are welcome, but please keep as much configuration and state as possible in ticket Markdown files. The `.kanban` file should remain a lightweight trigger file. Use `.kanban` for parameters only when absolutely necessary, for example:

- Fixed color for a label
- Mapping a directory name to a friendly column name
- Other board-level settings that cannot live in card Markdown

If you propose a feature that needs configuration, prefer putting it in the card Markdown first and only introduce `.kanban` parameters when there is no reasonable alternative.
