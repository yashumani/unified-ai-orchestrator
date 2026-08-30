#requires -Version 7.4

param(
  [switch]$ReleaseAclWorker,
  [string]$ReleaseAclContainmentRoot,
  [string]$ReleaseAclRoot,
  [string]$ReleaseAclIdentitySid,
  [string]$ReleaseAclAllowedReparsePathsBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:DeploymentCommonPath = $PSCommandPath

$script:CanonicalRepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
$script:CanonicalHealthUri = "http://127.0.0.1:8790/api/ready"
$script:CanonicalLivenessUri = "http://127.0.0.1:8790/api/health"
$script:CanonicalReadyUri = $script:CanonicalHealthUri
$script:CanonicalTaskName = "UnifiedAIOrchestrator-Local"
$script:CanonicalRunnerTaskName = "UnifiedAIOrchestrator-GitHubRunner"
$script:CanonicalRunnerRepositoryUrl = "https://github.com/yashumani/unified-ai-orchestrator"
$script:CanonicalIcaclsPath = "C:\Windows\System32\icacls.exe"
$script:CanonicalControllerVersion = "1.0.1"
$script:SupportedControllerVersions = @("1.0.0", $script:CanonicalControllerVersion)
$script:CanonicalDeploymentTaskDescription = "Supervises the loopback-only Unified AI Orchestrator release selected by the repository deployment pointer."
$script:CanonicalRunnerTaskDescription = "Pinned repository-scoped GitHub Actions runner for Unified AI Orchestrator local production."
$script:PinnedRunnerVersion = "2.337.0"
$script:PinnedRunnerArchiveSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"
$script:PinnedRunnerArchiveUrl = "https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip"
$script:PinnedNodeVersion = "22.23.2"
$script:PinnedNodeArchiveName = "node-v22.23.2-win-x64.zip"
$script:PinnedNodeArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$script:PinnedNodeArchiveUrl = "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip"
$script:ShaPattern = "^[0-9a-f]{40}$"
$script:RuntimeAttestationKind = "npm-lock-graph-v1"
$script:BundledRuntimeAttestationKind = "esbuild-bundle-v1"
$script:BundledRuntimeBuilderVersion = "0.28.2"
$script:BundledRuntimeFeatureGuard = "copilotkit-channels-disabled-v1"
$script:BundledRuntimeResolutionGuard = "node-builtins-only-v1"
$script:BundledRuntimeBuilderPackageIntegrity = "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA=="
$script:BundledRuntimePath = "apps/api/dist/server.bundle.mjs"
$script:BundledRuntimeBuildReceiptPath = "apps/api/dist/server.bundle.json"
$script:RuntimeAttestationGraphTimeoutSeconds = 120
$script:RuntimeAttestationReleaseProtectionTimeoutSeconds = 1800
$script:RuntimeAttestationSealProtectionTimeoutSeconds = 30
$script:RuntimeAttestationAclProtectionKind = "explicit-entry-dacl-v1"
$script:RuntimeAttestationMaximumAclEntries = 300000
$script:CriticalReleasePayloadPaths = @(
  "package.json",
  "package-lock.json",
  "apps/api/package.json",
  "apps/api/dist/server.js",
  "apps/web/dist/index.html"
)
$script:BundledRuntimeCriticalPayloadPaths = @(
  $script:CriticalReleasePayloadPaths
  $script:BundledRuntimePath
  $script:BundledRuntimeBuildReceiptPath
)

function Assert-CanonicalRepositoryRoot {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $resolved = [System.IO.Path]::GetFullPath($RepositoryRoot)
  if (-not [string]::Equals(
      $resolved.TrimEnd("\"),
      $script:CanonicalRepositoryRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "RepositoryRoot must be the canonical repository path $script:CanonicalRepositoryRoot."
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "Canonical repository root does not exist: $resolved"
  }
  return $script:CanonicalRepositoryRoot
}

function Assert-CommitSha {
  param([Parameter(Mandatory)][string]$CommitSha)

  if ($CommitSha -cnotmatch $script:ShaPattern) {
    throw "Commit SHA must be exactly 40 lowercase hexadecimal characters."
  }
  return $CommitSha
}

function Assert-CanonicalTaskName {
  param([Parameter(Mandatory)][string]$TaskName)

  if ($TaskName -cne $script:CanonicalTaskName) {
    throw "TaskName is pinned to $script:CanonicalTaskName."
  }
  return $TaskName
}

function Assert-CanonicalRunnerTaskName {
  param([Parameter(Mandatory)][string]$TaskName)

  if ($TaskName -cne $script:CanonicalRunnerTaskName) {
    throw "Runner TaskName is pinned to $script:CanonicalRunnerTaskName."
  }
  return $TaskName
}

function Assert-CanonicalHealthUri {
  param([Parameter(Mandatory)][string]$HealthUri)

  if ($HealthUri -cne $script:CanonicalHealthUri) {
    throw "HealthUri is pinned to the loopback endpoint $script:CanonicalHealthUri."
  }
  return $HealthUri
}

function Assert-SupportedControllerVersion {
  param([Parameter(Mandatory)][string]$ControllerVersion)

  if ($ControllerVersion -cnotmatch "^\d+\.\d+\.\d+$" -or
      $ControllerVersion -cnotin $script:SupportedControllerVersions) {
    throw "Recovery controller version is not in the reviewed transition allowlist: $ControllerVersion"
  }
  return $ControllerVersion
}

function Enter-DeploymentMutex {
  param([int]$TimeoutSeconds = 15)

  $mutex = [System.Threading.Mutex]::new($false, "Global\UnifiedAIOrchestratorDeploymentState")
  $acquired = $false
  $abandoned = $false
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
    $abandoned = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw "Another local deployment operation holds the deployment-state lock."
  }
  Add-Member -InputObject $mutex -NotePropertyName WasAbandoned -NotePropertyValue $abandoned
  return $mutex
}

function Enter-DeploymentTransactionMutex {
  param([int]$TimeoutSeconds = 15)

  $mutex = [System.Threading.Mutex]::new($false, "Global\UnifiedAIOrchestratorDeploymentTransaction")
  $acquired = $false
  $abandoned = $false
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
    $abandoned = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw "Another deploy or rollback operation is already running."
  }
  Add-Member -InputObject $mutex -NotePropertyName WasAbandoned -NotePropertyValue $abandoned
  return $mutex
}

function Exit-DeploymentMutex {
  param([System.Threading.Mutex]$Mutex)

  if ($null -ne $Mutex) {
    try {
      $Mutex.ReleaseMutex()
    } finally {
      $Mutex.Dispose()
    }
  }
}

function New-BoundedProcessJob {
  if ($null -eq ("UnifiedAiOrchestratorDeployment.NativeKillOnCloseJob" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace UnifiedAiOrchestratorDeployment
{
    public sealed class NativeKillOnCloseJob : IDisposable
    {
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private IntPtr handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            uint informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public NativeKillOnCloseJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create bounded process job.");
            }
            var information = new ExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf<ExtendedLimitInformation>();
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)length))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure bounded process job.");
                }
            }
            catch
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void AddProcess(Process process)
        {
            if (handle == IntPtr.Zero || process == null || !AssignProcessToJobObject(handle, process.Handle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to assign child process to bounded job.");
            }
        }

        public void Terminate()
        {
            if (handle != IntPtr.Zero && !TerminateJobObject(handle, 1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to terminate bounded process job.");
            }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~NativeKillOnCloseJob()
        {
            Dispose();
        }
    }
}
'@
  }
  return [UnifiedAiOrchestratorDeployment.NativeKillOnCloseJob]::new()
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$ArgumentList,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][ValidateRange(1, 1800)][int]$TimeoutSeconds,
    [Parameter(Mandatory)][ValidateRange(1024, 16777216)][int]$MaxOutputCharacters,
    [Parameter(Mandatory)][string]$Context,
    [ValidateRange(0, 300)][int]$IdleTimeoutSeconds = 0,
    [switch]$EchoOutput
  )

  $resolvedFile = [System.IO.Path]::GetFullPath($FilePath)
  $resolvedWorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory)
  if (-not (Test-Path -LiteralPath $resolvedFile -PathType Leaf) -or
      -not (Test-Path -LiteralPath $resolvedWorkingDirectory -PathType Container)) {
    throw "$Context executable or working directory is unavailable."
  }
  foreach ($path in @($resolvedFile, $resolvedWorkingDirectory)) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Context executable and working directory must not be reparse points."
    }
  }

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $resolvedFile
  $startInfo.WorkingDirectory = $resolvedWorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $ArgumentList) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $job = $null
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $job = New-BoundedProcessJob
    if (-not $process.Start()) {
      throw "$Context did not start."
    }
    try {
      $job.AddProcess($process)
    } catch {
      if (-not $process.HasExited) {
        $process.Kill($true)
        [void]$process.WaitForExit(10000)
      }
      throw "$Context could not enter its kill-on-close job: $($_.Exception.Message)"
    }
    $stopProcessTree = {
      $job.Terminate()
      if (-not $process.HasExited) {
        try {
          $process.Kill($true)
        } catch {
          throw "$Context process tree could not be terminated: $($_.Exception.Message)"
        }
      }
      if (-not $process.WaitForExit(10000)) {
        throw "$Context process tree did not exit after termination."
      }
    }
    $stdoutBuilder = [System.Text.StringBuilder]::new()
    $stderrBuilder = [System.Text.StringBuilder]::new()
    $stdoutBuffer = [char[]]::new(4096)
    $stderrBuffer = [char[]]::new(4096)
    $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
    $stdoutDone = $false
    $stderrDone = $false
    $lastOutputMilliseconds = [int64]0
    while (-not ($stdoutDone -and $stderrDone -and $process.HasExited)) {
      if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        & $stopProcessTree
        throw "$Context exceeded its $TimeoutSeconds-second bound."
      }
      if ($IdleTimeoutSeconds -gt 0 -and
          ($timer.ElapsedMilliseconds - $lastOutputMilliseconds) -ge ($IdleTimeoutSeconds * 1000)) {
        & $stopProcessTree
        throw "$Context made no observable progress for $IdleTimeoutSeconds seconds."
      }
      $madeProgress = $false
      if (-not $stdoutDone -and $stdoutRead.IsCompleted) {
        $count = $stdoutRead.GetAwaiter().GetResult()
        $madeProgress = $true
        if ($count -eq 0) {
          $stdoutDone = $true
        } else {
          if (($stdoutBuilder.Length + $stderrBuilder.Length + $count) -gt $MaxOutputCharacters) {
            & $stopProcessTree
            throw "$Context combined output exceeded its reviewed bound."
          }
          [void]$stdoutBuilder.Append($stdoutBuffer, 0, $count)
          $lastOutputMilliseconds = [int64]$timer.ElapsedMilliseconds
          if ($EchoOutput) {
            Write-Host -NoNewline ([string]::new($stdoutBuffer, 0, $count))
          }
          $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        }
      }
      if (-not $stderrDone -and $stderrRead.IsCompleted) {
        $count = $stderrRead.GetAwaiter().GetResult()
        $madeProgress = $true
        if ($count -eq 0) {
          $stderrDone = $true
        } else {
          if (($stdoutBuilder.Length + $stderrBuilder.Length + $count) -gt $MaxOutputCharacters) {
            & $stopProcessTree
            throw "$Context combined output exceeded its reviewed bound."
          }
          [void]$stderrBuilder.Append($stderrBuffer, 0, $count)
          $lastOutputMilliseconds = [int64]$timer.ElapsedMilliseconds
          if ($EchoOutput) {
            Write-Host -NoNewline ([string]::new($stderrBuffer, 0, $count))
          }
          $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        }
      }
      if (-not $madeProgress) {
        [System.Threading.Thread]::Sleep(10)
      }
    }
    [void]$process.WaitForExit()
    return [ordered]@{
      exitCode = $process.ExitCode
      stdout = $stdoutBuilder.ToString()
      stderr = $stderrBuilder.ToString()
      elapsedMilliseconds = [int64]$timer.ElapsedMilliseconds
    }
  } finally {
    $timer.Stop()
    if ($null -ne $job) {
      $job.Dispose()
    }
    $process.Dispose()
  }
}

function Get-DeploymentLayout {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $root = Join-Path $RepositoryRoot ".local\deployment"
  return [ordered]@{
    Root = $root
    Releases = Join-Path $root "releases"
    Staging = Join-Path $root "staging"
    Failed = Join-Path $root "failed"
    State = Join-Path $root "state"
    Backups = Join-Path $root "backups"
    Logs = Join-Path $root "logs"
    Downloads = Join-Path $root "downloads"
    Toolchains = Join-Path $root "toolchains"
    NodeRuntimeRoot = Join-Path $root "toolchains\node-v22.23.2-win-x64"
    Controllers = Join-Path $root "controllers"
    RuntimeIntegrity = Join-Path $root "state\runtime-dependencies"
    RunnerRoot = Join-Path $root "github-runner\2.337.0"
    Current = Join-Path $root "current.json"
    Previous = Join-Path $root "previous.json"
    Pending = Join-Path $root "pending.json"
    ReleaseInstallationPending = Join-Path $root "state\release-installation-pending.json"
    Process = Join-Path $root "state\process.json"
    TaskInstallation = Join-Path $root "state\local-production-task-installation.json"
    ControllerInstallation = Join-Path $root "state\recovery-controller-installation.json"
    ControllerInstallationPending = Join-Path $root "state\recovery-controller-installation-pending.json"
    ControllerActivationPending = Join-Path $root "state\controller-activation-pending.json"
    LastKnownGoodController = Join-Path $root "state\last-known-good-controller.json"
    RunnerInstallation = Join-Path $root "state\github-runner-installation.json"
    NodeRuntimeInstallation = Join-Path $root "state\node-runtime-installation.json"
    NodeRuntimeInstallationPending = Join-Path $root "state\node-runtime-installation-pending.json"
    RunnerProcess = Join-Path $root "state\github-runner-process.json"
    Events = Join-Path $root "logs\deployment-events.jsonl"
  }
}

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path,
    [switch]$AllowRoot
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
  $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $equals = [string]::Equals(
    $rootFull,
    $pathFull,
    [System.StringComparison]::OrdinalIgnoreCase
  )
  $contained = $pathFull.StartsWith(
    "$rootFull\",
    [System.StringComparison]::OrdinalIgnoreCase
  )
  if ((-not $contained) -and (-not ($AllowRoot -and $equals))) {
    throw "Unsafe path outside deployment root: $pathFull"
  }
  $current = $rootFull
  if (Test-Path -LiteralPath $current) {
    $rootItem = Get-Item -LiteralPath $current -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Contained path root must not be a reparse point: $current"
    }
  }
  if (-not $equals) {
    $relative = [System.IO.Path]::GetRelativePath($rootFull, $pathFull)
    foreach ($segment in $relative.Split("\")) {
      $current = Join-Path $current $segment
      if (-not (Test-Path -LiteralPath $current)) {
        break
      }
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Contained path cannot traverse a reparse point: $current"
      }
    }
  }
  return $pathFull
}

function Assert-TreeContainsNoReparsePoints {
  param([Parameter(Mandatory)][string]$Root)

  if (-not (Test-Path -LiteralPath $Root)) {
    return
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Path tree root must not be a reparse point: $Root"
  }
  if (-not $rootItem.PSIsContainer) {
    return
  }
  $directories = [System.Collections.Generic.Stack[string]]::new()
  $directories.Push($rootItem.FullName)
  while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Path tree contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $directories.Push($child.FullName)
      }
    }
  }
}

function Assert-NoForeignDeploymentPendingRecords {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [string[]]$AllowedPaths = @()
  )

  $allowed = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $AllowedPaths) {
    [void]$allowed.Add([System.IO.Path]::GetFullPath($path))
  }
  $pendingRecords = [ordered]@{
    activation = $Layout.Pending
    releaseInstallation = $Layout.ReleaseInstallationPending
    controllerInstallation = $Layout.ControllerInstallationPending
    controllerActivation = $Layout.ControllerActivationPending
    nodeRuntimeInstallation = $Layout.NodeRuntimeInstallationPending
  }
  foreach ($entry in $pendingRecords.GetEnumerator()) {
    if (Test-Path -LiteralPath ([string]$entry.Value)) {
      $fullPath = [System.IO.Path]::GetFullPath([string]$entry.Value)
      if (-not $allowed.Contains($fullPath)) {
        throw "Unresolved $([string]$entry.Key) pending record blocks this transaction: $fullPath"
      }
    }
  }
}

function Assert-NoDeploymentReparsePoints {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $repository = Get-Item -LiteralPath $script:CanonicalRepositoryRoot -Force
  if (($repository.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Canonical repository root must not be a reparse point."
  }

  foreach ($path in @(
      (Join-Path $script:CanonicalRepositoryRoot ".local"),
      $Layout.Root,
      $Layout.Releases,
      $Layout.Staging,
      $Layout.Failed,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      $Layout.Toolchains,
      $Layout.NodeRuntimeRoot,
      $Layout.Controllers,
      $Layout.RuntimeIntegrity,
      (Split-Path -Parent $Layout.RunnerRoot),
      $Layout.RunnerRoot
    )) {
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Deployment path must not be a reparse point: $path"
      }
    }
  }
}

function Initialize-DeploymentLayout {
  param([Parameter(Mandatory)][hashtable]$Layout)

  foreach ($path in @(
      $Layout.Root,
      $Layout.Releases,
      $Layout.Staging,
      $Layout.Failed,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      $Layout.Toolchains,
      $Layout.Controllers,
      $Layout.RuntimeIntegrity,
      (Split-Path -Parent $Layout.RunnerRoot)
    )) {
    [void](Assert-ContainedPath -Root $Layout.Root -Path $path -AllowRoot)
    [void](New-Item -ItemType Directory -Path $path -Force)
  }
  Assert-NoDeploymentReparsePoints -Layout $Layout
}

function Invoke-GitText {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  $output = & git.exe -C $RepositoryRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return (($output -join "`n").Trim())
}

function Assert-DeploymentSource {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  $head = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @("rev-parse", "HEAD")
  if ($head -cne $ExpectedSha) {
    throw "Canonical repository HEAD $head does not match expected deployment SHA $ExpectedSha."
  }
  $branch = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @("branch", "--show-current")
  if ($branch -cne "main") {
    throw "Local-production deployment is allowed only from branch main; current branch is $branch."
  }
  $status = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @(
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  )
  if ($status.Length -ne 0) {
    throw "Canonical repository must be clean before deployment."
  }
  return [ordered]@{ head = $head; branch = $branch; clean = $true }
}

function ConvertTo-JsonText {
  param([Parameter(Mandatory)][object]$Value)

  return ($Value | ConvertTo-Json -Depth 100)
}

function Write-AtomicJson {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][object]$Value
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  $parent = Split-Path -Parent $Path
  [void](New-Item -ItemType Directory -Path $parent -Force)
  $temporary = Join-Path $parent ".$([System.IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp"
  [void](Assert-ContainedPath -Root $Layout.Root -Path $temporary)
  try {
    [System.IO.File]::WriteAllText(
      $temporary,
      "$(ConvertTo-JsonText -Value $Value)`n",
      [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::Move($temporary, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function ConvertFrom-DeploymentJsonHashtable {
  param([Parameter(Mandatory)][string]$Json)

  try {
    $convertFromJson = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($convertFromJson.Parameters.ContainsKey("DateKind")) {
      return ($Json | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String)
    }
    return ($Json | ConvertFrom-Json -AsHashtable -Depth 100)
  } catch {
    throw "Invalid JSON content: $($_.Exception.Message)"
  }
}

function Read-JsonHashtable {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required JSON file does not exist: $Path"
  }
  try {
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return (ConvertFrom-DeploymentJsonHashtable -Json $json)
  } catch {
    throw "Invalid JSON file $Path`: $($_.Exception.Message)"
  }
}

function Assert-UtcTimestamp {
  param(
    [Parameter(Mandatory)][string]$Value,
    [string]$Context = "timestamp"
  )

  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed
    ) -or $parsed.Offset -ne [TimeSpan]::Zero) {
    throw "$Context must be a UTC ISO-8601 timestamp."
  }
  return $parsed
}

function Write-DeploymentEvent {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Action,
    [Parameter(Mandatory)][ValidateSet("started", "succeeded", "failed", "info")][string]$Status,
    [string]$CommitSha,
    [string]$OperationId,
    [string]$Message
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.Events)
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Layout.Events) -Force)
  $event = [ordered]@{
    schemaVersion = 1
    occurredAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    action = $Action
    status = $Status
    commitSha = $CommitSha
    operationId = $OperationId
    message = if ($null -eq $Message) { "" } else { $Message.Substring(0, [Math]::Min(500, $Message.Length)) }
  }
  [System.IO.File]::AppendAllText(
    $Layout.Events,
    "$(ConvertTo-JsonText -Value $event)`n",
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Assert-SafeWindowsPathSegment {
  param(
    [Parameter(Mandatory)][string]$Segment,
    [string]$Context = "path"
  )

  $hasControlCharacter = $false
  foreach ($character in $Segment.ToCharArray()) {
    if ([int][char]$character -lt 32) {
      $hasControlCharacter = $true
      break
    }
  }
  $invalidCharacters = [char[]]'<>:"/\|?*'
  $deviceName = $Segment.Split('.')[0].ToUpperInvariant()
  if (
    $Segment.Length -eq 0 -or
    $Segment.Length -gt 255 -or
    $hasControlCharacter -or
    $Segment.IndexOfAny($invalidCharacters) -ge 0 -or
    $Segment.EndsWith(".", [System.StringComparison]::Ordinal) -or
    $Segment.EndsWith(" ", [System.StringComparison]::Ordinal) -or
    $deviceName -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$'
  ) {
    throw "Unsafe Windows $Context segment: $Segment"
  }
  return $Segment
}

function Assert-SafePayloadPath {
  param(
    [Parameter(Mandatory)][string]$RelativePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  if (
    $RelativePath.Length -eq 0 -or
    $RelativePath.Length -gt 240 -or
    $RelativePath.Contains("\") -or
    $RelativePath.StartsWith("/") -or
    $RelativePath.Contains([char]0)
  ) {
    throw "Unsafe release payload path: $RelativePath"
  }
  $segments = $RelativePath.Split("/")
  if ($segments | Where-Object { $_ -in @("", ".", "..") }) {
    throw "Unsafe release payload path: $RelativePath"
  }
  foreach ($segment in $segments) {
    [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "release payload path")
  }
  $lower = $RelativePath.ToLowerInvariant()
  if (
    $lower -eq ".env" -or
    $lower.StartsWith(".env.") -or
    $lower -eq ".git" -or
    $lower.StartsWith(".git/") -or
    $lower -eq ".local" -or
    $lower.StartsWith(".local/") -or
    $lower -eq "node_modules" -or
    $lower.StartsWith("node_modules/") -or
    $lower.StartsWith("data/raw/") -or
    $lower.StartsWith("sources/private/") -or
    $lower.StartsWith("sources/chatgpt/")
  ) {
    throw "Forbidden release payload path: $RelativePath"
  }
  $candidate = Join-Path $DestinationRoot ($RelativePath.Replace("/", "\"))
  return (Assert-ContainedPath -Root $DestinationRoot -Path $candidate)
}

function Assert-ReleaseManifest {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Manifest,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  $requiredKeys = @(
    "schemaVersion",
    "commitSha",
    "createdAtUtc",
    "nodeVersion",
    "packageLockSha256",
    "payloadSha256"
  )
  $keys = @($Manifest.Keys)
  if (@($keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $keys }).Count -ne 0) {
    throw "release-manifest.json must contain only the six documented release fields."
  }
  if ([int]$Manifest.schemaVersion -ne 1) {
    throw "Unsupported release manifest schemaVersion."
  }
  [void](Assert-CommitSha -CommitSha ([string]$Manifest.commitSha))
  if ([string]$Manifest.commitSha -cne $ExpectedSha) {
    throw "Release manifest SHA does not match ExpectedSha."
  }
  $createdAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
      [string]$Manifest.createdAtUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$createdAt
    ) -or $createdAt.Offset -ne [TimeSpan]::Zero) {
    throw "Release manifest createdAtUtc must be a UTC timestamp."
  }
  if ([string]$Manifest.nodeVersion -notmatch "^v?\d+\.\d+\.\d+") {
    throw "Release manifest nodeVersion is invalid."
  }
  if ([string]$Manifest.packageLockSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Release manifest packageLockSha256 is invalid."
  }
  if ($Manifest.payloadSha256 -isnot [System.Collections.IDictionary]) {
    throw "Release manifest payloadSha256 must be an object."
  }
  if ($Manifest.payloadSha256.Count -lt 5 -or $Manifest.payloadSha256.Count -gt 10000) {
    throw "Release manifest payload file count is outside the allowed range."
  }
  foreach ($entry in $Manifest.payloadSha256.GetEnumerator()) {
    if ([string]$entry.Value -cnotmatch "^[0-9a-f]{64}$") {
      throw "Invalid SHA-256 for release payload path $($entry.Key)."
    }
  }
  foreach ($requiredPath in @(
      "package.json",
      "package-lock.json",
      "apps/api/package.json",
      "apps/api/dist/server.js",
      "apps/web/dist/index.html"
    )) {
    if (-not $Manifest.payloadSha256.Contains($requiredPath)) {
      throw "Release payload is missing required file $requiredPath."
    }
  }
  if ([string]$Manifest.payloadSha256["package-lock.json"] -cne [string]$Manifest.packageLockSha256) {
    throw "packageLockSha256 does not match the payload hash for package-lock.json."
  }
}

function Test-ReleaseArchive {
  param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  $artifact = [System.IO.Path]::GetFullPath($ArtifactPath)
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Release artifact does not exist: $artifact"
  }
  if ([System.IO.Path]::GetExtension($artifact) -cne ".zip") {
    throw "Release artifact must be a .zip file."
  }

  $archive = [System.IO.Compression.ZipFile]::OpenRead($artifact)
  try {
    $entries = [System.Collections.Generic.Dictionary[string, System.IO.Compression.ZipArchiveEntry]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($entry in $archive.Entries) {
      if ($entry.Name.Length -eq 0) {
        [void](Assert-SafePayloadPath -RelativePath $entry.FullName.TrimEnd("/") -DestinationRoot "C:\release-validation")
        continue
      }
      $safeName = $entry.FullName
      [void](Assert-SafePayloadPath -RelativePath $safeName -DestinationRoot "C:\release-validation")
      if (-not $entries.TryAdd($safeName, $entry)) {
        throw "Release archive contains a duplicate path: $safeName"
      }
    }
    if (-not $entries.ContainsKey("release-manifest.json")) {
      throw "Release archive is missing root release-manifest.json."
    }
    $manifestEntry = $entries["release-manifest.json"]
    $stream = $manifestEntry.Open()
    try {
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true, 1024, $true)
      try {
        $manifest = ConvertFrom-DeploymentJsonHashtable -Json ($reader.ReadToEnd())
      } finally {
        $reader.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    Assert-ReleaseManifest -Manifest $manifest -ExpectedSha $ExpectedSha

    $expectedEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void]$expectedEntries.Add("release-manifest.json")
    foreach ($payload in $manifest.payloadSha256.GetEnumerator()) {
      $path = [string]$payload.Key
      [void](Assert-SafePayloadPath -RelativePath $path -DestinationRoot "C:\release-validation")
      [void]$expectedEntries.Add($path)
      if (-not $entries.ContainsKey($path)) {
        throw "Release archive is missing manifest payload path $path."
      }
      $payloadStream = $entries[$path].Open()
      try {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
          $actual = [Convert]::ToHexString($hasher.ComputeHash($payloadStream)).ToLowerInvariant()
        } finally {
          $hasher.Dispose()
        }
      } finally {
        $payloadStream.Dispose()
      }
      if ($actual -cne [string]$payload.Value) {
        throw "Release archive hash mismatch for $path."
      }
    }
    foreach ($entryName in $entries.Keys) {
      if (-not $expectedEntries.Contains($entryName)) {
        throw "Release archive contains an undeclared file: $entryName"
      }
    }
    return $manifest
  } finally {
    $archive.Dispose()
  }
}

function Expand-ValidatedReleaseArchive {
  param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($ArtifactPath))
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.Name.Length -eq 0) {
        continue
      }
      $target = Assert-SafePayloadPath -RelativePath $entry.FullName -DestinationRoot $DestinationRoot
      $parent = Split-Path -Parent $target
      [void](New-Item -ItemType Directory -Path $parent -Force)
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $input.CopyTo($output)
        } finally {
          $output.Dispose()
        }
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-ReleaseDirectory {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $relativeRoot = [System.IO.Path]::GetRelativePath($Layout.Root, $ReleaseRoot).Replace("\", "/")
  if (-not ($relativeRoot.StartsWith("releases/") -or $relativeRoot.StartsWith("staging/"))) {
    throw "Release validation path must be under deployment releases or staging."
  }
  $manifestPath = Join-Path $ReleaseRoot "release-manifest.json"
  $manifest = Read-JsonHashtable -Path $manifestPath
  Assert-ReleaseManifest -Manifest $manifest -ExpectedSha $ExpectedSha
  foreach ($payload in $manifest.payloadSha256.GetEnumerator()) {
    $path = Assert-SafePayloadPath -RelativePath ([string]$payload.Key) -DestinationRoot $ReleaseRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Installed release is missing payload path $($payload.Key)."
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne [string]$payload.Value) {
      throw "Installed release hash mismatch for $($payload.Key)."
    }
  }
  return $manifest
}

