#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import datetime as dt
import enum
import hashlib
import json
import ntpath
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Literal, Sequence
from urllib.parse import quote


IS_WINDOWS = os.name == "nt"
ENCODING = "utf-8"
REPOSITORY_SWEEP_INTERVAL_SECONDS = 5 * 60
GIT_COMMAND_TIMEOUT_SECONDS = 120
MODEL_EFFORT_LEVELS = {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
MANUAL_AGENT_VALUE: Literal["manual"] = "manual"


class ShutdownRequested(RuntimeError):
    pass


class TaskStep(enum.Enum):
    BACKLOG = "backlog"
    DOING = "doing"
    BLOCKED = "blocked"
    DONE = "done"
    CONFIRMED = "confirmed"


class AgentKind(enum.Enum):
    CLAUDE = "claude"
    CODEX = "codex"
    KIMI = "kimi"
    DEEPSEEK = "deepseek"
    OPENCODE = "opencode"


DefaultAgentSelection = AgentKind | Literal["manual"] | None


class CodexMode(enum.Enum):
    DANGEROUS = "dangerous"
    FULL_AUTO = "fullauto"


class AgentRunMode(enum.Enum):
    NEW = "new"
    RESUME = "resume"


class AgentOutcome(enum.Enum):
    UNKNOWN = "unknown"
    BLOCKED = "blocked"
    DONE = "done"


@dataclass(frozen=True)
class KanbanFolder:
    name: str
    path: str


@dataclass(frozen=True)
class ActiveAgent:
    task_path: str
    repo_path: str
    agent_id: str
    agent_kind: AgentKind


@dataclass(frozen=True)
class ProjectAssignment:
    workspace_alias: str
    repo_url: str | None
    uses_blank_workspace: bool

    @staticmethod
    def blank() -> "ProjectAssignment":
        return ProjectAssignment(ProjectAliases.BLANK_WORKSPACE_ALIAS, None, True)

    @staticmethod
    def repository(alias: str, repo_url: str) -> "ProjectAssignment":
        return ProjectAssignment(alias, repo_url, False)


@dataclass(frozen=True)
class TaskRepositoryReference:
    task_path: str
    project_alias: str | None
    repo_path: str
    is_confirmed: bool
    managed_card: "TaskCard | None"


@dataclass(frozen=True)
class AgentRunResult:
    exit_code: int
    session_id: str
    final_agent_message: str
    stdout_lines: list[str]
    stderr_lines: list[str]


@dataclass(frozen=True)
class ModelSpec:
    raw: str
    agent_kind: AgentKind | None
    model: str
    effort: str | None


@dataclass(frozen=True)
class OrchestratorSettings:
    root_path: str
    invocation_directory: str
    max_agents: int
    poll_interval_seconds: int
    run_once: bool
    codex_mode: CodexMode
    default_agent: DefaultAgentSelection
    default_models: dict[AgentKind, ModelSpec]
    codex_executable: str
    claude_executable: str
    kimi_executable: str
    deepseek_executable: str
    opencode_executable: str

    @staticmethod
    def parse(argv: Sequence[str], default_root: str) -> "OrchestratorSettings":
        parser = argparse.ArgumentParser(
            prog="runner.py",
            description="Run AI agents for an ai-kanban board.",
        )
        parser.add_argument("--root", default=default_root)
        parser.add_argument("--max-agents", type=int, default=5)
        parser.add_argument("--poll-seconds", type=int, default=10)
        parser.add_argument("--once", action="store_true")
        parser.add_argument(
            "--codex-mode",
            default="Dangerous",
            choices=["Dangerous", "FullAuto", "dangerous", "fullauto"],
        )
        parser.add_argument(
            "--default-agent",
            default=None,
            help="Default agent kind: auto, claude, codex, opencode, kimi, deepseek, or manual.",
        )
        parser.add_argument("--codex-executable", default=None)
        parser.add_argument("--claude-executable", default=None)
        parser.add_argument("--kimi-executable", default=None)
        parser.add_argument("--deepseek-executable", default=None)
        parser.add_argument("--opencode-executable", default=None)
        args = parser.parse_args(argv)

        if args.max_agents < 1:
            raise ValueError("Max agents must be at least 1.")
        if args.poll_seconds < 1:
            raise ValueError("Poll interval must be at least 1 second.")

        root_path = os.path.abspath(args.root)
        invocation_directory = os.path.abspath(default_root)
        vscode_settings = load_vscode_kanban_settings(root_path, invocation_directory)
        default_agent_value = args.default_agent
        if default_agent_value is None:
            default_agent_value = settings_string(vscode_settings, "kanban.defaultAgent")
        codex_executable = (
            args.codex_executable
            or settings_string(vscode_settings, "kanban.codexExecutable")
            or "codex"
        )
        claude_executable = (
            args.claude_executable
            or settings_string(vscode_settings, "kanban.claudeExecutable")
            or "claude"
        )
        kimi_executable = (
            args.kimi_executable
            or settings_string(vscode_settings, "kanban.kimiExecutable")
            or "kimi"
        )
        deepseek_executable = (
            args.deepseek_executable
            or settings_string(vscode_settings, "kanban.deepseekExecutable")
            or "deepcode"
        )
        opencode_executable = (
            args.opencode_executable
            or settings_string(vscode_settings, "kanban.opencodeExecutable")
            or "opencode"
        )
        default_models = parse_default_model_settings(
            settings_object(vscode_settings, "kanban.defaultModels"),
            "kanban.defaultModels",
        )
        default_models.update(read_board_default_models(root_path))

        return OrchestratorSettings(
            root_path=root_path,
            invocation_directory=invocation_directory,
            max_agents=args.max_agents,
            poll_interval_seconds=args.poll_seconds,
            run_once=bool(args.once),
            codex_mode=parse_codex_mode(args.codex_mode),
            default_agent=parse_default_agent(default_agent_value),
            default_models=default_models,
            codex_executable=codex_executable.strip() or "codex",
            claude_executable=claude_executable.strip() or "claude",
            kimi_executable=kimi_executable.strip() or "kimi",
            deepseek_executable=deepseek_executable.strip() or "deepcode",
            opencode_executable=opencode_executable.strip() or "opencode",
        )


def load_vscode_kanban_settings(root_path: str, invocation_directory: str) -> dict[str, object]:
    merged: dict[str, object] = {}
    for settings_path in vscode_settings_paths(root_path, invocation_directory):
        data = read_jsonc_object(settings_path)
        if not data:
            continue
        for key in [
            "kanban.defaultAgent",
            "kanban.defaultModels",
            "kanban.codexExecutable",
            "kanban.claudeExecutable",
            "kanban.kimiExecutable",
            "kanban.deepseekExecutable",
            "kanban.opencodeExecutable",
        ]:
            if key in data:
                merged[key] = data[key]
    return merged


def vscode_settings_paths(root_path: str, invocation_directory: str) -> list[str]:
    candidates: list[str] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        for product in ["Code", "Code - Insiders", "VSCodium"]:
            candidates.append(os.path.join(appdata, product, "User", "settings.json"))
    for folder in [invocation_directory, root_path]:
        candidates.append(os.path.join(folder, ".vscode", "settings.json"))

    result: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = normalize_path(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(candidate)
    return result


def read_jsonc_object(path: str) -> dict[str, object] | None:
    try:
        with open(path, "r", encoding=ENCODING) as handle:
            text = handle.read()
    except OSError:
        return None
    try:
        data = json.loads(remove_json_trailing_commas(strip_jsonc_comments(text)))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def strip_jsonc_comments(text: str) -> str:
    result: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            result.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < len(text):
            next_char = text[index + 1]
            if next_char == "/":
                result.extend("  ")
                index += 2
                while index < len(text) and text[index] not in "\r\n":
                    result.append(" ")
                    index += 1
                continue
            if next_char == "*":
                result.extend("  ")
                index += 2
                while index + 1 < len(text) and not (
                    text[index] == "*" and text[index + 1] == "/"
                ):
                    result.append(text[index] if text[index] in "\r\n" else " ")
                    index += 1
                if index + 1 < len(text):
                    result.extend("  ")
                    index += 2
                continue
        result.append(char)
        index += 1
    return "".join(result)


def remove_json_trailing_commas(text: str) -> str:
    result: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            result.append(char)
            index += 1
            continue
        if char == ",":
            lookahead = index + 1
            while lookahead < len(text) and text[lookahead].isspace():
                lookahead += 1
            if lookahead < len(text) and text[lookahead] in "}]":
                index += 1
                continue
        result.append(char)
        index += 1
    return "".join(result)


def settings_string(settings: dict[str, object], key: str) -> str | None:
    value = settings.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped if stripped else None


def settings_object(settings: dict[str, object], key: str) -> dict[str, object] | None:
    value = settings.get(key)
    return value if isinstance(value, dict) else None


class BoardPaths:
    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        root_kanban_marker = os.path.join(self.root, ".kanban")
        nested_tasks_root = os.path.join(self.root, "tasks")
        nested_kanban_marker = os.path.join(nested_tasks_root, ".kanban")
        self.uses_root_board = os.path.exists(root_kanban_marker)
        self.tasks_root = self.root if self.uses_root_board else nested_tasks_root
        self.projects_root = os.path.join(self.root, "projects")
        self.cache_root = os.path.join(self.root, "cache")
        self.trash_root = os.path.join(self.root, "trash")
        self.logs_root = os.path.join(self.root, "logs")
        self.gitignore_path = os.path.join(self.root, ".gitignore")
        self.context_path = os.path.join(self.root, "context.md")
        self.knowledge_root = os.path.join(self.root, "knowledge")
        self.knowledge_readme_path = os.path.join(self.knowledge_root, "README.md")
        self.projects_map_path = os.path.join(self.root, "projects.md")
        self.kanban_marker_path = root_kanban_marker if self.uses_root_board else nested_kanban_marker
        self.task_template_path = os.path.join(self.tasks_root, "template.md")
        self.kanban_folders = [
            KanbanFolder("new", os.path.join(self.tasks_root, "new")),
            KanbanFolder("backlog", os.path.join(self.tasks_root, "backlog")),
            KanbanFolder("doing", os.path.join(self.tasks_root, "doing")),
            KanbanFolder("done", os.path.join(self.tasks_root, "done")),
            KanbanFolder("confirmed", os.path.join(self.tasks_root, "confirmed")),
        ]
        self.step_directories = {
            TaskStep.BACKLOG: os.path.join(self.tasks_root, "backlog"),
            TaskStep.DOING: os.path.join(self.tasks_root, "doing"),
            TaskStep.BLOCKED: os.path.join(self.tasks_root, "blocked"),
            TaskStep.DONE: os.path.join(self.tasks_root, "done"),
            TaskStep.CONFIRMED: os.path.join(self.tasks_root, "confirmed"),
        }
        self.required_directories = [
            self.tasks_root,
            self.projects_root,
            self.cache_root,
            self.trash_root,
            self.logs_root,
            *[folder.path for folder in self.kanban_folders],
        ]


class LogSink:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def info(self, message: str) -> None:
        self._write("INFO", message)

    def warn(self, message: str) -> None:
        self._write("WARN", message)

    def error(self, message: str) -> None:
        self._write("ERROR", message)

    def _write(self, level: str, message: str) -> None:
        timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{timestamp}] {level} {message}"
        with self._lock:
            try:
                print(line, flush=True)
            except UnicodeEncodeError:
                encoding = getattr(sys.stdout, "encoding", None) or ENCODING
                try:
                    sys.stdout.buffer.write(
                        (line + "\n").encode(encoding, errors="replace")
                    )
                    sys.stdout.flush()
                except Exception:
                    pass
            with open(self.path, "a", encoding=ENCODING, newline="") as handle:
                handle.write(line + "\n")


class TaskOrchestrator:
    def __init__(self, settings: OrchestratorSettings) -> None:
        self.settings = settings
        self.paths = BoardPaths(settings.root_path)
        self.log = LogSink(os.path.join(self.paths.logs_root, "runner.log"))
        self.notifications = NotificationService(self.log)
        self.workspace_mover = WorkspaceMoveBridge(self.paths.root, self.log)
        self.active_agents: dict[str, ActiveAgent] = {}
        self.active_agents_lock = threading.Lock()
        self.status_server = RunnerStatusServer(
            self.paths.root, self.paths.tasks_root, self.log, self._active_count
        )
        self.reconcile_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.signal_event = threading.Event()
        self.last_repository_sweep = 0.0
        self.requeued_done_comment_fingerprints: dict[str, str] = {}
        self.agent_resolver = AgentResolver(settings, self.log)
        self.agent_threads: list[threading.Thread] = []

    def run(self) -> None:
        previous_sigint = signal.getsignal(signal.SIGINT)
        signal.signal(signal.SIGINT, self._handle_signal)
        if hasattr(signal, "SIGTERM"):
            previous_sigterm = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGTERM, self._handle_signal)
        else:
            previous_sigterm = None

        try:
            self.ensure_board_scaffold()
            self.notifications.initialize()
            self.log.info(f"Board root: {self.paths.root}")
            self.log.info(f"Codex mode: {self.settings.codex_mode.value}")
            self.log.info(
                f"Default agent: {format_default_agent(self.settings.default_agent)}"
            )
            self.log.info(f"Codex executable: {self.settings.codex_executable}")
            self.log.info(f"Claude executable: {self.settings.claude_executable}")
            self.log.info(f"Kimi executable: {self.settings.kimi_executable}")
            self.log.info(f"DeepSeek executable: {self.settings.deepseek_executable}")
            self.log.info(f"opencode executable: {self.settings.opencode_executable}")
            if self.settings.default_models:
                self.log.info(
            "Default models: "
            + ", ".join(
                f"{kind.value}={model.raw}"
                        for kind, model in sorted(
                            self.settings.default_models.items(),
                            key=lambda item: item[0].value,
                        )
                    )
                )
            self.log.info(f"Max agents: {self.settings.max_agents}")

            if self.settings.run_once:
                self.reconcile()
                self._join_agent_threads()
                return

            if not self.status_server.start():
                return
            self.signal_scan()
            self.log.info("Watching for task and project map changes. Press Ctrl+C to stop.")
            self.scan_loop()
        finally:
            self.status_server.stop()
            signal.signal(signal.SIGINT, previous_sigint)
            if previous_sigterm is not None and hasattr(signal, "SIGTERM"):
                signal.signal(signal.SIGTERM, previous_sigterm)

    def _handle_signal(self, signum: int, _frame: object) -> None:
        self.log.info(f"Shutdown requested by signal {signum}.")
        self.stop_event.set()
        self.signal_scan()

    def scan_loop(self) -> None:
        while not self.stop_event.is_set():
            self.signal_event.wait(self.settings.poll_interval_seconds)
            self.signal_event.clear()
            if self.stop_event.is_set():
                break
            try:
                self.reconcile()
            except Exception as exc:
                self.log.error(f"Unexpected scan loop failure: {exc}")

    def signal_scan(self) -> None:
        self.signal_event.set()

    def reconcile(self) -> None:
        if not self.reconcile_lock.acquire(blocking=False):
            return
        try:
            self.ensure_board_scaffold()
            project_map = ProjectMap.load(self.paths.projects_map_path, self.log)
            self.reactivate_done_cards()
            self.sweep_repositories(self.settings.run_once)

            if self._active_count() >= self.settings.max_agents:
                return

            for task_path in self.enumerate_step_tasks(TaskStep.BACKLOG):
                if self._active_count() >= self.settings.max_agents:
                    break
                if self.stop_event.is_set():
                    break

                card = self.try_load_task_card(task_path, TaskStep.BACKLOG)
                if card is None:
                    continue

                try:
                    if self.agent_resolver.should_manage_manually(card):
                        continue
                except ValueError as exc:
                    self.block_task_for_issue(card, str(exc))
                    continue

                if not card.project_alias.strip():
                    card = card.with_updated_project_alias(
                        ProjectAliases.BLANK_WORKSPACE_ALIAS
                    )
                    self.log.info(
                        f"Defaulted missing Project to `{card.project_alias}` for task: {card.path}"
                    )

                if card.project_alias in project_map:
                    assignment = ProjectAssignment.repository(
                        card.project_alias, project_map[card.project_alias]
                    )
                elif ProjectAliases.is_blank(card.project_alias):
                    assignment = ProjectAssignment.blank()
                else:
                    self.block_task_for_issue(
                        card,
                        f"Unknown project alias `{card.project_alias}` in projects.md. Use an alias from projects.md, or use `Project: -` for an empty workspace.",
                    )
                    continue

                self.start_or_resume_task(card, assignment)
        finally:
            self.reconcile_lock.release()

    def ensure_board_scaffold(self) -> None:
        os.makedirs(self.paths.root, exist_ok=True)
        os.makedirs(self.paths.tasks_root, exist_ok=True)
        os.makedirs(self.paths.knowledge_root, exist_ok=True)
        should_seed_kanban = self.should_seed_kanban_config(self.paths.kanban_marker_path)
        for directory in self.paths.required_directories:
            os.makedirs(directory, exist_ok=True)

        self.ensure_kanban_config(
            self.paths.kanban_marker_path,
            BoardTemplates.create_kanban_config(self.paths.kanban_folders),
            should_seed_kanban,
        )
        self.ensure_file_exists(
            self.paths.gitignore_path,
            BoardTemplates.resolve_gitignore_template(self.settings.invocation_directory),
        )
        self.ensure_file_exists(self.paths.projects_map_path, BoardTemplates.projects_template())
        self.ensure_file_exists(
            self.paths.context_path,
            BoardTemplates.resolve_context_template(self.settings.invocation_directory),
        )
        self.ensure_file_exists(
            self.paths.knowledge_readme_path,
            BoardTemplates.resolve_knowledge_readme_template(self.settings.invocation_directory),
        )
        self.ensure_file_exists(
            self.paths.task_template_path,
            BoardTemplates.resolve_task_template(self.settings.invocation_directory),
        )

    @staticmethod
    def should_seed_kanban_config(path: str) -> bool:
        if not os.path.exists(path):
            return True
        return not read_text(path).lstrip("\ufeff").strip()

    @staticmethod
    def ensure_kanban_config(path: str, content: str, should_seed: bool) -> None:
        if not should_seed and os.path.exists(path):
            return
        write_text(path, content)

    @staticmethod
    def ensure_file_exists(path: str, content: str) -> None:
        if not os.path.exists(path):
            write_text(path, content)

    def sweep_repositories(self, force: bool) -> None:
        now = time.monotonic()
        if not force and now - self.last_repository_sweep < REPOSITORY_SWEEP_INTERVAL_SECONDS:
            return
        self.last_repository_sweep = now
        self.cache_completed_repositories()
        self.trash_completed_blank_workspaces()
        self.trash_orphan_repositories()

    def cache_completed_repositories(self) -> None:
        active_repo_paths = self.get_active_repository_paths()
        references_by_repo: dict[str, list[TaskRepositoryReference]] = {}
        for reference in self.load_task_repository_references():
            references_by_repo.setdefault(normalize_path(reference.repo_path), []).append(reference)

        for references in references_by_repo.values():
            repo_path = os.path.abspath(references[0].repo_path)
            if normalize_path(repo_path) in active_repo_paths:
                continue
            if not os.path.isdir(repo_path):
                continue
            if not path_startswith(repo_path, self.paths.projects_root):
                continue
            if any(not reference.is_confirmed for reference in references):
                continue
            if any(ProjectAliases.is_blank(reference.project_alias) for reference in references):
                continue

            alias = (
                next(
                    (
                        reference.project_alias
                        for reference in references
                        if reference.project_alias and reference.project_alias.strip()
                    ),
                    None,
                )
                or self.get_managed_project_alias(repo_path)
                or "unknown-project"
            )
            cache_project_dir = os.path.join(self.paths.cache_root, sanitize_file_name(alias))
            os.makedirs(cache_project_dir, exist_ok=True)

            destination = make_unique_directory_path(
                cache_project_dir, os.path.basename(repo_path)
            )
            try:
                self.workspace_mover.move_directory(repo_path, destination)
            except (OSError, shutil.Error) as exc:
                self.log.warn(
                    f"Skipped moving completed repo to cache because it is locked or inaccessible: {repo_path} -> {destination}. {exc}"
                )
                continue

            for reference in references:
                if reference.managed_card:
                    reference.managed_card.with_updated_repo_path(destination)
            self.log.info(f"Moved completed repo to cache: {destination}")

    def trash_orphan_repositories(self) -> None:
        referenced_repo_paths = {
            normalize_path(reference.repo_path)
            for reference in self.load_task_repository_references()
        }
        active_repo_paths = self.get_active_repository_paths()
        managed_repos = sorted(
            {
                normalize_path(path): path
                for path in [
                    *self.enumerate_managed_repositories(self.paths.projects_root),
                    *self.enumerate_managed_repositories(self.paths.cache_root),
                ]
            }.items()
        )

        for normalized_repo_path, repo_path in managed_repos:
            if normalized_repo_path in active_repo_paths:
                continue
            if normalized_repo_path in referenced_repo_paths:
                continue

            alias = self.get_managed_project_alias(repo_path) or "unassigned"
            trash_project_dir = os.path.join(self.paths.trash_root, sanitize_file_name(alias))
            os.makedirs(trash_project_dir, exist_ok=True)
            destination = make_unique_directory_path(
                trash_project_dir, os.path.basename(repo_path)
            )
            try:
                self.workspace_mover.move_directory(repo_path, destination)
            except (OSError, shutil.Error) as exc:
                self.log.warn(
                    f"Skipped moving orphaned repo to trash because it is locked or inaccessible: {repo_path} -> {destination}. {exc}"
                )
                continue

            self.log.info(f"Moved orphaned repo to trash: {destination}")

    def trash_completed_blank_workspaces(self) -> None:
        for task_path in [
            *self.enumerate_step_tasks(TaskStep.DONE),
            *self.enumerate_step_tasks(TaskStep.CONFIRMED),
        ]:
            step = self.try_infer_managed_task_step(task_path)
            if step is None:
                continue
            card = self.try_load_task_card(task_path, step)
            if card:
                self.trash_completed_blank_workspace(card)

    def trash_completed_blank_workspace(self, card: "TaskCard") -> None:
        if not ProjectAliases.is_blank(card.project_alias) or not card.repo_path:
            return
        repo_path = os.path.abspath(card.repo_path)
        if not os.path.isdir(repo_path) or path_startswith(repo_path, self.paths.trash_root):
            return

        trash_project_dir = os.path.join(
            self.paths.trash_root, ProjectAliases.BLANK_WORKSPACE_ALIAS
        )
        os.makedirs(trash_project_dir, exist_ok=True)
        destination = make_unique_directory_path(trash_project_dir, os.path.basename(repo_path))
        try:
            self.workspace_mover.move_directory(repo_path, destination)
        except (OSError, shutil.Error) as exc:
            self.log.warn(
                f"Skipped moving blank workspace to trash because it is locked or inaccessible: {repo_path} -> {destination}. {exc}"
            )
            return

        card.with_updated_repo_path(destination)
        self.log.info(f"Moved blank workspace to trash: {destination}")

    def reactivate_done_cards(self) -> None:
        for task_path in self.enumerate_step_tasks(TaskStep.DONE):
            card = self.try_load_task_card(task_path, TaskStep.DONE)
            if not card or not card.has_meaningful_comments:
                continue
            normalized_task_path = normalize_path(task_path)
            comments_fingerprint = card.comments_fingerprint
            if (
                self.requeued_done_comment_fingerprints.get(normalized_task_path)
                == comments_fingerprint
            ):
                self.log.info(
                    f"Done task still has unchanged Comments after requeue, leaving it done: {task_path}"
                )
                continue
            self.requeued_done_comment_fingerprints[normalized_task_path] = comments_fingerprint
            backlog_path = self.move_task(card, TaskStep.BACKLOG)
            self.log.info(f"Requeued done task because Comments is non-empty: {backlog_path}")
            self.signal_scan()

    def try_load_task_card(self, task_path: str, expected_step: TaskStep) -> "TaskCard | None":
        try:
            return TaskCard.load(task_path, expected_step, self.paths)
        except Exception as exc:
            self.log.warn(f"Skipping unreadable task `{task_path}`: {exc}")
            return None

    def start_or_resume_task(
        self, backlog_card: "TaskCard", assignment: ProjectAssignment
    ) -> None:
        if self.stop_event.is_set():
            return
        try:
            self.log.info(
                f"Provisioning repository for task before moving it to doing: {backlog_card.path}"
            )
            repo_path = self.ensure_working_repository(backlog_card, assignment)
        except ShutdownRequested:
            self.log.info(
                f"Shutdown requested; leaving task in backlog after interrupted provisioning: {backlog_card.path}"
            )
            return
        except Exception as exc:
            self.log.error(f"Repository provisioning failed for `{backlog_card.path}`: {exc}")
            self.block_task_for_issue(backlog_card, f"Repository provisioning failed: {exc}")
            return

        if self.stop_event.is_set():
            self.log.info(
                f"Shutdown requested; leaving task in backlog after repository provisioning: {backlog_card.path}"
            )
            return

        doing_path = self.move_task(backlog_card, TaskStep.DOING)
        doing_card = TaskCard.load(doing_path, TaskStep.DOING, self.paths)
        if self.stop_event.is_set():
            restored_path = self.move_task(doing_card, TaskStep.BACKLOG)
            self.log.info(
                f"Shutdown requested after moving task to doing; restored task to backlog: {restored_path}"
            )
            return

        doing_card = doing_card.with_updated_repo_path(repo_path)

        try:
            agent_kind = self.agent_resolver.select_agent_kind(doing_card)
        except Exception as exc:
            self.block_task_for_issue(doing_card, str(exc))
            return

        active_agent = ActiveAgent(
            doing_card.path, repo_path, doing_card.agent_id or "", agent_kind
        )
        with self.active_agents_lock:
            if doing_card.path in self.active_agents:
                self.log.warn(f"Task is already active, skipping duplicate start: {doing_card.path}")
                return
            self.active_agents[doing_card.path] = active_agent

        def run_agent() -> None:
            nonlocal doing_card
            try:
                run_mode = AgentRunMode.RESUME if doing_card.agent_id else AgentRunMode.NEW
                prompt = PromptFactory.build(
                    self.paths.root, doing_card.path, repo_path, run_mode, agent_kind
                )
                runner = AgentRunner.create(agent_kind, self.settings, self.paths, self.log)
                result = runner.run(
                    doing_card,
                    repo_path,
                    prompt,
                    lambda session_id: self._record_agent_id(
                        doing_card, session_id, agent_kind
                    ),
                )
                if result.session_id and result.session_id != doing_card.agent_id:
                    doing_card = doing_card.with_updated_agent_id(
                        result.session_id, agent_kind
                    )
                self.handle_agent_completion(doing_card, result, agent_kind)
            except Exception as exc:
                self.log.error(f"Agent failure for `{doing_card.path}`: {exc}")
                self.block_task_for_issue(
                    doing_card,
                    f"runner.py failure while running {agent_kind.value}: {exc}",
                )
            finally:
                with self.active_agents_lock:
                    self.active_agents.pop(doing_card.path, None)
                self.signal_scan()

        thread = threading.Thread(target=run_agent, name=f"kanban-{agent_kind.value}", daemon=False)
        self.agent_threads.append(thread)
        thread.start()

    def _record_agent_id(
        self, card: "TaskCard", session_id: str, agent_kind: AgentKind
    ) -> None:
        if session_id and session_id != card.agent_id:
            card.with_updated_agent_id(session_id, agent_kind)

    def ensure_working_repository(
        self, card: "TaskCard", assignment: ProjectAssignment
    ) -> str:
        repo_base_dir = os.path.join(
            self.paths.projects_root, sanitize_file_name(assignment.workspace_alias)
        )
        preferred_repo_folder_name = sanitize_file_name(os.path.splitext(card.file_name)[0])

        if card.repo_path:
            recorded_path = os.path.abspath(card.repo_path)
            if os.path.isdir(recorded_path):
                if assignment.uses_blank_workspace:
                    return recorded_path
                if path_startswith(recorded_path, self.paths.cache_root):
                    restored_path = make_unique_directory_path(
                        repo_base_dir, preferred_repo_folder_name
                    )
                    try:
                        self.workspace_mover.move_directory(recorded_path, restored_path)
                        GitCli.refresh(restored_path, self.log, self.stop_event)
                        return restored_path
                    except (OSError, shutil.Error) as exc:
                        self.log.warn(
                            f"Skipped recorded cached repo because it is locked or inaccessible: {recorded_path} -> {restored_path}. {exc}"
                        )
                GitCli.refresh(recorded_path, self.log, self.stop_event)
                return recorded_path

        if assignment.uses_blank_workspace:
            os.makedirs(repo_base_dir, exist_ok=True)
            workspace_path = make_unique_directory_path(repo_base_dir, preferred_repo_folder_name)
            os.makedirs(workspace_path, exist_ok=True)
            return workspace_path

        cache_project_dir = os.path.join(
            self.paths.cache_root, sanitize_file_name(card.project_alias)
        )
        if os.path.isdir(cache_project_dir):
            skipped_cache_count = 0
            first_cache_skip = None
            for reusable_repo in self.enumerate_reusable_cache_repositories(cache_project_dir):
                restored_path = make_unique_directory_path(
                    repo_base_dir, preferred_repo_folder_name
                )
                try:
                    self.workspace_mover.move_directory(reusable_repo, restored_path)
                    GitCli.refresh(restored_path, self.log, self.stop_event)
                    return restored_path
                except (OSError, shutil.Error) as exc:
                    skipped_cache_count += 1
                    if first_cache_skip is None:
                        first_cache_skip = f"{reusable_repo}: {exc}"

            if skipped_cache_count:
                self.log.warn(
                    f"Skipped {skipped_cache_count} cached repo(s) for `{card.project_alias}` because they are locked or inaccessible; cloning fresh. First failure: {first_cache_skip}"
                )

        os.makedirs(repo_base_dir, exist_ok=True)
        repo_path = make_unique_directory_path(repo_base_dir, preferred_repo_folder_name)
        self.log.info(f"Cloning fresh repository for task `{card.path}` into `{repo_path}`.")
        GitCli.clone(assignment.repo_url or "", repo_path, self.log, self.stop_event)
        return repo_path

    def enumerate_reusable_cache_repositories(self, cache_project_dir: str) -> list[str]:
        try:
            names = os.listdir(cache_project_dir)
        except OSError as exc:
            self.log.warn(f"Skipped cache directory because it is inaccessible: {cache_project_dir}. {exc}")
            return []

        candidates: list[tuple[float, str]] = []
        for name in names:
            path = os.path.join(cache_project_dir, name)
            try:
                if os.path.isdir(path):
                    candidates.append((os.path.getmtime(path), path))
            except OSError as exc:
                self.log.warn(f"Skipped cached repo metadata because it is inaccessible: {path}. {exc}")

        candidates.sort(key=lambda item: item[0], reverse=True)
        return [path for _, path in candidates]

    def handle_agent_completion(
        self, card: "TaskCard", result: AgentRunResult, agent_kind: AgentKind
    ) -> None:
        if result.exit_code != 0:
            self.block_task_for_issue(
                card,
                f"{agent_kind.value} exited with code {result.exit_code}. Check logs for details.",
            )
            return

        status = PromptFactory.parse_status(result.final_agent_message)
        if status == AgentOutcome.DONE:
            done_path = self.move_task(card, TaskStep.DONE)
            self.log.info(f"Task completed: {done_path}")
            self.notifications.show("Task complete", os.path.basename(done_path), done_path)
            done_card = self.try_load_task_card(done_path, TaskStep.DONE)
            if done_card:
                self.trash_completed_blank_workspace(done_card)
            return

        if status == AgentOutcome.BLOCKED:
            blocked_summary = PromptFactory.parse_summary(result.final_agent_message)
            if blocked_summary:
                reloaded = TaskCard.load(card.path, TaskStep.DOING, self.paths)
                if not reloaded.has_meaningful_comments:
                    card = reloaded.append_comment_topic(
                        f"[{agent_kind.value}] {blocked_summary}"
                    )
            blocked_path = self.move_task(card, TaskStep.BLOCKED)
            self.log.info(f"Task blocked: {blocked_path}")
            self.notifications.show("Task blocked", os.path.basename(blocked_path), blocked_path)
            return

        reloaded = TaskCard.load(card.path, TaskStep.DOING, self.paths)
        if reloaded.has_meaningful_comments:
            inferred_blocked_path = self.move_task(card, TaskStep.BLOCKED)
            self.log.warn(
                f"No explicit status; inferred blocked from non-empty Comments: {inferred_blocked_path}"
            )
            self.notifications.show(
                "Task blocked", os.path.basename(inferred_blocked_path), inferred_blocked_path
            )
            return

        self.block_task_for_issue(
            card, "Agent finished without a parseable `ORCHESTRATOR_STATUS:` line."
        )

    def block_task_for_issue(self, card: "TaskCard", issue: str) -> None:
        updated_card = card.append_comment_topic(f"[runner.py] {issue}")
        blocked_path = self.move_task(updated_card, TaskStep.BLOCKED)
        self.log.warn(f"Moved task to blocked: {blocked_path}. Reason: {issue}")
        self.notifications.show("Task blocked", os.path.basename(blocked_path), blocked_path)

    def move_task(self, card: "TaskCard", destination_step: TaskStep) -> str:
        if card.step == destination_step:
            return card.path

        source_step_dir = self.paths.step_directories[card.step]
        relative = os.path.relpath(card.path, source_step_dir)
        destination_path = os.path.join(self.paths.step_directories[destination_step], relative)
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)

        if os.path.exists(destination_path):
            destination_path = make_unique_file_path(destination_path)

        self.workspace_mover.move_file(card.path, destination_path)
        self.log.info(f"Moved task: {card.path} -> {destination_path}")
        return destination_path

    def enumerate_step_tasks(self, step: TaskStep) -> list[str]:
        root = self.paths.step_directories[step]
        if not os.path.isdir(root):
            return []
        result: list[str] = []
        for current_root, _dirs, files in os.walk(root):
            for file_name in files:
                if file_name.lower().endswith(".md"):
                    result.append(os.path.join(current_root, file_name))
        return sorted(result, key=lambda item: normalize_path(os.path.relpath(item, root)))

    def load_task_repository_references(self) -> list[TaskRepositoryReference]:
        references: list[TaskRepositoryReference] = []
        if not os.path.isdir(self.paths.tasks_root):
            return references

        for current_root, _dirs, files in os.walk(self.paths.tasks_root):
            for file_name in sorted(files):
                if not file_name.lower().endswith(".md"):
                    continue
                task_path = os.path.join(current_root, file_name)
                if self.is_task_template_path(task_path):
                    continue
                step = self.try_infer_managed_task_step(task_path)
                managed_card = self.try_load_task_card(task_path, step) if step else None
                if managed_card and managed_card.repo_path:
                    references.append(
                        TaskRepositoryReference(
                            managed_card.path,
                            managed_card.project_alias,
                            os.path.abspath(managed_card.repo_path),
                            managed_card.is_confirmed,
                            managed_card,
                        )
                    )
                    continue
                try:
                    content = read_text(task_path)
                    repo_path = TaskCard.read_metadata_value(content, "Repo")
                    if not repo_path:
                        continue
                    references.append(
                        TaskRepositoryReference(
                            task_path,
                            TaskCard.read_metadata_value(content, "Project"),
                            os.path.abspath(repo_path),
                            False,
                            None,
                        )
                    )
                except Exception as exc:
                    self.log.warn(f"Skipping unreadable task reference `{task_path}`: {exc}")
        return references

    def try_infer_managed_task_step(self, task_path: str) -> TaskStep | None:
        for step, directory in self.paths.step_directories.items():
            if path_startswith(task_path, directory):
                return step
        return None

    @staticmethod
    def is_task_template_path(task_path: str) -> bool:
        file_name = os.path.basename(task_path).lower()
        return file_name in {"template.md", "template-human.md"}

    def get_active_repository_paths(self) -> set[str]:
        with self.active_agents_lock:
            return {
                normalize_path(agent.repo_path)
                for agent in self.active_agents.values()
            }

    def _active_count(self) -> int:
        with self.active_agents_lock:
            return len(self.active_agents)

    def enumerate_managed_repositories(self, root: str) -> list[str]:
        if not os.path.isdir(root):
            return []
        result: list[str] = []
        try:
            alias_names = sorted(os.listdir(root), key=str.lower if IS_WINDOWS else None)
        except OSError as exc:
            self.log.warn(f"Skipped managed repository root because it is inaccessible: {root}. {exc}")
            return []

        for alias_name in alias_names:
            alias_dir = os.path.join(root, alias_name)
            try:
                if not os.path.isdir(alias_dir):
                    continue
                repo_names = sorted(os.listdir(alias_dir), key=str.lower if IS_WINDOWS else None)
            except OSError as exc:
                self.log.warn(f"Skipped managed repository alias because it is inaccessible: {alias_dir}. {exc}")
                continue

            for repo_name in repo_names:
                repo_dir = os.path.join(alias_dir, repo_name)
                try:
                    if os.path.isdir(repo_dir):
                        result.append(os.path.abspath(repo_dir))
                except OSError as exc:
                    self.log.warn(f"Skipped managed repository because it is inaccessible: {repo_dir}. {exc}")
        return result

    def get_managed_project_alias(self, repo_path: str) -> str | None:
        for root in [self.paths.projects_root, self.paths.cache_root, self.paths.trash_root]:
            if not path_startswith(repo_path, root):
                continue
            relative_path = os.path.relpath(repo_path, root)
            segments = [
                segment for segment in re.split(r"[\\/]+", relative_path) if segment
            ]
            if segments:
                return segments[0]
        return None

    def _join_agent_threads(self) -> None:
        for thread in list(self.agent_threads):
            thread.join()


