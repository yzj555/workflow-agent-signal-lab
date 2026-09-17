param([Parameter(Mandatory=$true)][switch]$UserAuthorized)
# One explicitly authorized IDLE activation, with one failure rollback. No tasks/gates/config writes.
$ErrorActionPreference = 'Stop'
if (-not $UserAuthorized) { throw 'Explicit activation authorization required' }
$taskRoot = 'F:\dsh\workflow-agent-signal-lab'
$taskBase = Join-Path $taskRoot '.dsh\activation\workflow-basic-production-20260917'
$taskTarget = Join-Path $taskBase 'activation'
$taskRuntime = Join-Path $taskRoot '.dsh\workflow-runtime'
$taskNode = 'C:\nvm4w\nodejs\node.exe'
$taskEntry = 'D:\nvm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$taskOldLog = Join-Path $taskRoot '.dsh\activation\workflow-budget-live-matrix-20260917\restart-restore\host.stdout.log'
$taskOld = Get-Content -LiteralPath (Join-Path $taskBase 'baseline\witness.json') -Raw | ConvertFrom-Json
$taskOldCreated = '2026-09-17T03:23:29.2173990Z'
$taskPeer = Join-Path $taskRoot 'node_modules\@deepseek-ai\dsh-session-persistence'
$taskPeerTarget = 'F:\dsh\deepseek-harness\packages\session\session-persistence'
$taskPeerExisted = Test-Path -LiteralPath $taskPeer
$taskReport = [ordered]@{ startedAt=(Get-Date).ToString('o'); status='preflight'; stopped=$false; switched=$false; rollback=$false }
$taskCurrent = $null
Set-Location -LiteralPath $taskRoot
if (Test-Path -LiteralPath $taskTarget) { throw 'This activation attempt was already used; inspect its receipt' }
$null = New-Item -ItemType Directory -Path $taskTarget
function Save-TaskReceipt($File, $Value) {
    $taskStream = [IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try { $taskBytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12)); $taskStream.Write($taskBytes,0,$taskBytes.Length) }
    finally { $taskStream.Dispose() }
}
function Assert-TaskIdentity($ExpectedPid, $ExpectedInstance, $ExpectedCreated) {
    $taskHost = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
    if ($null -eq $taskHost -or $taskHost.ExecutablePath -ne $taskNode -or
        $taskHost.CommandLine -ne ('"' + $taskNode + '" ' + $taskEntry + ' web --no-open --port 3080') -or
        $taskHost.CreationDate.ToUniversalTime() -ne ([datetimeoffset]$ExpectedCreated).UtcDateTime) { throw 'Exact Host identity changed' }
    $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    if ($taskOwner.pid -ne $ExpectedPid -or $taskOwner.instanceId -ne $ExpectedInstance) { throw 'Writer changed' }
    $taskListeners = @(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop)
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $ExpectedPid -or $taskListeners[0].LocalAddress -ne '127.0.0.1') { throw 'Listener changed' }
}
function Assert-TaskIdle($Log, $Label) {
    & $taskNode scripts/check-dsh-tree-idle.mjs F:/dsh/deepseek-harness $Log (Join-Path $taskTarget "$Label-idle.json") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Native root/child/queue/job idle guard rejected' }
    $taskAudit = Get-Content -LiteralPath (Join-Path $taskTarget "$Label-idle.json") -Raw | ConvertFrom-Json
    if (((Get-Date).ToUniversalTime() - ([datetimeoffset]$taskAudit.checkedAt).UtcDateTime).TotalSeconds -gt 25) { throw 'Idle observation expired' }
}
function Stop-TaskExact($ExpectedPid, $ExpectedInstance, $ExpectedCreated) {
    Assert-TaskIdentity $ExpectedPid $ExpectedInstance $ExpectedCreated
    Stop-Process -Id $ExpectedPid -Force
    $taskDeadline = (Get-Date).AddSeconds(5)
    while ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $taskDeadline) { Start-Sleep -Milliseconds 50 }
    if ($null -ne (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'Host exit not confirmed' }
}
function Start-TaskHost($Label, $RetiringOwner) {
    if (@(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).Count) { throw '3080 occupied' }
    if (Test-Path -LiteralPath (Join-Path $taskRuntime 'writer.lock')) {
        if ($null -ne (Get-Process -Id $RetiringOwner.pid -ErrorAction SilentlyContinue)) { throw 'Old PID exists; never touch a reused PID' }
        $taskOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
        if ($taskOwner.pid -ne $RetiringOwner.pid -or $taskOwner.instanceId -ne $RetiringOwner.instanceId) { throw 'Unexpected writer; refuse takeover' }
        $taskRetired = Join-Path $taskRuntime "writer.lock.retired-$($taskOwner.pid)-basic-20260917-$Label"
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskRetired)) -ne [IO.Path]::GetFullPath($taskRuntime) -or (Test-Path -LiteralPath $taskRetired)) { throw 'Invalid retired lock target' }
        Move-Item -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Destination $taskRetired
    }
    $taskLog = Join-Path $taskTarget "$Label.stdout.log"
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @($taskEntry,'web','--no-open','--port','3080') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskLog -RedirectStandardError (Join-Path $taskTarget "$Label.stderr.log")
    $script:taskCurrent = @{ process=$taskProcess; pid=$taskProcess.Id; log=$taskLog; ready=$false;
        createdAt=(Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)").CreationDate.ToUniversalTime().ToString('o') }
    $taskDeadline=(Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 250
        $taskProcess.Refresh()
        if ($taskProcess.HasExited) { throw 'New Host exited' }
        $taskReady = Select-String -LiteralPath $taskLog -Pattern 'dsh web:.*http://127.0.0.1:3080/' -Quiet
    } while (-not $taskReady -and (Get-Date) -lt $taskDeadline)
    if (-not $taskReady) { throw 'Host startup timeout; retain exact identity for safe recovery' }
    $taskNewOwner = Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
    Assert-TaskIdentity $taskProcess.Id $taskNewOwner.instanceId $taskCurrent.createdAt
    $script:taskCurrent.owner=$taskNewOwner; $script:taskCurrent.ready=$true
}
try {
    & $taskNode scripts/basic-production-release.mjs preflight
    if ($LASTEXITCODE -ne 0) { throw 'Release preflight rejected' }
    Assert-TaskIdentity $taskOld.writer.pid $taskOld.writer.instanceId $taskOldCreated
    & $taskNode scripts/basic-production-release.mjs backup activation-before
    if ($LASTEXITCODE -ne 0) { throw 'Online backup rejected' }
    Assert-TaskIdle $taskOldLog 'before'
    Stop-TaskExact $taskOld.writer.pid $taskOld.writer.instanceId $taskOldCreated
    $taskReport.stopped=$true
    & $taskNode scripts/basic-production-release.mjs backup-stopped activation-stopped
    if ($LASTEXITCODE -ne 0) { throw 'Stopped backup rejected' }
    & (Join-Path $taskRoot 'scripts\link-dsh-dev.ps1') -DshSourceRoot F:\dsh\deepseek-harness
    $taskLib = [IO.Path]::GetFullPath((Join-Path $taskRoot 'lib'))
    $taskSavedLib = [IO.Path]::GetFullPath((Join-Path $taskTarget 'previous-lib'))
    if ([IO.Path]::GetDirectoryName($taskLib) -ne $taskRoot -or [IO.Path]::GetDirectoryName($taskSavedLib) -ne $taskTarget -or (Test-Path -LiteralPath $taskSavedLib)) { throw 'Build swap path guard failed' }
    Move-Item -LiteralPath $taskLib -Destination $taskSavedLib
    $taskReport.switched=$true
    Copy-Item -LiteralPath (Join-Path $taskBase 'release\lib') -Destination $taskLib -Recurse
    Start-TaskHost 'candidate' $taskOld.writer
    & $taskNode scripts/basic-production-release.mjs postflight
    if ($LASTEXITCODE -ne 0) { throw 'Active build/config verification failed' }
    & $taskNode scripts/probe-agent-terminal-ui.mjs F:/dsh/deepseek-harness $taskCurrent.log (Join-Path $taskTarget 'native-ui')
    if ($LASTEXITCODE -ne 0) { throw 'Read-only UI verification failed' }
    & $taskNode scripts/basic-production-release.mjs backup activation-after
    if ($LASTEXITCODE -ne 0) { throw 'Post-start records changed' }
    Assert-TaskIdle $taskCurrent.log 'after'
    $taskReport.status='activated-and-verified'
} catch {
    $taskReport.error=$_.Exception.Message; $taskReport.status='failed-before-stop'
    if ($taskReport.stopped) {
        $taskReport.status='recovery-needs-attention'
        try {
            $taskRetiring=$taskOld.writer
            if ($null -ne $taskCurrent) {
                $taskCurrent.process.Refresh()
                if (-not $taskCurrent.process.HasExited) {
                    # Never interrupt user work that arrived during verification.
                    Assert-TaskIdle $taskCurrent.log 'rollback'
                    $taskOwner=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json
                    Stop-TaskExact $taskCurrent.pid $taskOwner.instanceId $taskCurrent.createdAt
                }
                if (Test-Path -LiteralPath (Join-Path $taskRuntime 'writer.lock')) { $taskRetiring=Get-Content -LiteralPath (Join-Path $taskRuntime 'writer.lock') -Raw | ConvertFrom-Json }
            }
            if ($taskReport.switched) {
                $taskFailedLib=[IO.Path]::GetFullPath((Join-Path $taskTarget 'rejected-lib'))
                if ([IO.Path]::GetDirectoryName($taskFailedLib) -ne $taskTarget -or (Test-Path -LiteralPath $taskFailedLib)) { throw 'Rollback target guard failed' }
                if (Test-Path -LiteralPath (Join-Path $taskRoot 'lib')) { Move-Item -LiteralPath (Join-Path $taskRoot 'lib') -Destination $taskFailedLib }
                Move-Item -LiteralPath (Join-Path $taskTarget 'previous-lib') -Destination (Join-Path $taskRoot 'lib')
            }
            if (-not $taskPeerExisted -and (Test-Path -LiteralPath $taskPeer)) {
                $taskLink=Get-Item -LiteralPath $taskPeer
                if ($taskLink.LinkType -ne 'Junction' -or $taskLink.Target -ne $taskPeerTarget) { throw 'Dependency target changed; refuse removal' }
                [IO.Directory]::Delete($taskPeer) # Nonrecursive: removes only the verified new junction, never its target.
            }
            Copy-Item -LiteralPath (Join-Path $taskBase 'baseline\package.json') -Destination (Join-Path $taskRoot 'package.json')
            Start-TaskHost 'rollback' $taskRetiring
            & $taskNode scripts/basic-production-release.mjs backup activation-rollback
            if ($LASTEXITCODE -ne 0) { throw 'Rollback data verification failed' }
            $taskReport.rollback=$true; $taskReport.status='rolled-back-data-retained'
        } catch { $taskReport.recoveryError=$_.Exception.Message }
    }
} finally {
    $taskReport.finishedAt=(Get-Date).ToString('o')
    if ($null -ne $taskCurrent) { $taskReport.host=@{pid=$taskCurrent.pid;createdAt=$taskCurrent.createdAt;ready=$taskCurrent.ready;owner=$taskCurrent.owner} }
    Save-TaskReceipt (Join-Path $taskTarget 'result.json') $taskReport
    $taskReport | ConvertTo-Json -Depth 12
}
if ($taskReport.status -ne 'activated-and-verified') { exit 1 }