function Get-CriticalReleasePayloadAttestation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [string[]]$PayloadPaths = $script:CriticalReleasePayloadPaths
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $releaseItem = Get-Item -LiteralPath $releaseRootFull -Force
  if (-not $releaseItem.PSIsContainer -or
      ($releaseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Installed release root must be a non-reparse directory."
  }
  $manifestPath = Join-Path $releaseRootFull "release-manifest.json"
  $manifest = Read-JsonHashtable -Path $manifestPath
  Assert-ReleaseManifest -Manifest $manifest -ExpectedSha $ExpectedSha
  $criticalHashes = [ordered]@{}
  if ($PayloadPaths.Count -lt 5 -or $PayloadPaths.Count -gt 64 -or
      @($PayloadPaths | Select-Object -Unique).Count -ne $PayloadPaths.Count) {
    throw "Critical release payload path contract is invalid."
  }
  foreach ($relativePath in $PayloadPaths) {
    $payloadPath = Assert-SafePayloadPath -RelativePath $relativePath -DestinationRoot $releaseRootFull
    if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
      throw "Installed release is missing critical payload path $relativePath."
    }
    $payloadItem = Get-Item -LiteralPath $payloadPath -Force
    if (($payloadItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Critical release payload cannot be a reparse point: $relativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne [string]$manifest.payloadSha256[$relativePath]) {
      throw "Installed release hash mismatch for critical payload $relativePath."
    }
    $criticalHashes[$relativePath] = $actualHash
  }
  return [ordered]@{
    manifest = $manifest
    manifestPath = $manifestPath
    releaseManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    packageLockSha256 = [string]$criticalHashes["package-lock.json"]
    criticalPayloadSha256 = $criticalHashes
  }
}

function Get-BundledRuntimeContainedPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$RelativePath
  )

  if ($RelativePath.Length -lt 1 -or
      $RelativePath.Length -gt 240 -or
      [System.IO.Path]::IsPathRooted($RelativePath) -or
      $RelativePath.Contains([char]0)) {
    throw "Bundled runtime relative path is invalid: $RelativePath"
  }
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $pathFull = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
  $relative = [System.IO.Path]::GetRelativePath($rootFull, $pathFull)
  if ($relative -ceq ".." -or
      $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::Ordinal) -or
      [System.IO.Path]::IsPathRooted($relative)) {
    throw "Bundled runtime path escaped its reviewed root: $pathFull"
  }
  return $pathFull
}

function Assert-BundledRuntimeRegularFile {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][uint64]$MinimumBytes,
    [Parameter(Mandatory)][uint64]$MaximumBytes
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  $relative = [System.IO.Path]::GetRelativePath($rootFull, $pathFull)
  if ($relative -ceq ".." -or
      $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::Ordinal) -or
      [System.IO.Path]::IsPathRooted($relative)) {
    throw "Bundled runtime path escaped its reviewed root: $pathFull"
  }
  if (-not (Test-Path -LiteralPath $pathFull -PathType Leaf)) {
    throw "Bundled runtime regular file is missing: $pathFull"
  }
  $leaf = Get-Item -LiteralPath $pathFull -Force
  if ([uint64]$leaf.Length -lt $MinimumBytes -or [uint64]$leaf.Length -gt $MaximumBytes) {
    throw "Bundled runtime regular file is outside its reviewed size bound: $pathFull"
  }
  $currentPath = $pathFull
  while ($true) {
    $currentItem = Get-Item -LiteralPath $currentPath -Force
    if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Bundled runtime path cannot contain a reparse point: $currentPath"
    }
    $pathComparison = if ([System.OperatingSystem]::IsWindows()) {
      [System.StringComparison]::OrdinalIgnoreCase
    } else {
      [System.StringComparison]::Ordinal
    }
    if ([string]::Equals(
        [System.IO.Path]::GetFullPath($currentPath).TrimEnd(
          [System.IO.Path]::DirectorySeparatorChar,
          [System.IO.Path]::AltDirectorySeparatorChar
        ),
        $rootFull,
        $pathComparison
      )) {
      break
    }
    $parent = [System.IO.Directory]::GetParent($currentPath)
    if ($null -eq $parent) {
      throw "Bundled runtime path escaped its reviewed root: $pathFull"
    }
    $currentPath = $parent.FullName
  }
  return $leaf
}

function Read-StrictBundledRuntimeBuildReceipt {
  param(
    [Parameter(Mandatory)][string]$Path
  )

  $receiptBytes = [System.IO.File]::ReadAllBytes($Path)
  $options = [System.Text.Json.JsonDocumentOptions]::new()
  $options.AllowTrailingCommas = $false
  $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
  $options.MaxDepth = 8
  try {
    $memory = [System.ReadOnlyMemory[byte]]::new($receiptBytes)
    $document = [System.Text.Json.JsonDocument]::Parse($memory, $options)
  } catch {
    throw "Bundled runtime build receipt is not strict JSON: $($_.Exception.Message)"
  }
  try {
    if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
      throw "Bundled runtime build receipt must be one JSON object."
    }
    $requiredKeys = @(
      "schemaVersion", "buildKind", "builder", "builderVersion", "builderPackageIntegrity",
      "builderBinaryPackage", "builderBinaryIntegrity", "entrypoint", "output",
      "platform", "format", "target", "nodeVersion", "buildPlatform", "buildArchitecture",
      "requireBridge", "runtimeFeatureGuard", "runtimeResolutionGuard", "bundleSha256",
      "bundleBytes"
    )
    $required = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($requiredKey in $requiredKeys) {
      [void]$required.Add($requiredKey)
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $receipt = [ordered]@{}
    foreach ($property in $document.RootElement.EnumerateObject()) {
      if (-not $seen.Add($property.Name)) {
        throw "Bundled runtime build receipt contains a duplicate key: $($property.Name)"
      }
      if (-not $required.Contains($property.Name)) {
        throw "Bundled runtime build receipt contains an unreviewed key: $($property.Name)"
      }
      if ($property.Name -ceq "schemaVersion") {
        $value = 0
        if ($property.Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or
            -not $property.Value.TryGetInt32([ref]$value)) {
          throw "Bundled runtime schemaVersion must be a JSON integer."
        }
        $receipt[$property.Name] = $value
      } elseif ($property.Name -ceq "bundleBytes") {
        [uint64]$value = 0
        if ($property.Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or
            -not $property.Value.TryGetUInt64([ref]$value)) {
          throw "Bundled runtime bundleBytes must be a JSON unsigned integer."
        }
        $receipt[$property.Name] = $value
      } else {
        if ($property.Value.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
          throw "Bundled runtime receipt field $($property.Name) must be a JSON string."
        }
        $receipt[$property.Name] = $property.Value.GetString()
      }
    }
    if ($seen.Count -ne $required.Count -or
        @($requiredKeys | Where-Object { -not $seen.Contains($_) }).Count -ne 0) {
      throw "Bundled runtime build receipt is missing a required exact-case key."
    }
    return $receipt
  } finally {
    $document.Dispose()
  }
}

function Read-BundledRuntimeBuildReceipt {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot
  )

  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $receiptPath = Get-BundledRuntimeContainedPath `
    -Root $releaseRootFull `
    -RelativePath $script:BundledRuntimeBuildReceiptPath
  $bundlePath = Get-BundledRuntimeContainedPath `
    -Root $releaseRootFull `
    -RelativePath $script:BundledRuntimePath
  $packageLockPath = Get-BundledRuntimeContainedPath `
    -Root $releaseRootFull `
    -RelativePath "package-lock.json"
  [void](Assert-BundledRuntimeRegularFile -Root $releaseRootFull -Path $receiptPath -MinimumBytes 1 -MaximumBytes 65536)
  $bundle = Assert-BundledRuntimeRegularFile -Root $releaseRootFull -Path $bundlePath -MinimumBytes 1 -MaximumBytes 104857600
  [void](Assert-BundledRuntimeRegularFile -Root $releaseRootFull -Path $packageLockPath -MinimumBytes 1 -MaximumBytes 104857600)
  $receipt = Read-StrictBundledRuntimeBuildReceipt -Path $receiptPath
  if ([int]$receipt.schemaVersion -ne 2 -or
      [string]$receipt.buildKind -cne $script:BundledRuntimeAttestationKind -or
      [string]$receipt.builder -cne "esbuild" -or
      [string]$receipt.builderVersion -cne $script:BundledRuntimeBuilderVersion -or
      [string]$receipt.builderPackageIntegrity -cne $script:BundledRuntimeBuilderPackageIntegrity -or
      [string]$receipt.entrypoint -cne "apps/api/dist/server.js" -or
      [string]$receipt.output -cne $script:BundledRuntimePath -or
      [string]$receipt.platform -cne "node" -or
      [string]$receipt.format -cne "esm" -or
      [string]$receipt.target -cne "node22" -or
      [string]$receipt.nodeVersion -cne "v$($script:PinnedNodeVersion)" -or
      [string]$receipt.buildArchitecture -cne "x64" -or
      [string]$receipt.requireBridge -cne "node-builtins-only-require-v1" -or
      [string]$receipt.runtimeFeatureGuard -cne $script:BundledRuntimeFeatureGuard -or
      [string]$receipt.runtimeResolutionGuard -cne $script:BundledRuntimeResolutionGuard -or
      [string]$receipt.bundleSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [uint64]$receipt.bundleBytes -lt 1 -or
      [uint64]$receipt.bundleBytes -gt 104857600) {
    throw "Bundled runtime build receipt does not match the reviewed production contract."
  }
  $builderBinaryValid = (
    ([string]$receipt.builderBinaryPackage -ceq "@esbuild/linux-x64" -and
      [string]$receipt.builderBinaryIntegrity -ceq "sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==" -and
      [string]$receipt.buildPlatform -ceq "linux") -or
    ([string]$receipt.builderBinaryPackage -ceq "@esbuild/win32-x64" -and
      [string]$receipt.builderBinaryIntegrity -ceq "sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==" -and
      [string]$receipt.buildPlatform -ceq "win32")
  )
  if (-not $builderBinaryValid) {
    throw "Bundled runtime build receipt does not identify a reviewed esbuild platform binary."
  }
  $bundleSha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([uint64]$bundle.Length -ne [uint64]$receipt.bundleBytes -or
      $bundleSha256 -cne [string]$receipt.bundleSha256) {
    throw "Bundled runtime bytes do not match their deterministic build receipt."
  }
  $packageLock = Read-JsonHashtable -Path $packageLockPath
  $builderBinaryLockPath = "node_modules/$([string]$receipt.builderBinaryPackage)"
  if (-not $packageLock.Contains("packages") -or
      $packageLock.packages -isnot [System.Collections.IDictionary] -or
      -not $packageLock.packages.Contains("") -or
      $packageLock.packages[""].devDependencies -isnot [System.Collections.IDictionary] -or
      [string]$packageLock.packages[""].devDependencies.esbuild -cne $script:BundledRuntimeBuilderVersion -or
      -not $packageLock.packages.Contains("node_modules/esbuild") -or
      [string]$packageLock.packages["node_modules/esbuild"].version -cne $script:BundledRuntimeBuilderVersion -or
      [string]$packageLock.packages["node_modules/esbuild"].integrity -cne $script:BundledRuntimeBuilderPackageIntegrity -or
      -not $packageLock.packages.Contains($builderBinaryLockPath) -or
      [string]$packageLock.packages[$builderBinaryLockPath].version -cne $script:BundledRuntimeBuilderVersion -or
      [string]$packageLock.packages[$builderBinaryLockPath].integrity -cne [string]$receipt.builderBinaryIntegrity) {
    throw "package-lock.json does not pin the reviewed bundled-runtime builder and selected binary."
  }
  return [ordered]@{
    receipt = $receipt
    receiptPath = $receiptPath
    bundlePath = $bundlePath
    bundleSha256 = $bundleSha256
    bundleBytes = [uint64]$bundle.Length
  }
}

function Get-BundledRuntimeCriticalPaths {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot
  )

  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $paths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($relativePath in @("release-manifest.json", "runtime-integrity.json") + $script:BundledRuntimeCriticalPayloadPaths) {
    $path = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull $relativePath))
    [void](Assert-ContainedPath -Root $releaseRootFull -Path $path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Bundled runtime critical path is missing: $relativePath"
    }
    [void]$paths.Add($path)
  }
  if ($paths.Count -lt 8 -or $paths.Count -gt 64) {
    throw "Bundled runtime critical-path count is outside the reviewed range."
  }
  $orderedPaths = [System.Collections.Generic.List[string]]::new()
  foreach ($path in $paths) {
    $orderedPaths.Add($path)
  }
  $orderedPaths.Sort([System.StringComparer]::OrdinalIgnoreCase)
  return @($orderedPaths)
}

function Get-RuntimeWorkspaceLinkContract {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][System.Collections.IDictionary]$PackageLock
  )

  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $nodeModulesRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull "node_modules"))
  if (-not (Test-Path -LiteralPath $nodeModulesRoot -PathType Container)) {
    throw "Release dependencies are missing. Deploy the release before starting it."
  }
  $nodeModulesItem = Get-Item -LiteralPath $nodeModulesRoot -Force
  if (($nodeModulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release node_modules cannot be a reparse point."
  }
  if (-not $PackageLock.Contains("packages") -or
      $PackageLock.packages -isnot [System.Collections.IDictionary]) {
    throw "Release package-lock.json does not expose workspace link contracts."
  }

  $links = [System.Collections.Generic.SortedDictionary[string,object]]::new(
    [System.StringComparer]::Ordinal
  )
  foreach ($package in $PackageLock.packages.GetEnumerator()) {
    if ($package.Value -isnot [System.Collections.IDictionary] -or
        -not $package.Value.Contains("link") -or
        -not [bool]$package.Value.link) {
      continue
    }
    if (-not $package.Value.Contains("resolved")) {
      throw "Runtime workspace link contract is missing its resolved target."
    }
    $linkPath = ([string]$package.Key).Replace("\", "/")
    $targetRelative = ([string]$package.Value.resolved).Replace("\", "/")
    if ($linkPath -cnotmatch "^node_modules/@unified-ai/[a-z0-9-]+$" -or
        $targetRelative -cnotmatch "^(apps|packages|services)/[a-z0-9-]+$") {
      throw "Runtime workspace link contract is unsafe: $linkPath -> $targetRelative"
    }
    $targetPath = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull $targetRelative))
    [void](Assert-ContainedPath -Root $releaseRootFull -Path $targetPath)
    if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
      throw "Runtime workspace link target is missing: $targetRelative"
    }
    $targetItem = Get-Item -LiteralPath $targetPath -Force
    if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Runtime workspace link target must be a non-reparse directory: $targetRelative"
    }

    $linkFull = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull $linkPath))
    $linkParent = Split-Path -Parent $linkFull
    [void](Assert-ContainedPath -Root $releaseRootFull -Path $linkParent)
    if (-not (Test-Path -LiteralPath $linkFull -PathType Container)) {
      throw "Runtime workspace link declared by package-lock.json is missing: $linkPath"
    }
    $linkItem = Get-Item -LiteralPath $linkFull -Force
    if (-not $linkItem.PSIsContainer -or
        ($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -or
        [string]$linkItem.LinkType -cne "Junction") {
      throw "Runtime workspace link is not a directory junction: $linkPath"
    }
    $resolvedTarget = $linkItem.ResolveLinkTarget($false)
    if ($null -eq $resolvedTarget -or
        -not [string]::Equals(
          [System.IO.Path]::GetFullPath($resolvedTarget.FullName),
          $targetPath,
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
      throw "Runtime workspace link target does not match package-lock.json: $linkPath"
    }
    if ($links.ContainsKey($linkPath)) {
      throw "Runtime workspace link contract contains a duplicate: $linkPath"
    }
    $links.Add($linkPath, [ordered]@{
        linkPath = $linkPath
        linkFullPath = $linkFull
        targetRelativePath = $targetRelative
        targetFullPath = $targetPath
      })
  }
  if ($links.Count -eq 0 -or $links.Count -gt 100) {
    throw "Runtime workspace link count is outside the allowed range."
  }
  return [ordered]@{
    nodeModulesRoot = $nodeModulesRoot
    count = $links.Count
    links = @($links.Values)
  }
}

function Get-BoundedReleaseCriticalPaths {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][System.Collections.IDictionary]$WorkspaceLinks,
    [switch]$IncludeHiddenPackageLock
  )

  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $paths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($relativePath in @("release-manifest.json", "runtime-integrity.json") + $script:CriticalReleasePayloadPaths) {
    [void]$paths.Add([System.IO.Path]::GetFullPath((Join-Path $releaseRootFull $relativePath)))
  }
  [void]$paths.Add([System.IO.Path]::GetFullPath((Join-Path $releaseRootFull "node_modules")))
  if ($IncludeHiddenPackageLock) {
    [void]$paths.Add([System.IO.Path]::GetFullPath((Join-Path $releaseRootFull "node_modules\.package-lock.json")))
  }
  foreach ($link in @($WorkspaceLinks.links)) {
    [void]$paths.Add([System.IO.Path]::GetFullPath([string]$link.linkFullPath))
    [void]$paths.Add([System.IO.Path]::GetFullPath([string]$link.targetFullPath))
  }
  if ($paths.Count -lt 8 -or $paths.Count -gt 256) {
    throw "Bounded release critical-path count is outside the reviewed range."
  }
  $orderedPaths = [System.Collections.Generic.List[string]]::new()
  foreach ($path in $paths) {
    $orderedPaths.Add($path)
  }
  $orderedPaths.Sort([System.StringComparer]::OrdinalIgnoreCase)
  return @($orderedPaths)
}

