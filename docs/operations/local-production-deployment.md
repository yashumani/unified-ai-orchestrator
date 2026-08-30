# Local production deployment

This deployment keeps the complete Unified AI Orchestrator on the canonical Windows machine. GitHub Actions is the CI/CD control plane; the running API, React bundle, Ollama integration, WhiteShadow adapter, and local evidence remain on `D:`. GitHub Pages is not used because it cannot run the local API or model dependencies.

## Fixed security boundary

- The application listens only on `127.0.0.1:8790`.
- Readiness is `http://127.0.0.1:8790/api/ready`; a release passes only when the response reports the exact selected Git SHA and the evidence store is ready.
- Liveness is also checked internally at `http://127.0.0.1:8790/api/health`.
- The canonical repository is `D:\Yashu-AI-Workspace\unified-ai-orchestrator`.
- All installed releases, pointers, process receipts, backups, and deployment logs live under `.local\deployment`. The scripts reject another repository root, path traversal, unsafe root reparse points, non-loopback health URLs, malformed SHAs, and undeclared or hash-mismatched archive files. Only package-lock-declared workspace junctions contained by an installed release are allowed.
- Release archives cannot contain `.env*`, `.git`, `.local`, `node_modules`, raw/private/ChatGPT sources, or undeclared files. The official Node.js `v22.23.2` Windows x64 archive is pinned to SHA-256 `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`, extracted under the D-backed deployment tree, and compared byte for byte on every qualification. Its npm `10.9.8` runs `npm ci --omit=dev --ignore-scripts` only after the payload has moved to its final release path, so workspace junctions cannot retain a staging target.
- Windows archive names also reject alternate-data-stream separators, control characters, trailing dots or spaces, invalid characters, and reserved device names such as `CON`, `NUL`, `COM1`, and `LPT1` before any filesystem path is created.
- A new dependency installation is qualified without a per-file `node_modules` scan. `npm ci` enforces the exact lock/SRI graph, then pinned `npm ls --omit=dev --all --json` is canonicalized into a dependency-graph hash and node count. Receipt v4 also binds the package lock, hidden npm lock when present, exact Node/npm bytes and versions, workspace links, release manifest and critical payload hashes, release root, and bounded critical ACLs. External seal v2 binds the receipt, graph, and manifest hashes and is carried by the release pointer and process receipt. Normal deploy, supervised start, live acceptance, rollback, and redeploy validate that sealed attestation without recursively walking dependency files or ACLs. Previously installed v3 receipts with v1 seals remain fast-verifiable for rollback compatibility; they are not silently rewritten. An independent full content-and-ACL audit remains available for out-of-band maintenance. No release points into the transient GitHub Actions tool cache.
- Runtime credentials are read from the canonical ignored `.env`; they are never copied into releases, logs, state backups, GitHub artifacts, or scheduled-task arguments.
- The Windows tasks use the current interactive identity with `LogonType Interactive` and `RunLevel Limited`. Exact action, SID, trigger, description, restart settings, battery settings, and other normalized Task Scheduler fields are validated on every use. They store no password.

## Release layout

```text
.local/deployment/
├── current.json                 # selected release pointer
├── previous.json                # one-step rollback pointer
├── pending.json                 # exists only during activation
├── releases/<40-char-sha>/      # immutable extracted build + runtime dependencies
├── staging/                     # contained temporary extraction
├── failed/                      # recoverable pre-activation quarantines
├── controllers/1.0.1-<hash>/    # frozen hash-verified recovery controller
├── downloads/                   # checksum-pinned Node and runner archives
├── toolchains/node-v22.23.2-win-x64/ # official D-backed Node distribution
├── github-runner/2.337.0/       # pinned runner, credentials, diagnostics, and _work
├── state/process.json           # exact PID, SHA, entrypoint, Node path, and log paths
├── state/runtime-dependencies/  # external per-release receipt seals
├── state/recovery-controller-installation.json
├── state/last-known-good-controller.json
├── state/*-installation-pending.json # crash-recovery records, absent after commit
├── state/github-runner-*.json   # non-secret runner installation/process receipts
├── state/node-runtime-installation.json # archive/tree/identity receipt
├── backups/<operation-id>/      # pointer/process-state snapshots only
└── logs/
    ├── deployment-events.jsonl  # structured lifecycle events
    └── <sha>/<run-id>/
        ├── stdout.log
        └── stderr.log
```

