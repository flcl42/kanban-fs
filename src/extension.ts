import * as path from "path";
import * as net from "net";
import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { promisify } from "util";
import MarkdownIt from "markdown-it";
import {
  buildFolderCardPriorityOverrides,
  buildFolderConfigMap,
  createEmptyBoardConfig,
  isIgnoredFolder,
  normalizeLineEndings,
  orderColumnsByConfig,
  parseBoardConfig,
  serializeBoardConfig,
  type BoardConfig,
} from "./board-config";
import {
  findTaskProperties,
  parseTaskMarkdown,
  type TaskProperty,
} from "./task-metadata";
import {
  findTaskLinkActions,
  getTaskPropertyActions,
  isAbsoluteLocalPath as isTaskAbsoluteLocalPath,
  isExternalUrlValue as isTaskExternalUrlValue,
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
  actions: TaskPropertyAction[];
};

type Card = {
  uri: string;
  fileName: string;
  title: string;
  searchText: string;
  properties: CardProperty[];
  tags: string[];
  priority: number | null;
  createdAt: number;
  updatedAt: number;
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

type WorkspaceMoveRequest = {
  version: number;
  command: "move";
  boardRoot: string;
  sourcePath: string;
  destinationPath: string;
  entryType: "file" | "directory";
};

type WorkspaceMoveResponse =
  | { ok: true }
  | { ok: false; error: string };

type RunnerToolStatus = {
  label: string;
  command: string;
  installed: boolean;
  version: string;
  installUrl: string;
};

type RunnerToolStatuses = Record<string, RunnerToolStatus>;

type RunnerStatusProbe = {
  port: number;
  activeAgentCount?: number;
};

type AgentKind = "claude" | "codex" | "kimi";
type WorkspaceMoveCallback = (
  root: string,
  sourcePath: string,
  destinationPath: string
) => void;

const md = new MarkdownIt({
  html: false,
  linkify: true,
});
const agentOutputMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});
const execFileAsync = promisify(execFile);
const DETAILS_REFRESH_INTERVAL_MS = 10000;

const RESUME_AGENT_COMMAND = "kanban.resumeAgent";
const OPEN_PATH_COMMAND = "kanban.openPath";
const OPEN_CODE_COMMAND = "kanban.openCode";
const OPEN_URL_COMMAND = "kanban.openUrl";
const OPEN_LOCAL_PATH_COMMAND = "kanban.openLocalPath";
const CREATE_EMPTY_BOARD_COMMAND = "kanban.createEmptyBoard";
const CREATE_BOARD_WITH_COLUMNS_COMMAND = "kanban.createBoardWithColumns";
const CREATE_BOARD_WITH_RUNNER_COMMAND = "kanban.createBoardWithRunner";
const INITIALIZE_RUNNER_COMMAND = "kanban.initializeRunner";
const KANBAN_CONFIGURATION_SECTION = "kanban";
const DETAILS_PANE_WIDTH_SETTING = "detailsPaneWidth";
const RUNNER_PANEL_ENABLED_SETTING = "runnerPanel.enabled";
const RUNNER_COMMAND_SETTING = "runner.command";
const RUNNER_ARGS_SETTING = "runner.args";
const DEFAULT_AGENT_SETTING = "defaultAgent";
const CODEX_EXECUTABLE_SETTING = "codexExecutable";
const CLAUDE_EXECUTABLE_SETTING = "claudeExecutable";
const KIMI_EXECUTABLE_SETTING = "kimiExecutable";
const DEFAULT_DETAILS_PANE_WIDTH = 360;
const MIN_DETAILS_PANE_WIDTH = 280;
const MAX_DETAILS_PANE_WIDTH = 720;
const DEFAULT_CODEX_EXECUTABLE = "codex";
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const DEFAULT_KIMI_EXECUTABLE = "kimi";
const RUNNER_STATUS_REFRESH_MS = 10_000;
const BOARD_DISK_REFRESH_MS = 10_000;
const RUNNER_STATUS_CONNECT_TIMEOUT_MS = 250;
const RUNNER_LAUNCH_GRACE_MS = 45_000;
const RUNNER_STATUS_PORT_BASE = 41_000;
const RUNNER_STATUS_PORT_RANGE = 20_000;
const RUNNER_STATUS_PORT_STEP = 997;
const RUNNER_STATUS_PORT_CANDIDATES = 32;
const RUNNER_TOOL_CHECK_TIMEOUT_MS = 5000;
const CODEX_INSTALL_URL = "https://github.com/openai/codex";
const CLAUDE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code";
const KIMI_INSTALL_URL = "https://moonshotai.github.io/kimi-code/";
const PYTHON_INSTALL_URL = "https://www.python.org/downloads/";
const KANBAN_FILE_NAME = ".kanban";
const RUNNER_SCRIPT_NAME = "runner.py";
const DEFAULT_BOARD_COLUMNS = [
  { id: "new", name: "new" },
  { id: "backlog", name: "backlog" },
  { id: "doing", name: "doing" },
  { id: "done", name: "done" },
  { id: "confirmed", name: "confirmed" },
];
const DEFAULT_RUNNER_ARGS = [
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
];
const DEFAULT_PROJECTS_MAP_TEXT = "blank = https://github.com/flcl42/blank.git\n";
const DEFAULT_TASK_TEMPLATE_TEXT = `# {{TITLE}}

Tags: 
Project: {{CURSOR}}
Model: 

## Description


`;
const DEFAULT_CONTEXT_TEXT = `# Context

- Read the task card and this file before starting.
- Keep work inside the assigned repository and task file.
- Check \`knowledge/README.md\` for shared board notes.
- Put completion notes in the task report.
`;
const DEFAULT_KNOWLEDGE_README_TEXT = `# Knowledge

Add durable board notes, links, and project references here.
`;

export function activate(context: vscode.ExtensionContext) {
  const provider = new KanbanEditorProvider(context);
  const taskActionProvider = new TaskActionEditorProvider(context);
  const workspaceMoveServer = new WorkspaceMoveServer((root, sourcePath, destinationPath) =>
    provider.notifyWorkspaceMove(root, sourcePath, destinationPath)
  );
  context.subscriptions.push(
    workspaceMoveServer,
    vscode.commands.registerCommand(RESUME_AGENT_COMMAND, async (agentId: string) =>
      provider.resumeAgent(String(agentId))
    ),
    vscode.commands.registerCommand(OPEN_PATH_COMMAND, async (targetPath: string) =>
      provider.openPathInTerminal(String(targetPath))
    ),
    vscode.commands.registerCommand(OPEN_CODE_COMMAND, async (targetPath: string) =>
      provider.openPathInCode(String(targetPath))
    ),
    vscode.commands.registerCommand(OPEN_URL_COMMAND, async (targetUrl: string) =>
      provider.openUrl(String(targetUrl))
    ),
    vscode.commands.registerCommand(OPEN_LOCAL_PATH_COMMAND, async (targetPath: string) =>
      provider.openLocalPath(String(targetPath))
    ),
    vscode.commands.registerCommand(CREATE_EMPTY_BOARD_COMMAND, async () =>
      provider.createEmptyBoard()
    ),
    vscode.commands.registerCommand(CREATE_BOARD_WITH_COLUMNS_COMMAND, async () =>
      provider.createBoardWithColumns()
    ),
    vscode.commands.registerCommand(CREATE_BOARD_WITH_RUNNER_COMMAND, async () =>
      provider.createBoardWithRunner()
    ),
    vscode.commands.registerCommand(INITIALIZE_RUNNER_COMMAND, async (target?: vscode.Uri) =>
      provider.initializeRunner(target)
    ),
    vscode.window.registerCustomEditorProvider("kanban.board", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, taskActionProvider)
  );
}

export function deactivate() {}