function Get-RuntimeDependencyTreeReceipt {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $nodeModulesRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull "node_modules"))
  $expectedNodeModulesRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) "node_modules"))
  if (-not [string]::Equals($nodeModulesRoot, $expectedNodeModulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime dependency root is unsafe."
  }
  if (-not (Test-Path -LiteralPath $nodeModulesRoot -PathType Container)) {
    throw "Release dependencies are missing. Deploy the release before starting it."
  }
  $rootItem = Get-Item -LiteralPath $nodeModulesRoot -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release node_modules cannot be a reparse point."
  }
  $releaseRootItem = Get-Item -LiteralPath $releaseRootFull -Force
  if (($releaseRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Installed release root cannot be a reparse point."
  }

  $packageLockPath = Join-Path $ReleaseRoot "package-lock.json"
  $packageLock = Read-JsonHashtable -Path $packageLockPath
  if (-not $packageLock.Contains("packages") -or $packageLock.packages -isnot [System.Collections.IDictionary]) {
    throw "Release package-lock.json does not expose workspace link contracts."
  }
  $expectedLinks = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
  foreach ($package in $packageLock.packages.GetEnumerator()) {
    if ($package.Value -isnot [System.Collections.IDictionary] -or
        -not $package.Value.Contains("link") -or
        -not [bool]$package.Value.link) {
      continue
    }
    $linkPath = ([string]$package.Key).Replace("\", "/")
    $resolved = ([string]$package.Value.resolved).Replace("\", "/")
    if ($linkPath -cnotmatch "^node_modules/@unified-ai/[a-z0-9-]+$" -or
        $resolved -cnotmatch "^(apps|packages|services)/[a-z0-9-]+$") {
      throw "Runtime workspace link contract is unsafe: $linkPath -> $resolved"
    }
    $target = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot $resolved))
    [void](Assert-ContainedPath -Root $ReleaseRoot -Path $target)
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
      throw "Runtime workspace link target is missing: $resolved"
    }
    $expectedLinks.Add($linkPath, $target)
  }
  if ($expectedLinks.Count -eq 0 -or $expectedLinks.Count -gt 100) {
    throw "Runtime workspace link count is outside the allowed range."
  }

  $items = @(
    Get-ChildItem -LiteralPath $releaseRootFull -Recurse -Force |
      Where-Object {
        [System.IO.Path]::GetRelativePath($releaseRootFull, $_.FullName).Replace("\", "/") -cne
          "runtime-integrity.json"
      } |
      Sort-Object FullName
  )
  if ($items.Count -eq 0 -or $items.Count -gt 250000) {
    throw "Installed runtime tree item count is outside the allowed range."
  }
  $entries = [System.Collections.Generic.SortedDictionary[string,object]]::new([System.StringComparer]::Ordinal)
  $seenLinks = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($item in $items) {
    $relativePath = [System.IO.Path]::GetRelativePath($ReleaseRoot, $item.FullName).Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($relativePath) -or $relativePath.StartsWith("../", [System.StringComparison]::Ordinal)) {
      throw "Runtime dependency path escaped the release: $relativePath"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      if (-not $item.PSIsContainer -or -not $expectedLinks.ContainsKey($relativePath)) {
        throw "Runtime dependencies contain an undeclared reparse point: $relativePath"
      }
      $resolvedTarget = $item.ResolveLinkTarget($false)
      if ($null -eq $resolvedTarget -or
          -not [string]::Equals(
            [System.IO.Path]::GetFullPath($resolvedTarget.FullName),
            $expectedLinks[$relativePath],
            [System.StringComparison]::OrdinalIgnoreCase
          )) {
        throw "Runtime workspace link target does not match package-lock.json: $relativePath"
      }
      [void]$seenLinks.Add($relativePath)
      $targetRelative = [System.IO.Path]::GetRelativePath($ReleaseRoot, $expectedLinks[$relativePath]).Replace("\", "/")
      $entries.Add($relativePath, [ordered]@{ kind = "link"; target = $targetRelative })
      continue
    }
    if ($item.PSIsContainer) {
      $entries.Add($relativePath, [ordered]@{ kind = "directory" })
    } else {
      $entries.Add($relativePath, [ordered]@{ kind = "file"; item = [System.IO.FileInfo]$item })
    }
  }
  foreach ($linkPath in $expectedLinks.Keys) {
    if (-not $seenLinks.Contains($linkPath)) {
      throw "Runtime workspace link declared by package-lock.json is missing: $linkPath"
    }
  }
  $fileCount = @($entries.Values | Where-Object { [string]$_.kind -ceq "file" }).Count
  $directoryCount = @($entries.Values | Where-Object { [string]$_.kind -ceq "directory" }).Count
  if ($fileCount -eq 0 -or $fileCount -gt 200000) {
    throw "Installed runtime tree file count is outside the allowed range."
  }

  $treeHasher = [System.Security.Cryptography.IncrementalHash]::CreateHash(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  $totalBytes = [uint64]0
  try {
    foreach ($entry in $entries.GetEnumerator()) {
      $relativePath = [string]$entry.Key
      if ([string]$entry.Value.kind -ceq "directory") {
        $record = "directory`t$relativePath`n"
        $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
        continue
      }
      if ([string]$entry.Value.kind -ceq "link") {
        $record = "link`t$relativePath`t$([string]$entry.Value.target)`n"
        $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
        continue
      }
      $file = [System.IO.FileInfo]$entry.Value.item
      $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
      try {
        $fileHash = [System.Security.Cryptography.SHA256]::HashData($stream)
      } finally {
        $stream.Dispose()
      }
      $fileHashText = [System.Convert]::ToHexString($fileHash).ToLowerInvariant()
      $record = "file`t$relativePath`t$($file.Length)`t$fileHashText`n"
      $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
      $totalBytes += [uint64]$file.Length
    }
    $treeHash = [System.Convert]::ToHexString($treeHasher.GetHashAndReset()).ToLowerInvariant()
  } finally {
    $treeHasher.Dispose()
  }
  return [ordered]@{
    commitSha = $ExpectedSha
    entryCount = $entries.Count
    fileCount = $fileCount
    directoryCount = $directoryCount
    linkCount = $seenLinks.Count
    totalBytes = $totalBytes
    treeSha256 = $treeHash
  }
}

function Get-PinnedNodeArchivePath {
  param([Parameter(Mandatory)][hashtable]$Layout)

  return (Assert-ContainedPath `
      -Root $Layout.Downloads `
      -Path (Join-Path $Layout.Downloads $script:PinnedNodeArchiveName))
}

function Expand-PinnedNodeArchive {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $archivePathFull = [System.IO.Path]::GetFullPath($ArchivePath)
  $destinationFull = [System.IO.Path]::GetFullPath($DestinationRoot)
  [void](Assert-ContainedPath -Root $Layout.Downloads -Path $archivePathFull)
  [void](Assert-ContainedPath -Root $Layout.Staging -Path $destinationFull)
  if ((Get-FileHash -LiteralPath $archivePathFull -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedNodeArchiveSha256) {
    throw "Pinned Node.js archive does not match the reviewed official SHA-256."
  }
  $prefix = "node-v$($script:PinnedNodeVersion)-win-x64/"
  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePathFull)
  try {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $fileCount = 0
    foreach ($entry in $archive.Entries) {
      $entryName = [string]$entry.FullName
      if ($entryName.Contains("\") -or
          -not $entryName.StartsWith($prefix, [System.StringComparison]::Ordinal) -or
          $entryName.Contains([char]0)) {
        throw "Pinned Node.js archive contains an unsafe path."
      }
      $relative = $entryName.Substring($prefix.Length)
      if ([string]::IsNullOrEmpty($relative)) {
        continue
      }
      $segments = $relative.TrimEnd("/").Split("/")
      if (@($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
        throw "Pinned Node.js archive contains an unsafe path segment."
      }
      foreach ($segment in $segments) {
        [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "Node.js archive path")
      }
      $normalizedRelative = $relative.TrimEnd("/")
      if (-not $seen.Add($normalizedRelative)) {
        throw "Pinned Node.js archive contains a duplicate path: $relative"
      }
      if ($entry.Name.Length -eq 0) {
        $directoryTarget = Assert-ContainedPath `
          -Root $destinationFull `
          -Path (Join-Path $destinationFull ($normalizedRelative.Replace("/", "\")))
        [void](New-Item -ItemType Directory -Path $directoryTarget -Force)
        continue
      }
      $fileCount += 1
      if ($fileCount -gt 10000) {
        throw "Pinned Node.js archive exceeds the reviewed payload-file limit."
      }
      if (($fileCount % 250) -eq 0) {
        Write-Host "[node-runtime] Extracted $fileCount files."
      }
      $target = Assert-ContainedPath `
        -Root $destinationFull `
        -Path (Join-Path $destinationFull ($relative.Replace("/", "\")))
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open(
          $target,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $input.CopyTo($output)
        } finally {
          $output.Dispose()
        }
      } finally {
        $input.Dispose()
      }
    }
    if ($fileCount -lt 1) {
      throw "Pinned Node.js archive has no payload files."
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-PinnedNodeRuntime {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [int]$ExpectedFileCount = 0,
    [string]$ExpectedTreeSha256,
    [switch]$ExecuteVersionChecks
  )

  $runtimeRootFull = [System.IO.Path]::GetFullPath($RuntimeRoot)
  [void](Assert-ContainedPath -Root $Layout.Root -Path $runtimeRootFull)
  $archivePath = Get-PinnedNodeArchivePath -Layout $Layout
  foreach ($path in @($runtimeRootFull, $archivePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Pinned Node.js source or runtime is missing: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned Node.js source and runtime cannot be reparse points."
    }
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedNodeArchiveSha256) {
    throw "Stored Node.js archive no longer matches its reviewed official SHA-256."
  }

  $prefix = "node-v$($script:PinnedNodeVersion)-win-x64/"
  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $expectedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $expectedDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($archive.Entries | Sort-Object -Property FullName -CaseSensitive)) {
      $entryName = [string]$entry.FullName
      if ($entryName.Contains("\") -or
          -not $entryName.StartsWith($prefix, [System.StringComparison]::Ordinal) -or
          $entryName.Contains([char]0)) {
        throw "Pinned Node.js archive inventory contains an unsafe path."
      }
      $relative = $entryName.Substring($prefix.Length)
      if ([string]::IsNullOrEmpty($relative)) {
        continue
      }
      $trimmedRelative = $relative.TrimEnd("/")
      $segments = $trimmedRelative.Split("/")
      if (@($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      if (-not $seenEntries.Add($trimmedRelative)) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      foreach ($segment in $segments) {
        [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "Node.js archive path")
      }
      $directorySegmentCount = if ($entry.Name.Length -eq 0) { $segments.Count } else { $segments.Count - 1 }
      for ($index = 0; $index -lt $directorySegmentCount; $index += 1) {
        [void]$expectedDirectories.Add(($segments[0..$index] -join "/"))
      }
      if ($entry.Name.Length -eq 0) {
        continue
      }
      if (-not $expectedFiles.Add($relative)) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      if ($expectedFiles.Count -gt 10000) {
        throw "Pinned Node.js archive exceeds the reviewed payload-file limit."
      }
      if (($expectedFiles.Count % 250) -eq 0) {
        Write-Host "[node-runtime] Verified $($expectedFiles.Count) archive files."
      }
      $installedPath = Assert-ContainedPath `
        -Root $runtimeRootFull `
        -Path (Join-Path $runtimeRootFull ($relative.Replace("/", "\")))
      if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
        throw "Pinned Node.js payload file is missing: $relative"
      }
      $installedItem = Get-Item -LiteralPath $installedPath -Force
      if (($installedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          [int64]$installedItem.Length -ne [int64]$entry.Length) {
        throw "Pinned Node.js payload entry is not a matching regular file: $relative"
      }
      $entryStream = $entry.Open()
      try {
        $entryHash = [Convert]::ToHexString(
          [System.Security.Cryptography.SHA256]::HashData($entryStream)
        ).ToLowerInvariant()
      } finally {
        $entryStream.Dispose()
      }
      $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($installedHash -cne $entryHash) {
        throw "Pinned Node.js payload SHA-256 mismatch: $relative"
      }
      $lines.Add("$relative`t$([int64]$entry.Length)`t$entryHash")
    }
  } finally {
    $archive.Dispose()
  }
  $installedFiles = 0
  $installedDirectories = 0
  foreach ($item in @(Get-ChildItem -LiteralPath $runtimeRootFull -Recurse -Force)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned Node.js runtime contains a reparse point: $($item.FullName)"
    }
    $relative = [System.IO.Path]::GetRelativePath($runtimeRootFull, $item.FullName).Replace("\", "/")
    if ($item.PSIsContainer) {
      $installedDirectories += 1
      if (-not $expectedDirectories.Contains($relative)) {
        throw "Pinned Node.js runtime contains an undeclared directory: $relative"
      }
    } else {
      $installedFiles += 1
      if (($installedFiles % 250) -eq 0) {
        Write-Host "[node-runtime] Inventoried $installedFiles installed files."
      }
      if (-not $expectedFiles.Contains($relative)) {
        throw "Pinned Node.js runtime contains an undeclared file: $relative"
      }
    }
  }
  if ($installedFiles -ne $lines.Count -or
      $installedDirectories -ne $expectedDirectories.Count -or
      $lines.Count -lt 1) {
    throw "Pinned Node.js runtime payload file or directory count does not match the reviewed archive."
  }
  $treeBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $treeSha256 = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData($treeBytes)
  ).ToLowerInvariant()
  if ($ExpectedFileCount -gt 0 -and $lines.Count -ne $ExpectedFileCount) {
    throw "Pinned Node.js runtime payload file count drifted."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      ($ExpectedTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or $treeSha256 -cne $ExpectedTreeSha256)) {
    throw "Pinned Node.js runtime payload tree SHA-256 drifted."
  }
  $nodePath = Join-Path $runtimeRootFull "node.exe"
  $npmPath = Join-Path $runtimeRootFull "npm.cmd"
  if ($ExecuteVersionChecks) {
    $nodeVersion = Assert-NodeRuntime -NodePath $nodePath
    if ($nodeVersion -cne "v$($script:PinnedNodeVersion)") {
      throw "Pinned Node.js runtime version drifted: $nodeVersion"
    }
    $npmOutput = @(& $npmPath --version 2>&1)
    $npmExitCode = $LASTEXITCODE
    $npmVersion = ($npmOutput | Select-Object -First 1).ToString().Trim()
    if ($npmExitCode -ne 0 -or $npmVersion -cne "10.9.8") {
      throw "Pinned npm runtime version drifted."
    }
  }
  return [ordered]@{
    version = $script:PinnedNodeVersion
    archiveSha256 = $script:PinnedNodeArchiveSha256
    fileCount = $lines.Count
    treeSha256 = $treeSha256
    runtimeRoot = $runtimeRootFull
    nodePath = $nodePath
    npmPath = $npmPath
  }
}

function Protect-PinnedNodeRuntime {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Toolchains -Path $Layout.NodeRuntimeRoot)
  $aclOutput = & $script:CanonicalIcaclsPath $Layout.NodeRuntimeRoot /reset /T /C /Q 2>&1
  if ($LASTEXITCODE -eq 0) {
    $aclOutput += & $script:CanonicalIcaclsPath $Layout.NodeRuntimeRoot /inheritance:r /grant:r "*$($IdentitySid):(OI)(CI)RX" "*S-1-5-18:(OI)(CI)F" /Q 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to seal pinned Node.js runtime read-only: $($aclOutput -join [Environment]::NewLine)"
  }
  return (Assert-ProtectedAclContract `
      -Path $Layout.NodeRuntimeRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -Recursive)
}

function Read-PinnedNodeRuntimeInstallation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [switch]$ExecuteVersionChecks
  )

  $state = Read-JsonHashtable -Path $Layout.NodeRuntimeInstallation
  $requiredKeys = @(
    "schemaVersion", "version", "archiveSha256", "payloadFileCount", "payloadTreeSha256",
    "runtimeRoot", "nodePath", "npmPath", "identityName", "identitySid", "installedAtUtc"
  )
  if (@($state.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $state.Keys }).Count -ne 0 -or
      [int]$state.schemaVersion -ne 1 -or
      [string]$state.version -cne $script:PinnedNodeVersion -or
      [string]$state.archiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$state.payloadFileCount -lt 1 -or
      [string]$state.payloadTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$state.runtimeRoot -cne $Layout.NodeRuntimeRoot -or
      [string]$state.nodePath -cne (Join-Path $Layout.NodeRuntimeRoot "node.exe") -or
      [string]$state.npmPath -cne (Join-Path $Layout.NodeRuntimeRoot "npm.cmd") -or
      [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Pinned Node.js installation state does not match the reviewed D-backed runtime contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$state.installedAtUtc) -Context "Node.js runtime installedAtUtc")
  $identity = Get-CurrentWindowsIdentityReceipt
  if ([string]$state.identitySid -cne [string]$identity.identitySid) {
    throw "Pinned Node.js runtime was installed for a different Windows identity."
  }
  $runtime = Test-PinnedNodeRuntime `
    -Layout $Layout `
    -RuntimeRoot ([string]$state.runtimeRoot) `
    -ExpectedFileCount ([int]$state.payloadFileCount) `
    -ExpectedTreeSha256 ([string]$state.payloadTreeSha256) `
    -ExecuteVersionChecks:$ExecuteVersionChecks
  [void](Assert-ProtectedAclContract `
      -Path ([string]$state.runtimeRoot) `
      -IdentitySid ([string]$state.identitySid) `
      -IdentityAccess ReadAndExecute `
      -Recursive)
  foreach ($key in $runtime.Keys) {
    $state[$key] = $runtime[$key]
  }
  return $state
}

function Read-PinnedNodeRuntimeAttestation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.NodeRuntimeInstallation
  $requiredKeys = @(
    "schemaVersion", "version", "archiveSha256", "payloadFileCount", "payloadTreeSha256",
    "runtimeRoot", "nodePath", "npmPath", "identityName", "identitySid", "installedAtUtc"
  )
  $expectedNodePath = Join-Path $Layout.NodeRuntimeRoot "node.exe"
  $expectedNpmPath = Join-Path $Layout.NodeRuntimeRoot "npm.cmd"
  if (@($state.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $state.Keys }).Count -ne 0 -or
      [int]$state.schemaVersion -ne 1 -or
      [string]$state.version -cne $script:PinnedNodeVersion -or
      [string]$state.archiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$state.payloadFileCount -lt 1 -or
      [string]$state.payloadTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      -not [string]::Equals([string]$state.runtimeRoot, $Layout.NodeRuntimeRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$state.nodePath, $expectedNodePath, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$state.npmPath, $expectedNpmPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Pinned Node.js installation state does not match the reviewed D-backed runtime contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$state.installedAtUtc) -Context "Node.js runtime installedAtUtc")
  $identity = Get-CurrentWindowsIdentityReceipt
  if ([string]$state.identitySid -cne [string]$identity.identitySid) {
    throw "Pinned Node.js runtime was installed for a different Windows identity."
  }

  $runtimeRoot = [System.IO.Path]::GetFullPath([string]$state.runtimeRoot)
  [void](Assert-ContainedPath -Root $Layout.Toolchains -Path $runtimeRoot)
  $runtimeItem = Get-Item -LiteralPath $runtimeRoot -Force
  if (-not $runtimeItem.PSIsContainer -or
      ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Pinned Node.js runtime root must be a non-reparse directory."
  }
  $npmCliPath = Join-Path $runtimeRoot "node_modules\npm\bin\npm-cli.js"
  $npmPackagePath = Join-Path $runtimeRoot "node_modules\npm\package.json"
  foreach ($path in @($expectedNodePath, $expectedNpmPath, $npmCliPath, $npmPackagePath)) {
    [void](Assert-ContainedPath -Root $runtimeRoot -Path $path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Pinned Node.js runtime critical file is missing: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned Node.js runtime critical files cannot be reparse points."
    }
  }
  $npmPackage = Read-JsonHashtable -Path $npmPackagePath
  if ([string]$npmPackage.name -cne "npm" -or [string]$npmPackage.version -cne "10.9.8") {
    throw "Pinned npm runtime package identity drifted."
  }
  [void](Assert-ProtectedAclContract `
      -Path $runtimeRoot `
      -IdentitySid ([string]$state.identitySid) `
      -IdentityAccess ReadAndExecute `
      -BoundedPaths @($expectedNodePath, $expectedNpmPath, $npmCliPath, $npmPackagePath))

  return [ordered]@{
    version = [string]$state.version
    archiveSha256 = [string]$state.archiveSha256
    payloadFileCount = [int]$state.payloadFileCount
    payloadTreeSha256 = [string]$state.payloadTreeSha256
    runtimeRoot = $runtimeRoot
    nodePath = [System.IO.Path]::GetFullPath($expectedNodePath)
    nodeVersion = "v$($script:PinnedNodeVersion)"
    nodeSha256 = (Get-FileHash -LiteralPath $expectedNodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    npmPath = [System.IO.Path]::GetFullPath($expectedNpmPath)
    npmVersion = [string]$npmPackage.version
    npmSha256 = (Get-FileHash -LiteralPath $expectedNpmPath -Algorithm SHA256).Hash.ToLowerInvariant()
    npmCliPath = [System.IO.Path]::GetFullPath($npmCliPath)
    npmCliSha256 = (Get-FileHash -LiteralPath $npmCliPath -Algorithm SHA256).Hash.ToLowerInvariant()
    identityName = [string]$state.identityName
    identitySid = [string]$state.identitySid
  }
}

function Get-CanonicalNpmDependencyGraphReceipt {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Graph)

  if ($Graph.Contains("error") -or
      ($Graph.Contains("problems") -and @($Graph.problems).Count -gt 0)) {
    throw "npm dependency graph reported an invalid installed tree."
  }
  $records = [System.Collections.Generic.List[string]]::new()
  $seenPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $visit = $null
  $visit = {
    param(
      [Parameter(Mandatory)][System.Collections.IDictionary]$Node,
      [string[]]$DependencyPath,
      [Parameter(Mandatory)][int]$Depth
    )

    if ($Depth -gt 100) {
      throw "npm dependency graph exceeds the reviewed depth limit."
    }
    foreach ($flag in @("missing", "invalid", "extraneous")) {
      if ($Node.Contains($flag) -and [bool]$Node[$flag]) {
        throw "npm dependency graph contains a $flag node."
      }
    }
    if (-not $Node.Contains("version")) {
      throw "npm dependency graph contains a non-empty node without a version."
    }
    if ($DependencyPath.Count -eq 0 -and -not $Node.Contains("name")) {
      throw "npm dependency graph root is missing its package name."
    }
    $nodeName = if ($DependencyPath.Count -eq 0) { [string]$Node.name } else { $DependencyPath[-1] }
    $nodeVersion = [string]$Node.version
    if ([string]::IsNullOrWhiteSpace($nodeName) -or $nodeName.Length -gt 214 -or
        $nodeName.Contains("`t") -or $nodeName.Contains("`r") -or $nodeName.Contains("`n") -or
        [string]::IsNullOrWhiteSpace($nodeVersion) -or $nodeVersion.Length -gt 256 -or
        $nodeVersion.Contains("`t") -or $nodeVersion.Contains("`r") -or $nodeVersion.Contains("`n")) {
      throw "npm dependency graph contains an unsafe package identity."
    }
    $pathJson = ConvertTo-Json -InputObject @($DependencyPath) -Compress
    if (-not $seenPaths.Add($pathJson)) {
      throw "npm dependency graph contains a duplicate logical path."
    }
    $records.Add((ConvertTo-Json -InputObject ([ordered]@{
          path = @($DependencyPath)
          name = $nodeName
          version = $nodeVersion
        }) -Compress -Depth 100))
    if ($records.Count -gt 100000) {
      throw "npm dependency graph exceeds the reviewed node-count limit."
    }
    if (-not $Node.Contains("dependencies") -or $null -eq $Node.dependencies) {
      return
    }
    if ($Node.dependencies -isnot [System.Collections.IDictionary]) {
      throw "npm dependency graph dependencies must be an object."
    }
    $dependencyNames = [System.Collections.Generic.List[string]]::new()
    foreach ($dependencyName in $Node.dependencies.Keys) {
      $dependencyNameText = [string]$dependencyName
      if ([string]::IsNullOrWhiteSpace($dependencyNameText) -or
          $dependencyNameText.Contains("`t") -or
          $dependencyNameText.Contains("`r") -or
          $dependencyNameText.Contains("`n")) {
        throw "npm dependency graph contains an unsafe dependency name."
      }
      $dependencyNames.Add($dependencyNameText)
    }
    $dependencyNames.Sort([System.StringComparer]::Ordinal)
    foreach ($dependencyName in $dependencyNames) {
      $child = $Node.dependencies[$dependencyName]
      if ($child -isnot [System.Collections.IDictionary]) {
        throw "npm dependency graph child nodes must be objects."
      }
      if ($child.Count -eq 0) {
        # npm emits empty objects for platform-omitted optional dependencies.
        # They are absence placeholders, not installed dependency nodes.
        continue
      }
      & $visit `
        -Node $child `
        -DependencyPath (@($DependencyPath) + @($dependencyName)) `
        -Depth ($Depth + 1)
    }
  }

  & $visit -Node $Graph -DependencyPath @() -Depth 0
  if ($records.Count -lt 1) {
    throw "npm dependency graph is empty."
  }
  $graphBytes = [System.Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  return [ordered]@{
    dependencyGraphNodeCount = $records.Count
    dependencyGraphSha256 = [System.Convert]::ToHexString(
      [System.Security.Cryptography.SHA256]::HashData($graphBytes)
    ).ToLowerInvariant()
  }
}

function Get-PinnedNpmDependencyGraphReceipt {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][System.Collections.IDictionary]$NodeRuntime,
    [ValidateRange(1, 150)][int]$TimeoutSeconds = $script:RuntimeAttestationGraphTimeoutSeconds
  )

  Write-Host "[runtime-attestation:npm-graph-start] timeoutSeconds=$TimeoutSeconds"
  $result = Invoke-BoundedProcess `
    -FilePath ([string]$NodeRuntime.nodePath) `
    -ArgumentList @(
      [string]$NodeRuntime.npmCliPath,
      "ls", "--omit=dev", "--all", "--json"
    ) `
    -WorkingDirectory $ReleaseRoot `
    -TimeoutSeconds $TimeoutSeconds `
    -MaxOutputCharacters 8388608 `
    -Context "Pinned npm dependency graph validation"
  if ([int]$result.exitCode -ne 0) {
    $stderr = [string]$result.stderr
    if ($stderr.Length -gt 2000) {
      $stderr = $stderr.Substring(0, 2000)
    }
    throw "Pinned npm dependency graph validation failed with exit code $($result.exitCode): $stderr"
  }
  $graph = try {
    ConvertFrom-Json -InputObject ([string]$result.stdout) -AsHashtable -Depth 100
  } catch {
    throw "Pinned npm dependency graph output was not valid bounded JSON: $($_.Exception.Message)"
  }
  if ($graph -isnot [System.Collections.IDictionary]) {
    throw "Pinned npm dependency graph output must be an object."
  }
  $receipt = Get-CanonicalNpmDependencyGraphReceipt -Graph $graph
  Write-Host "[runtime-attestation:npm-graph-complete] elapsedMilliseconds=$($result.elapsedMilliseconds) nodes=$($receipt.dependencyGraphNodeCount)"
  return $receipt
}

function Write-SealedRuntimeDependencyAttestation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][string]$NodePath
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $criticalPayload = Get-CriticalReleasePayloadAttestation `
    -Layout $Layout `
    -ReleaseRoot $ReleaseRoot `
    -ExpectedSha $ExpectedSha `
    -PayloadPaths $script:BundledRuntimeCriticalPayloadPaths
  $bundledRuntime = Read-BundledRuntimeBuildReceipt -ReleaseRoot $ReleaseRoot
  $NodePath = [System.IO.Path]::GetFullPath($NodePath)
  $nodeRuntime = Read-PinnedNodeRuntimeAttestation -Layout $Layout
  if (-not [string]::Equals($NodePath, [string]$nodeRuntime.nodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release installation must use the qualified D-backed Node.js runtime."
  }
  $nodeVersion = Assert-NodeRuntime -NodePath $NodePath
  if ($nodeVersion -cne "v22.23.2") {
    throw "Release installation requires the exact Node.js runtime v22.23.2; observed $nodeVersion."
  }
  $identity = Get-CurrentWindowsIdentityReceipt
  $receipt = [ordered]@{
    schemaVersion = 6
    attestationKind = $script:BundledRuntimeAttestationKind
    aclProtectionKind = $script:RuntimeAttestationAclProtectionKind
    commitSha = $ExpectedSha
    releaseManifestSha256 = [string]$criticalPayload.releaseManifestSha256
    packageLockSha256 = [string]$criticalPayload.packageLockSha256
    criticalPayloadSha256 = $criticalPayload.criticalPayloadSha256
    bundlePath = $script:BundledRuntimePath
    bundleSha256 = [string]$bundledRuntime.bundleSha256
    bundleBytes = [uint64]$bundledRuntime.bundleBytes
    bundleBuildReceiptSha256 = [string]$criticalPayload.criticalPayloadSha256[$script:BundledRuntimeBuildReceiptPath]
    nodePath = $NodePath
    nodeVersion = $nodeVersion
    nodeSha256 = [string]$nodeRuntime.nodeSha256
    nodeRuntimeArchiveSha256 = [string]$nodeRuntime.archiveSha256
    nodeRuntimeFileCount = [int]$nodeRuntime.payloadFileCount
    nodeRuntimeTreeSha256 = [string]$nodeRuntime.payloadTreeSha256
    identityName = [string]$identity.identityName
    identitySid = [string]$identity.identitySid
  }
  $receiptPath = Join-Path $ReleaseRoot "runtime-integrity.json"
  if (Test-Path -LiteralPath $receiptPath) {
    throw "Runtime dependency attestation receipt already exists; immutable releases cannot be rewritten."
  }
  $sealPath = Assert-ContainedPath `
    -Root $Layout.RuntimeIntegrity `
    -Path (Join-Path $Layout.RuntimeIntegrity "$ExpectedSha.json")
  if (Test-Path -LiteralPath $sealPath) {
    throw "Runtime dependency attestation seal already exists; immutable releases cannot be resealed."
  }
  Write-AtomicJson -Layout $Layout -Path $receiptPath -Value $receipt
  $receiptSha256 = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $criticalPaths = @(Get-BundledRuntimeCriticalPaths -ReleaseRoot $ReleaseRoot)
  Write-Host "[runtime-attestation:release-protection-start] timeoutSeconds=$script:RuntimeAttestationReleaseProtectionTimeoutSeconds mode=$script:RuntimeAttestationAclProtectionKind"
  $protectionTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $protection = Protect-ReleaseDirectory `
    -Layout $Layout `
    -ReleaseRoot $ReleaseRoot `
    -IdentitySid ([string]$identity.identitySid) `
    -CriticalPaths $criticalPaths `
    -WorkspaceLinks @()
  $protectionTimer.Stop()
  Write-Host "[runtime-attestation:release-protection-complete] elapsedMilliseconds=$($protectionTimer.ElapsedMilliseconds) entries=$($protection.entryCount) inventorySha256=$($protection.inventorySha256)"
  Write-AtomicJson -Layout $Layout -Path $sealPath -Value ([ordered]@{
      schemaVersion = 4
      attestationKind = $script:BundledRuntimeAttestationKind
      aclProtectionKind = $script:RuntimeAttestationAclProtectionKind
      commitSha = $ExpectedSha
      runtimeIntegritySha256 = $receiptSha256
      bundleSha256 = [string]$bundledRuntime.bundleSha256
      bundleBuildReceiptSha256 = [string]$receipt.bundleBuildReceiptSha256
      releaseManifestSha256 = [string]$criticalPayload.releaseManifestSha256
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    })
  $sealAcl = Invoke-BoundedProcess `
    -FilePath $script:CanonicalIcaclsPath `
    -ArgumentList @(
      $sealPath,
      "/inheritance:r",
      "/grant:r",
      "*$([string]$identity.identitySid):RX",
      "*S-1-5-18:F",
      "/Q"
    ) `
    -WorkingDirectory $Layout.RuntimeIntegrity `
    -TimeoutSeconds $script:RuntimeAttestationSealProtectionTimeoutSeconds `
    -MaxOutputCharacters 1048576 `
    -Context "Runtime dependency attestation seal protection"
  if ([int]$sealAcl.exitCode -ne 0) {
    throw "Unable to seal runtime dependency receipt: $([string]$sealAcl.stderr)"
  }
  [void](Assert-IntegritySealProtection -Path $sealPath -IdentitySid ([string]$identity.identitySid))
  Write-Host "[runtime-attestation:seal-complete] receiptSha256=$receiptSha256"
  return (Test-SealedRuntimeDependencyAttestation `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -ExpectedSha $ExpectedSha `
      -ExpectedReceiptSha256 $receiptSha256)
}

function Write-RuntimeDependencyIntegrity {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$NpmPath
  )

  return (Write-SealedRuntimeDependencyAttestation `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -ExpectedSha $ExpectedSha `
      -NodePath $NodePath)
}

function Test-SealedBundledRuntimeAttestation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][System.Collections.IDictionary]$CriticalPayload,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Receipt,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [string]$ExpectedReceiptSha256
  )

  $requiredKeys = @(
    "schemaVersion", "attestationKind", "aclProtectionKind", "commitSha",
    "releaseManifestSha256", "packageLockSha256", "criticalPayloadSha256",
    "bundlePath", "bundleSha256", "bundleBytes", "bundleBuildReceiptSha256",
    "nodePath", "nodeVersion", "nodeSha256", "nodeRuntimeArchiveSha256",
    "nodeRuntimeFileCount", "nodeRuntimeTreeSha256", "identityName", "identitySid"
  )
  if (@($Receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $Receipt.Keys }).Count -ne 0 -or
      [int]$Receipt.schemaVersion -ne 6 -or
      [string]$Receipt.attestationKind -cne $script:BundledRuntimeAttestationKind -or
      [string]$Receipt.aclProtectionKind -cne $script:RuntimeAttestationAclProtectionKind -or
      [string]$Receipt.commitSha -cne $ExpectedSha -or
      [string]$Receipt.releaseManifestSha256 -cne [string]$CriticalPayload.releaseManifestSha256 -or
      [string]$Receipt.packageLockSha256 -cne [string]$CriticalPayload.packageLockSha256 -or
      [string]$Receipt.bundlePath -cne $script:BundledRuntimePath -or
      [string]$Receipt.bundleSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [uint64]$Receipt.bundleBytes -lt 1 -or
      [string]$Receipt.bundleBuildReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$Receipt.nodeVersion -cne "v$($script:PinnedNodeVersion)" -or
      [string]$Receipt.nodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$Receipt.nodeRuntimeArchiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$Receipt.nodeRuntimeFileCount -lt 1 -or
      [string]$Receipt.nodeRuntimeTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$Receipt.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Bundled runtime attestation receipt does not match the selected release."
  }
  $criticalKeys = @($script:BundledRuntimeCriticalPayloadPaths)
  if ($Receipt.criticalPayloadSha256 -isnot [System.Collections.IDictionary] -or
      @($Receipt.criticalPayloadSha256.Keys | Where-Object { $_ -notin $criticalKeys }).Count -ne 0 -or
      @($criticalKeys | Where-Object { $_ -notin $Receipt.criticalPayloadSha256.Keys }).Count -ne 0) {
    throw "Bundled runtime critical-payload contract drifted."
  }
  foreach ($criticalPath in $criticalKeys) {
    if ([string]$Receipt.criticalPayloadSha256[$criticalPath] -cne
        [string]$CriticalPayload.criticalPayloadSha256[$criticalPath]) {
      throw "Bundled runtime critical payload drifted: $criticalPath"
    }
  }
  $bundledRuntime = Read-BundledRuntimeBuildReceipt -ReleaseRoot $ReleaseRoot
  if ([string]$Receipt.bundleSha256 -cne [string]$bundledRuntime.bundleSha256 -or
      [uint64]$Receipt.bundleBytes -ne [uint64]$bundledRuntime.bundleBytes -or
      [string]$Receipt.bundleBuildReceiptSha256 -cne
        [string]$CriticalPayload.criticalPayloadSha256[$script:BundledRuntimeBuildReceiptPath]) {
    throw "Bundled runtime build identity drifted after release installation."
  }
  $receiptSha256 = (Get-FileHash -LiteralPath $ReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($ExpectedReceiptSha256) -and
      ($ExpectedReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or
       $receiptSha256 -cne $ExpectedReceiptSha256)) {
    throw "Bundled runtime receipt does not match the release pointer."
  }
  $sealPath = Assert-ContainedPath `
    -Root $Layout.RuntimeIntegrity `
    -Path (Join-Path $Layout.RuntimeIntegrity "$ExpectedSha.json")
  $seal = Read-JsonHashtable -Path $sealPath
  $sealKeys = @(
    "schemaVersion", "attestationKind", "aclProtectionKind", "commitSha",
    "runtimeIntegritySha256", "bundleSha256", "bundleBuildReceiptSha256",
    "releaseManifestSha256", "createdAtUtc"
  )
  if (@($seal.Keys | Where-Object { $_ -notin $sealKeys }).Count -ne 0 -or
      @($sealKeys | Where-Object { $_ -notin $seal.Keys }).Count -ne 0 -or
      [int]$seal.schemaVersion -ne 4 -or
      [string]$seal.attestationKind -cne $script:BundledRuntimeAttestationKind -or
      [string]$seal.aclProtectionKind -cne $script:RuntimeAttestationAclProtectionKind -or
      [string]$seal.commitSha -cne $ExpectedSha -or
      [string]$seal.runtimeIntegritySha256 -cne $receiptSha256 -or
      [string]$seal.bundleSha256 -cne [string]$Receipt.bundleSha256 -or
      [string]$seal.bundleBuildReceiptSha256 -cne [string]$Receipt.bundleBuildReceiptSha256 -or
      [string]$seal.releaseManifestSha256 -cne [string]$CriticalPayload.releaseManifestSha256) {
    throw "External bundled runtime seal does not match the immutable release receipt."
  }
  [void](Assert-UtcTimestamp -Value ([string]$seal.createdAtUtc) -Context "Bundled runtime seal createdAtUtc")
  [void](Assert-IntegritySealProtection -Path $sealPath -IdentitySid ([string]$Receipt.identitySid))
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$Receipt.identitySid -cne [string]$currentIdentity.identitySid) {
    throw "Bundled runtime was sealed by a different Windows identity."
  }
  $nodeRuntime = Read-PinnedNodeRuntimeAttestation -Layout $Layout
  if (-not [string]::Equals(
      [string]$Receipt.nodePath,
      [string]$nodeRuntime.nodePath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
      [string]$Receipt.nodeSha256 -cne [string]$nodeRuntime.nodeSha256 -or
      [int]$Receipt.nodeRuntimeFileCount -ne [int]$nodeRuntime.payloadFileCount -or
      [string]$Receipt.nodeRuntimeTreeSha256 -cne [string]$nodeRuntime.payloadTreeSha256) {
    throw "Bundled runtime receipt is not bound to the qualified D-backed Node.js runtime."
  }
  $criticalPaths = @(Get-BundledRuntimeCriticalPaths -ReleaseRoot $ReleaseRoot)
  [void](Assert-BoundedReleaseDirectoryProtection `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -IdentitySid ([string]$Receipt.identitySid) `
      -CriticalPaths $criticalPaths `
      -DescendantAclMode Explicit)
  $Receipt["runtimeIntegritySha256"] = $receiptSha256
  $Receipt["attestationMode"] = "sealed"
  $Receipt["criticalPathCount"] = $criticalPaths.Count
  return $Receipt
}

function Test-SealedRuntimeDependencyAttestation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [string]$ExpectedReceiptSha256
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $receiptPath = Join-Path $ReleaseRoot "runtime-integrity.json"
  $receipt = Read-JsonHashtable -Path $receiptPath
  $criticalPayload = Get-CriticalReleasePayloadAttestation `
    -Layout $Layout `
    -ReleaseRoot $ReleaseRoot `
    -ExpectedSha $ExpectedSha `
    -PayloadPaths $(if ([int]$receipt.schemaVersion -eq 6) {
        $script:BundledRuntimeCriticalPayloadPaths
      } else {
        $script:CriticalReleasePayloadPaths
      })
  if ([int]$receipt.schemaVersion -eq 6) {
    return (Test-SealedBundledRuntimeAttestation `
        -Layout $Layout `
        -ReleaseRoot $ReleaseRoot `
        -ExpectedSha $ExpectedSha `
        -CriticalPayload $criticalPayload `
        -Receipt $receipt `
        -ReceiptPath $receiptPath `
        -ExpectedReceiptSha256 $ExpectedReceiptSha256)
  }
  $packageLock = Read-JsonHashtable -Path (Join-Path $ReleaseRoot "package-lock.json")
  $workspaceLinks = Get-RuntimeWorkspaceLinkContract -ReleaseRoot $ReleaseRoot -PackageLock $packageLock
  $legacyReceipt = [int]$receipt.schemaVersion -eq 3
  $explicitAclReceipt = [int]$receipt.schemaVersion -eq 5
  if ($legacyReceipt) {
    $requiredKeys = @(
      "schemaVersion", "commitSha", "packageLockSha256", "nodePath", "nodeVersion",
      "nodeSha256", "nodeRuntimeArchiveSha256", "nodeRuntimeFileCount", "nodeRuntimeTreeSha256",
      "identityName", "identitySid",
      "entryCount", "fileCount", "directoryCount", "linkCount", "totalBytes", "treeSha256"
    )
    if (@($receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
        @($requiredKeys | Where-Object { $_ -notin $receipt.Keys }).Count -ne 0 -or
        [string]$receipt.treeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        [int]$receipt.entryCount -lt 1 -or [int]$receipt.fileCount -lt 1 -or
        [int]$receipt.linkCount -ne [int]$workspaceLinks.count) {
      throw "Legacy runtime dependency integrity receipt is invalid."
    }
  } else {
    $requiredKeys = @(
      "schemaVersion", "attestationKind", "commitSha", "releaseManifestSha256",
      "packageLockSha256", "criticalPayloadSha256", "hiddenPackageLockSha256",
      "nodePath", "nodeVersion", "nodeSha256", "npmPath", "npmVersion", "npmSha256",
      "npmCliPath", "npmCliSha256", "nodeRuntimeArchiveSha256", "nodeRuntimeFileCount",
      "nodeRuntimeTreeSha256", "identityName", "identitySid", "dependencyGraphNodeCount",
      "dependencyGraphSha256", "workspaceLinkCount"
    )
    if ($explicitAclReceipt) {
      $requiredKeys += "aclProtectionKind"
    }
    if (@($receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
        @($requiredKeys | Where-Object { $_ -notin $receipt.Keys }).Count -ne 0 -or
        [int]$receipt.schemaVersion -notin @(4, 5) -or
        [string]$receipt.attestationKind -cne $script:RuntimeAttestationKind -or
        ($explicitAclReceipt -and
          [string]$receipt.aclProtectionKind -cne $script:RuntimeAttestationAclProtectionKind) -or
        [string]$receipt.releaseManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        $receipt.criticalPayloadSha256 -isnot [System.Collections.IDictionary] -or
        [string]$receipt.npmVersion -cne "10.9.8" -or
        [string]$receipt.npmSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        [string]$receipt.npmCliSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        [int]$receipt.dependencyGraphNodeCount -lt 1 -or
        [int]$receipt.dependencyGraphNodeCount -gt 100000 -or
        [string]$receipt.dependencyGraphSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        [int]$receipt.workspaceLinkCount -ne [int]$workspaceLinks.count) {
      throw "Runtime dependency attestation receipt does not match the bounded graph contract."
    }
    $criticalKeys = @($script:CriticalReleasePayloadPaths)
    if (@($receipt.criticalPayloadSha256.Keys | Where-Object { $_ -notin $criticalKeys }).Count -ne 0 -or
        @($criticalKeys | Where-Object { $_ -notin $receipt.criticalPayloadSha256.Keys }).Count -ne 0) {
      throw "Runtime dependency attestation critical-payload contract drifted."
    }
    foreach ($criticalPath in $criticalKeys) {
      if ([string]$receipt.criticalPayloadSha256[$criticalPath] -cne
          [string]$criticalPayload.criticalPayloadSha256[$criticalPath]) {
        throw "Runtime dependency attestation critical payload drifted: $criticalPath"
      }
    }
    if ([string]$receipt.releaseManifestSha256 -cne [string]$criticalPayload.releaseManifestSha256) {
      throw "Runtime dependency attestation release manifest drifted."
    }
  }
  if ([string]$receipt.commitSha -cne $ExpectedSha -or
      [string]$receipt.packageLockSha256 -cne [string]$criticalPayload.packageLockSha256 -or
      [string]$receipt.nodeVersion -cne "v$($script:PinnedNodeVersion)" -or
      [string]$receipt.nodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.nodeRuntimeArchiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$receipt.nodeRuntimeFileCount -lt 1 -or
      [string]$receipt.nodeRuntimeTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Runtime dependency attestation receipt does not match the selected release."
  }
  $sealPath = Assert-ContainedPath `
    -Root $Layout.RuntimeIntegrity `
    -Path (Join-Path $Layout.RuntimeIntegrity "$ExpectedSha.json")
  $seal = Read-JsonHashtable -Path $sealPath
  [void](Assert-IntegritySealProtection -Path $sealPath -IdentitySid ([string]$receipt.identitySid))
  $receiptSha256 = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($ExpectedReceiptSha256) -and
      ($ExpectedReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or $receiptSha256 -cne $ExpectedReceiptSha256)) {
    throw "Runtime dependency receipt does not match the release pointer."
  }
  if ($legacyReceipt) {
    $sealKeys = @("schemaVersion", "commitSha", "runtimeIntegritySha256", "treeSha256", "createdAtUtc")
    if (@($seal.Keys | Where-Object { $_ -notin $sealKeys }).Count -ne 0 -or
        @($sealKeys | Where-Object { $_ -notin $seal.Keys }).Count -ne 0 -or
        [int]$seal.schemaVersion -ne 1 -or
        [string]$seal.commitSha -cne $ExpectedSha -or
        [string]$seal.runtimeIntegritySha256 -cne $receiptSha256 -or
        [string]$seal.treeSha256 -cne [string]$receipt.treeSha256) {
      throw "Legacy external runtime dependency seal does not match the immutable release receipt."
    }
  } elseif ($explicitAclReceipt) {
    $sealKeys = @(
      "schemaVersion", "attestationKind", "aclProtectionKind", "commitSha",
      "runtimeIntegritySha256", "dependencyGraphSha256", "releaseManifestSha256",
      "createdAtUtc"
    )
    if (@($seal.Keys | Where-Object { $_ -notin $sealKeys }).Count -ne 0 -or
        @($sealKeys | Where-Object { $_ -notin $seal.Keys }).Count -ne 0 -or
        [int]$seal.schemaVersion -ne 3 -or
        [string]$seal.attestationKind -cne $script:RuntimeAttestationKind -or
        [string]$seal.aclProtectionKind -cne $script:RuntimeAttestationAclProtectionKind -or
        [string]$seal.commitSha -cne $ExpectedSha -or
        [string]$seal.runtimeIntegritySha256 -cne $receiptSha256 -or
        [string]$seal.dependencyGraphSha256 -cne [string]$receipt.dependencyGraphSha256 -or
        [string]$seal.releaseManifestSha256 -cne [string]$receipt.releaseManifestSha256) {
      throw "Explicit-entry runtime dependency attestation seal does not match the immutable release receipt."
    }
  } else {
    $sealKeys = @(
      "schemaVersion", "attestationKind", "commitSha", "runtimeIntegritySha256",
      "dependencyGraphSha256", "releaseManifestSha256", "createdAtUtc"
    )
    if (@($seal.Keys | Where-Object { $_ -notin $sealKeys }).Count -ne 0 -or
        @($sealKeys | Where-Object { $_ -notin $seal.Keys }).Count -ne 0 -or
        [int]$seal.schemaVersion -ne 2 -or
        [string]$seal.attestationKind -cne $script:RuntimeAttestationKind -or
        [string]$seal.commitSha -cne $ExpectedSha -or
        [string]$seal.runtimeIntegritySha256 -cne $receiptSha256 -or
        [string]$seal.dependencyGraphSha256 -cne [string]$receipt.dependencyGraphSha256 -or
        [string]$seal.releaseManifestSha256 -cne [string]$receipt.releaseManifestSha256) {
      throw "External runtime dependency attestation seal does not match the immutable release receipt."
    }
  }
  [void](Assert-UtcTimestamp -Value ([string]$seal.createdAtUtc) -Context "Runtime dependency seal createdAtUtc")
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$receipt.identitySid -cne [string]$currentIdentity.identitySid) {
    throw "Runtime dependencies were installed by a different Windows identity."
  }
  $nodeRuntime = Read-PinnedNodeRuntimeAttestation -Layout $Layout
  if ([int]$receipt.nodeRuntimeFileCount -ne [int]$nodeRuntime.payloadFileCount -or
      [string]$receipt.nodeRuntimeTreeSha256 -cne [string]$nodeRuntime.payloadTreeSha256 -or
      -not [string]::Equals(
        [string]$receipt.nodePath,
        [string]$nodeRuntime.nodePath,
       [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Release runtime receipt is not bound to the qualified D-backed Node.js runtime."
  }
  if ([string]$receipt.nodeSha256 -cne [string]$nodeRuntime.nodeSha256) {
    throw "Pinned Node.js runtime failed integrity verification."
  }
  $includeHiddenPackageLock = $false
  if (-not $legacyReceipt) {
    if (-not [string]::Equals([string]$receipt.npmPath, [string]$nodeRuntime.npmPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$receipt.npmCliPath, [string]$nodeRuntime.npmCliPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]$receipt.npmSha256 -cne [string]$nodeRuntime.npmSha256 -or
        [string]$receipt.npmCliSha256 -cne [string]$nodeRuntime.npmCliSha256) {
      throw "Pinned npm runtime failed bounded integrity verification."
    }
    $hiddenPackageLockPath = Join-Path $ReleaseRoot "node_modules\.package-lock.json"
    if ($null -eq $receipt.hiddenPackageLockSha256) {
      if (Test-Path -LiteralPath $hiddenPackageLockPath) {
        throw "Installed hidden package lock appeared after the release was attested."
      }
    } else {
      if ([string]$receipt.hiddenPackageLockSha256 -cnotmatch "^[0-9a-f]{64}$" -or
          -not (Test-Path -LiteralPath $hiddenPackageLockPath -PathType Leaf)) {
        throw "Installed hidden package lock does not match the sealed receipt."
      }
      $hiddenItem = Get-Item -LiteralPath $hiddenPackageLockPath -Force
      if (($hiddenItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          (Get-FileHash -LiteralPath $hiddenPackageLockPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            [string]$receipt.hiddenPackageLockSha256) {
        throw "Installed hidden package lock failed SHA-256 verification."
      }
      $includeHiddenPackageLock = $true
    }
  }
  $criticalPaths = @(Get-BoundedReleaseCriticalPaths `
      -ReleaseRoot $ReleaseRoot `
      -WorkspaceLinks $workspaceLinks `
      -IncludeHiddenPackageLock:$includeHiddenPackageLock)
  [void](Assert-BoundedReleaseDirectoryProtection `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -IdentitySid ([string]$receipt.identitySid) `
      -CriticalPaths $criticalPaths `
      -DescendantAclMode $(if ($explicitAclReceipt) { "Explicit" } else { "Inherited" }))
  if ($legacyReceipt) {
    $receipt["attestationKind"] = "legacy-full-tree-sha256"
  }
  $receipt["runtimeIntegritySha256"] = $receiptSha256
  $receipt["attestationMode"] = "sealed"
  $receipt["criticalPathCount"] = $criticalPaths.Count
  return $receipt
}

function Test-RuntimeDependencyIntegrityFullAudit {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [string]$ExpectedReceiptSha256,
    [string]$ExpectedTreeSha256
  )

  $receipt = Test-SealedRuntimeDependencyAttestation `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -ExpectedSha $ExpectedSha `
      -ExpectedReceiptSha256 $ExpectedReceiptSha256
  if ([int]$receipt.schemaVersion -eq 6) {
    $manifest = Test-ReleaseDirectory `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -ExpectedSha $ExpectedSha
    $nodeRuntime = Read-PinnedNodeRuntimeInstallation -Layout $Layout
    if ([int]$receipt.nodeRuntimeFileCount -ne [int]$nodeRuntime.payloadFileCount -or
        [string]$receipt.nodeRuntimeTreeSha256 -cne [string]$nodeRuntime.payloadTreeSha256) {
      throw "Pinned Node.js runtime failed bundled-runtime full-file audit."
    }
    [void](Assert-ReleaseDirectoryProtection `
        -Layout $Layout `
        -ReleaseRoot $ReleaseRoot `
        -IdentitySid ([string]$receipt.identitySid) `
        -DescendantAclMode Explicit)
    $receipt["attestationMode"] = "full-audit"
    $receipt["fullAuditPayloadFileCount"] = [int]$manifest.payloadSha256.Count
    $receipt["fullAuditBundleSha256"] = [string]$receipt.bundleSha256
    return $receipt
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      $ExpectedTreeSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Expected full-audit tree SHA-256 is invalid."
  }
  if ([int]$receipt.schemaVersion -in @(4, 5) -and
      [string]::IsNullOrWhiteSpace($ExpectedTreeSha256)) {
    throw "Bounded-graph full audit requires an externally trusted expected tree SHA-256."
  }
  [void](Test-ReleaseDirectory -Layout $Layout -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha)
  $nodeRuntime = Read-PinnedNodeRuntimeInstallation -Layout $Layout
  if ([int]$receipt.nodeRuntimeFileCount -ne [int]$nodeRuntime.payloadFileCount -or
      [string]$receipt.nodeRuntimeTreeSha256 -cne [string]$nodeRuntime.payloadTreeSha256) {
    throw "Pinned Node.js runtime failed full-file audit."
  }
  $tree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha
  if ([int]$receipt.schemaVersion -eq 3 -and
      ([int]$receipt.entryCount -ne [int]$tree.entryCount -or
       [int]$receipt.fileCount -ne [int]$tree.fileCount -or
       [int]$receipt.directoryCount -ne [int]$tree.directoryCount -or
       [int]$receipt.linkCount -ne [int]$tree.linkCount -or
       [uint64]$receipt.totalBytes -ne [uint64]$tree.totalBytes -or
       [string]$receipt.treeSha256 -cne [string]$tree.treeSha256)) {
    throw "Installed legacy runtime dependency tree failed its sealed full-file audit."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      [string]$tree.treeSha256 -cne $ExpectedTreeSha256) {
    throw "Installed runtime dependency tree failed the requested full-file audit baseline."
  }
  [void](Assert-ReleaseDirectoryProtection `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -IdentitySid ([string]$receipt.identitySid) `
      -DescendantAclMode $(if ([int]$receipt.schemaVersion -eq 5) { "Explicit" } else { "Inherited" }))
  $receipt["attestationMode"] = "full-audit"
  $receipt["fullAuditEntryCount"] = [int]$tree.entryCount
  $receipt["fullAuditFileCount"] = [int]$tree.fileCount
  $receipt["fullAuditDirectoryCount"] = [int]$tree.directoryCount
  $receipt["fullAuditLinkCount"] = [int]$tree.linkCount
  $receipt["fullAuditTotalBytes"] = [uint64]$tree.totalBytes
  $receipt["fullAuditTreeSha256"] = [string]$tree.treeSha256
  return $receipt
}

function Test-RuntimeDependencyIntegrity {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [string]$ExpectedReceiptSha256,
    [string]$ExpectedTreeSha256
  )

  return (Test-RuntimeDependencyIntegrityFullAudit `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -ExpectedSha $ExpectedSha `
      -ExpectedReceiptSha256 $ExpectedReceiptSha256 `
      -ExpectedTreeSha256 $ExpectedTreeSha256)
}

function Initialize-NativeReparsePointAcl {
  if ("UnifiedAiOrchestratorDeployment.NativeReparsePointAcl" -as [type]) {
    return
  }
  Add-Type -TypeDefinition @'
using Microsoft.Win32.SafeHandles;
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Tasks;

namespace UnifiedAiOrchestratorDeployment
{
    public static class NativeReparsePointAcl
    {
        private const uint ReadControl = 0x00020000;
        private const uint WriteDac = 0x00040000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint DaclSecurityInformation = 0x00000004;
        private const uint ProtectedDaclSecurityInformation = 0x80000000;
        private const uint FileAttributeDirectory = 0x00000010;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const uint IoReparseTagMountPoint = 0xA0000003;
        private const int FileAttributeTagInfoClass = 9;
        private const int ErrorInsufficientBuffer = 122;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileTime
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public NativeFileTime CreationTime;
            public NativeFileTime LastAccessTime;
            public NativeFileTime LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileAttributeTagInformation
        {
            public uint FileAttributes;
            public uint ReparseTag;
        }

        public sealed class PathIdentity
        {
            internal PathIdentity(
                string stableId,
                bool isDirectory,
                bool isReparsePoint,
                uint reparseTag,
                uint linkCount)
            {
                StableId = stableId;
                IsDirectory = isDirectory;
                IsReparsePoint = isReparsePoint;
                ReparseTag = reparseTag;
                LinkCount = linkCount;
            }

            public string StableId { get; }
            public bool IsDirectory { get; }
            public bool IsReparsePoint { get; }
            public uint ReparseTag { get; }
            public uint LinkCount { get; }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out ByHandleFileInformation fileInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle handle,
            int fileInformationClass,
            out FileAttributeTagInformation fileInformation,
            uint bufferSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetKernelObjectSecurity(
            SafeFileHandle handle,
            uint securityInformation,
            byte[] securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetKernelObjectSecurity(
            SafeFileHandle handle,
            uint requestedInformation,
            byte[] securityDescriptor,
            uint length,
            out uint lengthNeeded);

        public static void SetAndVerify(string path, string identitySid)
        {
            var expected = Inspect(path);
            SetAndVerifyPath(
                path,
                identitySid,
                expected.IsDirectory,
                expected.IsReparsePoint,
                false,
                expected.StableId);
        }

        public static PathIdentity Inspect(string path)
        {
            using var handle = Open(path, ReadControl, true);
            return ReadAndValidateIdentity(handle);
        }

        public static SafeFileHandle OpenRootGuard(string path, string expectedStableId)
        {
            var handle = Open(path, ReadControl, false);
            try
            {
                ValidateExpectedIdentity(
                    ReadAndValidateIdentity(handle),
                    expectedStableId,
                    true,
                    false);
                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        public static void SetAndVerifyPath(
            string path,
            string identitySid,
            bool isDirectory,
            bool isReparsePoint,
            bool inheritToChildren,
            string expectedStableId)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new ArgumentException("ACL path is required.", nameof(path));
            if (string.IsNullOrWhiteSpace(expectedStableId))
                throw new ArgumentException("Stable ACL identity is required.", nameof(expectedStableId));
            if (inheritToChildren && (!isDirectory || isReparsePoint))
                throw new ArgumentException("Only a non-reparse directory can inherit to children.");
            _ = new SecurityIdentifier(identitySid);
            var inheritance = inheritToChildren ? "OICI" : string.Empty;
            var desired = new RawSecurityDescriptor(
                $"D:P(A;{inheritance};0x1200a9;;;{identitySid})(A;{inheritance};FA;;;SY)");
            var desiredBytes = new byte[desired.BinaryLength];
            desired.GetBinaryForm(desiredBytes, 0);

            using var handle = Open(path, ReadControl | WriteDac, true);
            ValidateExpectedIdentity(
                ReadAndValidateIdentity(handle),
                expectedStableId,
                isDirectory,
                isReparsePoint);
            if (!SetKernelObjectSecurity(
                    handle,
                    DaclSecurityInformation | ProtectedDaclSecurityInformation,
                    desiredBytes))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Unable to protect the reparse-point DACL.");

            ValidateExpectedIdentity(
                ReadAndValidateIdentity(handle),
                expectedStableId,
                isDirectory,
                isReparsePoint);
            VerifyDescriptor(ReadDescriptor(handle), identitySid, inheritToChildren);
        }

        public static void SetAndVerifyBatch(
            string[] paths,
            bool[] isDirectories,
            bool[] isReparsePoints,
            string[] expectedStableIds,
            string identitySid,
            int maximumDegreeOfParallelism)
        {
            if (paths == null || isDirectories == null || isReparsePoints == null ||
                expectedStableIds == null ||
                paths.Length < 1 || paths.Length > 512 ||
                paths.Length != isDirectories.Length ||
                paths.Length != isReparsePoints.Length ||
                paths.Length != expectedStableIds.Length)
                throw new ArgumentException("ACL batch arrays must have the same reviewed 1-512 length.");
            if (maximumDegreeOfParallelism < 1 || maximumDegreeOfParallelism > 8)
                throw new ArgumentOutOfRangeException(nameof(maximumDegreeOfParallelism));
            var options = new ParallelOptions
            {
                MaxDegreeOfParallelism = maximumDegreeOfParallelism
            };
            Parallel.For(0, paths.Length, options, index =>
            {
                try
                {
                    SetAndVerifyPath(
                        paths[index],
                        identitySid,
                        isDirectories[index],
                        isReparsePoints[index],
                        isDirectories[index] && !isReparsePoints[index],
                        expectedStableIds[index]);
                }
                catch (Exception error)
                {
                    throw new InvalidOperationException(
                        $"ACL batch entry failed at {paths[index]}: {error.Message}",
                        error);
                }
            });
        }

        public static void Verify(string path, string identitySid)
        {
            var expected = Inspect(path);
            if (!expected.IsDirectory || !expected.IsReparsePoint ||
                expected.ReparseTag != IoReparseTagMountPoint)
                throw new InvalidOperationException("ACL target is not a directory junction.");
            VerifyExactPath(path, identitySid, true, true, false, expected.StableId);
        }

        public static void VerifyExactPath(
            string path,
            string identitySid,
            bool isDirectory,
            bool isReparsePoint,
            bool inheritToChildren,
            string expectedStableId)
        {
            _ = new SecurityIdentifier(identitySid);
            using var handle = Open(path, ReadControl, true);
            ValidateExpectedIdentity(
                ReadAndValidateIdentity(handle),
                expectedStableId,
                isDirectory,
                isReparsePoint);
            VerifyDescriptor(ReadDescriptor(handle), identitySid, inheritToChildren);
        }

        public static void VerifyBatch(
            string[] paths,
            bool[] isDirectories,
            bool[] isReparsePoints,
            string[] expectedStableIds,
            string identitySid,
            int maximumDegreeOfParallelism)
        {
            if (paths == null || isDirectories == null || isReparsePoints == null ||
                expectedStableIds == null ||
                paths.Length < 1 || paths.Length > 512 ||
                paths.Length != isDirectories.Length ||
                paths.Length != isReparsePoints.Length ||
                paths.Length != expectedStableIds.Length)
                throw new ArgumentException("ACL verification arrays must have the same reviewed 1-512 length.");
            if (maximumDegreeOfParallelism < 1 || maximumDegreeOfParallelism > 8)
                throw new ArgumentOutOfRangeException(nameof(maximumDegreeOfParallelism));
            var options = new ParallelOptions
            {
                MaxDegreeOfParallelism = maximumDegreeOfParallelism
            };
            Parallel.For(0, paths.Length, options, index =>
            {
                try
                {
                    VerifyExactPath(
                        paths[index],
                        identitySid,
                        isDirectories[index],
                        isReparsePoints[index],
                        isDirectories[index] && !isReparsePoints[index],
                        expectedStableIds[index]);
                }
                catch (Exception error)
                {
                    throw new InvalidOperationException(
                        $"Final ACL verification failed at {paths[index]}: {error.Message}",
                        error);
                }
            });
        }

        private static SafeFileHandle Open(
            string path,
            uint desiredAccess,
            bool shareDelete)
        {
            var shareMode = FileShareRead | FileShareWrite;
            if (shareDelete)
                shareMode |= FileShareDelete;
            var handle = CreateFileW(
                ToExtendedPath(path),
                desiredAccess,
                shareMode,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, $"Unable to open ACL target (Win32 error {error}).");
            }
            return handle;
        }

        private static PathIdentity ReadAndValidateIdentity(SafeFileHandle handle)
        {
            if (!GetFileInformationByHandle(handle, out var fileInformation))
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Unable to read the ACL target file identity.");
            if (!GetFileInformationByHandleEx(
                    handle,
                    FileAttributeTagInfoClass,
                    out var tagInformation,
                    (uint)Marshal.SizeOf<FileAttributeTagInformation>()))
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Unable to read the ACL target reparse identity.");
            var identityAttributes = fileInformation.FileAttributes &
                (FileAttributeDirectory | FileAttributeReparsePoint);
            var tagAttributes = tagInformation.FileAttributes &
                (FileAttributeDirectory | FileAttributeReparsePoint);
            if (identityAttributes != tagAttributes)
                throw new InvalidOperationException("ACL target attributes changed while its handle was open.");
            var isDirectory = (identityAttributes & FileAttributeDirectory) != 0;
            var isReparsePoint = (identityAttributes & FileAttributeReparsePoint) != 0;
            var reparseTag = isReparsePoint ? tagInformation.ReparseTag : 0;
            if (isReparsePoint && (!isDirectory || reparseTag != IoReparseTagMountPoint))
                throw new InvalidOperationException("ACL target is an unsupported reparse point.");
            if (!isDirectory && !isReparsePoint && fileInformation.NumberOfLinks != 1)
                throw new InvalidOperationException("Regular release files must have exactly one hard link.");
            var fileIndex = ((ulong)fileInformation.FileIndexHigh << 32) |
                fileInformation.FileIndexLow;
            var stableId = $"{fileInformation.VolumeSerialNumber:x8}:{fileIndex:x16}";
            return new PathIdentity(
                stableId,
                isDirectory,
                isReparsePoint,
                reparseTag,
                fileInformation.NumberOfLinks);
        }

        private static void ValidateExpectedIdentity(
            PathIdentity observed,
            string expectedStableId,
            bool expectedDirectory,
            bool expectedReparsePoint)
        {
            if (!string.Equals(observed.StableId, expectedStableId, StringComparison.Ordinal) ||
                observed.IsDirectory != expectedDirectory ||
                observed.IsReparsePoint != expectedReparsePoint)
                throw new InvalidOperationException("ACL target identity or type changed after inventory.");
        }

        private static string ToExtendedPath(string path)
        {
            var fullPath = System.IO.Path.GetFullPath(path);
            if (fullPath.StartsWith(@"\\?\", StringComparison.Ordinal))
                return fullPath;
            if (fullPath.StartsWith(@"\\", StringComparison.Ordinal))
                return @"\\?\UNC\" + fullPath.Substring(2);
            return @"\\?\" + fullPath;
        }

        private static RawSecurityDescriptor ReadDescriptor(SafeFileHandle handle)
        {
            GetKernelObjectSecurity(handle, DaclSecurityInformation, null, 0, out var needed);
            var firstError = Marshal.GetLastWin32Error();
            if (needed == 0 || firstError != ErrorInsufficientBuffer)
                throw new Win32Exception(firstError, "Unable to size the reparse-point security descriptor.");
            var buffer = new byte[needed];
            if (!GetKernelObjectSecurity(
                    handle,
                    DaclSecurityInformation,
                    buffer,
                    (uint)buffer.Length,
                    out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Unable to read the reparse-point security descriptor.");
            return new RawSecurityDescriptor(buffer, 0);
        }

        private static void VerifyDescriptor(
            RawSecurityDescriptor descriptor,
            string identitySid,
            bool inheritToChildren)
        {
            if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                descriptor.DiscretionaryAcl == null ||
                descriptor.DiscretionaryAcl.Count != 2)
                throw new InvalidOperationException("Reparse-point DACL is not an exact protected two-ACE contract.");

            var userSeen = false;
            var systemSeen = false;
            var readExecute = (int)(FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
            var fullControl = (int)FileSystemRights.FullControl;
            var inheritanceMask = AceFlags.ContainerInherit | AceFlags.ObjectInherit |
                                  AceFlags.InheritOnly | AceFlags.NoPropagateInherit;
            var expectedInheritance = inheritToChildren
                ? AceFlags.ContainerInherit | AceFlags.ObjectInherit
                : AceFlags.None;
            foreach (GenericAce genericAce in descriptor.DiscretionaryAcl)
            {
                if (genericAce is not CommonAce ace ||
                    ace.AceQualifier != AceQualifier.AccessAllowed ||
                    (ace.AceFlags & AceFlags.Inherited) != 0 ||
                    (ace.AceFlags & inheritanceMask) != expectedInheritance)
                    throw new InvalidOperationException("Protected DACL contains an unexpected ACE.");
                var sid = ace.SecurityIdentifier.Value;
                if (string.Equals(sid, identitySid, StringComparison.Ordinal))
                {
                    if (userSeen || ace.AccessMask != readExecute)
                        throw new InvalidOperationException("Protected DACL runtime identity rights are invalid.");
                    userSeen = true;
                }
                else if (string.Equals(sid, "S-1-5-18", StringComparison.Ordinal))
                {
                    if (systemSeen || ace.AccessMask != fullControl)
                        throw new InvalidOperationException("Protected DACL LocalSystem rights are invalid.");
                    systemSeen = true;
                }
                else
                {
                    throw new InvalidOperationException("Protected DACL contains an unexpected identity.");
                }
            }
            if (!userSeen || !systemSeen)
                throw new InvalidOperationException("Protected DACL is missing a required identity.");
        }
    }
}
'@
}

function New-ExplicitProtectedFileSystemAcl {
  param(
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][bool]$IsDirectory,
    [switch]$InheritToChildren
  )

  if ($IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Explicit ACL identity SID is invalid."
  }
  if ($InheritToChildren -and -not $IsDirectory) {
    throw "Only a directory ACL can inherit to children."
  }
  $security = if ($IsDirectory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $security.SetAccessRuleProtection($true, $false)
  $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
  if ($InheritToChildren) {
    $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags](
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
  }
  $propagationFlags = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  foreach ($rule in @(
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($IdentitySid),
        [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
        $inheritanceFlags,
        $propagationFlags,
        $allow
      ),
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritanceFlags,
        $propagationFlags,
        $allow
      )
    )) {
    [void]$security.AddAccessRule($rule)
  }
  return $security
}

function Assert-ExplicitProtectedPathAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][bool]$IsDirectory,
    [switch]$InheritToChildren
  )

  $item = if ($IsDirectory) {
    [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($Path))
  } else {
    [System.IO.FileInfo]::new([System.IO.Path]::GetFullPath($Path))
  }
  $security = if ($IsDirectory) {
    [System.IO.FileSystemAclExtensions]::GetAccessControl(
      [System.IO.DirectoryInfo]$item,
      [System.Security.AccessControl.AccessControlSections]::Access
    )
  } else {
    [System.IO.FileSystemAclExtensions]::GetAccessControl(
      [System.IO.FileInfo]$item,
      [System.Security.AccessControl.AccessControlSections]::Access
    )
  }
  if (-not $security.AreAccessRulesProtected) {
    throw "Explicit-entry DACL is not protected: $Path"
  }
  $rules = @($security.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))
  if ($rules.Count -ne 2) {
    throw "Explicit-entry DACL must contain exactly two ACEs: $Path"
  }
  $expectedInheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
  if ($InheritToChildren) {
    $expectedInheritanceFlags = [System.Security.AccessControl.InheritanceFlags](
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
  }
  $expectedSids = @($IdentitySid, "S-1-5-18")
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $expectedReadExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
  foreach ($rule in $rules) {
    $sid = ([System.Security.Principal.SecurityIdentifier]$rule.IdentityReference).Value
    if ([string]$rule.AccessControlType -cne "Allow" -or
        [bool]$rule.IsInherited -or
        $rule.InheritanceFlags -ne $expectedInheritanceFlags -or
        $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
        $sid -notin $expectedSids -or
        -not $seen.Add($sid)) {
      throw "Explicit-entry DACL contains an unexpected ACE: $Path"
    }
    $rights = [System.Security.AccessControl.FileSystemRights]$rule.FileSystemRights
    if ($sid -ceq "S-1-5-18") {
      if ($rights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw "Explicit-entry DACL does not grant LocalSystem full control: $Path"
      }
    } elseif ($rights -ne $expectedReadExecute) {
      throw "Explicit-entry DACL does not restrict the runtime identity to read and execute: $Path"
    }
  }
  foreach ($sid in $expectedSids) {
    if (-not $seen.Contains($sid)) {
      throw "Explicit-entry DACL is missing required identity $sid at $Path."
    }
  }
  return $true
}

function Set-ExplicitProtectedPathAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][bool]$IsDirectory,
    [Parameter(Mandatory)][string]$ExpectedStableId,
    [switch]$IsReparsePoint,
    [switch]$InheritToChildren
  )

  if ($IsReparsePoint -and (-not $IsDirectory -or $InheritToChildren)) {
    throw "Only non-inheriting directory junction DACLs are supported."
  }
  Initialize-NativeReparsePointAcl
  [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::SetAndVerifyPath(
    [System.IO.Path]::GetFullPath($Path),
    $IdentitySid,
    $IsDirectory,
    [bool]$IsReparsePoint,
    [bool]$InheritToChildren,
    $ExpectedStableId
  )
}

function Get-ReleaseAclInventory {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][System.Collections.IDictionary]$AllowedWorkspaceLinks,
    [Parameter(Mandatory)][ValidateRange(1, 300000)][int]$MaximumEntries,
    [Parameter(Mandatory)][ValidateSet("before", "after")][string]$Phase
  )

  $rootFull = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
  Initialize-NativeReparsePointAcl
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if (-not $rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release ACL inventory root must be a non-reparse directory."
  }
  $options = [System.IO.EnumerationOptions]::new()
  $options.RecurseSubdirectories = $false
  $options.IgnoreInaccessible = $false
  $options.AttributesToSkip = [System.IO.FileAttributes]0
  $options.ReturnSpecialDirectories = $false
  $pending = [System.Collections.Generic.Stack[object]]::new()
  $pending.Push([pscustomobject]@{ directory = [System.IO.DirectoryInfo]::new($rootFull); depth = 0 })
  $entries = [System.Collections.Generic.List[object]]::new()
  $inventoryLines = [System.Collections.Generic.List[string]]::new()
  $observedLinks = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  Write-Host "[release-acl:inventory-$Phase-start]"
  while ($pending.Count -gt 0) {
    $cursor = $pending.Pop()
    foreach ($item in $cursor.directory.EnumerateFileSystemInfos("*", $options)) {
      if ($entries.Count -ge $MaximumEntries) {
        throw "Release ACL inventory exceeds the reviewed $MaximumEntries-entry limit."
      }
      $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
      if (-not $fullPath.StartsWith("$rootFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release ACL inventory escaped its root."
      }
      $relativePath = [System.IO.Path]::GetRelativePath($rootFull, $fullPath).Replace("\", "/")
      if ($relativePath.Length -gt 32767 -or ($cursor.depth + 1) -gt 128) {
        throw "Release ACL inventory path length or depth exceeds its reviewed limit."
      }
      $isDirectory = [bool](($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
      $isReparsePoint = [bool](($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
      $nativeIdentity = [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Inspect($fullPath)
      if ([bool]$nativeIdentity.IsDirectory -ne $isDirectory -or
          [bool]$nativeIdentity.IsReparsePoint -ne $isReparsePoint) {
        throw "Release ACL inventory path type changed while it was inspected: $relativePath"
      }
      $stableId = [string]$nativeIdentity.StableId
      $linkCount = [uint32]$nativeIdentity.LinkCount
      $reparseTag = [uint32]$nativeIdentity.ReparseTag
      $linkTargetRelative = ""
      if ($isReparsePoint) {
        if (-not $isDirectory -or [string]$item.LinkType -cne "Junction" -or
            -not $AllowedWorkspaceLinks.ContainsKey($relativePath)) {
          throw "Release ACL inventory found an undeclared or unsupported reparse point: $relativePath"
        }
        $resolvedTarget = $item.ResolveLinkTarget($false)
        if ($null -eq $resolvedTarget) {
          throw "Release ACL inventory could not resolve workspace junction: $relativePath"
        }
        $targetFull = [System.IO.Path]::GetFullPath($resolvedTarget.FullName)
        $linkTargetRelative = [string]$AllowedWorkspaceLinks[$relativePath]
        $expectedTarget = [System.IO.Path]::GetFullPath((Join-Path $rootFull $linkTargetRelative))
        if (-not [string]::Equals($targetFull, $expectedTarget, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not $targetFull.StartsWith("$rootFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Release ACL inventory workspace junction target drifted: $relativePath"
        }
        $junctionIdentityAfterTargetRead = [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Inspect($fullPath)
        if ([string]$junctionIdentityAfterTargetRead.StableId -cne $stableId -or
            -not [bool]$junctionIdentityAfterTargetRead.IsDirectory -or
            -not [bool]$junctionIdentityAfterTargetRead.IsReparsePoint) {
          throw "Release ACL inventory workspace junction changed while its target was inspected: $relativePath"
        }
        [void]$observedLinks.Add($relativePath)
      }
      $entry = [pscustomobject]@{
        path = $fullPath
        relativePath = $relativePath
        depth = [int]($cursor.depth + 1)
        isDirectory = $isDirectory
        isReparsePoint = $isReparsePoint
        stableId = $stableId
        linkCount = $linkCount
        reparseTag = $reparseTag
        linkTargetRelative = $linkTargetRelative
      }
      $entries.Add($entry)
      $inventoryLines.Add("$relativePath`0$([int]$isDirectory)`0$([int]$isReparsePoint)`0$stableId`0$linkCount`0$reparseTag`0$linkTargetRelative")
      if ($entries.Count % 1024 -eq 0) {
        Write-Host "[release-acl:inventory-$Phase-progress] entries=$($entries.Count)"
      }
      if ($isDirectory -and -not $isReparsePoint) {
        $pending.Push([pscustomobject]@{
            directory = [System.IO.DirectoryInfo]$item
            depth = [int]($cursor.depth + 1)
          })
      }
    }
  }
  if ($observedLinks.Count -ne $AllowedWorkspaceLinks.Count) {
    throw "Release ACL inventory did not observe every declared workspace junction."
  }
  $inventoryLines.Sort([System.StringComparer]::Ordinal)
  $inventoryText = [string]::Join("`n", $inventoryLines)
  $inventorySha256 = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData(
      [System.Text.Encoding]::UTF8.GetBytes($inventoryText)
    )
  ).ToLowerInvariant()
  Write-Host "[release-acl:inventory-$Phase-complete] entries=$($entries.Count) reparsePoints=$($observedLinks.Count) inventorySha256=$inventorySha256"
  return [ordered]@{
    entries = @($entries)
    entryCount = $entries.Count
    reparsePointCount = $observedLinks.Count
    inventorySha256 = $inventorySha256
  }
}

function Invoke-ReleaseTreeAclWorker {
  param(
    [Parameter(Mandatory)][string]$ContainmentRoot,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][string]$AllowedWorkspaceLinksBase64
  )

  $containmentFull = [System.IO.Path]::GetFullPath($ContainmentRoot).TrimEnd("\")
  $deploymentRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $script:CanonicalRepositoryRoot ".local\deployment")
  ).TrimEnd("\")
  $approvedContainmentRoots = [ordered]@{
    releases = [System.IO.Path]::GetFullPath((Join-Path $deploymentRoot "releases")).TrimEnd("\")
    staging = [System.IO.Path]::GetFullPath((Join-Path $deploymentRoot "staging")).TrimEnd("\")
    failed = [System.IO.Path]::GetFullPath((Join-Path $deploymentRoot "failed")).TrimEnd("\")
  }
  $containmentKind = @($approvedContainmentRoots.GetEnumerator() | Where-Object {
      [string]::Equals(
        [string]$_.Value,
        $containmentFull,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    } | Select-Object -ExpandProperty Key)
  if ($containmentKind.Count -ne 1) {
    throw "Release ACL worker containment root is outside an approved deployment directory."
  }
  $releaseFull = Assert-ContainedPath -Root $containmentFull -Path $ReleaseRoot
  if (-not [string]::Equals(
      [System.IO.Path]::GetDirectoryName($releaseFull),
      $containmentFull,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Release ACL worker root must be a direct child of its approved containment directory."
  }
  $releaseName = [System.IO.Path]::GetFileName($releaseFull)
  $releaseNameAccepted = switch ([string]$containmentKind[0]) {
    "releases" { $releaseName -cmatch "^[0-9a-f]{40}$"; break }
    "staging" { $releaseName -cmatch "^acl-protection-test-[0-9a-f]{32}$"; break }
    "failed" {
      $releaseName -cmatch "^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}-(release|staging)$"
      break
    }
    default { $false }
  }
  if (-not $releaseNameAccepted) {
    throw "Release ACL worker root name does not match its approved containment contract."
  }
  if ($IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Release ACL worker identity SID is invalid."
  }
  $allowedJson = try {
    [System.Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($AllowedWorkspaceLinksBase64)
    )
  } catch {
    throw "Release ACL worker workspace-link contract is not valid base64."
  }
  $allowedArray = try {
    @(ConvertFrom-Json -InputObject $allowedJson -AsHashtable -Depth 10)
  } catch {
    throw "Release ACL worker workspace-link contract is not valid JSON."
  }
  $allowedLinks = [System.Collections.Generic.SortedDictionary[string,string]]::new(
    [System.StringComparer]::Ordinal
  )
  foreach ($link in $allowedArray) {
    if ($link -isnot [System.Collections.IDictionary] -or
        @($link.Keys | Where-Object { $_ -notin @("linkPath", "targetRelativePath") }).Count -ne 0 -or
        @(@("linkPath", "targetRelativePath") | Where-Object { $_ -notin $link.Keys }).Count -ne 0) {
      throw "Release ACL worker workspace-link contract is malformed."
    }
    $linkPath = ([string]$link.linkPath).Replace("\", "/")
    $targetPath = ([string]$link.targetRelativePath).Replace("\", "/")
    if ($linkPath -cnotmatch "^node_modules/@unified-ai/[a-z0-9-]+$" -or
        $targetPath -cnotmatch "^(apps|packages|services)/[a-z0-9-]+$" -or
        $allowedLinks.ContainsKey($linkPath)) {
      throw "Release ACL worker workspace-link contract is unsafe or duplicated."
    }
    $allowedLinks.Add($linkPath, $targetPath)
  }
  if ($allowedLinks.Count -gt 100) {
    throw "Release ACL worker workspace-link count is outside its reviewed range."
  }

  Initialize-NativeReparsePointAcl
  $rootIdentity = [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Inspect($releaseFull)
  if (-not [bool]$rootIdentity.IsDirectory -or [bool]$rootIdentity.IsReparsePoint) {
    throw "Release ACL worker root must remain a non-reparse directory."
  }
  $rootGuard = [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::OpenRootGuard(
    $releaseFull,
    [string]$rootIdentity.StableId
  )
  try {
    $before = Get-ReleaseAclInventory `
      -ReleaseRoot $releaseFull `
      -AllowedWorkspaceLinks $allowedLinks `
      -MaximumEntries $script:RuntimeAttestationMaximumAclEntries `
      -Phase before
    $orderedEntries = @($before.entries | Sort-Object `
        @{ Expression = "depth"; Descending = $true },
        @{ Expression = "relativePath"; Descending = $false })
    $protectedCount = 0
    Write-Host "[release-acl:protection-start] entries=$($before.entryCount)"
    $depthGroups = @($orderedEntries | Group-Object depth | Sort-Object {
          [int]$_.Name
        } -Descending)
    foreach ($depthGroup in $depthGroups) {
      $depthEntries = @($depthGroup.Group | Sort-Object relativePath)
      for ($offset = 0; $offset -lt $depthEntries.Count; $offset += 512) {
        $batchCount = [Math]::Min(512, $depthEntries.Count - $offset)
        $batchPaths = [string[]]::new($batchCount)
        $batchDirectories = [bool[]]::new($batchCount)
        $batchReparsePoints = [bool[]]::new($batchCount)
        $batchStableIds = [string[]]::new($batchCount)
        for ($batchIndex = 0; $batchIndex -lt $batchCount; $batchIndex++) {
          $entry = $depthEntries[$offset + $batchIndex]
          $batchPaths[$batchIndex] = [string]$entry.path
          $batchDirectories[$batchIndex] = [bool]$entry.isDirectory
          $batchReparsePoints[$batchIndex] = [bool]$entry.isReparsePoint
          $batchStableIds[$batchIndex] = [string]$entry.stableId
        }
        [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::SetAndVerifyBatch(
          $batchPaths,
          $batchDirectories,
          $batchReparsePoints,
          $batchStableIds,
          $IdentitySid,
          4
        )
        $protectedCount += $batchCount
        Write-Host "[release-acl:protection-progress] protected=$protectedCount total=$($before.entryCount)"
      }
    }
    Set-ExplicitProtectedPathAcl `
      -Path $releaseFull `
      -IdentitySid $IdentitySid `
      -IsDirectory $true `
      -ExpectedStableId ([string]$rootIdentity.StableId) `
      -InheritToChildren
    Write-Host "[release-acl:root-protected]"
    $after = Get-ReleaseAclInventory `
      -ReleaseRoot $releaseFull `
      -AllowedWorkspaceLinks $allowedLinks `
      -MaximumEntries $script:RuntimeAttestationMaximumAclEntries `
      -Phase after
    if ([int]$after.entryCount -ne [int]$before.entryCount -or
        [int]$after.reparsePointCount -ne [int]$before.reparsePointCount -or
        [string]$after.inventorySha256 -cne [string]$before.inventorySha256) {
      throw "Release ACL inventory changed during protection."
    }
    $finalEntries = @($after.entries | Sort-Object relativePath)
    $verifiedCount = 0
    Write-Host "[release-acl:final-verification-start] entries=$($after.entryCount)"
    for ($offset = 0; $offset -lt $finalEntries.Count; $offset += 512) {
      $batchCount = [Math]::Min(512, $finalEntries.Count - $offset)
      $batchPaths = [string[]]::new($batchCount)
      $batchDirectories = [bool[]]::new($batchCount)
      $batchReparsePoints = [bool[]]::new($batchCount)
      $batchStableIds = [string[]]::new($batchCount)
      for ($batchIndex = 0; $batchIndex -lt $batchCount; $batchIndex++) {
        $entry = $finalEntries[$offset + $batchIndex]
        $batchPaths[$batchIndex] = [string]$entry.path
        $batchDirectories[$batchIndex] = [bool]$entry.isDirectory
        $batchReparsePoints[$batchIndex] = [bool]$entry.isReparsePoint
        $batchStableIds[$batchIndex] = [string]$entry.stableId
      }
      [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::VerifyBatch(
        $batchPaths,
        $batchDirectories,
        $batchReparsePoints,
        $batchStableIds,
        $IdentitySid,
        4
      )
      $verifiedCount += $batchCount
      Write-Host "[release-acl:final-verification-progress] verified=$verifiedCount total=$($after.entryCount)"
    }
    [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::VerifyExactPath(
      $releaseFull,
      $IdentitySid,
      $true,
      $false,
      $true,
      [string]$rootIdentity.StableId
    )
    Write-Host "[release-acl:final-verification-complete] entries=$verifiedCount"
    Write-Host "[release-acl:complete] entries=$($before.entryCount) reparsePoints=$($before.reparsePointCount) inventorySha256=$($before.inventorySha256)"
  } finally {
    $rootGuard.Dispose()
  }
}

function Invoke-ReleaseTreeAclProtectionProcess {
  param(
    [Parameter(Mandatory)][string]$ContainmentRoot,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$WorkspaceLinks,
    [Parameter(Mandatory)][ValidateRange(1, 1800)][int]$TimeoutSeconds
  )

  $contracts = @($WorkspaceLinks | ForEach-Object {
      [ordered]@{
        linkPath = [string]$_.linkPath
        targetRelativePath = [string]$_.targetRelativePath
      }
    })
  $contractJson = ConvertTo-Json -InputObject $contracts -Compress -Depth 5
  $contractBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($contractJson)
  )
  $pwshPath = [string](Get-Process -Id $PID).Path
  $result = Invoke-BoundedProcess `
    -FilePath $pwshPath `
    -ArgumentList @(
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-File", $script:DeploymentCommonPath,
      "-ReleaseAclWorker",
      "-ReleaseAclContainmentRoot", $ContainmentRoot,
      "-ReleaseAclRoot", $ReleaseRoot,
      "-ReleaseAclIdentitySid", $IdentitySid,
      "-ReleaseAclAllowedReparsePathsBase64", $contractBase64
    ) `
    -WorkingDirectory $ContainmentRoot `
    -TimeoutSeconds $TimeoutSeconds `
    -IdleTimeoutSeconds 60 `
    -MaxOutputCharacters 1048576 `
    -Context "Explicit-entry release ACL protection" `
    -EchoOutput
  if ([int]$result.exitCode -ne 0) {
    throw "Explicit-entry release ACL protection failed: $([string]$result.stderr)"
  }
  $completion = [regex]::Match(
    [string]$result.stdout,
    "(?m)^\[release-acl:complete\] entries=(?<entries>[0-9]+) reparsePoints=(?<links>[0-9]+) inventorySha256=(?<sha>[0-9a-f]{64})\r?$"
  )
  if (-not $completion.Success) {
    throw "Explicit-entry release ACL protection did not emit its completion receipt."
  }
  return [ordered]@{
    entryCount = [int]$completion.Groups["entries"].Value
    reparsePointCount = [int]$completion.Groups["links"].Value
    inventorySha256 = [string]$completion.Groups["sha"].Value
    elapsedMilliseconds = [int64]$result.elapsedMilliseconds
  }
}

function Assert-ProtectedAclContract {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][ValidateSet("ReadAndExecute", "FullControl")][string]$IdentityAccess,
    [ValidateSet("Inherited", "Explicit")][string]$DescendantAclMode = "Inherited",
    [switch]$Recursive,
    [string[]]$BoundedPaths = @()
  )

  if (-not (Test-Path -LiteralPath $script:CanonicalIcaclsPath -PathType Leaf)) {
    throw "Pinned Windows ACL utility is unavailable: $script:CanonicalIcaclsPath"
  }
  if (-not (Test-Path -LiteralPath $Path) -or $IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Protected ACL path or identity is invalid."
  }
  if ($Recursive -and $BoundedPaths.Count -gt 0) {
    throw "Protected ACL validation cannot be both recursive and bounded."
  }
  $rootFull = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Protected ACL root must not be a reparse point: $rootFull"
  }
  $paths = [System.Collections.Generic.List[string]]::new()
  $pathSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $paths.Add($rootFull)
  [void]$pathSet.Add($rootFull)
  if ($Recursive) {
    foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Recurse -Force)) {
      $paths.Add([System.IO.Path]::GetFullPath($item.FullName))
    }
  } else {
    if ($BoundedPaths.Count -gt 256) {
      throw "Bounded protected ACL path count exceeds the reviewed limit."
    }
    foreach ($boundedPath in $BoundedPaths) {
      $boundedFull = [System.IO.Path]::GetFullPath($boundedPath).TrimEnd("\")
      if (-not $boundedFull.StartsWith("$rootFull\", [System.StringComparison]::OrdinalIgnoreCase) -or
          -not (Test-Path -LiteralPath $boundedFull)) {
        throw "Bounded protected ACL path is missing or outside its root: $boundedFull"
      }
      if ($pathSet.Add($boundedFull)) {
        $paths.Add($boundedFull)
      }
    }
  }
  if ($paths.Count -gt 300000) {
    throw "Protected ACL tree exceeds the reviewed validation limit."
  }
  $expectedSids = @($IdentitySid, "S-1-5-18")
  $expectedReadExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
  for ($pathIndex = 0; $pathIndex -lt $paths.Count; $pathIndex++) {
    $protectedPath = $paths[$pathIndex]
    $isRootPath = [string]::Equals(
      $protectedPath,
      $rootFull,
      [System.StringComparison]::OrdinalIgnoreCase
    )
    $protectedItem = Get-Item -LiteralPath $protectedPath -Force
    $isReparsePoint = ($protectedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($DescendantAclMode -ceq "Explicit" -and $isReparsePoint) {
      if ($isRootPath -or -not $protectedItem.PSIsContainer -or [string]$protectedItem.LinkType -cne "Junction") {
        throw "Explicit release ACL verification found an unsupported reparse point: $protectedPath"
      }
      Initialize-NativeReparsePointAcl
      [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Verify($protectedPath, $IdentitySid)
      continue
    }
    $acl = Get-Acl -LiteralPath $protectedPath
    $expectProtected = $isRootPath -or $DescendantAclMode -ceq "Explicit"
    $expectInherited = -not $isRootPath -and $DescendantAclMode -ceq "Inherited"
    if ([bool]$acl.AreAccessRulesProtected -ne $expectProtected) {
      throw "Protected ACL inheritance state is incorrect: $protectedPath"
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in @($acl.Access)) {
      $sid = try {
        $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      } catch {
        throw "Protected ACL contains an unresolvable identity: $protectedPath"
      }
      if ([string]$rule.AccessControlType -cne "Allow" -or
          [bool]$rule.IsInherited -ne $expectInherited -or
          $sid -notin $expectedSids -or
          -not $seen.Add($sid)) {
        throw "Protected ACL contains an unexpected, inherited, or duplicate rule for $sid at $protectedPath."
      }
      $rights = [System.Security.AccessControl.FileSystemRights]$rule.FileSystemRights
      if ($sid -ceq "S-1-5-18") {
        if ($rights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
          throw "Protected ACL does not grant LocalSystem full control: $protectedPath"
        }
      } elseif ($IdentityAccess -ceq "FullControl") {
        if ($rights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
          throw "Protected ACL does not grant the runtime identity full control: $protectedPath"
        }
      } elseif ($rights -ne $expectedReadExecute) {
        throw "Protected ACL does not restrict the runtime identity to read and execute: $protectedPath"
      }
    }
    foreach ($sid in $expectedSids) {
      if (-not $seen.Contains($sid)) {
        throw "Protected ACL is missing required identity $sid at $protectedPath."
      }
    }
  }
  return $true
}

function Assert-IntegritySealProtection {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  return (Assert-ProtectedAclContract `
      -Path $Path `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute)
}

function Protect-ReleaseDirectory {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][string[]]$CriticalPaths,
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$WorkspaceLinks
  )

  [void](Assert-ContainedPath -Root $Layout.Releases -Path $ReleaseRoot)
  if ($IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Release protection identity SID is invalid."
  }
  $protection = Invoke-ReleaseTreeAclProtectionProcess `
    -ContainmentRoot $Layout.Releases `
    -ReleaseRoot $ReleaseRoot `
    -IdentitySid $IdentitySid `
    -WorkspaceLinks $WorkspaceLinks `
    -TimeoutSeconds $script:RuntimeAttestationReleaseProtectionTimeoutSeconds
  [void](Assert-BoundedReleaseDirectoryProtection `
      -Layout $Layout `
      -ReleaseRoot $ReleaseRoot `
      -IdentitySid $IdentitySid `
      -CriticalPaths $CriticalPaths `
      -DescendantAclMode Explicit)
  return $protection
}

function Assert-BoundedReleaseDirectoryProtection {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][string[]]$CriticalPaths,
    [ValidateSet("Inherited", "Explicit")][string]$DescendantAclMode = "Inherited"
  )

  [void](Assert-ContainedPath -Root $Layout.Releases -Path $ReleaseRoot)
  if ($CriticalPaths.Count -lt 8 -or $CriticalPaths.Count -gt 256) {
    throw "Bounded release ACL verification path count is outside the reviewed range."
  }
  return (Assert-ProtectedAclContract `
      -Path $ReleaseRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -DescendantAclMode $DescendantAclMode `
      -BoundedPaths $CriticalPaths)
}

function Assert-ReleaseDirectoryProtection {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid,
    [ValidateSet("Inherited", "Explicit")][string]$DescendantAclMode = "Inherited"
  )

  [void](Assert-ContainedPath -Root $Layout.Releases -Path $ReleaseRoot)
  return (Assert-ProtectedAclContract `
      -Path $ReleaseRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -DescendantAclMode $DescendantAclMode `
      -Recursive)
}

function Test-RecoveryControllerManifest {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$SourceRoot,
    [string]$ExpectedControllerVersion = $script:CanonicalControllerVersion
  )

  [void](Assert-SupportedControllerVersion -ControllerVersion $ExpectedControllerVersion)
  $source = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Recovery controller source does not exist: $source"
  }
  $sourceItem = Get-Item -LiteralPath $source -Force
  if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Recovery controller source cannot be a reparse point."
  }
  $manifestPath = Join-Path $source "controller-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Recovery controller manifest is missing."
  }
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force
  if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Recovery controller manifest cannot be a reparse point."
  }
  $manifest = Read-JsonHashtable -Path $manifestPath
  $requiredKeys = @("schemaVersion", "controllerVersion", "files")
  $requiredFiles = @(
    "Deployment.Common.ps1",
    "Start-LocalRelease.ps1",
    "Stop-LocalRelease.ps1",
    "Rollback-LocalRelease.ps1",
    "Test-LocalRelease.ps1",
    "Test-LocalAiRuntime.ps1"
  )
  if (@($manifest.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $manifest.Keys }).Count -ne 0 -or
      [int]$manifest.schemaVersion -ne 1 -or
      [string]$manifest.controllerVersion -cne $ExpectedControllerVersion -or
      $manifest.files -isnot [System.Collections.IDictionary] -or
      @($manifest.files.Keys | Where-Object { $_ -notin $requiredFiles }).Count -ne 0 -or
      @($requiredFiles | Where-Object { $_ -notin $manifest.files.Keys }).Count -ne 0) {
    throw "Recovery controller manifest does not match the pinned controller contract."
  }
  foreach ($name in $requiredFiles) {
    if ($name -cnotmatch "^[A-Za-z0-9.-]+$" -or [string]$manifest.files[$name] -cnotmatch "^[0-9a-f]{64}$") {
      throw "Recovery controller manifest contains an invalid file contract."
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $source $name))
    $relative = [System.IO.Path]::GetRelativePath($source, $path)
    if ($relative.Contains("\") -or $relative.Contains("/") -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Recovery controller file is missing or outside the flat bundle: $name"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Recovery controller files cannot be reparse points: $name"
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne [string]$manifest.files[$name]) {
      throw "Recovery controller hash mismatch for $name."
    }
  }
  return [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$manifest.controllerVersion
    controllerManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceRoot = $source
    files = $manifest.files
  }
}

function Get-RecoveryControllerRoot {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerVersion,
    [Parameter(Mandatory)][string]$ControllerManifestSha256
  )

  [void](Assert-SupportedControllerVersion -ControllerVersion $ControllerVersion)
  if ($ControllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Recovery controller identity is invalid."
  }
  return (Assert-ContainedPath `
      -Root $Layout.Controllers `
      -Path (Join-Path $Layout.Controllers "$ControllerVersion-$ControllerManifestSha256"))
}

function Assert-RecoveryControllerProtection {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerRoot,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Controllers -Path $ControllerRoot)
  return (Assert-ProtectedAclContract `
      -Path $ControllerRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -Recursive)
}

function Test-InstalledRecoveryController {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerRoot,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory)][string]$IdentitySid,
    [string]$ExpectedControllerVersion = $script:CanonicalControllerVersion
  )

  [void](Assert-SupportedControllerVersion -ControllerVersion $ExpectedControllerVersion)
  $receipt = Test-RecoveryControllerManifest `
    -Layout $Layout `
    -SourceRoot $ControllerRoot `
    -ExpectedControllerVersion $ExpectedControllerVersion
  $expectedRoot = Get-RecoveryControllerRoot `
    -Layout $Layout `
    -ControllerVersion ([string]$receipt.controllerVersion) `
    -ControllerManifestSha256 $ExpectedManifestSha256
  if (-not [string]::Equals($ControllerRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$receipt.controllerManifestSha256 -cne $ExpectedManifestSha256) {
    throw "Installed recovery controller identity does not match its contained manifest."
  }
  $expectedEntries = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($name in @($receipt.files.Keys) + @("controller-manifest.json")) {
    [void]$expectedEntries.Add([string]$name)
  }
  $actualEntries = @(Get-ChildItem -LiteralPath $ControllerRoot -Force)
  if ($actualEntries.Count -ne $expectedEntries.Count) {
    throw "Installed recovery controller must contain exactly the six scripts and manifest."
  }
  foreach ($entry in $actualEntries) {
    if ($entry.PSIsContainer -or
        ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not $expectedEntries.Contains($entry.Name)) {
      throw "Installed recovery controller contains an undeclared or unsafe entry: $($entry.Name)"
    }
  }
  [void](Assert-RecoveryControllerProtection `
      -Layout $Layout `
      -ControllerRoot $ControllerRoot `
      -IdentitySid $IdentitySid)
  return $receipt
}

function Assert-RecoveryControllerInstallationValue {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$State
  )

  $requiredKeys = @(
    "schemaVersion", "controllerVersion", "controllerManifestSha256", "controllerRoot",
    "identityName", "identitySid", "installedAtUtc"
  )
  if (@($State.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $State.Keys }).Count -ne 0 -or
      [int]$State.schemaVersion -ne 1 -or
      [string]$State.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$State.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Recovery controller installation state does not match the pinned contract."
  }
  [void](Assert-SupportedControllerVersion -ControllerVersion ([string]$State.controllerVersion))
  [void](Assert-UtcTimestamp -Value ([string]$State.installedAtUtc) -Context "Recovery controller installedAtUtc")
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$State.identitySid -cne [string]$currentIdentity.identitySid) {
    throw "Recovery controller was installed for a different Windows identity."
  }
  [void](Test-InstalledRecoveryController `
      -Layout $Layout `
      -ControllerRoot ([string]$State.controllerRoot) `
      -ExpectedManifestSha256 ([string]$State.controllerManifestSha256) `
      -IdentitySid ([string]$State.identitySid) `
      -ExpectedControllerVersion ([string]$State.controllerVersion))
  return $State
}

function Read-RecoveryControllerInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.ControllerInstallation
  return (Assert-RecoveryControllerInstallationValue -Layout $Layout -State $state)
}

function Assert-LastKnownGoodRecoveryControllerValue {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Pointer
  )

  $requiredKeys = @(
    "schemaVersion", "controllerVersion", "controllerManifestSha256", "controllerRoot",
    "qualifiedReleaseSha", "qualifiedAtUtc"
  )
  if (@($Pointer.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $Pointer.Keys }).Count -ne 0 -or
      [int]$Pointer.schemaVersion -ne 1 -or
      [string]$Pointer.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$Pointer.qualifiedReleaseSha -cnotmatch $script:ShaPattern) {
    throw "Last-known-good recovery controller pointer is invalid."
  }
  [void](Assert-SupportedControllerVersion -ControllerVersion ([string]$Pointer.controllerVersion))
  [void](Assert-UtcTimestamp -Value ([string]$Pointer.qualifiedAtUtc) -Context "Recovery controller qualifiedAtUtc")
  $identity = Get-CurrentWindowsIdentityReceipt
  [void](Test-InstalledRecoveryController `
      -Layout $Layout `
      -ControllerRoot ([string]$Pointer.controllerRoot) `
      -ExpectedManifestSha256 ([string]$Pointer.controllerManifestSha256) `
      -IdentitySid ([string]$identity.identitySid) `
      -ExpectedControllerVersion ([string]$Pointer.controllerVersion))
  return $Pointer
}

function Read-LastKnownGoodRecoveryController {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pointer = Read-JsonHashtable -Path $Layout.LastKnownGoodController
  return (Assert-LastKnownGoodRecoveryControllerValue -Layout $Layout -Pointer $pointer)
}

function Set-LastKnownGoodRecoveryController {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$QualifiedReleaseSha,
    [Parameter(Mandatory)][string]$TaskName
  )

  [void](Assert-CommitSha -CommitSha $QualifiedReleaseSha)
  $installation = Read-RecoveryControllerInstallation -Layout $Layout
  $current = Read-ReleasePointer -Path $Layout.Current
  if ([string]$current.commitSha -cne $QualifiedReleaseSha) {
    throw "Recovery controller can be qualified only for the active release."
  }
  $releaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha $QualifiedReleaseSha
  [void](Test-SealedRuntimeDependencyAttestation `
    -Layout $Layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $QualifiedReleaseSha `
    -ExpectedReceiptSha256 ([string]$current.runtimeDependencyReceiptSha256))
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  if ($null -eq (Get-LiveReleaseProcess -Layout $Layout -ExpectedSha $QualifiedReleaseSha)) {
    throw "Recovery controller cannot be qualified without the exact live release process."
  }
  $pointer = [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$installation.controllerVersion
    controllerManifestSha256 = [string]$installation.controllerManifestSha256
    controllerRoot = [string]$installation.controllerRoot
    qualifiedReleaseSha = $QualifiedReleaseSha
    qualifiedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-AtomicJson -Layout $Layout -Path $Layout.LastKnownGoodController -Value $pointer
  [void](Read-LastKnownGoodRecoveryController -Layout $Layout)
  return $pointer
}

function Get-ReleaseRoot {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$CommitSha
  )

  [void](Assert-CommitSha -CommitSha $CommitSha)
  return (Assert-ContainedPath -Root $Layout.Releases -Path (Join-Path $Layout.Releases $CommitSha))
}

function Get-ReleaseServerEntrypoint {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][System.Collections.IDictionary]$RuntimeReceipt
  )

  $schemaVersion = [int]$RuntimeReceipt.schemaVersion
  $relativePath = if ($schemaVersion -eq 6) {
    $script:BundledRuntimePath
  } elseif ($schemaVersion -in @(3, 4, 5)) {
    "apps/api/dist/server.js"
  } else {
    throw "Runtime receipt schema $schemaVersion has no reviewed server entrypoint."
  }
  $entrypoint = Assert-SafePayloadPath `
    -RelativePath $relativePath `
    -DestinationRoot ([System.IO.Path]::GetFullPath($ReleaseRoot))
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Selected release is missing required server entrypoint $relativePath."
  }
  $item = Get-Item -LiteralPath $entrypoint -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Selected release server entrypoint cannot be a reparse point."
  }
  return $entrypoint
}

function New-ReleasePointer {
  param(
    [Parameter(Mandatory)][string]$CommitSha,
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][string]$RuntimeDependencyReceiptSha256
  )

  if ($RuntimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Release pointer runtime dependency receipt SHA-256 is invalid."
  }
  return [ordered]@{
    schemaVersion = 2
    commitSha = $CommitSha
    runtimeDependencyReceiptSha256 = $RuntimeDependencyReceiptSha256
    activatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    reason = $Reason
  }
}

function Assert-ReleasePointerValue {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Pointer,
    [string]$Context = "release pointer"
  )

  $requiredKeys = @(
    "schemaVersion", "commitSha", "runtimeDependencyReceiptSha256", "activatedAtUtc", "reason"
  )
  if (@($Pointer.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $Pointer.Keys }).Count -ne 0 -or
      [int]$Pointer.schemaVersion -ne 2 -or
      [string]$Pointer.runtimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]::IsNullOrWhiteSpace([string]$Pointer.reason)) {
    throw "Invalid $Context."
  }
  [void](Assert-CommitSha -CommitSha ([string]$Pointer.commitSha))
  [void](Assert-UtcTimestamp -Value ([string]$Pointer.activatedAtUtc) -Context "$Context activatedAtUtc")
  return $Pointer
}

