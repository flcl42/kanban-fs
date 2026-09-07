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
Model: codex/gpt-5.6-sol/ultra
Agent:
Repo:

## Description
Short description of the work.

## Comments

### Report
```

Behavior:

- `Project:` picks the repo alias from `projects.md`. Use `Project: blank` or `Project: -` for an empty workspace that is moved to `trash/` when the task is done.
- `Tags:` can select an agent per card. Supported markers include `claude`, `codex`, `opencode`, `oc`, `kimi`, `deepseek`, `ds`, `deepcode`, `agent:claude`, `agent:codex`, `agent:opencode`, `agent:oc`, `agent:kimi`, and `agent:deepseek`. Use `manual` or `human` for user-managed cards that the runner should leave in backlog without assigning an agent.
- `Model:` can choose the initial model for a new session. Use `agent/model` or `agent/model/effort`, for example `Model: codex/gpt-5.6-luna/max`, `Model: opencode/moonshotai/kimi-k3/minimal`, `Model: opencode/opencode-go/glm-5.3`, or `Model: deepseek/deepseek-v4-pro/max`. Codex maps effort to `model_reasoning_effort`, Claude maps effort to `--effort`, opencode maps effort to `--variant`, DeepSeek maps model and `high` or `max` effort to Deep Code environment settings, and Kimi supports `agent/model` only. Supported Codex and Claude effort values are `ultra`, `max`, `xhigh`, `high`, `medium`, and `low`; opencode variants include `max`, `high`, `medium`, `low`, and `minimal`; Deep Code supports `max` and `high`. If `Model:` is empty, `.kanban` `defaultModels` applies for that board; if the board has no default for that agent, VS Code `kanban.defaultModels` applies; if neither is set, the agent CLI uses its own default. The VS Code extension offers completions on `Model:` lines for these formats, configured defaults, and values from `kanban.modelCompletions`, while still accepting custom model names.
- `Agent:` stores the agent session id so a task can resume later.
- `Agent Kind:` is tolerated for older cards. New cards can rely on the `Agent:` id format and local session files: Codex uses UUIDv7-style ids, Claude uses UUIDv4-style ids, opencode uses `ses_...` ids, Kimi uses `session_<uuid>` ids, and Deep Code stores UUID session files under `.deepcode`. Clear `Agent:` if you intentionally want a card to start a fresh session with a different agent.
- `Repo:` stores the repo working-copy path or cache path.
- `## Comments` is for open questions, blockers, and missing context.
- `### Report` is for completion notes, handoff details, or a short summary of what changed.

Board defaults live in `.kanban`:

```yaml
defaultModels:
  codex: codex/gpt-5.6-sol/ultra
  claude: claude/sonnet/max
  kimi: kimi/k2
  deepseek: deepseek/deepseek-v4-pro/max
  opencode: opencode/moonshotai/kimi-k3
```

## Running

Requirements:

- Python 3.10+.
- Claude Code, Codex CLI, opencode, Kimi CLI, and/or Deep Code.
- DeepSeek through Deep Code requires `pywinpty` in the Python environment used by the runner.

Auto mode prefers Claude Code when `claude` is available, then falls back to Codex when `codex` is available, then falls back to opencode when `opencode` is available, then falls back to Kimi when `kimi` is available, then falls back to Deep Code when `deepcode` is available.

The VS Code board details pane can display recent output for Claude, Codex, opencode, Kimi, and DeepSeek sessions. Connect-agent terminals use `claude --resume <session>` for Claude cards, `codex resume <session>` for Codex cards, `opencode --session <session> --auto` for opencode cards, `kimi --session <session>` for Kimi cards, and `deepcode --resume <session>` for DeepSeek cards.

```powershell
python runner.py --root D:\board
python runner.py --root D:\board --default-agent claude
python runner.py --root D:\board --default-agent codex
python runner.py --root D:\board --default-agent opencode
python runner.py --root D:\board --default-agent oc
python runner.py --root D:\board --default-agent kimi
python runner.py --root D:\board --default-agent deepseek
python runner.py --root D:\board --default-agent manual
python runner.py --root D:\board --claude-executable claude
python runner.py --root D:\board --codex-executable codex
python runner.py --root D:\board --opencode-executable opencode
python runner.py --root D:\board --kimi-executable kimi
python runner.py --root D:\board --deepseek-executable deepcode
python runner.py --root D:\board --max-agents 5
python runner.py --root D:\board --poll-seconds 10
python runner.py --root D:\board --once
```

Options:

- `--root <path>`: board root. Defaults to the current directory.
- `--max-agents <n>`: global active-agent limit. Default `5`.
- `--poll-seconds <n>`: full reconciliation interval. Default `10`.
- `--default-agent <agent>`: `auto`, `claude`, `codex`, `opencode`, `oc`, `kimi`, `deepseek`, or `manual`. Default is auto. `manual` leaves cards without an explicit agent tag, session, or agent-prefixed `Model:` user-managed in backlog.
- `--claude-executable <cmd>`: Claude Code executable name or path. Default `claude`.
- `--codex-executable <cmd>`: Codex executable name or path. Default `codex`.
- `--opencode-executable <cmd>`: opencode executable name or path. Default `opencode`.
- `--kimi-executable <cmd>`: Kimi CLI executable name or path. Default `kimi`.
- `--deepseek-executable <cmd>`: Deep Code executable name or path. Default `deepcode`.
- `--codex-mode Dangerous|FullAuto`: permission mode used for Codex and mapped to the closest Claude and opencode permission modes. Kimi and Deep Code prompt mode do not accept `--yolo` or `--auto`, so this option is not passed to them.
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
