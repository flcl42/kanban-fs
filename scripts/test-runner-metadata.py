import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path


root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("kanban_runner", root / "runner.py")
runner = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)

assert runner.GIT_COMMAND_TIMEOUT_SECONDS == 12 * 60


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

windows_path_note = r"> Repository provisioning failed for `D:\tmp\projects\kanban\clone`: bad"
updated = runner.set_section_body(source, "Comments", windows_path_note)
assert windows_path_note in updated


ensured = runner.ensure_task_template("# Example\n\n## Description\n\n")
assert "Agent Kind:" not in ensured
assert "Model:" in ensured
assert runner.agent_kind_from_value("claude") == runner.AgentKind.CLAUDE
assert runner.agent_kind_from_value("agent:codex") == runner.AgentKind.CODEX
assert runner.agent_kind_from_value("agent:kimi") == runner.AgentKind.KIMI
assert runner.agent_kind_from_value("deepcode") == runner.AgentKind.DEEPSEEK
assert runner.agent_kind_from_value("ds") == runner.AgentKind.DEEPSEEK
assert runner.agent_kind_from_value("opencode") == runner.AgentKind.OPENCODE
assert runner.agent_kind_from_value("oc") == runner.AgentKind.OPENCODE
assert runner.has_manual_agent_tag(["manual"])
assert runner.has_manual_agent_tag(["human"])
assert runner.has_manual_agent_tag(["agent:manual"])
assert runner.parse_default_agent("manual") == runner.MANUAL_AGENT_VALUE
assert runner.parse_default_agent("human") == runner.MANUAL_AGENT_VALUE
assert runner.parse_default_agent("opencode") == runner.AgentKind.OPENCODE
assert runner.parse_default_agent("oc") == runner.AgentKind.OPENCODE
assert runner.BoardTemplates.projects_template() == "blank = https://github.com/flcl42/blank.git\n"
assert (
    runner.BoardTemplates.default_task_template()
    == "# {{TITLE}}\n\nTags: \nProject: {{CURSOR}}\nModel: \n\n## Description\n\n\n"
)
prompt = runner.PromptFactory.build(
    r"D:\board",
    r"D:\board\tasks\doing\example.md",
    r"D:\board\projects\blank\example",
    runner.AgentRunMode.NEW,
    runner.AgentKind.DEEPSEEK,
)
assert "Do not ask where the board, runner, task file, repository, README, or context file is" in prompt
assert "Do not use AskUserQuestion for information that is already present" in prompt
assert "If the repository workspace is empty, that is expected for blank tasks" in prompt
assert "--- BEGIN TASK FILE ---" in prompt
assert "--- BEGIN BOARD README ---" in prompt
assert "--- BEGIN SHARED CONTEXT ---" in prompt
assert (
    runner.PromptFactory.parse_summary(
        "ORCHESTRATOR_STATUS: BLOCKED\nORCHESTRATOR_SUMMARY: Missing API key"
    )
    == "Missing API key"
)
seeded_kanban_config = runner.BoardTemplates.create_kanban_config(
    [runner.KanbanFolder("backlog", "backlog")]
)
assert "defaultModels:" in seeded_kanban_config
assert '  codex: ""' in seeded_kanban_config
assert '  claude: ""' in seeded_kanban_config
assert '  kimi: ""' in seeded_kanban_config
assert '  deepseek: ""' in seeded_kanban_config
assert '  opencode: ""' in seeded_kanban_config
assert "knowledge/README.md" in runner.BoardTemplates.default_context_template()
assert "# Knowledge" in runner.BoardTemplates.default_knowledge_readme_template()
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    (temp_root / "task.md").write_text("", encoding="utf-8")
    assert runner.make_unique_file_path(str(temp_root / "task.md")).endswith("task-2.md")
    (temp_root / "task-2.md").write_text("", encoding="utf-8")
    assert runner.make_unique_file_path(str(temp_root / "task.md")).endswith("task-3.md")
    assert runner.make_unique_file_path(str(temp_root / "task-2.md")).endswith("task-3.md")
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    exclude_path = temp_root / ".git" / "info" / "exclude"
    exclude_path.parent.mkdir(parents=True)
    exclude_path.write_text("# local excludes\n", encoding="utf-8")
    runner.exclude_local_git_path(str(temp_root), ".kanban-runner-prompt-*.md")
    runner.exclude_local_git_path(str(temp_root), ".kanban-runner-prompt-*.md")
    assert (
        exclude_path.read_text(encoding="utf-8").count(".kanban-runner-prompt-*.md")
        == 1
    )
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    source_path = temp_root / "backlog" / "race.md"
    destination_path = temp_root / "doing" / "race.md"
    source_path.parent.mkdir()
    destination_path.parent.mkdir()
    source_path.write_text("# Race\n", encoding="utf-8")
    bridge = runner.WorkspaceMoveBridge(str(temp_root), runner.LogSink(str(temp_root / "runner.log")))

    def delayed_extension_move(source, destination, _entry_type):
        def worker():
            time.sleep(0.1)
            os.rename(source, destination)

        threading.Thread(target=worker, daemon=True).start()
        return "asked"

    bridge._try_move_via_extension = delayed_extension_move
    bridge.move_file(str(source_path), str(destination_path))
    assert destination_path.read_text(encoding="utf-8") == "# Race\n"
    assert not source_path.exists()
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    source_path = temp_root / "backlog" / "late.md"
    destination_path = temp_root / "doing" / "late.md"
    source_path.parent.mkdir()
    destination_path.parent.mkdir()
    source_path.write_text("# Late\n", encoding="utf-8")
    bridge = runner.WorkspaceMoveBridge(str(temp_root), runner.LogSink(str(temp_root / "runner.log")))
    bridge._try_move_via_extension = lambda _source, _destination, _entry_type: "asked"
    bridge._wait_for_move_completion = lambda _source, _destination, _exists: False
    original_move = runner.shutil.move

    def racing_fallback_move(source, destination):
        os.rename(source, destination)
        raise FileNotFoundError(source)

    try:
        runner.shutil.move = racing_fallback_move
        bridge.move_file(str(source_path), str(destination_path))
    finally:
        runner.shutil.move = original_move
    assert destination_path.read_text(encoding="utf-8") == "# Late\n"
    assert not source_path.exists()
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    log = runner.LogSink(str(temp_root / "runner.log"))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    stop_status_server = threading.Event()
    payload = {
        "version": 1,
        "kind": "kanban-runner-status",
        "rootPath": str(temp_root),
        "normalizedRootPath": runner.normalize_path(str(temp_root)),
        "kanbanPath": str(temp_root / "tasks"),
        "processId": 12345,
        "activeAgentCount": 0,
    }

    def serve_status():
        while not stop_status_server.is_set():
            try:
                client, _addr = listener.accept()
            except (TimeoutError, socket.timeout, OSError):
                continue
            with client:
                client.sendall((json.dumps(payload) + "\n").encode("utf-8"))

    status_thread = threading.Thread(target=serve_status, daemon=True)
    status_thread.start()
    original_candidate_status_ports = runner.candidate_status_ports
    runner.candidate_status_ports = lambda _root: [port]
    try:
        status_server = runner.RunnerStatusServer(
            str(temp_root), str(temp_root / "tasks"), log, lambda: 0
        )
        assert not status_server.start()
        assert status_server.socket is None
    finally:
        runner.candidate_status_ports = original_candidate_status_ports
        stop_status_server.set()
        listener.close()
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    doing_path = temp_root / "tasks" / "doing" / "complete.md"
    done_path = temp_root / "tasks" / "done" / "complete.md"
    doing_path.write_text(
        """# Complete

Tags:
Project: blank
Model:
Agent:
Repo:

## Description

Done.

## Comments

### Report
""",
        encoding="utf-8",
    )
    complete_card = runner.TaskCard.load(str(doing_path), runner.TaskStep.DOING, orchestrator.paths)
    orchestrator.move_task = lambda _card, _step: str(done_path)
    orchestrator.notifications.show = lambda *_args: None

    def unexpected_block(_card, _issue):
        raise AssertionError("Missing done-path cleanup should not block a completed task")

    orchestrator.block_task_for_issue = unexpected_block
    orchestrator.handle_agent_completion(
        complete_card,
        runner.AgentRunResult(0, "", "ORCHESTRATOR_STATUS: DONE", [], []),
        runner.AgentKind.CODEX,
    )
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    done_path = temp_root / "tasks" / "done" / "commented.md"
    backlog_path = temp_root / "tasks" / "backlog" / "commented.md"
    done_path.write_text(
        """# Commented

Tags:
Project: blank
Model:
Agent:
Repo:

## Description

Done.

## Comments
Please revisit this.

### Report
Already done.
""",
        encoding="utf-8",
    )
    orchestrator.reactivate_done_cards()
    assert backlog_path.exists()
    assert not done_path.exists()
    os.rename(backlog_path, done_path)
    orchestrator.reactivate_done_cards()
    assert done_path.exists()
    assert not backlog_path.exists()
    done_path.write_text(
        done_path.read_text(encoding="utf-8").replace(
            "Please revisit this.", "Please revisit this.\nOne more request."
        ),
        encoding="utf-8",
    )
    orchestrator.reactivate_done_cards()
    assert backlog_path.exists()
    assert not done_path.exists()
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    paths = runner.BoardPaths(str(temp_root))
    task_path = temp_root / "stale-card.md"
    task_path.write_text(
        """# Stale card

Tags: deepseek
Project: -
Model:
Agent:
Repo:

## Description

Do it.

## Comments

### Report
""",
        encoding="utf-8",
    )
    stale_card = runner.TaskCard.load(str(task_path), runner.TaskStep.BACKLOG, paths)
    task_path.write_text(
        task_path.read_text(encoding="utf-8")
        + "\nThe agent updated the report after the card was loaded.\n",
        encoding="utf-8",
    )
    refreshed_card = stale_card.with_updated_agent_id(
        "11111111-1111-4111-8111-111111111111", runner.AgentKind.DEEPSEEK
    )
    assert refreshed_card.agent_id == "11111111-1111-4111-8111-111111111111"
    assert "The agent updated the report after the card was loaded." in task_path.read_text(
        encoding="utf-8"
    )
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
assert (
    runner.agent_kind_from_agent_id("ses_fd76fc5e6ffeQJ9GZMIaR6Hq5e")
    == runner.AgentKind.OPENCODE
)
assert runner.agent_kind_from_tags(["agent:kimi"]) == runner.AgentKind.KIMI
assert runner.agent_kind_from_tags(["deepseek"]) == runner.AgentKind.DEEPSEEK
assert runner.agent_kind_from_tags(["ds"]) == runner.AgentKind.DEEPSEEK
assert runner.agent_kind_from_tags(["deepcode"]) == runner.AgentKind.DEEPSEEK
assert runner.agent_kind_from_tags(["oc"]) == runner.AgentKind.OPENCODE
assert runner.agent_kind_from_tags(["manual"]) is None
assert runner.parse_kimi_json_line(
    '{"role":"meta","type":"session.resume_hint","session_id":"session_1d11f261-5711-42ff-8a3a-fb7146ec5988"}',
    (kimi_state := {}),
) is None
assert kimi_state["session_id"] == "session_1d11f261-5711-42ff-8a3a-fb7146ec5988"
runner.parse_kimi_json_line('{"role":"assistant","content":"ORCHESTRATOR_STATUS: DONE"}', kimi_state)
assert kimi_state["final_agent_message"] == "ORCHESTRATOR_STATUS: DONE"
deepcode_state = {}
runner.parse_deepcode_line(
    "deepcode --resume 11111111-1111-4111-8111-111111111111",
    deepcode_state,
)
assert deepcode_state["session_id"] == "11111111-1111-4111-8111-111111111111"
runner.parse_deepcode_line("ORCHESTRATOR_STATUS: DONE", deepcode_state)
assert deepcode_state["final_agent_message"] == "ORCHESTRATOR_STATUS: DONE"
opencode_state = {}
runner.parse_opencode_json_line(
    '{"type":"session.updated","sessionID":"ses_fd76fc5e6ffeQJ9GZMIaR6Hq5e"}',
    opencode_state,
)
assert opencode_state["session_id"] == "ses_fd76fc5e6ffeQJ9GZMIaR6Hq5e"
assert (
    runner.extract_opencode_export_assistant_message(
        {
            "messages": [
                {"info": {"role": "user"}, "parts": [{"type": "text", "text": "Do it"}]},
                {
                    "info": {"role": "assistant"},
                    "parts": [{"type": "text", "text": "ORCHESTRATOR_STATUS: DONE"}],
                },
            ]
        }
    )
    == "ORCHESTRATOR_STATUS: DONE"
)
claude_state = {}
runner.parse_claude_json_line(
    '{"type":"system","session_id":"4d4c6b89-9a23-4bfc-a072-220e08f32dc6"}',
    claude_state,
)
assert claude_state["session_id"] == "4d4c6b89-9a23-4bfc-a072-220e08f32dc6"
assert "final_agent_message" not in claude_state
runner.parse_claude_json_line('{"type":"result","result":"ORCHESTRATOR_STATUS: DONE"}', claude_state)
assert claude_state["final_agent_message"] == "ORCHESTRATOR_STATUS: DONE"

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
ultra_codex_model = runner.parse_model_spec("codex/sol/ultra")
assert ultra_codex_model is not None
assert ultra_codex_model.agent_kind == runner.AgentKind.CODEX
assert ultra_codex_model.model == "sol"
assert ultra_codex_model.effort == "ultra"
assert runner.codex_model_arguments(ultra_codex_model) == [
    "--model",
    "sol",
    "-c",
    'model_reasoning_effort="ultra"',
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
kimi_effort_model = runner.parse_model_spec("kimi/k2/max")
assert kimi_effort_model is not None
assert kimi_effort_model.model == "k2"
assert kimi_effort_model.effort == "max"
assert runner.kimi_environment(kimi_effort_model) == {
    "KIMI_MODEL_THINKING_EFFORT": "max"
}
kimi_alias_model = runner.parse_model_spec("kimi/kimi-code/k3")
assert kimi_alias_model is not None
assert kimi_alias_model.agent_kind == runner.AgentKind.KIMI
assert kimi_alias_model.model == "kimi-code/k3"
assert kimi_alias_model.effort is None
codex_slash_model = runner.parse_model_spec("codex/openai/gpt-5/max")
assert codex_slash_model is not None
assert codex_slash_model.model == "openai/gpt-5"
assert codex_slash_model.effort == "max"
deepseek_model = runner.parse_model_spec("deepseek/deepseek-v4-pro/max")
assert deepseek_model is not None
assert deepseek_model.agent_kind == runner.AgentKind.DEEPSEEK
assert deepseek_model.model == "deepseek-v4-pro"
assert deepseek_model.effort == "max"
assert runner.deepseek_model_environment(deepseek_model) == {
    "DEEPCODE_MODEL": "deepseek-v4-pro",
    "DEEPCODE_THINKING_ENABLED": "true",
    "DEEPCODE_REASONING_EFFORT": "max",
}
opencode_model = runner.parse_model_spec("oc/moonshotai/kimi-k3/minimal")
assert opencode_model is not None
assert opencode_model.agent_kind == runner.AgentKind.OPENCODE
assert opencode_model.model == "moonshotai/kimi-k3"
assert opencode_model.effort == "minimal"
assert runner.opencode_model_arguments(opencode_model) == [
    "--model",
    "moonshotai/kimi-k3",
    "--variant",
    "minimal",
]
muse_spark_model = runner.parse_model_spec(
    "opencode/opencode/muse-spark-1.2-contributor-free"
)
assert muse_spark_model is not None
assert muse_spark_model.agent_kind == runner.AgentKind.OPENCODE
assert muse_spark_model.model == "opencode/muse-spark-1.2-contributor-free"
assert muse_spark_model.effort is None
assert runner.opencode_model_arguments(muse_spark_model) == [
    "--model",
    "opencode/muse-spark-1.2-contributor-free",
]
opencode_go_glm_model = runner.parse_model_spec("opencode/opencode-go/glm-5.3")
assert opencode_go_glm_model is not None
assert opencode_go_glm_model.agent_kind == runner.AgentKind.OPENCODE
assert opencode_go_glm_model.model == "opencode-go/glm-5.3"
assert opencode_go_glm_model.effort is None
assert runner.opencode_model_arguments(opencode_go_glm_model) == [
    "--model",
    "opencode-go/glm-5.3",
]
with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    settings = runner.OrchestratorSettings(
        root_path=str(temp_root),
        invocation_directory=str(temp_root),
        max_agents=1,
        poll_interval_seconds=1,
        run_once=True,
        codex_mode=runner.CodexMode.DANGEROUS,
        default_agent=runner.AgentKind.CODEX,
        default_models={},
        codex_executable=sys.executable,
        claude_executable="claude",
        kimi_executable="kimi",
        deepseek_executable="deepcode",
        opencode_executable="opencode",
    )
    log_path = temp_root / "runner.log"
    agent_runner = runner.AgentRunner(
        settings, runner.BoardPaths(str(temp_root)), runner.LogSink(str(log_path))
    )
    started = time.monotonic()
    result = agent_runner._run_process(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        str(temp_root),
        "",
        lambda _line, _state: None,
        "NoSession",
        None,
        write_prompt_to_stdin=False,
        discover_session_id=lambda: None,
        session_discovery_timeout_seconds=0.2,
    )
    assert time.monotonic() - started < 5
    assert result.exit_code != 0
    assert result.session_id == ""
    assert "NoSession did not report a session id within 0.2 seconds" in log_path.read_text(
        encoding="utf-8"
    )
codex_default_model = runner.parse_agent_default_model(
    runner.AgentKind.CODEX, "gpt-5.6-sol/ultra"
)
assert codex_default_model.raw == "codex/gpt-5.6-sol/ultra"
assert codex_default_model.model == "gpt-5.6-sol"
assert codex_default_model.effort == "ultra"
raw_kimi_default_model = runner.parse_agent_default_model(
    runner.AgentKind.KIMI, "openrouter/moonshotai/kimi-k2"
)
assert raw_kimi_default_model.raw == "kimi/openrouter/moonshotai/kimi-k2"
assert raw_kimi_default_model.model == "openrouter/moonshotai/kimi-k2"
assert raw_kimi_default_model.effort is None
with tempfile.TemporaryDirectory() as temp_dir:
    temp_home = Path(temp_dir)
    kimi_config = temp_home / ".kimi-code" / "config.toml"
    kimi_config.parent.mkdir(parents=True)
    kimi_config.write_text(
        """default_model = "kimi-code/k3"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"

[models."kimi-code/k3-256k"]
provider = "managed:kimi-code"
model = "k3-256k"
""",
        encoding="utf-8",
    )
    old_home = os.environ.get("HOME")
    old_userprofile = os.environ.get("USERPROFILE")
    old_kimi_code_home = os.environ.get("KIMI_CODE_HOME")
    os.environ["HOME"] = str(temp_home)
    os.environ["USERPROFILE"] = str(temp_home)
    os.environ["KIMI_CODE_HOME"] = str(kimi_config.parent)
    try:
        assert runner.configured_kimi_model_aliases() == [
            "kimi-code/k3",
            "kimi-code/k3-256k",
        ]
        assert runner.kimi_model_arguments(runner.parse_model_spec("kimi/k3")) == [
            "--model",
            "kimi-code/k3",
        ]
        assert runner.kimi_model_arguments(
            runner.parse_model_spec("kimi/kimi-code/k3")
        ) == [
            "--model",
            "kimi-code/k3",
        ]
        assert runner.kimi_model_arguments(runner.parse_model_spec("kimi/k3/max")) == [
            "--model",
            "kimi-code/k3",
        ]
        assert runner.kimi_environment(runner.parse_model_spec("kimi/k3/max")) == {
            "KIMI_MODEL_THINKING_EFFORT": "max"
        }
        assert (
            runner.encode_kimi_workdir_key(r"D:\life\projects\blank\lego")
            == "wd_lego_9d40b0ddb157"
        )
        runner.trust_kimi_workspace(r"D:\life\projects\blank\lego")
        trust_path = (
            kimi_config.parent / "workspace-trust" / "wd_lego_9d40b0ddb157"
        )
        assert trust_path.exists()
        trust_payload = json.loads(trust_path.read_text(encoding="utf-8"))
        assert trust_payload["root"].replace("\\", "/") == "D:/life/projects/blank/lego"
        assert isinstance(trust_payload["trustedAt"], int)
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
        if old_userprofile is None:
            os.environ.pop("USERPROFILE", None)
        else:
            os.environ["USERPROFILE"] = old_userprofile
        if old_kimi_code_home is None:
            os.environ.pop("KIMI_CODE_HOME", None)
        else:
            os.environ["KIMI_CODE_HOME"] = old_kimi_code_home
runner_source = Path(runner.__file__).read_text(encoding="utf-8")
assert "UnicodeEncodeError" in runner_source
assert 'errors="replace"' in runner_source
assert ".kanban-runner-prompt-" in runner_source
assert "Do not ask what the task is or where runner.py" in runner_source
assert "SO_EXCLUSIVEADDRUSE" in runner_source
assert 'hasattr(socket, "SO_EXCLUSIVEADDRUSE")' in runner_source
assert "else:\n                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)" in runner_source
assert "GIT_COMMAND_TIMEOUT_SECONDS" in runner_source
assert '"GIT_TERMINAL_PROMPT": "0"' in runner_source
assert '"GCM_INTERACTIVE": "never"' in runner_source
assert "timed out after {GIT_COMMAND_TIMEOUT_SECONDS} seconds" in runner_source
assert "exiting duplicate runner" in runner_source
assert "model_spec = card.model_spec or (" in runner_source
assert "self.settings.default_models.get(AgentKind.OPENCODE)" in runner_source
raw_model = runner.parse_model_spec("openrouter/moonshotai/kimi-k2")
assert raw_model is not None
assert raw_model.agent_kind is None
assert raw_model.model == "openrouter/moonshotai/kimi-k2"
assert runner.kimi_model_arguments(runner.parse_model_spec("kimi/k2/max")) == [
    "--model",
    "k2",
]
assert runner.kimi_environment(runner.parse_model_spec("kimi/k2/max")) == {
    "KIMI_MODEL_THINKING_EFFORT": "max"
}
try:
    runner.deepseek_model_environment(runner.parse_model_spec("deepseek/deepseek-v4-pro/ultra"))
    raise AssertionError("DeepSeek unsupported effort should be rejected")
except ValueError as exc:
    assert "Deep Code supports only high or max reasoning effort" in str(exc)


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
        default_models={
            runner.AgentKind.CLAUDE: runner.parse_agent_default_model(
                runner.AgentKind.CLAUDE, "sonnet/max"
            )
        },
        codex_executable="codex",
        claude_executable="claude",
        kimi_executable="kimi",
        deepseek_executable="deepcode",
        opencode_executable="opencode",
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
    default_model_task_path = temp_root / "default-model-task.md"
    default_model_task_path.write_text(
        """# Default model task

Tags:
Project: blank
Model:
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    default_model_card = runner.TaskCard.load(
        str(default_model_task_path), runner.TaskStep.BACKLOG, paths
    )
    agent_runner = runner.ClaudeRunner(settings, paths, runner.LogSink(str(temp_root / "runner.log")))
    selected_default_model = agent_runner.model_spec_for(
        default_model_card, runner.AgentKind.CLAUDE
    )
    assert selected_default_model is not None
    assert selected_default_model.raw == "claude/sonnet/max"

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

    manual_task_path = temp_root / "manual-task.md"
    manual_task_path.write_text(
        """# Manual task

Tags: human
Project:
Model:
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    manual_card = runner.TaskCard.load(str(manual_task_path), runner.TaskStep.BACKLOG, paths)
    assert manual_card.is_manual
    assert resolver.should_manage_manually(manual_card)
    try:
        resolver.select_agent_kind(manual_card)
        raise AssertionError("Manual cards should not select an agent")
    except ValueError as exc:
        assert "manual/human" in str(exc)

    manual_default_settings = runner.OrchestratorSettings(
        root_path=str(temp_root),
        invocation_directory=str(temp_root),
        max_agents=1,
        poll_interval_seconds=1,
        run_once=True,
        codex_mode=runner.CodexMode.DANGEROUS,
        default_agent=runner.MANUAL_AGENT_VALUE,
        default_models={},
        codex_executable="codex",
        claude_executable="claude",
        kimi_executable="kimi",
        deepseek_executable="deepcode",
        opencode_executable="opencode",
    )
    manual_default_resolver = runner.AgentResolver(
        manual_default_settings, runner.LogSink(str(temp_root / "manual-runner.log"))
    )
    manual_default_resolver.is_agent_available = lambda _kind: True

    unassigned_task_path = temp_root / "unassigned-task.md"
    unassigned_task_path.write_text(
        """# Unassigned task

Tags:
Project:
Model:
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    unassigned_card = runner.TaskCard.load(
        str(unassigned_task_path), runner.TaskStep.BACKLOG, paths
    )
    assert manual_default_resolver.should_manage_manually(unassigned_card)

    explicit_agent_task_path = temp_root / "explicit-agent-task.md"
    explicit_agent_task_path.write_text(
        """# Explicit agent task

Tags: codex
Project:
Model:
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    explicit_agent_card = runner.TaskCard.load(
        str(explicit_agent_task_path), runner.TaskStep.BACKLOG, paths
    )
    assert not manual_default_resolver.should_manage_manually(explicit_agent_card)
    assert manual_default_resolver.select_agent_kind(explicit_agent_card) == runner.AgentKind.CODEX

    explicit_model_task_path = temp_root / "explicit-model-task.md"
    explicit_model_task_path.write_text(
        """# Explicit model task

Tags:
Project:
Model: kimi/k2
Agent:
Repo:

## Description
""",
        encoding="utf-8",
    )
    explicit_model_card = runner.TaskCard.load(
        str(explicit_model_task_path), runner.TaskStep.BACKLOG, paths
    )
    assert not manual_default_resolver.should_manage_manually(explicit_model_card)
    assert manual_default_resolver.select_agent_kind(explicit_model_card) == runner.AgentKind.KIMI


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
    temp_home = temp_root / "home"
    workdir = temp_root / "projects" / "blank" / "deep-task"

    old_home = os.environ.get("HOME")
    old_userprofile = os.environ.get("USERPROFILE")
    os.environ["HOME"] = str(temp_home)
    os.environ["USERPROFILE"] = str(temp_home)
    try:
        session_id = "11111111-1111-4111-8111-111111111111"
        project_dir = Path(runner.DeepCodeSessions.project_dir(str(workdir)))
        project_dir.mkdir(parents=True)
        (project_dir / "sessions-index.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "entries": [
                        {
                            "id": session_id,
                            "status": "pending",
                            "assistantReply": "ORCHESTRATOR_STATUS: DONE",
                        }
                    ],
                    "originalPath": str(workdir),
                }
            ),
            encoding="utf-8",
        )
        session_file = project_dir / f"{session_id}.jsonl"
        session_file.write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "role": "user",
                            "content": "ORCHESTRATOR_STATUS: DONE",
                        }
                    ),
                    json.dumps(
                        {
                            "role": "assistant",
                            "content": "ORCHESTRATOR_STATUS: BLOCKED",
                        }
                    ),
                ]
            ),
            encoding="utf-8",
        )
        assert (
            runner.DeepCodeSessions.final_assistant_record_message(
                str(workdir), session_id
            )
            == "ORCHESTRATOR_STATUS: BLOCKED"
        )
        assert (
            runner.DeepCodeSessions.final_assistant_message(str(workdir), session_id)
            == "ORCHESTRATOR_STATUS: BLOCKED"
        )
        session_file.write_text(
            json.dumps({"role": "user", "content": "ORCHESTRATOR_STATUS: DONE"}),
            encoding="utf-8",
        )
        assert (
            runner.DeepCodeSessions.final_assistant_record_message(
                str(workdir), session_id
            )
            == ""
        )
        assert (
            runner.DeepCodeSessions.final_assistant_message(str(workdir), session_id)
            == "ORCHESTRATOR_STATUS: DONE"
        )
        assert runner.DeepCodeSessions.session_status(str(workdir), session_id) == "pending"
        session_file.write_text(
            json.dumps(
                {
                    "role": "tool",
                    "content": json.dumps(
                        {
                            "awaitUserResponse": True,
                            "metadata": {
                                "kind": "ask_user_question",
                                "questions": [
                                    {
                                        "question": "What is the actual task?",
                                        "options": [{"label": "Answer manually"}],
                                    },
                                    {
                                        "question": "Where is the board?",
                                        "options": [{"label": "Use provided path"}],
                                    },
                                ],
                            },
                        }
                    ),
                }
            ),
            encoding="utf-8",
        )
        assert runner.DeepCodeSessions.pending_user_questions(str(workdir), session_id) == [
            "What is the actual task?",
            "Where is the board?",
        ]
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
  "kanban.deepseekExecutable": "custom-deepcode",
  "kanban.opencodeExecutable": "custom-opencode",
  "kanban.defaultModels": {
    "codex": "gpt-5.6-sol/ultra",
    "claude": "claude/sonnet/max",
    "opencode": "moonshotai/kimi-k3/minimal"
  },
}
""",
        encoding="utf-8",
    )
    tasks_dir = temp_root / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / ".kanban").write_text(
        """defaultModels:
  codex: gpt-5.6-terra/high
  deepseek: deepseek-v4-flash/high
  opencode: opencode/deepseek/deepseek-v4-pro/max