function Read-ReleasePointer {
  param([Parameter(Mandatory)][string]$Path)

  $pointer = Read-JsonHashtable -Path $Path
  return (Assert-ReleasePointerValue -Pointer $pointer -Context "release pointer $Path")
}

function Backup-DeploymentState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId
  )

  if ($OperationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$") {
    throw "Unsafe deployment operation id."
  }
  $stateMutex = Enter-DeploymentMutex
  try {
    $backupRoot = Assert-ContainedPath -Root $Layout.Backups -Path (Join-Path $Layout.Backups $OperationId)
    [void](New-Item -ItemType Directory -Path $backupRoot)
    $statePaths = @(
      $Layout.Current,
      $Layout.Previous,
      $Layout.Pending,
      $Layout.Process,
      $Layout.LastKnownGoodController,
      $Layout.ControllerInstallation,
      $Layout.TaskInstallation
    )
    $entries = [ordered]@{}
    foreach ($statePath in $statePaths) {
      $name = [System.IO.Path]::GetFileName($statePath)
      $present = Test-Path -LiteralPath $statePath -PathType Leaf
      $backupPath = Join-Path $backupRoot $name
      if ($present) {
        Copy-Item -LiteralPath $statePath -Destination $backupPath
      }
      $entries[$name] = [ordered]@{
        present = $present
        sha256 = if ($present) {
          (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else {
          $null
        }
      }
    }
    Write-AtomicJson -Layout $Layout -Path (Join-Path $backupRoot "backup.json") -Value ([ordered]@{
        schemaVersion = 3
        operationId = $OperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        scope = "activation-state"
        entries = $entries
      })
    return $backupRoot
  } finally {
    Exit-DeploymentMutex -Mutex $stateMutex
  }
}

function Read-DeploymentStateBackup {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256
  )

  if ($OperationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      $ExpectedManifestSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Deployment activation backup identity is invalid."
  }
  $backupRoot = Assert-ContainedPath -Root $Layout.Backups -Path (Join-Path $Layout.Backups $OperationId)
  $manifestPath = Join-Path $backupRoot "backup.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256) {
    throw "Deployment activation backup manifest is missing or failed SHA-256 verification."
  }
  $manifest = Read-JsonHashtable -Path $manifestPath
  $requiredKeys = @("schemaVersion", "operationId", "createdAtUtc", "scope", "entries")
  $expectedNames = @(
    "current.json",
    "previous.json",
    "pending.json",
    "process.json",
    "last-known-good-controller.json",
    "recovery-controller-installation.json",
    "local-production-task-installation.json"
  )
  if (@($manifest.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $manifest.Keys }).Count -ne 0 -or
      [int]$manifest.schemaVersion -ne 3 -or
      [string]$manifest.operationId -cne $OperationId -or
      [string]$manifest.scope -cne "activation-state" -or
      $manifest.entries -isnot [System.Collections.IDictionary] -or
      @($manifest.entries.Keys | Where-Object { $_ -notin $expectedNames }).Count -ne 0 -or
      @($expectedNames | Where-Object { $_ -notin $manifest.entries.Keys }).Count -ne 0) {
    throw "Deployment activation backup manifest does not match the exact state contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$manifest.createdAtUtc) -Context "Deployment backup createdAtUtc")
  foreach ($name in $expectedNames) {
    $entry = $manifest.entries[$name]
    if ($entry -isnot [System.Collections.IDictionary] -or
        @($entry.Keys | Where-Object { $_ -notin @("present", "sha256") }).Count -ne 0 -or
        -not $entry.Contains("present") -or
        -not $entry.Contains("sha256")) {
      throw "Deployment activation backup entry is invalid: $name"
    }
    $path = Join-Path $backupRoot $name
    if ([bool]$entry.present) {
      if ([string]$entry.sha256 -cnotmatch "^[0-9a-f]{64}$" -or
          -not (Test-Path -LiteralPath $path -PathType Leaf) -or
          (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$entry.sha256) {
        throw "Deployment activation backup entry failed SHA-256 verification: $name"
      }
      [void](Read-JsonHashtable -Path $path)
    } elseif ($null -ne $entry.sha256 -or (Test-Path -LiteralPath $path)) {
      throw "Deployment activation backup contains an undeclared state file: $name"
    }
  }
  return [ordered]@{
    backupRoot = $backupRoot
    manifestPath = $manifestPath
    manifestSha256 = $ExpectedManifestSha256
    manifest = $manifest
  }
}

function Restore-DeploymentStateBackup {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256
  )

  $backup = Read-DeploymentStateBackup `
    -Layout $Layout `
    -OperationId $OperationId `
    -ExpectedManifestSha256 $ExpectedManifestSha256
  $targets = [ordered]@{
    "current.json" = $Layout.Current
    "previous.json" = $Layout.Previous
    "last-known-good-controller.json" = $Layout.LastKnownGoodController
  }
  foreach ($mapping in $targets.GetEnumerator()) {
    $entry = $backup.manifest.entries[[string]$mapping.Key]
    $targetPath = [string]$mapping.Value
    if ([bool]$entry.present) {
      $value = Read-JsonHashtable -Path (Join-Path $backup.backupRoot ([string]$mapping.Key))
      Write-AtomicJson -Layout $Layout -Path $targetPath -Value $value
    } elseif (Test-Path -LiteralPath $targetPath -PathType Leaf) {
      Remove-Item -LiteralPath $targetPath -Force
    }
  }
  return $backup
}

function Read-DeploymentActivationPending {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pending = Read-JsonHashtable -Path $Layout.Pending
  $requiredKeys = @(
    "schemaVersion", "action", "commitSha", "operationId", "createdAtUtc", "state",
    "backupRoot", "backupManifestSha256"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 2 -or
      [string]$pending.action -notin @("deploy", "rollback") -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.backupManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$pending.state -notin @("activating", "rolling-back") -or
      ([string]$pending.action -ceq "deploy" -and [string]$pending.state -cne "activating") -or
      ([string]$pending.action -ceq "rollback" -and [string]$pending.state -cne "rolling-back")) {
    throw "Pending deployment activation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending deployment createdAtUtc")
  [void](Assert-CommitSha -CommitSha ([string]$pending.commitSha))
  $expectedBackupRoot = Assert-ContainedPath `
    -Root $Layout.Backups `
    -Path (Join-Path $Layout.Backups ([string]$pending.operationId))
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$pending.backupRoot),
      $expectedBackupRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Pending deployment activation record references an unexpected backup root."
  }
  [void](Read-DeploymentStateBackup `
      -Layout $Layout `
      -OperationId ([string]$pending.operationId) `
      -ExpectedManifestSha256 ([string]$pending.backupManifestSha256))
  return $pending
}