class WorkspaceMoveBridge:
    def __init__(self, board_root: str, log: LogSink) -> None:
        self.board_root = os.path.abspath(board_root)
        self.log = log

    def move_file(self, source_path: str, destination_path: str) -> None:
        self._move_entry(source_path, destination_path, "file", os.path.isfile)

    def move_directory(self, source_path: str, destination_path: str) -> None:
        if path_equals(source_path, destination_path):
            return
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        os.rename(source_path, destination_path)
        self.log.info(
            f"Moved directory via direct filesystem rename: `{source_path}` -> `{destination_path}`"
        )

    def _move_entry(
        self,
        source_path: str,
        destination_path: str,
        entry_type: str,
        exists: Callable[[str], bool],
    ) -> None:
        if path_equals(source_path, destination_path):
            return

        result = self._try_move_via_extension(source_path, destination_path, entry_type)
        if result == "moved":
            self.log.info(
                f"Moved {entry_type} via VS Code extension: `{source_path}` -> `{destination_path}`"
            )
            return
        if result == "asked" and self._wait_for_move_completion(
            source_path, destination_path, exists
        ):
            self.log.info(
                f"Moved {entry_type} via VS Code extension (verified): `{source_path}` -> `{destination_path}`"
            )
            return

        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        try:
            shutil.move(source_path, destination_path)
        except (OSError, shutil.Error):
            if result == "asked" and not exists(source_path) and exists(destination_path):
                self.log.info(
                    f"Moved {entry_type} via VS Code extension (late verified): `{source_path}` -> `{destination_path}`"
                )
                return
            raise
        fallback_reason = "extension asked, no successful response" if result == "asked" else "extension not reached"
        self.log.info(
            f"Moved {entry_type} via direct filesystem move ({fallback_reason}): `{source_path}` -> `{destination_path}`"
        )

    def _wait_for_move_completion(
        self,
        source_path: str,
        destination_path: str,
        exists: Callable[[str], bool],
    ) -> bool:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if not exists(source_path) and exists(destination_path):
                return True
            time.sleep(0.05)
        return not exists(source_path) and exists(destination_path)

    def _try_move_via_extension(
        self, source_path: str, destination_path: str, entry_type: str
    ) -> str:
        if not IS_WINDOWS:
            return "unavailable"

        result_box: dict[str, str] = {}

        def worker() -> None:
            result_box["result"] = self._try_move_via_extension_blocking(
                source_path, destination_path, entry_type
            )

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        thread.join(1.25)
        if thread.is_alive():
            return "asked"
        return result_box.get("result", "unavailable")

    def _try_move_via_extension_blocking(
        self, source_path: str, destination_path: str, entry_type: str
    ) -> str:
        pipe_path = rf"\\.\pipe\{workspace_move_pipe_name(self.board_root)}"
        request = {
            "version": 1,
            "command": "move",
            "boardRoot": self.board_root,
            "sourcePath": os.path.abspath(source_path),
            "destinationPath": os.path.abspath(destination_path),
            "entryType": entry_type,
        }
        request_line = json.dumps(request, separators=(",", ":")) + "\n"
        try:
            with open(pipe_path, "r+b", buffering=0) as pipe:
                pipe.write(request_line.encode(ENCODING))
                chunks: list[bytes] = []
                started = time.monotonic()
                while time.monotonic() - started < 1.0:
                    chunk = pipe.read(1)
                    if not chunk:
                        break
                    if chunk == b"\n":
                        break
                    chunks.append(chunk)
                if not chunks:
                    return "asked"
                response = json.loads(b"".join(chunks).decode(ENCODING, errors="replace"))
                if response.get("ok") is True:
                    return "moved"
                if response.get("error"):
                    self.log.warn(
                        f"VS Code move bridge rejected {entry_type} move `{source_path}` -> `{destination_path}`: {response.get('error')}"
                    )
                return "asked"
        except Exception:
            return "unavailable"