folders:
  backlog: backlog
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
        assert parsed.deepseek_executable == "custom-deepcode"
        assert parsed.opencode_executable == "custom-opencode"
        assert (
            parsed.default_models[runner.AgentKind.CODEX].raw
            == "codex/gpt-5.6-terra/high"
        )
        assert (
            parsed.default_models[runner.AgentKind.CLAUDE].raw
            == "claude/sonnet/max"
        )
        assert (
            parsed.default_models[runner.AgentKind.DEEPSEEK].raw
            == "deepseek/deepseek-v4-flash/high"
        )
        assert (
            parsed.default_models[runner.AgentKind.OPENCODE].raw
            == "opencode/deepseek/deepseek-v4-pro/max"
        )

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
                "--deepseek-executable",
                "cli-deepcode",
                "--opencode-executable",
                "cli-opencode",
            ],
            str(temp_root),
        )
        assert override.default_agent == runner.AgentKind.KIMI
        assert override.codex_executable == "cli-codex"
        assert override.claude_executable == "custom-claude"
        assert override.kimi_executable == "cli-kimi"
        assert override.deepseek_executable == "cli-deepcode"
        assert override.opencode_executable == "cli-opencode"
        manual_override = runner.OrchestratorSettings.parse(
            ["--root", str(temp_root), "--default-agent", "manual"],
            str(temp_root),
        )
        assert manual_override.default_agent == runner.MANUAL_AGENT_VALUE
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


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(
        ["--root", str(temp_root), "--once", "--default-agent", "manual"],
        str(temp_root),
    )
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    manual_tag_path = temp_root / "tasks" / "backlog" / "manual-tag.md"
    manual_tag_path.write_text(
        """# Manual tag

Tags: manual
Project:
Model:
Agent:
Repo:

## Description

User will handle this.
""",
        encoding="utf-8",
    )
    default_manual_path = temp_root / "tasks" / "backlog" / "default-manual.md"
    default_manual_path.write_text(
        """# Default manual

Tags:
Project:
Model:
Agent:
Repo:

## Description

User will handle this by default.
""",
        encoding="utf-8",
    )

    def unexpected_start(_card, _assignment):
        raise AssertionError("Manual cards should not be started")

    orchestrator.start_or_resume_task = unexpected_start
    orchestrator.reconcile()
    assert manual_tag_path.exists()
    assert default_manual_path.exists()
    assert "Project: blank" not in manual_tag_path.read_text(encoding="utf-8")
    assert "Project: blank" not in default_manual_path.read_text(encoding="utf-8")


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    task_path = temp_root / "tasks" / "backlog" / "shutdown-git.md"
    task_path.write_text(
        """# Shutdown git

Tags:
Project: nmc
Model: codex/test
Agent:
Repo:

## Description

Do not start this after shutdown.
""",
        encoding="utf-8",
    )
    reusable_repo = temp_root / "cache" / "nmc" / "repo"
    (reusable_repo / ".git").mkdir(parents=True)
    original_refresh = runner.GitCli.refresh

    def interrupted_refresh(_repo_path, _log, stop_event=None):
        assert stop_event is orchestrator.stop_event
        orchestrator.stop_event.set()
        raise runner.ShutdownRequested("test shutdown")

    try:
        runner.GitCli.refresh = interrupted_refresh
        card = runner.TaskCard.load(str(task_path), runner.TaskStep.BACKLOG, orchestrator.paths)
        orchestrator.start_or_resume_task(
            card, runner.ProjectAssignment.repository("nmc", "https://example.invalid/repo.git")
        )
    finally:
        runner.GitCli.refresh = original_refresh

    assert task_path.exists()
    assert not (temp_root / "tasks" / "doing" / "shutdown-git.md").exists()
    assert orchestrator._active_count() == 0