function Recover-InterruptedDeploymentActivation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$HealthUri,
    [Parameter(Mandatory)][int]$HealthTimeoutSeconds
  )

  if (-not (Test-Path -LiteralPath $Layout.Pending -PathType Leaf)) {
    return $null
  }
  if (Test-Path -LiteralPath $Layout.ReleaseInstallationPending -PathType Leaf) {
    throw "Release installation and activation pending records coexist; refusing ambiguous recovery."
  }
  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  [void](Assert-CanonicalTaskName -TaskName $TaskName)
  [void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
  $pending = Read-DeploymentActivationPending -Layout $Layout
  $backup = Read-DeploymentStateBackup `
    -Layout $Layout `
    -OperationId ([string]$pending.operationId) `
    -ExpectedManifestSha256 ([string]$pending.backupManifestSha256)
  $priorCurrent = $null
  $currentEntry = $backup.manifest.entries["current.json"]
  if ([bool]$currentEntry.present) {
    $priorCurrent = Read-ReleasePointer -Path (Join-Path $backup.backupRoot "current.json")
    $priorReleaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha ([string]$priorCurrent.commitSha)
    [void](Test-SealedRuntimeDependencyAttestation `
      -Layout $Layout `
      -ReleaseRoot $priorReleaseRoot `
      -ExpectedSha ([string]$priorCurrent.commitSha) `
      -ExpectedReceiptSha256 ([string]$priorCurrent.runtimeDependencyReceiptSha256))
  }
  if ([bool]$backup.manifest.entries["previous.json"].present) {
    [void](Read-ReleasePointer -Path (Join-Path $backup.backupRoot "previous.json"))
  }
  $controllerRoot = $null
  if ([bool]$backup.manifest.entries["last-known-good-controller.json"].present) {
    $priorController = Read-JsonHashtable -Path (Join-Path $backup.backupRoot "last-known-good-controller.json")
    [void](Assert-LastKnownGoodRecoveryControllerValue -Layout $Layout -Pointer $priorController)
    if ($null -ne $priorCurrent -and
        [string]$priorController.qualifiedReleaseSha -cne [string]$priorCurrent.commitSha) {
      throw "Activation backup recovery controller is not qualified for the prior current release."
    }
    $controllerRoot = [string]$priorController.controllerRoot
  } else {
    $controllerEntry = $backup.manifest.entries["recovery-controller-installation.json"]
    if (-not [bool]$controllerEntry.present) {
      throw "Activation backup has no installed recovery controller for first-deployment recovery."
    }
    $controllerInstallation = Read-JsonHashtable `
      -Path (Join-Path $backup.backupRoot "recovery-controller-installation.json")
    [void](Assert-RecoveryControllerInstallationValue `
        -Layout $Layout `
        -State $controllerInstallation)
    $controllerRoot = [string]$controllerInstallation.controllerRoot
  }
  $stopScriptFull = Assert-ContainedPath `
    -Root $controllerRoot `
    -Path (Join-Path $controllerRoot "Stop-LocalRelease.ps1")
  if (-not (Test-Path -LiteralPath $stopScriptFull -PathType Leaf)) {
    throw "Activation backup recovery controller has no reviewed stop script."
  }
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  & $stopScriptFull `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  [void](Restore-DeploymentStateBackup `
      -Layout $Layout `
      -OperationId ([string]$pending.operationId) `
      -ExpectedManifestSha256 ([string]$pending.backupManifestSha256))
  if (Test-Path -LiteralPath $Layout.Current -PathType Leaf) {
    $restoredCurrent = Read-ReleasePointer -Path $Layout.Current
    Start-ScheduledTask -TaskName $TaskName
    [void](Wait-ForReleaseHealth `
        -HealthUri $HealthUri `
        -ExpectedSha ([string]$restoredCurrent.commitSha) `
        -TimeoutSeconds $HealthTimeoutSeconds)
    [void](Test-ReleaseWebDocument -ReleaseRoot $priorReleaseRoot -TimeoutSeconds 10)
    $restoredLive = Get-LiveReleaseProcess `
      -Layout $Layout `
      -ExpectedSha ([string]$restoredCurrent.commitSha)
    if ($null -eq $restoredLive) {
      throw "Activation recovery readiness passed without the exact restored release process."
    }
  }
  if (Test-Path -LiteralPath $Layout.Previous -PathType Leaf) {
    [void](Read-ReleasePointer -Path $Layout.Previous)
  }
  if (Test-Path -LiteralPath $Layout.LastKnownGoodController -PathType Leaf) {
    [void](Read-LastKnownGoodRecoveryController -Layout $Layout)
  }
  if (Test-Path -LiteralPath $Layout.Pending -PathType Leaf) {
    Remove-Item -LiteralPath $Layout.Pending -Force
  }
  try {
    Write-DeploymentEvent `
      -Layout $Layout `
      -Action "activation-recovery" `
      -Status "succeeded" `
      -CommitSha ([string]$pending.commitSha) `
      -OperationId ([string]$pending.operationId) `
      -Message "Recovered interrupted $([string]$pending.action) activation to its exact pre-operation pointers."
  } catch {
    Write-Warning "Activation recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return $pending
}

function Read-ReleaseInstallationPending {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pending = Read-JsonHashtable -Path $Layout.ReleaseInstallationPending
  $requiredKeys = @(
    "schemaVersion", "commitSha", "operationId", "createdAtUtc", "state",
    "artifactSha256", "releaseRoot", "stagingRoot"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 1 -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.state -cne "installing" -or
      [string]$pending.artifactSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Pending release installation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending release installation createdAtUtc")
  $commitSha = Assert-CommitSha -CommitSha ([string]$pending.commitSha)
  $expectedReleaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha $commitSha
  $expectedStagingRoot = Assert-ContainedPath `
    -Root $Layout.Staging `
    -Path (Join-Path $Layout.Staging "$commitSha-$([string]$pending.operationId)")
  foreach ($comparison in @(
      @([string]$pending.releaseRoot, $expectedReleaseRoot),
      @([string]$pending.stagingRoot, $expectedStagingRoot)
    )) {
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($comparison[0]),
        [System.IO.Path]::GetFullPath($comparison[1]),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Pending release installation record references an unexpected path."
    }
  }
  return $pending
}

function Assert-ReleaseInstallationIsUnreferenced {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$CommitSha
  )

  foreach ($pointerPath in @($Layout.Current, $Layout.Previous)) {
    if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
      $pointer = Read-ReleasePointer -Path $pointerPath
      if ([string]$pointer.commitSha -ceq $CommitSha) {
        throw "Interrupted release installation $CommitSha is still referenced by $pointerPath."
      }
    }
  }
  if (Test-Path -LiteralPath $Layout.LastKnownGoodController -PathType Leaf) {
    $controller = Read-LastKnownGoodRecoveryController -Layout $Layout
    if ([string]$controller.qualifiedReleaseSha -ceq $CommitSha) {
      throw "Interrupted release installation $CommitSha is still referenced by the recovery controller."
    }
  }
  if (Test-Path -LiteralPath $Layout.Process -PathType Leaf) {
    [void](Get-LiveReleaseProcess -Layout $Layout)
    $processReceipt = Read-JsonHashtable -Path $Layout.Process
    if ([string]$processReceipt.commitSha -ceq $CommitSha) {
      throw "Interrupted release installation $CommitSha is still referenced by the process receipt."
    }
  }
}

function Move-InterruptedReleasePathToFailed {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$CommitSha,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][ValidateSet("release", "staging")][string]$Kind
  )

  [void](Assert-CommitSha -CommitSha $CommitSha)
  if ($OperationId -cnotmatch "^[0-9TZ-]+-[0-9a-f]{12}$") {
    throw "Interrupted release quarantine operation identity is invalid."
  }
  $allowedRoot = if ($Kind -ceq "release") { $Layout.Releases } else { $Layout.Staging }
  $expectedSource = if ($Kind -ceq "release") {
    Get-ReleaseRoot -Layout $Layout -CommitSha $CommitSha
  } else {
    Assert-ContainedPath `
      -Root $Layout.Staging `
      -Path (Join-Path $Layout.Staging "$CommitSha-$OperationId")
  }
  $sourceFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
  if (-not [string]::Equals(
      $sourceFull,
      [System.IO.Path]::GetFullPath($expectedSource).TrimEnd("\"),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Interrupted release quarantine source does not match the exact pending identity."
  }
  [void](Assert-ContainedPath -Root $Layout.Root -Path $allowedRoot)
  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.Failed)
  [void](Assert-ContainedPath -Root $allowedRoot -Path $sourceFull)
  if (-not (Test-Path -LiteralPath $SourceRoot)) {
    return $null
  }
  $item = Get-Item -LiteralPath $sourceFull -Force
  if (-not $item.PSIsContainer -or
      ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Interrupted release root must be a non-reparse directory before quarantine: $sourceFull"
  }
  $name = "$CommitSha-$OperationId-$Kind"
  $destination = Assert-ContainedPath -Root $Layout.Failed -Path (Join-Path $Layout.Failed $name)
  if (Test-Path -LiteralPath $destination) {
    throw "Interrupted release quarantine target already exists: $destination"
  }
  $sourceVolume = [System.IO.Path]::GetPathRoot($sourceFull).TrimEnd("\")
  $destinationVolume = [System.IO.Path]::GetPathRoot($destination).TrimEnd("\")
  if (-not [string]::Equals(
      $sourceVolume,
      $destinationVolume,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Interrupted release quarantine requires an atomic same-volume rename."
  }
  [System.IO.Directory]::Move($sourceFull, $destination)
  return $destination
}

function Recover-InterruptedReleaseInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  if (-not (Test-Path -LiteralPath $Layout.ReleaseInstallationPending -PathType Leaf)) {
    return $null
  }
  if (Test-Path -LiteralPath $Layout.Pending -PathType Leaf) {
    throw "Release installation and activation pending records coexist; refusing ambiguous recovery."
  }
  $pending = Read-ReleaseInstallationPending -Layout $Layout
  $commitSha = [string]$pending.commitSha
  Assert-ReleaseInstallationIsUnreferenced -Layout $Layout -CommitSha $commitSha
  $releaseRoot = [string]$pending.releaseRoot
  $stagingRoot = [string]$pending.stagingRoot
  $operationId = [string]$pending.operationId
  $completed = $false
  if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
    try {
      [void](Test-SealedRuntimeDependencyAttestation `
          -Layout $Layout `
          -ReleaseRoot $releaseRoot `
          -ExpectedSha $commitSha)
      $completed = $true
    } catch {
      $completed = $false
    }
  }
  $quarantined = [System.Collections.Generic.List[string]]::new()
  if (-not $completed) {
    $failedRelease = Move-InterruptedReleasePathToFailed `
      -Layout $Layout `
      -SourceRoot $releaseRoot `
      -CommitSha $commitSha `
      -OperationId $operationId `
      -Kind "release"
    if ($null -ne $failedRelease) {
      $quarantined.Add($failedRelease)
    }
    $sealPath = Assert-ContainedPath `
      -Root $Layout.RuntimeIntegrity `
      -Path (Join-Path $Layout.RuntimeIntegrity "$commitSha.json")
    if (Test-Path -LiteralPath $sealPath -PathType Leaf) {
      $identity = Get-CurrentWindowsIdentityReceipt
      $sealRecoveryAcl = Invoke-BoundedProcess `
        -FilePath $script:CanonicalIcaclsPath `
        -ArgumentList @(
          $sealPath,
          "/inheritance:e",
          "/grant:r",
          "*$([string]$identity.identitySid):F",
          "/Q"
        ) `
        -WorkingDirectory $Layout.RuntimeIntegrity `
        -TimeoutSeconds $script:RuntimeAttestationSealProtectionTimeoutSeconds `
        -MaxOutputCharacters 1048576 `
        -Context "Interrupted runtime seal recovery"
      if ([int]$sealRecoveryAcl.exitCode -ne 0) {
        throw "Unable to reopen interrupted runtime seal for quarantine: $([string]$sealRecoveryAcl.stderr)"
      }
      $failedSeal = Assert-ContainedPath `
        -Root $Layout.Failed `
        -Path (Join-Path $Layout.Failed "$commitSha-$operationId-runtime-integrity.json")
      Move-Item -LiteralPath $sealPath -Destination $failedSeal
      $quarantined.Add($failedSeal)
    }
  }
  $failedStaging = Move-InterruptedReleasePathToFailed `
    -Layout $Layout `
    -SourceRoot $stagingRoot `
    -CommitSha $commitSha `
    -OperationId $operationId `
    -Kind "staging"
  if ($null -ne $failedStaging) {
    $quarantined.Add($failedStaging)
  }
  $recoveredRecord = Assert-ContainedPath `
    -Root $Layout.Failed `
    -Path (Join-Path $Layout.Failed "release-installation-$operationId-recovered.json")
  if (Test-Path -LiteralPath $recoveredRecord) {
    throw "Release-installation recovery record already exists: $recoveredRecord"
  }
  Move-Item -LiteralPath $Layout.ReleaseInstallationPending -Destination $recoveredRecord
  try {
    Write-DeploymentEvent `
      -Layout $Layout `
      -Action "release-installation-recovery" `
      -Status "succeeded" `
      -CommitSha $commitSha `
      -OperationId $operationId `
      -Message $(if ($completed) {
          "Recovered a fully qualified interrupted release installation."
        } else {
          "Quarantined an incomplete interrupted release installation."
        })
  } catch {
    Write-Warning "Release-installation recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return [ordered]@{
    commitSha = $commitSha
    completed = $completed
    quarantined = @($quarantined)
    recoveryRecord = $recoveredRecord
  }
}

