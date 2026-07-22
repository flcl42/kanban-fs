import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path


root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("kanban_runner", root / "runner.py")
runner = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)


source = """# Example
Tags:
Project: blank
Repo: D:\\base\\projects\\blank\\old

## Description

"""

for path in [
    r"D:\base\trash\blank\glamsterdam-compatibiltiy-research",
    r"D:\base\trash\blank\make-a-family-doctor",
]:
    updated = runner.set_metadata_value(source, "Repo", path)
    assert f"Repo: {path}" in updated


ensured = runner.ensure_task_template("# Example\n\n## Description\n\n")
assert "Agent Kind:" not in ensured
assert "Model:" in ensured
assert runner.agent_kind_from_value("claude") == runner.AgentKind.CLAUDE
assert runner.agent_kind_from_value("agent:codex") == runner.AgentKind.CODEX
assert runner.agent_kind_from_value("agent:kimi") == runner.AgentKind.KIMI
assert runner.BoardTemplates.projects_template() == "blank = https://github.com/flcl42/blank.git\n"
assert (
    runner.BoardTemplates.default_task_template()
    == "# {{TITLE}}\n\nTags: \nProject: {{CURSOR}}\nModel: \n\n## Description\n\n\n"
)
assert "knowledge/README.md" in runner.BoardTemplates.default_context_template()
assert "# Knowledge" in runner.BoardTemplates.default_knowledge_readme_template()
assert (
    runner.agent_kind_from_agent_id("019f3722-8c59-72b1-8487-635e387ea4a2")
    == runner.AgentKind.CODEX
)
assert (
    runner.agent_kind_from_agent_id("4d4c6b89-9a23-4bfc-a072-220e08f32dc6")
    == runner.AgentKind.CLAUDE
)
assert (
    runner.agent_kind_from_agent_id("session_1d11f261-5711-42ff-8a3a-fb7146ec5988")
    == runner.AgentKind.KIMI
)
assert runner.agent_kind_from_tags(["agent:kimi"]) == runner.AgentKind.KIMI
assert runner.parse_kimi_json_line(
    '{"role":"meta","type":"session.resume_hint","session_id":"session_1d11f261-5711-42ff-8a3a-fb7146ec5988"}',
    (kimi_state := {}),
) is None
assert kimi_state["session_id"] == "session_1d11f261-5711-42ff-8a3a-fb7146ec5988"
runner.parse_kimi_json_line('{"role":"assistant","content":"ORCHESTRATOR_STATUS: DONE"}', kimi_state)
assert kimi_state["final_agent_message"] == "ORCHESTRATOR_STATUS: DONE"

codex_model = runner.parse_model_spec("codex/gpt-5.6-terra/max")
assert codex_model is not None
assert codex_model.agent_kind == runner.AgentKind.CODEX
assert codex_model.model == "gpt-5.6-terra"
assert codex_model.effort == "max"
assert runner.codex_model_arguments(codex_model) == [
    "--model",
    "gpt-5.6-terra",
    "-c",
    'model_reasoning_effort="max"',
]
claude_model = runner.parse_model_spec("claude/sonnet/high")
assert claude_model is not None
assert runner.claude_model_arguments(claude_model) == [
    "--model",
    "sonnet",
    "--effort",
    "high",
]
kimi_model = runner.parse_model_spec("kimi/k2")
assert kimi_model is not None
assert runner.kimi_model_arguments(kimi_model) == ["--model", "k2"]
raw_model = runner.parse_model_spec("openrouter/moonshotai/kimi-k2")
assert raw_model is not None
assert raw_model.agent_kind is None
assert raw_model.model == "openrouter/moonshotai/kimi-k2"
try:
    runner.kimi_model_arguments(runner.parse_model_spec("kimi/k2/max"))
    raise AssertionError("Kimi effort should be rejected")
