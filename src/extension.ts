import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import MarkdownIt from "markdown-it";
import {
  buildFolderCardPriorityOverrides,
  buildFolderConfigMap,
  createEmptyBoardConfig,
  normalizeLineEndings,
  orderColumnsByConfig,
  parseBoardConfig,
  serializeBoardConfig,
  type BoardConfig,
} from "./board-config";
import {
  parseTaskMarkdown,
  type TaskProperty,
} from "./task-metadata";
import {
  findTaskLinkActions,
  getTaskPropertyAction,
  isAbsoluteLocalPath as isTaskAbsoluteLocalPath,
  isGuidValue as isTaskGuidValue,
  normalizePropertyValue as normalizeTaskPropertyValue,
  type TaskPropertyAction,
  type TaskLinkAction,
} from "./task-links";
import {
  buildNewCardContent,
  CARD_TEMPLATE_FILE_NAME,
  resolveCursorPlaceholder,
} from "./new-card";

type CardProperty = TaskProperty & {
  action: TaskPropertyAction | null;
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

type EditContext = {
  edit: vscode.WorkspaceEdit;
  docs: Map<string, vscode.TextDocument>;
};

type CodexSessionFile = {
  path: string;
  lastCheckedAt: number;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
});
const execFileAsync = promisify(execFile);
const DETAILS_REFRESH_INTERVAL_MS = 10000;

const RESUME_AGENT_COMMAND = "kanban.resumeAgent";
const OPEN_PATH_COMMAND = "kanban.openPath";
const OPEN_CODE_COMMAND = "kanban.openCode";

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
    vscode.commands.registerCommand(OPEN_CODE_COMMAND, async (targetPath: string) =>
      provider.openPathInCode(String(targetPath))
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
  let command = OPEN_PATH_COMMAND;
  if (action.command === "resumeAgent") {
    command = RESUME_AGENT_COMMAND;
  } else if (action.command === "openCode") {
    command = OPEN_CODE_COMMAND;
  }
  return {
    title: action.title,
    tooltip: getTaskActionTooltip(action),
    command,
    arguments: [action.value],
  };
}

