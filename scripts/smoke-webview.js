const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension.ts"),
  "utf8"
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);
const startMarker = "return `<!DOCTYPE html>";
const endMarker = "</html>`;";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

assert.notEqual(start, -1, "getHtml template start not found");
assert.notEqual(end, -1, "getHtml template end not found");

const templateLiteral = source.slice(
  start + "return ".length,
  end + "</html>`".length
);
const html = vm.runInNewContext(
  `(() => {
    const csp = "csp";
    const nonce = "nonce";
    const detailsPaneWidth = 360;
    const MIN_DETAILS_PANE_WIDTH = 280;
    const MAX_DETAILS_PANE_WIDTH = 720;
    return ${templateLiteral};
  })()`,
  {}
);
const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>/);
const openLocalPathSource = source.match(
  /public async openLocalPath[\s\S]*?\n  public async openUrl/
);

assert.ok(scriptMatch, "webview script block not found");
assert.ok(openLocalPathSource, "openLocalPath source block not found");
assert.match(
  openLocalPathSource[0],
  /await vscode\.env\.openExternal\(uri\);/,
  "local filesystem Open should use the OS external opener"
);
assert.doesNotMatch(
  openLocalPathSource[0],
  /executeCommand\("vscode\.open"/,
  "local filesystem Open should not open files in a VS Code editor"
);
assert.equal(
  manifest.contributes.configuration.properties["kanban.defaultAgent"].default,
  null,
  "manifest should default runner agent selection to auto detection"
);
assert.deepEqual(
  manifest.contributes.configuration.properties["kanban.runner.args"].default,
  [
    "${runnerScript}",
    "--root",
    "${runnerRoot}",
    "--default-agent",
    "${defaultAgent}",
    "--codex-executable",
    "${codexExecutable}",
    "--claude-executable",
    "${claudeExecutable}",
    "--kimi-executable",
    "${kimiExecutable}",
  ],
  "default runner args should pass agent settings to runner.py"
);
assert.ok(
  manifest.contributes.configuration.properties["kanban.defaultAgent"].enum.includes("kimi"),
  "default agent setting should include Kimi"
);
assert.equal(
  manifest.contributes.configuration.properties["kanban.kimiExecutable"].default,
  "kimi",
  "manifest should expose a Kimi executable setting"
);
assert.match(
  source,
  /const DEFAULT_AGENT_SETTING = "defaultAgent";/,
  "extension should read the default agent setting"
);
assert.ok(
  manifest.contributes.commands.some((command) => command.command === "kanban.initializeRunner"),
  "manifest should expose an Initialize Runner command"
);
assert.match(
  source,
  /provider\.initializeRunner\(target\)/,
  "extension should register the Initialize Runner command"
);
assert.match(
  source,
  /ensureRootRunnerIgnoredFolders\(kanbanUri\)/,
  "root-board runner initialization should add ignored runtime folders"
);
assert.match(
  source,
  /path\.join\(paths\.runnerRoot,\s*RUNNER_SCRIPT_NAME\)/,
  "runner initialization should place runner.py at the runner root"
);
assert.doesNotMatch(
  source,
  /path\.join\(paths\.kanbanDir,\s*RUNNER_SCRIPT_NAME\)/,
  "runner initialization should not place runner.py inside tasks for nested boards"
);
assert.match(
  source,
  /blank = https:\/\/github\.com\/flcl42\/blank\.git/,
  "runner initialization should seed projects.md with the blank project alias"
);
assert.match(
  source,
  /knowledge[\s\S]*README\.md/,
  "runner initialization should seed knowledge/README.md"
);
assert.match(
  source,
  /DEFAULT_TASK_TEMPLATE_TEXT[\s\S]*# \{\{TITLE\}\}[\s\S]*Project: \{\{CURSOR\}\}[\s\S]*Model:/,
  "runner initialization should define the default task template"
);
assert.match(
  source,
  /ensureTaskTemplateFile\(kanbanUri\)/,
  "runner initialization should seed template.md beside .kanban"
);
assert.match(
  source,
  /const agentOutputMd = new MarkdownIt\([\s\S]*breaks:\s*true/,
  "agent output should render Markdown while preserving single line breaks"
);
assert.match(
  source,
  /outputHtml:\s*output\.outputHtml/,
  "agent output messages should carry rendered Markdown HTML"
);
assert.match(
  source,
  /formatRecentAgentOutputBlocks\(outputBlocks\)/,
  "agent output extraction should preserve recent Markdown blocks"
);
assert.doesNotMatch(
  source,
  /prepareRunnerKanbanLocation/,
  "runner initialization should not move a root .kanban into tasks"
);
assert.doesNotMatch(
  source,
  /\bterminal\.sendText\(\s*sessionCwd\s*\?\s*`codex resume/,
  "resume-agent terminals should not hard-code the codex executable"
);
assert.match(
  source,
  /--session \$\{trimmed\}/,
  "resume-agent terminals should use Kimi session resume syntax"
);
assert.match(
  source,
  /function renderMarkdownWithTaskLists/,
  "card details should render Markdown through the task-list aware renderer"
);
assert.match(
  source,
  /message\?\.type === "toggleTaskCheckbox"/,
  "details checkbox changes should be handled by the extension host"
);
assert.doesNotThrow(
  () => new Function(scriptMatch[1]),
  "webview script should parse"
);
assert.doesNotMatch(
  html,
  /\.board\s*\{[^}]*align-items:\s*start;/,
  "board columns should stretch to a shared height"
);
assert.match(
  html,
  /\.board-pane\s*\{[^}]*min-height:\s*0;[^}]*height:\s*calc\(100vh - 32px\);/,
  "board pane should be viewport-bounded so long columns scroll inside it"
);
assert.match(
  html,
  /\.board-scroll\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*padding-bottom:\s*8px;/,
  "board scrolling should happen inside the board pane so sticky column headers keep working"
);
assert.match(
  html,
  /\.layout\s*\{[^}]*grid-template-columns:[^}]*var\(--details-resizer-width\)[^}]*var\(--details-pane-width\)[^}]*min-height:\s*100vh;/,
  "layout should reserve a draggable separator and a configurable details pane width"
);
assert.match(
  html,
  /\.details-resizer\s*\{[^}]*cursor:\s*col-resize;/,
  "details pane should expose a resize handle"
);
assert.match(
  html,
  /\.column-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/,
  "column headers should stay visible while scrolling long columns"
);
assert.match(
  html,
  /\.card h3\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
  "long unbroken card titles should be clipped inside the card"
);
assert.match(
  html,
  /\.details\s*\{[^}]*align-self:\s*start;[^}]*position:\s*sticky;[^}]*top:\s*16px;/,
  "details pane should stay pinned while the board scrolls"
);
assert.match(
  html,
  /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.details-resizer\s*\{[^}]*display:\s*none;[\s\S]*?\.board-pane\s*\{[^}]*height:\s*auto;[\s\S]*?\.details\s*\{[^}]*position:\s*static;[^}]*top:\s*auto;[^}]*height:\s*auto;/,
  "mobile layout should hide the resize handle and reset the fixed-height board pane and sticky details pane"
);

function createStyleDeclaration() {
  const values = new Map();
  return {
    setProperty(name, value) {
      const stringValue = String(value);
      values.set(name, stringValue);
      this[name] = stringValue;
    },
    getPropertyValue(name) {
      if (values.has(name)) {
        return values.get(name);
      }
      const direct = this[name];
      return typeof direct === "string" ? direct : "";
    },
  };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.className = "";
    this.classList = { add() {}, remove() {} };
    this.style = createStyleDeclaration();
    this.draggable = false;
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.placeholder = "";
    this.selected = false;
    this.listeners = {};
    this.attributes = new Map();
    this.children = [];
    this._innerHTML = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    activeElement = this;
  }

  select() {
    this.selected = true;
    activeElement = this;
  }

  blur() {
    if (activeElement === this) {
      activeElement = null;
    }
  }

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }

  remove() {
    this.removed = true;
  }
}

const boardEl = new FakeElement("section");
const layoutEl = new FakeElement("div");
const detailsEl = new FakeElement("aside");
const detailsResizerEl = new FakeElement("div");
const searchInputEl = new FakeElement("input");
const tagFilterEl = new FakeElement("select");
const searchMetaEl = new FakeElement("div");
const searchClearEl = new FakeElement("button");
const agentCountEl = new FakeElement("div");
const runnerPanelEl = new FakeElement("div");
const windowListeners = {};
const messages = [];
let activeElement = null;

detailsEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 100 });

function createDataTransfer() {
  const values = new Map();
  return {
    types: [],
    effectAllowed: "move",
    setData(type, value) {
      if (!this.types.includes(type)) {
        this.types.push(type);
      }
      values.set(type, String(value));
    },
    getData(type) {
      return values.get(type) ?? "";
    },
  };
}

const context = {
  console,
  navigator: { platform: "Win32" },
  Date,
  JSON,
  Math,
  Array,
  String,
  Number,
  Object,
  RegExp,
  setInterval: () => 1,
  clearInterval: () => {},
  acquireVsCodeApi: () => ({
    postMessage(message) {
      messages.push(message);
    },
  }),
  document: {
    documentElement: {
      style: createStyleDeclaration(),
    },
    getElementById(id) {
      if (id === "board") {
        return boardEl;
      }
      if (id === "layout") {
        return layoutEl;
      }
      if (id === "details") {
        return detailsEl;
      }
      if (id === "details-resizer") {
        return detailsResizerEl;
      }
      if (id === "board-search-input") {
        return searchInputEl;
      }
      if (id === "board-tag-filter") {
        return tagFilterEl;
      }
      if (id === "search-meta") {
        return searchMetaEl;
      }
      if (id === "search-clear") {
        return searchClearEl;
      }
      if (id === "board-agent-count") {
        return agentCountEl;
      }
      if (id === "runner-panel") {
        return runnerPanelEl;
      }
      return new FakeElement();
    },
    get activeElement() {
      return activeElement;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  },
  window: {
    innerWidth: 1440,
    addEventListener(type, handler) {
      windowListeners[type] = handler;
    },
  },
  Element: FakeElement,
};

vm.runInNewContext(scriptMatch[1], context);

assert.equal(messages[0]?.type, "ready", "webview should request board data");
assert.equal(typeof windowListeners.message, "function", "message listener missing");
assert.equal(typeof windowListeners.keydown, "function", "keydown listener missing");
assert.equal(typeof windowListeners.mousemove, "function", "mousemove listener missing");
assert.equal(typeof windowListeners.mouseup, "function", "mouseup listener missing");
assert.equal(typeof detailsEl.listeners.change, "function", "details checkbox change listener missing");
assert.match(searchInputEl.placeholder, /Ctrl\+F/, "search input should advertise the shortcut");
assert.match(html, /id="board-tag-filter"/, "tag filter selector should render next to search");
assert.match(html, /id="board-agent-count"/, "active agent count should render next to the tag filter");
assert.match(
  html,
  /\.board-tag-filter-select\s*\{[^}]*background:\s*var\(--vscode-dropdown-background,\s*var\(--panel\)\);[^}]*color:\s*var\(--vscode-dropdown-foreground,\s*var\(--ink\)\);/,
  "tag filter selector should use VS Code dropdown theme colors"
);
windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: false,
      requirements: {
        python: {
          label: "Python",
          command: "python",
          installed: true,
          version: "Python 3.11.9",
          installUrl: "https://www.python.org/downloads/",
        },
        agent: {
          label: "Claude Code, Codex CLI, or Kimi CLI",
          command: "claude / codex / kimi",
          installed: false,
          version: "",
          installUrl: "https://docs.anthropic.com/en/docs/claude-code",
        },
      },
      message: "Runner start requested.",
    },
  },
});
assert.equal(runnerPanelEl.hidden, false, "runner panel should be visible when no runner is active");
assert.match(
  runnerPanelEl.innerHTML,
  /No local runner script found/,
  "runner panel should ask to create a local runner script when the default runner is missing"
);
assert.doesNotMatch(runnerPanelEl.innerHTML, /Python/, "runner panel should hide installed tool rows");
assert.match(runnerPanelEl.innerHTML, /Claude Code, Codex CLI, or Kimi CLI/, "runner panel should show missing auto-agent status");
assert.match(runnerPanelEl.innerHTML, /data-action-type="openRunnerLink"/, "missing runner tools should render install links");
assert.match(runnerPanelEl.innerHTML, /data-action-type="hideRunnerPanel"/, "runner panel should expose a hide action");
assert.match(runnerPanelEl.innerHTML, /by default/, "runner panel hide should expose a persistent setting checkbox");

const installAgentButton = new FakeElement("button");
installAgentButton.setAttribute("data-action-type", "openRunnerLink");
installAgentButton.setAttribute("data-action-url", "https://docs.anthropic.com/en/docs/claude-code");
installAgentButton.closest = () => installAgentButton;
runnerPanelEl.listeners.click({
  target: installAgentButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(messages.at(-1)?.type, "openUrl", "runner install links should open externally");
assert.equal(messages.at(-1)?.url, "https://docs.anthropic.com/en/docs/claude-code");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: false,
      requirements: {
        python: {
          label: "Python",
          command: "python",
          installed: true,
          version: "Python 3.11.9",
          installUrl: "https://www.python.org/downloads/",
        },
        agent: {
          label: "Claude Code, Codex CLI, or Kimi CLI",
          command: "claude / codex / kimi",
          installed: false,
          version: "",
          installUrl: "https://docs.anthropic.com/en/docs/claude-code",
        },
      },
    },
  },
});

const createRunnerButton = new FakeElement("button");
createRunnerButton.setAttribute("data-action-type", "createRunner");
createRunnerButton.closest = () => createRunnerButton;
runnerPanelEl.listeners.click({
  target: createRunnerButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(messages.at(-1)?.type, "createRunner", "runner panel should request local runner creation");
assert.match(runnerPanelEl.innerHTML, /Initializing/, "runner panel should show pending initialization state");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: true,
      requirements: {
        python: {
          label: "Python",
          command: "python",
          installed: true,
          version: "Python 3.11.9",
          installUrl: "https://www.python.org/downloads/",
        },
        agent: {
          label: "Claude Code, Codex CLI, or Kimi CLI",
          command: "claude / codex / kimi",
          installed: true,
          version: "Claude Code 1.0.0",
          installUrl: "https://docs.anthropic.com/en/docs/claude-code",
        },
      },
    },
  },
});
assert.match(runnerPanelEl.innerHTML, /No Kanban runner detected/, "runner panel should warn about a missing runner");
assert.doesNotMatch(runnerPanelEl.innerHTML, /Install requirements/, "start should be available when runner tools are installed");
assert.match(
  runnerPanelEl.innerHTML,
  /keeps working if VS Code closes/,
  "runner panel should explain that the runner is detached from VS Code"
);

const startRunnerButton = new FakeElement("button");
startRunnerButton.setAttribute("data-action-type", "startRunner");
startRunnerButton.closest = () => startRunnerButton;
runnerPanelEl.listeners.click({
  target: startRunnerButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(messages.at(-1)?.type, "startRunner", "runner panel should request runner startup");
assert.match(runnerPanelEl.innerHTML, /Starting/, "runner panel should show pending startup state");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: true,
    },
  },
});
assert.equal(runnerPanelEl.hidden, true, "runner panel should hide when a runner status endpoint is detected");
assert.equal(agentCountEl.hidden, false, "runner count should show when a runner is connected");
assert.equal(agentCountEl.textContent, "0 running agents", "runner count should show zero active agents");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: true,
      activeAgentCount: 2,
    },
  },
});
assert.equal(agentCountEl.hidden, false, "active agent count should show when agents are active");
assert.equal(agentCountEl.textContent, "2 running agents", "active agent count should render explicit text");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: false,
      running: true,
      activeAgentCount: 3,
    },
  },
});
assert.equal(
  agentCountEl.hidden,
  false,
  "active agent count should still show when the runner warning panel is disabled"
);
assert.equal(agentCountEl.textContent, "3 running agents");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: true,
      requirements: {
        python: {
          label: "Python",
          command: "python",
          installed: true,
          version: "Python 3.11.9",
          installUrl: "https://www.python.org/downloads/",
        },
        agent: {
          label: "Claude Code, Codex CLI, or Kimi CLI",
          command: "claude / codex / kimi",
          installed: true,
          version: "Claude Code 1.0.0",
          installUrl: "https://docs.anthropic.com/en/docs/claude-code",
        },
      },
    },
  },
});
const messageCountBeforeSessionHide = messages.length;
const hideRunnerPanelButton = new FakeElement("button");
hideRunnerPanelButton.setAttribute("data-action-type", "hideRunnerPanel");
hideRunnerPanelButton.closest = () => hideRunnerPanelButton;
runnerPanelEl.querySelector = () => ({ checked: false });
runnerPanelEl.listeners.click({
  target: hideRunnerPanelButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(runnerPanelEl.hidden, true, "runner panel should hide for the current session");
assert.equal(messages.length, messageCountBeforeSessionHide, "session-only hide should not update user settings");
assert.equal(
  context.document.documentElement.style.getPropertyValue("--details-pane-width"),
  "360px",
  "details pane should initialize from the configured width"
);

detailsResizerEl.listeners.mousedown({
  button: 0,
  clientX: 800,
  preventDefault() {},
});
windowListeners.mousemove({ clientX: 740 });

assert.equal(
  context.document.documentElement.style.getPropertyValue("--details-pane-width"),
  "420px",
  "dragging the details separator should resize the details pane"
);

windowListeners.mouseup({});

assert.equal(messages.at(-1)?.type, "saveDetailsPaneWidth", "releasing the separator should persist the width");
assert.equal(messages.at(-1)?.width, 420);

windowListeners.message({
  data: {
    type: "detailsPaneWidth",
    width: 500,
  },
});

assert.equal(
  context.document.documentElement.style.getPropertyValue("--details-pane-width"),
  "500px",
  "details width updates from the extension host should be applied immediately"
);

windowListeners.message({
  data: {
    type: "boardData",
    board: {
      columns: [
        {
          id: "Doing",
          name: "Doing",
          order: 1,
          cards: [
            {
              uri: "file:///task.md",
              fileName: "task.md",
              title: "Ship it",
              searchText: [
                "ship it",
                "task.md",
                "jane",
                "kanban",
                "ship",
                "description line 55",
              ].join("\n"),
              properties: [
                { key: "Tags", label: "Tags", value: "ship", action: null },
                {
                  key: "Agent",
                  label: "Agent",
                  value: "019d0095-6102-7fe2-9fc8-5db0155692e9",
                  action: {
                    command: "resumeAgent",
                    title: "Connect",
                    value: "019d0095-6102-7fe2-9fc8-5db0155692e9",
                  },
                },
                {
                  key: "Agent Kind",
                  label: "Agent Kind",
                  value: "claude",
                  action: null,
                },
                {
                  key: "Project",
                  label: "Project",
                  value: "kanban",
                  action: null,
                },
                {
                  key: "Repo",
                  label: "Repo",
                  value: "C:\\work\\demo",
                  action: { command: "openPath", title: "Terminal", value: "C:\\work\\demo" },
                  actions: [
                    { command: "openPath", title: "Terminal", value: "C:\\work\\demo" },
                    { command: "openCode", title: "Code", value: "C:\\work\\demo" },
                  ],
                },
                {
                  key: "Path",
                  label: "Path",
                  value: "C:\\work\\demo",
                  action: { command: "openPath", title: "Terminal", value: "C:\\work\\demo" },
                  actions: [
                    { command: "openPath", title: "Terminal", value: "C:\\work\\demo" },
                    { command: "openLocalPath", title: "Open", value: "C:\\work\\demo" },
                  ],
                },
                {
                  key: "URL",
                  label: "URL",
                  value: "https://example.com/task",
                  action: { command: "openUrl", title: "Open", value: "https://example.com/task" },
                  actions: [
                    { command: "openUrl", title: "Open", value: "https://example.com/task" },
                  ],
                },
                { key: "Owner", label: "Owner", value: "Jane", action: null },
              ],
              tags: ["ship"],
              priority: 2,
              createdAt: 1000,
              updatedAt: 2000,
            },
            {
              uri: "file:///second.md",
              fileName: "second.md",
              title: "Second card",
              searchText: "second card\nsecond.md",
              properties: [],
              tags: [],
              priority: 3,
              createdAt: 1000,
              updatedAt: 2000,
            },
          ],
        },
        {
          id: "Backlog",
          name: "Backlog",
          order: 2,
          cards: [
            {
              uri: "file:///existing.md",
              fileName: "existing.md",
              title: "Existing card",
              searchText: "existing card\nexisting.md",
              properties: [],
              tags: [],
              priority: 1,
              createdAt: 1000,
              updatedAt: 2000,
            },
          ],
        },
      ],
    },
  },
});

assert.equal(boardEl.children.length, 2, "expected two rendered columns");
assert.equal(boardEl.children[0].dataset.column, "Doing", "column id should be rendered");
assert.equal(boardEl.children[1].dataset.column, "Backlog", "second column id should be rendered");
assert.equal(boardEl.children[0].children.length, 3, "expected header and two cards");
assert.equal(boardEl.children[1].children.length, 2, "expected second column header and one card");
assert.equal(boardEl.children[0].children[0].children[0].textContent, "Doing (2)");
assert.equal(boardEl.children[1].children[0].children[0].textContent, "Backlog (1)");
windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: true,
      activeAgentCount: 2,
    },
  },
});
assert.match(
  searchMetaEl.textContent,
  /3 cards.*2 running agents/,
  "card summary should include active agent count when a runner reports active work"
);
let columnRenamePrevented = false;
let columnRenameStopped = false;
boardEl.children[0].children[0].children[0].listeners.dblclick({
  preventDefault() {
    columnRenamePrevented = true;
  },
  stopPropagation() {
    columnRenameStopped = true;
  },
});
assert.equal(columnRenamePrevented, true, "column-title double click should prevent default selection handling");
assert.equal(columnRenameStopped, true, "column-title double click should not start a header drag");
assert.equal(messages.at(-1)?.type, "renameColumn", "column-title double click should request a rename");
assert.equal(messages.at(-1)?.columnId, "Doing");
assert.equal(messages.at(-1)?.currentTitle, "Doing");
assert.match(searchMetaEl.textContent, /3 cards/, "search summary should show card count");
assert.equal(searchClearEl.hidden, true, "clear button should stay hidden with no filter");
assert.deepEqual(
  tagFilterEl.children.map((option) => option.textContent),
  ["All tags", "(no-tag)", "ship"],
  "tag filter should include all tags plus the no-tag option first"
);

tagFilterEl.value = "ship";
tagFilterEl.listeners.change();

assert.equal(boardEl.children[0].children[0].children[0].textContent, "Doing (1/2)");
assert.equal(boardEl.children[0].children[1].dataset.uri, "file:///task.md");
assert.equal(boardEl.children[1].children[0].children[0].textContent, "Backlog (0/1)");
assert.equal(searchClearEl.hidden, false, "clear button should appear with an active tag filter");
assert.match(
  searchMetaEl.textContent,
  /1 of 3 cards shown/,
  "tag filter should update the search summary"
);

const noTagValue = tagFilterEl.children[1].value;
tagFilterEl.value = noTagValue;
tagFilterEl.listeners.change();

assert.equal(boardEl.children[0].children[0].children[0].textContent, "Doing (1/2)");
assert.equal(boardEl.children[0].children[1].dataset.uri, "file:///second.md");
assert.equal(boardEl.children[1].children[0].children[0].textContent, "Backlog (1/1)");
assert.equal(boardEl.children[1].children[1].dataset.uri, "file:///existing.md");

searchClearEl.listeners.click();

assert.equal(searchInputEl.value, "", "clear action should reset the query after tag filtering");
assert.equal(tagFilterEl.value, "", "clear action should reset the selected tag");
assert.equal(searchClearEl.hidden, true, "clear button should hide after clearing tag filtering");
assert.equal(boardEl.children[0].children[0].children[0].textContent, "Doing (2)");
assert.match(
  boardEl.children[0].children[1].innerHTML,
  /property-badge/,
  "card should render property badges"
);
assert.doesNotMatch(
  boardEl.children[0].children[1].innerHTML,
  /Tags/,
  "tag properties should not render as badges"
);
assert.ok(
  boardEl.children[0].children[1].innerHTML.indexOf("Owner") <
    boardEl.children[0].children[1].innerHTML.indexOf("Path"),
  "card property badges should be sorted by name"
);
assert.equal(
  boardEl.children[0].children[1].style.getPropertyValue("--card-accent"),
  "rgb(87, 128, 148)",
  "card left border should use a muted color from the Project property"
);
assert.equal(
  boardEl.children[0].children[2].style.getPropertyValue("--card-accent"),
  "",
  "cards without a Project property should use the default accent"
);
assert.match(
  boardEl.children[0].children[2].innerHTML,
  /data-card-action="bump"/,
  "cards should render a bump-to-top button"
);

const bumpButton = new FakeElement("button");
bumpButton.setAttribute("data-card-action", "bump");
bumpButton.closest = () => bumpButton;

boardEl.children[0].children[2].listeners.click({
  target: bumpButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "reorderCards", "bump button should reorder cards");
assert.equal(messages.at(-1)?.sourceColumnId, "Doing");
assert.equal(messages.at(-1)?.targetColumnId, "Doing");
assert.deepEqual(
  messages.at(-1)?.orderedUris,
  ["file:///second.md", "file:///task.md"],
  "bump button should move the card to the top of its column"
);

const sameColumnTransfer = createDataTransfer();
boardEl.children[0].children[2].listeners.dragstart({ dataTransfer: sameColumnTransfer });
const messageCountBeforeSelfDrop = messages.length;
boardEl.children[0].children[2].listeners.drop({
  dataTransfer: sameColumnTransfer,
  clientY: 0,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(
  messages.length,
  messageCountBeforeSelfDrop,
  "dropping a dragged card onto itself should keep its original position"
);

let sameColumnDragOverPrevented = false;
let sameColumnDragOverStopped = false;
boardEl.children[0].children[1].listeners.dragover({
  dataTransfer: sameColumnTransfer,
  preventDefault() {
    sameColumnDragOverPrevented = true;
  },
  stopPropagation() {
    sameColumnDragOverStopped = true;
  },
});

assert.equal(sameColumnDragOverPrevented, true, "same-column card dragover should allow dropping");
assert.equal(
  sameColumnDragOverStopped,
  true,
  "same-column card dragover should not bubble to the column drop highlight"
);
boardEl.children[0].children[1].listeners.drop({
  dataTransfer: sameColumnTransfer,
  clientY: 0,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "reorderCards", "same-column drops should reorder cards");
assert.equal(messages.at(-1)?.sourceColumnId, "Doing");
assert.equal(messages.at(-1)?.targetColumnId, "Doing");
assert.deepEqual(
  messages.at(-1)?.orderedUris,
  ["file:///second.md", "file:///task.md"],
  "same-column drops should send the complete destination order for persistence"
);

const sameColumnBackgroundTransfer = createDataTransfer();
boardEl.children[0].children[2].listeners.dragstart({ dataTransfer: sameColumnBackgroundTransfer });
const messageCountBeforeSameColumnBackgroundDrop = messages.length;
boardEl.children[0].listeners.drop({
  dataTransfer: sameColumnBackgroundTransfer,
  preventDefault() {},
});

assert.equal(
  messages.length,
  messageCountBeforeSameColumnBackgroundDrop,
  "dropping a dragged card back on its source column background should keep its original position"
);

const sameColumnUnknownSourceTransfer = createDataTransfer();
sameColumnUnknownSourceTransfer.setData("text/uri-list", "file:///second.md");
const messageCountBeforeUnknownSourceDrop = messages.length;
boardEl.children[0].listeners.drop({
  dataTransfer: sameColumnUnknownSourceTransfer,
  preventDefault() {},
});

assert.equal(
  messages.length,
  messageCountBeforeUnknownSourceDrop,
  "source-column fallback should prevent same-column background drops from appending to the bottom"
);

const crossColumnTransfer = createDataTransfer();
boardEl.children[0].children[1].listeners.dragstart({ dataTransfer: crossColumnTransfer });
boardEl.children[1].listeners.drop({
  dataTransfer: crossColumnTransfer,
  preventDefault() {},
});

assert.equal(messages.at(-1)?.type, "reorderCards", "cross-column drops should reorder cards");
assert.equal(messages.at(-1)?.sourceColumnId, "Doing");
assert.equal(messages.at(-1)?.targetColumnId, "Backlog");
assert.deepEqual(
  messages.at(-1)?.orderedUris,
  ["file:///task.md", "file:///existing.md"],
  "cross-column drops should place the moved card at the top of the destination column"
);

boardEl.children[0].children[1].listeners.click();

assert.equal(messages.at(-3)?.type, "requestCardDetails", "details should lazy-load the selected card body");
assert.equal(messages.at(-3)?.cardUri, "file:///task.md");
assert.equal(messages.at(-2)?.type, "requestGitStatus", "details should request git status for Repo properties");
assert.equal(messages.at(-2)?.path, "C:\\work\\demo");
assert.equal(messages.at(-1)?.type, "requestAgentOutput", "details should request agent output for Agent properties");
assert.equal(messages.at(-1)?.agentId, "019d0095-6102-7fe2-9fc8-5db0155692e9");
assert.equal(messages.at(-1)?.agentKind, "codex");

assert.match(detailsEl.innerHTML, /Owner:/, "details should render non-tag properties");
assert.match(detailsEl.innerHTML, /Loading description/, "details should show a placeholder before the selected card body loads");

windowListeners.message({
  data: {
    type: "cardDetails",
    cardUri: "file:///task.md",
    bodyHtml:
      '<ul><li><input class="task-list-checkbox" type="checkbox" data-task-index="0" /> Review markdown rendering</li></ul>' +
      Array.from({ length: 55 }, (_, index) => `<p>Description line ${index + 1}</p>`).join(""),
    bodyLineCount: 55,
    updatedAt: 2000,
  },
});

assert.match(
  detailsEl.innerHTML,
  /data-action-type="expandDescription"/,
  "long descriptions should render an expand button"
);
assert.match(
  detailsEl.innerHTML,
  /class="task-list-checkbox"/,
  "details markdown should render task-list checkboxes"
);

const taskCheckbox = new FakeElement("input");
taskCheckbox.setAttribute("type", "checkbox");
taskCheckbox.setAttribute("data-task-index", "0");
taskCheckbox.checked = true;

detailsEl.listeners.change({
  target: taskCheckbox,
});

assert.equal(messages.at(-1)?.type, "toggleTaskCheckbox", "task checkbox changes should patch the card");
assert.equal(messages.at(-1)?.cardUri, "file:///task.md");
assert.equal(messages.at(-1)?.taskIndex, 0);
assert.equal(messages.at(-1)?.checked, true);
assert.doesNotMatch(
  detailsEl.innerHTML,
  /Tags:/,
  "tag properties should not render in the details property list"
);
assert.ok(
  detailsEl.innerHTML.indexOf("Owner:") <
    detailsEl.innerHTML.indexOf("Path:"),
  "details properties should be sorted by name"
);
assert.doesNotMatch(
  detailsEl.innerHTML,
  /property-badge/,
  "details should not render duplicate property badges"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="openPath"/,
  "details should render an open-path action for path properties"
);
assert.match(
  detailsEl.innerHTML,
  />Terminal<\/button>/,
  "details should label terminal-opening path actions as Terminal"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="openCode"/,
  "details should render a code action when a path property exposes one"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="openLocalPath"/,
  "details should render an open action when a local path property exposes one"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="openUrl"/,
  "details should render an open-url action for URL properties"
);
assert.match(
  detailsEl.innerHTML,
  /class="details-delete"/,
  "details should render a delete ticket button"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="deleteCard"/,
  "details delete button should post a delete card action"
);
assert.doesNotMatch(
  boardEl.children[0].children[2].innerHTML,
  /deleteCard|details-delete/,
  "card tiles should not render the delete action"
);

const resumeButton = new FakeElement("button");
resumeButton.setAttribute("data-action-type", "resumeAgent");
resumeButton.setAttribute("data-action-value", "019d0095-6102-7fe2-9fc8-5db0155692e9");
resumeButton.closest = () => resumeButton;

detailsEl.listeners.click({
  target: resumeButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "resumeAgent");
assert.equal(messages.at(-1)?.agentId, "019d0095-6102-7fe2-9fc8-5db0155692e9");
assert.equal(messages.at(-1)?.title, "Ship it");
assert.equal(messages.at(-1)?.agentKind, "codex");
assert.equal(messages.at(-1)?.repoPath, "C:\\work\\demo");

windowListeners.message({
  data: {
    type: "gitStatus",
    cardUri: "file:///task.md",
    path: "C:\\work\\demo",
    status: "## main\\n M src/extension.ts",
  },
});

assert.match(detailsEl.innerHTML, /Git Status/, "details should render a git status section for Repo properties");
assert.doesNotMatch(
  detailsEl.innerHTML,
  /<hr\s*\/>\s*<h2 class="details-section-title">Git Status<\/h2>/,
  "git status should not render a separator line above its title"
);
assert.match(detailsEl.innerHTML, /## main/, "git status output should be displayed in the details pane");
assert.match(detailsEl.innerHTML, /M src\/extension\.ts/, "git status body should be rendered as text");

windowListeners.message({
  data: {
    type: "agentOutput",
    cardUri: "file:///task.md",
    agentId: "019d0095-6102-7fe2-9fc8-5db0155692e9",
    agentKind: "codex",
    output: "Investigating the issue.\nInvestigating the issue.\n- Patched **validator**.\nLine one\nLine two",
    outputHtml:
      "<p>Investigating the issue.</p>\n" +
      "<ul><li>Patched <strong>validator</strong>.</li></ul>\n" +
      "<p>Line one<br />\nLine two</p>\n",
  },
});

assert.match(detailsEl.innerHTML, /Codex Output/, "details should render a Codex output section for Agent properties");
assert.doesNotMatch(
  detailsEl.innerHTML,
  /<hr\s*\/>\s*<h2 class="details-section-title">Claude Output<\/h2>/,
  "agent output should not render a separator line above its title"
);
assert.match(
  html,
  /\.git-status-text\s*\+\s*\.details-section-title\s*\{[^}]*margin-top:\s*18px;/,
  "agent output title should have breathing room when it follows the git status block"
);
assert.match(detailsEl.innerHTML, /Investigating the issue\./, "agent output should be displayed in the details pane");
assert.match(detailsEl.innerHTML, /<strong>validator<\/strong>/, "agent output should render Markdown emphasis");
assert.match(detailsEl.innerHTML, /<ul><li>Patched/, "agent output should render Markdown lists");
assert.match(detailsEl.innerHTML, /Line one<br\s*\/>/, "agent output should preserve single line breaks");
assert.doesNotMatch(detailsEl.innerHTML, /<pre class="codex-output-text">/, "agent output should not render as a preformatted text block");
assert.doesNotMatch(detailsEl.innerHTML, /&lt;strong&gt;validator/, "agent output Markdown HTML should not be escaped as text");
assert.equal(
  (detailsEl.innerHTML.match(/Investigating the issue\./g) || []).length,
  1,
  "duplicate adjacent agent output lines should be hidden in the details pane"
);

let descriptionExpanded = false;
const expandButton = new FakeElement("button");
expandButton.setAttribute("data-action-type", "expandDescription");
expandButton.closest = () => expandButton;
detailsEl.querySelector = (selector) => {
  assert.equal(selector, "[data-description-frame]");
  return {
    classList: {
      remove(className) {
        if (className === "collapsed") {
          descriptionExpanded = true;
        }
      },
    },
  };
};

detailsEl.listeners.click({
  target: expandButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(descriptionExpanded, true, "expand description should reveal the full description");
assert.equal(expandButton.removed, true, "expand description should remove the expand button");

const actionButton = new FakeElement("button");
actionButton.setAttribute("data-action-type", "openPath");
actionButton.setAttribute("data-action-value", "C:\\work\\demo");
actionButton.closest = () => actionButton;

detailsEl.listeners.click({
  target: actionButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "openPath");
assert.equal(messages.at(-1)?.path, "C:\\work\\demo");

const codeButton = new FakeElement("button");
codeButton.setAttribute("data-action-type", "openCode");
codeButton.setAttribute("data-action-value", "C:\\work\\demo");
codeButton.closest = () => codeButton;

detailsEl.listeners.click({
  target: codeButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "openCode");
assert.equal(messages.at(-1)?.path, "C:\\work\\demo");

const localPathButton = new FakeElement("button");
localPathButton.setAttribute("data-action-type", "openLocalPath");
localPathButton.setAttribute("data-action-value", "C:\\work\\demo");
localPathButton.closest = () => localPathButton;

detailsEl.listeners.click({
  target: localPathButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "openLocalPath");
assert.equal(messages.at(-1)?.path, "C:\\work\\demo");

const urlButton = new FakeElement("button");
urlButton.setAttribute("data-action-type", "openUrl");
urlButton.setAttribute("data-action-value", "https://example.com/task");
urlButton.closest = () => urlButton;

detailsEl.listeners.click({
  target: urlButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "openUrl");
assert.equal(messages.at(-1)?.url, "https://example.com/task");

const deleteButton = new FakeElement("button");
deleteButton.setAttribute("data-action-type", "deleteCard");
deleteButton.setAttribute("data-action-value", "file:///task.md");
deleteButton.closest = () => deleteButton;

detailsEl.listeners.click({
  target: deleteButton,
  preventDefault() {},
  stopPropagation() {},
});

assert.equal(messages.at(-1)?.type, "deleteCard");
assert.equal(messages.at(-1)?.cardUri, "file:///task.md");
assert.equal(messages.at(-1)?.title, "Ship it");

let prevented = false;
windowListeners.keydown({
  key: "f",
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  target: boardEl,
  preventDefault() {
    prevented = true;
  },
});

assert.equal(prevented, true, "Ctrl+F should override browser find");
assert.equal(activeElement, searchInputEl, "Ctrl+F should focus the search input");
assert.equal(searchInputEl.selected, true, "Ctrl+F should select search text");

searchInputEl.value = "jane";
searchInputEl.listeners.input();

assert.equal(boardEl.children.length, 2, "filtering should keep columns visible");
assert.equal(boardEl.children[0].children.length, 2, "matching filter should still render header and card");
assert.equal(boardEl.children[0].children[0].children[0].textContent, "Doing (1/2)");
assert.equal(boardEl.children[1].children[0].children[0].textContent, "Backlog (0/1)");
assert.equal(boardEl.children[0].children[0].draggable, false, "column drag should be disabled while filtering");
assert.equal(boardEl.children[0].children[1].draggable, true, "matching cards should remain draggable while filtering");
assert.match(
  searchMetaEl.textContent,
  /1 of 3 cards shown.*Cards can be moved to other columns while filtering\./,
  "search summary should explain filtered state"
);
assert.equal(searchClearEl.hidden, false, "clear button should appear with an active filter");

const filteredColumnTransfer = createDataTransfer();
boardEl.children[0].children[1].listeners.dragstart({ dataTransfer: filteredColumnTransfer });
boardEl.children[1].listeners.drop({
  dataTransfer: filteredColumnTransfer,
  preventDefault() {},
});

assert.equal(messages.at(-1)?.type, "reorderCards", "filtered cross-column drops should move cards");
assert.equal(messages.at(-1)?.sourceColumnId, "Doing");
assert.equal(messages.at(-1)?.targetColumnId, "Backlog");
assert.deepEqual(
  messages.at(-1)?.orderedUris,
  ["file:///task.md", "file:///existing.md"],
  "filtered cross-column drops should place the moved card at the top of the destination column"
);

searchInputEl.value = "missing";
searchInputEl.listeners.input();

assert.equal(boardEl.children[0].children.length, 2, "no-match filter should render header and empty state");
assert.equal(boardEl.children[0].children[1].className, "column-empty", "column should show a filter empty state");
assert.match(
  detailsEl.innerHTML,
  /Selected card is hidden by the current search/,
  "details should explain when the selected card is filtered out"
);
assert.match(searchMetaEl.textContent, /No cards match "missing"\./, "search summary should show no-match text");

searchClearEl.listeners.click();

assert.equal(searchInputEl.value, "", "clear action should reset the query");
assert.equal(searchClearEl.hidden, true, "clear button should hide after clearing");
assert.equal(boardEl.children[0].children[1].dataset.uri, "file:///task.md", "clearing should restore matching cards");
assert.match(detailsEl.innerHTML, /Owner:/, "clearing the filter should restore selected card details");

