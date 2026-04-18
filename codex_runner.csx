#!/usr/bin/env dotnet-script
#nullable enable

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

var settings = OrchestratorSettings.Parse(Args.ToArray(), Directory.GetCurrentDirectory());
var runner = new TaskOrchestrator(settings);
await runner.RunAsync();

sealed class TaskOrchestrator
{
    private static readonly TimeSpan RepositorySweepInterval = TimeSpan.FromMinutes(5);
    private readonly OrchestratorSettings _settings;
    private readonly BoardPaths _paths;
    private readonly LogSink _log;
    private readonly NotificationService _notifications;
    private readonly WorkspaceMoveBridge _workspaceMover;
    private readonly RunnerStatusServer _statusServer;
    private readonly ConcurrentDictionary<string, ActiveAgent> _activeAgents = new(PathTraits.Comparer);
    private readonly SemaphoreSlim _reconcileGate = new(1, 1);
    private readonly SemaphoreSlim _scanSignal = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private FileSystemWatcher? _tasksWatcher;
    private FileSystemWatcher? _rootWatcher;
    private Task? _scanLoopTask;
    private DateTimeOffset _lastRepositorySweepUtc = DateTimeOffset.MinValue;

    public TaskOrchestrator(OrchestratorSettings settings)
    {
        _settings = settings;
        _paths = new BoardPaths(settings.RootPath);
        _log = new LogSink(Path.Combine(_paths.LogsRoot, "codex_runner.log"));
        _notifications = new NotificationService(_log);
        _workspaceMover = new WorkspaceMoveBridge(_paths.Root, _log);
        _statusServer = new RunnerStatusServer(_paths.Root, _paths.TasksRoot, _log);
    }

    public async Task RunAsync()
    {
        Console.CancelKeyPress += OnCancelKeyPress;

        try
        {
            EnsureBoardScaffold();
            _notifications.Initialize();
            _log.Info($"Board root: {_paths.Root}");
            _log.Info($"Codex mode: {_settings.CodexMode}");
            _log.Info($"Max agents: {_settings.MaxAgents}");

            if (_settings.RunOnce)
            {
                await ReconcileAsync(_cts.Token);
                return;
            }

            _statusServer.Start();
            StartWatchers();
            SignalScan();
            _scanLoopTask = ScanLoopAsync(_cts.Token);

            _log.Info("Watching for task and project map changes. Press Ctrl+C to stop.");
            await _scanLoopTask;
        }
        finally
        {
            await _statusServer.StopAsync();
            Console.CancelKeyPress -= OnCancelKeyPress;
            _tasksWatcher?.Dispose();
            _rootWatcher?.Dispose();
        }
    }

