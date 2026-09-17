# One-shot controlled test only. Exact Host identity, foreground fixture,
# fresh global idle preflight and immutable backups are required before stop.
$ErrorActionPreference = 'Stop'
$taskRoot = 'F:\dsh\workflow-agent-signal-lab'
$taskEvidence = 'F:\dsh\workflow-agent-signal-lab\.dsh\activation\workflow-command-online-suite-20260915\restart-v3'
$taskRuntime = 'F:\dsh\workflow-agent-signal-lab\.dsh\workflow-runtime'
$taskNode = 'C:\nvm4w\nodejs\node.exe'
$taskEntry = 'D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$taskOldPid = 49572
$taskOldInstance = '95e805e7-ffc2-4b3f-b3cb-3e615f3db36a'
$taskActivation = Join-Path $taskEvidence 'activation'
$taskRetiredLock = Join-Path $taskRuntime 'writer.lock.retired-49572-20260915-command-unknown'
$taskReportPath = Join-Path $taskEvidence 'interruption.json'
$taskReport = [ordered]@{ startedAt = (Get-Date).ToString('o'); oldPid = $taskOldPid; status = 'preflight' }
$taskStopped = $false
$taskNewProcess = $null
Set-Location -LiteralPath $taskRoot

function Assert-ExactTaskHost {
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskOldPid"
    if ($null -eq $taskProcess -or $taskProcess.ExecutablePath -ne $taskNode -or
        $taskProcess.CommandLine -ne '"C:\nvm4w\nodejs\node.exe" D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3080' -or
        $taskProcess.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') -ne '2026-09-15 14:12:50') {
        throw 'The exact previously observed Host identity changed; refuse interruption.'
    }
    $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $taskOldPid -or $taskOwner.instanceId -ne $taskOldInstance) { throw 'Writer ownership changed.' }
    $taskListeners = @(Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop)
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $taskOldPid -or
        $taskListeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected 3080 owner or listener.' }
}

try {
    foreach ($taskNewPath in @($taskActivation, $taskRetiredLock, $taskReportPath)) {
        if (Test-Path -LiteralPath $taskNewPath) { throw "Refuse existing output: $taskNewPath" }
    }
    Assert-ExactTaskHost
    & $taskNode scripts/watch-command-fixture.mjs F:/dsh/deepseek-harness `
        .dsh/activation/workflow-question-wait-activation-20260915/host.stdout.log `
        .dsh/workflow-runtime/journal.sqlite workflow-command-online-restart-v3-20260915 `
        F:/dsh/workflow-command-restart-v3-fixture-20260915 live `
        .dsh/activation/workflow-command-online-suite-20260915/restart-v3/process-observation.json
    if ($LASTEXITCODE -ne 0) { throw 'Live command/global idle observer did not pass.' }
    & $taskNode scripts/backup-command-restart-fixture.mjs before
    if ($LASTEXITCODE -ne 0) { throw 'Backup failed; Host has NOT been stopped.' }
    Assert-ExactTaskHost
    & $taskNode scripts/backup-command-restart-fixture.mjs check
    if ($LASTEXITCODE -ne 0) { throw 'Last open-command/backup guard failed; Host has NOT been stopped.' }

    $taskReport.stopRequestedAt = (Get-Date).ToString('o')
    Stop-Process -Id $taskOldPid -Force -ErrorAction Stop
    $taskStopped = $true
    $taskExitDeadline = (Get-Date).AddSeconds(5)
    while ($null -ne (Get-Process -Id $taskOldPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $taskExitDeadline) {
        Start-Sleep -Milliseconds 50
    }
    if ($null -ne (Get-Process -Id $taskOldPid -ErrorAction SilentlyContinue)) { throw 'Exact Host did not exit.' }
    $taskReport.oldHostGoneAt = (Get-Date).ToString('o')
    & $taskNode scripts/backup-command-restart-fixture.mjs after
    if ($LASTEXITCODE -ne 0) { throw 'Post-stop backup failed; finally will still attempt service restoration.' }
    $taskReport.status = 'interrupted-and-backed-up'
} catch {
    $taskReport.error = $_.Exception.Message
    $taskReport.status = 'failed'
} finally {
    if ($taskStopped) {
        try {
            if ($null -ne (Get-Process -Id $taskOldPid -ErrorAction SilentlyContinue)) { throw 'Old Host still alive; do not replace lock.' }
            if (@(Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue).Count -ne 0) {
                throw 'Another process owns 3080; do not start a competing Host.'
            }
            $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskOwner.pid -ne $taskOldPid -or $taskOwner.instanceId -ne $taskOldInstance) { throw 'Do not retire another writer lock.' }
            if (Test-Path -LiteralPath $taskRetiredLock) { throw 'Retired lock already exists.' }
            # Exact file within verified runtime directory; preserve, never delete.
            Move-Item -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Destination $taskRetiredLock -ErrorAction Stop
            $null = New-Item -ItemType Directory -Path $taskActivation -ErrorAction Stop
            $taskNewProcess = Start-Process -FilePath $taskNode -ArgumentList @($taskEntry, 'web', '--no-open', '--port', '3080') `
                -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $taskActivation 'host.stdout.log') `
                -RedirectStandardError (Join-Path $taskActivation 'host.stderr.log')
            $taskReport.newPid = $taskNewProcess.Id
            $taskReadyDeadline = (Get-Date).AddSeconds(25)
            $taskReady = $false
            do {
                Start-Sleep -Milliseconds 250
                if ($taskNewProcess.HasExited) { throw 'Replacement Host exited during startup.' }
                $taskLogPath = Join-Path $taskActivation 'host.stdout.log'
                $taskReady = (Test-Path -LiteralPath $taskLogPath) -and
                    (Select-String -LiteralPath $taskLogPath -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet)
            } while (-not $taskReady -and (Get-Date) -lt $taskReadyDeadline)
            if (-not $taskReady) { throw 'Replacement Host did not announce readiness.' }
            $taskNewOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskNewOwner.pid -ne $taskNewProcess.Id -or $taskNewOwner.instanceId -eq $taskOldInstance) { throw 'Replacement writer mismatch.' }
            $taskReport.newOwner = $taskNewOwner
            $taskReport.serviceRestoredAt = (Get-Date).ToString('o')
            $taskReport.serviceRestored = $true
        } catch {
            $taskReport.restorationError = $_.Exception.Message
            $taskReport.serviceRestored = $false
            $taskReport.status = 'failed'
        }
    }
    $taskReport.finishedAt = (Get-Date).ToString('o')
    # Generated test receipt; source/config/database files are never written here.
    $taskReceiptStream = [System.IO.File]::Open($taskReportPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try {
        $taskReceiptBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($taskReport | ConvertTo-Json -Depth 12))
        $taskReceiptStream.Write($taskReceiptBytes, 0, $taskReceiptBytes.Length)
    } finally { $taskReceiptStream.Dispose() }
    $taskReport | ConvertTo-Json -Depth 12
}
if ($taskReport.status -eq 'failed') { exit 1 }
