import importlib.util
import sys
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
assert "Agent Kind:" in ensured
assert runner.agent_kind_from_value("claude") == runner.AgentKind.CLAUDE
assert runner.agent_kind_from_value("agent:codex") == runner.AgentKind.CODEX