function getTaskActionTooltip(action: TaskLinkAction): string {
  return action.command === "resumeAgent"
    ? `Resume agent ${action.value}`
    : action.command === "openCode"
      ? `Open ${action.value} in VS Code`
      : `Open ${action.value}`;
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

class KanbanEditorProvider implements vscode.CustomEditorProvider {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly codexSessionFiles = new Map<string, CodexSessionFile | null>();
  private readonly context: vscode.ExtensionContext;
  private readonly onDidChangeCustomDocumentEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<vscode.CustomDocument>>();
  public readonly onDidChangeCustomDocument =
    this.onDidChangeCustomDocumentEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.resolveEditorCursorPlaceholder(editor);
      })
    );
    void this.resolveEditorCursorPlaceholder(vscode.window.activeTextEditor);
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
      if (message?.type === "requestGitStatus" && message?.path) {
        const status = await this.readGitStatus(String(message.path));
        webviewPanel.webview.postMessage({
          type: "gitStatus",
          cardUri: String(message?.cardUri ?? ""),
          path: String(message.path),
          status,
        });
        return;
      }
      if (message?.type === "requestCodexOutput" && message?.agentId) {
        const output = await this.readCodexOutput(String(message.agentId));
        webviewPanel.webview.postMessage({
          type: "codexOutput",
          cardUri: String(message?.cardUri ?? ""),
          agentId: String(message.agentId),
          output,
        });
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
      const cards = await this.readCards(columnUri, meta.cardPriorities);
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
    return orderColumnsByConfig(columns, boardConfig);
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
    columns: { id: string; name: string; cards: { fileName: string }[] }[],
    boardConfig: BoardConfig
  ): Promise<void> {
    const nextData = { ...boardConfig.data };
    const priorityOverrides = buildFolderCardPriorityOverrides(columns, boardConfig);

    if (columns.length === 0) {
      delete nextData.folders;
    } else {
      nextData.folders = buildFolderConfigMap(
        columns,
        boardConfig,
        priorityOverrides
      );
    }

    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized);
    }
  }

  private async readCards(
    columnUri: vscode.Uri,
    cardPriorities = new Map<string, number>()
  ): Promise<Card[]> {
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
      const { title, body, properties, tags } = parseTaskMarkdown(
        text,
        name
      );
      const propertiesWithActions = properties.map((property) => ({
        ...property,
        action: getTaskPropertyAction(property.key, property.value),
      }));
      const bodyHtml = md.render(body || "");
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        body,
        bodyHtml,
        properties: propertiesWithActions,
        tags,
        priority: cardPriorities.get(name) ?? null,
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
  ): Promise<{
    title: string;
    order: number | null;
    cardPriorities: Map<string, number>;
  }> {
    const configured = boardConfig.folderMap.get(fallbackTitle);
    if (configured) {
      return {
        title: configured.title?.trim() || fallbackTitle,
        order: configured.order,
        cardPriorities: new Map(configured.cardPriorities),
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
        cardPriorities: new Map(),
      };
    } catch {
      return { title: fallbackTitle, order: null, cardPriorities: new Map() };
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
    const sourceColumnId = path.posix.basename(sourceColumnUri.path);
    const targetCards = await this.readCards(targetColumnUri);
    const targetOrderedUris = targetCards.map((card) => card.uri);
    targetOrderedUris.unshift(newUri.toString());
    const sourceCards = await this.readCards(sourceColumnUri);
    const sourceOrderedUris = sourceCards
      .filter((card) => card.uri !== cardUriString)
      .map((card) => card.uri);
    const context = this.createEditContext();
    await this.renameFile(cardUri, newUri, context);
    await this.updateBoardCardPriorities(
      kanbanUri,
      [
        { columnId: targetColumnId, orderedUris: targetOrderedUris },
        { columnId: sourceColumnId, orderedUris: sourceOrderedUris },
      ],
      context
    );
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

    const fileUri = vscode.Uri.joinPath(columnUri, fileName);
    const templateContent = await this.readNewCardTemplate(boardFolder);
    const content = buildNewCardContent(safeTitle, templateContent);
    await this.ensureFile(fileUri);
    await this.applyContentEdit(fileUri, content);
  }

  private async readNewCardTemplate(
    boardFolder: vscode.Uri
  ): Promise<string | null> {
    const templateUri = vscode.Uri.joinPath(boardFolder, CARD_TEMPLATE_FILE_NAME);
    try {
      const stat = await vscode.workspace.fs.stat(templateUri);
      if (stat.type !== vscode.FileType.File) {
        return null;
      }
      const raw = await vscode.workspace.fs.readFile(templateUri);
      return Buffer.from(raw).toString("utf8");
    } catch {
      return null;
    }
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
    const columnUpdates: { columnId: string; orderedUris: string[] }[] = [
      { columnId: targetColumnId, orderedUris: normalizedUris },
    ];

    if (sourceColumnId && sourceColumnId !== targetColumnId && cardUriString) {
      const sourceColumnUri = vscode.Uri.joinPath(boardFolder, sourceColumnId);
      const sourceCards = await this.readCards(sourceColumnUri);
      const sourceOrderedUris = sourceCards
        .filter((card) => card.uri !== cardUriString)
        .map((card) => card.uri);
      columnUpdates.push({
        columnId: sourceColumnId,
        orderedUris: sourceOrderedUris,
      });
    }
    await this.updateBoardCardPriorities(kanbanUri, columnUpdates, context);
    await this.applyEditContext(context);
  }

  private async updateBoardCardPriorities(
    kanbanUri: vscode.Uri,
    columnUpdates: { columnId: string; orderedUris: string[] }[],
    context?: EditContext
  ): Promise<void> {
    const normalizedUpdates = new Map<string, string[]>();
    for (const update of columnUpdates) {
      const columnId = String(update?.columnId ?? "").trim();
      if (!columnId || normalizedUpdates.has(columnId)) {
        continue;
      }
      normalizedUpdates.set(
        columnId,
        Array.isArray(update?.orderedUris) ? update.orderedUris : []
      );
    }

    if (normalizedUpdates.size === 0) {
      return;
    }

    const boardConfig = await this.readBoardConfig(kanbanUri);
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
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

    const priorityOverrides = new Map<string, string[]>();
    for (const [columnId, orderedUris] of normalizedUpdates) {
      priorityOverrides.set(columnId, buildCardPriorityList(orderedUris));
    }

    const nextData = { ...boardConfig.data };
    if (columns.length === 0) {
      delete nextData.folders;
    } else {
      nextData.folders = buildFolderConfigMap(
        this.orderColumns(columns, boardConfig),
        boardConfig,
        priorityOverrides
      );
    }

    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized, context);
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
    const cwd = await this.resolvePathDirectory(rawPath);
    if (!cwd) {
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `Kanban Path ${path.basename(cwd) || cwd}`,
      cwd,
    });
    terminal.show(true);
  }

  public async openPathInCode(rawPath: string): Promise<void> {
    const cwd = await this.resolvePathDirectory(rawPath);
    if (!cwd) {
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(cwd),
      {
        forceNewWindow: true,
      }
    );
  }

  private async resolvePathDirectory(rawPath: string): Promise<string | null> {
    const targetPath = normalizeTaskPropertyValue(rawPath);
    if (!isTaskAbsoluteLocalPath(targetPath)) {
      return null;
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

    return cwd;
  }

  private async readGitStatus(rawPath: string): Promise<string | null> {
    const cwd = await this.resolvePathDirectory(rawPath);
    if (!cwd) {
      return null;
    }

    try {
      const inside = await execFileAsync(
        "git",
        ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
        {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }
      );
      if (String(inside.stdout || "").trim() !== "true") {
        return null;
      }

      const result = await execFileAsync(
        "git",
        ["-C", cwd, "status", "--short", "--branch"],
        {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }
      );
      const output = String(result.stdout || "").trim();
      return output || null;
    } catch {
      return null;
    }
  }

  private async readCodexOutput(agentId: string): Promise<string | null> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return null;
    }

    const sessionFile = await this.findCodexSessionFile(trimmed);
    if (!sessionFile) {
      return null;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(sessionFile));
      const text = Buffer.from(raw).toString("utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const outputBlocks: string[] = [];

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let entry: unknown;
        try {
          entry = JSON.parse(lines[index]);
        } catch {
          continue;
        }

        const payload = (entry as { payload?: unknown }).payload;
        if (!payload || typeof payload !== "object") {
          continue;
        }

        const payloadRecord = payload as {
          type?: string;
          role?: string;
          content?: unknown;
          message?: string;
        };

        if (payloadRecord.type === "message" && payloadRecord.role === "assistant") {
          const content = Array.isArray(payloadRecord.content)
            ? payloadRecord.content
            : [];
          const textParts = content
            .filter((item): item is { type: "output_text"; text: string } => {
              return !!item
                && typeof item === "object"
                && (item as { type?: string }).type === "output_text"
                && typeof (item as { text?: unknown }).text === "string";
            })
            .map((item) => item.text.trim())
            .filter((item) => item.length > 0);
          if (textParts.length > 0) {
            outputBlocks.push(textParts.join("\n\n"));
          }
        }

        if (payloadRecord.type === "agent_message" && typeof payloadRecord.message === "string") {
          const message = payloadRecord.message.trim();
          if (message) {
            outputBlocks.push(message);
          }
        }

        if (outputBlocks.length >= 3) {
          break;
        }
      }

      if (outputBlocks.length === 0) {
        return null;
      }

      const recentLines = outputBlocks
        .reverse()
        .join("\n\n")
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .slice(-5);

      return recentLines.length > 0 ? recentLines.join("\n") : null;
    } catch {
      return null;
    }
  }

  private async findCodexSessionFile(agentId: string): Promise<string | null> {
    const cached = this.codexSessionFiles.get(agentId);
    const now = Date.now();
    if (cached && now - cached.lastCheckedAt < DETAILS_REFRESH_INTERVAL_MS) {
      return cached.path || null;
    }
    if (cached === null) {
      return null;
    }

    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) {
      this.codexSessionFiles.set(agentId, null);
      return null;
    }

    const roots = [
      path.join(home, ".codex", "sessions"),
      path.join(home, ".codex", "archived_sessions"),
    ];

    for (const root of roots) {
      try {
        const command = `Get-ChildItem -Path '${escapePowerShellSingleQuotedString(root)}' -Recurse -File -Filter '*${agentId}*.jsonl' | Select-Object -First 1 -ExpandProperty FullName`;
        const result = await execFileAsync(
          "powershell",
          ["-NoProfile", "-Command", command],
          {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 1024 * 1024,
          }
        );
        const found = String(result.stdout || "").trim();
        if (found) {
          this.codexSessionFiles.set(agentId, {
            path: found,
            lastCheckedAt: now,
          });
          return found;
        }
      } catch {
        continue;
      }
    }

    this.codexSessionFiles.set(agentId, {
      path: "",
      lastCheckedAt: now,
    });
    return null;
  }

  private async resolveEditorCursorPlaceholder(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (!editor || !isMarkdownDocument(editor.document)) {
      return;
    }

    const fileName = path.posix.basename(editor.document.uri.path).toLowerCase();
    if (
      fileName === CARD_TEMPLATE_FILE_NAME.toLowerCase()
      || fileName === "folder.md"
    ) {
      return;
    }

    const resolved = resolveCursorPlaceholder(editor.document.getText());
    if (resolved.cursorOffset === null) {
      return;
    }

    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)
    );
    const normalized = normalizeContentForEol(
      resolved.content,
      editor.document.eol
    );
    const updated = await editor.edit(
      (editBuilder) => {
        editBuilder.replace(fullRange, normalized);
      },
      {
        undoStopBefore: false,
        undoStopAfter: false,
      }
    );
    if (!updated) {
      return;
    }

    const position = editor.document.positionAt(resolved.cursorOffset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
    await editor.document.save();
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
    const normalized = normalizeContentForEol(content, document.eol);
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    context.edit.replace(fileUri, fullRange, normalized);
    context.docs.set(fileUri.toString(), document);
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
    .board-pane {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      height: calc(100vh - 32px);
    }
    .board-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .board-search {
      flex: 1 1 280px;
      min-width: 240px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 10px 22px -18px var(--shadow);
    }
    .board-search-label {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      white-space: nowrap;
    }
    .board-search-input {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--ink);
      font: inherit;
      padding: 0;
    }
    .board-search-input::placeholder {
      color: var(--muted);
    }
    .search-meta {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .search-clear {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
    }
    .search-clear:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .search-clear:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .layout {
      display: grid;
      grid-template-columns: 2.2fr 1fr;
      gap: 16px;
      padding: 16px;
      min-height: 100vh;
    }
    .board-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding-bottom: 8px;
      padding-right: 4px;
    }
    .board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(220px, 1fr);
      gap: 16px;
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
      position: sticky;
      top: 0;
      z-index: 1;
      padding-bottom: 6px;
      background: var(--panel);
      cursor: grab;
    }
    .column-header:active {
      cursor: grabbing;
    }
    .column-header.static {
      cursor: default;
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
    .card.static {
      cursor: default;
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
    .property-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .property-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      line-height: 1.4;
    }
    .property-badge-label {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
      white-space: nowrap;
    }
    .property-badge-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .details {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 12px 24px -18px var(--shadow);
      align-self: start;
      position: sticky;
      top: 16px;
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
    .details-section-title {
      margin: 0 0 10px;
      font-size: 12px;
      font-family: var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .git-status-text {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .codex-output-text {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
      font-family: var(--display);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .drop-target {
      outline: 2px dashed var(--accent);
      outline-offset: 4px;
      background: var(--accent-soft);
    }
    .column-empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      padding: 12px;
      border-radius: 12px;
      background: var(--surface);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        height: auto;
      }
      .board-pane {
        height: auto;
      }
      .board-scroll {
        flex: none;
        min-height: 0;
      }
      .details {
        position: static;
        top: auto;
        height: auto;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="board-pane">
      <div class="board-toolbar">
        <label class="board-search" for="board-search-input">
          <span class="board-search-label">Search</span>
          <input
            class="board-search-input"
            id="board-search-input"
            type="search"
            placeholder="Search cards"
            spellcheck="false"
          />
        </label>
        <button class="search-clear" id="search-clear" type="button" hidden>Clear</button>
        <div class="search-meta" id="search-meta"></div>
      </div>
      <div class="board-scroll">
        <section class="board" id="board"></section>
      </div>
    </section>
    <aside class="details" id="details">
      <div class="empty">Select a card to view details.</div>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const boardEl = document.getElementById("board");
    const detailsEl = document.getElementById("details");
    const searchInputEl = document.getElementById("board-search-input");
    const searchMetaEl = document.getElementById("search-meta");
    const searchClearEl = document.getElementById("search-clear");
    let selectedCard = null;
    let lastBoard = null;
    let searchQuery = "";
    const gitStatusCache = new Map();
    const codexOutputCache = new Map();
    let refreshTimer = null;
    let detailsRefreshTimer = null;
    const cardDragType = "application/x-kanban-card";
    const columnDragType = "application/x-kanban-column";
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const searchShortcutLabel = isMac ? "Cmd+F" : "Ctrl+F";
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

    const getPropertyAction = (property) => {
      const action = property?.action;
      const type = String(action?.command || "").trim();
      const label = String(action?.title || "").trim();
      const value = String(action?.value || "").trim();
      if (!type || !label || !value) {
        return null;
      }
      if (type !== "resumeAgent" && type !== "openPath") {
        return null;
      }
      return { type, label, value };
    };

    const getVisibleProperties = (properties) => {
      return (properties || [])
        .filter((property) => String(property?.key || "").trim().toLowerCase() !== "tags")
        .sort((a, b) => {
          const aLabel = String(a?.label || a?.key || "").trim();
          const bLabel = String(b?.label || b?.key || "").trim();
          return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
        });
    };

    const renderProperties = (properties) => {
      const visibleProperties = getVisibleProperties(properties);
      if (!visibleProperties.length) return "";
      const rows = visibleProperties.map((property) => {
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

    const renderDetailsPlaceholder = (message) => {
      detailsEl.innerHTML = \`<div class="empty">\${escapeHtml(message)}</div>\`;
    };

    const getAgentId = (card) => {
      const agentProperty = (card?.properties || []).find((property) => {
        return String(property?.key || "").trim().toLowerCase() === "agent";
      });
      const value = String(agentProperty?.value || "").trim();
      return value || null;
    };

    const getRepoPath = (card) => {
      const repoProperty = (card?.properties || []).find((property) => {
        return String(property?.key || "").trim().toLowerCase() === "repo";
      });
      const value = String(repoProperty?.value || "").trim();
      return value || null;
    };

    const shouldRefreshCache = (entry) => {
      if (!entry) {
        return true;
      }
      const refreshedAt = Number(entry.refreshedAt || 0);
      return Date.now() - refreshedAt >= 10000;
    };

    const requestGitStatus = (card) => {
      const repoPath = getRepoPath(card);
      if (!repoPath) {
        return;
      }
      const cached = gitStatusCache.get(repoPath);
      if (cached?.state === "loading" || !shouldRefreshCache(cached)) {
        return;
      }
      gitStatusCache.set(repoPath, {
        state: "loading",
        text: cached?.text || "",
        refreshedAt: cached?.refreshedAt || 0,
      });
      vscode.postMessage({
        type: "requestGitStatus",
        cardUri: card.uri,
        path: repoPath,
      });
    };

    const requestCodexOutput = (card) => {
      const agentId = getAgentId(card);
      if (!agentId) {
        return;
      }
      const cached = codexOutputCache.get(agentId);
      if (cached?.state === "loading" || !shouldRefreshCache(cached)) {
        return;
      }
      codexOutputCache.set(agentId, {
        state: "loading",
        text: cached?.text || "",
        refreshedAt: cached?.refreshedAt || 0,
      });
      vscode.postMessage({
        type: "requestCodexOutput",
        cardUri: card.uri,
        agentId,
      });
    };

    const renderGitStatus = (card) => {
      const repoPath = getRepoPath(card);
      if (!repoPath) {
        return "";
      }
      const cached = gitStatusCache.get(repoPath);
      if (!cached) {
        requestGitStatus(card);
        return "";
      }
      if (cached.state === "loading") {
        return \`
          <hr />
          <h2 class="details-section-title">Git Status</h2>
          <pre class="git-status-text">\${escapeHtml(cached.text || "Loading...")}</pre>
        \`;
      }
      if (cached.state !== "ready" || !cached.text) {
        return "";
      }
      return \`
        <hr />
        <h2 class="details-section-title">Git Status</h2>
        <pre class="git-status-text">\${escapeHtml(cached.text)}</pre>
      \`;
    };

    const renderCodexOutput = (card) => {
      const agentId = getAgentId(card);
      if (!agentId) {
        return "";
      }
      const cached = codexOutputCache.get(agentId);
      if (!cached) {
        requestCodexOutput(card);
        return "";
      }
      if (cached.state === "loading") {
        return \`
          <hr />
          <h2 class="details-section-title">Codex Output</h2>
          <pre class="codex-output-text">\${escapeHtml(cached.text || "Loading...")}</pre>
        \`;
      }
      if (cached.state !== "ready" || !cached.text) {
        return "";
      }
      return \`
        <hr />
        <h2 class="details-section-title">Codex Output</h2>
        <pre class="codex-output-text">\${escapeHtml(cached.text)}</pre>
      \`;
    };

    const refreshDetailsData = (card) => {
      if (!card?.uri) {
        return;
      }
      requestGitStatus(card);
      requestCodexOutput(card);
    };

    const startDetailsRefresh = () => {
      if (detailsRefreshTimer) {
        return;
      }
      detailsRefreshTimer = setInterval(() => {
        if (!selectedCard) {
          return;
        }
        refreshDetailsData(selectedCard);
      }, 10000);
    };

    const renderDetails = (card) => {
      if (!card) {
        renderDetailsPlaceholder("Select a card to view details.");
        return;
      }
      selectedCard = card;
      const created = new Date(card.createdAt);
      const createdLabel = created.toLocaleString();
      const createdRelative = formatRelativeTime(created);
      const bodyHtml = card.bodyHtml || '';
      const tagsHtml = renderTags(card.tags || []);
      const propertiesHtml = renderProperties(card.properties || []);
      const gitStatusHtml = renderGitStatus(card);
      const codexOutputHtml = renderCodexOutput(card);
      const metaLine = "Created: " + createdLabel + " · " + createdRelative;
      detailsEl.innerHTML = \`
        <h1>\${escapeHtml(card.title)}</h1>
        <div class="meta">\${metaLine}</div>
        \${tagsHtml}
        \${propertiesHtml}
        <div class="details-body">
          <hr />
          <div>\${bodyHtml || '<div class="empty">No description.</div>'}</div>
          \${gitStatusHtml}
          \${codexOutputHtml}
        </div>
      \`;
      refreshDetailsData(card);
      startDetailsRefresh();
    };

    const normalizeSearchQuery = (value) => {
      return String(value ?? "").trim().toLowerCase();
    };

    const buildCardSearchText = (card) => {
      const propertiesText = getVisibleProperties(card?.properties || [])
        .map((property) => {
          const label = String(property?.label || property?.key || "").trim();
          const value = String(property?.value || "").trim();
          return label ? label + ": " + value : value;
        })
        .join("\\n");
      return [
        card?.title,
        card?.fileName,
        card?.body,
        ...(card?.tags || []),
        propertiesText,
      ]
        .join("\\n")
        .toLowerCase();
    };

    const matchesSearch = (card, query) => {
      return !query || buildCardSearchText(card).includes(query);
    };

    const countCards = (columns) => {
      return (columns || []).reduce((sum, column) => {
        return sum + (Array.isArray(column?.cards) ? column.cards.length : 0);
      }, 0);
    };

    const focusSearch = (selectAll = false) => {
      if (!searchInputEl) {
        return;
      }
      if (typeof searchInputEl.focus === "function") {
        searchInputEl.focus();
      }
      if (selectAll && typeof searchInputEl.select === "function") {
        searchInputEl.select();
      }
    };

    const updateSearchUi = (boardColumns, visibleColumns) => {
      const activeQuery = normalizeSearchQuery(searchQuery);
      const totalCards = countCards(boardColumns);
      const visibleCards = countCards(visibleColumns);
      if (searchMetaEl) {
        if (!activeQuery) {
          searchMetaEl.textContent = totalCards === 1 ? "1 card" : \`\${totalCards} cards\`;
        } else if (!visibleCards) {
          searchMetaEl.textContent = \`No cards match "\${searchQuery.trim()}".\`;
        } else {
          const matchingColumns = (visibleColumns || []).filter((column) => column.cards.length > 0).length;
          const columnLabel = matchingColumns === 1 ? "column" : "columns";
          searchMetaEl.textContent =
            \`\${visibleCards} of \${totalCards} cards shown in \${matchingColumns} \${columnLabel}. Dragging is disabled while filtering.\`;
        }
      }
      if (searchClearEl) {
        searchClearEl.hidden = !activeQuery;
      }
    };

    const getDragTypes = (event) => {
      return Array.from(event?.dataTransfer?.types || []);
    };

    const buildOrderedUris = (cards, cardUri, targetUri, position) => {
      const list = (cards || []).map((card) => card.uri).filter((uri) => uri !== cardUri);
      if (!targetUri) {
        if (position === "start") {
          list.unshift(cardUri);
        } else {
          list.push(cardUri);
        }
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

    const renderPropertyBadges = (properties) => {
      const badges = getVisibleProperties(properties)
        .map((property) => \`
          <span class="property-badge">
            <span class="property-badge-label">\${escapeHtml(property.label)}</span>
            <span class="property-badge-value">\${escapeHtml(property.value)}</span>
          </span>
        \`)
        .join("");
      return badges ? \`<div class="property-badges">\${badges}</div>\` : "";
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

    const syncDetails = () => {
      if (!selectedCard) {
        renderDetailsPlaceholder("Select a card to view details.");
        return;
      }
      const updated = findCard(lastBoard, selectedCard.uri);
      if (!updated) {
        selectedCard = null;
        renderDetailsPlaceholder("Select a card to view details.");
        return;
      }
      selectedCard = updated;
      if (!matchesSearch(updated, normalizeSearchQuery(searchQuery))) {
        renderDetailsPlaceholder("Selected card is hidden by the current search.");
        return;
      }
      renderDetails(updated);
    };

    const renderBoard = (board) => {
      boardEl.innerHTML = "";
      if (!board?.columns?.length) {
        boardEl.innerHTML = '<div class="card">No columns found. Create folders next to the .kanban file.</div>';
        updateSearchUi([], []);
        return;
      }
      const activeQuery = normalizeSearchQuery(searchQuery);
      const searchActive = Boolean(activeQuery);
      const visibleColumns = [];
      const firstColumnId = board.columns[0]?.id ?? board.columns[0]?.name;
      for (const column of board.columns) {
        const columnId = column.id ?? column.name;
        const allCards = Array.isArray(column.cards) ? column.cards : [];
        const visibleCards = searchActive
          ? allCards.filter((card) => matchesSearch(card, activeQuery))
          : allCards;
        visibleColumns.push({ id: columnId, cards: visibleCards });
        const columnEl = document.createElement("div");
        columnEl.className = "column";
        columnEl.dataset.column = columnId;
        const headerEl = document.createElement("div");
        headerEl.className = searchActive ? "column-header static" : "column-header";
        headerEl.draggable = !searchActive;
        if (!searchActive) {
          headerEl.addEventListener("dragstart", (event) => {
            draggingColumn = columnId;
            event.dataTransfer.setData(columnDragType, columnId);
            event.dataTransfer.effectAllowed = "move";
          });
          headerEl.addEventListener("dragend", () => {
            draggingColumn = null;
          });
        }
        const titleEl = document.createElement("h2");
        titleEl.textContent = searchActive
          ? \`\${column.name} (\${visibleCards.length}/\${allCards.length})\`
          : column.name;
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
        if (!searchActive) {
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
              const movePosition = sourceColumnId && sourceColumnId !== columnId ? "start" : "after";
              const orderedUris = buildOrderedUris(allCards, cardUri, null, movePosition);
              vscode.postMessage({
                type: "reorderCards",
                cardUri,
                sourceColumnId,
                targetColumnId: columnId,
                orderedUris,
              });
            }
          });
        }

        if (!visibleCards.length) {
          const emptyEl = document.createElement("div");
          emptyEl.className = "column-empty";
          emptyEl.textContent = searchActive ? "No matches in this column." : "No cards yet.";
          columnEl.appendChild(emptyEl);
        }

        for (const card of visibleCards) {
          const cardEl = document.createElement("div");
          cardEl.className = searchActive ? "card static" : "card";
          cardEl.draggable = !searchActive;
          cardEl.dataset.uri = card.uri;
          cardEl.dataset.column = columnId;
          const tagsHtml = renderTags(card.tags || []);
          const propertyBadgesHtml = renderPropertyBadges(card.properties || []);
          const created = new Date(card.createdAt);
          const createdLabel = created.toLocaleDateString();
          const createdRelative = formatRelativeTime(created);
          const metaLine = createdLabel + " · " + createdRelative;
          cardEl.innerHTML = \`
            <h3>\${escapeHtml(card.title)}</h3>
            <div class="meta">\${metaLine}</div>
            \${tagsHtml}
            \${propertyBadgesHtml}
          \`;
          cardEl.addEventListener("click", () => renderDetails(card));
          cardEl.addEventListener("dblclick", () => openCard(card));
          if (!searchActive) {
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
              const orderedUris = buildOrderedUris(allCards, cardUri, card.uri, position);
              vscode.postMessage({
                type: "reorderCards",
                cardUri,
                sourceColumnId,
                targetColumnId: columnId,
                orderedUris,
              });
            });
          }
          columnEl.appendChild(cardEl);
        }
        boardEl.appendChild(columnEl);
      }
      updateSearchUi(board.columns, visibleColumns);
    };

    const refreshBoard = () => {
      if (!lastBoard) {
        updateSearchUi([], []);
        return;
      }
      renderBoard(lastBoard);
      syncDetails();
    };

    const setSearchQuery = (value) => {
      searchQuery = String(value ?? "");
      if (searchInputEl && searchInputEl.value !== searchQuery) {
        searchInputEl.value = searchQuery;
      }
      refreshBoard();
    };

    const isEditableTarget = (target) => {
      if (!(target instanceof Element)) {
        return false;
      }
      const tagName = String(target.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select") {
        return true;
      }
      return target.getAttribute("contenteditable") === "true";
    };

    if (searchInputEl) {
      searchInputEl.placeholder = \`Search cards (\${searchShortcutLabel})\`;
      searchInputEl.addEventListener("input", () => {
        setSearchQuery(searchInputEl.value);
      });
      searchInputEl.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        if (normalizeSearchQuery(searchInputEl.value)) {
          setSearchQuery("");
          focusSearch();
          return;
        }
        if (typeof searchInputEl.blur === "function") {
          searchInputEl.blur();
        }
      });
    }

    if (searchClearEl) {
      searchClearEl.addEventListener("click", () => {
        setSearchQuery("");
        focusSearch();
      });
    }

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
      if (actionType === "resumeAgent") {
        vscode.postMessage({ type: actionType, agentId: actionValue });
        return;
      }
      if (actionType === "openPath") {
        vscode.postMessage({ type: actionType, path: actionValue });
      }
    });
    detailsEl.addEventListener("dblclick", () => openCard(selectedCard));

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "boardData") {
        lastBoard = message.board;
        refreshBoard();
        if (!refreshTimer) {
          refreshTimer = setInterval(() => {
            if (!lastBoard) return;
            refreshBoard();
          }, 60000);
        }
      }
      if (message?.type === "boardError") {
        boardEl.innerHTML = \`<div class="error">\${escapeHtml(message.message || "Failed to load board.")}</div>\`;
      }
      if (message?.type === "gitStatus") {
        const repoPath = String(message?.path || "").trim();
        if (repoPath) {
          gitStatusCache.set(repoPath, message?.status
            ? { state: "ready", text: String(message.status), refreshedAt: Date.now() }
            : { state: "missing", text: "", refreshedAt: Date.now() });
        }
        if (selectedCard && message?.cardUri === selectedCard.uri) {
          renderDetails(selectedCard);
        }
      }
      if (message?.type === "codexOutput") {
        const agentId = String(message?.agentId || "").trim();
        if (agentId) {
          codexOutputCache.set(agentId, message?.output
            ? { state: "ready", text: String(message.output), refreshedAt: Date.now() }
            : { state: "missing", text: "", refreshedAt: Date.now() });
        }
        if (selectedCard && message?.cardUri === selectedCard.uri) {
          renderDetails(selectedCard);
        }
      }
    });

    window.addEventListener("keydown", (event) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        focusSearch(true);
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
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

function buildCardPriorityList(orderedUris: string[]): string[] {
  const priorities: string[] = [];
  const seen = new Set<string>();

  for (const rawUri of orderedUris) {
    if (typeof rawUri !== "string" || !rawUri.trim()) {
      continue;
    }
    let fileName = "";
    try {
      fileName = path.posix.basename(vscode.Uri.parse(rawUri).path);
    } catch {
      fileName = "";
    }
    if (!fileName || seen.has(fileName)) {
      continue;
    }
    seen.add(fileName);
    priorities.push(fileName);
  }

  return priorities;
}

function normalizeContentForEol(
  content: string,
  eol: vscode.EndOfLine
): string {
  const newLine = eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  return content.replace(/\r?\n/g, newLine);
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
