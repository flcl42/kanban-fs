import * as vscode from "vscode";
import MarkdownIt from "markdown-it";

type Card = {
  uri: string;
  fileName: string;
  title: string;
  body: string;
  bodyHtml: string;
  tags: string[];
  createdAt: number;
};

type Column = {
  name: string;
  cards: Card[];
};

type BoardData = {
  columns: Column[];
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
});

export function activate(context: vscode.ExtensionContext) {
  const provider = new KanbanEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("kanban.board", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );
}

export function deactivate() {}

class KanbanEditorProvider implements vscode.CustomEditorProvider {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly context: vscode.ExtensionContext;
  private readonly onDidChangeCustomDocumentEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<vscode.CustomDocument>>();
  public readonly onDidChangeCustomDocument =
    this.onDidChangeCustomDocumentEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => {
        const key = uri.toString();
        const watcher = this.watchers.get(key);
        if (watcher) {
          watcher.dispose();
          this.watchers.delete(key);
        }
      },
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const sendBoard = async () => {
      const board = await this.buildBoard(document.uri);
      webviewPanel.webview.postMessage({ type: "boardData", board });
    };

    const key = document.uri.toString();
    const parentFolder = vscode.Uri.joinPath(document.uri, "..");
    const pattern = new vscode.RelativePattern(parentFolder, "**/*");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watchers.set(key, watcher);
    watcher.onDidCreate(sendBoard);
    watcher.onDidDelete(sendBoard);
    watcher.onDidChange(sendBoard);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "ready") {
        await sendBoard();
        return;
      }
      if (message?.type === "moveCard") {
        await this.moveCard(document.uri, message.cardUri, message.targetColumn);
        await sendBoard();
        return;
      }
      if (message?.type === "openFile" && message?.cardUri) {
        const target = vscode.Uri.parse(message.cardUri);
        await vscode.window.showTextDocument(target, { preview: true });
        return;
      }
    });

    await sendBoard();
  }

  async saveCustomDocument(
    _document: vscode.CustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    return;
  }

  async saveCustomDocumentAs(
    _document: vscode.CustomDocument,
    _destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    return;
  }

  async revertCustomDocument(
    _document: vscode.CustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    return;
  }

  async backupCustomDocument(
    document: vscode.CustomDocument,
    _context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    return {
      id: document.uri.toString(),
      delete: () => undefined,
    };
  }

  private async buildBoard(kanbanUri: vscode.Uri): Promise<BoardData> {
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: Column[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const columnUri = vscode.Uri.joinPath(boardFolder, name);
      const cards = await this.readCards(columnUri);
      columns.push({ name, cards });
    }

    columns.sort((a, b) => a.name.localeCompare(b.name));
    return { columns };
  }

  private async readCards(columnUri: vscode.Uri): Promise<Card[]> {
    const entries = await vscode.workspace.fs.readDirectory(columnUri);
    const cards: Card[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(columnUri, name);
      const raw = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(raw).toString("utf8");
      const { title, body, tags } = parseMarkdown(text, name);
      const bodyHtml = md.render(body || "");
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        body,
        bodyHtml,
        tags,
        createdAt: stat.ctime,
      });
    }

    cards.sort((a, b) => a.title.localeCompare(b.title));
    return cards;
  }

  private async moveCard(
    kanbanUri: vscode.Uri,
    cardUriString: string,
    targetColumnName: string
  ): Promise<void> {
    if (!cardUriString || !targetColumnName) {
      return;
    }
    const cardUri = vscode.Uri.parse(cardUriString);
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const targetColumnUri = vscode.Uri.joinPath(boardFolder, targetColumnName);
    const fileName = cardUri.path.split("/").pop();
    if (!fileName) {
      return;
    }
    const newUri = vscode.Uri.joinPath(targetColumnUri, fileName);
    if (cardUri.toString() === newUri.toString()) {
      return;
    }
    await vscode.workspace.fs.rename(cardUri, newUri, { overwrite: false });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      "img-src " + webview.cspSource + " https:",
      "style-src " + webview.cspSource + " 'unsafe-inline'",
      "script-src 'nonce-" + nonce + "'",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kanban</title>
  <style>
    :root {
      --bg: #f5f2ea;
      --panel: #fff9ee;
      --line: #d8cdb5;
      --ink: #23211b;
      --muted: #6b6354;
      --accent: #c66a2b;
      --accent-soft: #f0d2bb;
      --shadow: rgba(0, 0, 0, 0.08);
      --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --display: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #fff8ea, #f3efe6 45%, #ece7da);
      color: var(--ink);
      font-family: var(--display);
    }
    .layout {
      display: grid;
      grid-template-columns: 2.2fr 1fr;
      gap: 16px;
      padding: 16px;
      height: 100vh;
    }
    .board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(220px, 1fr);
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .column {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      min-height: 70vh;
      box-shadow: 0 12px 24px -18px var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .column h2 {
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0;
      color: var(--muted);
    }
    .card {
      background: #fff;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 12px;
      padding: 10px 12px;
      cursor: grab;
      box-shadow: 0 8px 16px -14px var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 16px 24px -16px var(--shadow);
    }
    .card h3 {
      margin: 0;
      font-size: 15px;
    }
    .meta {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .tag {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .details {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 12px 24px -18px var(--shadow);
      height: calc(100vh - 32px);
      overflow: auto;
    }
    .details h1 {
      margin-top: 0;
      font-size: 22px;
    }
    .details .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      padding: 16px;
      border-radius: 12px;
      background: var(--panel);
    }
    .drop-target {
      outline: 2px dashed var(--accent);
      outline-offset: 4px;
      background: var(--accent-soft);
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        height: auto;
      }
      .details {
        height: auto;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="board" id="board"></section>
    <aside class="details" id="details">
      <div class="empty">Select a card to view details.</div>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const boardEl = document.getElementById("board");
    const detailsEl = document.getElementById("details");
    let selectedCard = null;
    let lastBoard = null;
    let refreshTimer = null;

    const renderDetails = (card) => {
      if (!card) {
        detailsEl.innerHTML = '<div class="empty">Select a card to view details.</div>';
        return;
      }
      selectedCard = card;
      const created = new Date(card.createdAt);
      const createdLabel = created.toLocaleString();
      const createdRelative = formatRelativeTime(created);
      const bodyHtml = card.bodyHtml || '';
      const tagsHtml = renderTags(card.tags || []);
      detailsEl.innerHTML = \`
        <h1>\${escapeHtml(card.title)}</h1>
        <div class="meta">Created: \${createdLabel} · \${createdRelative}</div>
        \${tagsHtml}
        <hr />
        <div>\${bodyHtml}</div>
      \`;
    };

    const escapeHtml = (value) => {
      return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const hashString = (value) => {
      let hash = 0;
      for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
      }
      return hash;
    };

    const hslToRgb = (h, s, l) => {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let [r1, g1, b1] = [0, 0, 0];
      if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
      else if (hp >= 1 && hp < 2) [r1, g1, b1] = [x, c, 0];
      else if (hp >= 2 && hp < 3) [r1, g1, b1] = [0, c, x];
      else if (hp >= 3 && hp < 4) [r1, g1, b1] = [0, x, c];
      else if (hp >= 4 && hp < 5) [r1, g1, b1] = [x, 0, c];
      else if (hp >= 5 && hp < 6) [r1, g1, b1] = [c, 0, x];
      const m = l - c / 2;
      return [r1 + m, g1 + m, b1 + m];
    };

    const readableTextColor = (r, g, b) => {
      const srgb = [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      const luminance = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
      return luminance > 0.5 ? "#1f1b14" : "#fff";
    };

    const tagStyle = (tag) => {
      const hash = hashString(tag.toLowerCase());
      const hue = hash % 360;
      const saturation = 0.55;
      const lightness = 0.5;
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      const text = readableTextColor(r, g, b);
      const rgb = \`rgb(\${Math.round(r * 255)}, \${Math.round(g * 255)}, \${Math.round(b * 255)})\`;
      return { background: rgb, color: text };
    };

    const renderTags = (tags) => {
      if (!tags?.length) return "";
      const pills = tags.map((tag) => {
        const safe = escapeHtml(tag);
        const style = tagStyle(tag);
        return \`<span class="tag" style="background:\${style.background};color:\${style.color}">\${safe}</span>\`;
      }).join("");
      return \`<div class="tags">\${pills}</div>\`;
    };

    const openCard = (card) => {
      if (!card?.uri) return;
      vscode.postMessage({ type: "openFile", cardUri: card.uri });
    };

    const findCard = (board, uri) => {
      for (const column of board?.columns || []) {
        for (const card of column.cards || []) {
          if (card.uri === uri) return card;
        }
      }
      return null;
    };

    const renderBoard = (board) => {
      boardEl.innerHTML = "";
      if (!board?.columns?.length) {
        boardEl.innerHTML = '<div class="card">No columns found. Create folders next to the .kanban file.</div>';
        return;
      }
      for (const column of board.columns) {
        const columnEl = document.createElement("div");
        columnEl.className = "column";
        columnEl.dataset.column = column.name;
        columnEl.innerHTML = \`<h2>\${escapeHtml(column.name)}</h2>\`;
        columnEl.addEventListener("dragover", (event) => {
          event.preventDefault();
          columnEl.classList.add("drop-target");
        });
        columnEl.addEventListener("dragleave", () => {
          columnEl.classList.remove("drop-target");
        });
        columnEl.addEventListener("drop", (event) => {
          event.preventDefault();
          columnEl.classList.remove("drop-target");
          const cardUri = event.dataTransfer.getData("text/uri-list");
          if (cardUri) {
            vscode.postMessage({ type: "moveCard", cardUri, targetColumn: column.name });
          }
        });

        for (const card of column.cards) {
          const cardEl = document.createElement("div");
          cardEl.className = "card";
          cardEl.draggable = true;
          cardEl.dataset.uri = card.uri;
          const tagsHtml = renderTags(card.tags || []);
          const created = new Date(card.createdAt);
          const createdLabel = created.toLocaleDateString();
          const createdRelative = formatRelativeTime(created);
          cardEl.innerHTML = \`
            <h3>\${escapeHtml(card.title)}</h3>
            <div class="meta">\${createdLabel} · \${createdRelative}</div>
            \${tagsHtml}
          \`;
          cardEl.addEventListener("click", () => renderDetails(card));
          cardEl.addEventListener("dblclick", () => openCard(card));
          cardEl.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/uri-list", card.uri);
          });
          columnEl.appendChild(cardEl);
        }
        boardEl.appendChild(columnEl);
      }
    };

    detailsEl.addEventListener("dblclick", () => openCard(selectedCard));

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "boardData") {
        lastBoard = message.board;
        renderBoard(message.board);
        if (selectedCard && lastBoard?.columns) {
          const updated = findCard(lastBoard, selectedCard.uri);
          if (updated) {
            renderDetails(updated);
          }
        }
        if (!refreshTimer) {
          refreshTimer = setInterval(() => {
            if (!lastBoard) return;
            renderBoard(lastBoard);
            if (selectedCard) {
              const refreshed = findCard(lastBoard, selectedCard.uri);
              if (refreshed) {
                renderDetails(refreshed);
              }
            }
          }, 60000);
        }
      }
    });

    vscode.postMessage({ type: "ready" });

    function formatRelativeTime(date) {
      const now = new Date();
      const diffMs = date.getTime() - now.getTime();
      const diffSec = Math.round(diffMs / 1000);
      const absSec = Math.abs(diffSec);

      if (absSec < 60) {
        return "just now";
      }

      const units = [
        { name: "minute", seconds: 60 },
        { name: "hour", seconds: 3600 },
        { name: "day", seconds: 86400 },
        { name: "week", seconds: 604800 },
        { name: "month", seconds: 2592000 },
        { name: "year", seconds: 31536000 },
      ];

      let unit = units[0];
      for (const next of units) {
        if (absSec >= next.seconds) {
          unit = next;
        } else {
          break;
        }
      }

      const value = Math.round(absSec / unit.seconds);
      const label = value === 1 ? unit.name : unit.name + "s";
      return diffSec < 0 ? \`\${value} \${label} ago\` : \`in \${value} \${label}\`;
    }
  </script>
</body>
</html>`;
  }
}

function parseMarkdown(
  content: string,
  fallbackTitle: string
): { title: string; body: string; tags: string[] } {
  const lines = content.split(/\r?\n/);
  let title = fallbackTitle.replace(/\.md$/i, "");
  let bodyStart = 0;
  const tags: string[] = [];
  const tagPattern = /^tags\s*:\s*(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("# ")) {
      title = line.replace(/^#\s+/, "").trim() || title;
      bodyStart = i + 1;
      break;
    }
  }
  for (let i = 0; i < bodyStart; i++) {
    const match = lines[i].match(tagPattern);
    if (match) {
      const parsed = match[1]
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      tags.push(...parsed);
    }
  }
  const bodyLines: string[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(tagPattern);
    if (match) {
      const parsed = match[1]
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      tags.push(...parsed);
      continue;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n").trim();
  return { title, body, tags };
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
