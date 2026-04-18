# codex_runner

`codex_runner.csx` watches a `kanban-fs`-style board under `tasks/`, starts up to 5 Codex agents for cards in `tasks/backlog/`, and moves cards across `doing`, `blocked`, `done`, and `confirmed`.

The runner bootstraps a missing board root on startup. If needed, it creates `.gitignore`, `tasks/`, `projects/`, `cache/`, `trash/`, `logs/`, `projects.md`, `context.md`, `tasks/.kanban`, and `tasks/template.md`, plus the task folders in this order: `new`, `backlog`, `doing`, `blocked`, `done`, `confirmed`. When `.gitignore`, `context.md`, or `tasks/template.md` already exist in the launch board, their current contents are used as the seed for the new root.

The script now runs on Windows, Linux, and macOS. Windows keeps clickable toast notifications, Linux uses `notify-send` when available, macOS uses `osascript`, and unsupported environments fall back to the log.

Agents are expected to read both `README.md` and `context.md` before they begin work on a task.

## Board layout

The runner expects this root layout:

```text
.
├─ .gitignore
├─ codex_runner.csx
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
   ├─ blocked/
   ├─ done/
   └─ confirmed/
```

`new/` is a staging column for cards that are not ready to run yet. `codex_runner` only starts work from `tasks/backlog/`.

## `projects.md`

One alias per line:

```md
nm = https://github.com/NethermindEth/nethermind
roslyn = https://github.com/dotnet/roslyn
```

Blank lines and lines starting with `#` are ignored.

## Task format

Each task is a Markdown file. `codex_runner` manages `Agent:` and `Repo:`; keep them present even if blank.

```md
# Title

Project: nm
Agent:
Repo:

## Description
Short description of the work.

## Comments

### Report
```

Behavior:

- `Project:` picks the repo alias from `projects.md`.
- `Agent:` stores the Codex session id so a task can resume later.
- `Repo:` stores the repo working-copy path or cache path.
- `## Comments` is for open questions, blockers, and missing context.
- Each non-empty line in `## Comments` should start with `> `.
- Separate unrelated comment topics with a line that is exactly `===`.
- `### Report` is for completion notes, handoff details, or a short summary of what changed.

## Lifecycle

1. Cards in `tasks/backlog/` are picked in filename order.
2. `codex_runner` moves the card to `tasks/doing/`.
3. It clones or reuses a repo under `projects/`, writes the path to `Repo:`, and starts or resumes Codex.
4. Codex reads `README.md`, `context.md`, and the task file before doing work.
5. If Codex blocks, it updates `## Comments`; `codex_runner` moves the card to `tasks/blocked/` and raises a notification.
6. When you answer questions, move the card back to `tasks/backlog/`. The same Codex session resumes.
7. If Codex finishes, `codex_runner` moves the card to `tasks/done/` and raises a completion notification.
8. If you want follow-up work on a done card, add text under `## Comments`; `codex_runner` requeues it automatically.
9. A repo sweep runs roughly every 5 minutes. Repos tied only to `confirmed` tasks move from `projects/` to `cache/`. Repos still referenced by `done` tasks stay in `projects/`. Unreferenced and inactive repos move to `trash/`.
10. When a cached repo is needed again, `codex_runner` restores it into `projects/`.

## Running

With `dotnet-script` installed, the portable command is:

```powershell
dotnet script codex_runner.csx --
```

On Linux or macOS you can also run it directly after making it executable:

```bash
chmod +x codex_runner.csx
./codex_runner.csx
```

Useful options:

```powershell
dotnet script codex_runner.csx -- --root D:\board
dotnet script codex_runner.csx -- --max-agents 5
dotnet script codex_runner.csx -- --poll-seconds 10
dotnet script codex_runner.csx -- --codex-mode Dangerous
dotnet script codex_runner.csx -- --codex-mode FullAuto
dotnet script codex_runner.csx -- --once
```

Options:

- `--root <path>`: board root. Defaults to the current directory.
- `--max-agents <n>`: global active-agent limit. Default `5`.
- `--poll-seconds <n>`: full reconciliation interval. Default `10`.
- `--codex-mode Dangerous|FullAuto`: how Codex runs tasks.
- `--once`: run one reconciliation pass and exit.

While running continuously, the runner writes `tasks/.kanban.runner.json` every few seconds. The VS Code Kanban view uses that heartbeat, not the runner process name or script location, to decide whether the board already has an active runner.

## Codex mode

`Dangerous` is the default because autonomous task agents usually need to edit files and run repo commands without stopping for approval. That maps to:

```text
codex exec --dangerously-bypass-approvals-and-sandbox
```

If you want safer but less autonomous behavior, use `--codex-mode FullAuto`.

## Logging

Runtime logs are written to:

```text
logs/codex_runner.log
```

## Notes

- `codex_runner` does not let agents move cards directly; it moves cards based on Codex outcome.
- The agent prompt tells Codex to follow `context.md`, keep task comments current, merge resolved Q&A back into `## Description`, and finish with `ORCHESTRATOR_STATUS: BLOCKED` or `ORCHESTRATOR_STATUS: DONE`.
- Repo reuse is per project alias. Repos referenced only by `confirmed` tasks can move into `cache/<alias>/`, and unreferenced repos can be parked in `trash/<alias>/`.