class WorkspaceMoveServer implements vscode.Disposable {
  private readonly servers = new Map<string, net.Server>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly onMove?: WorkspaceMoveCallback) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.syncServers();
      })
    );
    void this.syncServers();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    for (const server of this.servers.values()) {
      server.close();
    }
    this.servers.clear();
  }

  private async syncServers(): Promise<void> {
    if (process.platform !== "win32") {
      return;
    }

    const roots = new Set<string>(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => normalizeMovePath(folder.uri.fsPath))
    );
    const boardMarkers = await vscode.workspace.findFiles("**/.kanban");
    for (const marker of boardMarkers) {
      if (marker.scheme !== "file") {
        continue;
      }

      roots.add(normalizeMovePath(path.resolve(marker.fsPath, "..", "..")));
    }

    for (const [root, server] of [...this.servers.entries()]) {
      if (roots.has(root)) {
        continue;
      }

      this.servers.delete(root);
      await closeServer(server);
    }

    for (const root of roots) {
      if (this.servers.has(root)) {
        continue;
      }

      const server = net.createServer((socket) => {
        void this.handleConnection(root, socket);
      });

      try {
        await listenServer(server, getWorkspaceMovePipePath(root));
        this.servers.set(root, server);
      } catch (error) {
        await closeServer(server);
        console.error("Failed to start Kanban workspace move server", {
          root,
          error,
        });
      }
    }
  }

  private async handleConnection(root: string, socket: net.Socket): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }

      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      handled = true;
      const requestLine = buffer.slice(0, newlineIndex).trim();
      void this.respond(socket, this.processRequest(root, requestLine));
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async respond(
    socket: net.Socket,
    responsePromise: Promise<WorkspaceMoveResponse>
  ): Promise<void> {
    try {
      const response = await responsePromise;
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkspaceMoveResponse)}\n`
      );
    } finally {
      socket.end();
    }
  }

  private async processRequest(
    root: string,
    requestLine: string
  ): Promise<WorkspaceMoveResponse> {
    if (!requestLine) {
      return { ok: false, error: "Empty request." };
    }

    let request: Partial<WorkspaceMoveRequest>;
    try {
      request = JSON.parse(requestLine) as Partial<WorkspaceMoveRequest>;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid JSON.",
      };
    }

    const requestRecord = request as Record<string, unknown>;
    const readRequestString = (name: string): string =>
      String(
        requestRecord[name] ??
          requestRecord[`${name.charAt(0).toUpperCase()}${name.slice(1)}`] ??
          ""
      );

    if (readRequestString("command") !== "move") {
      return { ok: false, error: "Unsupported command." };
    }

    const boardRoot = normalizeMovePath(readRequestString("boardRoot"));
    if (boardRoot !== root) {
      return { ok: false, error: "Workspace root mismatch." };
    }

    const sourcePath = path.resolve(readRequestString("sourcePath"));
    const destinationPath = path.resolve(readRequestString("destinationPath"));
    if (!isPathInsideRoot(sourcePath, root) || !isPathInsideRoot(destinationPath, root)) {
      return {
        ok: false,
        error: "Move paths must stay inside the workspace root.",
      };
    }

    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(destinationPath))
    );

    try {
      await vscode.workspace.fs.rename(
        vscode.Uri.file(sourcePath),
        vscode.Uri.file(destinationPath),
        { overwrite: false }
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "VS Code rejected the move.",
      };
    }

    this.onMove?.(root, sourcePath, destinationPath);
    return { ok: true };
  }
}

function listenServer(server: net.Server, pipePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(pipePath);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function getWorkspaceMovePipePath(root: string): string {
  return `\\\\.\\pipe\\kanban-fs-mover-${hashWorkspaceMoveRoot(root)}`;
}

function hashWorkspaceMoveRoot(root: string): string {
  return createHash("sha256")
    .update(normalizeMovePath(root), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function getRunnerStatusPorts(root: string): number[] {
  const digest = createHash("sha256")
    .update(normalizeMovePath(root), "utf8")
    .digest();
  const seed = (digest[0] << 8) | digest[1];
  return Array.from({ length: RUNNER_STATUS_PORT_CANDIDATES }, (_, index) =>
    RUNNER_STATUS_PORT_BASE +
    ((seed + index * RUNNER_STATUS_PORT_STEP) % RUNNER_STATUS_PORT_RANGE)
  );
}

function normalizeMovePath(inputPath: string): string {
  const resolved = path.resolve(inputPath).replace(/\\/g, "/");
  const trimmed = resolved.length > 3 ? resolved.replace(/\/+$/, "") : resolved;
  return trimmed.toLowerCase();
}

function isPathInsideRoot(candidatePath: string, root: string): boolean {
  const normalizedCandidate = normalizeMovePath(candidatePath);
  const normalizedRoot = normalizeMovePath(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function getPathResolutionBases(
  fileUri: vscode.Uri,
  boardFolderUri?: vscode.Uri
): string[] {
  const bases: string[] = [];
  const addBase = (candidate: string | undefined) => {
    if (!candidate) {
      return;
    }
    const resolved = path.resolve(candidate);
    if (!bases.some((base) => normalizeMovePath(base) === normalizeMovePath(resolved))) {
      bases.push(resolved);
    }
  };

  if (fileUri.scheme === "file") {
    const fileDirectory = path.dirname(fileUri.fsPath);
    addBase(fileDirectory);
    const parent = path.dirname(fileDirectory);
    addBase(parent);
    if (path.basename(parent).toLowerCase() === "tasks") {
      addBase(path.dirname(parent));
    }
  }

  if (boardFolderUri?.scheme === "file") {
    addBase(boardFolderUri.fsPath);
    if (path.basename(boardFolderUri.fsPath).toLowerCase() === "tasks") {
      addBase(path.dirname(boardFolderUri.fsPath));
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") {
      addBase(folder.uri.fsPath);
    }
  }

  return bases;
}

function shouldProbeExistingLocalPath(key: string, value: string): boolean {
  const normalizedValue = normalizeTaskPropertyValue(value);
  if (
    !normalizedValue ||
    /[\r\n\0]/.test(normalizedValue) ||
    isTaskGuidValue(normalizedValue) ||
    isTaskExternalUrlValue(normalizedValue)
  ) {
    return false;
  }
  if (isTaskAbsoluteLocalPath(normalizedValue)) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalizedValue)) {
    return false;
  }
  if (/^\.{1,2}([\\/]|$)/.test(normalizedValue) || /[\\/]/.test(normalizedValue)) {
    return true;
  }
  if (/\.[a-z0-9]{1,16}$/i.test(path.basename(normalizedValue))) {
    return true;
  }

  return key.trim().length > 0;
}

async function resolveExistingLocalPath(
  key: string,
  value: string,
  bases: string[]
): Promise<string | null> {
  const normalizedValue = normalizeTaskPropertyValue(value);
  if (!shouldProbeExistingLocalPath(key, normalizedValue)) {
    return null;
  }

  const candidates = isTaskAbsoluteLocalPath(normalizedValue)
    ? [normalizedValue]
    : bases.map((base) => path.resolve(base, normalizedValue));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeMovePath(candidate);
    if (seen.has(normalizedCandidate)) {
      continue;
    }
    seen.add(normalizedCandidate);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      return candidate;
    } catch {
      // Only existing paths should get an Open action.
    }
  }

  return null;
}

async function getTaskPropertyActionsWithExistingLocalPath(
  key: string,
  value: string,
  bases: string[]
): Promise<TaskPropertyAction[]> {
  const actions = getTaskPropertyActions(key, value);
  const existingPath = await resolveExistingLocalPath(key, value, bases);
  if (
    existingPath &&
    !actions.some(
      (action) => action.command === "openLocalPath" && action.value === existingPath
    )
  ) {
    actions.push({
      command: "openLocalPath",
      title: "Open",
      value: existingPath,
    });
  }
  return actions;
}

async function findTaskLinkActionsWithExistingLocalPaths(
  content: string,
  bases: string[]
): Promise<TaskLinkAction[]> {
  const actions = findTaskLinkActions(content);
  const localPathActions: TaskLinkAction[] = [];
  for (const property of findTaskProperties(content)) {
    const existingPath = await resolveExistingLocalPath(
      property.key,
      property.value,
      bases
    );
    if (!existingPath) {
      continue;
    }
    localPathActions.push({
      line: property.line,
      key: property.key,
      label: property.label,
      command: "openLocalPath",
      title: "Open",
      value: existingPath,
    });
  }

  return [...actions, ...localPathActions].sort((left, right) => left.line - right.line);
}

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
    return this.getActions(document).then((actions) => actions.map((action) => {
      const line = document.lineAt(action.line);
      return new vscode.CodeLens(line.range, toTaskActionCommand(action));
    }));
  }

  private getActions(document: vscode.TextDocument): Promise<TaskLinkAction[]> {
    return findTaskLinkActionsWithExistingLocalPaths(
      document.getText(),
      getPathResolutionBases(document.uri)
    );
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
  } else if (action.command === "openUrl") {
    command = OPEN_URL_COMMAND;
  } else if (action.command === "openLocalPath") {
    command = OPEN_LOCAL_PATH_COMMAND;
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
      : action.command === "openUrl"
        ? `Open ${action.value}`
        : action.command === "openLocalPath"
          ? `Open ${action.value}`
          : `Open terminal at ${action.value}`;
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

function createDefaultBoardConfigText(): string {
  return serializeBoardConfig({
    folders: Object.fromEntries(
      DEFAULT_BOARD_COLUMNS.map((column) => [column.id, column.name])
    ),
  });
}

class KanbanEditorProvider implements vscode.CustomEditorProvider {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly boardRefreshersByRoot = new Map<string, Set<() => void>>();
  private readonly boardConfigCache = new Map<string, BoardConfig>();
  private readonly codexSessionFiles = new Map<string, CodexSessionFile | null>();
  private readonly claudeSessionFiles = new Map<string, CodexSessionFile | null>();
  private readonly kimiSessionFiles = new Map<string, CodexSessionFile | null>();
  private readonly runnerLaunches = new Map<string, number>();
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

  notifyWorkspaceMove(
    root: string,
    _sourcePath: string,
    _destinationPath: string
  ): void {
    const refreshers = this.boardRefreshersByRoot.get(normalizeMovePath(root));
    if (!refreshers) {
      return;
    }
    for (const refresh of refreshers) {
      refresh();
    }
  }

  private registerBoardRefresher(
    root: string,
    refresh: () => void
  ): vscode.Disposable {
    const normalizedRoot = normalizeMovePath(root);
    let refreshers = this.boardRefreshersByRoot.get(normalizedRoot);
    if (!refreshers) {
      refreshers = new Set();
      this.boardRefreshersByRoot.set(normalizedRoot, refreshers);
    }
    refreshers.add(refresh);
    return {
      dispose: () => {
        refreshers?.delete(refresh);
        if (refreshers?.size === 0) {
          this.boardRefreshersByRoot.delete(normalizedRoot);
        }
      },
    };
  }

  async createEmptyBoard(): Promise<void> {
    const boardFolder = await this.pickBoardFolder(
      "Select a folder for the empty AI Kanban board"
    );
    if (!boardFolder) {
      return;
    }

    const kanbanUri = vscode.Uri.joinPath(boardFolder, KANBAN_FILE_NAME);
    if (!(await this.writeBoardFileIfSafe(kanbanUri, "", false))) {
      return;
    }

    await this.openBoard(kanbanUri);
  }

  async createBoardWithColumns(): Promise<void> {
    const boardFolder = await this.pickBoardFolder(
      "Select a folder for the AI Kanban board"
    );
    if (!boardFolder) {
      return;
    }

    const kanbanUri = vscode.Uri.joinPath(boardFolder, KANBAN_FILE_NAME);
    if (
      !(await this.writeBoardFileIfSafe(
        kanbanUri,
        createDefaultBoardConfigText(),
        true
      ))
    ) {
      return;
    }

    await this.createDefaultColumnDirectories(boardFolder);
    await this.openBoard(kanbanUri);
  }

  async createBoardWithRunner(): Promise<void> {
    const rootFolder = await this.pickBoardFolder(
      "Select a root folder for the AI Kanban runner"
    );
    if (!rootFolder) {
      return;
    }

    const tasksUri = vscode.Uri.joinPath(rootFolder, "tasks");
    await vscode.workspace.fs.createDirectory(tasksUri);
    const kanbanUri = vscode.Uri.joinPath(tasksUri, KANBAN_FILE_NAME);
    if (
      !(await this.writeBoardFileIfSafe(
        kanbanUri,
        createDefaultBoardConfigText(),
        true
      ))
    ) {
      return;
    }

    await this.createDefaultColumnDirectories(tasksUri);
    const result = await this.initializeRunnerForBoard(kanbanUri);
    await this.openBoard(result.kanbanUri);
    vscode.window.showInformationMessage(
      `AI Kanban runner initialized: ${result.runnerPath}`
    );
  }

  async initializeRunner(target?: vscode.Uri): Promise<void> {
    const kanbanUri = await this.resolveRunnerInitializationTarget(target);
    if (!kanbanUri) {
      return;
    }

    const result = await this.initializeRunnerForBoard(kanbanUri);
    await this.openBoard(result.kanbanUri);
    vscode.window.showInformationMessage(
      `AI Kanban runner initialized: ${result.runnerPath}`
    );
  }

  private async resolveRunnerInitializationTarget(
    target?: vscode.Uri
  ): Promise<vscode.Uri | null> {
    const directTarget = await this.resolveKanbanUriFromTarget(target);
    if (directTarget) {
      return directTarget;
    }

    const activeTarget = await this.resolveKanbanUriFromTarget(
      vscode.window.activeTextEditor?.document.uri
    );
    if (activeTarget) {
      return activeTarget;
    }

    const boards = (await vscode.workspace.findFiles(
      `**/${KANBAN_FILE_NAME}`,
      "**/{.git,node_modules}/**"
    )).filter((uri) => uri.scheme === "file");
    if (boards.length === 1) {
      return boards[0];
    }
    if (boards.length > 1) {
      const selected = await vscode.window.showQuickPick(
        boards.map((uri) => ({
          label: vscode.workspace.asRelativePath(uri, false),
          description: uri.fsPath,
          uri,
        })),
        {
          title: "Select a board to initialize runner support",
          placeHolder: "Select .kanban",
        }
      );
      return selected?.uri ?? null;
    }

    const rootFolder = await this.pickBoardFolder(
      "Select a root folder for the AI Kanban runner"
    );
    if (!rootFolder) {
      return null;
    }
    return this.ensureRunnerBoardInRoot(rootFolder);
  }

  private async resolveKanbanUriFromTarget(
    target?: vscode.Uri
  ): Promise<vscode.Uri | null> {
    if (!target || target.scheme !== "file") {
      return null;
    }
    const targetPath = target.fsPath;
    if (path.basename(targetPath).toLowerCase() === KANBAN_FILE_NAME) {
      return target;
    }

    try {
      const stat = await vscode.workspace.fs.stat(target);
      if (stat.type !== vscode.FileType.Directory) {
        return null;
      }
    } catch {
      return null;
    }

    const rootKanbanUri = vscode.Uri.joinPath(target, KANBAN_FILE_NAME);
    if (await this.fileExists(rootKanbanUri)) {
      return rootKanbanUri;
    }
    const tasksKanbanUri = vscode.Uri.joinPath(target, "tasks", KANBAN_FILE_NAME);
    if (await this.fileExists(tasksKanbanUri)) {
      return tasksKanbanUri;
    }
    return this.ensureRunnerBoardInRoot(target);
  }

  private async ensureRunnerBoardInRoot(rootFolder: vscode.Uri): Promise<vscode.Uri> {
    const tasksUri = vscode.Uri.joinPath(rootFolder, "tasks");
    await vscode.workspace.fs.createDirectory(tasksUri);
    const kanbanUri = vscode.Uri.joinPath(tasksUri, KANBAN_FILE_NAME);
    const existing = await this.readExistingText(kanbanUri);
    if (existing === null || existing.trim().length === 0) {
      await this.writeTextFile(kanbanUri, createDefaultBoardConfigText());
    }
    await this.createDefaultColumnDirectories(tasksUri);
    return kanbanUri;
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

    webviewPanel.webview.html = this.getHtml(
      webviewPanel.webview,
      this.getDetailsPaneWidthSetting()
    );

    let scheduledBoardRefresh: NodeJS.Timeout | undefined;
    let boardRefreshQueue = Promise.resolve();
    const runBoardRefresh = async () => {
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
    const sendBoard = async () => {
      if (scheduledBoardRefresh) {
        clearTimeout(scheduledBoardRefresh);
        scheduledBoardRefresh = undefined;
      }
      boardRefreshQueue = boardRefreshQueue
        .catch(() => undefined)
        .then(runBoardRefresh);
      await boardRefreshQueue;
    };
    const scheduleBoardRefresh = () => {
      if (scheduledBoardRefresh) {
        clearTimeout(scheduledBoardRefresh);
      }
      scheduledBoardRefresh = setTimeout(() => {
        scheduledBoardRefresh = undefined;
        void sendBoard();
      }, 150);
    };
    const sendDetailsPaneWidth = () => {
      webviewPanel.webview.postMessage({
        type: "detailsPaneWidth",
        width: this.getDetailsPaneWidthSetting(),
      });
    };
    const sendRunnerStatus = async (message?: string) => {
      const status = await this.getRunnerStatus(document.uri, message);
      webviewPanel.webview.postMessage({ type: "runnerStatus", status });
    };
    let boardMutationQueue = Promise.resolve();
    const runBoardMutation = async (operation: () => Promise<void>) => {
      const nextMutation = boardMutationQueue
        .catch(() => undefined)
        .then(operation);
      boardMutationQueue = nextMutation.then(
        () => undefined,
        () => undefined
      );
      await nextMutation;
    };
    const detailsPaneWidthListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (
          event.affectsConfiguration(
            `${KANBAN_CONFIGURATION_SECTION}.${DETAILS_PANE_WIDTH_SETTING}`
          )
        ) {
          sendDetailsPaneWidth();
        }
        if (
          event.affectsConfiguration(
            `${KANBAN_CONFIGURATION_SECTION}.${RUNNER_PANEL_ENABLED_SETTING}`
          ) ||
          event.affectsConfiguration(
            `${KANBAN_CONFIGURATION_SECTION}.${RUNNER_COMMAND_SETTING}`
          ) ||
          event.affectsConfiguration(
            `${KANBAN_CONFIGURATION_SECTION}.${RUNNER_ARGS_SETTING}`
          )
        ) {
          void sendRunnerStatus();
        }
      }
    );
    const runnerStatusTimer = setInterval(() => {
      void sendRunnerStatus();
    }, RUNNER_STATUS_REFRESH_MS);
    const boardDiskRefreshTimer = setInterval(() => {
      scheduleBoardRefresh();
    }, BOARD_DISK_REFRESH_MS);
    const boardRefreshRegistration = this.registerBoardRefresher(
      this.getRunnerTokenPaths(document.uri).runnerRoot,
      scheduleBoardRefresh
    );
    webviewPanel.onDidDispose(() => {
      boardRefreshRegistration.dispose();
      detailsPaneWidthListener.dispose();
      clearInterval(runnerStatusTimer);
      clearInterval(boardDiskRefreshTimer);
      if (scheduledBoardRefresh) {
        clearTimeout(scheduledBoardRefresh);
      }
    });

    const key = document.uri.toString();
    const parentFolder = vscode.Uri.joinPath(document.uri, "..");
    const pattern = new vscode.RelativePattern(parentFolder, "**/*");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watchers.set(key, watcher);
    watcher.onDidCreate(scheduleBoardRefresh);
    watcher.onDidDelete(scheduleBoardRefresh);
    watcher.onDidChange(scheduleBoardRefresh);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "ready") {
        await sendBoard();
        sendDetailsPaneWidth();
        await sendRunnerStatus();
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
        await runBoardMutation(() => this.createCard(document.uri, columnId, title));
        await sendBoard();
        return;
      }
      if (message?.type === "undo") {
        await runBoardMutation(async () => {
          await vscode.commands.executeCommand("undo");
        });
        return;
      }
      if (message?.type === "redo") {
        await runBoardMutation(async () => {
          await vscode.commands.executeCommand("redo");
        });
        return;
      }
      if (message?.type === "reorderCards") {
        const orderedUris = Array.isArray(message?.orderedUris)
          ? message.orderedUris
          : [];
        await runBoardMutation(() =>
          this.reorderCards(
            document.uri,
            message?.cardUri,
            message?.sourceColumnId,
            message?.targetColumnId,
            orderedUris
          )
        );
        await sendBoard();
        return;
      }
      if (message?.type === "reorderColumns") {
        await runBoardMutation(() =>
          this.reorderColumns(
            document.uri,
            message?.sourceColumnId,
            message?.targetColumnId,
            message?.position
          )
        );
        await sendBoard();
        return;
      }
      if (message?.type === "renameColumn") {
        const columnId = String(message?.columnId ?? "").trim();
        if (!columnId) {
          return;
        }
        const currentTitle = String(message?.currentTitle ?? columnId).trim() || columnId;
        const title = await vscode.window.showInputBox({
          prompt: `Rename column "${currentTitle}"`,
          value: currentTitle,
          ignoreFocusOut: true,
        });
        if (title === undefined) {
          return;
        }
        await runBoardMutation(() =>
          this.renameColumnTitle(document.uri, columnId, title)
        );
        await sendBoard();
        return;
      }
      if (message?.type === "moveCard") {
        await runBoardMutation(() =>
          this.moveCard(
            document.uri,
            message.cardUri,
            message.targetColumnId ?? message.targetColumn
          )
        );
        await sendBoard();
        return;
      }
      if (message?.type === "deleteCard" && message?.cardUri) {
        const title = String(message?.title ?? "this ticket").trim() || "this ticket";
        const confirmed = await vscode.window.showWarningMessage(
          `Delete ticket "${title}"? This deletes the Markdown file.`,
          { modal: true },
          "Delete"
        );
        if (confirmed !== "Delete") {
          return;
        }
        await runBoardMutation(() => this.deleteCard(document.uri, message.cardUri));
        await sendBoard();
        return;
      }
      if (message?.type === "startRunner") {
        try {
          await this.startRunner(document.uri);
          await sendRunnerStatus(
            "Runner start requested. It runs in the background and is not tied to VS Code."
          );
          setTimeout(() => {
            void sendRunnerStatus();
          }, 2000);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error ?? "Unknown error");
          webviewPanel.webview.postMessage({
            type: "runnerStatus",
            status: {
              enabled: this.getRunnerPanelEnabledSetting(),
              running: false,
              message: `Failed to start runner: ${errorMessage}`,
            },
          });
        }
        return;
      }
      if (message?.type === "createRunner") {
        try {
          const result = await this.initializeRunnerForBoard(document.uri);
          if (result.kanbanUri.toString() !== document.uri.toString()) {
            await vscode.commands.executeCommand(
              "vscode.openWith",
              result.kanbanUri,
              "kanban.board"
            );
            webviewPanel.dispose();
            return;
          }
          await sendRunnerStatus(`Created runner script: ${result.runnerPath}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error ?? "Unknown error");
          webviewPanel.webview.postMessage({
            type: "runnerStatus",
            status: {
              enabled: this.getRunnerPanelEnabledSetting(),
              running: false,
              runnerScriptRequired: true,
              runnerScriptExists: false,
              message: `Failed to create runner: ${errorMessage}`,
            },
          });
        }
        return;
      }
      if (message?.type === "hideRunnerPanel") {
        await this.updateRunnerPanelEnabledSetting(false);
        webviewPanel.webview.postMessage({
          type: "runnerStatus",
          status: { enabled: false, running: false },
        });
        return;
      }
      if (message?.type === "openFile" && message?.cardUri) {
        const requestedCardUri = String(message.cardUri);
        const target = await this.resolveCurrentCardUri(document.uri, requestedCardUri);
        if (!target) {
          await sendBoard();
          vscode.window.showWarningMessage(
            "That ticket moved or was deleted. The board has been refreshed."
          );
          return;
        }
        if (target.toString() !== requestedCardUri) {
          await sendBoard();
        }
        await vscode.window.showTextDocument(target, { preview: true });
        return;
      }
      if (message?.type === "resumeAgent" && message?.agentId) {
        await this.resumeAgent(
          String(message.agentId),
          message?.title,
          message?.agentKind,
          message?.repoPath
        );
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
      if (message?.type === "requestAgentOutput" && message?.agentId) {
        const output = await this.readAgentOutput(
          String(message.agentId),
          message?.agentKind
        );
        webviewPanel.webview.postMessage({
          type: "agentOutput",
          cardUri: String(message?.cardUri ?? ""),
          agentId: String(message.agentId),
          agentKind: output.agentKind,
          output: output.output,
          outputHtml: output.outputHtml,
        });
        return;
      }
      if (message?.type === "requestCardDetails" && message?.cardUri) {
        const cardUri = String(message.cardUri);
        try {
          const details = await this.readCardDetails(document.uri, cardUri);
          webviewPanel.webview.postMessage({
            type: "cardDetails",
            requestedUpdatedAt: Number(message?.updatedAt),
            ...details,
          });
          if (details.currentCardUri !== cardUri) {
            scheduleBoardRefresh();
          }
        } catch {
          scheduleBoardRefresh();
          webviewPanel.webview.postMessage({
            type: "cardDetails",
            cardUri,
            currentCardUri: cardUri,
            requestedUpdatedAt: Number(message?.updatedAt),
            bodyHtml: "",
            bodyLineCount: 0,
            updatedAt: 0,
          });
        }
        return;
      }
      if (message?.type === "toggleTaskCheckbox" && message?.cardUri) {
        const cardUri = String(message.cardUri);
        const resolvedCardUri = await this.resolveCurrentCardUri(document.uri, cardUri);
        if (!resolvedCardUri) {
          await sendBoard();
          return;
        }
        await runBoardMutation(() =>
          this.updateTaskCheckbox(
            resolvedCardUri.toString(),
            Number(message?.taskIndex),
            Boolean(message?.checked)
          )
        );
        await sendBoard();
        const details = await this.readCardDetails(document.uri, cardUri);
        webviewPanel.webview.postMessage({
          type: "cardDetails",
          requestedUpdatedAt: Number(message?.updatedAt),
          ...details,
        });
        return;
      }
      if (message?.type === "saveDetailsPaneWidth") {
        await this.updateDetailsPaneWidthSetting(message?.width);
        return;
      }
      if (message?.type === "openPath" && message?.path) {
        await this.openPathInTerminal(String(message.path));
        return;
      }
      if (message?.type === "openCode" && message?.path) {
        await this.openPathInCode(String(message.path));
        return;
      }
      if (message?.type === "openLocalPath" && message?.path) {
        await this.openLocalPath(String(message.path));
        return;
      }
      if (message?.type === "openUrl" && message?.url) {
        await this.openUrl(String(message.url));
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
    const rawBoardConfig = await this.readBoardConfig(kanbanUri);
    const cachedBoardConfig = this.boardConfigCache.get(kanbanUri.toString());
    const useCachedBoardConfig = this.shouldUseCachedBoardConfig(
      rawBoardConfig,
      cachedBoardConfig
    );
    const boardConfig =
      useCachedBoardConfig && cachedBoardConfig
        ? cachedBoardConfig
        : rawBoardConfig;
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: Column[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      if (isIgnoredFolder(boardConfig, name)) {
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
    if (!this.shouldSkipBoardConfigSync(rawBoardConfig, useCachedBoardConfig)) {
      try {
        const syncedConfig = await this.syncBoardConfig(
          kanbanUri,
          orderedColumns,
          rawBoardConfig
        );
        this.boardConfigCache.set(kanbanUri.toString(), syncedConfig);
      } catch (error) {
        console.error("Failed to sync .kanban config", error);
      }
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
      return createEmptyBoardConfig("", false);
    }
  }

  private async readBoardConfigForWrite(
    kanbanUri: vscode.Uri
  ): Promise<BoardConfig | null> {
    const boardConfig = await this.readBoardConfig(kanbanUri);
    const cachedBoardConfig = this.boardConfigCache.get(kanbanUri.toString());
    if (this.shouldUseCachedBoardConfig(boardConfig, cachedBoardConfig)) {
      return cachedBoardConfig ?? null;
    }
    if (this.shouldSkipBoardConfigSync(boardConfig, false)) {
      return cachedBoardConfig ?? null;
    }
    return boardConfig;
  }

  private shouldUseCachedBoardConfig(
    boardConfig: BoardConfig,
    cachedBoardConfig: BoardConfig | undefined
  ): boolean {
    if (!cachedBoardConfig || cachedBoardConfig.folders.length === 0) {
      return false;
    }
    if (!boardConfig.valid) {
      return true;
    }
    const sourceText = boardConfig.sourceText.trim();
    return (
      boardConfig.folders.length === 0 &&
      (sourceText.length === 0 || /\bfolders\s*:/i.test(sourceText))
    );
  }

  private shouldSkipBoardConfigSync(
    boardConfig: BoardConfig,
    useCachedBoardConfig: boolean
  ): boolean {
    if (useCachedBoardConfig || !boardConfig.valid) {
      return true;
    }
    return (
      boardConfig.folders.length === 0 &&
      /\bfolders\s*:/i.test(boardConfig.sourceText)
    );
  }

  private async syncBoardConfig(
    kanbanUri: vscode.Uri,
    columns: { id: string; name: string; cards: { fileName: string }[] }[],
    boardConfig: BoardConfig
  ): Promise<BoardConfig> {
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
    const nextConfig = parseBoardConfig(serialized);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized);
    }
    return nextConfig;
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
      const actionBases = getPathResolutionBases(
        fileUri,
        vscode.Uri.joinPath(columnUri, "..")
      );
      const propertiesWithActions = await Promise.all(
        properties.map(async (property) => {
          const actions = await getTaskPropertyActionsWithExistingLocalPath(
            property.key,
            property.value,
            actionBases
          );
          return {
            ...property,
            actions,
            action: actions[0] ?? null,
          };
        })
      );
      const stat = await vscode.workspace.fs.stat(fileUri);
      cards.push({
        uri: fileUri.toString(),
        fileName: name,
        title,
        searchText: buildCardSearchText(title, name, body, tags, properties),
        properties: propertiesWithActions,
        tags,
        priority: cardPriorities.get(name) ?? null,
        createdAt: stat.ctime,
        updatedAt: stat.mtime,
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

  private async resolveCurrentCardUri(
    kanbanUri: vscode.Uri,
    cardUriString: string
  ): Promise<vscode.Uri | null> {
    let cardUri: vscode.Uri;
    try {
      cardUri = vscode.Uri.parse(cardUriString);
    } catch {
      return null;
    }

    if (cardUri.scheme !== "file") {
      return cardUri;
    }

    const existingStat = await this.statUri(cardUri);
    if (existingStat?.type === vscode.FileType.File) {
      return cardUri;
    }

    const fileName = path.basename(cardUri.fsPath);
    if (!fileName || !fileName.toLowerCase().endsWith(".md")) {
      return null;
    }
    if (fileName.toLowerCase() === "folder.md") {
      return null;
    }

    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const boardConfig = await this.readBoardConfig(kanbanUri);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(boardFolder);
    } catch {
      return null;
    }

    const matches: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory || isIgnoredFolder(boardConfig, name)) {
        continue;
      }
      const candidate = vscode.Uri.joinPath(boardFolder, name, fileName);
      const candidateStat = await this.statUri(candidate);
      if (candidateStat?.type === vscode.FileType.File) {
        matches.push(candidate);
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  private async readCardDetails(
    kanbanUri: vscode.Uri,
    cardUriString: string
  ): Promise<{
    cardUri: string;
    currentCardUri: string;
    bodyHtml: string;
    bodyLineCount: number;
    updatedAt: number;
  }> {
    const cardUri = await this.resolveCurrentCardUri(kanbanUri, cardUriString);
    if (!cardUri) {
      throw new Error("Card file no longer exists.");
    }
    if (cardUri.scheme !== "file") {
      throw new Error("Card details are only available for local file cards.");
    }

    const raw = await vscode.workspace.fs.readFile(cardUri);
    const text = Buffer.from(raw).toString("utf8");
    const { body } = parseTaskMarkdown(text, path.basename(cardUri.fsPath));
    const stat = await vscode.workspace.fs.stat(cardUri);
    const bodyLineCount = String(body || "")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0).length;
    return {
      cardUri: cardUriString,
      currentCardUri: cardUri.toString(),
      bodyHtml: renderMarkdownWithTaskLists(body || ""),
      bodyLineCount,
      updatedAt: stat.mtime,
    };
  }

  private async updateTaskCheckbox(
    cardUriString: string,
    taskIndex: number,
    checked: boolean
  ): Promise<void> {
    if (!Number.isInteger(taskIndex) || taskIndex < 0) {
      return;
    }

    const cardUri = vscode.Uri.parse(cardUriString);
    if (cardUri.scheme !== "file") {
      return;
    }

    const existing = await this.readExistingText(cardUri);
    if (existing === null) {
      return;
    }

    const lines = existing.split(/\r?\n/);
    let currentTaskIndex = 0;
    let changed = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/);
      if (!match) {
        continue;
      }
      if (currentTaskIndex === taskIndex) {
        const nextMarker = checked ? "x" : " ";
        if (match[2] !== nextMarker) {
          lines[index] = `${match[1]}${nextMarker}${match[3]}${line.slice(match[0].length)}`;
          changed = true;
        }
        break;
      }
      currentTaskIndex += 1;
    }

    if (!changed) {
      return;
    }

    await this.applyContentEdit(cardUri, lines.join("\n"));
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

  private async readOrderedCardsForColumn(
    kanbanUri: vscode.Uri,
    columnId: string,
    boardConfig: BoardConfig
  ): Promise<Card[]> {
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const columnUri = vscode.Uri.joinPath(boardFolder, columnId);
    const meta = await this.readColumnMeta(columnUri, columnId, boardConfig);
    return this.readCards(columnUri, meta.cardPriorities);
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
    const boardConfig =
      (await this.readBoardConfigForWrite(kanbanUri)) ??
      createEmptyBoardConfig("", false);
    const targetCards = await this.readOrderedCardsForColumn(
      kanbanUri,
      targetColumnId,
      boardConfig
    );
    const targetOrderedUris = targetCards.map((card) => card.uri);
    targetOrderedUris.unshift(newUri.toString());
    const sourceCards = await this.readOrderedCardsForColumn(
      kanbanUri,
      sourceColumnId,
      boardConfig
    );
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

  private async deleteCard(
    kanbanUri: vscode.Uri,
    cardUriString: string
  ): Promise<void> {
    if (!cardUriString) {
      return;
    }
    const cardUri = vscode.Uri.parse(cardUriString);
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const sourceColumnUri = vscode.Uri.joinPath(cardUri, "..");
    const sourceColumnParentUri = vscode.Uri.joinPath(sourceColumnUri, "..");
    const fileName = path.posix.basename(cardUri.path).toLowerCase();
    if (
      sourceColumnParentUri.toString() !== boardFolder.toString() ||
      !fileName.endsWith(".md") ||
      fileName === "folder.md" ||
      fileName === CARD_TEMPLATE_FILE_NAME.toLowerCase()
    ) {
      return;
    }
    const sourceColumnId = path.posix.basename(sourceColumnUri.path);
    const boardConfig =
      (await this.readBoardConfigForWrite(kanbanUri)) ??
      createEmptyBoardConfig("", false);
    const sourceCards = sourceColumnId
      ? await this.readOrderedCardsForColumn(kanbanUri, sourceColumnId, boardConfig)
      : [];
    const sourceOrderedUris = sourceCards
      .filter((card) => card.uri !== cardUriString)
      .map((card) => card.uri);

    const context = this.createEditContext();
    await this.deleteFile(cardUri, context);
    if (sourceColumnId) {
      await this.updateBoardCardPriorities(
        kanbanUri,
        [{ columnId: sourceColumnId, orderedUris: sourceOrderedUris }],
        context
      );
    }
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

    const boardConfig =
      (await this.readBoardConfigForWrite(kanbanUri)) ??
      createEmptyBoardConfig("", false);
    const existingCards = await this.readOrderedCardsForColumn(
      kanbanUri,
      columnId,
      boardConfig
    );
    const fileUri = vscode.Uri.joinPath(columnUri, fileName);
    const templateContent = await this.readNewCardTemplate(boardFolder);
    const content = buildNewCardContent(safeTitle, templateContent);
    await this.ensureFile(fileUri);
    await this.applyContentEdit(fileUri, content);
    await this.updateBoardCardPriorities(kanbanUri, [
      {
        columnId,
        orderedUris: [
          fileUri.toString(),
          ...existingCards.map((card) => card.uri),
        ],
      },
    ]);
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
    const boardConfig =
      (await this.readBoardConfigForWrite(kanbanUri)) ??
      createEmptyBoardConfig("", false);
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
      const sourceCards = await this.readOrderedCardsForColumn(
        kanbanUri,
        sourceColumnId,
        boardConfig
      );
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

    const boardConfig = await this.readBoardConfigForWrite(kanbanUri);
    if (!boardConfig) {
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
    const nextConfig = parseBoardConfig(serialized);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized, context);
    }
    this.boardConfigCache.set(kanbanUri.toString(), nextConfig);
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

  private async renameColumnTitle(
    kanbanUri: vscode.Uri,
    columnId: string,
    title: string
  ): Promise<void> {
    const trimmedColumnId = String(columnId ?? "").trim();
    if (!trimmedColumnId) {
      return;
    }
    const boardConfig = await this.readBoardConfigForWrite(kanbanUri);
    if (!boardConfig) {
      return;
    }

    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    const entries = await vscode.workspace.fs.readDirectory(boardFolder);
    const columns: { id: string; name: string; order: number | null }[] = [];
    let found = false;
    const nextTitle = title.trim() || trimmedColumnId;

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory || isIgnoredFolder(boardConfig, name)) {
        continue;
      }
      const columnUri = vscode.Uri.joinPath(boardFolder, name);
      const meta = await this.readColumnMeta(columnUri, name, boardConfig);
      if (name === trimmedColumnId) {
        found = true;
      }
      columns.push({
        id: name,
        name: name === trimmedColumnId ? nextTitle : meta.title,
        order: meta.order,
      });
    }

    if (!found) {
      return;
    }

    const nextData = { ...boardConfig.data };
    nextData.folders = buildFolderConfigMap(
      this.orderColumns(columns, boardConfig),
      boardConfig
    );
    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    const nextConfig = parseBoardConfig(serialized);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized);
    }
    this.boardConfigCache.set(kanbanUri.toString(), nextConfig);
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

  public async resumeAgent(
    agentId: string,
    ticketTitle?: unknown,
    agentKind?: unknown,
    repoPath?: unknown
  ): Promise<void> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return;
    }
    const kind =
      agentKindFromAgentId(trimmed)
      ?? normalizeAgentKindValue(agentKind)
      ?? await this.detectAgentKindFromSessions(trimmed)
      ?? await this.detectDefaultResumeAgentKind();
    const repoCwd =
      typeof repoPath === "string"
        ? await this.resolvePathDirectory(repoPath)
        : null;
    const sessionCwd =
      repoCwd
      ?? (kind === "claude"
        ? await this.readClaudeSessionCwd(trimmed)
        : kind === "kimi"
          ? await this.readKimiSessionCwd(trimmed)
        : await this.readCodexSessionCwd(trimmed));
    const terminal = vscode.window.createTerminal({
      name: formatAgentTerminalName(ticketTitle, trimmed),
      cwd: sessionCwd ?? undefined,
    });
    const executableCommand = formatTerminalExecutable(
      kind === "claude"
        ? this.getClaudeExecutableSetting()
        : kind === "kimi"
          ? this.getKimiExecutableSetting()
        : this.getCodexExecutableSetting()
    );
    terminal.show(false);
    if (kind === "claude") {
      terminal.sendText(`${executableCommand} --resume ${trimmed}`, true);
    } else if (kind === "kimi") {
      terminal.sendText(`${executableCommand} --session ${trimmed}`, true);
    } else {
      terminal.sendText(
        sessionCwd
          ? `${executableCommand} resume --cd . ${trimmed}`
          : `${executableCommand} resume ${trimmed}`,
        true
      );
    }
    await this.focusTerminal();
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
    terminal.show(false);
    await this.focusTerminal();
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

  public async openLocalPath(rawPath: string): Promise<void> {
    const targetPath = normalizeTaskPropertyValue(rawPath);
    if (!isTaskAbsoluteLocalPath(targetPath)) {
      return;
    }

    const uri = vscode.Uri.file(targetPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }

    await vscode.env.openExternal(uri);
  }

  public async openUrl(rawUrl: string): Promise<void> {
    const targetUrl = normalizeTaskPropertyValue(rawUrl);
    if (!isTaskExternalUrlValue(targetUrl)) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
  }

  private async focusTerminal(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
    } catch {
      // terminal.show(false) is enough in normal VS Code builds; this is best-effort.
    }
  }

  private getDetailsPaneWidthSetting(): number {
    const configuration = vscode.workspace.getConfiguration(
      KANBAN_CONFIGURATION_SECTION
    );
    const inspected = configuration.inspect<number>(DETAILS_PANE_WIDTH_SETTING);
    return normalizeDetailsPaneWidth(
      inspected?.globalValue ?? inspected?.defaultValue
    );
  }

  private async updateDetailsPaneWidthSetting(rawWidth: unknown): Promise<void> {
    const width = normalizeDetailsPaneWidth(rawWidth);
    await vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .update(
        DETAILS_PANE_WIDTH_SETTING,
        width,
        vscode.ConfigurationTarget.Global
      );
  }

  private async updateRunnerPanelEnabledSetting(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .update(
        RUNNER_PANEL_ENABLED_SETTING,
        enabled,
        vscode.ConfigurationTarget.Global
      );
  }

  private getRunnerPanelEnabledSetting(): boolean {
    return vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<boolean>(RUNNER_PANEL_ENABLED_SETTING, true);
  }

  private getRunnerCommandSetting(): string {
    const command = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string>(RUNNER_COMMAND_SETTING, "python")
      .trim();
    return command || "python";
  }

  private getRunnerArgsSetting(): string[] {
    const args = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string[]>(RUNNER_ARGS_SETTING, DEFAULT_RUNNER_ARGS);
    return Array.isArray(args) && args.length > 0 ? args : DEFAULT_RUNNER_ARGS;
  }

  private getCodexExecutableSetting(): string {
    const executable = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string>(CODEX_EXECUTABLE_SETTING, DEFAULT_CODEX_EXECUTABLE)
      .trim();
    return executable || DEFAULT_CODEX_EXECUTABLE;
  }

  private getClaudeExecutableSetting(): string {
    const executable = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string>(CLAUDE_EXECUTABLE_SETTING, DEFAULT_CLAUDE_EXECUTABLE)
      .trim();
    return executable || DEFAULT_CLAUDE_EXECUTABLE;
  }

  private getKimiExecutableSetting(): string {
    const executable = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string>(KIMI_EXECUTABLE_SETTING, DEFAULT_KIMI_EXECUTABLE)
      .trim();
    return executable || DEFAULT_KIMI_EXECUTABLE;
  }

  private getDefaultAgentSetting(): string {
    const value = vscode.workspace
      .getConfiguration(KANBAN_CONFIGURATION_SECTION)
      .get<string | null>(DEFAULT_AGENT_SETTING, null);
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  private getRunnerScriptRequiredSetting(): boolean {
    const command = this.getRunnerCommandSetting();
    const args = this.getRunnerArgsSetting();
    return [command, ...args].some((value) => value.includes("${runnerScript}"));
  }

  private async getRunnerToolStatuses(): Promise<RunnerToolStatuses> {
    const pythonStatus = await this.detectRunnerTool(
      "Python",
      this.getRunnerCommandSetting(),
      ["--version"],
      PYTHON_INSTALL_URL
    );
    const defaultAgent = this.getDefaultAgentSetting();
    if (defaultAgent === "claude") {
      return {
        python: pythonStatus,
        claude: await this.detectRunnerTool(
          "Claude Code",
          this.getClaudeExecutableSetting(),
          ["--version"],
          CLAUDE_INSTALL_URL
        ),
      };
    }
    if (defaultAgent === "codex") {
      return {
        python: pythonStatus,
        codex: await this.detectRunnerTool(
          "Codex CLI",
          this.getCodexExecutableSetting(),
          ["--version"],
          CODEX_INSTALL_URL
        ),
      };
    }
    if (defaultAgent === "kimi") {
      return {
        python: pythonStatus,
        kimi: await this.detectRunnerTool(
          "Kimi CLI",
          this.getKimiExecutableSetting(),
          ["--version"],
          KIMI_INSTALL_URL
        ),
      };
    }

    const [claudeStatus, codexStatus, kimiStatus] = await Promise.all([
      this.detectRunnerTool(
        "Claude Code",
        this.getClaudeExecutableSetting(),
        ["--version"],
        CLAUDE_INSTALL_URL
      ),
      this.detectRunnerTool(
        "Codex CLI",
        this.getCodexExecutableSetting(),
        ["--version"],
        CODEX_INSTALL_URL
      ),
      this.detectRunnerTool(
        "Kimi CLI",
        this.getKimiExecutableSetting(),
        ["--version"],
        KIMI_INSTALL_URL
      ),
    ]);
    return {
      python: pythonStatus,
      agent: {
        label: "Claude Code, Codex CLI, or Kimi CLI",
        command: `${claudeStatus.command} / ${codexStatus.command} / ${kimiStatus.command}`,
        installed: claudeStatus.installed || codexStatus.installed || kimiStatus.installed,
        version: claudeStatus.installed
          ? `Claude Code ${claudeStatus.version}`
          : codexStatus.installed
            ? `Codex CLI ${codexStatus.version}`
            : kimiStatus.installed
              ? `Kimi CLI ${kimiStatus.version}`
            : "",
        installUrl: CLAUDE_INSTALL_URL,
      },
    };
  }

  private async detectRunnerTool(
    label: string,
    command: string,
    args: string[],
    installUrl: string
  ): Promise<RunnerToolStatus> {
    try {
      const result = await execFileAsync(command, args, {
        windowsHide: true,
        timeout: RUNNER_TOOL_CHECK_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        shell: process.platform === "win32",
      });
      const output = String(result.stdout || result.stderr || "")
        .trim()
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "";
      return {
        label,
        command,
        installed: true,
        version: output,
        installUrl,
      };
    } catch {
      return {
        label,
        command,
        installed: false,
        version: "",
        installUrl,
      };
    }
  }

  private async getRunnerStatus(
    kanbanUri: vscode.Uri,
    message?: string
  ): Promise<{
    enabled: boolean;
    running: boolean;
    activeAgentCount?: number;
    runnerScriptRequired?: boolean;
    runnerScriptExists?: boolean;
    runnerScriptPath?: string;
    port?: number;
    requirements?: RunnerToolStatuses;
    message?: string;
  }> {
    const enabled = this.getRunnerPanelEnabledSetting();
    if (kanbanUri.scheme !== "file") {
      return {
        enabled,
        running: false,
        message: "Runner status is only available for local file boards.",
      };
    }

    const paths = this.getRunnerTokenPaths(kanbanUri);
    const runnerScriptRequired = this.getRunnerScriptRequiredSetting();
    const probe = await this.probeRunnerStatus(paths.runnerRoot);
    const requirements = enabled ? await this.getRunnerToolStatuses() : undefined;
    if (probe) {
      this.runnerLaunches.delete(normalizeMovePath(paths.runnerRoot));
      return {
        enabled,
        running: true,
        runnerScriptRequired,
        runnerScriptExists: Boolean(paths.localRunnerScript),
        runnerScriptPath: paths.localRunnerScript ?? "",
        port: probe.port,
        activeAgentCount: probe.activeAgentCount,
        requirements,
        message,
      };
    }

    const normalizedRoot = normalizeMovePath(paths.runnerRoot);
    const launchedAt = this.runnerLaunches.get(normalizedRoot);
    if (launchedAt && Date.now() - launchedAt <= RUNNER_LAUNCH_GRACE_MS) {
      return {
        enabled,
        running: true,
        runnerScriptRequired,
        runnerScriptExists: Boolean(paths.localRunnerScript),
        runnerScriptPath: paths.localRunnerScript ?? "",
        requirements,
        message:
          message ??
          "Runner start requested. Waiting for its local status endpoint.",
      };
    }

    if (launchedAt) {
      this.runnerLaunches.delete(normalizedRoot);
    }
    return {
      enabled,
      running: false,
      runnerScriptRequired,
      runnerScriptExists: Boolean(paths.localRunnerScript),
      runnerScriptPath: paths.localRunnerScript ?? "",
      requirements,
      message,
    };
  }

  private async startRunner(kanbanUri: vscode.Uri): Promise<void> {
    if (kanbanUri.scheme !== "file") {
      throw new Error("Runner startup is only supported for local file boards.");
    }

    const paths = this.getRunnerTokenPaths(kanbanUri);
    if (this.getRunnerScriptRequiredSetting() && !paths.localRunnerScript) {
      throw new Error("Create a local runner script before starting this board.");
    }
    const command = this.expandRunnerTokens(
      this.getRunnerCommandSetting(),
      paths
    );
    const args = this.getRunnerArgsSetting().map((arg) =>
      this.expandRunnerTokens(arg, paths)
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: paths.runnerRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve();
        }
      });
    });
    this.runnerLaunches.set(normalizeMovePath(paths.runnerRoot), Date.now());
  }

  private async pickBoardFolder(title: string): Promise<vscode.Uri | null> {
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const folders = await vscode.window.showOpenDialog({
      title,
      openLabel: "Use Folder",
      defaultUri,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    return folders?.[0] ?? null;
  }

  private async writeBoardFileIfSafe(
    kanbanUri: vscode.Uri,
    content: string,
    allowEmptyOverwrite: boolean
  ): Promise<boolean> {
    const existing = await this.readExistingText(kanbanUri);
    if (existing !== null) {
      if (allowEmptyOverwrite && existing.trim().length === 0) {
        await this.writeTextFile(kanbanUri, content);
        return true;
      }

      const choice = await vscode.window.showWarningMessage(
        `${kanbanUri.fsPath} already exists.`,
        "Open Existing",
        "Cancel"
      );
      if (choice === "Open Existing") {
        await this.openBoard(kanbanUri);
      }
      return false;
    }

    await this.writeTextFile(kanbanUri, content);
    return true;
  }

  private async readExistingText(uri: vscode.Uri): Promise<string | null> {
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(content).toString("utf8");
    } catch {
      return null;
    }
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    return Boolean(await this.statUri(uri));
  }

  private async statUri(uri: vscode.Uri): Promise<vscode.FileStat | null> {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch {
      return null;
    }
  }

  private async writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  private async createDefaultColumnDirectories(boardFolder: vscode.Uri): Promise<void> {
    for (const column of DEFAULT_BOARD_COLUMNS) {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(boardFolder, column.id)
      );
    }
  }

  private async openBoard(kanbanUri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand("vscode.openWith", kanbanUri, "kanban.board");
  }

  private getRunnerTokenPaths(kanbanUri: vscode.Uri): {
    kanbanDir: string;
    runnerRoot: string;
    localRunnerScript: string | null;
    runnerScript: string;
    workspaceFolder: string;
    defaultAgent: string;
    codexExecutable: string;
    claudeExecutable: string;
    kimiExecutable: string;
  } {
    const kanbanDir = path.dirname(kanbanUri.fsPath);
    const runnerRoot =
      path.basename(kanbanDir).toLowerCase() === "tasks"
        ? path.dirname(kanbanDir)
        : kanbanDir;
    const workspaceFolder =
      vscode.workspace.getWorkspaceFolder(kanbanUri)?.uri.fsPath ?? runnerRoot;
    const localRunnerScript = this.resolveLocalRunnerScriptPath(
      runnerRoot,
      kanbanDir,
      workspaceFolder
    );
    const bundledRunnerScript = this.context.asAbsolutePath(RUNNER_SCRIPT_NAME);
    const runnerScript = localRunnerScript ?? bundledRunnerScript;
    return {
      kanbanDir,
      runnerRoot,
      localRunnerScript,
      runnerScript,
      workspaceFolder,
      defaultAgent: this.getDefaultAgentSetting(),
      codexExecutable: this.getCodexExecutableSetting(),
      claudeExecutable: this.getClaudeExecutableSetting(),
      kimiExecutable: this.getKimiExecutableSetting(),
    };
  }

  private async initializeRunnerForBoard(
    kanbanUri: vscode.Uri
  ): Promise<{ runnerPath: string; kanbanUri: vscode.Uri }> {
    if (kanbanUri.scheme !== "file") {
      throw new Error("Runner creation is only supported for local file boards.");
    }

    const paths = this.getRunnerTokenPaths(kanbanUri);
    if (paths.kanbanDir === paths.runnerRoot) {
      await this.ensureRootRunnerIgnoredFolders(kanbanUri);
    }
    const runnerRootUri = vscode.Uri.file(paths.runnerRoot);
    await this.ensureRunnerSupportFiles(runnerRootUri);
    await this.ensureTaskTemplateFile(kanbanUri);
    const destination = path.join(paths.runnerRoot, RUNNER_SCRIPT_NAME);
    if (existsSync(destination)) {
      return { runnerPath: destination, kanbanUri };
    }

    const source = this.context.asAbsolutePath(RUNNER_SCRIPT_NAME);
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(source));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(destination), content);
    return { runnerPath: destination, kanbanUri };
  }

  private async ensureTaskTemplateFile(kanbanUri: vscode.Uri): Promise<void> {
    const boardFolder = vscode.Uri.joinPath(kanbanUri, "..");
    await this.writeTextFileIfMissingOrEmpty(
      vscode.Uri.joinPath(boardFolder, CARD_TEMPLATE_FILE_NAME),
      DEFAULT_TASK_TEMPLATE_TEXT
    );
  }

  private async ensureRunnerSupportFiles(runnerRootUri: vscode.Uri): Promise<void> {
    await this.writeTextFileIfMissingOrEmpty(
      vscode.Uri.joinPath(runnerRootUri, "projects.md"),
      DEFAULT_PROJECTS_MAP_TEXT
    );
    await this.writeTextFileIfMissingOrEmpty(
      vscode.Uri.joinPath(runnerRootUri, "context.md"),
      DEFAULT_CONTEXT_TEXT
    );
    const knowledgeUri = vscode.Uri.joinPath(runnerRootUri, "knowledge");
    await vscode.workspace.fs.createDirectory(knowledgeUri);
    await this.writeTextFileIfMissingOrEmpty(
      vscode.Uri.joinPath(knowledgeUri, "README.md"),
      DEFAULT_KNOWLEDGE_README_TEXT
    );
  }

  private async writeTextFileIfMissingOrEmpty(
    uri: vscode.Uri,
    content: string
  ): Promise<void> {
    const existing = await this.readExistingText(uri);
    if (existing !== null && existing.trim().length > 0) {
      return;
    }
    await this.writeTextFile(uri, content);
  }

  private async ensureRootRunnerIgnoredFolders(kanbanUri: vscode.Uri): Promise<void> {
    const boardConfig = await this.readBoardConfig(kanbanUri);
    if (!boardConfig.valid) {
      return;
    }
    const runnerFolders = ["projects", "cache", "trash", "logs"];
    const missingFolders = runnerFolders.filter(
      (folder) => !boardConfig.ignoredFolders.has(folder)
    );
    if (missingFolders.length === 0) {
      return;
    }

    const existingIgnoredFolders = readStringList(boardConfig.data.ignoreFolders);
    const nextData = {
      ...boardConfig.data,
      ignoreFolders: [...existingIgnoredFolders, ...missingFolders],
    };
    const serialized = serializeBoardConfig(nextData, boardConfig.sourceText);
    if (
      normalizeLineEndings(serialized) !==
      normalizeLineEndings(boardConfig.sourceText)
    ) {
      await this.applyContentEdit(kanbanUri, serialized);
    }
  }

  private async probeRunnerStatus(
    runnerRoot: string
  ): Promise<RunnerStatusProbe | null> {
    const normalizedRoot = normalizeMovePath(runnerRoot);
    for (const port of getRunnerStatusPorts(runnerRoot)) {
      const found = await this.probeRunnerStatusPort(port, normalizedRoot);
      if (found) {
        return { port, ...found };
      }
    }
    return null;
  }

  private async probeRunnerStatusPort(
    port: number,
    normalizedRoot: string
  ): Promise<Omit<RunnerStatusProbe, "port"> | null> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let buffer = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (status: Omit<RunnerStatusProbe, "port"> | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.destroy();
        resolve(status);
      };
      const parseStatus = () => {
        const line = buffer.trim().split(/\r?\n/)[0];
        if (!line) {
          return null;
        }
        try {
          const payload = JSON.parse(line);
          const kind = String(payload.Kind ?? payload.kind ?? "");
          const payloadRoot = String(
            payload.NormalizedRootPath ?? payload.normalizedRootPath ?? ""
          );
          if (kind !== "kanban-runner-status" || payloadRoot !== normalizedRoot) {
            return null;
          }

          const rawActiveCount =
            payload.ActiveAgentCount ?? payload.activeAgentCount;
          const activeAgentCount = Number(rawActiveCount);
          return {
            activeAgentCount:
              Number.isFinite(activeAgentCount) && activeAgentCount >= 0
                ? Math.floor(activeAgentCount)
                : undefined,
          };
        } catch {
          return null;
        }
      };
      timer = setTimeout(() => finish(null), RUNNER_STATUS_CONNECT_TIMEOUT_MS);
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          finish(parseStatus());
        }
      });
      socket.on("error", () => finish(null));
      socket.on("end", () => finish(parseStatus()));
      socket.on("close", () => finish(parseStatus()));
    });
  }

  private resolveLocalRunnerScriptPath(
    runnerRoot: string,
    kanbanDir: string,
    workspaceFolder: string
  ): string | null {
    const candidates = [
      path.join(runnerRoot, RUNNER_SCRIPT_NAME),
      path.join(kanbanDir, RUNNER_SCRIPT_NAME),
      path.join(workspaceFolder, RUNNER_SCRIPT_NAME),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  private expandRunnerTokens(
    value: string,
    paths: {
      kanbanDir: string;
      runnerRoot: string;
      runnerScript: string;
      workspaceFolder: string;
      defaultAgent: string;
      codexExecutable: string;
      claudeExecutable: string;
      kimiExecutable: string;
    }
  ): string {
    return value
      .replace(/\$\{kanbanDir\}/g, paths.kanbanDir)
      .replace(/\$\{runnerRoot\}/g, paths.runnerRoot)
      .replace(/\$\{runnerScript\}/g, paths.runnerScript)
      .replace(/\$\{workspaceFolder\}/g, paths.workspaceFolder)
      .replace(/\$\{defaultAgent\}/g, paths.defaultAgent)
      .replace(/\$\{codexExecutable\}/g, paths.codexExecutable)
      .replace(/\$\{claudeExecutable\}/g, paths.claudeExecutable)
      .replace(/\$\{kimiExecutable\}/g, paths.kimiExecutable);
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

  private async readAgentOutput(
    agentId: string,
    agentKind: unknown
  ): Promise<{
    agentKind: AgentKind | null;
    output: string | null;
    outputHtml: string | null;
  }> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return { agentKind: null, output: null, outputHtml: null };
    }

    const buildResult = async (
      selectedKind: AgentKind,
      outputPromise: Promise<string | null>
    ) => {
      const output = await outputPromise;
      return {
        agentKind: selectedKind,
        output,
        outputHtml: output ? renderAgentOutputMarkdown(output) : null,
      };
    };

    const inferredKind = agentKindFromAgentId(trimmed);
    if (inferredKind === "claude") {
      return buildResult("claude", this.readClaudeOutput(trimmed));
    }
    if (inferredKind === "codex") {
      return buildResult("codex", this.readCodexOutput(trimmed));
    }
    if (inferredKind === "kimi") {
      return buildResult("kimi", this.readKimiOutput(trimmed));
    }

    const requestedKind = normalizeAgentKindValue(agentKind);
    if (requestedKind === "claude") {
      return buildResult("claude", this.readClaudeOutput(trimmed));
    }
    if (requestedKind === "codex") {
      return buildResult("codex", this.readCodexOutput(trimmed));
    }
    if (requestedKind === "kimi") {
      return buildResult("kimi", this.readKimiOutput(trimmed));
    }

    if (await this.findClaudeSessionFile(trimmed)) {
      return buildResult("claude", this.readClaudeOutput(trimmed));
    }
    if (await this.findCodexSessionFile(trimmed)) {
      return buildResult("codex", this.readCodexOutput(trimmed));
    }
    if (await this.findKimiSessionFile(trimmed)) {
      return buildResult("kimi", this.readKimiOutput(trimmed));
    }

    const defaultKind = await this.detectDefaultResumeAgentKind();
    return buildResult(
      defaultKind,
      defaultKind === "claude"
        ? this.readClaudeOutput(trimmed)
        : defaultKind === "kimi"
          ? this.readKimiOutput(trimmed)
        : this.readCodexOutput(trimmed)
    );
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

      return formatRecentAgentOutputBlocks(outputBlocks);
    } catch {
      return null;
    }
  }

  private async readClaudeOutput(agentId: string): Promise<string | null> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return null;
    }

    const sessionFile = await this.findClaudeSessionFile(trimmed);
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

        const text = extractClaudeRecordText(entry);
        if (text) {
          outputBlocks.push(text);
        }

        if (outputBlocks.length >= 3) {
          break;
        }
      }

      if (outputBlocks.length === 0) {
        return null;
      }

      return formatRecentAgentOutputBlocks(outputBlocks);
    } catch {
      return null;
    }
  }

  private async readKimiOutput(agentId: string): Promise<string | null> {
    const trimmed = normalizeTaskPropertyValue(agentId);
    if (!isTaskGuidValue(trimmed)) {
      return null;
    }

    const sessionFile = await this.findKimiSessionFile(trimmed);
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

        const text = extractKimiRecordText(entry);
        if (text) {
          outputBlocks.push(text);
        }

        if (outputBlocks.length >= 3) {
          break;
        }
      }

      if (outputBlocks.length === 0) {
        return null;
      }

      return formatRecentAgentOutputBlocks(outputBlocks);
    } catch {
      return null;
    }
  }

  private async readCodexSessionCwd(agentId: string): Promise<string | null> {
    const sessionFile = await this.findCodexSessionFile(agentId);
    if (!sessionFile) {
      return null;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(sessionFile));
      const text = Buffer.from(raw).toString("utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

      for (const line of lines) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const record = entry as { type?: string; payload?: unknown };
        if (record.type !== "session_meta") {
          continue;
        }

        const payload = record.payload as { cwd?: unknown } | undefined;
        const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
        if (!cwd) {
          return null;
        }

        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(cwd));
        return stat.type === vscode.FileType.Directory ? cwd : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async readClaudeSessionCwd(agentId: string): Promise<string | null> {
    const sessionFile = await this.findClaudeSessionFile(agentId);
    if (!sessionFile) {
      return null;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(sessionFile));
      const text = Buffer.from(raw).toString("utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

      for (const line of lines) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const cwd = findNestedString(entry, "cwd") ?? findNestedString(entry, "project");
        if (!cwd) {
          continue;
        }

        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(cwd));
        return stat.type === vscode.FileType.Directory ? cwd : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async readKimiSessionCwd(agentId: string): Promise<string | null> {
    const sessionFile = await this.findKimiSessionFile(agentId);
    if (!sessionFile) {
      return null;
    }

    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) {
      return null;
    }

    const indexPath = path.join(home, ".kimi-code", "session_index.jsonl");
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(indexPath));
      const lines = Buffer.from(raw).toString("utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as { sessionId?: unknown; workDir?: unknown };
        if (
          record.sessionId === agentId
          && typeof record.workDir === "string"
          && record.workDir.trim()
        ) {
          return record.workDir.trim();
        }
      }
    } catch {
      // fall through to the session directory below.
    }

    return path.dirname(path.dirname(path.dirname(sessionFile)));
  }

  private async detectAgentKindFromSessions(
    agentId: string
  ): Promise<AgentKind | null> {
    if (await this.findClaudeSessionFile(agentId)) {
      return "claude";
    }
    if (await this.findCodexSessionFile(agentId)) {
      return "codex";
    }
    if (await this.findKimiSessionFile(agentId)) {
      return "kimi";
    }
    return null;
  }

  private async detectDefaultResumeAgentKind(): Promise<AgentKind> {
    const configured = normalizeAgentKindValue(this.getDefaultAgentSetting());
    if (configured) {
      return configured;
    }
    const [claude, codex, kimi] = await Promise.all([
      this.canExecuteTool(this.getClaudeExecutableSetting()),
      this.canExecuteTool(this.getCodexExecutableSetting()),
      this.canExecuteTool(this.getKimiExecutableSetting()),
    ]);
    if (claude || (!codex && !kimi)) {
      return "claude";
    }
    if (codex || !kimi) {
      return "codex";
    }
    return "kimi";
  }

  private async canExecuteTool(executable: string): Promise<boolean> {
    try {
      await execFileAsync(executable, ["--version"], {
        windowsHide: true,
        timeout: RUNNER_TOOL_CHECK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return true;
    } catch {
      return false;
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

  private async findClaudeSessionFile(agentId: string): Promise<string | null> {
    const cached = this.claudeSessionFiles.get(agentId);
    const now = Date.now();
    if (cached && now - cached.lastCheckedAt < DETAILS_REFRESH_INTERVAL_MS) {
      return cached.path || null;
    }
    if (cached === null) {
      return null;
    }

    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) {
      this.claudeSessionFiles.set(agentId, null);
      return null;
    }

    const root = path.join(home, ".claude", "projects");
    try {
      const command = `Get-ChildItem -Path '${escapePowerShellSingleQuotedString(root)}' -Recurse -File -Filter '${agentId}.jsonl' | Select-Object -First 1 -ExpandProperty FullName`;
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
        this.claudeSessionFiles.set(agentId, {
          path: found,
          lastCheckedAt: now,
        });
        return found;
      }
    } catch {
      // fall through to the cached miss below
    }

    this.claudeSessionFiles.set(agentId, {
      path: "",
      lastCheckedAt: now,
    });
    return null;
  }

  private async findKimiSessionFile(agentId: string): Promise<string | null> {
    const cached = this.kimiSessionFiles.get(agentId);
    const now = Date.now();
    if (cached && now - cached.lastCheckedAt < DETAILS_REFRESH_INTERVAL_MS) {
      return cached.path || null;
    }
    if (cached === null) {
      return null;
    }

    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) {
      this.kimiSessionFiles.set(agentId, null);
      return null;
    }

    const indexPath = path.join(home, ".kimi-code", "session_index.jsonl");
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(indexPath));
      const lines = Buffer.from(raw).toString("utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as { sessionId?: unknown; sessionDir?: unknown };
        if (record.sessionId === agentId && typeof record.sessionDir === "string") {
          const wirePath = path.join(
            record.sessionDir,
            "agents",
            "main",
            "wire.jsonl"
          );
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(wirePath));
            this.kimiSessionFiles.set(agentId, {
              path: wirePath,
              lastCheckedAt: now,
            });
            return wirePath;
          } catch {
            // fall through to recursive search.
          }
        }
      }
    } catch {
      // fall through to recursive search.
    }

    const root = path.join(home, ".kimi-code", "sessions");
    try {
      const command = `Get-ChildItem -Path '${escapePowerShellSingleQuotedString(root)}' -Recurse -File -Filter 'wire.jsonl' | Where-Object { $_.FullName -like '*${agentId}*' } | Select-Object -First 1 -ExpandProperty FullName`;
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
        this.kimiSessionFiles.set(agentId, {
          path: found,
          lastCheckedAt: now,
        });
        return found;
      }
    } catch {
      // fall through to the cached miss below
    }

    this.kimiSessionFiles.set(agentId, {
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
    _context?: EditContext
  ): Promise<void> {
    if (oldUri.toString() === newUri.toString()) {
      return;
    }
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
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

  private async deleteFile(
    fileUri: vscode.Uri,
    context?: EditContext
  ): Promise<void> {
    if (context) {
      context.edit.deleteFile(fileUri, { ignoreIfNotExists: true });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(fileUri, { ignoreIfNotExists: true });
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

  private getHtml(
    webview: vscode.Webview,
    detailsPaneWidth: number
  ): string {
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
      --details-pane-width: ${detailsPaneWidth}px;
      --details-pane-min-width: ${MIN_DETAILS_PANE_WIDTH}px;
      --details-pane-max-width: ${MAX_DETAILS_PANE_WIDTH}px;
      --details-resizer-width: 10px;
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
    .board-tag-filter {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 10px 22px -18px var(--shadow);
    }
    .board-tag-filter-label {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      white-space: nowrap;
    }
    .board-tag-filter-select {
      min-width: 150px;
      border: 1px solid transparent;
      border-radius: 8px;
      outline: none;
      background: var(--vscode-dropdown-background, var(--panel));
      color: var(--vscode-dropdown-foreground, var(--ink));
      font: inherit;
      padding: 2px 24px 2px 6px;
    }
    .board-tag-filter-select option {
      background: var(--vscode-dropdown-background, var(--panel));
      color: var(--vscode-dropdown-foreground, var(--ink));
    }
    .board-tag-filter-select:focus {
      border-color: var(--vscode-focusBorder, var(--accent));
    }
    .board-agent-count {
      display: inline-flex;
      align-items: center;
      min-height: 38px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .board-agent-count[hidden] {
      display: none;
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
    .runner-panel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--line));
      border-radius: 14px;
      background: var(--vscode-inputValidation-warningBackground, var(--panel));
      color: var(--vscode-inputValidation-warningForeground, var(--ink));
      box-shadow: 0 10px 22px -18px var(--shadow);
    }
    .runner-panel[hidden] {
      display: none;
    }
    .runner-panel-title {
      margin: 0 0 3px;
      font-weight: 700;
    }
    .runner-panel-text {
      margin: 0;
      color: var(--muted);
      line-height: 1.4;
    }
    .runner-panel-message {
      margin-top: 4px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
    }
    .runner-requirements {
      display: grid;
      gap: 6px;
      margin-top: 10px;
    }
    .runner-requirement {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      font-family: var(--mono);
      font-size: 11px;
    }
    .runner-requirement-status {
      color: var(--muted);
    }
    .runner-requirement.missing .runner-requirement-status {
      color: var(--vscode-inputValidation-errorForeground, var(--ink));
    }
    .runner-requirement.ok .runner-requirement-status {
      color: var(--vscode-testing-iconPassed, var(--accent));
    }
    .runner-panel button {
      flex: 0 0 auto;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 999px;
      background: var(--vscode-button-background, var(--accent));
      color: var(--vscode-button-foreground, var(--ink));
      cursor: pointer;
      font-family: var(--mono);
      font-size: 11px;
      padding: 7px 12px;
      white-space: nowrap;
    }
    .runner-panel button:hover {
      background: var(--vscode-button-hoverBackground, var(--accent));
    }
    .runner-panel button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .runner-panel-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .runner-hide-default {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      white-space: nowrap;
    }
    .runner-hide-default input {
      margin: 0;
    }
    .layout {
      display: grid;
      grid-template-columns:
        minmax(0, 1fr)
        var(--details-resizer-width)
        minmax(var(--details-pane-min-width), var(--details-pane-width));
      gap: 16px;
      padding: 16px;
      min-height: 100vh;
    }
    .layout.resizing {
      user-select: none;
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
    .column-title {
      cursor: text;
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
    .card-title-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
    }
    .card h3 {
      margin: 0;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
    }
    .card-bump {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      width: 24px;
      height: 24px;
      border-radius: 999px;
      cursor: pointer;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1;
      padding: 0;
    }
    .card-bump:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .card-bump:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .card-bump:disabled {
      cursor: default;
      opacity: 0.45;
      border-color: var(--line);
      background: var(--panel);
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
    .details-resizer {
      position: relative;
      cursor: col-resize;
      user-select: none;
      touch-action: none;
    }
    .details-resizer::before {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc(50% - 1px);
      width: 2px;
      border-radius: 999px;
      background: var(--line);
      transition: background 0.12s ease;
    }
    .details-resizer:hover::before,
    .details-resizer.active::before {
      background: var(--accent);
    }
    .details-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .details-title {
      min-width: 0;
      flex: 1;
    }
    .details h1 {
      margin: 0;
      font-size: 22px;
    }
    .details-delete {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
      color: var(--vscode-errorForeground, #f14c4c);
      cursor: pointer;
      padding: 0;
    }
    .details-delete:hover {
      border-color: var(--vscode-errorForeground, #f14c4c);
      background: var(--vscode-inputValidation-errorBackground, var(--surface));
    }
    .details-delete:focus {
      outline: 2px solid var(--vscode-errorForeground, #f14c4c);
      outline-offset: 2px;
    }
    .details-delete svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
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
    .property-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .property-action {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background, var(--accent));
      color: var(--vscode-button-foreground, #ffffff);
      font-family: var(--mono);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
    }
    .property-action:hover {
      background: var(--vscode-button-hoverBackground, var(--accent));
    }
    .property-action:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .details-body {
      margin-top: 18px;
    }
    .description-frame {
      position: relative;
    }
    .description-frame p,
    .description-frame ul,
    .description-frame ol,
    .description-frame blockquote,
    .description-frame pre {
      margin: 0 0 10px;
    }
    .description-frame ul,
    .description-frame ol {
      padding-left: 22px;
    }
    .description-frame li {
      margin: 4px 0;
    }
    .description-frame code {
      font-family: var(--mono);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .description-frame pre {
      overflow: auto;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .description-frame pre code {
      border: 0;
      padding: 0;
      background: transparent;
    }
    .task-list-checkbox {
      margin: 0 6px 0 0;
      vertical-align: -2px;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .description-frame.collapsed {
      max-height: 40rem;
      overflow: hidden;
    }
    .description-frame.collapsed::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4rem;
      background: linear-gradient(to bottom, transparent, var(--panel));
      pointer-events: none;
    }
    .description-expand {
      margin-top: 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, var(--surface));
      color: var(--vscode-button-secondaryForeground, var(--ink));
      font-family: var(--mono);
      font-size: 11px;
      padding: 6px 12px;
      border-radius: 999px;
      cursor: pointer;
    }
    .description-expand:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--accent-soft));
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
    .git-status-text + .details-section-title {
      margin-top: 18px;
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
      word-break: break-word;
    }
    .codex-output-text p,
    .codex-output-text ul,
    .codex-output-text ol,
    .codex-output-text blockquote,
    .codex-output-text pre {
      margin: 0 0 10px;
    }
    .codex-output-text > :last-child {
      margin-bottom: 0;
    }
    .codex-output-text ul,
    .codex-output-text ol {
      padding-left: 22px;
    }
    .codex-output-text li {
      margin: 4px 0;
    }
    .codex-output-text blockquote {
      border-left: 3px solid var(--accent);
      color: var(--muted);
      padding-left: 10px;
    }
    .codex-output-text code {
      font-family: var(--mono);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .codex-output-text pre {
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .codex-output-text pre code {
      border: 0;
      padding: 0;
      background: transparent;
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
      .details-resizer {
        display: none;
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
  <div class="layout" id="layout">
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
        <label class="board-tag-filter" for="board-tag-filter">
          <span class="board-tag-filter-label">Tag</span>
          <select class="board-tag-filter-select" id="board-tag-filter">
            <option value="">All tags</option>
          </select>
        </label>
        <div class="board-agent-count" id="board-agent-count" title="Active agents" hidden></div>
        <button class="search-clear" id="search-clear" type="button" hidden>Clear</button>
        <div class="search-meta" id="search-meta"></div>
      </div>
      <div class="runner-panel" id="runner-panel" hidden></div>
      <div class="board-scroll">
        <section class="board" id="board"></section>
      </div>
    </section>
    <div class="details-resizer" id="details-resizer" aria-hidden="true"></div>
    <aside class="details" id="details">
      <div class="empty">Select a card to view details.</div>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const boardEl = document.getElementById("board");
    const layoutEl = document.getElementById("layout");
    const detailsEl = document.getElementById("details");
    const detailsResizerEl = document.getElementById("details-resizer");
    const searchInputEl = document.getElementById("board-search-input");
    const tagFilterEl = document.getElementById("board-tag-filter");
    const searchMetaEl = document.getElementById("search-meta");
    const searchClearEl = document.getElementById("search-clear");
    const agentCountEl = document.getElementById("board-agent-count");
    const runnerPanelEl = document.getElementById("runner-panel");
    const rootStyle = document.documentElement?.style || null;
    let selectedCard = null;
    let lastBoard = null;
    let searchQuery = "";
    let selectedTagFilter = "";
    let runnerStatus = { enabled: false, running: false };
    let runnerStartPending = false;
    let runnerCreatePending = false;
    let runnerPanelHiddenForSession = false;
    const gitStatusCache = new Map();
    const agentOutputCache = new Map();
    const cardDetailsCache = new Map();
    let refreshTimer = null;
    let detailsRefreshTimer = null;
    const cardDragType = "application/x-kanban-card";
    const columnDragType = "application/x-kanban-column";
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const searchShortcutLabel = isMac ? "Cmd+F" : "Ctrl+F";
    const detailsPaneMinWidth = ${MIN_DETAILS_PANE_WIDTH};
    const detailsPaneMaxWidth = ${MAX_DETAILS_PANE_WIDTH};
    let draggingCard = null;
    let draggingColumn = null;
    let detailsPaneWidth = ${detailsPaneWidth};
    let activeDetailsResize = null;

    const escapeHtml = (value) => {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const renderRunnerPanel = () => {
      if (!runnerPanelEl) {
        return;
      }
      if (runnerPanelHiddenForSession || !runnerStatus?.enabled || runnerStatus.running) {
        runnerPanelEl.hidden = true;
        runnerPanelEl.innerHTML = "";
        runnerStartPending = false;
        runnerCreatePending = false;
        return;
      }
      runnerPanelEl.hidden = false;
      const messageHtml = runnerStatus.message
        ? \`<div class="runner-panel-message">\${escapeHtml(runnerStatus.message)}</div>\`
        : "";
      const missingRequirements = Object.values(runnerStatus.requirements || {})
        .filter((requirement) => !requirement.installed);
      const requirementsHtml = missingRequirements.length
        ? \`
          <div class="runner-requirements">
            \${missingRequirements.map((requirement) => {
              return \`
                <div class="runner-requirement missing">
                  <span>\${escapeHtml(requirement.label)}</span>
                  <span class="runner-requirement-status">Missing</span>
                  <button type="button" data-action-type="openRunnerLink" data-action-url="\${escapeHtml(requirement.installUrl)}">Install</button>
                </div>
              \`;
            }).join("")}
          </div>
        \`
        : "";
      const hideActionHtml = \`
        <div class="runner-panel-actions">
          <button type="button" data-action-type="hideRunnerPanel">Hide</button>
          <label class="runner-hide-default">[ <input type="checkbox" data-runner-hide-default /> by default ]</label>
        </div>
      \`;
      if (runnerStatus.runnerScriptRequired && !runnerStatus.runnerScriptExists) {
        runnerPanelEl.innerHTML = \`
          <div>
            <div class="runner-panel-title">No local runner script found</div>
            <p class="runner-panel-text">Initialize runner support: create tasks/, add runner.py at the runner root, and seed projects/context files.</p>
            \${messageHtml}
            \${requirementsHtml}
          </div>
          <button type="button" data-action-type="createRunner" \${runnerCreatePending ? "disabled" : ""}>
            \${runnerCreatePending ? "Initializing..." : "Initialize runner"}
          </button>
          \${hideActionHtml}
        \`;
        return;
      }
      runnerPanelEl.innerHTML = \`
        <div>
          <div class="runner-panel-title">No Kanban runner detected</div>
          <p class="runner-panel-text">Start a background runner for this board. It keeps working if VS Code closes.</p>
          \${messageHtml}
          \${requirementsHtml}
        </div>
        <button type="button" data-action-type="startRunner" \${runnerStartPending || missingRequirements.length ? "disabled" : ""}>
          \${runnerStartPending ? "Starting..." : missingRequirements.length ? "Install requirements" : "Start runner"}
        </button>
        \${hideActionHtml}
      \`;
    };

    const activeAgentCount = () => {
      const value = Number(runnerStatus?.activeAgentCount);
      if (!Number.isFinite(value) || value < 1) {
        return 0;
      }
      return Math.floor(value);
    };

    const renderActiveAgentCount = () => {
      if (!agentCountEl) {
        return;
      }
      if (!runnerStatus?.running) {
        agentCountEl.hidden = true;
        agentCountEl.textContent = "";
        agentCountEl.removeAttribute?.("aria-label");
        return;
      }
      const count = activeAgentCount();
      const label = count === 1 ? "1 running agent" : \`\${count} running agents\`;
      const title = label;
      agentCountEl.hidden = false;
      agentCountEl.textContent = label;
      agentCountEl.setAttribute("aria-label", title);
      agentCountEl.setAttribute("title", title);
    };

    const activeAgentSummary = () => {
      const count = runnerStatus?.running ? activeAgentCount() : 0;
      if (count < 1) {
        return "";
      }
      return count === 1 ? "1 running agent" : \`\${count} running agents\`;
    };

    const withActiveAgentSummary = (text) => {
      const summary = activeAgentSummary();
      return summary ? \`\${text} · \${summary}\` : text;
    };

    const clampDetailsPaneWidth = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return detailsPaneWidth;
      }
      return Math.max(
        detailsPaneMinWidth,
        Math.min(detailsPaneMaxWidth, Math.round(numeric))
      );
    };

    const applyDetailsPaneWidth = (value) => {
      detailsPaneWidth = clampDetailsPaneWidth(value);
      if (rootStyle && typeof rootStyle.setProperty === "function") {
        rootStyle.setProperty("--details-pane-width", detailsPaneWidth + "px");
      } else if (rootStyle) {
        rootStyle["--details-pane-width"] = detailsPaneWidth + "px";
      }
      return detailsPaneWidth;
    };

    const canResizeDetailsPane = () => {
      return typeof window.innerWidth !== "number" || window.innerWidth > 900;
    };

    const beginDetailsResize = (event) => {
      if (!detailsResizerEl || !canResizeDetailsPane()) {
        return;
      }
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      event.preventDefault();
      const rect = typeof detailsEl.getBoundingClientRect === "function"
        ? detailsEl.getBoundingClientRect()
        : null;
      activeDetailsResize = {
        startX: Number(event.clientX || 0),
        startWidth: Number(rect?.width || detailsPaneWidth),
      };
      layoutEl?.classList?.add("resizing");
      detailsResizerEl.classList.add("active");
    };

    const updateDetailsResize = (event) => {
      if (!activeDetailsResize) {
        return;
      }
      const nextWidth =
        activeDetailsResize.startWidth
        + (activeDetailsResize.startX - Number(event.clientX || 0));
      applyDetailsPaneWidth(nextWidth);
    };

    const finishDetailsResize = () => {
      if (!activeDetailsResize) {
        return;
      }
      activeDetailsResize = null;
      layoutEl?.classList?.remove("resizing");
      detailsResizerEl?.classList?.remove("active");
      vscode.postMessage({
        type: "saveDetailsPaneWidth",
        width: detailsPaneWidth,
      });
    };

    const getPropertyActions = (property) => {
      const rawActions = Array.isArray(property?.actions)
        ? property.actions
        : property?.action
          ? [property.action]
          : [];
      return rawActions
        .map((action) => {
          const type = String(action?.command || "").trim();
          const label = String(action?.title || "").trim();
          const value = String(action?.value || "").trim();
          if (!type || !label || !value) {
            return null;
          }
          if (
            type !== "resumeAgent" &&
            type !== "openPath" &&
            type !== "openCode" &&
            type !== "openUrl" &&
            type !== "openLocalPath"
          ) {
            return null;
          }
          return { type, label, value };
        })
        .filter(Boolean);
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
        const actionHtml = getPropertyActions(property)
          .map((action) => \`<button class="property-action" type="button" data-action-type="\${escapeHtml(action.type)}" data-action-value="\${escapeHtml(action.value)}">\${escapeHtml(action.label)}</button>\`)
          .join("");
        const actionsHtml = actionHtml ? \`<div class="property-actions">\${actionHtml}</div>\` : "";
        return \`
          <div class="property-row">
            <div class="property-label">\${escapeHtml(property.label)}:</div>
            <div class="property-value">\${escapeHtml(property.value)}</div>
            \${actionsHtml}
          </div>
        \`;
      }).join("");
      return \`<div class="properties">\${rows}</div>\`;
    };

    const renderDetailsPlaceholder = (message) => {
      detailsEl.innerHTML = \`<div class="empty">\${escapeHtml(message)}</div>\`;
    };

    const getPropertyValue = (card, names) => {
      const normalizedNames = new Set(
        (Array.isArray(names) ? names : [names])
          .map((name) => String(name || "").trim().toLowerCase())
          .filter(Boolean)
      );
      const property = (card?.properties || []).find((property) => {
        return normalizedNames.has(String(property?.key || "").trim().toLowerCase());
      });
      const value = String(property?.value || "").trim();
      return value || null;
    };

    const normalizeAgentKind = (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "claude" || normalized === "agent:claude") {
        return "claude";
      }
      if (normalized === "codex" || normalized === "agent:codex") {
        return "codex";
      }
      if (normalized === "kimi" || normalized === "agent:kimi") {
        return "kimi";
      }
      return null;
    };

    const getAgentKindFromId = (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      if (/^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
        return "kimi";
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
        return null;
      }
      const version = normalized[14];
      if (version === "7") {
        return "codex";
      }
      if (version === "4") {
        return "claude";
      }
      return null;
    };

    const getAgentKindFromTags = (card) => {
      for (const tag of card?.tags || []) {
        const kind = normalizeAgentKind(tag);
        if (kind) {
          return kind;
        }
      }
      return null;
    };

    const getAgentKind = (card) => {
      return getAgentKindFromId(getPropertyValue(card, "Agent"))
        || normalizeAgentKind(getPropertyValue(card, ["Agent Kind", "AgentKind"]))
        || getAgentKindFromTags(card);
    };

    const getAgentOutputTitle = (card, cached) => {
      const kind = normalizeAgentKind(cached?.agentKind) || getAgentKind(card);
      if (kind === "claude") {
        return "Claude Output";
      }
      if (kind === "codex") {
        return "Codex Output";
      }
      if (kind === "kimi") {
        return "Kimi Output";
      }
      return "Agent Output";
    };

    const getAgentId = (card) => {
      return getPropertyValue(card, "Agent");
    };

    const getRepoPath = (card) => {
      return getPropertyValue(card, "Repo");
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

    const requestAgentOutput = (card) => {
      const agentId = getAgentId(card);
      if (!agentId) {
        return;
      }
      const cached = agentOutputCache.get(agentId);
      if (cached?.state === "loading" || !shouldRefreshCache(cached)) {
        return;
      }
      const agentKind = getAgentKind(card);
      agentOutputCache.set(agentId, {
        state: "loading",
        text: cached?.text || "",
        html: cached?.html || "",
        agentKind: cached?.agentKind || agentKind,
        refreshedAt: cached?.refreshedAt || 0,
      });
      vscode.postMessage({
        type: "requestAgentOutput",
        cardUri: card.uri,
        agentId,
        agentKind,
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
          <h2 class="details-section-title">Git Status</h2>
          <pre class="git-status-text">\${escapeHtml(cached.text || "Loading...")}</pre>
        \`;
      }
      if (cached.state !== "ready" || !cached.text) {
        return "";
      }
      return \`
        <h2 class="details-section-title">Git Status</h2>
        <pre class="git-status-text">\${escapeHtml(cached.text)}</pre>
      \`;
    };

    const renderAgentOutput = (card) => {
      const agentId = getAgentId(card);
      if (!agentId) {
        return "";
      }
      const cached = agentOutputCache.get(agentId);
      if (!cached) {
        requestAgentOutput(card);
        return "";
      }
      const title = getAgentOutputTitle(card, cached);
      if (cached.state === "loading") {
        return \`
          <h2 class="details-section-title">\${escapeHtml(title)}</h2>
          <div class="codex-output-text agent-output-text">\${escapeHtml(cached.text || "Loading...")}</div>
        \`;
      }
      if (cached.state !== "ready" || !cached.text) {
        return "";
      }
      const html = cached.html || escapeHtml(String(cached.text)).replace(/\\r?\\n/g, "<br />");
      return \`
        <h2 class="details-section-title">\${escapeHtml(title)}</h2>
        <div class="codex-output-text agent-output-text">\${html}</div>
      \`;
    };

    const requestCardDetails = (card) => {
      if (!card?.uri) {
        return;
      }
      const cached = cardDetailsCache.get(card.uri);
      if (cached?.state === "loading" || (cached?.state === "ready" && cached.updatedAt === card.updatedAt)) {
        return;
      }
      cardDetailsCache.set(card.uri, {
        state: "loading",
        bodyHtml: cached?.bodyHtml || "",
        bodyLineCount: cached?.bodyLineCount || 0,
        updatedAt: card.updatedAt,
      });
      vscode.postMessage({
        type: "requestCardDetails",
        cardUri: card.uri,
        updatedAt: card.updatedAt,
      });
    };

    const renderDescription = (card) => {
      const details = card?.uri ? cardDetailsCache.get(card.uri) : null;
      if (!details || details.state === "loading" || details.updatedAt !== card?.updatedAt) {
        requestCardDetails(card);
        return '<div class="empty">Loading description...</div>';
      }
      const bodyHtml = details?.bodyHtml || "";
      if (!bodyHtml) {
        return '<div class="empty">No description.</div>';
      }
      const collapsed = Number(details?.bodyLineCount || 0) > 50;
      return \`
        <div class="description-frame\${collapsed ? " collapsed" : ""}" data-description-frame>
          \${bodyHtml}
        </div>
        \${collapsed ? '<button class="description-expand" type="button" data-action-type="expandDescription">Show full description</button>' : ''}
      \`;
    };

    const refreshDetailsData = (card) => {
      if (!card?.uri) {
        return;
      }
      requestCardDetails(card);
      requestGitStatus(card);
      requestAgentOutput(card);
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
      const descriptionHtml = renderDescription(card);
      const tagsHtml = renderTags(card.tags || []);
      const propertiesHtml = renderProperties(card.properties || []);
      const gitStatusHtml = renderGitStatus(card);
      const agentOutputHtml = renderAgentOutput(card);
      const metaLine = "Created: " + createdLabel + " · " + createdRelative;
      detailsEl.innerHTML = \`
        <div class="details-header">
          <div class="details-title">
            <h1>\${escapeHtml(card.title)}</h1>
            <div class="meta">\${metaLine}</div>
          </div>
          <button
            class="details-delete"
            type="button"
            title="Delete ticket"
            aria-label="Delete \${escapeHtml(card.title)}"
            data-action-type="deleteCard"
            data-action-value="\${escapeHtml(card.uri)}"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7h16" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M6 7l1 14h10l1-14" />
              <path d="M9 7V4h6v3" />
            </svg>
          </button>
        </div>
        \${tagsHtml}
        \${propertiesHtml}
        <div class="details-body">
          <hr />
          \${descriptionHtml}
          \${gitStatusHtml}
          \${agentOutputHtml}
        </div>
      \`;
      refreshDetailsData(card);
      startDetailsRefresh();
    };

    const normalizeSearchQuery = (value) => {
      return String(value ?? "").trim().toLowerCase();
    };

    const buildCardSearchText = (card) => {
      return String(card?.searchText || "").toLowerCase();
    };

    const matchesSearch = (card, query) => {
      return !query || buildCardSearchText(card).includes(query);
    };

    const NO_TAG_FILTER = "__kanban_no_tag__";

    const normalizeTagValue = (value) => {
      return String(value ?? "").trim();
    };

    const getCardTags = (card) => {
      return (card?.tags || []).map(normalizeTagValue).filter(Boolean);
    };

    const matchesTagFilter = (card, tagFilter) => {
      if (!tagFilter) {
        return true;
      }
      const tags = getCardTags(card);
      if (tagFilter === NO_TAG_FILTER) {
        return tags.length === 0;
      }
      return tags.includes(tagFilter);
    };

    const matchesActiveFilters = (card, query, tagFilter) => {
      return matchesSearch(card, query) && matchesTagFilter(card, tagFilter);
    };

    const collectTags = (board) => {
      const tags = new Set();
      for (const column of board?.columns || []) {
        for (const card of column?.cards || []) {
          for (const tag of getCardTags(card)) {
            tags.add(tag);
          }
        }
      }
      return Array.from(tags).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" })
      );
    };

    const updateTagFilterOptions = (board) => {
      if (!tagFilterEl) {
        return;
      }
      const tags = collectTags(board);
      if (selectedTagFilter && selectedTagFilter !== NO_TAG_FILTER && !tags.includes(selectedTagFilter)) {
        selectedTagFilter = "";
      }

      tagFilterEl.innerHTML = "";
      const addOption = (value, label) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        tagFilterEl.appendChild(option);
      };
      addOption("", "All tags");
      addOption(NO_TAG_FILTER, "(no-tag)");
      for (const tag of tags) {
        addOption(tag, tag);
      }
      tagFilterEl.value = selectedTagFilter;
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
      const activeTagFilter = selectedTagFilter;
      const activeFilter = Boolean(activeQuery || activeTagFilter);
      const totalCards = countCards(boardColumns);
      const visibleCards = countCards(visibleColumns);
      if (searchMetaEl) {
        let metaText = "";
        if (!activeFilter) {
          metaText = totalCards === 1 ? "1 card" : \`\${totalCards} cards\`;
        } else if (!visibleCards && activeQuery && !activeTagFilter) {
          metaText = \`No cards match "\${searchQuery.trim()}".\`;
        } else if (!visibleCards && activeTagFilter === NO_TAG_FILTER && !activeQuery) {
          metaText = "No cards without tags.";
        } else if (!visibleCards && activeTagFilter && !activeQuery) {
          metaText = \`No cards match tag "\${activeTagFilter}".\`;
        } else if (!visibleCards) {
          metaText = "No cards match the current filters.";
        } else {
          const matchingColumns = (visibleColumns || []).filter((column) => column.cards.length > 0).length;
          const columnLabel = matchingColumns === 1 ? "column" : "columns";
          metaText =
            \`\${visibleCards} of \${totalCards} cards shown in \${matchingColumns} \${columnLabel}. Cards can be moved to other columns while filtering.\`;
        }
        searchMetaEl.textContent = withActiveAgentSummary(metaText);
      }
      if (searchClearEl) {
        searchClearEl.hidden = !activeFilter;
      }
    };

    const getDragTypes = (event) => {
      return Array.from(event?.dataTransfer?.types || []);
    };

    const getCardUris = (cards) => {
      return (cards || []).map((card) => card.uri).filter(Boolean);
    };

    const hasSameOrder = (cards, orderedUris) => {
      const currentUris = getCardUris(cards);
      return currentUris.length === orderedUris.length
        && currentUris.every((uri, index) => uri === orderedUris[index]);
    };

    const buildOrderedUris = (cards, cardUri, targetUri, position) => {
      const currentUris = getCardUris(cards);
      if (cardUri && targetUri && cardUri === targetUri) {
        return currentUris;
      }
      const list = currentUris.filter((uri) => uri !== cardUri);
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

    const bumpCardToTop = (card, columnId, cards) => {
      if (!card?.uri || !columnId) {
        return;
      }
      vscode.postMessage({
        type: "reorderCards",
        cardUri: card.uri,
        sourceColumnId: columnId,
        targetColumnId: columnId,
        orderedUris: buildOrderedUris(cards, card.uri, null, "start"),
      });
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

    const colorStyle = (value, saturation, lightness) => {
      const hash = hashString(value.toLowerCase());
      const hue = hash % 360;
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      const text = readableTextColor(r, g, b);
      const rgb = \`rgb(\${Math.round(r * 255)}, \${Math.round(g * 255)}, \${Math.round(b * 255)})\`;
      return { background: rgb, color: text };
    };

    const tagStyle = (tag) => colorStyle(tag, 0.55, 0.5);
    const projectBorderStyle = (project) => colorStyle(project, 0.26, 0.46);

    const getProjectValue = (card) => {
      const projectProperty = (card?.properties || []).find((property) => {
        return String(property?.key || "").trim().toLowerCase() === "project";
      });
      return String(projectProperty?.value || "").trim();
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

    const findCardByFileName = (board, fileName) => {
      const normalized = String(fileName || "").toLowerCase();
      if (!normalized) return null;
      const matches = [];
      for (const column of board?.columns || []) {
        for (const card of column.cards || []) {
          if (String(card?.fileName || "").toLowerCase() === normalized) {
            matches.push(card);
          }
        }
      }
      return matches.length === 1 ? matches[0] : null;
    };

    const findCardColumnId = (board, uri) => {
      for (const column of board?.columns || []) {
        for (const card of column.cards || []) {
          if (card.uri === uri) return column.id ?? column.name;
        }
      }
      return null;
    };

    const pruneCardDetailsCache = (board) => {
      const currentCards = new Map();
      for (const column of board?.columns || []) {
        for (const card of column.cards || []) {
          if (card?.uri) {
            currentCards.set(card.uri, card.updatedAt);
          }
        }
      }
      for (const [cardUri, details] of cardDetailsCache) {
        if (!currentCards.has(cardUri) || details?.updatedAt !== currentCards.get(cardUri)) {
          cardDetailsCache.delete(cardUri);
        }
      }
    };

    const syncDetails = () => {
      if (!selectedCard) {
        renderDetailsPlaceholder("Select a card to view details.");
        return;
      }
      const updated = findCard(lastBoard, selectedCard.uri)
        || findCardByFileName(lastBoard, selectedCard.fileName);
      if (!updated) {
        selectedCard = null;
        renderDetailsPlaceholder("Select a card to view details.");
        return;
      }
      selectedCard = updated;
      const activeQuery = normalizeSearchQuery(searchQuery);
      const activeTagFilter = selectedTagFilter;
      if (!matchesActiveFilters(updated, activeQuery, activeTagFilter)) {
        const filterLabel = activeQuery && !activeTagFilter
          ? "current search"
          : activeTagFilter && !activeQuery
            ? "current tag filter"
            : "current filters";
        renderDetailsPlaceholder(\`Selected card is hidden by the \${filterLabel}.\`);
        return;
      }
      renderDetails(updated);
    };

    const renderBoard = (board) => {
      boardEl.innerHTML = "";
      updateTagFilterOptions(board);
      if (!board?.columns?.length) {
        boardEl.innerHTML = '<div class="card">No columns found. Create folders next to the .kanban file.</div>';
        updateSearchUi([], []);
        return;
      }
      const activeQuery = normalizeSearchQuery(searchQuery);
      const activeTagFilter = selectedTagFilter;
      const searchActive = Boolean(activeQuery || activeTagFilter);
      const visibleColumns = [];
      const firstColumnId = board.columns[0]?.id ?? board.columns[0]?.name;
      for (const column of board.columns) {
        const columnId = column.id ?? column.name;
        const allCards = Array.isArray(column.cards) ? column.cards : [];
        const visibleCards = searchActive
          ? allCards.filter((card) => matchesActiveFilters(card, activeQuery, activeTagFilter))
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
        titleEl.className = "column-title";
        titleEl.textContent = searchActive
          ? \`\${column.name} (\${visibleCards.length}/\${allCards.length})\`
          : \`\${column.name} (\${allCards.length})\`;
        titleEl.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          vscode.postMessage({
            type: "renameColumn",
            columnId,
            currentTitle: column.name,
          });
        });
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
          const acceptsColumn = !searchActive && types.includes(columnDragType);
          const acceptsCard = types.includes(cardDragType) || types.includes("text/uri-list");
          if (acceptsColumn || acceptsCard) {
            event.preventDefault();
            columnEl.classList.add("drop-target");
          }
        });
        columnEl.addEventListener("dragleave", (event) => {
          if (
            event.relatedTarget
            && typeof columnEl.contains === "function"
            && columnEl.contains(event.relatedTarget)
          ) {
            return;
          }
          columnEl.classList.remove("drop-target");
        });
        columnEl.addEventListener("drop", (event) => {
          const types = getDragTypes(event);
          if (!searchActive && types.includes(columnDragType)) {
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
            if (!sourceColumnId) {
              sourceColumnId = findCardColumnId(lastBoard, cardUri);
            }
            if (searchActive && sourceColumnId === columnId) {
              return;
            }
            if (sourceColumnId === columnId) {
              return;
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

        if (!visibleCards.length) {
          const emptyEl = document.createElement("div");
          emptyEl.className = "column-empty";
          emptyEl.textContent = searchActive ? "No matches in this column." : "No cards yet.";
          columnEl.appendChild(emptyEl);
        }

        for (const card of visibleCards) {
          const cardEl = document.createElement("div");
          cardEl.className = "card";
          cardEl.draggable = true;
          cardEl.dataset.uri = card.uri;
          cardEl.dataset.column = columnId;
          const projectValue = getProjectValue(card);
          if (projectValue) {
            cardEl.style.setProperty("--card-accent", projectBorderStyle(projectValue).background);
          }
          const tagsHtml = renderTags(card.tags || []);
          const propertyBadgesHtml = renderPropertyBadges(card.properties || []);
          const created = new Date(card.createdAt);
          const createdLabel = created.toLocaleDateString();
          const createdRelative = formatRelativeTime(created);
          const metaLine = createdLabel + " · " + createdRelative;
          const isFirstCard = allCards[0]?.uri === card.uri;
          cardEl.innerHTML = \`
            <div class="card-title-row">
              <h3 title="\${escapeHtml(card.title)}">\${escapeHtml(card.title)}</h3>
              <button
                class="card-bump"
                type="button"
                title="Move to top"
                aria-label="Move \${escapeHtml(card.title)} to top"
                data-card-action="bump"
                draggable="false"
                \${isFirstCard ? "disabled" : ""}
              >↑</button>
            </div>
            <div class="meta">\${metaLine}</div>
            \${tagsHtml}
            \${propertyBadgesHtml}
          \`;
          cardEl.addEventListener("click", (event) => {
            const actionButton = event?.target instanceof Element
              ? event.target.closest("[data-card-action]")
              : null;
            if (actionButton?.getAttribute("data-card-action") === "bump") {
              event.preventDefault?.();
              event.stopPropagation?.();
              bumpCardToTop(card, columnId, allCards);
              return;
            }
            renderDetails(card);
          });
          cardEl.addEventListener("dblclick", (event) => {
            const actionButton = event?.target instanceof Element
              ? event.target.closest("[data-card-action]")
              : null;
            if (actionButton) {
              return;
            }
            openCard(card);
          });
          cardEl.addEventListener("dragstart", (event) => {
            draggingCard = { uri: card.uri, columnId };
            event.dataTransfer.setData("text/uri-list", card.uri);
            event.dataTransfer.setData(cardDragType, JSON.stringify(draggingCard));
            event.dataTransfer.effectAllowed = "move";
          });
          cardEl.addEventListener("dragend", () => {
            draggingCard = null;
          });
          if (!searchActive) {
            cardEl.addEventListener("dragover", (event) => {
              const types = getDragTypes(event);
              if (types.includes(columnDragType)) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              cardEl.classList.add("card-drop-target");
            });
            cardEl.addEventListener("dragleave", (event) => {
              const types = getDragTypes(event);
              if (!types.includes(columnDragType)) {
                event.stopPropagation();
              }
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
              if (cardUri === card.uri) {
                return;
              }
              let sourceColumnId = draggingCard?.columnId;
              if (!sourceColumnId) {
                try {
                  const payload = JSON.parse(event.dataTransfer.getData(cardDragType) || "{}");
                  sourceColumnId = payload.columnId;
                } catch {}
              }
              if (!sourceColumnId) {
                sourceColumnId = findCardColumnId(lastBoard, cardUri);
              }
              const rect = cardEl.getBoundingClientRect();
              const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
              const orderedUris = buildOrderedUris(allCards, cardUri, card.uri, position);
              if (sourceColumnId === columnId && hasSameOrder(allCards, orderedUris)) {
                return;
              }
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

    const setTagFilter = (value) => {
      selectedTagFilter = String(value ?? "");
      if (tagFilterEl && tagFilterEl.value !== selectedTagFilter) {
        tagFilterEl.value = selectedTagFilter;
      }
      refreshBoard();
    };

    const clearSearchFilters = () => {
      searchQuery = "";
      selectedTagFilter = "";
      if (searchInputEl) {
        searchInputEl.value = "";
      }
      if (tagFilterEl) {
        tagFilterEl.value = "";
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

    if (tagFilterEl) {
      tagFilterEl.addEventListener("change", () => {
        setTagFilter(tagFilterEl.value);
      });
    }

    if (searchClearEl) {
      searchClearEl.addEventListener("click", () => {
        clearSearchFilters();
        focusSearch();
      });
    }

    if (runnerPanelEl) {
      runnerPanelEl.addEventListener("click", (event) => {
        const actionButton = event.target instanceof Element
          ? event.target.closest("[data-action-type]")
          : null;
        const actionType = actionButton?.getAttribute("data-action-type");
        if (
          actionType !== "startRunner" &&
          actionType !== "createRunner" &&
          actionType !== "openRunnerLink" &&
          actionType !== "hideRunnerPanel"
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (actionType === "hideRunnerPanel") {
          const hideByDefaultInput = runnerPanelEl.querySelector("[data-runner-hide-default]");
          const hideByDefault = Boolean(hideByDefaultInput?.checked);
          runnerPanelHiddenForSession = true;
          renderRunnerPanel();
          if (hideByDefault) {
            vscode.postMessage({ type: "hideRunnerPanel" });
          }
          return;
        }
        if (actionType === "openRunnerLink") {
          const url = actionButton.getAttribute("data-action-url");
          if (url) {
            vscode.postMessage({ type: "openUrl", url });
          }
          return;
        }
        if (actionType === "createRunner") {
          runnerCreatePending = true;
          renderRunnerPanel();
          vscode.postMessage({ type: "createRunner" });
          return;
        }
        runnerStartPending = true;
        renderRunnerPanel();
        vscode.postMessage({ type: "startRunner" });
      });
    }

    applyDetailsPaneWidth(detailsPaneWidth);

    if (detailsResizerEl) {
      detailsResizerEl.addEventListener("mousedown", beginDetailsResize);
    }

    window.addEventListener("mousemove", updateDetailsResize);
    window.addEventListener("mouseup", finishDetailsResize);

    detailsEl.addEventListener("change", (event) => {
      const target = event.target instanceof Element
        ? event.target
        : null;
      if (!target || target.getAttribute("type") !== "checkbox") {
        return;
      }
      const taskIndex = Number(target.getAttribute("data-task-index"));
      if (!Number.isInteger(taskIndex) || !selectedCard?.uri) {
        return;
      }
      vscode.postMessage({
        type: "toggleTaskCheckbox",
        cardUri: selectedCard.uri,
        updatedAt: selectedCard.updatedAt,
        taskIndex,
        checked: Boolean(target.checked),
      });
    });

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
      if (actionType === "expandDescription") {
        const frame = detailsEl.querySelector("[data-description-frame]");
        if (frame) {
          frame.classList.remove("collapsed");
        }
        actionButton.remove();
        return;
      }
      if (!actionType || !actionValue) {
        return;
      }
      if (actionType === "resumeAgent") {
        vscode.postMessage({
          type: actionType,
          agentId: actionValue,
          title: selectedCard?.title || "",
          agentKind: getAgentKind(selectedCard),
          repoPath: getRepoPath(selectedCard),
        });
        return;
      }
      if (actionType === "openPath") {
        vscode.postMessage({ type: actionType, path: actionValue });
        return;
      }
      if (actionType === "openCode") {
        vscode.postMessage({ type: actionType, path: actionValue });
        return;
      }
      if (actionType === "openLocalPath") {
        vscode.postMessage({ type: actionType, path: actionValue });
        return;
      }
      if (actionType === "openUrl") {
        vscode.postMessage({ type: actionType, url: actionValue });
        return;
      }
      if (actionType === "deleteCard") {
        vscode.postMessage({
          type: actionType,
          cardUri: actionValue,
          title: selectedCard?.title || "",
        });
      }
    });
    detailsEl.addEventListener("dblclick", (event) => {
      const actionButton = event.target instanceof Element
        ? event.target.closest("[data-action-type]")
        : null;
      if (actionButton) {
        return;
      }
      openCard(selectedCard);
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "boardData") {
        lastBoard = message.board;
        pruneCardDetailsCache(lastBoard);
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
      if (message?.type === "detailsPaneWidth") {
        applyDetailsPaneWidth(message?.width);
      }
      if (message?.type === "runnerStatus") {
        runnerStatus = message.status || { enabled: false, running: false };
        runnerStartPending = false;
        runnerCreatePending = false;
        renderRunnerPanel();
        renderActiveAgentCount();
        if (lastBoard) {
          refreshBoard();
        }
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
      if (message?.type === "agentOutput") {
        const agentId = String(message?.agentId || "").trim();
        if (agentId) {
          const cached = agentOutputCache.get(agentId);
          const agentKind = normalizeAgentKind(message?.agentKind)
            || normalizeAgentKind(cached?.agentKind);
          agentOutputCache.set(agentId, message?.output
            ? {
                state: "ready",
                text: String(message.output),
                html: String(message.outputHtml || ""),
                agentKind,
                refreshedAt: Date.now(),
              }
            : {
                state: "missing",
                text: "",
                html: "",
                agentKind,
                refreshedAt: Date.now(),
              });
        }
        if (selectedCard && message?.cardUri === selectedCard.uri) {
          renderDetails(selectedCard);
        }
      }
      if (message?.type === "cardDetails") {
        const cardUri = String(message?.cardUri || "").trim();
        const currentCardUri = String(message?.currentCardUri || cardUri).trim();
        const requestedUpdatedAt = Number(message?.requestedUpdatedAt);
        const actualUpdatedAt = Number(message?.updatedAt || 0);
        const detailEntry = {
          state: "ready",
          bodyHtml: String(message?.bodyHtml || ""),
          bodyLineCount: Number(message?.bodyLineCount || 0),
          updatedAt: Number.isFinite(requestedUpdatedAt) && requestedUpdatedAt > 0
            ? requestedUpdatedAt
            : actualUpdatedAt,
        };
        if (cardUri) {
          cardDetailsCache.set(cardUri, detailEntry);
        }
        if (currentCardUri && currentCardUri !== cardUri) {
          cardDetailsCache.set(currentCardUri, {
            ...detailEntry,
            updatedAt: actualUpdatedAt,
          });
        }
        if (
          selectedCard &&
          (message?.cardUri === selectedCard.uri || currentCardUri === selectedCard.uri)
        ) {
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

function buildCardSearchText(
  title: string,
  fileName: string,
  body: string,
  tags: string[],
  properties: TaskProperty[]
): string {
  const propertiesText = properties
    .filter((property) => property.key.trim().toLowerCase() !== "tags")
    .map((property) => {
      const label = String(property.label || property.key || "").trim();
      const value = String(property.value || "").trim();
      return label ? `${label}: ${value}` : value;
    })
    .join("\n");
  return [title, fileName, body, ...tags, propertiesText]
    .join("\n")
    .toLowerCase();
}

function renderMarkdownWithTaskLists(markdown: string): string {
  let taskIndex = 0;
  return md.render(markdown).replace(
    /(<li\b[^>]*>\s*(?:<p>)?)\[( |x|X)\]\s+/g,
    (_match, prefix: string, marker: string) => {
      const checked = marker.toLowerCase() === "x";
      const checkbox =
        `<input class="task-list-checkbox" type="checkbox" data-task-index="${taskIndex}"` +
        (checked ? " checked" : "") +
        " /> ";
      taskIndex += 1;
      return `${prefix}${checkbox}`;
    }
  );
}

function normalizeAgentOutputMarkdown(markdown: string): string {
  const lines = String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const deduped: string[] = [];
  for (const line of lines) {
    const previous = deduped[deduped.length - 1];
    if (
      line.trim().length > 0
      && previous !== undefined
      && previous.trim() === line.trim()
    ) {
      continue;
    }
    deduped.push(line);
  }
  while (deduped.length > 0 && deduped[0].trim().length === 0) {
    deduped.shift();
  }
  while (deduped.length > 0 && deduped[deduped.length - 1].trim().length === 0) {
    deduped.pop();
  }
  return deduped.join("\n");
}

function formatRecentAgentOutputBlocks(blocks: string[]): string | null {
  const recentBlocks = [...blocks]
    .reverse()
    .map(normalizeAgentOutputMarkdown)
    .filter((block) => block.trim().length > 0)
    .filter((block, index, normalizedBlocks) => {
      if (index === 0) {
        return true;
      }
      return block.trim() !== normalizedBlocks[index - 1].trim();
    })
    .slice(-3);
  return recentBlocks.length > 0 ? recentBlocks.join("\n\n") : null;
}

function renderAgentOutputMarkdown(markdown: string): string {
  const normalized = normalizeAgentOutputMarkdown(markdown);
  return normalized ? agentOutputMd.render(normalized) : "";
}

function normalizeAgentKindValue(value: unknown): AgentKind | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "agent:claude") {
    return "claude";
  }
  if (normalized === "codex" || normalized === "agent:codex") {
    return "codex";
  }
  if (normalized === "kimi" || normalized === "agent:kimi") {
    return "kimi";
  }
  return null;
}

function agentKindFromAgentId(value: unknown): AgentKind | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      normalized
    )
  ) {
    return "kimi";
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      normalized
    )
  ) {
    return null;
  }
  const version = normalized[14];
  if (version === "7") {
    return "codex";
  }
  if (version === "4") {
    return "claude";
  }
  return null;
}

function extractClaudeRecordText(entry: unknown): string {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const record = entry as {
    type?: unknown;
    result?: unknown;
    message?: unknown;
    content?: unknown;
  };
  const type = String(record.type || "").toLowerCase();
  if (type === "result" && typeof record.result === "string") {
    return record.result.trim();
  }
  if (type === "assistant") {
    const message = record.message;
    if (message && typeof message === "object") {
      const text = extractClaudeContentText(
        (message as { content?: unknown }).content
      );
      if (text) {
        return text;
      }
    }
    return extractClaudeContentText(record.content);
  }
  return "";
}

function extractClaudeContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      if (
        typeof record.text === "string"
        && (!record.type || String(record.type).toLowerCase() === "text")
      ) {
        return record.text.trim();
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();
}

function extractKimiRecordText(entry: unknown): string {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const record = entry as {
    role?: unknown;
    content?: unknown;
    type?: unknown;
    event?: unknown;
    message?: unknown;
  };
  if (String(record.role || "").toLowerCase() === "assistant") {
    return extractKimiContentText(record.content);
  }
  const type = String(record.type || "").toLowerCase();
  if (type === "context.append_loop_event") {
    const event = record.event as { part?: unknown } | undefined;
    const part = event?.part as { type?: unknown; text?: unknown } | undefined;
    if (
      part
      && String(part.type || "").toLowerCase() === "text"
      && typeof part.text === "string"
    ) {
      return part.text.trim();
    }
  }
  if (type === "context.append_message") {
    const message = record.message as { role?: unknown; content?: unknown } | undefined;
    if (String(message?.role || "").toLowerCase() === "assistant") {
      return extractKimiContentText(message?.content);
    }
  }
  return "";
}

function extractKimiContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      if (
        typeof record.text === "string"
        && String(record.type || "text").toLowerCase() === "text"
      ) {
        return record.text.trim();
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();
}

function findNestedString(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, key);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const raw = record[key];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  for (const child of Object.values(record)) {
    const found = findNestedString(child, key);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizeDetailsPaneWidth(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_DETAILS_PANE_WIDTH;
  }
  return Math.max(
    MIN_DETAILS_PANE_WIDTH,
    Math.min(MAX_DETAILS_PANE_WIDTH, Math.round(numeric))
  );
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function formatAgentTerminalName(
  ticketTitle: unknown,
  agentId: string
): string {
  const title = String(ticketTitle ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return `Kanban Agent ${agentId.slice(0, 8)}`;
  }
  const maxTitleLength = 48;
  const trimmedTitle =
    title.length > maxTitleLength
      ? `${title.slice(0, maxTitleLength - 1).trimEnd()}…`
      : title;
  return `Kanban: ${trimmedTitle}`;
}

function formatTerminalExecutable(executable: string): string {
  const trimmed = executable.trim() || DEFAULT_CODEX_EXECUTABLE;
  if (!/\s/.test(trimmed)) {
    return trimmed;
  }

  if (process.platform === "win32") {
    return `& '${escapePowerShellSingleQuotedString(trimmed)}'`;
  }

  return `'${trimmed.replace(/'/g, "'\\''")}'`;
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