The API entrypoint and React distribution are both loaded from the selected release directory. `ORCHESTRATOR_RELEASE_SHA` and `ORCHESTRATOR_WEB_DIST_ROOT` are set by the supervised launcher and are validated again by the application. The canonical repository and `.local\evidence` remain the managed workspace and durable evidence location.

## One-time machine preparation

Requirements:

- PowerShell 7.4 or newer discoverable as `pwsh.exe` (the installer records and validates the resolved executable; it does not assume one installation directory)
- Git on `PATH`; the deployment installer provisions and verifies its own D-backed Node.js `v22.23.2` and npm `10.9.8`, so a release never depends on Actions tool-cache paths
- `D:` connected and the canonical repository present
- a clean `main` checkout tracking the exact GitHub release commit
- the ignored `.env` configured at the repository root
- Ollama and WhiteShadow installed at their existing pinned local paths
- a repository-scoped GitHub Actions self-hosted Windows runner registered through GitHub's normal ephemeral registration-token flow and running as the same Windows user that owns the scheduled task, Ollama, and WhiteShadow

Do not put a GitHub token, Windows password, `.env` value, or runner registration token in command history.

### Configure GitHub release governance

Create one fine-grained personal access token restricted to `yashumani/unified-ai-orchestrator` with repository **Administration: Read-only** permission and no write permissions. Store it as the repository Actions secret `REPOSITORY_ADMIN_READ_TOKEN`. The package job uses it only to read the repository immutable-release setting before creating a release. The workflow explicitly removes it from the process environment before using the normal job token to publish, and no secret is referenced anywhere in the self-hosted deploy or rollback jobs.

Enable immutable releases for the repository, create the `local-production` GitHub Environment with `main` as its only deployment branch, and protect `main` with strict required status check `Public fixture verification`. A release fails before draft creation if the immutable-release API does not report `enabled=true`.

Do not use a broad classic token as this long-lived secret. Revoke any token that has been exposed and create the narrow read-only token above.

### Install the pinned D-backed Node runtime

Preview and then install the reviewed official distribution:

```powershell
pwsh -NoProfile -File .\scripts\deployment\Install-PinnedNodeRuntime.ps1 -WhatIf
pwsh -NoProfile -File .\scripts\deployment\Install-PinnedNodeRuntime.ps1 -Confirm:$false
```

The installer downloads only the fixed `node-v22.23.2-win-x64.zip` URL when the archive is absent, checks the reviewed SHA-256 before extraction, rejects traversal, duplicate, extra, or reparse-point entries, verifies every installed file against the archive, requires Node `v22.23.2` and npm `10.9.8`, seals the tree read/execute, and writes a non-secret installation receipt. Reruns revalidate the entire distribution instead of trusting the receipt alone.

### Install the repository runner