with tempfile.TemporaryDirectory() as temp_dir:
    temp_root = Path(temp_dir)
    parsed = runner.OrchestratorSettings.parse(["--root", str(temp_root), "--once"], str(temp_root))
    orchestrator = runner.TaskOrchestrator(parsed)
    orchestrator.ensure_board_scaffold()
    task_path = temp_root / "tasks" / "backlog" / "shutdown-after-provision.md"
    task_path.write_text(
        """# Shutdown after provision

Tags:
Project: -
Model: codex/test
Agent:
Repo:

## Description

Do not move this after shutdown.
""",
        encoding="utf-8",
    )
    repo_path = temp_root / "projects" / "blank" / "shutdown-after-provision"
    repo_path.mkdir(parents=True)

    def provision_then_shutdown(_card, _assignment):
        orchestrator.stop_event.set()
        return str(repo_path)

    orchestrator.ensure_working_repository = provision_then_shutdown
    card = runner.TaskCard.load(str(task_path), runner.TaskStep.BACKLOG, orchestrator.paths)
    orchestrator.start_or_resume_task(card, runner.ProjectAssignment.blank())

    assert task_path.exists()
    assert not (temp_root / "tasks" / "doing" / "shutdown-after-provision.md").exists()
    assert orchestrator._active_count() == 0
