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
  `(() => { const csp = "csp"; const nonce = "nonce"; return ${templateLiteral}; })()`,
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
  /\.layout\s*\{[^}]*min-height:\s*100vh;/,
  "layout should be able to grow beyond the viewport for tall columns"
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
  /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.board-pane\s*\{[^}]*height:\s*auto;[\s\S]*?\.details\s*\{[^}]*position:\s*static;[^}]*top:\s*auto;[^}]*height:\s*auto;/,
  "mobile layout should reset the fixed-height board pane and sticky details pane"
);

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.className = "";
    this.classList = { add() {}, remove() {} };
    this.style = {};
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
}

const boardEl = new FakeElement("section");
const detailsEl = new FakeElement("aside");
const searchInputEl = new FakeElement("input");
const searchMetaEl = new FakeElement("div");
const searchClearEl = new FakeElement("button");
const windowListeners = {};
const messages = [];
let activeElement = null;

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
    getElementById(id) {
      if (id === "board") {
        return boardEl;
      }
      if (id === "details") {
        return detailsEl;
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
assert.match(searchInputEl.placeholder, /Ctrl\+F/, "search input should advertise the shortcut");

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
              body: "",
              bodyHtml: "",
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
                },
                {
                  key: "Path",
                  label: "Path",
                  value: "C:\\work\\demo",
                  action: { command: "openPath", title: "Open", value: "C:\\work\\demo" },
                },
                { key: "Owner", label: "Owner", value: "Jane", action: null },
              ],
              tags: ["ship"],
              priority: 2,
              createdAt: Date.now(),
            },
          ],
        },
      ],
    },
  },
});

assert.equal(boardEl.children.length, 1, "expected one rendered column");
assert.equal(boardEl.children[0].dataset.column, "Doing", "column id should be rendered");
assert.equal(boardEl.children[0].children.length, 2, "expected header and one card");
assert.match(searchMetaEl.textContent, /1 card/, "search summary should show card count");
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

boardEl.children[0].children[1].listeners.click();

assert.equal(messages.at(-2)?.type, "requestGitStatus", "details should request git status for Repo properties");
assert.equal(messages.at(-2)?.path, "C:\\work\\demo");
assert.equal(messages.at(-1)?.type, "requestCodexOutput", "details should request codex output for Agent properties");
assert.equal(messages.at(-1)?.agentId, "019d0095-6102-7fe2-9fc8-5db0155692e9");

assert.match(detailsEl.innerHTML, /Owner:/, "details should render non-tag properties");
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

windowListeners.message({
  data: {
    type: "gitStatus",
    cardUri: "file:///task.md",
    path: "C:\\work\\demo",
    status: "## main\\n M src/extension.ts",
  },
});

assert.match(detailsEl.innerHTML, /Git Status/, "details should render a git status section for Repo properties");
assert.match(detailsEl.innerHTML, /## main/, "git status output should be displayed in the details pane");
assert.match(detailsEl.innerHTML, /M src\/extension\.ts/, "git status body should be rendered as text");

windowListeners.message({
  data: {
    type: "codexOutput",
    cardUri: "file:///task.md",
    agentId: "019d0095-6102-7fe2-9fc8-5db0155692e9",
    output: "Investigating the issue.\\n\\nPatched the validator.",
  },
});

assert.match(detailsEl.innerHTML, /Codex Output/, "details should render a codex output section for Agent properties");
assert.match(detailsEl.innerHTML, /Investigating the issue\./, "codex output should be displayed in the details pane");
assert.match(detailsEl.innerHTML, /Patched the validator\./, "latest codex output should preserve line breaks");

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

assert.equal(boardEl.children.length, 1, "filtering should keep the column visible");
assert.equal(boardEl.children[0].children.length, 2, "matching filter should still render header and card");
assert.equal(boardEl.children[0].children[0].draggable, false, "column drag should be disabled while filtering");
assert.equal(boardEl.children[0].children[1].draggable, false, "card drag should be disabled while filtering");
assert.match(
  searchMetaEl.textContent,
  /1 of 1 cards shown.*Dragging is disabled while filtering\./,
  "search summary should explain filtered state"
);
assert.equal(searchClearEl.hidden, false, "clear button should appear with an active filter");

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