The installer is pinned to the official GitHub Actions runner `2.337.0` Windows x64 archive and SHA-256 `1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc`, as published on the [official GitHub release](https://github.com/actions/runner/releases/tag/v2.337.0). It refuses a different version, checksum, repository URL, task name, or runner directory. Automatic runner updates are disabled so the reviewed binary stays pinned.

First preview without a token:

```powershell
pwsh -NoProfile -File .\scripts\deployment\Install-GitHubRunner.ps1 -WhatIf
```

Generate a short-lived repository registration token in GitHub, paste it into a non-echoing prompt, and pass the resulting `SecureString`:

```powershell
$runnerToken = Read-Host 'Paste the one-time runner registration token' -AsSecureString
try {
  & .\scripts\deployment\Install-GitHubRunner.ps1 `
    -RegistrationToken $runnerToken
} finally {
  Remove-Variable runnerToken -ErrorAction SilentlyContinue
}
```

The alternative environment input is `ACTIONS_RUNNER_REGISTRATION_TOKEN`. Set it only for the installer process. The script clears that process environment variable immediately, converts it to a `SecureString`, never writes it to state or logs, clears managed references, and zeroes the unmanaged BSTR after GitHub's official `config.cmd` returns. GitHub's configuration interface still requires a transient plaintext command-line argument, so use only the short-lived one-time registration token on this trusted single-user host.

The configured runner has the default `self-hosted`, `Windows`, and `X64` labels plus the repository label `unified-ai-orchestrator`. Its hidden task `UnifiedAIOrchestrator-GitHubRunner` runs under the current interactive user without a password, starts immediately, starts again at user logon, and supervises `run.cmd`. The runner directory ACL is reduced to the current user and LocalSystem before registration.

Installation is idempotent when the validated state, pinned binary, registration, and exact task already exist. If remote registration succeeds but task creation or startup is interrupted, the durable validated installation state lets a rerun recreate or restart the exact task. A directory or task without matching state fails closed instead of being reused or overwritten.

The application task never points at mutable repository scripts. Installation first verifies `controller-manifest.json`, copies the six-script recovery bundle plus its manifest to a content-addressed controller directory, seals it read/execute for the task identity, and points the task at that frozen launcher. The bundle includes the exact rollback, release verification, and local-AI acceptance scripts. When replacing an existing controller, the transaction stops the current process through the prior verified controller, registers the new task, restarts the same current release, and requires exact readiness, served-web hash, and live-process proof before committing. Failure restores and proves the prior task/controller. Preview and install it from an interactive terminal running as the same Windows user that owns Ollama and WhiteShadow:

```powershell
Set-Location 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'

pwsh -NoProfile -File .\scripts\deployment\Install-LocalProductionTask.ps1 -WhatIf
pwsh -NoProfile -File .\scripts\deployment\Install-LocalProductionTask.ps1

Get-ScheduledTask -TaskName 'UnifiedAIOrchestrator-Local' |
  Select-Object TaskName, State
Get-ScheduledTask -TaskName 'UnifiedAIOrchestrator-GitHubRunner' |
  Select-Object TaskName, State
