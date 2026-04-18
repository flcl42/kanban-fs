const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension.ts"),
  "utf8"
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

assert.ok(scriptMatch, "webview script block not found");
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
const searchMetaEl = new FakeElement("div");
const searchClearEl = new FakeElement("button");
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
      if (id === "search-meta") {
        return searchMetaEl;
      }
      if (id === "search-clear") {
        return searchClearEl;
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
assert.match(searchInputEl.placeholder, /Ctrl\+F/, "search input should advertise the shortcut");
windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: false,
      requirements: {
        dotnet: {
          label: ".NET SDK",
          command: "dotnet",
          installed: true,
          version: "8.0.100",
          installUrl: "https://dotnet.microsoft.com/download",
        },
        codex: {
          label: "Codex CLI",
          command: "codex",
          installed: false,
          version: "",
          installUrl: "https://github.com/openai/codex",
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
assert.match(runnerPanelEl.innerHTML, /\.NET SDK/, "runner panel should show dotnet status");
assert.match(runnerPanelEl.innerHTML, /Codex CLI/, "runner panel should show codex status");
assert.match(runnerPanelEl.innerHTML, /8\.0\.100/, "runner panel should show installed tool versions");
assert.match(runnerPanelEl.innerHTML, /data-action-type="openRunnerLink"/, "missing runner tools should render install links");

const installCodexButton = new FakeElement("button");
installCodexButton.setAttribute("data-action-type", "openRunnerLink");
installCodexButton.setAttribute("data-action-url", "https://github.com/openai/codex");
installCodexButton.closest = () => installCodexButton;
runnerPanelEl.listeners.click({
  target: installCodexButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(messages.at(-1)?.type, "openUrl", "runner install links should open externally");
assert.equal(messages.at(-1)?.url, "https://github.com/openai/codex");

const createRunnerButton = new FakeElement("button");
createRunnerButton.setAttribute("data-action-type", "createRunner");
createRunnerButton.closest = () => createRunnerButton;
runnerPanelEl.listeners.click({
  target: createRunnerButton,
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(messages.at(-1)?.type, "createRunner", "runner panel should request local runner creation");
assert.match(runnerPanelEl.innerHTML, /Creating/, "runner panel should show pending creation state");

windowListeners.message({
  data: {
    type: "runnerStatus",
    status: {
      enabled: true,
      running: false,
      runnerScriptRequired: true,
      runnerScriptExists: true,
      requirements: {
        dotnet: {
          label: ".NET SDK",
          command: "dotnet",
          installed: true,
          version: "8.0.100",
          installUrl: "https://dotnet.microsoft.com/download",
        },
        codex: {
          label: "Codex CLI",
          command: "codex",
          installed: true,
          version: "codex 0.1.0",
          installUrl: "https://github.com/openai/codex",
        },
      },
    },
  },
});
assert.match(runnerPanelEl.innerHTML, /No Codex runner detected/, "runner panel should warn about a missing runner");
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
              body: Array.from({ length: 55 }, (_, index) => `Description line ${index + 1}`).join("\n"),
              bodyHtml: Array.from({ length: 55 }, (_, index) => `<p>Description line ${index + 1}</p>`).join(""),
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
                  key: "Repo",
                  label: "Repo",
                  value: "C:\\work\\demo",
                  action: { command: "openPath", title: "Open", value: "C:\\work\\demo" },
                  actions: [
                    { command: "openPath", title: "Open", value: "C:\\work\\demo" },
                    { command: "openCode", title: "Code", value: "C:\\work\\demo" },
                  ],
                },
                {
                  key: "Path",
                  label: "Path",
                  value: "C:\\work\\demo",
                  action: { command: "openPath", title: "Open", value: "C:\\work\\demo" },
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
              createdAt: Date.now(),
            },
            {
              uri: "file:///second.md",
              fileName: "second.md",
              title: "Second card",
              body: "",
              bodyHtml: "",
              properties: [],
              tags: [],
              priority: 3,
              createdAt: Date.now(),
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
              body: "",
              bodyHtml: "",
              properties: [],
              tags: [],
              priority: 1,
              createdAt: Date.now(),
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
assert.match(searchMetaEl.textContent, /3 cards/, "search summary should show card count");
assert.equal(searchClearEl.hidden, true, "clear button should stay hidden with no filter");
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

assert.equal(messages.at(-2)?.type, "requestGitStatus", "details should request git status for Repo properties");
assert.equal(messages.at(-2)?.path, "C:\\work\\demo");
assert.equal(messages.at(-1)?.type, "requestCodexOutput", "details should request codex output for Agent properties");
assert.equal(messages.at(-1)?.agentId, "019d0095-6102-7fe2-9fc8-5db0155692e9");

assert.match(detailsEl.innerHTML, /Owner:/, "details should render non-tag properties");
assert.match(
  detailsEl.innerHTML,
  /data-action-type="expandDescription"/,
  "long descriptions should render an expand button"
);
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
  /data-action-type="openCode"/,
  "details should render a code action when a path property exposes one"
);
assert.match(
  detailsEl.innerHTML,
  /data-action-type="openUrl"/,
  "details should render an open-url action for URL properties"
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
    type: "codexOutput",
    cardUri: "file:///task.md",
    agentId: "019d0095-6102-7fe2-9fc8-5db0155692e9",
    output: "Investigating the issue.\nInvestigating the issue.\nPatched the validator.",
  },
});

assert.match(detailsEl.innerHTML, /Codex Output/, "details should render a codex output section for Agent properties");
assert.match(detailsEl.innerHTML, /Investigating the issue\./, "codex output should be displayed in the details pane");
assert.match(detailsEl.innerHTML, /Patched the validator\./, "latest codex output should preserve line breaks");
assert.equal(
  (detailsEl.innerHTML.match(/Investigating the issue\./g) || []).length,
  1,
  "duplicate adjacent codex output lines should be hidden in the details pane"
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