    private void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true;
        _log.Info("Shutdown requested.");
        _cts.Cancel();
        _tasksWatcher?.Dispose();
        _rootWatcher?.Dispose();
        SignalScan();
    }

    private void EnsureBoardScaffold()
    {
        Directory.CreateDirectory(_paths.Root);
        foreach (var directory in _paths.RequiredDirectories)
        {
            Directory.CreateDirectory(directory);
        }

        EnsureFileExists(_paths.KanbanMarkerPath, BoardTemplates.CreateKanbanConfig(_paths.KanbanFolders));
        EnsureFileExists(_paths.GitIgnorePath, BoardTemplates.ResolveGitIgnoreTemplate(_settings.InvocationDirectory));
        EnsureFileExists(_paths.ProjectsMapPath, BoardTemplates.ProjectsTemplate);
        EnsureFileExists(_paths.ContextPath, BoardTemplates.ResolveContextTemplate(_settings.InvocationDirectory));
        EnsureFileExists(_paths.TaskTemplatePath, BoardTemplates.ResolveTaskTemplate(_settings.InvocationDirectory));
    }

    private static void EnsureFileExists(string path, string content)
    {
        if (File.Exists(path))
        {
            return;
        }

        File.WriteAllText(path, content, new UTF8Encoding(false));
    }

    private void StartWatchers()
    {
        _tasksWatcher = new FileSystemWatcher(_paths.TasksRoot)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.CreationTime,
            EnableRaisingEvents = true,
            Filter = "*.md"
        };

        _rootWatcher = new FileSystemWatcher(_paths.Root)
        {
            IncludeSubdirectories = false,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
            EnableRaisingEvents = true,
            Filter = Path.GetFileName(_paths.ProjectsMapPath)
        };

        foreach (var watcher in new[] { _tasksWatcher, _rootWatcher })
        {
            watcher.Created += OnWatcherChanged;
            watcher.Changed += OnWatcherChanged;
            watcher.Deleted += OnWatcherChanged;
            watcher.Renamed += OnWatcherRenamed;
            watcher.Error += OnWatcherError;
        }
    }

    private void OnWatcherChanged(object sender, FileSystemEventArgs e)
    {
        _log.Info($"FS event: {e.ChangeType} {e.FullPath}");
        SignalScan();
    }

    private void OnWatcherRenamed(object sender, RenamedEventArgs e)
    {
        _log.Info($"FS event: Renamed {e.OldFullPath} -> {e.FullPath}");
        SignalScan();
    }

    private void OnWatcherError(object sender, ErrorEventArgs e)
    {
        _log.Warn($"File watcher error: {e.GetException().Message}");
        SignalScan();
    }

    private void SignalScan()
    {
        if (_scanSignal.CurrentCount == 0)
        {
            _scanSignal.Release();
        }
    }

    private async Task ScanLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var signalTask = _scanSignal.WaitAsync(cancellationToken);
                var delayTask = Task.Delay(_settings.PollInterval, cancellationToken);
                await Task.WhenAny(signalTask, delayTask);

                if (cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                await ReconcileAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error($"Unexpected scan loop failure: {ex}");
            }
        }
    }

    private async Task ReconcileAsync(CancellationToken cancellationToken)
    {
        if (!await _reconcileGate.WaitAsync(0, cancellationToken))
        {
            return;
        }

        try
        {
            EnsureBoardScaffold();

            var projectMap = ProjectMap.Load(_paths.ProjectsMapPath, _log);
            await ReactivateDoneCardsAsync(cancellationToken);
            await SweepRepositoriesAsync(_settings.RunOnce, cancellationToken);

            if (_activeAgents.Count >= _settings.MaxAgents)
            {
                return;
            }

            foreach (var taskPath in EnumerateStepTasks(TaskStep.Backlog))
            {
                if (_activeAgents.Count >= _settings.MaxAgents)
                {
                    break;
                }

                cancellationToken.ThrowIfCancellationRequested();

                if (!TryLoadTaskCard(taskPath, TaskStep.Backlog, out var card))
                {
                    continue;
                }

                if (string.IsNullOrWhiteSpace(card.ProjectAlias))
                {
                    await BlockTaskForIssueAsync(card, "Missing `Project:` field.", cancellationToken);
                    continue;
                }

                if (!projectMap.TryGetValue(card.ProjectAlias, out var repoUrl))
                {
                    await BlockTaskForIssueAsync(card, $"Unknown project alias `{card.ProjectAlias}` in projects.md.", cancellationToken);
                    continue;
                }

                await StartOrResumeTaskAsync(card, repoUrl, cancellationToken);
            }
        }
        finally
        {
            _reconcileGate.Release();
        }
    }

    private async Task SweepRepositoriesAsync(bool force, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        if (!force && now - _lastRepositorySweepUtc < RepositorySweepInterval)
        {
            return;
        }

        _lastRepositorySweepUtc = now;
        await CacheCompletedRepositoriesAsync(cancellationToken);
        await TrashOrphanRepositoriesAsync(cancellationToken);
    }

    private async Task CacheCompletedRepositoriesAsync(CancellationToken cancellationToken)
    {
        var activeRepoPaths = GetActiveRepositoryPaths();
        var referencesByRepo = LoadTaskRepositoryReferences()
            .GroupBy(reference => reference.RepoPath, PathTraits.Comparer);

        foreach (var referenceGroup in referencesByRepo)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var repoPath = referenceGroup.Key;
            if (activeRepoPaths.Contains(repoPath))
            {
                continue;
            }

            if (!Directory.Exists(repoPath))
            {
                continue;
            }

            if (!PathStartsWith(repoPath, _paths.ProjectsRoot))
            {
                continue;
            }

            if (referenceGroup.Any(reference => !reference.IsConfirmed))
            {
                continue;
            }

            var alias = referenceGroup
                .Select(reference => reference.ProjectAlias)
                .FirstOrDefault(projectAlias => !string.IsNullOrWhiteSpace(projectAlias))
                ?? GetManagedProjectAlias(repoPath)
                ?? "unknown-project";
            var cacheProjectDir = Path.Combine(_paths.CacheRoot, FileName.Sanitize(alias));
            Directory.CreateDirectory(cacheProjectDir);

            var destination = MakeUniqueDirectoryPath(cacheProjectDir, Path.GetFileName(repoPath));
            await _workspaceMover.MoveDirectoryAsync(repoPath, destination, cancellationToken);
            foreach (var reference in referenceGroup)
            {
                if (reference.ManagedCard is not null)
                {
                    await reference.ManagedCard.WithUpdatedRepoPathAsync(destination, cancellationToken);
                }
            }

            _log.Info($"Moved completed repo to cache: {destination}");
        }
    }

    private async Task TrashOrphanRepositoriesAsync(CancellationToken cancellationToken)
    {
        var referencedRepoPaths = new HashSet<string>(
            LoadTaskRepositoryReferences()
                .Select(reference => reference.RepoPath),
            PathTraits.Comparer);

        var activeRepoPaths = GetActiveRepositoryPaths();
        var managedRepos = EnumerateManagedRepositories(_paths.ProjectsRoot)
            .Concat(EnumerateManagedRepositories(_paths.CacheRoot))
            .Distinct(PathTraits.Comparer)
            .OrderBy(path => path, PathTraits.Comparer);

        foreach (var repoPath in managedRepos)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (activeRepoPaths.Contains(repoPath) || referencedRepoPaths.Contains(repoPath))
            {
                continue;
            }

            var alias = GetManagedProjectAlias(repoPath) ?? "unassigned";
            var trashProjectDir = Path.Combine(_paths.TrashRoot, FileName.Sanitize(alias));
            Directory.CreateDirectory(trashProjectDir);

            var destination = MakeUniqueDirectoryPath(trashProjectDir, Path.GetFileName(repoPath));
            await _workspaceMover.MoveDirectoryAsync(repoPath, destination, cancellationToken);
            _log.Info($"Moved orphaned repo to trash: {destination}");
        }
    }

    private async Task ReactivateDoneCardsAsync(CancellationToken cancellationToken)
    {
        foreach (var taskPath in EnumerateStepTasks(TaskStep.Done))
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!TryLoadTaskCard(taskPath, TaskStep.Done, out var card))
            {
                continue;
            }

            if (!card.HasMeaningfulComments)
            {
                continue;
            }

            var backlogPath = await MoveTaskAsync(card, TaskStep.Backlog, cancellationToken);
            _log.Info($"Requeued done task because Comments is non-empty: {backlogPath}");
            SignalScan();
        }
    }

    private bool TryLoadTaskCard(string taskPath, TaskStep expectedStep, out TaskCard card)
    {
        try
        {
            card = TaskCard.Load(taskPath, expectedStep, _paths);
            return true;
        }
        catch (Exception ex)
        {
            _log.Warn($"Skipping unreadable task `{taskPath}`: {ex.Message}");
            card = null!;
            return false;
        }
    }

    private async Task StartOrResumeTaskAsync(TaskCard backlogCard, string repoUrl, CancellationToken cancellationToken)
    {
        var doingPath = await MoveTaskAsync(backlogCard, TaskStep.Doing, cancellationToken);
        var doingCard = TaskCard.Load(doingPath, TaskStep.Doing, _paths);

        string repoPath;
        try
        {
            repoPath = await EnsureWorkingRepositoryAsync(doingCard, repoUrl, cancellationToken);
            doingCard = await doingCard.WithUpdatedRepoPathAsync(repoPath, cancellationToken);
        }
        catch (Exception ex)
        {
            _log.Error($"Repository provisioning failed for `{doingCard.Path}`: {ex.Message}");
            await BlockTaskForIssueAsync(doingCard, $"Repository provisioning failed: {ex.Message}", cancellationToken);
            return;
        }

        var runner = new CodexRunner(_settings, _paths, _log);
        var activeAgent = new ActiveAgent(doingCard.Path, repoPath, doingCard.AgentId ?? string.Empty);

        if (!_activeAgents.TryAdd(doingCard.Path, activeAgent))
        {
            _log.Warn($"Task is already active, skipping duplicate start: {doingCard.Path}");
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var runMode = string.IsNullOrWhiteSpace(doingCard.AgentId) ? AgentRunMode.New : AgentRunMode.Resume;
                var prompt = PromptFactory.Build(_paths.Root, doingCard.Path, repoPath, runMode);
                var result = await runner.RunAsync(
                    doingCard,
                    repoPath,
                    prompt,
                    async threadId =>
                    {
                        if (!string.IsNullOrWhiteSpace(threadId) &&
                            !string.Equals(doingCard.AgentId, threadId, StringComparison.OrdinalIgnoreCase))
                        {
                            doingCard = await doingCard.WithUpdatedAgentIdAsync(threadId, cancellationToken);
                        }
                    },
                    cancellationToken);

                await HandleAgentCompletionAsync(doingCard, result, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                _log.Info($"Agent task cancelled: {doingCard.Path}");
            }
            catch (Exception ex)
            {
                _log.Error($"Agent failure for `{doingCard.Path}`: {ex}");
                await BlockTaskForIssueAsync(doingCard, $"codex_runner failure while running Codex: {ex.Message}", cancellationToken);
            }
            finally
            {
                _activeAgents.TryRemove(doingCard.Path, out _);
                SignalScan();
            }
        }, CancellationToken.None);
    }

    private async Task<string> EnsureWorkingRepositoryAsync(TaskCard card, string repoUrl, CancellationToken cancellationToken)
    {
        var repoBaseDir = Path.Combine(_paths.ProjectsRoot, FileName.Sanitize(card.ProjectAlias));
        var preferredRepoFolderName = FileName.Sanitize(Path.GetFileNameWithoutExtension(card.FileName));

        if (!string.IsNullOrWhiteSpace(card.RepoPath))
        {
            var recordedPath = Path.GetFullPath(card.RepoPath);
            if (Directory.Exists(recordedPath))
            {
                if (PathStartsWith(recordedPath, _paths.CacheRoot))
                {
                    var restoredPath = MakeUniqueDirectoryPath(
                        repoBaseDir,
                        preferredRepoFolderName);
                    await _workspaceMover.MoveDirectoryAsync(recordedPath, restoredPath, cancellationToken);
                    await GitCli.RefreshAsync(restoredPath, _log, cancellationToken);
                    return restoredPath;
                }

                await GitCli.RefreshAsync(recordedPath, _log, cancellationToken);
                return recordedPath;
            }
        }

        var cacheProjectDir = Path.Combine(_paths.CacheRoot, FileName.Sanitize(card.ProjectAlias));
        if (Directory.Exists(cacheProjectDir))
        {
            var reusableRepo = Directory.EnumerateDirectories(cacheProjectDir)
                .OrderByDescending(path => Directory.GetLastWriteTimeUtc(path))
                .FirstOrDefault();

            if (!string.IsNullOrWhiteSpace(reusableRepo))
            {
                var restoredPath = MakeUniqueDirectoryPath(
                    repoBaseDir,
                    preferredRepoFolderName);
                await _workspaceMover.MoveDirectoryAsync(reusableRepo, restoredPath, cancellationToken);
                await GitCli.RefreshAsync(restoredPath, _log, cancellationToken);
                return restoredPath;
            }
        }

        Directory.CreateDirectory(repoBaseDir);

        var repoPath = MakeUniqueDirectoryPath(repoBaseDir, preferredRepoFolderName);
        await GitCli.CloneAsync(repoUrl, repoPath, _log, cancellationToken);
        return repoPath;
    }

    private async Task HandleAgentCompletionAsync(TaskCard card, CodexRunResult result, CancellationToken cancellationToken)
    {
        if (result.ExitCode != 0)
        {
            await BlockTaskForIssueAsync(card, $"Codex exited with code {result.ExitCode}. Check logs for details.", cancellationToken);
            return;
        }

        var status = PromptFactory.ParseStatus(result.FinalAgentMessage);
        switch (status)
        {
            case AgentOutcome.Done:
                var donePath = await MoveTaskAsync(card, TaskStep.Done, cancellationToken);
                _log.Info($"Task completed: {donePath}");
                _notifications.Show("Task complete", Path.GetFileName(donePath), donePath);
                break;

            case AgentOutcome.Blocked:
                var blockedPath = await MoveTaskAsync(card, TaskStep.Blocked, cancellationToken);
                _log.Info($"Task blocked: {blockedPath}");
                _notifications.Show("Task blocked", Path.GetFileName(blockedPath), blockedPath);
                break;

            default:
                if (TaskCard.Load(card.Path, TaskStep.Doing, _paths).HasMeaningfulComments)
                {
                    var inferredBlockedPath = await MoveTaskAsync(card, TaskStep.Blocked, cancellationToken);
                    _log.Warn($"No explicit status; inferred blocked from non-empty Comments: {inferredBlockedPath}");
                    _notifications.Show("Task blocked", Path.GetFileName(inferredBlockedPath), inferredBlockedPath);
                    break;
                }

                await BlockTaskForIssueAsync(card, "Codex finished without a parseable `ORCHESTRATOR_STATUS:` line.", cancellationToken);
                break;
        }
    }

    private async Task BlockTaskForIssueAsync(TaskCard card, string issue, CancellationToken cancellationToken)
    {
        var updatedCard = await card.AppendCommentTopicAsync($"[codex_runner] {issue}", cancellationToken);
        var blockedPath = await MoveTaskAsync(updatedCard, TaskStep.Blocked, cancellationToken);
        _log.Warn($"Moved task to blocked: {blockedPath}. Reason: {issue}");
        _notifications.Show("Task blocked", Path.GetFileName(blockedPath), blockedPath);
    }

    private async Task<string> MoveTaskAsync(TaskCard card, TaskStep destinationStep, CancellationToken cancellationToken)
    {
        if (card.Step == destinationStep)
        {
            return card.Path;
        }

        var sourceStepDir = _paths.StepDirectories[card.Step];
        var relative = Path.GetRelativePath(sourceStepDir, card.Path);
        var destinationPath = Path.Combine(_paths.StepDirectories[destinationStep], relative);
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);

        if (File.Exists(destinationPath))
        {
            destinationPath = MakeUniqueFilePath(destinationPath);
        }

        await _workspaceMover.MoveFileAsync(card.Path, destinationPath, cancellationToken);
        _log.Info($"Moved task: {card.Path} -> {destinationPath}");
        return destinationPath;
    }

    private IEnumerable<string> EnumerateStepTasks(TaskStep step)
    {
        var root = _paths.StepDirectories[step];
        if (!Directory.Exists(root))
        {
            yield break;
        }

        foreach (var file in Directory.EnumerateFiles(root, "*.md", SearchOption.AllDirectories)
                     .OrderBy(path => Path.GetRelativePath(root, path), PathTraits.Comparer))
        {
            yield return file;
        }
    }

    private IReadOnlyCollection<TaskRepositoryReference> LoadTaskRepositoryReferences()
    {
        var references = new List<TaskRepositoryReference>();
        foreach (var taskPath in Directory.EnumerateFiles(_paths.TasksRoot, "*.md", SearchOption.AllDirectories)
                     .OrderBy(path => path, PathTraits.Comparer))
        {
            if (IsTaskTemplatePath(taskPath))
            {
                continue;
            }

            if (TryInferManagedTaskStep(taskPath, out var step) &&
                TryLoadTaskCard(taskPath, step, out var managedCard) &&
                !string.IsNullOrWhiteSpace(managedCard.RepoPath))
            {
                references.Add(new TaskRepositoryReference(
                    managedCard.Path,
                    managedCard.ProjectAlias,
                    Path.GetFullPath(managedCard.RepoPath!),
                    managedCard.IsConfirmed,
                    managedCard));
                continue;
            }

            try
            {
                var content = File.ReadAllText(taskPath);
                var repoPath = TaskCard.ReadMetadataValue(content, "Repo");
                if (string.IsNullOrWhiteSpace(repoPath))
                {
                    continue;
                }

                references.Add(new TaskRepositoryReference(
                    taskPath,
                    TaskCard.ReadMetadataValue(content, "Project"),
                    Path.GetFullPath(repoPath),
                    false,
                    null));
            }
            catch (Exception ex)
            {
                _log.Warn($"Skipping unreadable task reference `{taskPath}`: {ex.Message}");
            }
        }

        return references;
    }

    private bool TryInferManagedTaskStep(string taskPath, out TaskStep step)
    {
        foreach (var pair in _paths.StepDirectories)
        {
            if (PathStartsWith(taskPath, pair.Value))
            {
                step = pair.Key;
                return true;
            }
        }

        step = default;
        return false;
    }

    private static bool IsTaskTemplatePath(string taskPath)
    {
        var fileName = Path.GetFileName(taskPath);
        return string.Equals(fileName, "template.md", StringComparison.OrdinalIgnoreCase)
            || string.Equals(fileName, "template-human.md", StringComparison.OrdinalIgnoreCase);
    }

    private HashSet<string> GetActiveRepositoryPaths() =>
        new(
            _activeAgents.Values
                .Select(agent => Path.GetFullPath(agent.RepoPath)),
            PathTraits.Comparer);

    private IEnumerable<string> EnumerateManagedRepositories(string root)
    {
        if (!Directory.Exists(root))
        {
            yield break;
        }

        foreach (var aliasDirectory in Directory.EnumerateDirectories(root)
                     .OrderBy(path => path, PathTraits.Comparer))
        {
            foreach (var repoDirectory in Directory.EnumerateDirectories(aliasDirectory)
                         .OrderBy(path => path, PathTraits.Comparer))
            {
                yield return Path.GetFullPath(repoDirectory);
            }
        }
    }

    private string? GetManagedProjectAlias(string repoPath)
    {
        foreach (var root in new[] { _paths.ProjectsRoot, _paths.CacheRoot, _paths.TrashRoot })
        {
            if (!PathStartsWith(repoPath, root))
            {
                continue;
            }

            var relativePath = Path.GetRelativePath(root, repoPath);
            var segments = relativePath.Split(
                new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries);

            if (segments.Length > 0)
            {
                return segments[0];
            }
        }

        return null;
    }

    private static string MakeUniqueDirectoryPath(string parentDirectory, string desiredName)
    {
        Directory.CreateDirectory(parentDirectory);
        var candidate = Path.Combine(parentDirectory, desiredName);
        if (!Directory.Exists(candidate) && !File.Exists(candidate))
        {
            return candidate;
        }

        var counter = 2;
        while (true)
        {
            var next = Path.Combine(parentDirectory, $"{desiredName}-{counter}");
            if (!Directory.Exists(next) && !File.Exists(next))
            {
                return next;
            }

            counter++;
        }
    }

    private static string MakeUniqueFilePath(string desiredPath)
    {
        if (!File.Exists(desiredPath))
        {
            return desiredPath;
        }

        var directory = Path.GetDirectoryName(desiredPath)!;
        var fileName = Path.GetFileNameWithoutExtension(desiredPath);
        var extension = Path.GetExtension(desiredPath);
        var counter = 2;
        while (true)
        {
            var next = Path.Combine(directory, $"{fileName}-{counter}{extension}");
            if (!File.Exists(next))
            {
                return next;
            }

            counter++;
        }
    }

    private static bool PathEquals(string left, string right) =>
        string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), PathTraits.Comparison);

    private static bool PathStartsWith(string candidate, string root)
    {
        var normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return normalizedCandidate.StartsWith(normalizedRoot, PathTraits.Comparison);
    }
}

