#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import datetime as dt
import enum
import hashlib
import json
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
from typing import Callable, Iterable, Sequence
from urllib.parse import quote


IS_WINDOWS = os.name == "nt"
ENCODING = "utf-8"
REPOSITORY_SWEEP_INTERVAL_SECONDS = 5 * 60


class TaskStep(enum.Enum):
    BACKLOG = "backlog"
    DOING = "doing"
    BLOCKED = "blocked"
    DONE = "done"
    CONFIRMED = "confirmed"


class AgentKind(enum.Enum):
    CLAUDE = "claude"
    CODEX = "codex"


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
class OrchestratorSettings:
    root_path: str
    invocation_directory: str
    max_agents: int
    poll_interval_seconds: int
    run_once: bool
    codex_mode: CodexMode
    default_agent: AgentKind | None
    codex_executable: str
    claude_executable: str

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
            help="Default agent kind: claude, codex, null, or auto.",
        )
        parser.add_argument("--codex-executable", default="codex")
        parser.add_argument("--claude-executable", default="claude")
        args = parser.parse_args(argv)

        if args.max_agents < 1:
            raise ValueError("Max agents must be at least 1.")
        if args.poll_seconds < 1:
            raise ValueError("Poll interval must be at least 1 second.")

        return OrchestratorSettings(
            root_path=os.path.abspath(args.root),
            invocation_directory=os.path.abspath(default_root),
            max_agents=args.max_agents,
            poll_interval_seconds=args.poll_seconds,
            run_once=bool(args.once),
            codex_mode=parse_codex_mode(args.codex_mode),
            default_agent=parse_default_agent(args.default_agent),
            codex_executable=(args.codex_executable or "codex").strip(),
            claude_executable=(args.claude_executable or "claude").strip(),
        )


class BoardPaths:
    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.tasks_root = os.path.join(self.root, "tasks")
        self.projects_root = os.path.join(self.root, "projects")
        self.cache_root = os.path.join(self.root, "cache")
        self.trash_root = os.path.join(self.root, "trash")
        self.logs_root = os.path.join(self.root, "logs")
        self.gitignore_path = os.path.join(self.root, ".gitignore")
        self.context_path = os.path.join(self.root, "context.md")
        self.projects_map_path = os.path.join(self.root, "projects.md")
        self.kanban_marker_path = os.path.join(self.tasks_root, ".kanban")
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
            print(line, flush=True)
            with open(self.path, "a", encoding=ENCODING, newline="") as handle:
                handle.write(line + "\n")


