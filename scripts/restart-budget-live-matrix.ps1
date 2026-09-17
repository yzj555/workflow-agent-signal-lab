param(
    [Parameter(Mandatory=$true)][ValidateSet('stop','start')][string]$Action,
    [Parameter(Mandatory=$true)][ValidateSet('command','time','restore')][string]$Phase,
    [int]$ExpectedPid,
    [string]$ExpectedInstance,
    [string]$ExpectedCreatedAt,
    [string]$LaunchLog
)
# Three user-authorized IDLE restarts. No active-turn/crash injection.
# Caller applies the exact config patch after stop, and always calls start.
$ErrorActionPreference='Stop'
$taskRoot='F:\dsh\workflow-agent-signal-lab'
$taskBase=Join-Path $taskRoot '.dsh\activation\workflow-budget-live-matrix-20260917'
$taskTarget=Join-Path $taskBase "restart-$Phase"
$taskRuntime=Join-Path $taskRoot '.dsh\workflow-runtime'
$taskNode='C:\nvm4w\nodejs\node.exe'
$taskEntry='D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
Set-Location -LiteralPath $taskRoot
function Save-TaskReceipt($File,$Value) {
    $taskStream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try { $taskBytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12)); $taskStream.Write($taskBytes,0,$taskBytes.Length) }
    finally { $taskStream.Dispose() }
}
function Assert-TaskHost {
    $taskHost=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
    if ($null -eq $taskHost -or $taskHost.ExecutablePath -ne $taskNode -or
        $taskHost.CommandLine -ne '"C:\nvm4w\nodejs\node.exe" D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3080' -or
        $taskHost.CreationDate.ToUniversalTime() -ne ([datetimeoffset]$ExpectedCreatedAt).UtcDateTime) { throw 'Exact official Host identity changed' }
    $taskOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) { throw 'Writer identity changed' }
    $taskListeners=@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop)
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $ExpectedPid -or $taskListeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener' }
}
if ($Action -eq 'stop') {
    if ($ExpectedPid -le 0 -or -not $ExpectedInstance -or -not $ExpectedCreatedAt -or -not $LaunchLog) { throw 'Exact expected Host and launch log required' }
    if (Test-Path -LiteralPath $taskTarget) { throw 'Restart phase already used; no repeated stop' }
    if ($Phase -ne 'command') {
        $taskPrevious=if ($Phase -eq 'time') {'command'} else {'time'}
        $taskReceipt=Get-Content -LiteralPath (Join-Path $taskBase "restart-$taskPrevious/start.json") -Raw | ConvertFrom-Json
        if ($taskReceipt.status -ne 'ready' -or $taskReceipt.newPid -ne $ExpectedPid) { throw 'Previous restart phase is not the current Host' }
    }
    $null=New-Item -ItemType Directory -Path $taskTarget
    $taskReport=[ordered]@{phase=$Phase;startedAt=(Get-Date).ToString('o');oldPid=$ExpectedPid;oldInstance=$ExpectedInstance;oldCreatedAt=$ExpectedCreatedAt;stopped=$false;status='preflight'}
    try {
        Assert-TaskHost
        $taskConfig=if ($Phase -eq 'command') {'baseline'} elseif ($Phase -eq 'time') {'command'} else {'time'}
        & $taskNode scripts/budget-live-matrix-records.mjs check-config $taskConfig | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unexpected pre-stop config' }
        & $taskNode scripts/budget-live-matrix-records.mjs backup "$Phase-before" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Protected baseline/backup rejected' }
        & $taskNode scripts/check-dsh-tree-idle.mjs F:/dsh/deepseek-harness $LaunchLog (Join-Path $taskTarget 'idle.json') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Native idle guard rejected' }
        Assert-TaskHost
        & $taskNode scripts/budget-live-matrix-records.mjs check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Final records guard rejected' }
        $taskIdle=Get-Content -LiteralPath (Join-Path $taskTarget 'idle.json') -Raw | ConvertFrom-Json
        if (((Get-Date).ToUniversalTime()-([datetimeoffset]$taskIdle.checkedAt).UtcDateTime).TotalSeconds -gt 25) { throw 'Idle audit expired' }
        $taskReport.stopRequestedAt=(Get-Date).ToString('o')
        Stop-Process -Id $ExpectedPid -Force -ErrorAction Stop
        $taskReport.stopped=$true
        $taskDeadline=(Get-Date).AddSeconds(5)
        while ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $taskDeadline) { Start-Sleep -Milliseconds 50 }
        if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'Old Host did not exit' }
        & $taskNode scripts/budget-live-matrix-records.mjs backup "$Phase-after" $ExpectedPid $ExpectedInstance | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Stopped-copy backup failed; caller must restore service without starting test' }
        $taskReport.status='stopped-and-backed-up'
    } catch { $taskReport.status='failed'; $taskReport.error=$_.Exception.Message }
    $taskReport.finishedAt=(Get-Date).ToString('o')
    Save-TaskReceipt (Join-Path $taskTarget 'stop.json') $taskReport
    $taskReport | ConvertTo-Json -Depth 12
    if ($taskReport.status -eq 'failed') { exit 1 }
    exit 0
}
$taskStop=Get-Content -LiteralPath (Join-Path $taskTarget 'stop.json') -Raw | ConvertFrom-Json
if (-not $taskStop.stopped) { throw 'No stopped Host in this phase' }
if (Test-Path -LiteralPath (Join-Path $taskTarget 'start.json')) { throw 'Start phase already consumed' }
$taskReport=[ordered]@{phase=$Phase;startedAt=(Get-Date).ToString('o');status='starting';oldPid=$taskStop.oldPid}
try {
    if ($null -ne (Get-Process -Id $taskStop.oldPid -ErrorAction SilentlyContinue)) { throw 'Old PID exists; do not touch a potentially reused PID' }
    if (@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Another process owns 3080' }
    $taskOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $taskStop.oldPid -or $taskOwner.instanceId -ne $taskStop.oldInstance) { throw 'Cannot retire another writer' }
    $taskRetired=Join-Path $taskRuntime "writer.lock.retired-$($taskStop.oldPid)-20260917-budget-live-$Phase"
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskRetired)) -ne [IO.Path]::GetFullPath($taskRuntime)) { throw 'Retired lock escapes runtime' }
    if (Test-Path -LiteralPath $taskRetired) { throw 'Retired lock already exists' }
    Move-Item -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Destination $taskRetired
    $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @($taskEntry,'web','--no-open','--port','3080') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskTarget 'host.stdout.log') -RedirectStandardError (Join-Path $taskTarget 'host.stderr.log')
    $taskReport.newPid=$taskProcess.Id
    $taskDeadline=(Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 250
        if ($taskProcess.HasExited) { throw 'New Host exited' }
        $taskReady=Select-String -LiteralPath (Join-Path $taskTarget 'host.stdout.log') -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet
    } while (-not $taskReady -and (Get-Date) -lt $taskDeadline)
    if (-not $taskReady) { throw 'Startup timeout' }
    $taskNewOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskNewOwner.pid -ne $taskProcess.Id -or $taskNewOwner.instanceId -eq $taskStop.oldInstance) { throw 'New writer mismatch' }
    $taskReport.newOwner=$taskNewOwner
    $taskReport.createdAt=(Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)").CreationDate.ToUniversalTime().ToString('o')
    $taskReport.status='ready'
} catch { $taskReport.status='failed'; $taskReport.error=$_.Exception.Message }
$taskReport.finishedAt=(Get-Date).ToString('o')
Save-TaskReceipt (Join-Path $taskTarget 'start.json') $taskReport
$taskReport | ConvertTo-Json -Depth 12
if ($taskReport.status -ne 'ready') { exit 1 }
