import * as path from "path";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import YAML from "yaml";
import {
  findTaskLinkActions,
  isAbsoluteLocalPath as isTaskAbsoluteLocalPath,
  isGuidValue as isTaskGuidValue,
  normalizePropertyValue as normalizeTaskPropertyValue,
  parseTaskPropertyLine,
  type TaskLinkAction,
} from "./task-links";

type CardProperty = {
  key: string;
  label: string;
  value: string;
};

type Card = {
  uri: string;
  fileName: string;
  title: string;
  body: string;
  bodyHtml: string;
  properties: CardProperty[];
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

type BoardFolderConfig = {
  id: string;
  title: string | null;
  order: number;
  rawValue: unknown;
};

type BoardConfig = {
  data: Record<string, unknown>;
  folders: BoardFolderConfig[];
  folderMap: Map<string, BoardFolderConfig>;
  sourceText: string;
};

type EditContext = {
  edit: vscode.WorkspaceEdit;
  docs: Map<string, vscode.TextDocument>;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
});

const RESUME_AGENT_COMMAND = "kanban.resumeAgent";
const OPEN_PATH_COMMAND = "kanban.openPath";

export function activate(context: vscode.ExtensionContext) {
  const provider = new KanbanEditorProvider(context);
  const taskActionProvider = new TaskActionEditorProvider(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(RESUME_AGENT_COMMAND, async (agentId: string) =>
      provider.resumeAgent(String(agentId))
    ),
    vscode.commands.registerCommand(OPEN_PATH_COMMAND, async (targetPath: string) =>
      provider.openPathInTerminal(String(targetPath))
    ),
    vscode.window.registerCustomEditorProvider("kanban.board", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, taskActionProvider)
  );
}

export function deactivate() {}

class TaskActionEditorProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses =
    this.onDidChangeCodeLensesEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.disposables.push(
      this.onDidChangeCodeLensesEmitter,
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isMarkdownDocument(event.document)) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (isMarkdownDocument(document)) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isMarkdownDocument(document)) {
          this.refresh();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document && isMarkdownDocument(editor.document)) {
          this.refresh();
        }
      })
    );
    context.subscriptions.push(this);
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    return this.getActions(document).map((action) => {
      const line = document.lineAt(action.line);
      return new vscode.CodeLens(line.range, toTaskActionCommand(action));
    });
  }

  private getActions(document: vscode.TextDocument) {
    return findTaskLinkActions(document.getText());
  }

  private refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function toTaskActionCommand(action: TaskLinkAction): vscode.Command {
  return {
    title: action.title,
    command:
      action.command === "resumeAgent" ? RESUME_AGENT_COMMAND : OPEN_PATH_COMMAND,
    arguments: [action.value],
  };
}