```

Installation does not start a release when `current.json` is absent. At later logons, the hidden task starts only the exact release selected by that pointer and remains active as its supervisor. Task Scheduler is configured for three bounded restart attempts at one-minute intervals.

## CI/CD cycle

The governed delivery order is:

1. Pull request verification runs the public-boundary check, tests, typecheck, and production build. Protected `main` requires that check.
2. The approved pull request is merged to `main`.
3. The release job creates both application and recovery-controller artifacts twice with identical basenames, compares both ZIPs and both checksum sidecars byte for byte, and only then uploads the first qualified copies. The application archive contains `release-manifest.json` and only manifest-declared payload files. Every payload file has a SHA-256 digest, and the manifest carries the exact 40-character commit SHA and lockfile digest.
4. The `local-production` GitHub Environment gates release publication and local execution. GitHub repository immutable releases must be enabled; the release is created as a draft, populated with the app artifact, recovery-controller artifact, both checksums, and audit receipt, then published and required to report `immutable=true`.
5. Before touching an application release, the self-hosted Windows job installs or revalidates the official D-backed Node runtime and executes the Windows hardening and state-recovery fixtures.
6. The job synchronizes the clean canonical `main` checkout by fast-forward only to that exact SHA. `Sync-CanonicalMain.ps1` is the only delivery script allowed to switch/fast-forward the canonical Git checkout; deploy/rollback scripts never alter Git.
7. The job installs or verifies the published frozen recovery controller and exact application task. Controller `1.0.0` is accepted only as the hash-verified historical side of the reviewed transition to canonical `1.0.1`; new controller sources must be `1.0.1`. Pending `1.0.0` controller-install records and schema-2 task activations are recovered through their exact protected historical bundles before the new transition starts. An existing current release must survive a behaviorally verified controller handoff before the task change commits, and the schema-3 transaction advances the last-known-good pointer to the new controller or restores its prior exact snapshot on failure. `Deploy-LocalRelease.ps1` then validates the canonical source, archive, hashes, task registration, D-backed Node runtime, and locked dependency installation. For a new release, `npm ci` is followed by the canonical npm dependency-graph, workspace-link, critical-payload, and bounded ACL/seal checks before activation. No production install performs the recursive per-file audit.
8. Activation uses the completed receipt without repeating dependency qualification. It writes a SHA-bound backup manifest and pending transaction, stops only the recorded orchestrator process, changes the release pointer, and starts the supervised task. The health timeout starts after that launch request, so it measures application startup rather than installation work.
9. Inside that same uncommitted transaction, the deploy script requires liveness, exact-SHA readiness, evidence readiness, a live exact-process receipt, byte-for-byte equality between the served and packaged React index, both governed local AI backends ready, a WhiteShadow allowlisted capability call, and a bounded real `qwen3:4b` Ollama inference.
10. Only after every check passes is `pending.json` removed, which is the single activation commit point. If installation or activation is interrupted, the next locked operation either accepts a completed sealed install or quarantines the incomplete path with a contained same-volume rename. Quarantine rejects a release-root reparse point, path escape, cross-volume destination, or referenced release, but it does not traverse package-lock-declared workspace junctions while moving the directory. Activation recovery verifies the sealed prior state before stopping anything, restores the prior pointers, restarts the prior release, and requires readiness, the packaged web hash, and the exact live-process receipt before clearing the recovery record. Foreign transaction pending records block Node, controller, and task mutations until the owning recovery completes.

The manual equivalent, useful for diagnosis with a downloaded GitHub release artifact, is:

```powershell
$sha = (git rev-parse HEAD).Trim()
$artifact = "D:\Downloads\unified-ai-orchestrator-$sha.zip"
$controllerArtifact = "D:\Downloads\unified-ai-orchestrator-controller-$sha.zip"

pwsh -NoProfile -File .\scripts\deployment\Install-PinnedNodeRuntime.ps1 `
  -Confirm:$false

pwsh -NoProfile -File .\scripts\deployment\Install-RecoveryControllerArtifact.ps1 `
  -ArtifactPath $controllerArtifact `
  -ChecksumPath "$controllerArtifact.sha256" `
  -Confirm:$false

. .\scripts\deployment\Deployment.Common.ps1
$layout = Get-DeploymentLayout -RepositoryRoot (Get-Location).Path
$controller = Read-RecoveryControllerInstallation -Layout $layout
pwsh -NoProfile -File .\scripts\deployment\Install-LocalProductionTask.ps1 `
  -ControllerSourceRoot $controller.controllerRoot `
  -Confirm:$false

pwsh -NoProfile -File .\scripts\deployment\Deploy-LocalRelease.ps1 `
  -ArtifactPath $artifact `
  -ExpectedSha $sha `
  -HealthUri 'http://127.0.0.1:8790/api/ready' `
  -WhatIf

pwsh -NoProfile -File .\scripts\deployment\Deploy-LocalRelease.ps1 `
  -ArtifactPath $artifact `
  -ExpectedSha $sha `
  -HealthUri 'http://127.0.0.1:8790/api/ready'

pwsh -NoProfile -File .\scripts\deployment\Test-LocalRelease.ps1 `
  -ExpectedSha $sha `
  -RequireRepositoryHeadMatch `
  -HealthUri 'http://127.0.0.1:8790/api/ready'