class RunnerStatusServer:
    def __init__(
        self,
        root_path: str,
        kanban_path: str,
        log: LogSink,
        active_agent_count: Callable[[], int],
    ) -> None:
        self.root_path = os.path.abspath(root_path)
        self.normalized_root_path = normalize_path(self.root_path)
        self.kanban_path = os.path.abspath(kanban_path)
        self.log = log
        self.active_agent_count = active_agent_count
        self.process_id = os.getpid()
        self.started_at_utc = utc_now_iso()
        self.stop_event = threading.Event()
        self.socket: socket.socket | None = None
        self.thread: threading.Thread | None = None
        self.port = 0

    def start(self) -> bool:
        if self.socket is not None:
            return True
        for port in candidate_status_ports(self.root_path):
            try:
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                else:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", port))
                listener.listen()
                listener.settimeout(0.5)
                self.socket = listener
                self.port = port
                self.thread = threading.Thread(target=self._accept_loop, daemon=True)
                self.thread.start()
                self.log.info(f"Runner status endpoint listening on 127.0.0.1:{port}")
                return True
            except OSError:
                existing = self._read_existing_status(port)
                if (
                    existing
                    and existing.get("kind") == "kanban-runner-status"
                    and existing.get("normalizedRootPath") == self.normalized_root_path
                ):
                    existing_pid = existing.get("processId")
                    self.log.warn(
                        f"Runner for `{self.root_path}` is already listening on 127.0.0.1:{port}"
                        + (f" (pid {existing_pid})" if existing_pid else "")
                        + "; exiting duplicate runner."
                    )
                    return False
                try:
                    listener.close()
                except Exception:
                    pass
        self.log.warn("Failed to start runner status endpoint; all candidate localhost ports are in use.")
        return True

    def _read_existing_status(self, port: int) -> dict[str, object] | None:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25) as client:
                client.settimeout(0.5)
                data = client.recv(4096).decode(ENCODING, "replace").strip()
        except OSError:
            return None
        if not data:
            return None
        line = data.splitlines()[0]
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def stop(self) -> None:
        self.stop_event.set()
        if self.socket is not None:
            try:
                self.socket.close()
            except OSError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=1.0)

    def _accept_loop(self) -> None:
        while not self.stop_event.is_set() and self.socket is not None:
            try:
                client, _addr = self.socket.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            threading.Thread(target=self._write_status, args=(client,), daemon=True).start()

    def _write_status(self, client: socket.socket) -> None:
        with client:
            payload = {
                "version": 1,
                "kind": "kanban-runner-status",
                "rootPath": self.root_path,
                "normalizedRootPath": self.normalized_root_path,
                "kanbanPath": self.kanban_path,
                "processId": self.process_id,
                "startedAtUtc": self.started_at_utc,
                "updatedAtUtc": utc_now_iso(),
                "port": self.port,
                "activeAgentCount": self.active_agent_count(),
            }
            try:
                client.sendall((json.dumps(payload) + "\n").encode(ENCODING))
            except OSError:
                pass