function Read-OptionalJsonState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  $present = Test-Path -LiteralPath $Path -PathType Leaf
  return [ordered]@{
    present = $present
    value = if ($present) { Read-JsonHashtable -Path $Path } else { $null }
  }
}

function Restore-OptionalJsonState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Snapshot
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  if (-not $Snapshot.Contains("present") -or -not $Snapshot.Contains("value")) {
    throw "Optional state snapshot is invalid."
  }
  if ([bool]$Snapshot.present) {
    if ($Snapshot.value -isnot [System.Collections.IDictionary]) {
      throw "Present optional state snapshot has no JSON object value."
    }
    Write-AtomicJson -Layout $Layout -Path $Path -Value ([System.Collections.IDictionary]$Snapshot.value)
  } elseif (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-OperationId {
  return "$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
}

function Get-StableExecutable {
  param([Parameter(Mandatory)][ValidateSet("node.exe", "npm.cmd", "pwsh.exe")][string]$Name)

  if ($Name -eq "pwsh.exe") {
    $stablePowerShell = "C:\Program Files\PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $stablePowerShell -PathType Leaf) {
      return $stablePowerShell
    }
  }
  $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
  return $command.Source
}

function Assert-NodeRuntime {
  param([Parameter(Mandatory)][string]$NodePath)

  $versionOutput = @(& $NodePath --version 2>&1)
  $exitCode = $LASTEXITCODE
  $version = ($versionOutput | Select-Object -First 1).ToString().Trim()
  if ($exitCode -ne 0 -or $version -notmatch "^v(?<major>\d+)\.\d+\.\d+") {
    throw "Unable to verify the Node.js runtime."
  }
  if ([int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required; found $version."
  }
  return $version
}

function Get-LiveReleaseProcess {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [string]$ExpectedSha
  )

  if (-not (Test-Path -LiteralPath $Layout.Process -PathType Leaf)) {
    return $null
  }
  $receipt = Read-JsonHashtable -Path $Layout.Process
  $requiredKeys = @(
    "schemaVersion", "commitSha", "pid", "entrypoint", "nodePath", "nodeVersion",
    "nodeSha256", "runtimeDependencyReceiptSha256", "startedAtUtc", "stdoutPath",
    "stderrPath", "supervised"
  )
  if (@($receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $receipt.Keys }).Count -ne 0) {
    throw "Process receipt does not match the exact runtime contract."
  }
  if ([int]$receipt.schemaVersion -ne 2 -or
      [string]$receipt.nodeVersion -cne "v22.23.2" -or
      [string]$receipt.nodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.runtimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Unsupported process receipt schemaVersion."
  }
  [void](Assert-CommitSha -CommitSha ([string]$receipt.commitSha))
  if ($ExpectedSha -and [string]$receipt.commitSha -cne $ExpectedSha) {
    throw "Live process receipt SHA does not match the selected release."
  }
  [void](Assert-ContainedPath -Root $Layout.Releases -Path ([string]$receipt.entrypoint))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stdoutPath))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stderrPath))
  if (-not (Test-Path -LiteralPath ([string]$receipt.nodePath) -PathType Leaf) -or
      (Get-FileHash -LiteralPath ([string]$receipt.nodePath) -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.nodeSha256) {
    throw "Process receipt Node.js runtime failed SHA-256 verification."
  }
  if (Test-Path -LiteralPath $Layout.Current -PathType Leaf) {
    $currentPointer = Read-ReleasePointer -Path $Layout.Current
    if ([string]$currentPointer.commitSha -ceq [string]$receipt.commitSha -and
        [string]$currentPointer.runtimeDependencyReceiptSha256 -cne [string]$receipt.runtimeDependencyReceiptSha256) {
      throw "Process receipt runtime dependency identity does not match the current release pointer."
    }
  }
  $pidValue = [int]$receipt.pid
  if ($pidValue -lt 1) {
    throw "Process receipt PID is invalid."
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$process.ExecutablePath),
      [System.IO.Path]::GetFullPath([string]$receipt.nodePath),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "PID $pidValue is not the recorded Node.js executable; refusing to manage it."
  }
  if ([string]$process.CommandLine -notlike "*$([string]$receipt.entrypoint)*") {
    throw "PID $pidValue command line does not contain the recorded release entrypoint."
  }
  return [ordered]@{ receipt = $receipt; process = $process }
}

