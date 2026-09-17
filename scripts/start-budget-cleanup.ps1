# User approved one normal startup plus read-only UI replay; no crash or new model task.
$ErrorActionPreference='Stop'
$taskRoot='F:\dsh\workflow-agent-signal-lab'
$taskRuntime=Join-Path $taskRoot '.dsh\workflow-runtime'
$taskEvidence=Join-Path $taskRoot '.dsh\activation\workflow-budget-cleanup-20260917\startup'
$taskNode='C:\nvm4w\nodejs\node.exe'
$taskEntry='D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$taskLock=Join-Path $taskRuntime 'writer.lock'
$taskRetired=Join-Path $taskRuntime 'writer.lock.retired-43048-20260917-cleanup'
if ((Test-Path -LiteralPath $taskEvidence) -or (Test-Path -LiteralPath $taskRetired)) {throw 'Refuse repeated startup'}
function Assert-TaskStopped {
    $taskOwner=Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne 43048 -or $taskOwner.instanceId -ne '1e18c294-dad6-47b5-bacf-3ef8fa810c84') {throw 'Old writer identity changed'}
    $taskCurrent=Get-CimInstance Win32_Process -Filter 'ProcessId=43048'
    if ($null -ne $taskCurrent -and [DateTimeOffset]::new($taskCurrent.CreationDate).ToUnixTimeMilliseconds() -le $taskOwner.startedAt + 10000) {throw 'Original Host may still be present'}
    if (@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {throw '3080 already in use; no stop/restart allowed'}
}
Set-Location -LiteralPath $taskRoot
Assert-TaskStopped
& $taskNode scripts/backup-budget-cleanup.mjs check pre-start
if ($LASTEXITCODE -ne 0) {throw 'Protected-record/default-scope backup guard failed'}
$null=New-Item -ItemType Directory -Path $taskEvidence
$taskReceipt=[ordered]@{startedAt=(Get-Date).ToString('o');mode='normal-start-readonly-ui';status='failed';modelTasksSubmitted=0;oldProcessStopped=$false}
try {
    Assert-TaskStopped
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskRetired)) -ne [IO.Path]::GetFullPath($taskRuntime)) {throw 'Retired lock escapes intended runtime'}
    Move-Item -LiteralPath $taskLock -Destination $taskRetired
    $taskReceipt.oldWriterRecord='retained as writer.lock.retired-43048-20260917-cleanup'
    $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @($taskEntry,'web','--no-open','--port','3080') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskEvidence 'host.stdout.log') -RedirectStandardError (Join-Path $taskEvidence 'host.stderr.log')
    $taskReceipt.pid=$taskProcess.Id
    $taskDeadline=(Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 250
        if ($taskProcess.HasExited) {throw 'New Host exited'}
        $taskReady=Select-String -LiteralPath (Join-Path $taskEvidence 'host.stdout.log') -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet
    } while (-not $taskReady -and (Get-Date) -lt $taskDeadline)
    if (-not $taskReady) {throw 'Startup readiness timeout'}
    $taskNewOwner=Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
    if ($taskNewOwner.pid -ne $taskProcess.Id -or $taskNewOwner.instanceId -eq '1e18c294-dad6-47b5-bacf-3ef8fa810c84') {throw 'Unexpected new owner'}
    $taskReceipt.newWriter=$taskNewOwner
    $taskReceipt.status='started'
} catch {$taskReceipt.error=$_.Exception.Message}
finally {
    $taskReceipt.finishedAt=(Get-Date).ToString('o')
    $taskStream=[IO.File]::Open((Join-Path $taskEvidence 'startup.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {$taskBytes=[Text.UTF8Encoding]::new($false).GetBytes(($taskReceipt|ConvertTo-Json -Depth 8));$taskStream.Write($taskBytes,0,$taskBytes.Length)} finally {$taskStream.Dispose()}
    $taskReceipt|ConvertTo-Json -Depth 8
}
if ($taskReceipt.status -ne 'started') {exit 1}