class AgentResolver:
    def __init__(self, settings: OrchestratorSettings, log: LogSink) -> None:
        self.settings = settings
        self.log = log
        self._auto_agent: AgentKind | None = None

    def should_manage_manually(self, card: "TaskCard") -> bool:
        if has_manual_agent_tag(card.tags):
            return True
        if self.settings.default_agent != MANUAL_AGENT_VALUE:
            return False
        if card.agent_id:
            return False
        if agent_kind_from_value(card.agent_kind_value):
            return False
        if agent_kind_from_tags(card.tags):
            return False
        model_spec = card.model_spec
        return not bool(model_spec and model_spec.agent_kind)

    def select_agent_kind(self, card: "TaskCard") -> AgentKind:
        if has_manual_agent_tag(card.tags):
            raise ValueError(
                "Task is tagged manual/human, so it is user-managed and should not be assigned to an agent."
            )
        stored_agent = agent_kind_from_value(card.agent_kind_value)
        id_agent = agent_kind_from_agent_id(card.agent_id)
        if card.agent_id:
            if id_agent in {AgentKind.CODEX, AgentKind.KIMI, AgentKind.OPENCODE}:
                resume_agent = id_agent
            elif stored_agent:
                resume_agent = stored_agent
            elif (
                id_agent == AgentKind.CLAUDE
                and card.repo_path
                and DeepCodeSessions.session_file(card.repo_path, card.agent_id)
            ):
                resume_agent = AgentKind.DEEPSEEK
            else:
                resume_agent = id_agent
            if resume_agent:
                self.ensure_agent_available(resume_agent)
                return resume_agent

        model_spec = card.model_spec
        tagged_agent = agent_kind_from_tags(card.tags)
        if tagged_agent:
            self.ensure_model_matches_agent(model_spec, tagged_agent, "Tags")
            self.ensure_agent_available(tagged_agent)
            self.log.info(f"Task `{card.path}` selected agent from tag: {tagged_agent.value}")
            return tagged_agent
        if stored_agent:
            self.ensure_model_matches_agent(model_spec, stored_agent, "Agent Kind")
            self.ensure_agent_available(stored_agent)
            return stored_agent
        if model_spec and model_spec.agent_kind:
            self.ensure_agent_available(model_spec.agent_kind)
            self.log.info(
                f"Task `{card.path}` selected agent from Model: {model_spec.agent_kind.value}"
            )
            return model_spec.agent_kind
        if self.settings.default_agent == MANUAL_AGENT_VALUE:
            raise ValueError(
                "Default agent is manual. Add an agent tag or an agent-prefixed Model: value to let the runner manage this task."
            )
        if self.settings.default_agent:
            self.ensure_agent_available(self.settings.default_agent)
            return self.settings.default_agent
        return self.detect_default_agent()

    def ensure_model_matches_agent(
        self,
        model_spec: ModelSpec | None,
        agent_kind: AgentKind,
        source: str,
    ) -> None:
        if model_spec and model_spec.agent_kind and model_spec.agent_kind != agent_kind:
            raise ValueError(
                f"`Model: {model_spec.raw}` requests `{model_spec.agent_kind.value}`, "
                f"but `{source}` selects `{agent_kind.value}`."
            )

    def detect_default_agent(self) -> AgentKind:
        if self._auto_agent:
            return self._auto_agent
        for kind in [
            AgentKind.CLAUDE,
            AgentKind.CODEX,
            AgentKind.OPENCODE,
            AgentKind.KIMI,
            AgentKind.DEEPSEEK,
        ]:
            if self.is_agent_available(kind):
                self._auto_agent = kind
                self.log.info(f"Auto-detected default agent: {kind.value}")
                return kind
        raise FileNotFoundError(
            "No supported agent executable was found. Install Claude Code, Codex, opencode, Kimi CLI, or Deep Code, or configure `kanban.defaultAgent` and the matching executable setting."
        )

    def ensure_agent_available(self, kind: AgentKind) -> None:
        if not self.is_agent_available(kind):
            executable = self.executable_for(kind)
            raise FileNotFoundError(
                f"Task requested `{kind.value}`, but `{executable}` was not found. Install it or update the matching executable setting."
            )

    def is_agent_available(self, kind: AgentKind) -> bool:
        try:
            ToolPaths.resolve_executable(self.executable_for(kind), kind)
            return True
        except FileNotFoundError:
            return False

    def executable_for(self, kind: AgentKind) -> str:
        if kind == AgentKind.CLAUDE:
            return self.settings.claude_executable
        if kind == AgentKind.KIMI:
            return self.settings.kimi_executable
        if kind == AgentKind.DEEPSEEK:
            return self.settings.deepseek_executable
        if kind == AgentKind.OPENCODE:
            return self.settings.opencode_executable
        return self.settings.codex_executable


class AgentRunner:
    def __init__(self, settings: OrchestratorSettings, paths: BoardPaths, log: LogSink) -> None:
        self.settings = settings
        self.paths = paths
        self.log = log

    @staticmethod
    def create(
        kind: AgentKind, settings: OrchestratorSettings, paths: BoardPaths, log: LogSink
    ) -> "AgentRunner":
        if kind == AgentKind.CLAUDE:
            return ClaudeRunner(settings, paths, log)
        if kind == AgentKind.KIMI:
            return KimiRunner(settings, paths, log)
        if kind == AgentKind.DEEPSEEK:
            return DeepSeekRunner(settings, paths, log)
        if kind == AgentKind.OPENCODE:
            return OpencodeRunner(settings, paths, log)
        return CodexRunner(settings, paths, log)

    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        raise NotImplementedError

    def model_spec_for(self, card: "TaskCard", agent_kind: AgentKind) -> ModelSpec | None:
        if card.agent_id:
            return None
        return card.model_spec or self.settings.default_models.get(agent_kind)

    def _run_process(
        self,
        args: list[str],
        repo_path: str,
        prompt: str,
        parse_line: Callable[[str, dict[str, str]], None],
        label: str,
        on_session_started: Callable[[str], None] | None,
        write_prompt_to_stdin: bool = True,
        redacted_arg_indexes: set[int] | None = None,
        discover_session_id: Callable[[], str | None] | None = None,
        session_discovery_timeout_seconds: float = 30.0,
        env_overrides: dict[str, str] | None = None,
    ) -> AgentRunResult:
        redacted = redacted_arg_indexes or set()
        log_args = [
            "<prompt>" if index in redacted else arg
            for index, arg in enumerate(args)
        ]
        self.log.info(f"Starting {label}: {' '.join(quote_arg(arg) for arg in log_args)}")
        process = subprocess.Popen(
            args,
            cwd=repo_path,
            env={**os.environ, **env_overrides} if env_overrides else None,
            stdin=subprocess.PIPE if write_prompt_to_stdin else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding=ENCODING,
            errors="replace",
        )
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        state = {"session_id": "", "final_agent_message": ""}
        session_reported = False
        session_lock = threading.Lock()

        def report_session_id(session_id: str) -> None:
            nonlocal session_reported
            if not session_id:
                return
            with session_lock:
                if not state.get("session_id"):
                    state["session_id"] = session_id
                if session_reported:
                    return
                session_reported = True
            if on_session_started:
                on_session_started(session_id)

        if write_prompt_to_stdin:
            assert process.stdin is not None
            process.stdin.write(prompt)
            process.stdin.flush()
            process.stdin.close()

        assert process.stdout is not None
        assert process.stderr is not None

        def read_stdout() -> None:
            for raw_line in process.stdout:
                line = raw_line.rstrip("\r\n")
                stdout_lines.append(line)
                parse_line(line, state)
                report_session_id(state.get("session_id", ""))

        def read_stderr() -> None:
            for raw_line in process.stderr:
                line = raw_line.rstrip("\r\n")
                stderr_lines.append(line)
                self.log.warn(f"{label} stderr: {line}")

        discovery_stop = threading.Event()

        def discover_session() -> None:
            deadline = time.monotonic() + session_discovery_timeout_seconds
            while (
                discover_session_id
                and not discovery_stop.is_set()
                and time.monotonic() < deadline
            ):
                if state.get("session_id"):
                    return
                session_id = discover_session_id()
                if session_id:
                    report_session_id(session_id)
                    return
                discovery_stop.wait(0.5)
            if (
                discover_session_id
                and not discovery_stop.is_set()
                and not state.get("session_id")
                and process.poll() is None
            ):
                self.log.warn(
                    f"{label} did not report a session id within "
                    f"{session_discovery_timeout_seconds:g} seconds; terminating it so the task can be retried."
                )
                terminate_process_tree(process.pid)

        stdout_thread = threading.Thread(target=read_stdout)
        stderr_thread = threading.Thread(target=read_stderr)
        discovery_thread: threading.Thread | None = None
        stdout_thread.start()
        stderr_thread.start()
        if discover_session_id:
            discovery_thread = threading.Thread(
                target=discover_session,
                name=f"{label}-session-discovery",
                daemon=True,
            )
            discovery_thread.start()
        exit_code = process.wait()
        stdout_thread.join()
        stderr_thread.join()
        discovery_stop.set()
        if discovery_thread:
            discovery_thread.join(timeout=1)

        for line in stdout_lines[-10:]:
            self.log.info(f"{label} stdout: {line}")

        return AgentRunResult(
            exit_code,
            state.get("session_id", ""),
            state.get("final_agent_message", ""),
            stdout_lines,
            stderr_lines,
        )


class CodexRunner(AgentRunner):
    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        executable = ToolPaths.resolve_executable(
            self.settings.codex_executable, AgentKind.CODEX
        )
        model_spec = self.model_spec_for(card, AgentKind.CODEX)
        if card.agent_id:
            args = [
                executable,
                "exec",
                "resume",
                card.agent_id,
                "--json",
                *codex_mode_arguments(self.settings.codex_mode),
                "-",
            ]
        else:
            args = [
                executable,
                "exec",
                *codex_model_arguments(model_spec),
                "--json",
                "-C",
                repo_path,
                "--add-dir",
                self.paths.root,
                *codex_mode_arguments(self.settings.codex_mode),
                "-",
            ]
        return self._run_process(
            args, repo_path, prompt, parse_codex_json_line, "Codex", on_session_started
        )


class ClaudeRunner(AgentRunner):
    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        executable = ToolPaths.resolve_executable(
            self.settings.claude_executable, AgentKind.CLAUDE
        )
        model_spec = self.model_spec_for(card, AgentKind.CLAUDE)
        args = [
            executable,
            "--print",
            "--verbose",
            "--output-format",
            "stream-json",
            "--input-format",
            "text",
            "--add-dir",
            self.paths.root,
            *claude_model_arguments(model_spec),
            *claude_permission_arguments(self.settings.codex_mode),
        ]
        if card.agent_id:
            args.extend(["--resume", card.agent_id])
        return self._run_process(
            args, repo_path, prompt, parse_claude_json_line, "Claude", on_session_started
        )


class KimiRunner(AgentRunner):
    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        executable = ToolPaths.resolve_executable(
            self.settings.kimi_executable, AgentKind.KIMI
        )
        model_spec = self.model_spec_for(card, AgentKind.KIMI)
        existing_session_ids = KimiSessions.session_ids_for_workdir(repo_path)
        self.ensure_kimi_workspace_trusted(repo_path)
        self.ensure_kimi_workspace_trusted(self.paths.root)
        args = [
            executable,
            *kimi_model_arguments(model_spec),
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--add-dir",
            self.paths.root,
        ]
        if card.agent_id:
            args.extend(["--session", card.agent_id])
        return self._run_process(
            args,
            repo_path,
            prompt,
            parse_kimi_json_line,
            "Kimi",
            on_session_started,
            write_prompt_to_stdin=False,
            redacted_arg_indexes={args.index(prompt)},
            discover_session_id=(
                None
                if card.agent_id
                else lambda: KimiSessions.find_new_session_id_for_workdir(
                    repo_path, existing_session_ids
                )
            ),
            env_overrides=kimi_environment(model_spec),
        )

    def ensure_kimi_workspace_trusted(self, work_dir: str) -> None:
        try:
            trust_kimi_workspace(work_dir)
        except OSError as exc:
            self.log.warn(f"Could not pre-trust Kimi workspace `{work_dir}`: {exc}")


class OpencodeRunner(AgentRunner):
    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        executable = ToolPaths.resolve_executable(
            self.settings.opencode_executable, AgentKind.OPENCODE
        )
        model_spec = card.model_spec or (
            None if card.agent_id else self.settings.default_models.get(AgentKind.OPENCODE)
        )
        existing_session_ids = OpencodeSessions.session_ids_for_workdir(
            executable, repo_path
        )
        prompt_file = os.path.join(
            repo_path, f".kanban-runner-prompt-{hash_path(card.path)}.md"
        )
        write_text(prompt_file, prompt)
        exclude_local_git_path(repo_path, ".kanban-runner-prompt-*.md")
        prompt_arg = (
            f"Read and follow the attached runner prompt file `{prompt_file}`. "
            "It contains the kanban task file content, board root, repository path, README, and context. "
            "Do not ask what the task is or where runner.py, the board, task file, or repository are; read that file first. "
            "Do not modify the prompt file."
        )
        args = [
            executable,
            "run",
            "--format",
            "json",
            "--dir",
            repo_path,
            "-f",
            prompt_file,
            *opencode_model_arguments(model_spec),
            *opencode_permission_arguments(self.settings.codex_mode),
        ]
        if card.agent_id:
            args.extend(["--session", card.agent_id])
        else:
            args.extend(["--title", task_title(card)])
        args.append(prompt_arg)
        try:
            result = self._run_process(
                args,
                repo_path,
                prompt_arg,
                parse_opencode_json_line,
                "opencode",
                on_session_started,
                write_prompt_to_stdin=False,
                redacted_arg_indexes={args.index(prompt_arg)},
                discover_session_id=(
                    None
                    if card.agent_id
                    else lambda: OpencodeSessions.find_new_session_id_for_workdir(
                        executable, repo_path, existing_session_ids
                    )
                ),
            )
        finally:
            try:
                os.remove(prompt_file)
            except OSError:
                pass
        if result.final_agent_message:
            return result

        session_id = result.session_id or card.agent_id
        final_message = OpencodeSessions.final_assistant_message(executable, session_id)
        if not final_message:
            return result
        return AgentRunResult(
            result.exit_code,
            result.session_id,
            final_message,
            result.stdout_lines,
            result.stderr_lines,
        )