function Wait-ForReleaseHealth {
  param(
    [Parameter(Mandatory)][string]$HealthUri,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )

  [void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 300) {
    throw "Health timeout must be from 1 to 300 seconds."
  }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = "health endpoint did not respond"
  do {
    try {
      $response = Invoke-RestMethod -Uri $script:CanonicalLivenessUri -Method Get -TimeoutSec 5 -Headers @{ Host = "127.0.0.1:8790" }
      if (
        [string]$response.status -eq "ok" -and
        [string]$response.app -eq "unified-ai-orchestrator" -and
        [string]$response.mode -eq "local" -and
        [string]$response.model -eq "qwen3:4b"
      ) {
        $readiness = Invoke-RestMethod -Uri $HealthUri -Method Get -TimeoutSec 5 -Headers @{ Host = "127.0.0.1:8790" }
        if (
          [string]$readiness.status -eq "ready" -and
          [string]$readiness.app -eq "unified-ai-orchestrator" -and
          [string]$readiness.mode -eq "local" -and
          [string]$readiness.releaseSha -ceq $ExpectedSha -and
          [string]$readiness.checks.evidence -eq "ready"
        ) {
          return [ordered]@{ health = $response; readiness = $readiness }
        }
        $lastError = "readiness response did not attest the selected release SHA"
      } else {
        $lastError = "health response did not match the pinned application contract"
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 750
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Release health check failed: $lastError"
}

function ConvertTo-WindowsSid {
  param([Parameter(Mandatory)][string]$Identity)

  if ([string]::IsNullOrWhiteSpace($Identity)) {
    throw "Windows identity cannot be empty."
  }
  if ($Identity -cmatch "^S-1-[0-9-]+$") {
    try {
      return ([System.Security.Principal.SecurityIdentifier]::new($Identity)).Value
    } catch {
      throw "Windows SID is invalid: $Identity"
    }
  }
  try {
    return ([System.Security.Principal.NTAccount]::new($Identity)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw "Unable to resolve Windows identity '$Identity' to a SID."
  }
}

function Get-CurrentWindowsIdentityReceipt {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.Name)) {
    throw "Unable to resolve the current Windows identity."
  }
  return [ordered]@{
    identityName = $identity.Name
    identitySid = $identity.User.Value
  }
}

function Assert-ScheduledTaskDefinition {
  param(
    [Parameter(Mandatory)][object]$Task,
    [Parameter(Mandatory)][string]$ExpectedTaskName,
    [Parameter(Mandatory)][string]$ExpectedExecute,
    [Parameter(Mandatory)][string]$ExpectedArguments,
    [Parameter(Mandatory)][string]$ExpectedIdentitySid,
    [Parameter(Mandatory)][string]$ExpectedDescription
  )

  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$currentIdentity.identitySid -cne $ExpectedIdentitySid) {
    throw "Scheduled task identity SID does not match the currently executing user."
  }
  if ([string]$Task.TaskName -cne $ExpectedTaskName -or [string]$Task.TaskPath -cne "\") {
    throw "Scheduled task must use the exact name $ExpectedTaskName at root task path \."
  }
  if ([string]$Task.Description -cne $ExpectedDescription) {
    throw "Scheduled task description does not match the reviewed contract."
  }

  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) {
    throw "Scheduled task $ExpectedTaskName must have exactly one action."
  }
  $action = $actions[0]
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$action.Execute),
      [System.IO.Path]::GetFullPath($ExpectedExecute),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$action.Arguments -cne $ExpectedArguments -or
    -not [string]::IsNullOrWhiteSpace([string]$action.WorkingDirectory)) {
    throw "Scheduled task $ExpectedTaskName action does not match the exact launcher contract."
  }

  $principalSid = ConvertTo-WindowsSid -Identity ([string]$Task.Principal.UserId)
  if ($principalSid -cne $ExpectedIdentitySid -or
      [string]$Task.Principal.LogonType -cne "Interactive" -or
      [string]$Task.Principal.RunLevel -cne "Limited" -or
      [string]$Task.Principal.ProcessTokenSidType -cne "Default" -or
      -not [string]::IsNullOrWhiteSpace([string]$Task.Principal.RequiredPrivilege) -or
      -not [string]::IsNullOrWhiteSpace([string]$Task.Principal.GroupId)) {
    throw "Scheduled task $ExpectedTaskName principal does not match the password-free current-user contract."
  }

  $triggers = @($Task.Triggers)
  if ($triggers.Count -ne 1) {
    throw "Scheduled task $ExpectedTaskName must have exactly one trigger."
  }
  $trigger = $triggers[0]
  $triggerClass = [string]$trigger.CimClass.CimClassName
  $triggerSid = ConvertTo-WindowsSid -Identity ([string]$trigger.UserId)
  $repetitionInvalid = $false
  if ($null -ne $trigger.Repetition) {
    $repetitionInvalid = (
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Repetition.Duration) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Repetition.Interval) -or
      [bool]$trigger.Repetition.StopAtDurationEnd
    )
  }
  if ($triggerClass -cne "MSFT_TaskLogonTrigger" -or
      -not [bool]$trigger.Enabled -or
      $triggerSid -cne $ExpectedIdentitySid -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Delay) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.StartBoundary) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.EndBoundary) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.ExecutionTimeLimit) -or
      $repetitionInvalid) {
    throw "Scheduled task $ExpectedTaskName logon trigger does not match the exact current-user contract."
  }

  $settings = $Task.Settings
  if ($null -eq $settings -or
      [int]$settings.RestartCount -ne 3 -or
      [string]$settings.RestartInterval -cne "PT1M" -or
      [string]$settings.ExecutionTimeLimit -cne "P3650D" -or
      [string]$settings.MultipleInstances -cne "IgnoreNew" -or
      [string]$settings.Compatibility -cne "Win7" -or
      -not [bool]$settings.AllowDemandStart -or
      -not [bool]$settings.AllowHardTerminate -or
      -not [bool]$settings.Enabled -or
      [int]$settings.Priority -ne 7 -or
      -not [bool]$settings.Hidden -or
      -not [bool]$settings.StartWhenAvailable -or
      [bool]$settings.DisallowStartIfOnBatteries -or
      [bool]$settings.StopIfGoingOnBatteries -or
      [bool]$settings.RunOnlyIfIdle -or
      [bool]$settings.RunOnlyIfNetworkAvailable -or
      [bool]$settings.WakeToRun -or
      [bool]$settings.DisallowStartOnRemoteAppSession -or
      -not [bool]$settings.UseUnifiedSchedulingEngine -or
      [bool]$settings.volatile -or
      $null -ne $settings.MaintenanceSettings -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.DeleteExpiredTaskAfter) -or
      [string]$settings.IdleSettings.IdleDuration -cne "PT10M" -or
      [bool]$settings.IdleSettings.RestartOnIdle -or
      -not [bool]$settings.IdleSettings.StopOnIdleEnd -or
      [string]$settings.IdleSettings.WaitTimeout -cne "PT1H" -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.NetworkSettings.Id) -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.NetworkSettings.Name)) {
    throw "Scheduled task $ExpectedTaskName settings do not match the exact supervision contract."
  }
  return $Task
}