class TaskOrchestrator:
    def __init__(self, settings: OrchestratorSettings) -> None:
        self.settings = settings
        self.paths = BoardPaths(settings.root_path)
        self.log = LogSink(os.path.join(self.paths.logs_root, "runner.log"))
        self.notifications = NotificationService(self.log)
        self.workspace_mover = WorkspaceMoveBridge(self.paths.root, self.log)
        self.status_server = RunnerStatusServer(
            self.paths.root, self.paths.tasks_root, self.log
        )
        self.active_agents: dict[str, ActiveAgent] = {}
        self.active_agents_lock = threading.Lock()
        self.reconcile_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.signal_event = threading.Event()
        self.last_repository_sweep = 0.0
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
                "Default agent: "
                + (self.settings.default_agent.value if self.settings.default_agent else "auto")
            )
            self.log.info(f"Codex executable: {self.settings.codex_executable}")
            self.log.info(f"Claude executable: {self.settings.claude_executable}")
            self.log.info(f"Max agents: {self.settings.max_agents}")

            if self.settings.run_once:
                self.reconcile()
                self._join_agent_threads()
                return

            self.status_server.start()
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

                if not card.project_alias.strip():
                    self.block_task_for_issue(
                        card,
                        "Missing `Project:` field. Create the task with `Project:` set to an alias from projects.md, or use `Project: blank` / `Project: -` for an empty workspace.",
                    )
                    continue

                if ProjectAliases.is_blank(card.project_alias):
                    assignment = ProjectAssignment.blank()
                elif card.project_alias in project_map:
                    assignment = ProjectAssignment.repository(
                        card.project_alias, project_map[card.project_alias]
                    )
                else:
                    self.block_task_for_issue(
                        card,
                        f"Unknown project alias `{card.project_alias}` in projects.md. Use an alias from projects.md, or use `Project: blank` / `Project: -` for an empty workspace.",
                    )
                    continue

                self.start_or_resume_task(card, assignment)
        finally:
            self.reconcile_lock.release()

    def ensure_board_scaffold(self) -> None:
        os.makedirs(self.paths.root, exist_ok=True)
        os.makedirs(self.paths.tasks_root, exist_ok=True)
        self.move_root_kanban_marker_into_tasks()
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
            self.paths.task_template_path,
            BoardTemplates.resolve_task_template(self.settings.invocation_directory),
        )

    def move_root_kanban_marker_into_tasks(self) -> None:
        root_marker = os.path.join(self.paths.root, ".kanban")
        if not os.path.exists(root_marker) or path_equals(root_marker, self.paths.kanban_marker_path):
            return

        if not os.path.exists(self.paths.kanban_marker_path):
            shutil.move(root_marker, self.paths.kanban_marker_path)
            self.log.info(f"Moved root .kanban marker into tasks: {self.paths.kanban_marker_path}")
            return

        root_text = read_text(root_marker)
        task_text = read_text(self.paths.kanban_marker_path)
        if not task_text.strip() and root_text.strip():
            write_text(self.paths.kanban_marker_path, root_text)
            os.remove(root_marker)
            self.log.info(
                f"Moved root .kanban marker content into tasks: {self.paths.kanban_marker_path}"
            )
            return

        if not root_text.strip():
            os.remove(root_marker)
            self.log.info("Removed empty root .kanban marker after runner initialization.")
            return

        self.log.warn(
            f"Root .kanban marker was left in place because tasks/.kanban already exists: {root_marker}"
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
            self.workspace_mover.move_directory(repo_path, destination)
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
            self.workspace_mover.move_directory(repo_path, destination)
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
        self.workspace_mover.move_directory(repo_path, destination)
        card.with_updated_repo_path(destination)
        self.log.info(f"Moved blank workspace to trash: {destination}")

    def reactivate_done_cards(self) -> None:
        for task_path in self.enumerate_step_tasks(TaskStep.DONE):
            card = self.try_load_task_card(task_path, TaskStep.DONE)
            if not card or not card.has_meaningful_comments:
                continue
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
        doing_path = self.move_task(backlog_card, TaskStep.DOING)
        doing_card = TaskCard.load(doing_path, TaskStep.DOING, self.paths)

        try:
            repo_path = self.ensure_working_repository(doing_card, assignment)
            doing_card = doing_card.with_updated_repo_path(repo_path)
        except Exception as exc:
            self.log.error(f"Repository provisioning failed for `{doing_card.path}`: {exc}")
            self.block_task_for_issue(doing_card, f"Repository provisioning failed: {exc}")
            return

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
                    lambda session_id: self._record_agent_id(doing_card, session_id),
                )
                if result.session_id and result.session_id != doing_card.agent_id:
                    doing_card = doing_card.with_updated_agent_id(result.session_id)
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

    def _record_agent_id(self, card: "TaskCard", session_id: str) -> None:
        if session_id and session_id != card.agent_id:
            card.with_updated_agent_id(session_id)

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
                    self.workspace_mover.move_directory(recorded_path, restored_path)
                    GitCli.refresh(restored_path, self.log)
                    return restored_path
                GitCli.refresh(recorded_path, self.log)
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
            reusable_repos = sorted(
                (
                    os.path.join(cache_project_dir, name)
                    for name in os.listdir(cache_project_dir)
                    if os.path.isdir(os.path.join(cache_project_dir, name))
                ),
                key=lambda item: os.path.getmtime(item),
                reverse=True,
            )
            if reusable_repos:
                restored_path = make_unique_directory_path(
                    repo_base_dir, preferred_repo_folder_name
                )
                self.workspace_mover.move_directory(reusable_repos[0], restored_path)
                GitCli.refresh(restored_path, self.log)
                return restored_path

        os.makedirs(repo_base_dir, exist_ok=True)
        repo_path = make_unique_directory_path(repo_base_dir, preferred_repo_folder_name)
        GitCli.clone(assignment.repo_url or "", repo_path, self.log)
        return repo_path

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
            self.trash_completed_blank_workspace(
                TaskCard.load(done_path, TaskStep.DONE, self.paths)
            )
            return

        if status == AgentOutcome.BLOCKED:
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
        for alias_name in sorted(os.listdir(root), key=str.lower if IS_WINDOWS else None):
            alias_dir = os.path.join(root, alias_name)
            if not os.path.isdir(alias_dir):
                continue
            for repo_name in sorted(os.listdir(alias_dir), key=str.lower if IS_WINDOWS else None):
                repo_dir = os.path.join(alias_dir, repo_name)
                if os.path.isdir(repo_dir):
                    result.append(os.path.abspath(repo_dir))
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
        self._move_entry(source_path, destination_path, "directory", os.path.isdir)

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
        if result == "asked" and not exists(source_path) and exists(destination_path):
            self.log.info(
                f"Moved {entry_type} via VS Code extension (verified): `{source_path}` -> `{destination_path}`"
            )
            return

        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        shutil.move(source_path, destination_path)
        fallback_reason = "extension asked, no successful response" if result == "asked" else "extension not reached"
        self.log.info(
            f"Moved {entry_type} via direct filesystem move ({fallback_reason}): `{source_path}` -> `{destination_path}`"
        )

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
    def __init__(self, root_path: str, kanban_path: str, log: LogSink) -> None:
        self.root_path = os.path.abspath(root_path)
        self.normalized_root_path = normalize_path(self.root_path)
        self.kanban_path = os.path.abspath(kanban_path)
        self.log = log
        self.process_id = os.getpid()
        self.started_at_utc = utc_now_iso()
        self.stop_event = threading.Event()
        self.socket: socket.socket | None = None
        self.thread: threading.Thread | None = None
        self.port = 0

    def start(self) -> None:
        if self.socket is not None:
            return
        for port in candidate_status_ports(self.root_path):
            try:
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", port))
                listener.listen()
                listener.settimeout(0.5)
                self.socket = listener
                self.port = port
                self.thread = threading.Thread(target=self._accept_loop, daemon=True)
                self.thread.start()
                self.log.info(f"Runner status endpoint listening on 127.0.0.1:{port}")
                return
            except OSError:
                try:
                    listener.close()
                except Exception:
                    pass
        self.log.warn("Failed to start runner status endpoint; all candidate localhost ports are in use.")

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

    def select_agent_kind(self, card: "TaskCard") -> AgentKind:
        tagged_agent = agent_kind_from_tags(card.tags)
        if tagged_agent:
            self.ensure_agent_available(tagged_agent)
            self.log.info(f"Task `{card.path}` selected agent from tag: {tagged_agent.value}")
            return tagged_agent
        if self.settings.default_agent:
            self.ensure_agent_available(self.settings.default_agent)
            return self.settings.default_agent
        return self.detect_default_agent()

    def detect_default_agent(self) -> AgentKind:
        if self._auto_agent:
            return self._auto_agent
        for kind in [AgentKind.CLAUDE, AgentKind.CODEX]:
            if self.is_agent_available(kind):
                self._auto_agent = kind
                self.log.info(f"Auto-detected default agent: {kind.value}")
                return kind
        raise FileNotFoundError(
            "No supported agent executable was found. Install Claude Code or Codex, or configure `kanban.defaultAgent` and the matching executable setting."
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
        return CodexRunner(settings, paths, log)

    def run(
        self,
        card: "TaskCard",
        repo_path: str,
        prompt: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        raise NotImplementedError

    def _run_process(
        self,
        args: list[str],
        repo_path: str,
        prompt: str,
        parse_line: Callable[[str, dict[str, str]], None],
        label: str,
        on_session_started: Callable[[str], None] | None,
    ) -> AgentRunResult:
        self.log.info(f"Starting {label}: {' '.join(quote_arg(arg) for arg in args)}")
        process = subprocess.Popen(
            args,
            cwd=repo_path,
            stdin=subprocess.PIPE,
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

        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.flush()
        process.stdin.close()

        assert process.stdout is not None
        assert process.stderr is not None

        def read_stdout() -> None:
            nonlocal session_reported
            for raw_line in process.stdout:
                line = raw_line.rstrip("\r\n")
                stdout_lines.append(line)
                parse_line(line, state)
                session_id = state.get("session_id", "")
                if session_id and not session_reported and on_session_started:
                    session_reported = True
                    on_session_started(session_id)

        def read_stderr() -> None:
            for raw_line in process.stderr:
                line = raw_line.rstrip("\r\n")
                stderr_lines.append(line)
                self.log.warn(f"{label} stderr: {line}")

        stdout_thread = threading.Thread(target=read_stdout)
        stderr_thread = threading.Thread(target=read_stderr)
        stdout_thread.start()
        stderr_thread.start()
        exit_code = process.wait()
        stdout_thread.join()
        stderr_thread.join()

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
        args = [
            executable,
            "--print",
            "--output-format",
            "stream-json",
            "--input-format",
            "text",
            "--add-dir",
            self.paths.root,
            *claude_permission_arguments(self.settings.codex_mode),
        ]
        if card.agent_id:
            args.extend(["--resume", card.agent_id])
        return self._run_process(
            args, repo_path, prompt, parse_claude_json_line, "Claude", on_session_started
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
    def is_confirmed(self) -> bool:
        return self.step == TaskStep.CONFIRMED

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

    def get_section_body(self, heading: str, level: int = 2) -> str:
        return get_section_body(self.content, heading, level)

    def with_updated_agent_id(self, agent_id: str) -> "TaskCard":
        updated = ensure_task_template(self.content)
        updated = set_metadata_value(updated, "Agent", agent_id)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def with_updated_repo_path(self, repo_path: str) -> "TaskCard":
        updated = ensure_task_template(self.content)
        updated = set_metadata_value(updated, "Repo", repo_path)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def append_comment_topic(self, note: str) -> "TaskCard":
        updated = ensure_task_template(self.content)
        existing = get_section_body(updated, "Comments")
        topic = format_comment_topic(note)
        new_comments = topic if not existing.strip() else existing.rstrip() + "\n===\n" + topic
        updated = set_section_body(updated, "Comments", new_comments)
        self.write(updated)
        return TaskCard.load(self.path, self.step, self.paths)

    def write(self, content: str) -> None:
        write_text(self.path, content)


class PromptFactory:
    status_regex = re.compile(r"^ORCHESTRATOR_STATUS:\s*(BLOCKED|DONE)\s*$", re.I | re.M)

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
- Do not change `Project:`, `Agent:`, or `Repo:` lines.
- Keep `## Comments` and `### Report` aligned with the current state.
- Do not move the task file between folders; `runner.py` does that.

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


class GitCli:
    @staticmethod
    def clone(repo_url: str, destination: str, log: LogSink) -> None:
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        GitCli._run(["clone", repo_url, destination], log)

    @staticmethod
    def refresh(repo_path: str, log: LogSink) -> None:
        if not os.path.isdir(os.path.join(repo_path, ".git")):
            return
        GitCli._run(["-C", repo_path, "fetch", "--all", "--prune"], log, tolerate_failure=True)
        GitCli._run(["-C", repo_path, "pull", "--ff-only"], log, tolerate_failure=True)

    @staticmethod
    def _run(arguments: list[str], log: LogSink, tolerate_failure: bool = False) -> None:
        process = subprocess.run(
            ["git", *arguments],
            text=True,
            encoding=ENCODING,
            errors="replace",
            capture_output=True,
        )
        if process.stdout.strip():
            log.info(process.stdout.strip())
        if process.stderr.strip():
            log.warn(process.stderr.strip())
        if process.returncode != 0 and not tolerate_failure:
            raise RuntimeError(f"git {' '.join(arguments)} failed with exit code {process.returncode}")


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
        return "# alias = https://github.com/org/repo\n"

    @staticmethod
    def default_gitignore_template() -> str:
        return "projects/\ncache/\ntrash/\nlogs/\n"

    @staticmethod
    def default_context_template() -> str:
        return """# Task Agent Context

Read this file, the `{working directory}/README.md`, and the task file before doing any work.

## General rules

- Work only inside the assigned repository/workspace path and the task file.
- Don't push anything unless explicitly asked.
- Don't commit unless explicitly asked.
- If you do commit, use a short informative message without a prefix like `fix` or `chore`.
- Keep task markdown tidy.
- Read `{working directory}/knowledge/README.md` and check whether any linked reference is relevant to the task.
- Confirm you use up to date branches, pull if needed.
- Use default branch like master or main (stash changes if present, nothing should be there, checkout the branch, pull), if specific one is not mentioned.
- If a cached repo contains uncommitted changes, stash them all so no changes interfere with new task. Mention it in the task.
- When asked to checkout a branch or merge another branch, use most recent state available at remote by default, unless asked to use local branch.

## Task file conventions

- Keep `## Description` as the durable task record.
- When a question is resolved, fold the answer into `## Description` and trim stale items from `## Comments`.
- Use `## Comments` only for open questions, blockers, or missing context.
- Every non-empty line in `## Comments` must start with `> `.
- Separate unrelated comment topics with a line that is exactly `===`.
- Use `### Report` for completion notes, handoff details, or a concise summary of what changed.
- Leave `## Comments` empty when the task is not blocked and no user input is needed.
- Interpret cited comments (`> ...`) as yours; if they do not make sense, ignore them.
- Improve markdown.

## Final message

- End with exactly one status block.
- If blocked:
`ORCHESTRATOR_STATUS: BLOCKED`
`ORCHESTRATOR_SUMMARY: <one sentence>`
- If done:
`ORCHESTRATOR_STATUS: DONE`
`ORCHESTRATOR_SUMMARY: <one sentence>`
"""

    @staticmethod
    def default_task_template() -> str:
        return """# {{TITLE}}

Tags: 
Project: {{CURSOR}}

## Description

"""

    @staticmethod
    def resolve_context_template(invocation_directory: str) -> str:
        return read_seed_file(
            invocation_directory, "context.md", BoardTemplates.default_context_template()
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
        lines = ["folders:"]
        for folder in folders:
            lines.append(f"  {folder.name}: {folder.name}")
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


def parse_codex_mode(value: str) -> CodexMode:
    normalized = value.strip().replace("-", "").replace("_", "").lower()
    if normalized == "dangerous":
        return CodexMode.DANGEROUS
    if normalized == "fullauto":
        return CodexMode.FULL_AUTO
    raise ValueError(f"Unsupported Codex mode: {value}")


def parse_default_agent(value: str | None) -> AgentKind | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"", "null", "none", "auto", "detect"}:
        return None
    if normalized == "claude":
        return AgentKind.CLAUDE
    if normalized == "codex":
        return AgentKind.CODEX
    raise ValueError("Default agent must be claude, codex, null, or auto.")


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
    has_claude = bool(normalized_tags & claude_markers)
    has_codex = bool(normalized_tags & codex_markers)
    if has_claude and not has_codex:
        return AgentKind.CLAUDE
    if has_codex and not has_claude:
        return AgentKind.CODEX
    return None


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
    if event_type == "assistant":
        message = payload.get("message")
        text = extract_claude_message_text(message)
        if text:
            state["final_agent_message"] = text


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
        return re.sub(rf"(?m)^{re.escape(key)}:[ \t]*.*$", f"{key}: {value}", content)
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
    counter = 2
    while True:
        candidate = os.path.join(directory, f"{file_name}-{counter}{extension}")
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