pwsh -NoProfile -File .\scripts\deployment\Test-LocalAiRuntime.ps1 `
  -TimeoutSeconds 180
```

### Sealed verification and independent full audit

The default `Test-LocalRelease.ps1` command above is the production-safe sealed path. It verifies the exact commit and release pointer, the receipt hash and protected external seal, the lockfile and manifest payload, the pinned Node identity, the contained release root, and a fixed set of critical ACLs. That set includes the two attestation files, root and application package files, API entrypoint, web index, `node_modules`, its hidden lock when present, and every declared workspace junction plus its exact contained target; the list fails closed above 256 paths. Release protection sets inheritable object/container permissions at the root, then checks those bounded descendants. It does not use `icacls /reset /T`, enumerate the complete dependency tree, or recursively validate ACLs.

Use the independent full audit outside the deploy/start/rollback path when a maintenance review requires every dependency byte and descendant ACL to be rechecked. Receipt v4 deliberately does not create a full-tree baseline during deployment, so an accepted v4 full audit requires a tree SHA-256 obtained from a separately governed trusted baseline. A newly calculated, untrusted snapshot is inventory only and is never reported as an accepted audit. The function does not require or stop a live process:

```powershell
. .\scripts\deployment\Deployment.Common.ps1
$layout = Get-DeploymentLayout -RepositoryRoot (Get-Location).Path
$pointer = Read-ReleasePointer -Path $layout.Current
$releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $pointer.commitSha
$trustedTreeSha256 = '<64-character externally approved tree SHA-256>'

Test-RuntimeDependencyIntegrityFullAudit `
  -Layout $layout `
  -ReleaseRoot $releaseRoot `
  -ExpectedSha $pointer.commitSha `
  -ExpectedReceiptSha256 $pointer.runtimeDependencyReceiptSha256 `
  -ExpectedTreeSha256 $trustedTreeSha256
```

For an optional combined live acceptance plus that full audit, provide the same trusted value and an explicit maintenance budget: `Test-LocalRelease.ps1 -FullAudit -ExpectedFullAuditTreeSha256 $trustedTreeSha256 -IntegrityTimeoutSeconds 7200`. The expected value is mandatory for receipt v4. Receipt v3 already contains its protected full-tree baseline, so the parameter is optional there, though still useful for independent comparison. The JSON result reports `runtimeAttestationMode` as `full-audit`; the default reports `sealed`. Schedule either full-audit form out of band because it intentionally performs the slow recursive work excluded from production startup.

Deployment from a feature branch, dirty checkout, uppercase/short SHA, mismatched artifact, missing task, unsafe archive, or non-loopback endpoint fails before activation.

## Monitoring

### Quiet first-install phase

For a previously unseen SHA, long gaps in console output are expected while `npm ci`, canonical dependency-graph generation, workspace-link checks, and the initial bounded ACL/seal work run. The durable `state\release-installation-pending.json` record remains until that phase commits. Production deliberately avoids a full per-file tree hash because it can starve the self-hosted runner heartbeat on the external disk. The npm graph command is capped at 120 seconds and each root/seal ACL command at 30 seconds. Console progress markers are `runtime-attestation:npm-graph-start`, `runtime-attestation:npm-graph-complete`, `runtime-attestation:release-protection-start`, `runtime-attestation:release-protection-complete`, and `runtime-attestation:seal-complete`; use those stable phase IDs with the pending record and deployment event stream instead of waiting for per-file noise. Do not start a duplicate workflow run, cancel a healthy job merely because output is quiet, or run recursive `Get-ChildItem`, `Get-FileHash`, `npm` inventory, or `icacls /T` probes against the release. Those probes compete for the same external disk and do not distinguish slow progress from a stalled transaction.

```powershell
$deployment = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator\.local\deployment'
$currentPath = "$deployment\current.json"
$current = if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
  Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
} else {
  $null
}
$installPending = "$deployment\state\release-installation-pending.json"