function getTaskActionTooltip(action: TaskLinkAction): string {
  return action.command === "resumeAgent"
    ? `Resume agent ${action.value}`
    : `Open ${action.value}`;
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

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
      try {
        const board = await this.buildBoard(document.uri);
        webviewPanel.webview.postMessage({ type: "boardData", board });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "Unknown error");
        console.error("Failed to build kanban board", error);
        webviewPanel.webview.postMessage({ type: "boardError", message });
      }
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
      if (message?.type === "undo") {
        await vscode.commands.executeCommand("undo");
        return;
      }
      if (message?.type === "redo") {
        await vscode.commands.executeCommand("redo");
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
      if (message?.type === "resumeAgent" && message?.agentId) {
        await this.resumeAgent(String(message.agentId));
        return;
      }
      if (message?.type === "openPath" && message?.path) {
        await this.openPathInTerminal(String(message.path));
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
    const boardConfig = await this.readBoardConfig(kanbanUri);
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: Column[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const columnUri = vscode.Uri.joinPath(boardFolder, name);
      const meta = await this.readColumnMeta(columnUri, name, boardConfig);
      const cards = await this.readCards(columnUri);
      columns.push({
        id: name,
        name: meta.title,
        order: meta.order,
        cards,
      });
    }

    const orderedColumns = this.orderColumns(columns, boardConfig);
    try {
      await this.syncBoardConfig(kanbanUri, orderedColumns, boardConfig);
    } catch (error) {
      console.error("Failed to sync .kanban config", error);
    }
    return { columns: orderedColumns };
  }

  private orderColumns<T extends { id: string; name: string; order: number | null }>(
    columns: T[],
    boardConfig: BoardConfig
  ): T[] {
    if (boardConfig.folders.length === 0) {
      return [...columns].sort(compareColumns);
    }

    const configured = boardConfig.folders
      .map((folder) => columns.find((column) => column.id === folder.id))
      .filter((column): column is T => !!column);
    const extras = columns
      .filter((column) => !boardConfig.folderMap.has(column.id))
      .sort(compareColumns);
    return [...configured, ...extras];
  }

  private async readBoardConfig(kanbanUri: vscode.Uri): Promise<BoardConfig> {
    try {
      const raw = await vscode.workspace.fs.readFile(kanbanUri);
      const text = Buffer.from(raw).toString("utf8");
      return parseBoardConfig(text);
    } catch {
      return createEmptyBoardConfig("");
    }
  }

  private async syncBoardConfig(
    kanbanUri: vscode.Uri,
    columns: { id: string; name: string }[],
    boardConfig: BoardConfig
  ): Promise<void> {
    const nextData = { ...boardConfig.data };

    if (columns.length === 0) {
      delete nextData.folders;
    } else {
      nextData.folders = buildFolderConfigMap(columns, boardConfig);
    }

    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized);
    }
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
      const { title, body, properties, tags, priority } = parseMarkdown(
        text,
        name
      );
      const bodyHtml = md.render(body || "");
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        body,
        bodyHtml,
        properties,
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
    fallbackTitle: string,
    boardConfig: BoardConfig
  ): Promise<{ title: string; order: number | null }> {
    const configured = boardConfig.folderMap.get(fallbackTitle);
    if (configured) {
      return {
        title: configured.title?.trim() || fallbackTitle,
        order: configured.order,
      };
    }
    const metaUri = vscode.Uri.joinPath(columnUri, "folder.md");
    try {
      const raw = await vscode.workspace.fs.readFile(metaUri);
      const text = Buffer.from(raw).toString("utf8");
      const legacy = parseColumnMarkdown(text, fallbackTitle);
      return {
        title: legacy.title,
        order: boardConfig.folderMap.size > 0 ? null : legacy.order,
      };
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
    const sourceColumnUri = vscode.Uri.joinPath(cardUri, "..");
    const targetCards = await this.readCards(targetColumnUri);
    const targetTargets = targetCards.map((card) => ({
      displayUri: card.uri,
      editUri: card.uri,
    }));
    targetTargets.push({
      displayUri: newUri.toString(),
      editUri: cardUri.toString(),
    });
    const sourceCards = await this.readCards(sourceColumnUri);
    const sourceTargets = sourceCards
      .filter((card) => card.uri !== cardUriString)
      .map((card) => ({
        displayUri: card.uri,
        editUri: card.uri,
      }));
    const context = this.createEditContext();
    await this.renameFile(cardUri, newUri, context);
    await this.updateCardPriorities(targetTargets, context);
    await this.updateCardPriorities(sourceTargets, context);
    await this.applyEditContext(context);
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
    const context = this.createEditContext();
    await this.ensureFile(fileUri, context);
    this.queueInsertContent(context, fileUri, content);
    await this.applyEditContext(context);
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
    const context = this.createEditContext();

    if (cardUriString && sourceColumnId && sourceColumnId !== targetColumnId) {
      const cardUri = vscode.Uri.parse(cardUriString);
      const fileName = cardUri.path.split("/").pop();
      if (fileName) {
        const newUri = vscode.Uri.joinPath(targetColumnUri, fileName);
        if (cardUri.toString() !== newUri.toString()) {
          await this.renameFile(cardUri, newUri, context);
        }
        movedCardUriString = newUri.toString();
      }
    }

    const normalizedUris = orderedUris.map((uri) =>
      uri === cardUriString && movedCardUriString ? movedCardUriString : uri
    );
    const orderedTargets = normalizedUris.map((uri) => ({
      displayUri: uri,
      editUri: uri,
    }));
    if (
      cardUriString &&
      movedCardUriString &&
      sourceColumnId &&
      sourceColumnId !== targetColumnId
    ) {
      const movedIndex = orderedTargets.findIndex(
        (target) => target.displayUri === movedCardUriString
      );
      if (movedIndex !== -1) {
        orderedTargets[movedIndex] = {
          displayUri: movedCardUriString,
          editUri: cardUriString,
        };
      }
    }
    await this.updateCardPriorities(orderedTargets, context);

    if (sourceColumnId && sourceColumnId !== targetColumnId && cardUriString) {
      const sourceColumnUri = vscode.Uri.joinPath(boardFolder, sourceColumnId);
      const sourceCards = await this.readCards(sourceColumnUri);
      const sourceTargets = sourceCards
        .filter((card) => card.uri !== cardUriString)
        .map((card) => ({
          displayUri: card.uri,
          editUri: card.uri,
        }));
      await this.updateCardPriorities(sourceTargets, context);
    }
    await this.applyEditContext(context);
  }

  private async updateCardPriorities(
    orderedTargets: { displayUri: string; editUri: string }[],
    context?: EditContext
  ): Promise<void> {
    const seen = new Set<string>();
    let priority = 1;
    for (const target of orderedTargets) {
      if (!target?.editUri || seen.has(target.editUri)) {
        continue;
      }
      seen.add(target.editUri);
      const fileUri = vscode.Uri.parse(target.editUri);
      try {
        await this.updateMarkdownNumber(fileUri, "Priority", priority, context);
        priority += 1;
      } catch {
        continue;
      }
    }
  }

  private async resequenceColumnPriorities(
    columnUri: vscode.Uri,
    context?: EditContext,
    excludeUri?: string
  ): Promise<void> {
    try {
      const cards = await this.readCards(columnUri);
      const orderedTargets = cards
        .filter((card) => card.uri !== excludeUri)
        .map((card) => ({
          displayUri: card.uri,
          editUri: card.uri,
        }));
      await this.updateCardPriorities(orderedTargets, context);
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
    const boardConfig = await this.readBoardConfig(kanbanUri);
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: { id: string; name: string; order: number | null }[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const columnUri = vscode.Uri.joinPath(boardFolder, name);
      const meta = await this.readColumnMeta(columnUri, name, boardConfig);
      columns.push({ id: name, name: meta.title, order: meta.order });
    }

    const orderedIds = this.orderColumns(columns, boardConfig).map(
      (column) => column.id
    );
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

    await this.updateBoardFolderOrder(kanbanUri, orderedIds, columns, boardConfig);
  }

  private async updateBoardFolderOrder(
    kanbanUri: vscode.Uri,
    orderedIds: string[],
    columns: { id: string; name: string }[],
    boardConfig: BoardConfig
  ): Promise<void> {
    const nextData = { ...boardConfig.data };
    const orderedColumns = orderedIds
      .map((id) => columns.find((column) => column.id === id))
      .filter(
        (column): column is { id: string; name: string } => !!column
      );
    nextData.folders = buildFolderConfigMap(orderedColumns, boardConfig);
    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    await this.applyContentEdit(kanbanUri, serialized);
  }

  public async resumeAgent(agentId: string): Promise<void> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `Kanban Agent ${trimmed.slice(0, 8)}`,
    });
    terminal.show(true);
    terminal.sendText(`codex resume ${trimmed}`, true);
  }

  public async openPathInTerminal(rawPath: string): Promise<void> {
    const targetPath = normalizeTaskPropertyValue(rawPath);
    if (!isTaskAbsoluteLocalPath(targetPath)) {
      return;
    }

    let cwd = targetPath;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
      if (stat.type !== vscode.FileType.Directory) {
        cwd = path.dirname(targetPath);
      }
    } catch {
      const parent = path.dirname(targetPath);
      if (parent && parent !== targetPath) {
        cwd = parent;
      }
    }

    const terminal = vscode.window.createTerminal({
      name: `Kanban Path ${path.basename(cwd) || cwd}`,
      cwd,
    });
    terminal.show(true);
  }

  private async updateMarkdownNumber(
    fileUri: vscode.Uri,
    key: string,
    value: number,
    context?: EditContext
  ): Promise<void> {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    const text = Buffer.from(raw).toString("utf8");
    const updated = upsertNumberLine(text, key, value);
    if (updated !== text) {
      await this.applyContentEdit(fileUri, updated, context);
    }
  }

  private async renameFile(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    context?: EditContext
  ): Promise<void> {
    if (oldUri.toString() === newUri.toString()) {
      return;
    }
    if (context) {
      context.edit.renameFile(oldUri, newUri, { overwrite: false });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldUri, newUri, { overwrite: false });
    await vscode.workspace.applyEdit(edit);
  }

  private async ensureFile(
    fileUri: vscode.Uri,
    context?: EditContext
  ): Promise<void> {
    if (context) {
      context.edit.createFile(fileUri, { ignoreIfExists: true });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(fileUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
  }

  private async applyContentEdit(
    fileUri: vscode.Uri,
    content: string,
    context?: EditContext
  ): Promise<void> {
    if (context) {
      await this.queueContentEdit(context, fileUri, content);
      return;
    }
    const localContext = this.createEditContext();
    await this.queueContentEdit(localContext, fileUri, content);
    await this.applyEditContext(localContext);
  }

  private createEditContext(): EditContext {
    return { edit: new vscode.WorkspaceEdit(), docs: new Map() };
  }

  private async applyEditContext(context: EditContext): Promise<void> {
    await vscode.workspace.applyEdit(context.edit);
    for (const document of context.docs.values()) {
      await document.save();
    }
  }

  private async queueContentEdit(
    context: EditContext,
    fileUri: vscode.Uri,
    content: string
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const normalized = content.replace(/\r?\n/g, eol);
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    context.edit.replace(fileUri, fullRange, normalized);
    context.docs.set(fileUri.toString(), document);
  }

  private queueInsertContent(
    context: EditContext,
    fileUri: vscode.Uri,
    content: string
  ): void {
    context.edit.insert(fileUri, new vscode.Position(0, 0), content);
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
      --bg: var(--vscode-editor-background, #1e1e1e);
      --panel: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, var(--bg)));
      --surface: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, var(--bg)));
      --line: var(--vscode-panel-border, var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.35)));
      --ink: var(--vscode-editor-foreground, #cccccc);
      --muted: var(--vscode-descriptionForeground, var(--vscode-editor-foreground, #9da5b4));
      --accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #3794ff));
      --accent-soft: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
      --card-accent: var(--vscode-textLink-foreground, var(--accent));
      --shadow: rgba(0, 0, 0, 0.18);
      --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      --display: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--display);
      font-size: var(--vscode-font-size, 13px);
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
      background: var(--surface);
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
      background: var(--surface);
      border: 1px solid var(--line);
      border-left: 4px solid var(--card-accent);
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
      background: var(--panel);
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
    .error {
      color: var(--vscode-errorForeground, #f14c4c);
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      padding: 16px;
      border-radius: 12px;
      background: var(--panel);
      white-space: pre-wrap;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .properties {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 14px;
    }
    .property-row {
      display: grid;
      grid-template-columns: minmax(72px, 110px) minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      padding: 10px 12px;
      border-radius: 12px;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    .property-label {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .property-value {
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    .property-action {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--accent);
      font-family: var(--mono);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
    }
    .property-action:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .property-action:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .details-body {
      margin-top: 18px;
    }
    .details-body hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 0 0 16px;
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

    const escapeHtml = (value) => {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const normalizePropertyValue = (value) => {
      const trimmed = String(value || "").trim();
      if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          return trimmed.slice(1, -1).trim();
        }
      }
      return trimmed;
    };

    const isGuidValue = (value) => {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        normalizePropertyValue(value)
      );
    };

    const isAbsoluteLocalPath = (value) => {
      const normalized = normalizePropertyValue(value);
      return /^[a-zA-Z]:[\\/]/.test(normalized)
        || normalized.startsWith("\\\\")
        || normalized.startsWith("/");
    };

    const getPropertyAction = (property) => {
      const value = normalizePropertyValue(property?.value);
      const key = String(property?.key || "").trim().toLowerCase();
      if (key === "agent" && isGuidValue(value)) {
        return { type: "resumeAgent", label: "Connect", value };
      }
      if (isAbsoluteLocalPath(value)) {
        return { type: "openPath", label: "Open", value };
      }
      return null;
    };

    const renderProperties = (properties) => {
      if (!properties?.length) return "";
      const rows = properties.map((property) => {
        const action = getPropertyAction(property);
        const actionHtml = action
          ? \`<button class="property-action" type="button" data-action-type="\${escapeHtml(action.type)}" data-action-value="\${escapeHtml(action.value)}">\${escapeHtml(action.label)}</button>\`
          : "";
        return \`
          <div class="property-row">
            <div class="property-label">\${escapeHtml(property.label)}:</div>
            <div class="property-value">\${escapeHtml(property.value)}</div>
            \${actionHtml}
          </div>
        \`;
      }).join("");
      return \`<div class="properties">\${rows}</div>\`;
    };

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
      const propertiesHtml = renderProperties(card.properties || []);
      const priorityLabel = formatPriority(card.priority);
      const metaLine = "Created: " + createdLabel + " · " + createdRelative + (priorityLabel ? " · Priority " + priorityLabel : "");
      detailsEl.innerHTML = \`
        <h1>\${escapeHtml(card.title)}</h1>
        <div class="meta">\${metaLine}</div>
        \${tagsHtml}
        \${propertiesHtml}
        <div class="details-body">
          <hr />
          <div>\${bodyHtml || '<div class="empty">No description.</div>'}</div>
        </div>
      \`;
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
    detailsEl.addEventListener("click", (event) => {
      const actionButton = event.target instanceof Element
        ? event.target.closest("[data-action-type]")
        : null;
      if (!actionButton) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const actionType = actionButton.getAttribute("data-action-type");
      const actionValue = actionButton.getAttribute("data-action-value");
      if (!actionType || !actionValue) {
        return;
      }
      vscode.postMessage({ type: actionType, path: actionValue, agentId: actionValue });
    });
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
      if (message?.type === "boardError") {
        boardEl.innerHTML = \`<div class="error">\${escapeHtml(message.message || "Failed to load board.")}</div>\`;
      }
    });

    window.addEventListener("keydown", (event) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        vscode.postMessage({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (!isMac && key === "y") {
        event.preventDefault();
        vscode.postMessage({ type: "redo" });
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

function createEmptyBoardConfig(sourceText: string): BoardConfig {
  return {
    data: {},
    folders: [],
    folderMap: new Map(),
    sourceText,
  };
}

function parseBoardConfig(content: string): BoardConfig {
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(content);
    if (isPlainObject(parsed)) {
      data = { ...parsed };
    }
  } catch {
    data = {};
  }

  const folders: BoardFolderConfig[] = [];
  const rawFolders = data.folders;

  if (Array.isArray(rawFolders)) {
    let order = 1;
    for (const entry of rawFolders) {
      if (typeof entry === "string") {
        const id = entry.trim();
        if (!id) {
          continue;
        }
        folders.push({ id, title: id, order, rawValue: entry });
        order += 1;
        continue;
      }
      if (!isPlainObject(entry)) {
        continue;
      }
      const id = coerceString(
        entry.id ?? entry.folder ?? entry.path ?? entry.name
      );
      if (!id) {
        continue;
      }
      folders.push({
        id,
        title: coerceString(entry.title) ?? id,
        order,
        rawValue: entry,
      });
      order += 1;
    }
  } else if (isPlainObject(rawFolders)) {
    let order = 1;
    for (const [id, value] of Object.entries(rawFolders)) {
      const folderId = id.trim();
      if (!folderId) {
        continue;
      }
      folders.push({
        id: folderId,
        title: readFolderTitle(value) ?? folderId,
        order,
        rawValue: value,
      });
      order += 1;
    }
  }

  return {
    data,
    folders,
    folderMap: new Map(folders.map((folder) => [folder.id, folder])),
    sourceText: content,
  };
}

function serializeBoardConfig(
  data: Record<string, unknown>,
  existingText = ""
): string {
  const eol = detectLineEnding(existingText);
  const serialized = YAML.stringify(data).trim();
  return serialized ? `${serialized}${eol}` : "";
}

function buildFolderConfigMap(
  columns: { id: string; name: string }[],
  boardConfig: BoardConfig
): Record<string, unknown> {
  const folders: Record<string, unknown> = {};
  for (const column of columns) {
    const existing = boardConfig.folderMap.get(column.id);
    folders[column.id] = buildFolderConfigValue(
      column.id,
      column.name,
      existing?.rawValue
    );
  }
  return folders;
}

function buildFolderConfigValue(
  folderId: string,
  title: string,
  rawValue: unknown
): unknown {
  if (isPlainObject(rawValue)) {
    const updated = { ...rawValue };
    if (title === folderId) {
      delete updated.title;
    } else {
      updated.title = title;
    }
    return Object.keys(updated).length > 0 ? updated : title;
  }
  return title;
}

function readFolderTitle(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (isPlainObject(value)) {
    return coerceString(value.title);
  }
  return null;
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compareColumns(
  a: { name: string; order: number | null },
  b: { name: string; order: number | null }
): number {
  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return a.name.localeCompare(b.name);
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function normalizePropertyValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isGuidValue(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizePropertyValue(value)
  );
}

function isAbsoluteLocalPath(value: string): boolean {
  const normalized = normalizePropertyValue(value);
  if (!normalized || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return false;
  }
  return (
    path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)
  );
}

function parseMarkdown(
  content: string,
  fallbackTitle: string
): {
  title: string;
  body: string;
  properties: CardProperty[];
  tags: string[];
  priority: number | null;
} {
  const lines = content.split(/\r?\n/);
  let title = fallbackTitle.replace(/\.md$/i, "");
  let titleIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("# ")) {
      title = line.replace(/^#\s+/, "").trim() || title;
      titleIndex = i;
      break;
    }
  }

  const metadataStart = titleIndex === -1 ? 0 : titleIndex + 1;
  const { properties, nextIndex } = extractPropertyBlock(lines, metadataStart);
  const tags = new Set<string>();
  let priority: number | null = null;

  for (const property of properties) {
    if (property.key.toLowerCase() === "tags") {
      for (const tag of property.value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)) {
        tags.add(tag);
      }
    }
    if (property.key.toLowerCase() === "priority") {
      const value = Number(property.value.trim());
      if (Number.isFinite(value)) {
        priority = value;
      }
    }
  }

  const body = lines.slice(nextIndex).join("\n").trim();
  return {
    title,
    body,
    properties,
    tags: Array.from(tags),
    priority,
  };
}

function extractPropertyBlock(
  lines: string[],
  startIndex: number
): { properties: CardProperty[]; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }
  const firstContentIndex = index;

  const properties: CardProperty[] = [];
  while (index < lines.length) {
    const property = parseTaskPropertyLine(lines[index]);
    if (!property) {
      break;
    }
    properties.push(property);
    index += 1;
  }

  if (
    properties.length === 0 ||
    (index < lines.length && lines[index].trim() !== "")
  ) {
    return { properties: [], nextIndex: firstContentIndex };
  }

  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  return { properties, nextIndex: index };
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
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*.*$`, "i");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