sealed class WorkspaceMoveBridge
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromMilliseconds(1000);
    private readonly string _boardRoot;
    private readonly LogSink _log;

    public WorkspaceMoveBridge(string boardRoot, LogSink log)
    {
        _boardRoot = Path.GetFullPath(boardRoot);
        _log = log;
    }

    public async Task MoveFileAsync(string sourcePath, string destinationPath, CancellationToken cancellationToken)
    {
        if (PathEquals(sourcePath, destinationPath))
        {
            return;
        }

        if (await TryMoveViaExtensionAsync(sourcePath, destinationPath, "file", cancellationToken))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        File.Move(sourcePath, destinationPath);
    }

    public async Task MoveDirectoryAsync(string sourcePath, string destinationPath, CancellationToken cancellationToken)
    {
        if (PathEquals(sourcePath, destinationPath))
        {
            return;
        }

        if (await TryMoveViaExtensionAsync(sourcePath, destinationPath, "directory", cancellationToken))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        Directory.Move(sourcePath, destinationPath);
    }

    private async Task<bool> TryMoveViaExtensionAsync(string sourcePath, string destinationPath, string entryType, CancellationToken cancellationToken)
    {
        try
        {
            using var client = new NamedPipeClientStream(
                ".",
                WorkspaceMoveProtocol.GetPipeName(_boardRoot),
                PipeDirection.InOut,
                PipeOptions.Asynchronous);
            using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            connectCts.CancelAfter(ConnectTimeout);
            await client.ConnectAsync(connectCts.Token);

            using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: true)
            {
                AutoFlush = true
            };
            using var reader = new StreamReader(client, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);

            var request = new WorkspaceMoveRequest(
                1,
                "move",
                _boardRoot,
                Path.GetFullPath(sourcePath),
                Path.GetFullPath(destinationPath),
                entryType);
            await writer.WriteLineAsync(JsonSerializer.Serialize(request));

            using var responseCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            responseCts.CancelAfter(ResponseTimeout);
            var responseTask = reader.ReadLineAsync();
            var completedTask = await Task.WhenAny(responseTask, Task.Delay(Timeout.InfiniteTimeSpan, responseCts.Token));
            if (completedTask != responseTask)
            {
                return false;
            }

            var responseLine = await responseTask;
            if (string.IsNullOrWhiteSpace(responseLine))
            {
                return false;
            }

            var response = JsonSerializer.Deserialize<WorkspaceMoveResponse>(responseLine);
            if (response?.Ok == true)
            {
                return true;
            }

            if (!string.IsNullOrWhiteSpace(response?.Error))
            {
                _log.Warn($"VS Code move bridge rejected {entryType} move `{sourcePath}` -> `{destinationPath}`: {response.Error}");
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        catch (Exception ex)
        {
            _log.Warn($"VS Code move bridge failed for `{sourcePath}` -> `{destinationPath}`: {ex.Message}");
        }

        return false;
    }

    private static bool PathEquals(string left, string right) =>
        string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
}

