param(
    [Parameter(Mandatory=$true)][ValidateSet('activation','interruption','persistence')][string]$Phase,
    [Parameter(Mandatory=$true)][int]$ExpectedPid,
    [Parameter(Mandatory=$true)][string]$ExpectedInstance,
    [Parameter(Mandatory=$true)][string]$ExpectedCreated,
    [Parameter(Mandatory=$true)][string]$LaunchLog
)
# The user explicitly authorized these three scoped test epochs. No generic restart target.
$ErrorActionPreference = 'Stop'
$taskRoot = 'F:\dsh\workflow-agent-signal-lab'
$taskBase = Join-Path $taskRoot '.dsh\activation\workflow-manual-recovery-20260915'
$taskTarget = Join-Path $taskBase $Phase
$taskRuntime = Join-Path $taskRoot '.dsh\workflow-runtime'
$taskNode = 'C:\nvm4w\nodejs\node.exe'
$taskEntry = 'D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$taskReportPath = Join-Path $taskTarget 'restart.json'
$taskRetired = Join-Path $taskRuntime "writer.lock.retired-$ExpectedPid-20260915-manual-$Phase"
$taskStopped = $false
$taskReport = [ordered]@{ phase=$Phase; oldPid=$ExpectedPid; startedAt=(Get-Date).ToString('o'); status='preflight' }
Set-Location -LiteralPath $taskRoot
function Assert-TaskHost {
    $taskHost = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
    if ($null -eq $taskHost -or $taskHost.ExecutablePath -ne $taskNode -or
        $taskHost.CommandLine -ne '"C:\nvm4w\nodejs\node.exe" D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3080' -or
        $taskHost.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') -ne $ExpectedCreated) { throw 'Exact Host identity changed.' }
    $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) { throw 'Writer identity changed.' }
    $taskListeners = @(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop)
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $ExpectedPid -or $taskListeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected 3080 owner.' }
}
try {
    if ((Test-Path -LiteralPath $taskReportPath) -or (Test-Path -LiteralPath $taskRetired)) { throw 'Refuse a repeated epoch or existing receipt.' }
    Assert-TaskHost
    $null = New-Item -ItemType Directory -Path $taskTarget -Force
    if ($Phase -eq 'interruption') {
        & $taskNode scripts/watch-command-fixture.mjs F:/dsh/deepseek-harness $LaunchLog .dsh/workflow-runtime/journal.sqlite `
            workflow-command-online-manual-recovery-20260915 F:/dsh/workflow-command-manual-recovery-fixture-20260915 live (Join-Path $taskTarget 'preflight.json')
    } else {
        & $taskNode scripts/check-dsh-tree-idle.mjs F:/dsh/deepseek-harness $LaunchLog (Join-Path $taskTarget 'preflight.json')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Native preflight rejected; Host not stopped.' }
    & $taskNode scripts/backup-manual-recovery-activation.mjs before $Phase $ExpectedPid $ExpectedInstance
    if ($LASTEXITCODE -ne 0) { throw 'Pre-stop backup rejected; Host not stopped.' }
    Assert-TaskHost
    & $taskNode scripts/backup-manual-recovery-activation.mjs check $Phase $ExpectedPid $ExpectedInstance
    if ($LASTEXITCODE -ne 0) { throw 'Final freshness/record guard rejected; Host not stopped.' }
    $taskReport.stopRequestedAt = (Get-Date).ToString('o')
    Stop-Process -Id $ExpectedPid -Force -ErrorAction Stop
    $taskStopped = $true
    $taskExitDeadline = (Get-Date).AddSeconds(5)
    while ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $taskExitDeadline) { Start-Sleep -Milliseconds 50 }
    if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'Old Host did not exit.' }
    & $taskNode scripts/backup-manual-recovery-activation.mjs after $Phase $ExpectedPid $ExpectedInstance
    if ($LASTEXITCODE -ne 0) { throw 'Post-stop backup failed; finally will attempt restoration.' }
    $taskReport.status = 'stopped-and-backed-up'
} catch {
    $taskReport.status = 'failed'; $taskReport.error = $_.Exception.Message
} finally {
    if ($taskStopped) {
        try {
            if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'Old Host still alive.' }
            if (@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw '3080 acquired by another process.' }
            $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) { throw 'Refuse to retire another writer.' }
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskRetired)) -ne [IO.Path]::GetFullPath($taskRuntime)) { throw 'Retired path escapes runtime.' }
            Move-Item -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Destination $taskRetired -ErrorAction Stop
            $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @($taskEntry,'web','--no-open','--port','3080') `
                -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $taskTarget 'host.stdout.log') -RedirectStandardError (Join-Path $taskTarget 'host.stderr.log')
            $taskReport.newPid = $taskProcess.Id
            $taskDeadline = (Get-Date).AddSeconds(25); $taskReady = $false
            do {
                Start-Sleep -Milliseconds 250
                if ($taskProcess.HasExited) { throw 'New Host exited during startup.' }
                $taskReady = Select-String -LiteralPath (Join-Path $taskTarget 'host.stdout.log') -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet
            } while (-not $taskReady -and (Get-Date) -lt $taskDeadline)
            if (-not $taskReady) { throw 'New Host did not announce readiness.' }
            $taskNewOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskNewOwner.pid -ne $taskProcess.Id -or $taskNewOwner.instanceId -eq $ExpectedInstance) { throw 'New writer mismatch.' }
            $taskReport.newOwner = $taskNewOwner
            $taskReport.serviceRestoredAt = (Get-Date).ToString('o'); $taskReport.serviceRestored = $true
        } catch { $taskReport.restorationError=$_.Exception.Message; $taskReport.serviceRestored=$false; $taskReport.status='failed' }
    }
    $taskReport.finishedAt = (Get-Date).ToString('o')
    if (Test-Path -LiteralPath $taskTarget) {
        # Generated receipt only; never overwrite a prior acceptance record.
        $taskStream = [IO.File]::Open($taskReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
        try { $taskBytes=[Text.UTF8Encoding]::new($false).GetBytes(($taskReport | ConvertTo-Json -Depth 10)); $taskStream.Write($taskBytes,0,$taskBytes.Length) }
        finally { $taskStream.Dispose() }
    }
    $taskReport | ConvertTo-Json -Depth 10
}
if ($taskReport.status -eq 'failed') { exit 1 }
