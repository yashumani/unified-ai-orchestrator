# Local production deployment

This deployment keeps the complete Unified AI Orchestrator on the canonical Windows machine. GitHub Actions is the CI/CD control plane; the running API, React bundle, Ollama integration, WhiteShadow adapter, and local evidence remain on `D:`. GitHub Pages is not used because it cannot run the local API or model dependencies.

## Fixed security boundary

- The application listens only on `127.0.0.1:8790`.
- Readiness is `http://127.0.0.1:8790/api/ready`; a release passes only when the response reports the exact selected Git SHA and the evidence store is ready.
- Liveness is also checked internally at `http://127.0.0.1:8790/api/health`.
- The canonical repository is `D:\Yashu-AI-Workspace\unified-ai-orchestrator`.
- All installed releases, pointers, process receipts, backups, and deployment logs live under `.local\deployment`. The scripts reject another repository root, path traversal, reparse points in the deployment tree, non-loopback health URLs, malformed SHAs, and undeclared or hash-mismatched archive files.
- Release archives cannot contain `.env*`, `.git`, `.local`, `node_modules`, raw/private/ChatGPT sources, or undeclared files. `npm ci --omit=dev --ignore-scripts` installs locked runtime dependencies after archive verification.
- Runtime credentials are read from the canonical ignored `.env`; they are never copied into releases, logs, state backups, GitHub artifacts, or scheduled-task arguments.
- The Windows task uses the current interactive identity with `LogonType Interactive` and `RunLevel Limited`. It stores no password.

## Release layout

```text
.local/deployment/
├── current.json                 # selected release pointer
├── previous.json                # one-step rollback pointer
├── pending.json                 # exists only during activation
├── releases/<40-char-sha>/      # immutable extracted build + runtime dependencies
├── staging/                     # contained temporary extraction
├── downloads/                   # checksum-pinned runner archive
├── github-runner/2.337.0/       # pinned runner, credentials, diagnostics, and _work
├── state/process.json           # exact PID, SHA, entrypoint, Node path, and log paths
├── state/github-runner-*.json   # non-secret runner installation/process receipts
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
- Node.js 22 or newer, `npm`, and Git on `PATH`
- `D:` connected and the canonical repository present
- a clean `main` checkout tracking the exact GitHub release commit
- the ignored `.env` configured at the repository root
- Ollama and WhiteShadow installed at their existing pinned local paths
- a repository-scoped GitHub Actions self-hosted Windows runner registered through GitHub's normal ephemeral registration-token flow and running as the same Windows user that owns the scheduled task, Ollama, and WhiteShadow

Do not put a GitHub token, Windows password, `.env` value, or runner registration token in command history.

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

Preview and install the supervised task from an interactive terminal running as the same Windows user that owns Ollama and WhiteShadow:

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

1. Pull request verification runs the public-boundary check, tests, typecheck, and production build.
2. The approved pull request is merged to `main`.
3. The release job creates an archive whose root contains `release-manifest.json` and only manifest-declared payload files. Every payload file has a SHA-256 digest, and the manifest carries the exact 40-character commit SHA and lockfile digest.
4. GitHub publishes the immutable artifact/release.
5. The self-hosted Windows deployment job synchronizes the clean canonical `main` checkout by fast-forward only to that exact SHA. Deployment scripts never change Git state themselves.
6. `Deploy-LocalRelease.ps1` validates the canonical source, archive, hashes, task registration, Node runtime, and locked dependency installation.
7. Activation backs up pointer/process state, stops only the recorded orchestrator process, changes the release pointer, and starts the supervised task.
8. The job requires liveness, exact-SHA readiness, evidence readiness, a live exact-process receipt, and byte-for-byte equality between the served and packaged React index.
9. Only after those checks pass does the prior pointer become `previous.json`. If activation fails, the script restores the old pointer, restarts the old release, checks its readiness, and fails the job.

The manual equivalent, useful for diagnosis with a downloaded GitHub release artifact, is:

```powershell
$sha = (git rev-parse HEAD).Trim()
$artifact = 'D:\Downloads\unified-ai-orchestrator-release.zip'

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
```

Deployment from a feature branch, dirty checkout, uppercase/short SHA, mismatched artifact, missing task, unsafe archive, or non-loopback endpoint fails before activation.

## Monitoring

```powershell
$deployment = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator\.local\deployment'
$current = Get-Content "$deployment\current.json" -Raw | ConvertFrom-Json

Get-ScheduledTask -TaskName 'UnifiedAIOrchestrator-Local' |
  Select-Object TaskName, State
Get-Content "$deployment\state\process.json" -Raw
Invoke-RestMethod 'http://127.0.0.1:8790/api/ready'
pwsh -NoProfile -File .\scripts\deployment\Test-LocalRelease.ps1 `
  -ExpectedSha $current.commitSha

Get-Content "$deployment\logs\deployment-events.jsonl" -Tail 30
Get-Content "$deployment\logs\deployment-events.jsonl" -Wait
```

Application stdout and stderr paths are recorded in `state\process.json`. Deployment events are newline-delimited JSON with UTC time, action, status, SHA, operation ID, and a bounded non-secret message.

The GitHub runner writes its own diagnostics under `.local\deployment\github-runner\2.337.0\_diag`; its non-secret wrapper receipt is `state\github-runner-process.json`. Never publish the runner directory because it contains repository-scoped runner credentials and job workspaces.

## Rollback

Rollback changes the deployed API binaries and React bundle; it never runs `git checkout`, rewrites evidence, edits `.env`, or downloads a model. It swaps `current.json` and `previous.json` only after the rollback target passes exact-SHA readiness.

```powershell
$previous = Get-Content '.\.local\deployment\previous.json' -Raw | ConvertFrom-Json
pwsh -NoProfile -File .\scripts\deployment\Rollback-LocalRelease.ps1 `
  -ExpectedPreviousSha $previous.commitSha `
  -WhatIf
pwsh -NoProfile -File .\scripts\deployment\Rollback-LocalRelease.ps1 `
  -ExpectedPreviousSha $previous.commitSha
pwsh -NoProfile -File .\scripts\deployment\Test-LocalRelease.ps1 `
  -ExpectedSha $previous.commitSha
```

The rollback script re-reads `previous.json` inside the cross-session deployment lock and rejects the operation if the pointer changed after the operator selected it.

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
- Ollama and WhiteShadow remain separate local dependencies. Startup does not pull, update, or replace models.
- Qlik remains a separately configured and governed adapter. Deployment does not enable it or add credentials.
- Releases are retained until manually reviewed; disk-capacity monitoring is an operator responsibility.
- The pinned GitHub runner has automatic updates disabled. When GitHub requires a newer runner, update the version, official URL, checksum, validation, and operator record through a reviewed release rather than modifying the installation in place.
- The known high transitive `undici` advisory below `@copilotkit/runtime` remains a release caveat until a stable compatible upstream fix exists. Loopback-only exposure reduces reachability but does not erase the advisory.