static class WorkspaceMoveProtocol
{
    public static string GetPipeName(string boardRoot) => $"kanban-fs-mover-{HashPath(boardRoot)}";

    public static string NormalizePath(string path)
    {
        var normalized = Path.GetFullPath(path).Replace('\\', '/');
        if (normalized.Length > 3)
        {
            normalized = normalized.TrimEnd('/');
        }

        return normalized.ToLowerInvariant();
    }

    private static string HashPath(string path)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(NormalizePath(path)));
        return Convert.ToHexString(bytes[..8]).ToLowerInvariant();
    }
}

sealed record WorkspaceMoveRequest(
    int Version,
    string Command,
    string BoardRoot,
    string SourcePath,
    string DestinationPath,
    string EntryType);

sealed record WorkspaceMoveResponse(bool Ok, string? Error);

sealed class RunnerStatusServer
{
    private readonly string _rootPath;
    private readonly string _normalizedRootPath;
    private readonly string _kanbanPath;
    private readonly LogSink _log;
    private readonly int _processId = Process.GetCurrentProcess().Id;
    private readonly DateTimeOffset _startedAtUtc = DateTimeOffset.UtcNow;
    private readonly CancellationTokenSource _cts = new();
    private TcpListener? _listener;
    private Task? _acceptLoopTask;
    private int _port;

    public RunnerStatusServer(string rootPath, string kanbanPath, LogSink log)
    {
        _rootPath = Path.GetFullPath(rootPath);
        _normalizedRootPath = RunnerStatusProtocol.NormalizePath(_rootPath);
        _kanbanPath = Path.GetFullPath(kanbanPath);
        _log = log;
    }

    public void Start()
    {
        if (_listener is not null)
        {
            return;
        }

        foreach (var port in RunnerStatusProtocol.GetCandidatePorts(_rootPath))
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                _listener = listener;
                _port = port;
                _acceptLoopTask = Task.Run(AcceptLoopAsync);
                _log.Info($"Runner status endpoint listening on 127.0.0.1:{port}");
                return;
            }
            catch (SocketException)
            {
            }
        }

        _log.Warn("Failed to start runner status endpoint; all candidate localhost ports are in use.");
    }

    public async Task StopAsync()
    {
        _cts.Cancel();
        _listener?.Stop();
        if (_acceptLoopTask is not null)
        {
            try
            {
                await _acceptLoopTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
        }
        _cts.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        if (_listener is null)
        {
            return;
        }

        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_cts.Token);
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException) when (_cts.IsCancellationRequested)
            {
                break;
            }

            _ = Task.Run(() => WriteStatusAsync(client));
        }
    }

    private async Task WriteStatusAsync(TcpClient client)
    {
        using var _ = client;
        try
        {
            var payload = new RunnerStatusPayload(
                1,
                "kanban-runner-status",
                _rootPath,
                _normalizedRootPath,
                _kanbanPath,
                _processId,
                _startedAtUtc,
                DateTimeOffset.UtcNow,
                _port);
            var json = JsonSerializer.Serialize(payload);
            using var stream = client.GetStream();
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            await stream.WriteAsync(bytes, _cts.Token);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException or OperationCanceledException)
        {
        }
    }
}

static class RunnerStatusProtocol
{
    private const int PortBase = 41000;
    private const int PortRange = 20000;
    private const int PortStep = 997;
    private const int CandidateCount = 32;

    public static IEnumerable<int> GetCandidatePorts(string boardRoot)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(NormalizePath(boardRoot)));
        var seed = (hash[0] << 8) | hash[1];
        for (var index = 0; index < CandidateCount; index++)
        {
            yield return PortBase + ((seed + index * PortStep) % PortRange);
        }
    }

    public static string NormalizePath(string path)
    {
        var normalized = Path.GetFullPath(path).Replace('\\', '/');
        if (normalized.Length > 3)
        {
            normalized = normalized.TrimEnd('/');
        }

        return normalized.ToLowerInvariant();
    }
}

sealed record RunnerStatusPayload(
    int Version,
    string Kind,
    string RootPath,
    string NormalizedRootPath,
    string KanbanPath,
    int ProcessId,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    int Port);

sealed class CodexRunner
{
    private readonly OrchestratorSettings _settings;
    private readonly BoardPaths _paths;
    private readonly LogSink _log;
    private readonly string _codexExecutable;

    public CodexRunner(OrchestratorSettings settings, BoardPaths paths, LogSink log)
    {
        _settings = settings;
        _paths = paths;
        _log = log;
        _codexExecutable = ToolPaths.ResolveCodexExecutable();
    }

    public async Task<CodexRunResult> RunAsync(
        TaskCard card,
        string repoPath,
        string prompt,
        Func<string, Task>? onThreadStarted,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _codexExecutable,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = repoPath
        };

        if (string.IsNullOrWhiteSpace(card.AgentId))
        {
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--json");
            startInfo.ArgumentList.Add("-C");
            startInfo.ArgumentList.Add(repoPath);
            startInfo.ArgumentList.Add("--add-dir");
            startInfo.ArgumentList.Add(_paths.Root);
            AddCodexModeArguments(startInfo, _settings.CodexMode);
            startInfo.ArgumentList.Add("-");
        }
        else
        {
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("resume");
            startInfo.ArgumentList.Add(card.AgentId);
            startInfo.ArgumentList.Add("--json");
            AddCodexModeArguments(startInfo, _settings.CodexMode);
            startInfo.ArgumentList.Add("-");
        }