class DeepSeekRunner(AgentRunner):
    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        executable = ToolPaths.resolve_executable(
            self.settings.deepseek_executable, AgentKind.DEEPSEEK
        )
        model_spec = self.model_spec_for(card, AgentKind.DEEPSEEK)
        existing_session_ids = DeepCodeSessions.session_ids_for_workdir(repo_path)
        prompt_file = os.path.join(
            repo_path, f".kanban-runner-prompt-{hash_path(card.path)}.md"
        )
        write_text(prompt_file, prompt)
        exclude_local_git_path(repo_path, ".kanban-runner-prompt-*.md")
        prompt_arg = (
            f"Read and follow the full runner prompt in `{prompt_file}`. "
            "It contains the kanban task file content, board root, repository path, README, and context. "
            "Do not ask what the task is or where runner.py, the board, task file, or repository are; read that file first. "
            "Do not modify the prompt file."
        )
        if card.agent_id:
            args = [executable, "--resume", card.agent_id, "-p", prompt_arg]
        else:
            args = [executable, "-p", prompt_arg]
        try:
            result = self._run_deepcode_pty_process(
                args,
                repo_path,
                prompt_arg,
                parse_deepcode_line,
                "DeepSeek",
                on_session_started,
                redacted_arg_indexes={args.index(prompt_arg)},
                discover_session_id=(
                    None
                    if card.agent_id
                    else lambda: DeepCodeSessions.find_new_session_id_for_workdir(
                        repo_path, existing_session_ids
                    )
                ),
                env_overrides=deepseek_model_environment(model_spec),
                initial_session_id=card.agent_id or "",
            )
        finally:
            try:
                os.remove(prompt_file)
            except OSError:
                pass
        if result.final_agent_message:
            return result

        session_id = result.session_id or card.agent_id
        final_message = DeepCodeSessions.final_assistant_message(repo_path, session_id)
        if not final_message:
            return result
        return AgentRunResult(
            result.exit_code,
            result.session_id,
            final_message,
            result.stdout_lines,
            result.stderr_lines,
        )

    def _run_deepcode_pty_process(
        self,
        args: list[str],
        repo_path: str,
        prompt: str,
        parse_line: Callable[[str, dict[str, str]], None],
        label: str,
        on_session_started: Callable[[str], None] | None,
        redacted_arg_indexes: set[int] | None = None,
        discover_session_id: Callable[[], str | None] | None = None,
        env_overrides: dict[str, str] | None = None,
        initial_session_id: str = "",
    ) -> AgentRunResult:
        if not IS_WINDOWS:
            raise RuntimeError("Deep Code runner support currently requires Windows pywinpty.")
        try:
            from winpty import PtyProcess
        except ImportError as exc:
            raise RuntimeError(
                "Deep Code requires a TTY. Install pywinpty for runner support: python -m pip install pywinpty"
            ) from exc

        redacted = redacted_arg_indexes or set()
        log_args = [
            "<prompt>" if index in redacted else arg
            for index, arg in enumerate(args)
        ]
        self.log.info(f"Starting {label}: {' '.join(quote_arg(arg) for arg in log_args)}")
        env = os.environ.copy()
        if env_overrides:
            env.update(env_overrides)

        process = PtyProcess.spawn(args, cwd=repo_path, env=env, dimensions=(40, 140))
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        state = {"session_id": initial_session_id, "final_agent_message": ""}
        session_reported = False
        session_lock = threading.Lock()
        output_lock = threading.Lock()
        stop_reader = threading.Event()

        def report_session_id(session_id: str) -> None:
            nonlocal session_reported
            if not session_id:
                return
            with session_lock:
                if not state.get("session_id"):
                    state["session_id"] = session_id
                if session_reported:
                    return
                session_reported = True
            if on_session_started:
                on_session_started(session_id)

        if initial_session_id:
            report_session_id(initial_session_id)

        def read_pty_output() -> None:
            pending = ""
            while process.isalive() and not stop_reader.is_set():
                try:
                    chunk = process.read(4096)
                except Exception as exc:
                    if process.isalive() and not stop_reader.is_set():
                        stderr_lines.append(str(exc))
                    break
                if not chunk:
                    continue
                text = strip_ansi(chunk).replace("\r", "\n")
                pending += text
                parts = pending.split("\n")
                pending = parts.pop() if parts else ""
                with output_lock:
                    for raw_line in parts:
                        line = raw_line.strip()
                        if not line:
                            continue
                        stdout_lines.append(line)
            if pending.strip():
                line = pending.strip()
                with output_lock:
                    stdout_lines.append(line)

        output_thread = threading.Thread(
            target=read_pty_output,
            name=f"{label}-pty-output",
            daemon=True,
        )
        output_thread.start()

        completed = False
        completed_with_status = False
        failed = False
        try:
            while process.isalive():
                if discover_session_id and not state.get("session_id"):
                    report_session_id(discover_session_id() or "")
                session_id = state.get("session_id", "")
                if session_id:
                    final_message = DeepCodeSessions.final_assistant_record_message(
                        repo_path, session_id
                    )
                    if final_message:
                        state["final_agent_message"] = final_message
                    session_status = DeepCodeSessions.session_status(repo_path, session_id)
                    if session_status in {"completed", "failed", "interrupted"}:
                        completed = True
                        failed = session_status == "failed"
                    elif session_status == "waiting_for_user":
                        questions = DeepCodeSessions.pending_user_questions(
                            repo_path, session_id
                        )
                        question_summary = "; ".join(questions)
                        if not question_summary:
                            question_summary = "Deep Code asked for user input."
                        state["final_agent_message"] = (
                            "ORCHESTRATOR_STATUS: BLOCKED\n"
                            f"ORCHESTRATOR_SUMMARY: Deep Code asked for user input: {question_summary}"
                        )
                        completed = True
                        completed_with_status = True
                        self.log.warn(
                            f"{label} entered waiting_for_user: {question_summary}"
                        )
                        break
                parsed_status = PromptFactory.parse_status(
                    state.get("final_agent_message", "")
                )
                if session_id and parsed_status != AgentOutcome.UNKNOWN:
                    completed = True
                    completed_with_status = True
                    self.log.info(
                        f"{label} wrote a parseable orchestrator status; terminating Deep Code TUI."
                    )
                    break
                if completed:
                    self.log.info(
                        f"{label} session reached terminal state; terminating Deep Code TUI."
                    )
                    break
                time.sleep(0.5)
        finally:
            if completed and process.isalive():
                try:
                    process.terminate(force=True)
                except Exception as exc:
                    stderr_lines.append(f"Failed to terminate Deep Code PTY: {exc}")
            stop_reader.set()

        if process.isalive():
            try:
                exit_code = process.wait()
            except Exception:
                exit_code = process.exitstatus
        else:
            exit_code = process.exitstatus
            if exit_code is None:
                try:
                    exit_code = process.wait()
                except Exception:
                    exit_code = 0 if completed_with_status else 1
        output_thread.join(timeout=2)

        for line in stdout_lines[-10:]:
            self.log.info(f"{label} stdout: {line}")
        for line in stderr_lines:
            self.log.warn(f"{label} stderr: {line}")

        return AgentRunResult(
            0 if completed and not failed else int(exit_code or 0),
            state.get("session_id", ""),
            state.get("final_agent_message", ""),
            stdout_lines,
            stderr_lines,
        )


class NotificationService:
    def __init__(self, log: LogSink) -> None:
        self.log = log

    def initialize(self) -> None:
        return

    def show(self, title: str, message: str, task_path: str) -> None:
        full_task_path = os.path.abspath(task_path)
        try:
            if sys.platform.startswith("win"):
                self._show_windows_toast(title, message, full_task_path)
                return
            if sys.platform.startswith("linux"):
                self._show_linux_notification(title, message, full_task_path)
                return
            if sys.platform == "darwin":
                self._show_mac_notification(title, message, full_task_path)
                return
        except Exception as exc:
            self.log.warn(f"Notification failed for `{full_task_path}`: {exc}")
        self.log.info(f"Notification: {title} - {message} ({full_task_path})")

    def _show_windows_toast(self, title: str, message: str, task_path: str) -> None:
        xml = build_toast_xml(title, message, task_path)
        encoded = base64.b64encode(xml.encode("utf-16-le")).decode("ascii")
        script = (
            "$xml=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"
            + encoded
            + "')); "
            + "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; "
            + "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null; "
            + "$doc=New-Object Windows.Data.Xml.Dom.XmlDocument; "
            + "$doc.LoadXml($xml); "
            + "$toast=[Windows.UI.Notifications.ToastNotification]::new($doc); "
            + "$notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('kanban_runner'); "
            + "$notifier.Show($toast);"
        )
        self._run_notification_process(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
            "PowerShell",
            task_path,
        )

    def _show_linux_notification(self, title: str, message: str, task_path: str) -> None:
        self._run_notification_process(
            [
                "notify-send",
                "--app-name=kanban_runner",
                "--icon=dialog-information",
                title,
                f"{message} ({task_path})",
            ],
            "notify-send",
            task_path,
        )

    def _show_mac_notification(self, title: str, message: str, task_path: str) -> None:
        self._run_notification_process(
            [
                "osascript",
                "-e",
                f"display notification {apple_script_string(f'{message} ({task_path})')} with title {apple_script_string(title)}",
            ],
            "osascript",
            task_path,
        )

    @staticmethod
    def _run_notification_process(args: list[str], tool_name: str, task_path: str) -> None:
        process = subprocess.run(args, text=True, capture_output=True, timeout=10)
        if process.returncode != 0:
            raise RuntimeError(
                f"{tool_name} exited with code {process.returncode} for `{task_path}`: {process.stderr}"
            )


class TaskCard:
    metadata_regex = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9 _-]*):[ \t]*(?P<value>.*)$", re.M)

    def __init__(self, path: str, step: TaskStep, paths: BoardPaths, content: str) -> None:
        self.path = path
        self.step = step
        self.paths = paths
        self.content = content
        self.file_name = os.path.basename(path)
        self.project_alias = self.get_metadata_value("Project") or ""
        self.agent_id = self.get_metadata_value("Agent")
        self.repo_path = self.get_metadata_value("Repo")
        self.model_value = self.get_metadata_value("Model")
        self.tags = parse_tags(self.get_metadata_value("Tags"))
        self.comments_body = self.get_section_body("Comments")
        if not self.comments_body.strip():
            self.comments_body = self.get_section_body("WIP")
        self.report_body = self.get_section_body("Report", 3)
        if not self.report_body.strip():
            self.report_body = self.get_section_body("Report")
        self.description_body = self.get_section_body("Description")

    @property
    def has_meaningful_comments(self) -> bool:
        return has_meaningful_body(self.comments_body)

    @property
    def comments_fingerprint(self) -> str:
        normalized_comments = normalize_comment_body(self.comments_body)
        return hashlib.sha256(
            normalized_comments.encode(ENCODING, errors="replace")
        ).hexdigest()

    @property
    def is_confirmed(self) -> bool:
        return self.step == TaskStep.CONFIRMED

    @property
    def is_manual(self) -> bool:
        return has_manual_agent_tag(self.tags)

    @staticmethod
    def load(path: str, step: TaskStep, paths: BoardPaths) -> "TaskCard":
        return TaskCard(path, step, paths, read_text(path))

    @staticmethod
    def read_metadata_value(content: str, key: str) -> str | None:
        for match in TaskCard.metadata_regex.finditer(content):
            if match.group("key").strip().lower() == key.lower():
                value = match.group("value").strip()
                return value or None
        return None

    def get_metadata_value(self, key: str) -> str | None:
        return self.read_metadata_value(self.content, key)

    @property
    def agent_kind_value(self) -> str | None:
        return self.get_metadata_value("Agent Kind") or self.get_metadata_value("AgentKind")

    @property
    def model_spec(self) -> ModelSpec | None:
        return parse_model_spec(self.model_value)

    def get_section_body(self, heading: str, level: int = 2) -> str:
        return get_section_body(self.content, heading, level)

    def current_template_content(self) -> str:
        try:
            return ensure_task_template(read_text(self.path))
        except OSError:
            return ensure_task_template(self.content)

    def with_updated_agent_id(
        self, agent_id: str, agent_kind: AgentKind | None = None
    ) -> "TaskCard":
        updated = self.current_template_content()
        updated = set_metadata_value(updated, "Agent", agent_id)
        if agent_kind == AgentKind.DEEPSEEK:
            updated = set_metadata_value(updated, "Agent Kind", agent_kind.value)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def with_updated_agent_kind(self, agent_kind: AgentKind) -> "TaskCard":
        return self

    def with_updated_project_alias(self, project_alias: str) -> "TaskCard":
        updated = self.current_template_content()
        updated = set_metadata_value(updated, "Project", project_alias)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def with_updated_repo_path(self, repo_path: str) -> "TaskCard":
        updated = self.current_template_content()
        updated = set_metadata_value(updated, "Repo", repo_path)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def append_comment_topic(self, note: str) -> "TaskCard":
        updated = self.current_template_content()
        existing = get_section_body(updated, "Comments")
        topic = format_comment_topic(note)
        new_comments = topic if not existing.strip() else existing.rstrip() + "\n===\n" + topic
        updated = set_section_body(updated, "Comments", new_comments)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def write(self, content: str) -> None:
        write_text(self.path, content)


def read_prompt_file_excerpt(path: str, max_chars: int) -> str:
    try:
        content = read_text(path)
    except Exception as exc:
        return f"(Could not read `{path}` before launch: {exc})"
    if len(content) <= max_chars:
        return content
    return content[:max_chars].rstrip() + "\n\n[runner.py truncated this file excerpt]"


class PromptFactory:
    status_regex = re.compile(r"^ORCHESTRATOR_STATUS:\s*(BLOCKED|DONE)\s*$", re.I | re.M)
    summary_regex = re.compile(r"^ORCHESTRATOR_SUMMARY:\s*(.+?)\s*$", re.I | re.M)

    @staticmethod
    def build(
        board_root: str,
        task_path: str,
        repo_path: str,
        run_mode: AgentRunMode,
        agent_kind: AgentKind,
    ) -> str:
        action = (
            "Start the task from scratch."
            if run_mode == AgentRunMode.NEW
            else "Resume the existing session, reread the task file, and continue from the current state."
        )
        readme_path = os.path.join(board_root, "README.md")
        context_path = os.path.join(board_root, "context.md")
        task_content = read_prompt_file_excerpt(task_path, 30_000)
        readme_content = read_prompt_file_excerpt(readme_path, 12_000)
        context_content = read_prompt_file_excerpt(context_path, 12_000)
        return f"""You are handling a kanban task for a local `runner.py` board.

Agent kind: {agent_kind.value}
Board root: {board_root}
Task file: {task_path}
Repository path: {repo_path}
Board README: {readme_path}
Shared context: {context_path}
`{{working directory}}` means `{board_root}`.

Requirements:
- Read the task file, `{{working directory}}/README.md`, and `{{working directory}}/context.md` before doing any work.
- Follow `{{working directory}}/context.md` for task-card conventions, question formatting, and report handling.
- Work only inside the repository path and the task file.
- If the repository path is not a Git repository, treat it as an empty task workspace.
- If the repository workspace is empty, that is expected for blank tasks and is not a reason to ask a question.
- Do not change `Project:`, `Model:`, `Agent:`, or `Repo:` lines.
- Keep `## Comments` and `### Report` aligned with the current state.
- Do not move the task file between folders; `runner.py` does that.
- Do not ask where the board, runner, task file, repository, README, or context file is; those exact paths are listed above.
- Do not use AskUserQuestion for information that is already present in the task file, board README, shared context, or the paths above.
- If task-specific information is truly missing and you cannot continue, write the missing question in `## Comments` and finish with `ORCHESTRATOR_STATUS: BLOCKED`.

The current task file content is included here so you do not need to ask what the task is:

--- BEGIN TASK FILE ---
{task_content}
--- END TASK FILE ---

The board README content is included here:

--- BEGIN BOARD README ---
{readme_content}
--- END BOARD README ---

The shared context content is included here:

--- BEGIN SHARED CONTEXT ---
{context_content}
--- END SHARED CONTEXT ---

Lifecycle instruction:
- {action}
- If you are blocked, finish your final message with:
  ORCHESTRATOR_STATUS: BLOCKED
  ORCHESTRATOR_SUMMARY: <one sentence>
- If you are done, finish your final message with:
  ORCHESTRATOR_STATUS: DONE
  ORCHESTRATOR_SUMMARY: <one sentence>

The final status block must be present exactly once.
"""

    @staticmethod
    def parse_status(message: str) -> AgentOutcome:
        if not message.strip():
            return AgentOutcome.UNKNOWN
        match = PromptFactory.status_regex.search(message)
        if not match:
            return AgentOutcome.UNKNOWN
        value = match.group(1).upper()
        if value == "BLOCKED":
            return AgentOutcome.BLOCKED
        if value == "DONE":
            return AgentOutcome.DONE
        return AgentOutcome.UNKNOWN

    @staticmethod
    def parse_summary(message: str) -> str:
        match = PromptFactory.summary_regex.search(message)
        return match.group(1).strip() if match else ""