except ValueError as exc:
    assert "Kimi CLI only supports model selection" in str(exc)


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    paths = runner.BoardPaths(str(temp_root))
    settings = runner.OrchestratorSettings(
        root_path=str(temp_root),
        invocation_directory=str(temp_root),
        max_agents=1,
        poll_interval_seconds=1,
        run_once=True,
        codex_mode=runner.CodexMode.DANGEROUS,
        default_agent=runner.AgentKind.CLAUDE,
        codex_executable="codex",
        claude_executable="claude",
        kimi_executable="kimi",
    )
    resolver = runner.AgentResolver(settings, runner.LogSink(str(temp_root / "runner.log")))
    resolver.is_agent_available = lambda _kind: True

    model_task_path = temp_root / "model-task.md"
    model_task_path.write_text(
        """# Model task

Tags:
Project: blank
Model: codex/gpt-5.6-terra/max
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    model_card = runner.TaskCard.load(str(model_task_path), runner.TaskStep.BACKLOG, paths)
    assert resolver.select_agent_kind(model_card) == runner.AgentKind.CODEX

    conflict_task_path = temp_root / "conflict-task.md"
    conflict_task_path.write_text(
        """# Conflict task

Tags: kimi
Project: blank
Model: codex/gpt-5.6-terra/max
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    conflict_card = runner.TaskCard.load(str(conflict_task_path), runner.TaskStep.BACKLOG, paths)
    try:
        resolver.select_agent_kind(conflict_card)
        raise AssertionError("Model/tag agent conflict should be rejected")
    except ValueError as exc:
        assert "Model: codex/gpt-5.6-terra/max" in str(exc)


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    temp_home = temp_root / "home"
    kimi_dir = temp_home / ".kimi-code"
    kimi_dir.mkdir(parents=True)
    workdir = temp_root / "projects" / "blank" / "task"
    other_workdir = temp_root / "projects" / "blank" / "other-task"
    index_path = kimi_dir / "session_index.jsonl"

    old_home = os.environ.get("HOME")
    old_userprofile = os.environ.get("USERPROFILE")
    os.environ["HOME"] = str(temp_home)
    os.environ["USERPROFILE"] = str(temp_home)

    def append_session(session_id, path):
        with index_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"sessionId": session_id, "workDir": str(path)}) + "\n")

    try:
        old_session = "session_11111111-1111-4111-8111-111111111111"
        other_session = "session_22222222-2222-4222-8222-222222222222"
        new_session = "session_33333333-3333-4333-8333-333333333333"
        append_session(old_session, workdir)
        append_session(other_session, other_workdir)
        with index_path.open("a", encoding="utf-8") as handle:
            handle.write("not-json\n")

        existing_sessions = runner.KimiSessions.session_ids_for_workdir(str(workdir))
        assert existing_sessions == {old_session}
        assert (
            runner.KimiSessions.find_new_session_id_for_workdir(
                str(workdir), existing_sessions
            )
            is None
        )

        append_session(new_session, workdir)
        assert (
            runner.KimiSessions.find_new_session_id_for_workdir(
                str(workdir), existing_sessions
            )
            == new_session
        )
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
        if old_userprofile is None:
            os.environ.pop("USERPROFILE", None)
        else:
            os.environ["USERPROFILE"] = old_userprofile


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    appdata = temp_root / "appdata"
    settings_dir = appdata / "Code" / "User"
    settings_dir.mkdir(parents=True)
    (settings_dir / "settings.json").write_text(
        """{
  // Direct runner starts should still honor VS Code user settings.
  "kanban.defaultAgent": "codex",
  "kanban.codexExecutable": "custom-codex",
  "kanban.claudeExecutable": "custom-claude",
  "kanban.kimiExecutable": "custom-kimi",
}
""",
        encoding="utf-8",
    )
    old_appdata = os.environ.get("APPDATA")
    os.environ["APPDATA"] = str(appdata)
    try:
        parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root)], str(temp_root))
        assert parsed.default_agent == runner.AgentKind.CODEX
        assert parsed.codex_executable == "custom-codex"
        assert parsed.claude_executable == "custom-claude"
        assert parsed.kimi_executable == "custom-kimi"

        override = runner.OrchestratorSettings.parse(
            [
                "--root",
                str(temp_root),
                "--default-agent",
                "kimi",
                "--codex-executable",
                "cli-codex",
                "--kimi-executable",
                "cli-kimi",
            ],
            str(temp_root),
        )
        assert override.default_agent == runner.AgentKind.KIMI
        assert override.codex_executable == "cli-codex"
        assert override.claude_executable == "custom-claude"
        assert override.kimi_executable == "cli-kimi"
    finally:
        if old_appdata is None:
            os.environ.pop("APPDATA", None)
        else:
            os.environ["APPDATA"] = old_appdata


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    assert (temp_root / "tasks" / ".kanban").exists()
    assert (
        (temp_root / "tasks" / "template.md").read_text(encoding="utf-8")
        == runner.BoardTemplates.default_task_template()
    )
    assert (temp_root / "projects.md").read_text(encoding="utf-8") == (
        "blank = https://github.com/flcl42/blank.git\n"
    )
    assert (temp_root / "context.md").exists()
    assert (temp_root / "knowledge" / "README.md").exists()


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    task_path = temp_root / "tasks" / "backlog" / "missing-project.md"
    task_path.write_text(
        """# Missing project

Tags:
Project: 

## Description

Run with the default project.
""",
        encoding="utf-8",
    )
    started = {}

    def fake_start(card, assignment):
        started["card"] = card
        started["assignment"] = assignment

    orchestrator.start_or_resume_task = fake_start
    orchestrator.reconcile()
    assert "card" in started
    assert started["card"].project_alias == runner.ProjectAliases.BLANK_WORKSPACE_ALIAS
    assert started["assignment"].workspace_alias == runner.ProjectAliases.BLANK_WORKSPACE_ALIAS
    assert "Project: blank" in task_path.read_text(encoding="utf-8")