        using var process = new Process { StartInfo = startInfo };
        var stdout = new List<string>();
        var stderr = new List<string>();
        var threadId = string.Empty;
        var finalAgentMessage = string.Empty;
        var threadIdReported = false;

        process.Start();
        _log.Info($"Started Codex for task `{card.Path}` (pid {process.Id}).");
        await process.StandardInput.WriteAsync(prompt);
        await process.StandardInput.FlushAsync();
        process.StandardInput.Close();

        var stdoutTask = Task.Run(async () =>
        {
            while (!process.StandardOutput.EndOfStream)
            {
                var line = await process.StandardOutput.ReadLineAsync();
                if (line is null)
                {
                    break;
                }

                stdout.Add(line);
                TryParseCodexJsonLine(line, ref threadId, ref finalAgentMessage);

                if (!threadIdReported && !string.IsNullOrWhiteSpace(threadId) && onThreadStarted is not null)
                {
                    threadIdReported = true;
                    await onThreadStarted(threadId);
                }
            }
        }, cancellationToken);

        var stderrTask = Task.Run(async () =>
        {
            while (!process.StandardError.EndOfStream)
            {
                var line = await process.StandardError.ReadLineAsync();
                if (line is null)
                {
                    break;
                }

                stderr.Add(line);
                _log.Warn($"Codex stderr: {line}");
            }
        }, cancellationToken);

        await Task.WhenAll(stdoutTask, stderrTask, process.WaitForExitAsync(cancellationToken));

        foreach (var line in stdout.TakeLast(10))
        {
            _log.Info($"Codex stdout: {line}");
        }

        return new CodexRunResult(process.ExitCode, threadId, finalAgentMessage, stdout.ToArray(), stderr.ToArray());
    }

    private static void AddCodexModeArguments(ProcessStartInfo startInfo, CodexMode mode)
    {
        switch (mode)
        {
            case CodexMode.Dangerous:
                startInfo.ArgumentList.Add("--dangerously-bypass-approvals-and-sandbox");
                break;

            case CodexMode.FullAuto:
                startInfo.ArgumentList.Add("--full-auto");
                break;

            default:
                throw new ArgumentOutOfRangeException(nameof(mode), mode, null);
        }
    }

    private static void TryParseCodexJsonLine(string line, ref string threadId, ref string finalAgentMessage)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeProperty))
            {
                return;
            }

            var type = typeProperty.GetString();
            if (string.Equals(type, "thread.started", StringComparison.OrdinalIgnoreCase) &&
                root.TryGetProperty("thread_id", out var threadIdProperty))
            {
                threadId = threadIdProperty.GetString() ?? string.Empty;
                return;
            }

            if (!string.Equals(type, "item.completed", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!root.TryGetProperty("item", out var itemProperty))
            {
                return;
            }

            if (itemProperty.TryGetProperty("type", out var itemTypeProperty) &&
                string.Equals(itemTypeProperty.GetString(), "agent_message", StringComparison.OrdinalIgnoreCase) &&
                itemProperty.TryGetProperty("text", out var textProperty))
            {
                finalAgentMessage = textProperty.GetString() ?? string.Empty;
            }
        }
        catch
        {
        }
    }
}

sealed class NotificationService
{
    private readonly LogSink _log;

    public NotificationService(LogSink log)
    {
        _log = log;
    }

    public void Initialize()
    {
        // No startup work is required for best-effort native notifications.
    }

    public void Show(string title, string message, string taskPath)
    {
        var fullTaskPath = Path.GetFullPath(taskPath);

        try
        {
            if (OperatingSystem.IsWindows())
            {
                ShowWindowsToast(title, message, fullTaskPath);
                return;
            }

            if (OperatingSystem.IsLinux())
            {
                ShowLinuxNotification(title, message, fullTaskPath);
                return;
            }

            if (OperatingSystem.IsMacOS())
            {
                ShowMacNotification(title, message, fullTaskPath);
                return;
            }
        }
        catch (Exception ex)
        {
            _log.Warn($"Notification failed for `{fullTaskPath}`: {ex.Message}");
        }

        _log.Info($"Notification: {title} - {message} ({fullTaskPath})");
    }

    private void ShowWindowsToast(string title, string message, string taskPath)
    {
        var xml = BuildToastXml(title, message, taskPath);
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(xml));

        var script = "$xml=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "')); " +
                     "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; " +
                     "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null; " +
                     "$doc=New-Object Windows.Data.Xml.Dom.XmlDocument; " +
                     "$doc.LoadXml($xml); " +
                     "$toast=[Windows.UI.Notifications.ToastNotification]::new($doc); " +
                     "$notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('codex_runner'); " +
                     "$notifier.Show($toast);";

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-WindowStyle");
        startInfo.ArgumentList.Add("Hidden");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add(script);

        RunNotificationProcess(startInfo, "PowerShell", taskPath);
    }

    private void ShowLinuxNotification(string title, string message, string taskPath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "notify-send",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("--app-name=codex_runner");
        startInfo.ArgumentList.Add("--icon=dialog-information");
        startInfo.ArgumentList.Add(title);
        startInfo.ArgumentList.Add($"{message} ({taskPath})");

        RunNotificationProcess(startInfo, "notify-send", taskPath);
    }

    private void ShowMacNotification(string title, string message, string taskPath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "osascript",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("-e");
        startInfo.ArgumentList.Add($"display notification {ToAppleScriptString($"{message} ({taskPath})")} with title {ToAppleScriptString(title)}");

        RunNotificationProcess(startInfo, "osascript", taskPath);
    }

    private static string ToAppleScriptString(string value) =>
        "\"" + value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    private static void RunNotificationProcess(ProcessStartInfo startInfo, string toolName, string taskPath)
    {
        using var process = Process.Start(startInfo);
        if (process is null)
        {
            throw new InvalidOperationException($"Failed to start {toolName} for notification.");
        }

        process.WaitForExit(10000);
        var stderr = process.StandardError.ReadToEnd();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{toolName} exited with code {process.ExitCode} for `{taskPath}`: {stderr}");
        }
    }

    private static string BuildToastXml(string title, string message, string taskPath)
    {
        var taskUri = new Uri(taskPath).AbsoluteUri;
        return
            "<toast activationType=\"protocol\" launch=\"" + EscapeXml(taskUri) + "\">" +
            "<visual><binding template=\"ToastGeneric\">" +
            "<text>" + EscapeXml(title) + "</text>" +
            "<text>" + EscapeXml(message) + "</text>" +
            "</binding></visual></toast>";
    }

    private static string EscapeXml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);
}

sealed class LogSink
{
    private readonly object _gate = new();
    private readonly string _path;

    public LogSink(string path)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        var line = $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] {level} {message}";
        lock (_gate)
        {
            Console.WriteLine(line);
            File.AppendAllText(_path, line + Environment.NewLine, new UTF8Encoding(false));
        }
    }
}

sealed class TaskCard
{
    private static readonly Regex MetadataRegex = new(@"^(?<key>[A-Za-z][A-Za-z0-9 _-]*):[ \t]*(?<value>.*)$", RegexOptions.Multiline | RegexOptions.Compiled);
    private readonly BoardPaths _paths;
    private readonly string _content;

    private TaskCard(string path, TaskStep step, BoardPaths paths, string content)
    {
        Path = path;
        Step = step;
        _paths = paths;
        _content = content;
        FileName = System.IO.Path.GetFileName(path);
        ProjectAlias = GetMetadataValue("Project") ?? string.Empty;
        AgentId = GetMetadataValue("Agent");
        RepoPath = GetMetadataValue("Repo");
        CommentsBody = GetSectionBody("Comments");
        if (string.IsNullOrWhiteSpace(CommentsBody))
        {
            CommentsBody = GetSectionBody("WIP");
        }

        ReportBody = GetSectionBody("Report", 3);
        if (string.IsNullOrWhiteSpace(ReportBody))
        {
            ReportBody = GetSectionBody("Report");
        }

        DescriptionBody = GetSectionBody("Description");
    }

