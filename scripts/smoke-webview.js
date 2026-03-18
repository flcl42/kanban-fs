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
          cards: [],
        },
      ],
    },
  },
});

assert.equal(boardEl.children.length, 1, "expected one rendered column");
assert.equal(boardEl.children[0].dataset.column, "Doing", "column id should be rendered");