class GitCli:
    @staticmethod
    def clone(
        repo_url: str,
        destination: str,
        log: LogSink,
        stop_event: threading.Event | None = None,
    ) -> None:
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        GitCli._run(["clone", repo_url, destination], log, stop_event=stop_event)

    @staticmethod
    def refresh(
        repo_path: str,
        log: LogSink,
        stop_event: threading.Event | None = None,
    ) -> None:
        if not os.path.isdir(os.path.join(repo_path, ".git")):
            return
        GitCli._run(
            ["-C", repo_path, "fetch", "--all", "--prune"],
            log,
            tolerate_failure=True,
            stop_event=stop_event,
        )
        if stop_event is not None and stop_event.is_set():
            raise ShutdownRequested("shutdown requested during git refresh")
        GitCli._run(
            ["-C", repo_path, "pull", "--ff-only"],
            log,
            tolerate_failure=True,
            stop_event=stop_event,
        )

    @staticmethod
    def _run(
        arguments: list[str],
        log: LogSink,
        tolerate_failure: bool = False,
        stop_event: threading.Event | None = None,
    ) -> None:
        if stop_event is not None and stop_event.is_set():
            raise ShutdownRequested("shutdown requested before git command")

        command = ["git", *arguments]
        git_env = {
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "never",
        }
        process = subprocess.Popen(
            command,
            env=git_env,
            text=True,
            encoding=ENCODING,
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + GIT_COMMAND_TIMEOUT_SECONDS
        while process.poll() is None:
            if stop_event is not None and stop_event.is_set():
                terminate_process_tree(process.pid)
                stdout, stderr = GitCli._communicate_after_terminate(process)
                GitCli._log_output(stdout, stderr, log)
                log.info(
                    f"Terminated git {' '.join(arguments)} because shutdown was requested."
                )
                raise ShutdownRequested("shutdown requested during git command")
            if time.monotonic() >= deadline:
                terminate_process_tree(process.pid)
                stdout, stderr = GitCli._communicate_after_terminate(process)
                GitCli._log_output(stdout, stderr, log)
                if not tolerate_failure:
                    raise RuntimeError(
                        f"git {' '.join(arguments)} timed out after {GIT_COMMAND_TIMEOUT_SECONDS} seconds"
                    )
                log.warn(
                    f"git {' '.join(arguments)} timed out after {GIT_COMMAND_TIMEOUT_SECONDS} seconds"
                )
                return
            time.sleep(0.2)

        stdout, stderr = process.communicate()
        GitCli._log_output(stdout, stderr, log)
        if process.returncode != 0 and not tolerate_failure:
            raise RuntimeError(f"git {' '.join(arguments)} failed with exit code {process.returncode}")

    @staticmethod
    def _communicate_after_terminate(process: subprocess.Popen[str]) -> tuple[str, str]:
        try:
            return process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            terminate_process_tree(process.pid)
            return process.communicate()

    @staticmethod
    def _log_output(stdout: str | None, stderr: str | None, log: LogSink) -> None:
        if stdout and stdout.strip():
            log.info(stdout.strip())
        if stderr and stderr.strip():
            log.warn(stderr.strip())


class ProjectMap(dict[str, str]):
    def __setitem__(self, key: str, value: str) -> None:
        super().__setitem__(key.strip().lower(), value)

    def __contains__(self, key: object) -> bool:
        if isinstance(key, str):
            return super().__contains__(key.strip().lower())
        return False

    def __getitem__(self, key: str) -> str:
        return super().__getitem__(key.strip().lower())

    @staticmethod
    def load(path: str, log: LogSink) -> "ProjectMap":
        result = ProjectMap()
        if not os.path.exists(path):
            return result
        for raw_line in read_text(path).splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                log.warn(f"Ignoring malformed projects.md line: {line}")
                continue
            alias, repo_url = [part.strip() for part in line.split("=", 1)]
            if not alias or not repo_url:
                log.warn(f"Ignoring malformed projects.md line: {line}")
                continue
            result[alias] = repo_url
        return result


class ProjectAliases:
    BLANK_WORKSPACE_ALIAS = "blank"

    @staticmethod
    def is_blank(alias: str | None) -> bool:
        normalized = (alias or "").strip()
        return normalized.lower() == ProjectAliases.BLANK_WORKSPACE_ALIAS or normalized == "-"


class BoardTemplates:
    @staticmethod
    def projects_template() -> str:
        return "blank = https://github.com/flcl42/blank.git\n"

    @staticmethod
    def default_gitignore_template() -> str:
        return "projects/\ncache/\ntrash/\nlogs/\n"

    @staticmethod
    def default_context_template() -> str:
        return """# Context

- Read the task card and this file before starting.
- Keep work inside the assigned repository and task file.
- Check `knowledge/README.md` for shared board notes.
- Put completion notes in the task report.
"""

    @staticmethod
    def default_knowledge_readme_template() -> str:
        return """# Knowledge

Add durable board notes, links, and project references here.
"""

    @staticmethod
    def default_task_template() -> str:
        return """# {{TITLE}}

Tags: 
Project: {{CURSOR}}
Model: 

## Description


"""

    @staticmethod
    def resolve_context_template(invocation_directory: str) -> str:
        return read_seed_file(
            invocation_directory, "context.md", BoardTemplates.default_context_template()
        )

    @staticmethod
    def resolve_knowledge_readme_template(invocation_directory: str) -> str:
        return read_seed_file(
            invocation_directory,
            os.path.join("knowledge", "README.md"),
            BoardTemplates.default_knowledge_readme_template(),
        )

    @staticmethod
    def resolve_task_template(invocation_directory: str) -> str:
        return read_seed_file(
            invocation_directory,
            os.path.join("tasks", "template.md"),
            BoardTemplates.default_task_template(),
        )

    @staticmethod
    def resolve_gitignore_template(invocation_directory: str) -> str:
        return read_seed_file(
            invocation_directory, ".gitignore", BoardTemplates.default_gitignore_template()
        )

    @staticmethod
    def create_kanban_config(folders: Iterable[KanbanFolder]) -> str:
        lines = [
            "defaultModels:",
            '  codex: ""',
            '  claude: ""',
            '  kimi: ""',
            '  deepseek: ""',
            '  opencode: ""',
            "folders:",
        ]
        for folder in folders:
            lines.append(f"  {folder.name}: {folder.name}")
        lines.extend([
            "ignoreFolders:",
            "  - projects",
            "  - cache",
            "  - trash",
            "  - logs",
        ])
        return "\n".join(lines) + "\n"


class ToolPaths:
    @staticmethod
    def resolve_executable(configured_executable: str, kind: AgentKind) -> str:
        executable = normalize_executable(configured_executable)
        candidates: list[str] = []
        if is_path_like(executable):
            candidates.extend(executable_candidates(executable))
        else:
            found = shutil.which(executable)
            if found:
                candidates.append(found)
            for directory in os.environ.get("PATH", "").split(os.pathsep):
                if directory.strip():
                    candidates.extend(executable_candidates(os.path.join(directory, executable)))

        home = str(Path.home())
        if kind == AgentKind.CODEX and executable.lower() == "codex" and home:
            candidates.extend(
                [
                    os.path.join(home, ".codex", ".sandbox-bin", "codex.exe"),
                    os.path.join(home, ".codex", ".sandbox-bin", "codex"),
                ]
            )
        if kind == AgentKind.KIMI and executable.lower() == "kimi" and home:
            candidates.extend(
                [
                    os.path.join(home, ".kimi-code", "bin", "kimi.exe"),
                    os.path.join(home, ".kimi-code", "bin", "kimi"),
                ]
            )
        if kind == AgentKind.OPENCODE and executable.lower() in {"opencode", "oc"}:
            alternate = "opencode" if executable.lower() == "oc" else "oc"
            found = shutil.which(alternate)
            if found:
                candidates.append(found)

        seen: set[str] = set()
        for candidate in candidates:
            normalized = normalize_path(candidate)
            if normalized in seen:
                continue
            seen.add(normalized)
            if os.path.isfile(candidate):
                return candidate
        raise FileNotFoundError(
            f"Unable to locate configured {kind.value} executable `{executable}` on PATH or at the configured path."
        )


class KimiSessions:
    @staticmethod
    def index_path() -> str:
        return os.path.join(str(Path.home()), ".kimi-code", "session_index.jsonl")

    @staticmethod
    def session_ids_for_workdir(workdir: str) -> set[str]:
        session_ids: set[str] = set()
        normalized_workdir = normalize_path(workdir)
        for entry in KimiSessions._read_index():
            session_id = KimiSessions._session_id_for_entry(entry, normalized_workdir)
            if session_id:
                session_ids.add(session_id)
        return session_ids

    @staticmethod
    def find_new_session_id_for_workdir(
        workdir: str, existing_session_ids: set[str]
    ) -> str | None:
        normalized_workdir = normalize_path(workdir)
        for entry in reversed(KimiSessions._read_index()):
            session_id = KimiSessions._session_id_for_entry(entry, normalized_workdir)
            if session_id and session_id not in existing_session_ids:
                return session_id
        return None

    @staticmethod
    def _session_id_for_entry(entry: dict[str, object], normalized_workdir: str) -> str | None:
        session_id = entry.get("sessionId")
        workdir = entry.get("workDir")
        if not isinstance(session_id, str) or not isinstance(workdir, str):
            return None
        session_id = session_id.strip()
        if agent_kind_from_agent_id(session_id) != AgentKind.KIMI:
            return None
        if normalize_path(workdir) != normalized_workdir:
            return None
        return session_id

    @staticmethod
    def _read_index() -> list[dict[str, object]]:
        path = KimiSessions.index_path()
        if not os.path.exists(path):
            return []
        entries: list[dict[str, object]] = []
        try:
            with open(path, "r", encoding=ENCODING, errors="replace") as handle:
                for line in handle:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(entry, dict):
                        entries.append(entry)
        except OSError:
            return []
        return entries


class DeepCodeSessions:
    @staticmethod
    def project_dir(workdir: str) -> str:
        return os.path.join(str(Path.home()), ".deepcode", "projects", deepcode_project_code(workdir))

    @staticmethod
    def index_path(workdir: str) -> str:
        return os.path.join(DeepCodeSessions.project_dir(workdir), "sessions-index.json")

    @staticmethod
    def session_ids_for_workdir(workdir: str) -> set[str]:
        return {
            session_id
            for session_id in (
                DeepCodeSessions._session_id_for_entry(entry)
                for entry in DeepCodeSessions._read_index(workdir)
            )
            if session_id
        }

    @staticmethod
    def find_new_session_id_for_workdir(
        workdir: str, existing_session_ids: set[str]
    ) -> str | None:
        for entry in reversed(DeepCodeSessions._read_index(workdir)):
            session_id = DeepCodeSessions._session_id_for_entry(entry)
            if session_id and session_id not in existing_session_ids:
                return session_id
        return None

    @staticmethod
    def session_file(workdir: str, session_id: str | None) -> str | None:
        if not is_deepcode_session_id(session_id):
            return None
        path = os.path.join(DeepCodeSessions.project_dir(workdir), f"{session_id}.jsonl")
        return path if os.path.isfile(path) else None

    @staticmethod
    def final_assistant_message(workdir: str, session_id: str | None) -> str:
        text = DeepCodeSessions.final_assistant_record_message(workdir, session_id)
        if text:
            return text

        for entry in reversed(DeepCodeSessions._read_index(workdir)):
            if DeepCodeSessions._session_id_for_entry(entry) != session_id:
                continue
            reply = entry.get("assistantReply")
            if isinstance(reply, str) and reply.strip():
                return reply.strip()
        return ""

    @staticmethod
    def final_assistant_record_message(workdir: str, session_id: str | None) -> str:
        session_file = DeepCodeSessions.session_file(workdir, session_id)
        if not session_file:
            return ""
        try:
            with open(session_file, "r", encoding=ENCODING, errors="replace") as handle:
                lines = [line for line in handle if line.strip()]
            for line in reversed(lines):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = extract_deepcode_message_text(entry)
                if text:
                    return text
        except OSError:
            return ""
        return ""

    @staticmethod
    def pending_user_questions(workdir: str, session_id: str | None) -> list[str]:
        session_file = DeepCodeSessions.session_file(workdir, session_id)
        if not session_file:
            return []
        try:
            with open(session_file, "r", encoding=ENCODING, errors="replace") as handle:
                lines = [line for line in handle if line.strip()]
            for line in reversed(lines):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                questions = extract_deepcode_user_questions(entry)
                if questions:
                    return questions
        except OSError:
            return []
        return []

    @staticmethod
    def session_status(workdir: str, session_id: str | None) -> str:
        if not session_id:
            return ""
        for entry in reversed(DeepCodeSessions._read_index(workdir)):
            if DeepCodeSessions._session_id_for_entry(entry) != session_id:
                continue
            return str(entry.get("status") or "").strip().lower()
        return ""

    @staticmethod
    def _session_id_for_entry(entry: dict[str, object]) -> str | None:
        session_id = entry.get("id")
        if not isinstance(session_id, str):
            return None
        session_id = session_id.strip()
        if not is_deepcode_session_id(session_id):
            return None
        return session_id

    @staticmethod
    def _read_index(workdir: str) -> list[dict[str, object]]:
        path = DeepCodeSessions.index_path(workdir)
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding=ENCODING, errors="replace") as handle:
                parsed = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return []
        entries = parsed.get("entries") if isinstance(parsed, dict) else None
        if not isinstance(entries, list):
            return []
        return [entry for entry in entries if isinstance(entry, dict)]