    public string Path { get; }
    public string FileName { get; }
    public TaskStep Step { get; }
    public string ProjectAlias { get; }
    public string? AgentId { get; }
    public string? RepoPath { get; }
    public string CommentsBody { get; }
    public string ReportBody { get; }
    public string DescriptionBody { get; }
    public bool HasMeaningfulComments => HasMeaningfulBody(CommentsBody);
    public bool IsConfirmed => Step is TaskStep.Confirmed;

    public static TaskCard Load(string path, TaskStep step, BoardPaths paths)
    {
        var content = File.ReadAllText(path);
        return new TaskCard(path, step, paths, content);
    }

    public static string? ReadMetadataValue(string content, string key)
    {
        foreach (Match match in MetadataRegex.Matches(content))
        {
            if (string.Equals(match.Groups["key"].Value.Trim(), key, StringComparison.OrdinalIgnoreCase))
            {
                var value = match.Groups["value"].Value.Trim();
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
        }

        return null;
    }

    public async Task<TaskCard> WithUpdatedAgentIdAsync(string agentId, CancellationToken cancellationToken)
    {
        var updatedContent = EnsureTaskTemplate(_content);
        updatedContent = SetMetadataValue(updatedContent, "Agent", agentId);
        await WriteAsync(updatedContent, cancellationToken);
        return Load(Path, Step, _paths);
    }

    public async Task<TaskCard> WithUpdatedRepoPathAsync(string repoPath, CancellationToken cancellationToken)
    {
        var updatedContent = EnsureTaskTemplate(_content);
        updatedContent = SetMetadataValue(updatedContent, "Repo", repoPath);
        await WriteAsync(updatedContent, cancellationToken);
        return Load(Path, Step, _paths);
    }

    public async Task<TaskCard> AppendCommentTopicAsync(string note, CancellationToken cancellationToken)
    {
        var updatedContent = EnsureTaskTemplate(_content);
        var existing = GetSectionBody(updatedContent, "Comments");
        var topic = FormatCommentTopic(note);
        var newComments = string.IsNullOrWhiteSpace(existing)
            ? topic
            : existing.TrimEnd() + Environment.NewLine + "===" + Environment.NewLine + topic;
        updatedContent = SetSectionBody(updatedContent, "Comments", newComments);
        await WriteAsync(updatedContent, cancellationToken);
        return Load(Path, Step, _paths);
    }

    private async Task WriteAsync(string content, CancellationToken cancellationToken)
    {
        await File.WriteAllTextAsync(Path, content, new UTF8Encoding(false), cancellationToken);
    }

    private string? GetMetadataValue(string key)
    {
        return ReadMetadataValue(_content, key);
    }

    private string GetSectionBody(string heading, int level = 2) => GetSectionBody(_content, heading, level);

    private static string GetSectionBody(string content, string heading, int level = 2)
    {
        var match = Regex.Match(
            content,
            $@"(?ms)^{Regex.Escape(new string('#', level))}\s+{Regex.Escape(heading)}\s*\r?\n(?<body>.*?)(?=^#{{1,6}}\s+|\z)");
        return match.Success ? match.Groups["body"].Value.Trim() : string.Empty;
    }

    private static string EnsureTaskTemplate(string content)
    {
        var updated = content;
        updated = EnsureMetadataLine(updated, "Project");
        updated = EnsureMetadataLine(updated, "Agent");
        updated = EnsureMetadataLine(updated, "Repo");
        updated = MigrateLegacySections(updated);
        updated = EnsureSection(updated, "Description");
        updated = EnsureSection(updated, "Comments");
        updated = EnsureSection(updated, "Report", 3);
        return updated;
    }

    private static string EnsureMetadataLine(string content, string key)
    {
        if (Regex.IsMatch(content, $@"(?m)^{Regex.Escape(key)}:[ \t]*.*$"))
        {
            return content;
        }

        var insertion = $"{key}: {Environment.NewLine}";
        var firstHeadingIndex = content.IndexOf("## ", StringComparison.Ordinal);
        if (firstHeadingIndex >= 0)
        {
            return content.Insert(firstHeadingIndex, insertion);
        }

        return insertion + content;
    }

    private static string SetMetadataValue(string content, string key, string value)
    {
        if (Regex.IsMatch(content, $@"(?m)^{Regex.Escape(key)}:[ \t]*.*$"))
        {
            return Regex.Replace(content, $@"(?m)^{Regex.Escape(key)}:[ \t]*.*$", $"{key}: {value}");
        }

        return EnsureMetadataLine(content, key).Replace($"{key}: {Environment.NewLine}", $"{key}: {value}{Environment.NewLine}", StringComparison.Ordinal);
    }

    private static string EnsureSection(string content, string heading, int level = 2)
    {
        var marker = Regex.Escape(new string('#', level));
        if (Regex.IsMatch(content, $@"(?m)^{marker}\s+{Regex.Escape(heading)}\s*$"))
        {
            return content;
        }

        var suffix = content.EndsWith(Environment.NewLine, StringComparison.Ordinal) ? string.Empty : Environment.NewLine;
        return content + suffix + $"{new string('#', level)} {heading}{Environment.NewLine}{Environment.NewLine}";
    }

    private static string SetSectionBody(string content, string heading, string body, int level = 2)
    {
        content = EnsureSection(content, heading, level);
        var marker = Regex.Escape(new string('#', level));
        var normalizedBody = body.Trim();
        var pattern = $@"(?ms)^{marker}\s+{Regex.Escape(heading)}\s*\r?\n.*?(?=^#{{1,6}}\s+|\z)";
        var replacement = string.IsNullOrWhiteSpace(normalizedBody)
            ? $"{new string('#', level)} {heading}{Environment.NewLine}{Environment.NewLine}"
            : $"{new string('#', level)} {heading}{Environment.NewLine}{normalizedBody}{Environment.NewLine}{Environment.NewLine}";
        return Regex.Replace(content, pattern, replacement);
    }

    private static string MigrateLegacySections(string content)
    {
        var updated = content;
        updated = MigrateLegacyWip(updated);
        updated = MigrateLegacyReport(updated);
        return updated;
    }

    private static string MigrateLegacyWip(string content)
    {
        if (!HasSection(content, "WIP"))
        {
            return content;
        }

        var legacyBody = GetSectionBody(content, "WIP");
        if (!HasSection(content, "Comments"))
        {
            return Regex.Replace(content, @"(?m)^##\s+WIP\s*$", "## Comments");
        }

        var mergedComments = MergeBodies(GetSectionBody(content, "Comments"), legacyBody);
        var updated = SetSectionBody(content, "Comments", mergedComments);
        return RemoveSection(updated, "WIP");
    }

    private static string MigrateLegacyReport(string content)
    {
        if (!HasSection(content, "Report"))
        {
            return content;
        }

        if (HasSection(content, "Report", 3))
        {
            return RemoveSection(content, "Report");
        }

        return Regex.Replace(content, @"(?m)^##\s+Report\s*$", "### Report");
    }

    private static bool HasSection(string content, string heading, int level = 2)
    {
        var marker = Regex.Escape(new string('#', level));
        return Regex.IsMatch(content, $@"(?m)^{marker}\s+{Regex.Escape(heading)}\s*$");
    }

    private static string RemoveSection(string content, string heading, int level = 2)
    {
        var marker = Regex.Escape(new string('#', level));
        var updated = Regex.Replace(
            content,
            $@"(?ms)^{marker}\s+{Regex.Escape(heading)}\s*\r?\n.*?(?=^#{{1,6}}\s+|\z)",
            string.Empty);

        return updated.TrimEnd() + Environment.NewLine;
    }

    private static string MergeBodies(string existing, string additional)
    {
        if (!HasMeaningfulBody(existing))
        {
            return additional.Trim();
        }

        if (!HasMeaningfulBody(additional))
        {
            return existing.Trim();
        }

        return existing.TrimEnd() + Environment.NewLine + "===" + Environment.NewLine + additional.Trim();
    }

    private static string FormatCommentTopic(string note)
    {
        var lines = note
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line =>
            {
                var trimmed = line.Trim();
                return trimmed.StartsWith(">", StringComparison.Ordinal)
                    ? trimmed.TrimStart('>', ' ')
                    : trimmed;
            })
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Select(line => $"> {line}")
            .ToArray();

        return string.Join(Environment.NewLine, lines);
    }

