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
  /\.layout\s*\{[^}]*min-height:\s*100vh;/,
  "layout should be able to grow beyond the viewport for tall columns"
);
assert.match(
  html,
  /\.column-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/,
  "column headers should stay visible while scrolling long columns"
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

  closest() {
    return null;
  }
}

const boardEl = new FakeElement("section");
const detailsEl = new FakeElement("aside");
const windowListeners = {};
const messages = [];

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
      return new FakeElement();
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
