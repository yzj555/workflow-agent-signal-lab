param(
    [Parameter(Mandatory=$true)][ValidateSet('activation','activation-retry','restore')][string]$Phase,
    [Parameter(Mandatory=$true)][int]$ExpectedPid,
    [Parameter(Mandatory=$true)][string]$ExpectedInstance,
    [Parameter(Mandatory=$true)][string]$ExpectedCreated,
    [Parameter(Mandatory=$true)][string]$LaunchLog
)
# User authorized two idle restarts for this one Session, not an in-flight crash test.
$ErrorActionPreference='Stop'
$taskRoot='F:\dsh\workflow-agent-signal-lab'
$taskBase=Join-Path $taskRoot '.dsh\activation\workflow-budget-online-20260916'
$taskTarget=Join-Path $taskBase $Phase
$taskRuntime=Join-Path $taskRoot '.dsh\workflow-runtime'
$taskNode='C:\nvm4w\nodejs\node.exe'
$taskEntry='D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$taskRetired=Join-Path $taskRuntime "writer.lock.retired-$ExpectedPid-20260916-budget-$Phase"
$taskStopped=$false
$taskReport=[ordered]@{phase=$Phase;oldPid=$ExpectedPid;startedAt=(Get-Date).ToString('o');status='preflight';backupBefore='not-attempted';backupAfter='not-attempted';serviceRestored=$false}
Set-Location -LiteralPath $taskRoot
function Assert-TaskHost {
    $taskHost=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
    if ($null -eq $taskHost -or $taskHost.ExecutablePath -ne $taskNode -or
        $taskHost.CommandLine -ne '"C:\nvm4w\nodejs\node.exe" D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3080' -or
        $taskHost.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') -ne $ExpectedCreated) {throw 'Host identity changed'}
    $taskOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) {throw 'Writer identity changed'}
    $taskListeners=@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop)
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $ExpectedPid -or $taskListeners[0].LocalAddress -ne '127.0.0.1') {throw 'Unexpected 3080 listener'}
}
if ((Test-Path -LiteralPath $taskTarget) -or (Test-Path -LiteralPath $taskRetired)) {throw 'Refuse repeated restart phase'}
if ($Phase -eq 'activation-retry') {
    $taskPrevious=Get-Content -LiteralPath (Join-Path $taskBase 'activation/restart.json') -Raw | ConvertFrom-Json
    if ($taskPrevious.error -ne 'Idle audit expired' -or $taskPrevious.stopRequestedAt -or $taskPrevious.newPid) {throw 'Retry is only allowed after the pre-stop timestamp guard rejection'}
}
$null=New-Item -ItemType Directory -Path $taskTarget
try {
    Assert-TaskHost
    & $taskNode scripts/check-dsh-tree-idle.mjs F:/dsh/deepseek-harness $LaunchLog (Join-Path $taskTarget 'idle.json')
    if ($LASTEXITCODE -ne 0) {throw 'Native idle guard rejected; no restart'}
    $taskReport.backupBefore='failed'
    & $taskNode scripts/budget-online-records.mjs backup "$Phase-before"
    if ($LASTEXITCODE -ne 0) {throw 'Backup or protected records rejected'}
    $taskReport.backupBefore='complete'
    Assert-TaskHost
    & $taskNode scripts/budget-online-records.mjs check
    if ($LASTEXITCODE -ne 0) {throw 'Final records/code guard rejected'}
    $taskIdle=Get-Content -LiteralPath (Join-Path $taskTarget 'idle.json') -Raw | ConvertFrom-Json
    # PowerShell 7 ConvertFrom-Json already returns a UTC DateTime for ISO Z.
    # Parsing its culture-formatted string again would lose the timezone.
    if (((Get-Date).ToUniversalTime()-([datetimeoffset]$taskIdle.checkedAt).UtcDateTime).TotalSeconds -gt 25) {throw 'Idle audit expired'}
    $taskReport.stopRequestedAt=(Get-Date).ToString('o')
    Stop-Process -Id $ExpectedPid -Force -ErrorAction Stop
    $taskStopped=$true
    $taskDeadline=(Get-Date).AddSeconds(5)
    while ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $taskDeadline) {Start-Sleep -Milliseconds 50}
    if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) {throw 'Old Host did not exit'}
    $taskReport.backupAfter='failed'
    & $taskNode scripts/budget-online-records.mjs backup "$Phase-after" $ExpectedPid $ExpectedInstance
    if ($LASTEXITCODE -ne 0) {throw 'Post-stop backup failed; restore service in finally'}
    $taskReport.backupAfter='complete'
    $taskReport.status='stopped-and-backed-up'
} catch {$taskReport.status='failed';$taskReport.error=$_.Exception.Message}
finally {
    if ($taskStopped) {
        try {
            if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) {throw 'Old Host still alive'}
            if (@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {throw '3080 acquired by another process'}
            $taskOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) {throw 'Cannot retire another writer'}
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskRetired)) -ne [IO.Path]::GetFullPath($taskRuntime)) {throw 'Retired lock escapes runtime'}
            Move-Item -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Destination $taskRetired
            $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @($taskEntry,'web','--no-open','--port','3080') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskTarget 'host.stdout.log') -RedirectStandardError (Join-Path $taskTarget 'host.stderr.log')
            $taskReport.newPid=$taskProcess.Id
            $taskDeadline=(Get-Date).AddSeconds(25)
            do {
                Start-Sleep -Milliseconds 250
                if ($taskProcess.HasExited) {throw 'New Host exited'}
                $taskReady=Select-String -LiteralPath (Join-Path $taskTarget 'host.stdout.log') -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet
            } while (-not $taskReady -and (Get-Date) -lt $taskDeadline)
            if (-not $taskReady) {throw 'Startup readiness timeout'}
            $taskNewOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
            if ($taskNewOwner.pid -ne $taskProcess.Id -or $taskNewOwner.instanceId -eq $ExpectedInstance) {throw 'New writer mismatch'}
            $taskReport.newOwner=$taskNewOwner
            $taskReport.serviceRestored=$true
            $taskReport.serviceRestoredAt=(Get-Date).ToString('o')
        } catch {$taskReport.status='failed';$taskReport.serviceRestored=$false;$taskReport.restorationError=$_.Exception.Message}
    }
    $taskReport.finishedAt=(Get-Date).ToString('o')
    $taskReceipt=Join-Path $taskTarget 'restart.json'
    $taskStream=[IO.File]::Open($taskReceipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {$taskBytes=[Text.UTF8Encoding]::new($false).GetBytes(($taskReport|ConvertTo-Json -Depth 10));$taskStream.Write($taskBytes,0,$taskBytes.Length)} finally {$taskStream.Dispose()}
    $taskReport|ConvertTo-Json -Depth 10
}
if ($taskReport.status -eq 'failed') {exit 1}