    private static bool HasMeaningfulBody(string body) =>
        body.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
            .Select(line => line.Trim())
            .Any(line => !string.IsNullOrWhiteSpace(line) && !string.Equals(line, "===", StringComparison.Ordinal));
}

static class PromptFactory
{
    private static readonly Regex StatusRegex = new(@"(?im)^ORCHESTRATOR_STATUS:\s*(?<value>BLOCKED|DONE)\s*$", RegexOptions.Compiled);

    public static string Build(string boardRoot, string taskPath, string repoPath, AgentRunMode runMode)
    {
        var action = runMode == AgentRunMode.New
            ? "Start the task from scratch."
            : "Resume the existing session, reread the task file, and continue from the current state.";
        var readmePath = Path.Combine(boardRoot, "README.md");
        var contextPath = Path.Combine(boardRoot, "context.md");
        const string workingDirectoryToken = "{working directory}";
        return $"""
You are handling a kanban task for a local `codex_runner` board.

Board root: {boardRoot}
Task file: {taskPath}
Repository path: {repoPath}
Board README: {readmePath}
Shared context: {contextPath}
`{workingDirectoryToken}` means `{boardRoot}`.
Requirements:
- Read the task file, `{workingDirectoryToken}/README.md`, and `{workingDirectoryToken}/context.md` before doing any work.
- Follow `{workingDirectoryToken}/context.md` for task-card conventions, question formatting, and report handling.
- Work only inside the repository path and the task file.
- Do not change `Project:`, `Agent:`, or `Repo:` lines.
- Keep `## Comments` and `### Report` aligned with the current state.
- Do not move the task file between folders; `codex_runner` does that.

Lifecycle instruction:
- {action}
- If you are blocked, finish your final message with:
  ORCHESTRATOR_STATUS: BLOCKED
  ORCHESTRATOR_SUMMARY: <one sentence>
- If you are done, finish your final message with:
  ORCHESTRATOR_STATUS: DONE
  ORCHESTRATOR_SUMMARY: <one sentence>

The final status block must be present exactly once.
""";
    }

    public static AgentOutcome ParseStatus(string message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return AgentOutcome.Unknown;
        }

        var match = StatusRegex.Match(message);
        if (!match.Success)
        {
            return AgentOutcome.Unknown;
        }

        return match.Groups["value"].Value.ToUpperInvariant() switch
        {
            "BLOCKED" => AgentOutcome.Blocked,
            "DONE" => AgentOutcome.Done,
            _ => AgentOutcome.Unknown
        };
    }
}

static class GitCli
{
    public static Task CloneAsync(string repoUrl, string destination, LogSink log, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        return RunAsync(new[] { "clone", repoUrl, destination }, log, cancellationToken);
    }

    public static async Task RefreshAsync(string repoPath, LogSink log, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(Path.Combine(repoPath, ".git")))
        {
            return;
        }

        await RunAsync(new[] { "-C", repoPath, "fetch", "--all", "--prune" }, log, cancellationToken, tolerateFailure: true);
        await RunAsync(new[] { "-C", repoPath, "pull", "--ff-only" }, log, cancellationToken, tolerateFailure: true);
    }

    private static async Task RunAsync(IReadOnlyList<string> arguments, LogSink log, CancellationToken cancellationToken, bool tolerateFailure = false)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "git",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(cancellationToken);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (!string.IsNullOrWhiteSpace(stdout))
        {
            log.Info(stdout.Trim());
        }

        if (!string.IsNullOrWhiteSpace(stderr))
        {
            log.Warn(stderr.Trim());
        }

        if (process.ExitCode != 0 && !tolerateFailure)
        {
            throw new InvalidOperationException($"git {string.Join(" ", arguments)} failed with exit code {process.ExitCode}");
        }
    }
}

sealed class ProjectMap : Dictionary<string, string>
{
    private ProjectMap() : base(StringComparer.OrdinalIgnoreCase)
    {
    }

    public static ProjectMap Load(string path, LogSink log)
    {
        var result = new ProjectMap();

        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }

            var separatorIndex = line.IndexOf('=');
            if (separatorIndex < 0)
            {
                log.Warn($"Ignoring malformed projects.md line: {line}");
                continue;
            }

            var alias = line[..separatorIndex].Trim();
            var repoUrl = line[(separatorIndex + 1)..].Trim();

            if (string.IsNullOrWhiteSpace(alias) || string.IsNullOrWhiteSpace(repoUrl))
            {
                log.Warn($"Ignoring malformed projects.md line: {line}");
                continue;
            }

            result[alias] = repoUrl;
        }

        return result;
    }
}

sealed class BoardPaths
{
    public BoardPaths(string root)
    {
        Root = Path.GetFullPath(root);
        TasksRoot = Path.Combine(Root, "tasks");
        ProjectsRoot = Path.Combine(Root, "projects");
        CacheRoot = Path.Combine(Root, "cache");
        TrashRoot = Path.Combine(Root, "trash");
        LogsRoot = Path.Combine(Root, "logs");
        GitIgnorePath = Path.Combine(Root, ".gitignore");
        ContextPath = Path.Combine(Root, "context.md");
        ProjectsMapPath = Path.Combine(Root, "projects.md");
        KanbanMarkerPath = Path.Combine(TasksRoot, ".kanban");
        TaskTemplatePath = Path.Combine(TasksRoot, "template.md");
        var newRoot = Path.Combine(TasksRoot, "new");
        var backlogRoot = Path.Combine(TasksRoot, "backlog");
        var doingRoot = Path.Combine(TasksRoot, "doing");
        var blockedRoot = Path.Combine(TasksRoot, "blocked");
        var doneRoot = Path.Combine(TasksRoot, "done");
        var confirmedRoot = Path.Combine(TasksRoot, "confirmed");
        KanbanFolders = new[]
        {
            new KanbanFolder("new", newRoot),
            new KanbanFolder("backlog", backlogRoot),
            new KanbanFolder("doing", doingRoot),
            new KanbanFolder("blocked", blockedRoot),
            new KanbanFolder("done", doneRoot),
            new KanbanFolder("confirmed", confirmedRoot)
        };
        StepDirectories = new Dictionary<TaskStep, string>
        {
            [TaskStep.Backlog] = backlogRoot,
            [TaskStep.Doing] = doingRoot,
            [TaskStep.Blocked] = blockedRoot,
            [TaskStep.Done] = doneRoot,
            [TaskStep.Confirmed] = confirmedRoot
        };
        RequiredDirectories = new[]
        {
            TasksRoot,
            ProjectsRoot,
            CacheRoot,
            TrashRoot,
            LogsRoot,
            newRoot,
            backlogRoot,
            doingRoot,
            blockedRoot,
            doneRoot,
            confirmedRoot
        };
    }

    public string Root { get; }
    public string TasksRoot { get; }
    public string ProjectsRoot { get; }
    public string CacheRoot { get; }
    public string TrashRoot { get; }
    public string LogsRoot { get; }
    public string GitIgnorePath { get; }
    public string ContextPath { get; }
    public string ProjectsMapPath { get; }
    public string KanbanMarkerPath { get; }
    public string TaskTemplatePath { get; }
    public IReadOnlyList<KanbanFolder> KanbanFolders { get; }
    public IReadOnlyList<string> RequiredDirectories { get; }
    public IReadOnlyDictionary<TaskStep, string> StepDirectories { get; }
}

sealed class OrchestratorSettings
{
    private OrchestratorSettings(string rootPath, string invocationDirectory, int maxAgents, TimeSpan pollInterval, bool runOnce, CodexMode codexMode)
    {
        RootPath = rootPath;
        InvocationDirectory = invocationDirectory;
        MaxAgents = maxAgents;
        PollInterval = pollInterval;
        RunOnce = runOnce;
        CodexMode = codexMode;
    }

