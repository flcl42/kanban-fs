import * as vscode from "vscode";
import MarkdownIt from "markdown-it";

type Card = {
  uri: string;
  fileName: string;
  title: string;
  body: string;
  bodyHtml: string;
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
      const { title, body } = parseMarkdown(text, name);
      const bodyHtml = md.render(body || "");
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        body,
        bodyHtml,
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

    const renderDetails = (card) => {
      if (!card) {
        detailsEl.innerHTML = '<div class="empty">Select a card to view details.</div>';
        return;
      }
      const created = new Date(card.createdAt).toLocaleString();
      const bodyHtml = card.bodyHtml || '';
      detailsEl.innerHTML = \`
        <h1>\${escapeHtml(card.title)}</h1>
        <div class="meta">Created: \${created}</div>
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
          cardEl.innerHTML = \`
            <h3>\${escapeHtml(card.title)}</h3>
            <div class="meta">\${new Date(card.createdAt).toLocaleDateString()}</div>
          \`;
          cardEl.addEventListener("click", () => renderDetails(card));
          cardEl.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/uri-list", card.uri);
          });
          columnEl.appendChild(cardEl);
        }
        boardEl.appendChild(columnEl);
      }
    };

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "boardData") {
        renderBoard(message.board);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function parseMarkdown(content: string, fallbackTitle: string): { title: string; body: string } {
  const lines = content.split(/\r?\n/);
  let title = fallbackTitle.replace(/\.md$/i, "");
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("# ")) {
      title = line.replace(/^#\s+/, "").trim() || title;
      bodyStart = i + 1;
      break;
    }
  }
  const body = lines.slice(bodyStart).join("\n").trim();
  return { title, body };
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
