import * as vscode from "vscode";
import MarkdownIt from "markdown-it";

type Card = {
  uri: string;
  fileName: string;
  title: string;
  body: string;
  bodyHtml: string;
  tags: string[];
  priority: number | null;
  createdAt: number;
};

type Column = {
  id: string;
  name: string;
  order: number | null;
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
      if (message?.type === "requestNewCard") {
        const columnId = String(
          message?.columnId ?? message?.columnName ?? ""
        ).trim();
        if (!columnId) {
          return;
        }
        const title = await vscode.window.showInputBox({
          prompt: "Ticket title",
          placeHolder: "New ticket",
          ignoreFocusOut: true,
        });
        if (title === undefined) {
          return;
        }
        await this.createCard(document.uri, columnId, title);
        await sendBoard();
        return;
      }
      if (message?.type === "reorderCards") {
        const orderedUris = Array.isArray(message?.orderedUris)
          ? message.orderedUris
          : [];
        await this.reorderCards(
          document.uri,
          message?.cardUri,
          message?.sourceColumnId,
          message?.targetColumnId,
          orderedUris
        );
        await sendBoard();
        return;
      }
      if (message?.type === "reorderColumns") {
        await this.reorderColumns(
          document.uri,
          message?.sourceColumnId,
          message?.targetColumnId,
          message?.position
        );
        await sendBoard();
        return;
      }
      if (message?.type === "moveCard") {
        await this.moveCard(
          document.uri,
          message.cardUri,
          message.targetColumnId ?? message.targetColumn
        );
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
      const meta = await this.readColumnMeta(columnUri, name);
      const cards = await this.readCards(columnUri);
      columns.push({
        id: name,
        name: meta.title,
        order: meta.order,
        cards,
      });
    }

    columns.sort((a, b) => {
      const orderA = a.order ?? Number.POSITIVE_INFINITY;
      const orderB = b.order ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.name.localeCompare(b.name);
    });
    return { columns };
  }

  private async readCards(columnUri: vscode.Uri): Promise<Card[]> {
    const entries = await vscode.workspace.fs.readDirectory(columnUri);
    const cards: Card[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (name.toLowerCase() === "folder.md") {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(columnUri, name);
      const raw = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(raw).toString("utf8");
      const { title, body, tags, priority } = parseMarkdown(text, name);
      const bodyHtml = md.render(body || "");
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        body,
        bodyHtml,
        tags,
        priority,
        createdAt: stat.ctime,
      });
    }

    cards.sort((a, b) => {
      const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
      const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return a.title.localeCompare(b.title);
    });
    return cards;
  }

  private async readColumnMeta(
    columnUri: vscode.Uri,
    fallbackTitle: string
  ): Promise<{ title: string; order: number | null }> {
    const metaUri = vscode.Uri.joinPath(columnUri, "folder.md");
    try {
      const raw = await vscode.workspace.fs.readFile(metaUri);
      const text = Buffer.from(raw).toString("utf8");
      return parseColumnMarkdown(text, fallbackTitle);
    } catch {
      return { title: fallbackTitle, order: null };
    }
  }

  private async moveCard(
    kanbanUri: vscode.Uri,
    cardUriString: string,
    targetColumnId: string
  ): Promise<void> {
    if (!cardUriString || !targetColumnId) {
      return;
    }
    const cardUri = vscode.Uri.parse(cardUriString);
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const targetColumnUri = vscode.Uri.joinPath(boardFolder, targetColumnId);
    const fileName = cardUri.path.split("/").pop();
    if (!fileName) {
      return;
    }
    const newUri = vscode.Uri.joinPath(targetColumnUri, fileName);
    if (cardUri.toString() === newUri.toString()) {
      return;
    }
    await vscode.workspace.fs.rename(cardUri, newUri, { overwrite: false });
    const sourceColumnUri = vscode.Uri.joinPath(cardUri, "..");
    await this.resequenceColumnPriorities(sourceColumnUri);
    if (sourceColumnUri.toString() !== targetColumnUri.toString()) {
      await this.resequenceColumnPriorities(targetColumnUri);
    }
  }

  private async createCard(
    kanbanUri: vscode.Uri,
    columnId: string,
    title: string
  ): Promise<void> {
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const columnUri = vscode.Uri.joinPath(boardFolder, columnId);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(columnUri);
    } catch {
      return;
    }
    if (stat.type !== vscode.FileType.Directory) {
      return;
    }

    const trimmedTitle = title.trim();
    const safeTitle = trimmedTitle || "New ticket";
    const baseName = slugifyFileName(trimmedTitle) || "new-ticket";
    const entries = await vscode.workspace.fs.readDirectory(columnUri);
    const existing = new Set(
      entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name.toLowerCase())
    );

    let fileName = `${baseName}.md`;
    if (existing.has(fileName.toLowerCase())) {
      let counter = 2;
      while (existing.has(`${baseName}-${counter}.md`)) {
        counter += 1;
      }
      fileName = `${baseName}-${counter}.md`;
    }

    const existingCards = await this.readCards(columnUri);
    const maxPriority = existingCards.reduce((max, card) => {
      return typeof card.priority === "number" && Number.isFinite(card.priority)
        ? Math.max(max, card.priority)
        : max;
    }, 0);
    const nextPriority = maxPriority + 1;
    const fileUri = vscode.Uri.joinPath(columnUri, fileName);
    const content = `# ${safeTitle}\n\nPriority: ${nextPriority}\n\n`;
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
  }

  private async reorderCards(
    kanbanUri: vscode.Uri,
    cardUriString: string,
    sourceColumnId: string,
    targetColumnId: string,
    orderedUris: string[]
  ): Promise<void> {
    if (!targetColumnId || !Array.isArray(orderedUris)) {
      return;
    }
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const targetColumnUri = vscode.Uri.joinPath(boardFolder, targetColumnId);
    let movedCardUriString = cardUriString;

    if (cardUriString && sourceColumnId && sourceColumnId !== targetColumnId) {
      const cardUri = vscode.Uri.parse(cardUriString);
      const fileName = cardUri.path.split("/").pop();
      if (fileName) {
        const newUri = vscode.Uri.joinPath(targetColumnUri, fileName);
        if (cardUri.toString() !== newUri.toString()) {
          await vscode.workspace.fs.rename(cardUri, newUri, { overwrite: false });
        }
        movedCardUriString = newUri.toString();
      }
    }

    const normalizedUris = orderedUris.map((uri) =>
      uri === cardUriString && movedCardUriString ? movedCardUriString : uri
    );
    await this.updateCardPriorities(normalizedUris);

    if (sourceColumnId && sourceColumnId !== targetColumnId) {
      const sourceColumnUri = vscode.Uri.joinPath(boardFolder, sourceColumnId);
      await this.resequenceColumnPriorities(sourceColumnUri);
    }
  }

  private async updateCardPriorities(
    orderedUris: string[]
  ): Promise<void> {
    const seen = new Set<string>();
    let priority = 1;
    for (const uriString of orderedUris) {
      if (!uriString || seen.has(uriString)) {
        continue;
      }
      seen.add(uriString);
      const fileUri = vscode.Uri.parse(uriString);
      try {
        await this.updateMarkdownNumber(fileUri, "Priority", priority);
        priority += 1;
      } catch {
        continue;
      }
    }
  }

  private async resequenceColumnPriorities(
    columnUri: vscode.Uri
  ): Promise<void> {
    try {
      const cards = await this.readCards(columnUri);
      const orderedUris = cards.map((card) => card.uri);
      await this.updateCardPriorities(orderedUris);
    } catch {
      return;
    }
  }

  private async reorderColumns(
    kanbanUri: vscode.Uri,
    sourceColumnId: string,
    targetColumnId: string,
    position: "before" | "after" | undefined
  ): Promise<void> {
    if (!sourceColumnId || !targetColumnId || sourceColumnId === targetColumnId) {
      return;
    }
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: { id: string; name: string; order: number | null }[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const columnUri = vscode.Uri.joinPath(boardFolder, name);
      const meta = await this.readColumnMeta(columnUri, name);
      columns.push({ id: name, name: meta.title, order: meta.order });
    }

    columns.sort((a, b) => {
      const orderA = a.order ?? Number.POSITIVE_INFINITY;
      const orderB = b.order ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.name.localeCompare(b.name);
    });

    const orderedIds = columns.map((column) => column.id);
    const sourceIndex = orderedIds.indexOf(sourceColumnId);
    const targetIndex = orderedIds.indexOf(targetColumnId);
    if (sourceIndex === -1 || targetIndex === -1) {
      return;
    }
    orderedIds.splice(sourceIndex, 1);
    const nextTargetIndex = orderedIds.indexOf(targetColumnId);
    const insertIndex =
      position === "after" ? nextTargetIndex + 1 : nextTargetIndex;
    orderedIds.splice(insertIndex, 0, sourceColumnId);

    let orderValue = 1;
    for (const id of orderedIds) {
      const columnUri = vscode.Uri.joinPath(boardFolder, id);
      const meta = columns.find((column) => column.id === id);
      await this.updateColumnOrder(columnUri, meta?.name ?? id, orderValue);
      orderValue += 1;
    }
  }

  private async updateColumnOrder(
    columnUri: vscode.Uri,
    fallbackTitle: string,
    order: number
  ): Promise<void> {
    const metaUri = vscode.Uri.joinPath(columnUri, "folder.md");
    let content = "";
    try {
      const raw = await vscode.workspace.fs.readFile(metaUri);
      content = Buffer.from(raw).toString("utf8");
    } catch {
      content = `# ${fallbackTitle}\n`;
    }
    const updated = upsertNumberLine(content, "Order", order);
    await vscode.workspace.fs.writeFile(metaUri, Buffer.from(updated, "utf8"));
  }

  private async updateMarkdownNumber(
    fileUri: vscode.Uri,
    key: string,
    value: number
  ): Promise<void> {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    const text = Buffer.from(raw).toString("utf8");
    const updated = upsertNumberLine(text, key, value);
    if (updated !== text) {
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(updated, "utf8")
      );
    }
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
    .column-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: grab;
    }
    .column-header:active {
      cursor: grabbing;
    }
    .column h2 {
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0;
      color: var(--muted);
    }
    .add-card {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      font-family: var(--mono);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
    }
    .add-card:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 10px -8px var(--shadow);
      border-color: var(--accent);
    }
    .add-card:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
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
    .card-drop-target {
      outline: 2px dashed var(--accent);
      outline-offset: 2px;
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
    const cardDragType = "application/x-kanban-card";
    const columnDragType = "application/x-kanban-column";
    let draggingCard = null;
    let draggingColumn = null;

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
      const priorityLabel = formatPriority(card.priority);
      const metaLine = "Created: " + createdLabel + " · " + createdRelative + (priorityLabel ? " · Priority " + priorityLabel : "");
      detailsEl.innerHTML = \`
        <h1>\${escapeHtml(card.title)}</h1>
        <div class="meta">\${metaLine}</div>
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

    const formatPriority = (value) => {
      return Number.isFinite(value) ? String(value) : "";
    };

    const getDragTypes = (event) => {
      return Array.from(event?.dataTransfer?.types || []);
    };

    const buildOrderedUris = (cards, cardUri, targetUri, position) => {
      const list = (cards || []).map((card) => card.uri).filter((uri) => uri !== cardUri);
      if (!targetUri) {
        list.push(cardUri);
        return list;
      }
      const targetIndex = list.indexOf(targetUri);
      if (targetIndex === -1) {
        list.push(cardUri);
        return list;
      }
      const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
      list.splice(insertIndex, 0, cardUri);
      return list;
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
      const firstColumnId = board.columns[0]?.id ?? board.columns[0]?.name;
      for (const column of board.columns) {
        const columnId = column.id ?? column.name;
        const columnEl = document.createElement("div");
        columnEl.className = "column";
        columnEl.dataset.column = columnId;
        const headerEl = document.createElement("div");
        headerEl.className = "column-header";
        headerEl.draggable = true;
        headerEl.addEventListener("dragstart", (event) => {
          draggingColumn = columnId;
          event.dataTransfer.setData(columnDragType, columnId);
          event.dataTransfer.effectAllowed = "move";
        });
        headerEl.addEventListener("dragend", () => {
          draggingColumn = null;
        });
        const titleEl = document.createElement("h2");
        titleEl.textContent = column.name;
        headerEl.appendChild(titleEl);
        if (columnId === firstColumnId) {
          const addButton = document.createElement("button");
          addButton.className = "add-card";
          addButton.type = "button";
          addButton.textContent = "+ Add ticket";
          addButton.draggable = false;
          addButton.addEventListener("click", () => {
            vscode.postMessage({ type: "requestNewCard", columnId });
          });
          headerEl.appendChild(addButton);
        }
        columnEl.appendChild(headerEl);
        columnEl.addEventListener("dragover", (event) => {
          const types = getDragTypes(event);
          if (types.includes(columnDragType) || types.includes(cardDragType) || types.includes("text/uri-list")) {
            event.preventDefault();
            columnEl.classList.add("drop-target");
          }
        });
        columnEl.addEventListener("dragleave", () => {
          columnEl.classList.remove("drop-target");
        });
        columnEl.addEventListener("drop", (event) => {
          const types = getDragTypes(event);
          if (types.includes(columnDragType)) {
            event.preventDefault();
            columnEl.classList.remove("drop-target");
            const sourceColumnId = draggingColumn || event.dataTransfer.getData(columnDragType);
            if (!sourceColumnId || sourceColumnId === columnId) {
              return;
            }
            const rect = columnEl.getBoundingClientRect();
            const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
            vscode.postMessage({
              type: "reorderColumns",
              sourceColumnId,
              targetColumnId: columnId,
              position,
            });
            return;
          }
          event.preventDefault();
          columnEl.classList.remove("drop-target");
          const cardUri = event.dataTransfer.getData("text/uri-list");
          if (cardUri) {
            let sourceColumnId = draggingCard?.columnId;
            if (!sourceColumnId) {
              try {
                const payload = JSON.parse(event.dataTransfer.getData(cardDragType) || "{}");
                sourceColumnId = payload.columnId;
              } catch {}
            }
            const orderedUris = buildOrderedUris(column.cards, cardUri, null, "after");
            vscode.postMessage({
              type: "reorderCards",
              cardUri,
              sourceColumnId,
              targetColumnId: columnId,
              orderedUris,
            });
          }
        });

        for (const card of column.cards) {
          const cardEl = document.createElement("div");
          cardEl.className = "card";
          cardEl.draggable = true;
          cardEl.dataset.uri = card.uri;
          cardEl.dataset.column = columnId;
          const tagsHtml = renderTags(card.tags || []);
          const created = new Date(card.createdAt);
          const createdLabel = created.toLocaleDateString();
          const createdRelative = formatRelativeTime(created);
          const priorityLabel = formatPriority(card.priority);
          const metaLine = createdLabel + " · " + createdRelative + (priorityLabel ? " · P" + priorityLabel : "");
          cardEl.innerHTML = \`
            <h3>\${escapeHtml(card.title)}</h3>
            <div class="meta">\${metaLine}</div>
            \${tagsHtml}
          \`;
          cardEl.addEventListener("click", () => renderDetails(card));
          cardEl.addEventListener("dblclick", () => openCard(card));
          cardEl.addEventListener("dragstart", (event) => {
            draggingCard = { uri: card.uri, columnId };
            event.dataTransfer.setData("text/uri-list", card.uri);
            event.dataTransfer.setData(cardDragType, JSON.stringify(draggingCard));
            event.dataTransfer.effectAllowed = "move";
          });
          cardEl.addEventListener("dragend", () => {
            draggingCard = null;
          });
          cardEl.addEventListener("dragover", (event) => {
            const types = getDragTypes(event);
            if (types.includes(columnDragType)) {
              return;
            }
            event.preventDefault();
            cardEl.classList.add("card-drop-target");
          });
          cardEl.addEventListener("dragleave", () => {
            cardEl.classList.remove("card-drop-target");
          });
          cardEl.addEventListener("drop", (event) => {
            const types = getDragTypes(event);
            if (types.includes(columnDragType)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            cardEl.classList.remove("card-drop-target");
            const cardUri = event.dataTransfer.getData("text/uri-list");
            if (!cardUri) {
              return;
            }
            let sourceColumnId = draggingCard?.columnId;
            if (!sourceColumnId) {
              try {
                const payload = JSON.parse(event.dataTransfer.getData(cardDragType) || "{}");
                sourceColumnId = payload.columnId;
              } catch {}
            }
            const rect = cardEl.getBoundingClientRect();
            const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            const orderedUris = buildOrderedUris(column.cards, cardUri, card.uri, position);
            vscode.postMessage({
              type: "reorderCards",
              cardUri,
              sourceColumnId,
              targetColumnId: columnId,
              orderedUris,
            });
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
): { title: string; body: string; tags: string[]; priority: number | null } {
  const lines = content.split(/\r?\n/);
  let title = fallbackTitle.replace(/\.md$/i, "");
  let bodyStart = 0;
  const tags: string[] = [];
  const tagPattern = /^tags\s*:\s*(.+)$/i;
  const priorityPattern = /^priority\s*:\s*(.+)$/i;
  let priority: number | null = null;
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
    const priorityMatch = lines[i].match(priorityPattern);
    if (priorityMatch) {
      const value = Number(priorityMatch[1].trim());
      if (Number.isFinite(value)) {
        priority = value;
      }
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
    const priorityMatch = line.match(priorityPattern);
    if (priorityMatch) {
      const value = Number(priorityMatch[1].trim());
      if (Number.isFinite(value)) {
        priority = value;
      }
      continue;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n").trim();
  return { title, body, tags, priority };
}

function parseColumnMarkdown(
  content: string,
  fallbackTitle: string
): { title: string; order: number | null } {
  const lines = content.split(/\r?\n/);
  let title = fallbackTitle;
  let order: number | null = null;
  const orderPattern = /^order\s*:\s*(.+)$/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ")) {
      title = line.replace(/^#\s+/, "").trim() || title;
    }
    const match = line.match(orderPattern);
    if (match) {
      const value = Number(match[1].trim());
      if (Number.isFinite(value)) {
        order = value;
      }
    }
  }
  return { title, order };
}

function upsertNumberLine(content: string, key: string, value: number): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\s*${key}\s*:\s*.*$`, "i");
  const updated: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (pattern.test(line)) {
      if (!replaced) {
        updated.push(`${key}: ${value}`);
        replaced = true;
      }
      continue;
    }
    updated.push(line);
  }
  if (!replaced) {
    const headingIndex = updated.findIndex((line) => line.trim().startsWith("# "));
    if (headingIndex !== -1) {
      updated.splice(headingIndex + 1, 0, "", `${key}: ${value}`, "");
    } else {
      updated.splice(0, 0, `${key}: ${value}`, "");
    }
  }
  return updated.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n\n$/g, "\n\n");
}
function slugifyFileName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
