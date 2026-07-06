# runner.py

`runner.py` watches an ai-kanban board under `tasks/`, starts up to 5 AI agents for cards in `tasks/backlog/`, and moves cards across `doing`, `blocked`, `done`, and `confirmed`.

The runner bootstraps a missing board root on startup. If needed, it creates `.gitignore`, `tasks/`, `projects/`, `cache/`, `trash/`, `logs/`, `projects.md`, `context.md`, `tasks/.kanban`, and `tasks/template.md`, plus the initial task folders in this order: `new`, `backlog`, `doing`, `done`, `confirmed`. The `blocked` folder is created on demand when a task blocks. When `.gitignore`, `context.md`, or `tasks/template.md` already exist in the launch board, their current contents are used as the seed for the new root.

Agents are expected to read both `README.md` and `context.md` before they begin work on a task.

## Board Layout

The runner supports a root board when `.kanban` is in the root:

```text
.
├─ .kanban
├─ runner.py
├─ backlog/
├─ doing/
├─ done/
├─ confirmed/
├─ projects/
├─ cache/
├─ trash/
└─ logs/
```

It also supports the nested runner layout:

```text
.
├─ .gitignore
├─ runner.py
├─ context.md
├─ projects.md
├─ projects/
├─ cache/
├─ trash/
├─ logs/
└─ tasks/
   ├─ .kanban
   ├─ template.md
   ├─ new/
   ├─ backlog/
   ├─ doing/
   ├─ done/
   └─ confirmed/
```

`new/` is a staging column for cards that are not ready to run yet. `runner.py` starts work from `backlog/` in root-board mode or `tasks/backlog/` in nested mode.

## Task Format

Each task is a Markdown file. `runner.py` manages `Agent:` and `Repo:`; keep them present even if blank.

```md
# Title

Tags: claude
Project: nm
Agent:
Repo:

## Description
Short description of the work.

## Comments

### Report
```

Behavior:

- `Project:` picks the repo alias from `projects.md`. Use `Project: blank` or `Project: -` for an empty workspace that is moved to `trash/` when the task is done.
- `Tags:` can select an agent per card. Supported markers include `claude`, `codex`, `agent:claude`, and `agent:codex`.
- `Agent:` stores the agent session id so a task can resume later.
- `Repo:` stores the repo working-copy path or cache path.
- `## Comments` is for open questions, blockers, and missing context.
- `### Report` is for completion notes, handoff details, or a short summary of what changed.

## Running

Requirements:

- Python 3.10+.
- Claude Code and/or Codex CLI.

Auto mode prefers Claude Code when `claude` is available, then falls back to Codex when `codex` is available.

```powershell
python runner.py --root D:\board
python runner.py --root D:\board --default-agent claude
python runner.py --root D:\board --default-agent codex
python runner.py --root D:\board --claude-executable claude
python runner.py --root D:\board --codex-executable codex
python runner.py --root D:\board --max-agents 5
python runner.py --root D:\board --poll-seconds 10
python runner.py --root D:\board --once
```

Options:

- `--root <path>`: board root. Defaults to the current directory.
- `--max-agents <n>`: global active-agent limit. Default `5`.
- `--poll-seconds <n>`: full reconciliation interval. Default `10`.
- `--default-agent <agent>`: `claude`, `codex`, `null`, or `auto`. Default is auto.
- `--claude-executable <cmd>`: Claude Code executable name or path. Default `claude`.
- `--codex-executable <cmd>`: Codex executable name or path. Default `codex`.
- `--codex-mode Dangerous|FullAuto`: permission mode used for Codex and mapped to the closest Claude permission mode.
- `--once`: run one reconciliation pass and exit.

While running continuously, the runner exposes a localhost status endpoint on a deterministic port sequence derived from the board root. The VS Code Kanban view probes that endpoint and validates the normalized root path.

## Logging

Runtime logs are written to:

```text
logs/runner.log
```

## Notes

- `runner.py` does not let agents move cards directly; it moves cards based on agent outcome.
- The agent prompt tells agents to follow `context.md`, keep task comments current, merge resolved Q&A back into `## Description`, and finish with `ORCHESTRATOR_STATUS: BLOCKED` or `ORCHESTRATOR_STATUS: DONE`.
- Repo reuse is per project alias. Repos referenced only by `confirmed` tasks can move into `cache/<alias>/`, and unreferenced repos can be parked in `trash/<alias>/`.
