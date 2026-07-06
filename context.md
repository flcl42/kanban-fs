# Project Agent Context

This context is specific to the `D:\apps\kanban.vsix` project.

## Upgrade And Release Requests

When the user asks to upgrade this VS Code extension, release a new version, or publish an update, complete the full project release workflow:

- Increment the extension version first.
- Include all relevant pending project changes in the commit; do not leave local-only changes behind unless the user explicitly excludes them.
- Run the test/package workflow.
- Install the generated VSIX locally with `code --install-extension .\kanban-vsix-<version>.vsix --force`.
- Push the commit to the remote branch.
- Trigger the GitHub Actions `Publish VS Code Extension` workflow (`.github/workflows/publish-vscode-marketplace.yml`) with `dry_run=false`, unless the user explicitly asks for a dry run.
- Verify and report the resulting version, local install status, pushed commit, and release workflow run.