function Assert-ScheduledTaskContract {
  param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ExpectedExecute,
    [Parameter(Mandatory)][string]$ExpectedArguments,
    [Parameter(Mandatory)][string]$ExpectedIdentitySid,
    [Parameter(Mandatory)][string]$ExpectedDescription
  )

  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -ne 1) {
    throw "Expected exactly one scheduled task named $TaskName; found $($tasks.Count)."
  }
  return (Assert-ScheduledTaskDefinition `
      -Task $tasks[0] `
      -ExpectedTaskName $TaskName `
      -ExpectedExecute $ExpectedExecute `
      -ExpectedArguments $ExpectedArguments `
      -ExpectedIdentitySid $ExpectedIdentitySid `
      -ExpectedDescription $ExpectedDescription)
}

function Read-DeploymentTaskInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.TaskInstallation
  $requiredKeys = @(
    "schemaVersion", "repositoryRoot", "taskName", "powerShellPath", "arguments",
    "startScript", "controllerVersion", "controllerManifestSha256", "identityName",
    "identitySid", "installedAtUtc"
  )
  if (@($state.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $state.Keys }).Count -ne 0 -or
      [int]$state.schemaVersion -ne 1 -or
      [string]$state.repositoryRoot -cne $script:CanonicalRepositoryRoot -or
      [string]$state.taskName -cne $script:CanonicalTaskName -or
      [string]$state.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Local-production task installation state does not match the pinned contract."
  }
  [void](Assert-SupportedControllerVersion -ControllerVersion ([string]$state.controllerVersion))
  [void](Assert-ContainedPath -Root $Layout.Controllers -Path ([string]$state.startScript))
  if (-not (Test-Path -LiteralPath ([string]$state.startScript) -PathType Leaf) -or
      -not (Test-Path -LiteralPath ([string]$state.powerShellPath) -PathType Leaf)) {
    throw "Local-production task installation references a missing launcher or PowerShell executable."
  }
  $controller = Read-RecoveryControllerInstallation -Layout $Layout
  $expectedStartScript = Join-Path ([string]$controller.controllerRoot) "Start-LocalRelease.ps1"
  $expectedPowerShell = Get-StableExecutable -Name "pwsh.exe"
  $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$expectedStartScript`" -RepositoryRoot `"$script:CanonicalRepositoryRoot`" -Supervised"
  if ([string]$state.controllerVersion -cne [string]$controller.controllerVersion -or
      [string]$state.controllerManifestSha256 -cne [string]$controller.controllerManifestSha256 -or
      -not [string]::Equals([string]$state.startScript, $expectedStartScript, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$state.powerShellPath, $expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$state.arguments -cne $expectedArguments -or
      (ConvertTo-WindowsSid -Identity ([string]$state.identityName)) -cne [string]$state.identitySid) {
    throw "Local-production task installation state drifted from the immutable recovery controller."
  }
  return $state
}

function Assert-DeploymentTaskRegistration {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$TaskName
  )

  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  [void](Assert-CanonicalTaskName -TaskName $TaskName)
  $layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
  $installation = Read-DeploymentTaskInstallation -Layout $layout
  return (Assert-ScheduledTaskContract `
      -TaskName $TaskName `
      -ExpectedExecute ([string]$installation.powerShellPath) `
      -ExpectedArguments ([string]$installation.arguments) `
      -ExpectedIdentitySid ([string]$installation.identitySid) `
      -ExpectedDescription $script:CanonicalDeploymentTaskDescription)
}

function Read-GitHubRunnerInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.RunnerInstallation
  foreach ($key in @(
      "schemaVersion",
      "version",
      "archiveSha256",
      "payloadFileCount",
      "payloadTreeSha256",
      "repositoryUrl",
      "labels",
      "runnerName",
      "runnerRoot",
      "taskName",
      "powerShellPath",
      "arguments",
      "identityName",
      "identitySid",
      "configured",
      "installedAtUtc"
    )) {
    if (-not $state.Contains($key)) {
      throw "GitHub runner installation state is missing $key."
    }
  }
  if (
    [int]$state.schemaVersion -ne 3 -or
    [string]$state.version -cne $script:PinnedRunnerVersion -or
    [string]$state.archiveSha256 -cne $script:PinnedRunnerArchiveSha256 -or
    [int]$state.payloadFileCount -lt 1 -or
    [string]$state.payloadTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
    [string]$state.repositoryUrl -cne $script:CanonicalRunnerRepositoryUrl -or
    [string]$state.taskName -cne $script:CanonicalRunnerTaskName -or
    [string]$state.runnerRoot -cne $Layout.RunnerRoot -or
    [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$" -or
    @($state.labels).Count -ne 1 -or
    [string](@($state.labels)[0]) -cne "unified-ai-orchestrator"
  ) {
    throw "GitHub runner installation state does not match the pinned repository contract."
  }
  [void](Assert-ContainedPath -Root $Layout.Root -Path ([string]$state.runnerRoot))
  if (-not (Test-Path -LiteralPath ([string]$state.powerShellPath) -PathType Leaf)) {
    throw "The PowerShell executable recorded for the GitHub runner task is unavailable."
  }
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  $expectedScript = Join-Path $script:CanonicalRepositoryRoot "scripts\deployment\Start-GitHubRunner.ps1"
  $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$expectedScript`" -RepositoryRoot `"$script:CanonicalRepositoryRoot`""
  if ([string]$state.identitySid -cne [string]$currentIdentity.identitySid -or
      (ConvertTo-WindowsSid -Identity ([string]$state.identityName)) -cne [string]$state.identitySid -or
      [string]$state.arguments -cne $expectedArguments -or
      -not [string]::Equals(
        [string]$state.powerShellPath,
        (Get-StableExecutable -Name "pwsh.exe"),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "GitHub runner task installation identity or launcher arguments drifted."
  }
  return $state
}

function Assert-GitHubRunnerTaskRegistration {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Installation
  )

  [void](Assert-CanonicalRunnerTaskName -TaskName ([string]$Installation.taskName))
  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  return (Assert-ScheduledTaskContract `
      -TaskName ([string]$Installation.taskName) `
      -ExpectedExecute ([string]$Installation.powerShellPath) `
      -ExpectedArguments ([string]$Installation.arguments) `
      -ExpectedIdentitySid ([string]$Installation.identitySid) `
      -ExpectedDescription $script:CanonicalRunnerTaskDescription)
}

function Assert-PinnedRunnerBinary {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [int]$ExpectedFileCount = 0,
    [string]$ExpectedTreeSha256
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.RunnerRoot)
  $archivePath = Assert-ContainedPath `
    -Root $Layout.Downloads `
    -Path (Join-Path $Layout.Downloads "actions-runner-win-x64-$($script:PinnedRunnerVersion).zip")
  foreach ($rootPath in @($Layout.RunnerRoot, $archivePath)) {
    $rootItem = Get-Item -LiteralPath $rootPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned GitHub runner source and destination cannot be reparse points."
    }
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedRunnerArchiveSha256) {
    throw "Stored GitHub runner archive no longer matches its pinned official SHA-256."
  }

  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($archive.Entries | Sort-Object -Property FullName -CaseSensitive)) {
      if ($entry.Name.Length -eq 0) {
        continue
      }
      $relative = [string]$entry.FullName
      $segments = $relative.Split("/")
      if ($relative.Contains("\") -or
          $relative.StartsWith("/") -or
          $relative.Contains([char]0) -or
          @($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0 -or
          -not $seen.Add($relative)) {
        throw "Pinned GitHub runner archive inventory contains an unsafe or duplicate path."
      }
      $installedPath = Assert-ContainedPath `
        -Root $Layout.RunnerRoot `
        -Path (Join-Path $Layout.RunnerRoot ($relative.Replace("/", "\")))
      if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
        throw "Pinned GitHub runner payload file is missing: $relative"
      }
      $installedItem = Get-Item -LiteralPath $installedPath -Force
      if (($installedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          [int64]$installedItem.Length -ne [int64]$entry.Length) {
        throw "Pinned GitHub runner payload entry is not a matching regular file: $relative"
      }
      $entryStream = $entry.Open()
      try {
        $entryHash = [Convert]::ToHexString(
          [System.Security.Cryptography.SHA256]::HashData($entryStream)
        ).ToLowerInvariant()
      } finally {
        $entryStream.Dispose()
      }
      $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($installedHash -cne $entryHash) {
        throw "Pinned GitHub runner payload SHA-256 mismatch: $relative"
      }
      $lines.Add("$relative`t$([int64]$entry.Length)`t$entryHash")
    }
    if ($lines.Count -lt 1) {
      throw "Pinned GitHub runner archive has no payload files."
    }
    $treeBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $treeSha256 = [Convert]::ToHexString(
      [System.Security.Cryptography.SHA256]::HashData($treeBytes)
    ).ToLowerInvariant()
  } finally {
    $archive.Dispose()
  }
  if ($ExpectedFileCount -gt 0 -and $lines.Count -ne $ExpectedFileCount) {
    throw "Pinned GitHub runner payload file count drifted."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      ($ExpectedTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or $treeSha256 -cne $ExpectedTreeSha256)) {
    throw "Pinned GitHub runner payload tree SHA-256 drifted."
  }
  return [ordered]@{
    version = $script:PinnedRunnerVersion
    fileCount = $lines.Count
    treeSha256 = $treeSha256
  }
}

function Test-ReleaseWebDocument {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )

  $releaseIndex = Join-Path $ReleaseRoot "apps\web\dist\index.html"
  $expectedHash = (Get-FileHash -LiteralPath $releaseIndex -Algorithm SHA256).Hash.ToLowerInvariant()
  $handler = [System.Net.Http.SocketsHttpHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler, $true)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  try {
    $bytes = $client.GetByteArrayAsync("http://127.0.0.1:8790/").GetAwaiter().GetResult()
    $actualHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($actualHash -cne $expectedHash) {
      throw "Served web index does not match the selected release."
    }
  } finally {
    $client.Dispose()
  }
  return $expectedHash
}

if ($ReleaseAclWorker) {
  foreach ($workerValue in @(
      $ReleaseAclContainmentRoot,
      $ReleaseAclRoot,
      $ReleaseAclIdentitySid,
      $ReleaseAclAllowedReparsePathsBase64
    )) {
    if ([string]::IsNullOrWhiteSpace($workerValue)) {
      throw "Release ACL worker invocation is missing a required argument."
    }
  }
  Invoke-ReleaseTreeAclWorker `
    -ContainmentRoot $ReleaseAclContainmentRoot `
    -ReleaseRoot $ReleaseAclRoot `
    -IdentitySid $ReleaseAclIdentitySid `
    -AllowedWorkspaceLinksBase64 $ReleaseAclAllowedReparsePathsBase64
}