if (Test-Path -LiteralPath $installPending -PathType Leaf) {
  Get-Item -LiteralPath $installPending |
    Select-Object FullName, Length, LastWriteTimeUtc
  Get-Content -LiteralPath $installPending -Raw
}

Get-ScheduledTask -TaskName 'UnifiedAIOrchestrator-Local' |
  Select-Object TaskName, State
if ($null -ne $current) {
  $processPath = "$deployment\state\process.json"
  if (Test-Path -LiteralPath $processPath -PathType Leaf) {
    Get-Content -LiteralPath $processPath -Raw
  }
  Invoke-RestMethod 'http://127.0.0.1:8790/api/ready'
  pwsh -NoProfile -File .\scripts\deployment\Test-LocalRelease.ps1 `
    -ExpectedSha $current.commitSha
  pwsh -NoProfile -File .\scripts\deployment\Test-LocalAiRuntime.ps1 `
    -TimeoutSeconds 180
}

Get-Content "$deployment\logs\deployment-events.jsonl" -Tail 30
Get-Content "$deployment\logs\deployment-events.jsonl" -Wait
```

If `current.json` does not exist during the first installation, the snippet skips the release acceptance command until activation starts. Application stdout and stderr paths are recorded in `state\process.json`. Deployment events are newline-delimited JSON with UTC time, action, status, SHA, operation ID, and a bounded non-secret message. Default monitoring and `Test-LocalRelease.ps1` remain non-recursive and use the sealed attestation.

If the install process is interrupted, leave the pending record and release paths in place. The next locked deploy or rollback owns recovery: a completed matching seal is reused; otherwise the unreferenced incomplete directory and seal are moved under `failed\`, where the recovered pending record is preserved beside them. Do not manually delete the pending record or junction-bearing release tree. A referenced release, source-root reparse point, path escape, cross-volume move, or conflicting pending operation fails closed for operator review.

An Actions job reported as **Abandoned** is not proof that its local PowerShell process stopped. The observed failure sequence was a runner job-renewal HTTP timeout followed by `NotFound`; the Actions control plane abandoned the lease while the disk-bound command continued locally. Stop dispatching new work, inspect the exact local process and `release-installation-pending.json`, and let the process exit before the next locked recovery attempt. The durable pending record, not the remote job label, tells recovery what may be completed or quarantined. A GitHub Actions service hostname containing `azure-eastus` identifies GitHub's hosted control-plane infrastructure; this repository still has no Azure deployment target.

The GitHub runner writes its own diagnostics under `.local\deployment\github-runner\2.337.0\_diag`; its non-secret wrapper receipt is `state\github-runner-process.json`. Never publish the runner directory because it contains repository-scoped runner credentials and job workspaces.

## Rollback

Rollback changes the deployed API binaries and React bundle; it never runs `git checkout`, rewrites evidence, edits `.env`, or downloads a model. The GitHub rollback job performs no checkout and executes no `./scripts` path. It independently verifies the last-known-good controller pointer, manifest, path, and every controller hash, then invokes the installed frozen rollback entrypoint. That entrypoint uses the target release's fast sealed attestation, then runs release and local-AI verification before it removes the pending record, so there is no fallible post-commit acceptance step and no recursive tree or ACL pass in the health path.

```powershell
$deployment = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator\.local\deployment'
$previous = Get-Content "$deployment\previous.json" -Raw | ConvertFrom-Json
$controller = Get-Content "$deployment\state\last-known-good-controller.json" -Raw | ConvertFrom-Json

pwsh -NoProfile -File (Join-Path $controller.controllerRoot 'Rollback-LocalRelease.ps1') `
  -ExpectedPreviousSha $previous.commitSha `
  -WhatIf