class OpencodeSessions:
    @staticmethod
    def session_ids_for_workdir(executable: str, workdir: str) -> set[str]:
        normalized_workdir = normalize_path(workdir)
        return {
            session_id
            for session_id in (
                OpencodeSessions._session_id_for_entry(entry, normalized_workdir)
                for entry in OpencodeSessions._list_sessions(executable)
            )
            if session_id
        }

    @staticmethod
    def find_new_session_id_for_workdir(
        executable: str, workdir: str, existing_session_ids: set[str]
    ) -> str | None:
        normalized_workdir = normalize_path(workdir)
        for entry in reversed(OpencodeSessions._list_sessions(executable)):
            session_id = OpencodeSessions._session_id_for_entry(entry, normalized_workdir)
            if session_id and session_id not in existing_session_ids:
                return session_id
        return None

    @staticmethod
    def session_directory(executable: str, session_id: str | None) -> str | None:
        if not is_opencode_session_id(session_id):
            return None
        for entry in reversed(OpencodeSessions._list_sessions(executable)):
            if str(entry.get("id") or "").strip() != session_id:
                continue
            directory = entry.get("directory")
            if isinstance(directory, str) and directory.strip():
                return directory.strip()
        return None

    @staticmethod
    def final_assistant_message(executable: str, session_id: str | None) -> str:
        if not is_opencode_session_id(session_id):
            return ""
        exported = OpencodeSessions._export_session(executable, session_id or "")
        if not exported:
            return ""
        return extract_opencode_export_assistant_message(exported)

    @staticmethod
    def _session_id_for_entry(
        entry: dict[str, object], normalized_workdir: str | None = None
    ) -> str | None:
        session_id = entry.get("id")
        if not isinstance(session_id, str) or not is_opencode_session_id(session_id):
            return None
        if normalized_workdir is None:
            return session_id.strip()
        directory = entry.get("directory")
        if not isinstance(directory, str):
            return None
        if normalize_path(directory) != normalized_workdir:
            return None
        return session_id.strip()

    @staticmethod
    def _list_sessions(executable: str) -> list[dict[str, object]]:
        try:
            result = subprocess.run(
                [
                    executable,
                    "session",
                    "list",
                    "--format",
                    "json",
                    "--max-count",
                    "200",
                ],
                text=True,
                encoding=ENCODING,
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        if result.returncode != 0 or not result.stdout.strip():
            return []
        parsed = parse_first_json_value(result.stdout)
        if isinstance(parsed, list):
            return [entry for entry in parsed if isinstance(entry, dict)]
        if isinstance(parsed, dict):
            return [parsed]
        return []

    @staticmethod
    def _export_session(executable: str, session_id: str) -> dict[str, object] | None:
        try:
            result = subprocess.run(
                [executable, "export", session_id],
                text=True,
                encoding=ENCODING,
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0 or not result.stdout.strip():
            return None
        parsed = parse_first_json_value(result.stdout)
        return parsed if isinstance(parsed, dict) else None


def parse_codex_mode(value: str) -> CodexMode:
    normalized = value.strip().replace("-", "").replace("_", "").lower()
    if normalized == "dangerous":
        return CodexMode.DANGEROUS
    if normalized == "fullauto":
        return CodexMode.FULL_AUTO
    raise ValueError(f"Unsupported Codex mode: {value}")


def parse_default_agent(value: str | None) -> DefaultAgentSelection:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"", "null", "none", "auto", "detect"}:
        return None
    if normalized in {"manual", "human"}:
        return MANUAL_AGENT_VALUE
    if normalized == "claude":
        return AgentKind.CLAUDE
    if normalized == "codex":
        return AgentKind.CODEX
    if normalized == "kimi":
        return AgentKind.KIMI
    if normalized in {"deepseek", "deepcode", "ds"}:
        return AgentKind.DEEPSEEK
    if normalized in {"opencode", "oc"}:
        return AgentKind.OPENCODE
    raise ValueError(
        "Default agent must be auto, claude, codex, opencode, kimi, deepseek, or manual."
    )


def format_default_agent(value: DefaultAgentSelection) -> str:
    if value is None:
        return "auto"
    if isinstance(value, AgentKind):
        return value.value
    return value


def agent_kind_from_value(value: str | None) -> AgentKind | None:
    if value is None:
        return None
    normalized = normalize_tag(value)
    if normalized in {"claude", "agent:claude", "agent=claude"}:
        return AgentKind.CLAUDE
    if normalized in {"codex", "agent:codex", "agent=codex"}:
        return AgentKind.CODEX
    if normalized in {"kimi", "agent:kimi", "agent=kimi"}:
        return AgentKind.KIMI
    if normalized in {
        "opencode",
        "oc",
        "agent:opencode",
        "agent=opencode",
        "agent:oc",
        "agent=oc",
    }:
        return AgentKind.OPENCODE
    if normalized in {
        "deepseek",
        "deepcode",
        "ds",
        "agent:deepseek",
        "agent=deepseek",
        "agent:deepcode",
        "agent=deepcode",
        "agent:ds",
        "agent=ds",
    }:
        return AgentKind.DEEPSEEK
    return None


def parse_model_spec(value: str | None) -> ModelSpec | None:
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None

    parts = [part.strip() for part in raw.split("/")]
    if any(not part for part in parts):
        raise ValueError(f"`Model: {raw}` contains an empty segment.")

    agent_kind = agent_kind_from_value(parts[0])
    if not agent_kind:
        return ModelSpec(raw=raw, agent_kind=None, model=raw, effort=None)

    if len(parts) < 2:
        raise ValueError(
            f"`Model: {raw}` must use `agent/model` or `agent/model/effort`."
        )
    model_parts = parts[1:]
    effort = None
    if len(model_parts) > 1 and model_parts[-1].strip().lower() in MODEL_EFFORT_LEVELS:
        effort = normalize_model_effort(model_parts[-1])
        model_parts = model_parts[:-1]
    model = "/".join(model_parts)
    if not model.strip():
        raise ValueError(f"`Model: {raw}` contains an empty model segment.")
    return ModelSpec(raw=raw, agent_kind=agent_kind, model=model, effort=effort)


def parse_default_model_settings(
    values: dict[str, object] | None, source: str
) -> dict[AgentKind, ModelSpec]:
    if not values:
        return {}

    parsed: dict[AgentKind, ModelSpec] = {}
    for key, value in values.items():
        agent_kind = agent_kind_from_value(key)
        if not agent_kind:
            continue
        if not isinstance(value, str) or not value.strip():
            continue
        try:
            parsed[agent_kind] = parse_agent_default_model(agent_kind, value)
        except ValueError as exc:
            raise ValueError(f"Invalid {source}.{key}: {exc}") from exc
    return parsed


def parse_agent_default_model(agent_kind: AgentKind, value: str) -> ModelSpec:
    raw = value.strip()
    parts = [part.strip() for part in raw.split("/")]
    if any(not part for part in parts):
        raise ValueError(f"`{raw}` contains an empty segment.")

    explicit_agent = agent_kind_from_value(parts[0])
    if explicit_agent:
        spec = parse_model_spec(raw)
        if spec is None or spec.agent_kind != agent_kind:
            raise ValueError(
                f"`{raw}` selects `{explicit_agent.value}`, but this default belongs to `{agent_kind.value}`."
            )
        return spec

    effort = None
    model = raw
    if len(parts) > 1 and parts[-1].strip().lower() in MODEL_EFFORT_LEVELS:
        effort = normalize_model_effort(parts[-1])
        model = "/".join(parts[:-1])
        if not model.strip():
            raise ValueError(f"`{raw}` contains an empty model segment.")
    return ModelSpec(
        raw=f"{agent_kind.value}/{raw}",
        agent_kind=agent_kind,
        model=model,
        effort=effort,
    )


def read_board_default_models(root_path: str) -> dict[AgentKind, ModelSpec]:
    marker_path = BoardPaths(root_path).kanban_marker_path
    if not os.path.exists(marker_path):
        return {}
    try:
        with open(marker_path, "r", encoding=ENCODING, errors="replace") as handle:
            values = parse_kanban_default_models(handle.read())
    except OSError:
        return {}
    return parse_default_model_settings(values, f"{marker_path}:defaultModels")


def parse_kanban_default_models(content: str) -> dict[str, object]:
    lines = content.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$", line)
        if not match:
            continue
        if match.group(1) not in {
            "defaultModels",
            "defaultAgentModels",
            "agentDefaultModels",
        }:
            continue
        inline_value = strip_yaml_comment(match.group(2)).strip()
        if inline_value:
            return {}
        return parse_indented_string_map(lines[index + 1 :])
    return {}


def parse_indented_string_map(lines: list[str]) -> dict[str, object]:
    result: dict[str, object] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            break
        match = re.match(r"^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$", line)
        if not match:
            continue
        value = strip_yaml_comment(match.group(2)).strip()
        result[match.group(1)] = unquote_yaml_scalar(value)
    return result


def strip_yaml_comment(value: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if in_double and char == "\\":
            escaped = True
            continue
        if char == "'" and not in_double:
            in_single = not in_single
            continue
        if char == '"' and not in_single:
            in_double = not in_double
            continue
        if char == "#" and not in_single and not in_double:
            return value[:index]
    return value


def unquote_yaml_scalar(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def normalize_model_effort(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in MODEL_EFFORT_LEVELS:
        raise ValueError(
            f"Unsupported model effort `{value}`. Use one of: "
            + ", ".join(sorted(MODEL_EFFORT_LEVELS))
            + "."
        )
    return normalized


def agent_kind_from_agent_id(value: str | None) -> AgentKind | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if is_opencode_session_id(normalized):
        return AgentKind.OPENCODE
    if re.fullmatch(
        r"session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        normalized,
    ):
        return AgentKind.KIMI
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        normalized,
    ):
        return None
    version = normalized[14]
    if version == "7":
        return AgentKind.CODEX
    if version == "4":
        return AgentKind.CLAUDE
    return None


def is_deepcode_session_id(value: str | None) -> bool:
    if value is None:
        return False
    return bool(
        re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            value.strip().lower(),
        )
    )


def is_opencode_session_id(value: str | None) -> bool:
    if value is None:
        return False
    return bool(re.fullmatch(r"ses_[a-z0-9]+", value.strip(), re.I))


def agent_kind_from_tags(tags: Sequence[str]) -> AgentKind | None:
    normalized_tags = {normalize_tag(tag) for tag in tags}
    claude_markers = {
        "claude",
        "agent:claude",
        "agent=claude",
        "ai:claude",
        "runner:claude",
        "use:claude",
        "use-claude",
    }
    codex_markers = {
        "codex",
        "agent:codex",
        "agent=codex",
        "ai:codex",
        "runner:codex",
        "use:codex",
        "use-codex",
    }
    kimi_markers = {
        "kimi",
        "agent:kimi",
        "agent=kimi",
        "ai:kimi",
        "runner:kimi",
        "use:kimi",
        "use-kimi",
    }
    opencode_markers = {
        "opencode",
        "oc",
        "agent:opencode",
        "agent=opencode",
        "agent:oc",
        "agent=oc",
        "ai:opencode",
        "ai:oc",
        "runner:opencode",
        "runner:oc",
        "use:opencode",
        "use:oc",
        "use-opencode",
        "use-oc",
    }
    deepseek_markers = {
        "deepseek",
        "deepcode",
        "ds",
        "agent:deepseek",
        "agent=deepseek",
        "agent:deepcode",
        "agent=deepcode",
        "agent:ds",
        "agent=ds",
        "ai:deepseek",
        "ai:deepcode",
        "ai:ds",
        "runner:deepseek",
        "runner:deepcode",
        "runner:ds",
        "use:deepseek",
        "use:deepcode",
        "use:ds",
        "use-deepseek",
        "use-deepcode",
        "use-ds",
    }
    has_claude = bool(normalized_tags & claude_markers)
    has_codex = bool(normalized_tags & codex_markers)
    has_kimi = bool(normalized_tags & kimi_markers)
    has_opencode = bool(normalized_tags & opencode_markers)
    has_deepseek = bool(normalized_tags & deepseek_markers)
    if has_claude and not has_codex and not has_kimi and not has_opencode and not has_deepseek:
        return AgentKind.CLAUDE
    if has_codex and not has_claude and not has_kimi and not has_opencode and not has_deepseek:
        return AgentKind.CODEX
    if has_kimi and not has_claude and not has_codex and not has_opencode and not has_deepseek:
        return AgentKind.KIMI
    if has_opencode and not has_claude and not has_codex and not has_kimi and not has_deepseek:
        return AgentKind.OPENCODE
    if has_deepseek and not has_claude and not has_codex and not has_kimi and not has_opencode:
        return AgentKind.DEEPSEEK
    return None


def has_manual_agent_tag(tags: Sequence[str]) -> bool:
    normalized_tags = {normalize_tag(tag) for tag in tags}
    manual_markers = {
        "manual",
        "human",
        "agent:manual",
        "agent=manual",
        "agent:human",
        "agent=human",
        "ai:manual",
        "ai:human",
        "runner:manual",
        "runner:human",
        "use:manual",
        "use:human",
        "use-manual",
        "use-human",
        "no-agent",
        "noagent",
        "user-managed",
    }
    return bool(normalized_tags & manual_markers)


def parse_tags(value: str | None) -> list[str]:
    if not value:
        return []
    return [
        item.strip()
        for item in re.split(r"[,;\s]+", value)
        if item.strip()
    ]


def normalize_tag(value: str) -> str:
    return value.strip().lstrip("#").lower()


def deepcode_project_code(project_root: str) -> str:
    legacy_code = project_root.replace("\\", "-").replace("/", "-").replace(":", "")
    if len(legacy_code) <= 64:
        return legacy_code
    normalized_root = os.path.abspath(project_root)
    hash_input = normalized_root.lower() if IS_WINDOWS else normalized_root
    digest = hashlib.sha256(hash_input.encode(ENCODING)).hexdigest()[:16]
    prefix_limit = 64 - 16 - 1
    prefix = sanitize_deepcode_project_code_part(os.path.basename(normalized_root))[
        :prefix_limit
    ].rstrip("-.")
    return f"{prefix or 'project'}-{digest}"


def sanitize_deepcode_project_code_part(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "-", value)
    sanitized = re.sub(r"-+", "-", sanitized)
    return sanitized.strip("-.")


def codex_model_arguments(model_spec: ModelSpec | None) -> list[str]:
    if not model_spec:
        return []
    args = ["--model", model_spec.model]
    if model_spec.effort:
        args.extend(["-c", f'model_reasoning_effort="{model_spec.effort}"'])
    return args


def claude_model_arguments(model_spec: ModelSpec | None) -> list[str]:
    if not model_spec:
        return []
    args = ["--model", model_spec.model]
    if model_spec.effort:
        args.extend(["--effort", model_spec.effort])
    return args


def kimi_model_arguments(model_spec: ModelSpec | None) -> list[str]:
    if not model_spec:
        return []
    return ["--model", resolve_kimi_model_alias(model_spec.model)]


def kimi_environment(model_spec: ModelSpec | None) -> dict[str, str]:
    if not model_spec or not model_spec.effort:
        return {}
    return {"KIMI_MODEL_THINKING_EFFORT": model_spec.effort}


def resolve_kimi_model_alias(model: str) -> str:
    aliases = configured_kimi_model_aliases()
    if not aliases:
        return model
    by_lower = {alias.lower(): alias for alias in aliases}
    existing = by_lower.get(model.lower())
    if existing:
        return existing
    if "/" not in model:
        kimi_code_alias = by_lower.get(f"kimi-code/{model}".lower())
        if kimi_code_alias:
            return kimi_code_alias
        suffix_matches = [
            alias for alias in aliases if alias.lower().endswith("/" + model.lower())
        ]
        if len(suffix_matches) == 1:
            return suffix_matches[0]
    return model


def configured_kimi_model_aliases() -> list[str]:
    config_path = Path(kimi_home_path()) / "config.toml"
    try:
        content = read_text(str(config_path))
    except OSError:
        return []
    aliases: list[str] = []
    seen: set[str] = set()
    for line in content.replace("\r\n", "\n").split("\n"):
        match = re.match(r'^\s*\[models\."([^"]+)"\]\s*$', line)
        if not match:
            match = re.match(r"^\s*\[models\.([^\]\s]+)\]\s*$", line)
        if not match:
            continue
        alias = match.group(1).strip()
        normalized = alias.lower()
        if alias and normalized not in seen:
            seen.add(normalized)
            aliases.append(alias)
    return aliases


def trust_kimi_workspace(work_dir: str) -> None:
    expanded = os.path.expanduser(os.path.expandvars(work_dir))
    root = ntpath.abspath(expanded) if is_windows_absolute_path(expanded) else os.path.abspath(expanded)
    key = encode_kimi_workdir_key(root)
    trust_dir = os.path.join(kimi_home_path(), "workspace-trust")
    os.makedirs(trust_dir, exist_ok=True)
    trust_path = os.path.join(trust_dir, key)
    if os.path.exists(trust_path):
        return
    payload = {
        "root": root,
        "trustedAt": int(time.time() * 1000),
    }
    write_text(trust_path, json.dumps(payload, separators=(",", ":")))


def kimi_home_path() -> str:
    configured_home = os.environ.get("KIMI_CODE_HOME", "").strip()
    if configured_home:
        return os.path.abspath(os.path.expanduser(os.path.expandvars(configured_home)))
    return os.path.join(str(Path.home()), ".kimi-code")


def encode_kimi_workdir_key(work_dir: str) -> str:
    normalized = normalize_kimi_workdir(work_dir)
    name = normalized.replace("\\", "/").split("/")[-1] or normalized
    slug = slugify_kimi_workdir_name(name)
    digest = hashlib.sha256(normalized.encode(ENCODING)).hexdigest()[:12]
    return f"wd_{slug}_{digest}"


def normalize_kimi_workdir(work_dir: str) -> str:
    if is_windows_absolute_path(work_dir):
        normalized = ntpath.abspath(work_dir).replace("\\", "/")
    else:
        normalized = os.path.abspath(work_dir).replace("\\", "/")
    if len(normalized) > 3:
        normalized = normalized.rstrip("/")
    return normalized


def is_windows_absolute_path(value: str) -> bool:
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)", value))


def slugify_kimi_workdir_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-")[:40].strip("-")
    return slug if slug and slug not in {".", ".."} else "workspace"


def deepseek_model_environment(model_spec: ModelSpec | None) -> dict[str, str]:
    if not model_spec:
        return {}
    env = {"DEEPCODE_MODEL": model_spec.model}
    if model_spec.effort:
        if model_spec.effort not in {"high", "max"}:
            raise ValueError(
                f"`Model: {model_spec.raw}` sets effort `{model_spec.effort}`, but Deep Code supports only high or max reasoning effort."
            )
        env["DEEPCODE_THINKING_ENABLED"] = "true"
        env["DEEPCODE_REASONING_EFFORT"] = model_spec.effort
    return env


def opencode_model_arguments(model_spec: ModelSpec | None) -> list[str]:
    if not model_spec:
        return []
    args = ["--model", model_spec.model]
    if model_spec.effort:
        args.extend(["--variant", model_spec.effort])
    return args


def codex_mode_arguments(mode: CodexMode) -> list[str]:
    if mode == CodexMode.DANGEROUS:
        return ["--dangerously-bypass-approvals-and-sandbox"]
    if mode == CodexMode.FULL_AUTO:
        return ["--full-auto"]
    raise ValueError(f"Unsupported Codex mode: {mode}")


def claude_permission_arguments(mode: CodexMode) -> list[str]:
    if mode == CodexMode.DANGEROUS:
        return ["--permission-mode", "bypassPermissions"]
    if mode == CodexMode.FULL_AUTO:
        return ["--permission-mode", "auto"]
    raise ValueError(f"Unsupported Codex mode: {mode}")


def opencode_permission_arguments(mode: CodexMode) -> list[str]:
    if mode in {CodexMode.DANGEROUS, CodexMode.FULL_AUTO}:
        return ["--auto"]
    raise ValueError(f"Unsupported Codex mode: {mode}")


def parse_codex_json_line(line: str, state: dict[str, str]) -> None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return
    event_type = str(payload.get("type", ""))
    if event_type.lower() == "thread.started":
        state["session_id"] = str(payload.get("thread_id") or "")
        return
    if event_type.lower() != "item.completed":
        return
    item = payload.get("item")
    if not isinstance(item, dict):
        return
    if str(item.get("type", "")).lower() == "agent_message":
        state["final_agent_message"] = str(item.get("text") or "")


def parse_claude_json_line(line: str, state: dict[str, str]) -> None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        if line.strip():
            state["final_agent_message"] = line
        return

    session_id = find_nested_string(payload, "session_id") or find_nested_string(payload, "sessionId")
    if session_id:
        state["session_id"] = session_id

    event_type = str(payload.get("type", "")).lower()
    if event_type == "result":
        result = payload.get("result")
        if isinstance(result, str):
            state["final_agent_message"] = result
            return
    text = ""
    if event_type == "assistant":
        message = payload.get("message")
        text = extract_claude_message_text(message)
    if text:
        state["final_agent_message"] = text


def parse_kimi_json_line(line: str, state: dict[str, str]) -> None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        if line.strip():
            state["final_agent_message"] = line
        return

    session_id = (
        find_nested_string(payload, "session_id")
        or find_nested_string(payload, "sessionId")
    )
    if session_id and agent_kind_from_agent_id(session_id) == AgentKind.KIMI:
        state["session_id"] = session_id

    role = str(payload.get("role", "")).lower()
    if role == "assistant" and isinstance(payload.get("content"), str):
        state["final_agent_message"] = str(payload.get("content") or "")


def parse_opencode_json_line(line: str, state: dict[str, str]) -> None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        if "ORCHESTRATOR_STATUS:" in line:
            state["final_agent_message"] = line
        return

    session_id = (
        find_nested_string(payload, "sessionID")
        or find_nested_string(payload, "sessionId")
        or find_nested_string(payload, "session_id")
    )
    if session_id and is_opencode_session_id(session_id):
        state["session_id"] = session_id

    text = extract_opencode_message_text(payload)
    if text:
        state["final_agent_message"] = text


def parse_deepcode_line(line: str, state: dict[str, str]) -> None:
    text = strip_ansi(line).strip()
    if not text:
        return
    session_match = re.search(
        r"deepcode\s+(?:--resume|-r)\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
        text,
        re.I,
    )
    if session_match:
        state["session_id"] = session_match.group(1)
    if "ORCHESTRATOR_STATUS:" in text:
        state["final_agent_message"] = text


def extract_deepcode_message_text(entry: object) -> str:
    if not isinstance(entry, dict):
        return ""
    if str(entry.get("role", "")).lower() != "assistant":
        return ""
    content = entry.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    message_params = entry.get("messageParams")
    if isinstance(message_params, dict):
        reasoning = message_params.get("reasoning_content")
        if isinstance(reasoning, str) and "ORCHESTRATOR_STATUS:" in reasoning:
            return reasoning.strip()
    return ""


def extract_deepcode_user_questions(entry: object) -> list[str]:
    if not isinstance(entry, dict):
        return []
    if str(entry.get("role", "")).lower() != "tool":
        return []
    content = entry.get("content")
    if not isinstance(content, str) or not content.strip():
        return []
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict) or payload.get("awaitUserResponse") is not True:
        return []
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("kind") != "ask_user_question":
        return []
    questions = metadata.get("questions")
    if not isinstance(questions, list):
        return []
    result: list[str] = []
    for item in questions:
        if not isinstance(item, dict):
            continue
        question = item.get("question")
        if isinstance(question, str) and question.strip():
            result.append(question.strip())
    return result