    public string RootPath { get; }
    public string InvocationDirectory { get; }
    public int MaxAgents { get; }
    public TimeSpan PollInterval { get; }
    public bool RunOnce { get; }
    public CodexMode CodexMode { get; }

    public static OrchestratorSettings Parse(string[] args, string defaultRoot)
    {
        var root = defaultRoot;
        var maxAgents = 5;
        var pollInterval = TimeSpan.FromSeconds(10);
        var runOnce = false;
        var codexMode = CodexMode.Dangerous;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--root":
                    root = ReadNextValue(args, ref index, "--root");
                    break;

                case "--max-agents":
                    maxAgents = int.Parse(ReadNextValue(args, ref index, "--max-agents"));
                    break;

                case "--poll-seconds":
                    pollInterval = TimeSpan.FromSeconds(int.Parse(ReadNextValue(args, ref index, "--poll-seconds")));
                    break;

                case "--once":
                    runOnce = true;
                    break;

                case "--codex-mode":
                    codexMode = Enum.Parse<CodexMode>(ReadNextValue(args, ref index, "--codex-mode"), ignoreCase: true);
                    break;

                case "--help":
                case "-h":
                    PrintUsage();
                    Environment.Exit(0);
                    break;

                default:
                    throw new ArgumentException($"Unknown argument: {args[index]}");
            }
        }

        if (maxAgents < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxAgents), "Max agents must be at least 1.");
        }

        return new OrchestratorSettings(root, defaultRoot, maxAgents, pollInterval, runOnce, codexMode);
    }

    private static string ReadNextValue(string[] args, ref int index, string optionName)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException($"Missing value for {optionName}.");
        }

        index++;
        return args[index];
    }

    private static void PrintUsage()
    {
        Console.WriteLine(
            """
            Usage:
              codex_runner.csx [options]
              dotnet script codex_runner.csx -- [options]

            Options:
              --root <path>           Board root. Defaults to the current directory.
              --max-agents <n>        Maximum active Codex agents. Defaults to 5.
              --poll-seconds <n>      Full reconciliation interval. Defaults to 10.
              --codex-mode <mode>     `Dangerous` or `FullAuto`. Defaults to `Dangerous`.
              --once                  Run a single reconciliation pass and exit.
              --help                  Show this help.
            """);
    }
}

sealed record ActiveAgent(string TaskPath, string RepoPath, string AgentId);

sealed record TaskRepositoryReference(
    string TaskPath,
    string? ProjectAlias,
    string RepoPath,
    bool IsConfirmed,
    TaskCard? ManagedCard);

sealed record CodexRunResult(
    int ExitCode,
    string ThreadId,
    string FinalAgentMessage,
    IReadOnlyList<string> StdoutLines,
    IReadOnlyList<string> StderrLines);

enum TaskStep
{
    Backlog,
    Doing,
    Blocked,
    Done,
    Confirmed
}

enum CodexMode
{
    Dangerous,
    FullAuto
}

enum AgentRunMode
{
    New,
    Resume
}

enum AgentOutcome
{
    Unknown,
    Blocked,
    Done
}

static class FileName
{
    private static readonly Regex InvalidCharsRegex = new($"[{Regex.Escape(new string(Path.GetInvalidFileNameChars()))}]+", RegexOptions.Compiled);

    public static string Sanitize(string value)
    {
        var sanitized = InvalidCharsRegex.Replace(value, "-").Trim();
        return string.IsNullOrWhiteSpace(sanitized) ? "item" : sanitized;
    }

}

sealed record KanbanFolder(string Name, string Path);

static class PathTraits
{
    public static StringComparer Comparer { get; } =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public static StringComparison Comparison { get; } =
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}

static class BoardTemplates
{
    public static string ProjectsTemplate =>
        "# alias = https://github.com/org/repo" + Environment.NewLine;

    private static string DefaultGitIgnoreTemplate =>
        """
        projects/
        cache/
        trash/
        logs/
        """;

    private static string DefaultContextTemplate =>
        """
        # Task Agent Context

        Read this file, the `{working directory}/README.md`, and the task file before doing any work.

        ## General rules

        - Work only inside the assigned repository path and the task file.
        - Don't push anything unless explicitly asked.
        - Don't commit unless explicitly asked.
        - If you do commit, use a short informative message without a prefix like `fix` or `chore`.
        - Keep task markdown tidy.
        - Read `{working directory}/knowledge/README.md` and check whether any linked reference is relevant to the task.
        - Confirm you use up to date branches, pull if needed.
        - Use default branch like master or main (stash changes if present, nothing should be there, checkout the branch, pull), if specific one is not mentioned.
        - If a cached repo contains uncommitted changes, stash them all so no changed will interfere with new task! Mention it in the task
        - When asked to checkout a branch or merge another branch then use most recent state available at remote by default, if not asked to use local branch

        ## Task file conventions

        - Keep `## Description` as the durable task record.
        - When a question is resolved, fold the answer into `## Description` and trim stale items from `## Comments`.
        - Use `## Comments` only for open questions, blockers, or missing context.
        - Every non-empty line in `## Comments` must start with `> `.
        - Separate unrelated comment topics with a line that is exactly `===`.
        - Use `### Report` for completion notes, handoff details, or a concise summary of what changed.
        - Leave `## Comments` empty when the task is not blocked and no user input is needed.
        - Interpret cited comments (>  ...) as yours, if they don't make sense ignore them
        - Improve markdown

        ## Final message

        - End with exactly one status block.
        - If blocked:
        `ORCHESTRATOR_STATUS: BLOCKED`
        `ORCHESTRATOR_SUMMARY: <one sentence>`
        - If done:
        `ORCHESTRATOR_STATUS: DONE`
        `ORCHESTRATOR_SUMMARY: <one sentence>`
        """;

    private static string DefaultTaskTemplate =>
        """
        # {{TITLE}}

        Tags: 
        Project: {{CURSOR}}

        ## Description


        """;

    public static string ResolveContextTemplate(string invocationDirectory) =>
        ReadSeedFile(invocationDirectory, "context.md", DefaultContextTemplate);

    public static string ResolveTaskTemplate(string invocationDirectory) =>
        ReadSeedFile(invocationDirectory, Path.Combine("tasks", "template.md"), DefaultTaskTemplate);

    public static string ResolveGitIgnoreTemplate(string invocationDirectory) =>
        ReadSeedFile(invocationDirectory, ".gitignore", DefaultGitIgnoreTemplate);

    public static string CreateKanbanConfig(IEnumerable<KanbanFolder> folders)
    {
        var builder = new StringBuilder();
        builder.AppendLine("folders:");

        foreach (var folder in folders)
        {
            builder.Append("  ")
                .Append(folder.Name)
                .Append(": ")
                .Append(folder.Name)
                .AppendLine();
        }

        return builder.ToString();
    }

    private static string ReadSeedFile(string invocationDirectory, string relativePath, string fallback)
    {
        var candidatePath = Path.Combine(invocationDirectory, relativePath);
        if (File.Exists(candidatePath))
        {
            return File.ReadAllText(candidatePath);
        }

        return fallback;
    }
}

static class ToolPaths
{
    public static string ResolveCodexExecutable()
    {
        var candidates = new List<string>();

        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            candidates.Add(Path.Combine(directory, "codex.exe"));
            candidates.Add(Path.Combine(directory, "codex.cmd"));
            candidates.Add(Path.Combine(directory, "codex.bat"));
            candidates.Add(Path.Combine(directory, "codex"));
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(home))
        {
            candidates.Add(Path.Combine(home, ".codex", ".sandbox-bin", "codex.exe"));
            candidates.Add(Path.Combine(home, ".codex", ".sandbox-bin", "codex"));
        }

        foreach (var candidate in candidates.Distinct(PathTraits.Comparer))
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("Unable to locate a Codex executable on PATH or in ~/.codex/.sandbox-bin.");
    }
}