```

Normal operation should dispatch the `Local Production Release` workflow with operation `rollback` and the exact `previous.json` SHA. The direct command above is diagnostic preview only. The rollback script re-reads `previous.json` inside the cross-session deployment lock and rejects the operation if the pointer changed after the operator selected it.

Rolling forward again to an already installed, sealed SHA is a redeploy, not a reinstall: it reuses the external seal and bounded checks, restarts the supervised task, and proves exact-SHA health. A genuinely new SHA performs the one-time dependency install and canonical graph qualification before activation. Neither rollback nor redeploy implicitly runs the independent full audit; request `-FullAudit` separately when that evidence is required.

The repository tools intentionally continue to operate on the canonical working tree. Therefore, a binary rollback does not roll back repository content, dashboard sample files, `.env`, trust state, or evidence. If compatibility requires a matching repository revision, perform a separately reviewed clean fast-forward/revert in Git and deploy that commit as a new release instead of forcing the working tree backward.

## Stop or remove supervision

Stop only the exact process named in the validated process receipt:

```powershell
pwsh -NoProfile -File .\scripts\deployment\Stop-LocalRelease.ps1 -WhatIf
pwsh -NoProfile -File .\scripts\deployment\Stop-LocalRelease.ps1
```

Remove only the exact repository-scoped scheduled task while preserving releases, state, logs, `.env`, and evidence:

```powershell
pwsh -NoProfile -File .\scripts\deployment\Remove-LocalProductionTask.ps1 -WhatIf
pwsh -NoProfile -File .\scripts\deployment\Remove-LocalProductionTask.ps1
```

Add `-StopRunningRelease` only when the running local application should also stop. No deployment cleanup or release-pruning command is provided; deletion of old immutable releases requires a separate review and approval.

To unregister the GitHub runner, create a short-lived removal token in GitHub and use another non-echoing prompt. The script stops and removes only the exact validated runner task and remote registration. It preserves the pinned binaries, diagnostics, and `_work` for separate review.

```powershell
pwsh -NoProfile -File .\scripts\deployment\Remove-GitHubRunner.ps1 -WhatIf

$runnerRemovalToken = Read-Host 'Paste the one-time runner removal token' -AsSecureString
try {
  & .\scripts\deployment\Remove-GitHubRunner.ps1 `
    -RemovalToken $runnerRemovalToken
} finally {
  Remove-Variable runnerRemovalToken -ErrorAction SilentlyContinue
}
```

`ACTIONS_RUNNER_REMOVAL_TOKEN` is the equivalent process-only environment input and is cleared immediately. Repeating removal after the validated registration and task are absent is a no-op.

## Operational limitations

- This is single-machine, single-user local production. It is not a public website, remote multi-user service, or high-availability deployment.
- The task uses interactive logon rather than a stored password or service account. The user must log on after a reboot before the application starts.
- The self-hosted runner and application require `D:` to remain connected.
- Ollama and WhiteShadow remain separate local dependencies. Production acceptance requires both, including a bounded real Ollama inference and an allowlisted WhiteShadow capability call. Startup does not pull, update, or replace models.
- Qlik remains a separately configured and governed adapter. Deployment does not enable it or add credentials.
- Releases are retained until manually reviewed; disk-capacity monitoring is an operator responsibility.
- NTFS ACLs are an operational drift guard, not a separate hostile-user security boundary: the runner, application, and release owner intentionally share this single-user Windows identity. Production startup checks the release root and bounded critical ACLs against the immutable seal; the out-of-band full audit revalidates every descendant ACL and dependency hash. Genuine protection from the machine owner would require a separate unprivileged runtime identity and privileged sealing service.
- The pinned GitHub runner has automatic updates disabled. When GitHub requires a newer runner, update the version, official URL, checksum, validation, and operator record through a reviewed release rather than modifying the installation in place.
- The known high transitive `undici` advisory below `@copilotkit/runtime` remains a release caveat until a stable compatible upstream fix exists. Loopback-only exposure reduces reachability but does not erase the advisory.