def strip_ansi(value: str) -> str:
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)


def find_nested_string(value: object, key: str) -> str | None:
    if isinstance(value, dict):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        for child in value.values():
            found = find_nested_string(child, key)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_nested_string(child, key)
            if found:
                return found
    return None


def extract_claude_message_text(message: object) -> str:
    if isinstance(message, str):
        return message
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()
    return ""


def extract_opencode_message_text(entry: object) -> str:
    if not isinstance(entry, dict):
        return ""
    role = str(
        entry.get("role")
        or (entry.get("info") if isinstance(entry.get("info"), dict) else {}).get("role")
        or ""
    ).lower()
    if role and role != "assistant":
        return ""
    content = entry.get("content") or entry.get("text")
    if isinstance(content, str) and content.strip():
        return content.strip()
    parts = entry.get("parts")
    if isinstance(parts, list):
        text_parts = [
            str(part.get("text") or "").strip()
            for part in parts
            if isinstance(part, dict) and str(part.get("type") or "").lower() == "text"
        ]
        return "\n".join(part for part in text_parts if part).strip()
    message = entry.get("message")
    if isinstance(message, dict):
        return extract_opencode_message_text(message)
    return ""


def extract_opencode_export_assistant_message(exported: dict[str, object]) -> str:
    messages = exported.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        text = extract_opencode_message_text(message)
        if text:
            return text
    return ""


def parse_first_json_value(text: str) -> object | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, _end = decoder.raw_decode(text[index:])
            return value
        except json.JSONDecodeError:
            continue
    return None


def task_title(card: "TaskCard") -> str:
    match = re.search(r"(?m)^\s*#{1,6}\s+(.+?)\s*$", card.content)
    if match:
        title = match.group(1).strip()
        if title:
            return title[:120]
    fallback = os.path.splitext(os.path.basename(card.path))[0].replace("-", " ").strip()
    return fallback[:120] if fallback else "Kanban task"


def get_section_body(content: str, heading: str, level: int = 2) -> str:
    marker = re.escape("#" * level)
    match = re.search(
        rf"(?ms)^{marker}\s+{re.escape(heading)}\s*\r?\n(?P<body>.*?)(?=^#{{1,6}}\s+|\Z)",
        content,
    )
    return match.group("body").strip() if match else ""


def ensure_task_template(content: str) -> str:
    updated = content
    updated = ensure_metadata_line(updated, "Project")
    updated = ensure_metadata_line(updated, "Model")
    updated = ensure_metadata_line(updated, "Agent")
    updated = ensure_metadata_line(updated, "Repo")
    updated = migrate_legacy_sections(updated)
    updated = ensure_section(updated, "Description")
    updated = ensure_section(updated, "Comments")
    updated = ensure_section(updated, "Report", 3)
    return updated


def ensure_metadata_line(content: str, key: str) -> str:
    if re.search(rf"(?m)^{re.escape(key)}:[ \t]*.*$", content):
        return content
    insertion = f"{key}: \n"
    first_heading = content.find("## ")
    if first_heading >= 0:
        return content[:first_heading] + insertion + content[first_heading:]
    return insertion + content


def set_metadata_value(content: str, key: str, value: str) -> str:
    if re.search(rf"(?m)^{re.escape(key)}:[ \t]*.*$", content):
        return re.sub(
            rf"(?m)^{re.escape(key)}:[ \t]*.*$",
            lambda _match: f"{key}: {value}",
            content,
        )
    ensured = ensure_metadata_line(content, key)
    return ensured.replace(f"{key}: \n", f"{key}: {value}\n", 1)


def ensure_section(content: str, heading: str, level: int = 2) -> str:
    marker = re.escape("#" * level)
    if re.search(rf"(?m)^{marker}\s+{re.escape(heading)}\s*$", content):
        return content
    suffix = "" if content.endswith("\n") else "\n"
    return content + suffix + f"{'#' * level} {heading}\n\n"


def set_section_body(content: str, heading: str, body: str, level: int = 2) -> str:
    content = ensure_section(content, heading, level)
    marker = re.escape("#" * level)
    normalized_body = body.strip()
    replacement = (
        f"{'#' * level} {heading}\n\n"
        if not normalized_body
        else f"{'#' * level} {heading}\n{normalized_body}\n\n"
    )
    return re.sub(
        rf"(?ms)^{marker}\s+{re.escape(heading)}\s*\r?\n.*?(?=^#{{1,6}}\s+|\Z)",
        replacement,
        content,
    )


def migrate_legacy_sections(content: str) -> str:
    updated = migrate_legacy_wip(content)
    updated = migrate_legacy_report(updated)
    return updated


def migrate_legacy_wip(content: str) -> str:
    if not has_section(content, "WIP"):
        return content
    legacy_body = get_section_body(content, "WIP")
    if not has_section(content, "Comments"):
        return re.sub(r"(?m)^##\s+WIP\s*$", "## Comments", content)
    merged_comments = merge_bodies(get_section_body(content, "Comments"), legacy_body)
    updated = set_section_body(content, "Comments", merged_comments)
    return remove_section(updated, "WIP")


def migrate_legacy_report(content: str) -> str:
    if not has_section(content, "Report"):
        return content
    if has_section(content, "Report", 3):
        return remove_section(content, "Report")
    return re.sub(r"(?m)^##\s+Report\s*$", "### Report", content)


def has_section(content: str, heading: str, level: int = 2) -> bool:
    marker = re.escape("#" * level)
    return bool(re.search(rf"(?m)^{marker}\s+{re.escape(heading)}\s*$", content))


def remove_section(content: str, heading: str, level: int = 2) -> str:
    marker = re.escape("#" * level)
    updated = re.sub(
        rf"(?ms)^{marker}\s+{re.escape(heading)}\s*\r?\n.*?(?=^#{{1,6}}\s+|\Z)",
        "",
        content,
    )
    return updated.rstrip() + "\n"


def merge_bodies(existing: str, additional: str) -> str:
    if not has_meaningful_body(existing):
        return additional.strip()
    if not has_meaningful_body(additional):
        return existing.strip()
    return existing.rstrip() + "\n===\n" + additional.strip()


def format_comment_topic(note: str) -> str:
    lines: list[str] = []
    for line in note.replace("\r\n", "\n").split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed.startswith(">"):
            trimmed = trimmed.lstrip("> ").strip()
        if trimmed:
            lines.append(f"> {trimmed}")
    return "\n".join(lines)


def has_meaningful_body(body: str) -> bool:
    for line in body.replace("\r\n", "\n").split("\n"):
        trimmed = line.strip()
        if trimmed and trimmed != "===":
            return True
    return False


def normalize_comment_body(body: str) -> str:
    lines = [line.rstrip() for line in body.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines).strip()


def read_seed_file(invocation_directory: str, relative_path: str, fallback: str) -> str:
    candidate = os.path.join(invocation_directory, relative_path)
    if os.path.exists(candidate):
        return read_text(candidate)
    return fallback


def read_text(path: str) -> str:
    with open(path, "r", encoding=ENCODING, errors="replace") as handle:
        return handle.read()


def write_text(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding=ENCODING, newline="\n") as handle:
        handle.write(content)


def terminate_process_tree(process_id: int) -> None:
    if process_id <= 0:
        return
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/PID", str(process_id), "/T", "/F"],
            text=True,
            encoding=ENCODING,
            errors="replace",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    try:
        process = subprocess.Popen(["kill", "-TERM", str(process_id)])
        process.wait(timeout=1)
    except Exception:
        pass


def exclude_local_git_path(repo_path: str, pattern: str) -> None:
    exclude_path = os.path.join(repo_path, ".git", "info", "exclude")
    if not os.path.isfile(exclude_path):
        return
    try:
        existing = read_text(exclude_path)
    except OSError:
        return
    lines = [line.strip() for line in existing.splitlines()]
    if pattern in lines:
        return
    suffix = "" if existing.endswith(("\n", "\r")) or not existing else "\n"
    try:
        with open(exclude_path, "a", encoding=ENCODING, newline="\n") as handle:
            handle.write(f"{suffix}{pattern}\n")
    except OSError:
        pass


def make_unique_directory_path(parent_directory: str, desired_name: str) -> str:
    os.makedirs(parent_directory, exist_ok=True)
    candidate = os.path.join(parent_directory, desired_name)
    if not os.path.exists(candidate):
        return candidate
    counter = 2
    while True:
        next_candidate = os.path.join(parent_directory, f"{desired_name}-{counter}")
        if not os.path.exists(next_candidate):
            return next_candidate
        counter += 1


def make_unique_file_path(desired_path: str) -> str:
    if not os.path.exists(desired_path):
        return desired_path
    directory = os.path.dirname(desired_path)
    file_name, extension = os.path.splitext(os.path.basename(desired_path))
    suffix_match = re.match(r"^(.+)-(\d+)$", file_name)
    suffix_width = 0
    counter = 2
    if suffix_match:
        file_name = suffix_match.group(1)
        suffix_width = len(suffix_match.group(2))
        counter = int(suffix_match.group(2)) + 1
    while True:
        suffix = str(counter).zfill(suffix_width) if suffix_width > 1 else str(counter)
        candidate = os.path.join(directory, f"{file_name}-{suffix}{extension}")
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def sanitize_file_name(value: str) -> str:
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", value).strip()
    return sanitized or "item"


def normalize_path(path: str) -> str:
    normalized = os.path.abspath(path).replace("\\", "/")
    if len(normalized) > 3:
        normalized = normalized.rstrip("/")
    return normalized.lower() if IS_WINDOWS else normalized


def path_equals(left: str, right: str) -> bool:
    return normalize_path(left) == normalize_path(right)


def path_startswith(candidate: str, root: str) -> bool:
    normalized_candidate = normalize_path(candidate)
    normalized_root = normalize_path(root)
    return normalized_candidate == normalized_root or normalized_candidate.startswith(
        normalized_root + "/"
    )


def workspace_move_pipe_name(board_root: str) -> str:
    return "kanban-fs-mover-" + hash_path(board_root)


def hash_path(path: str) -> str:
    return hashlib.sha256(normalize_path(path).encode(ENCODING)).hexdigest()[:16]


def candidate_status_ports(board_root: str) -> list[int]:
    digest = hashlib.sha256(normalize_path(board_root).encode(ENCODING)).digest()
    seed = (digest[0] << 8) | digest[1]
    return [41000 + ((seed + index * 997) % 20000) for index in range(32)]


def normalize_executable(configured_executable: str) -> str:
    executable = (configured_executable or "").strip().strip('"') or "codex"
    executable = os.path.expandvars(os.path.expanduser(executable))
    return executable


def is_path_like(executable: str) -> bool:
    return os.path.isabs(executable) or "/" in executable or "\\" in executable


def executable_candidates(executable_path: str) -> list[str]:
    candidates = [executable_path]
    if os.path.splitext(executable_path)[1]:
        return candidates
    if IS_WINDOWS:
        candidates.extend([f"{executable_path}.exe", f"{executable_path}.cmd", f"{executable_path}.bat"])
    return candidates


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def quote_arg(value: str) -> str:
    if re.search(r"\s", value):
        return '"' + value.replace('"', '\\"') + '"'
    return value


def build_toast_xml(title: str, message: str, task_path: str) -> str:
    task_uri = Path(task_path).absolute().as_uri() if not task_path.startswith("\\\\") else "file://" + quote(task_path.replace("\\", "/"))
    return (
        f'<toast activationType="protocol" launch="{escape_xml(task_uri)}">'
        f"<visual><binding template=\"ToastGeneric\">"
        f"<text>{escape_xml(title)}</text>"
        f"<text>{escape_xml(message)}</text>"
        f"</binding></visual></toast>"
    )


def escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def apple_script_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main(argv: Sequence[str]) -> int:
    settings = OrchestratorSettings.parse(argv, os.getcwd())
    runner = TaskOrchestrator(settings)
    runner.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
