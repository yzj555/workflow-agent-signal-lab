param([Parameter(Mandatory = $true)][string]$DshSourceRoot, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
$dshRoot = (Resolve-Path -LiteralPath $DshSourceRoot).Path
$labManifest = Get-Content -Raw -LiteralPath (Join-Path $labRoot 'package.json') | ConvertFrom-Json
$hostManifest = Get-Content -Raw -LiteralPath (Join-Path $dshRoot 'apps/cli/package.json') | ConvertFrom-Json
if ($hostManifest.name -ne '@deepseek-ai/dsh' -or $hostManifest.version -ne '0.2.0-rc.2') {
    throw 'Development links require the reviewed DSH 0.2.0-rc.2 source baseline.'
}
$links = [ordered]@{
    '@deepseek-ai/cordis' = Join-Path $dshRoot 'vendor/cordis'
    '@deepseek-ai/cordis-plugin-loader' = Join-Path $dshRoot 'vendor/loader'
    '@deepseek-ai/dsh-persona' = Join-Path $dshRoot 'packages/preset/persona'
    '@deepseek-ai/dsh-agent-tool-presentation' = Join-Path $dshRoot 'packages/core/agent-tool-presentation'
    '@deepseek-ai/schemastery' = Join-Path $dshRoot 'vendor/schemastery'
    '@deepseek-ai/dsh-storage' = Join-Path $dshRoot 'packages/storage/storage'
    '@deepseek-ai/dsh-storage-domain' = Join-Path $dshRoot 'packages/storage/storage-domain'
    '@deepseek-ai/dsh-storage-sqlite' = Join-Path $dshRoot 'packages/storage/storage-sqlite'
    '@deepseek-ai/dsh-api-session-controller' = Join-Path $dshRoot 'packages/api/session-controller'
    '@deepseek-ai/dsh-client-connection' = Join-Path $dshRoot 'packages/client/connection'
    '@deepseek-ai/dsh-host-webserver' = Join-Path $dshRoot 'packages/host/webserver'
    '@deepseek-ai/dsh-client-store' = Join-Path $dshRoot 'packages/client/store'
    '@deepseek-ai/dsh-client-ui-chat' = Join-Path $dshRoot 'packages/client/ui-chat'
    '@deepseek-ai/dsh-client-ui-conversation' = Join-Path $dshRoot 'packages/client/ui-conversation'
    '@deepseek-ai/dsh-client-ui-primitives' = Join-Path $dshRoot 'packages/client/ui-primitives'
    '@deepseek-ai/dsh-client-ui-renderer' = Join-Path $dshRoot 'packages/client/ui-renderer'
    '@deepseek-ai/dsh-client-ui-session' = Join-Path $dshRoot 'packages/client/ui-session'
    '@deepseek-ai/dsh-client-ui-slots' = Join-Path $dshRoot 'packages/client/ui-slots'
    '@deepseek-ai/dsh-client-ui-user-questions' = Join-Path $dshRoot 'packages/client/ui-user-questions'
    '@deepseek-ai/dsh-session' = Join-Path $dshRoot 'packages/core/session'
    '@deepseek-ai/dsh-session-persistence' = Join-Path $dshRoot 'packages/session/session-persistence'
    '@deepseek-ai/dsh-session-query' = Join-Path $dshRoot 'packages/session-query/session-query'
    '@deepseek-ai/dsh-agent' = Join-Path $dshRoot 'packages/core/agent'
    '@deepseek-ai/dsh-agent-preset-registry' = Join-Path $dshRoot 'packages/preset/agent-preset-registry'
    '@deepseek-ai/dsh-agent-preset' = Join-Path $dshRoot 'packages/preset/agent-preset'
    '@deepseek-ai/dsh-app-boot' = Join-Path $dshRoot 'packages/boot/app-boot'
    '@deepseek-ai/cordis-plugin-include' = Join-Path $dshRoot 'vendor/include'
    '@deepseek-ai/dsh-subagent' = Join-Path $dshRoot 'packages/subagent/subagent'
    '@deepseek-ai/dsh-subagent-spawn-in-process' = Join-Path $dshRoot 'packages/subagent/subagent-spawn-in-process'
    '@deepseek-ai/dsh-tool-subagent-control' = Join-Path $dshRoot 'packages/subagent/tool-subagent-control'
    '@deepseek-ai/dsh-tools' = Join-Path $dshRoot 'packages/core/tools'
    '@deepseek-ai/dsh-system-prompt' = Join-Path $dshRoot 'packages/core/system-prompt'
    '@deepseek-ai/dsh-user-questions' = Join-Path $dshRoot 'packages/interaction/user-questions'
    '@deepseek-ai/dsh-tool-ask-user' = Join-Path $dshRoot 'packages/interaction/tool-ask-user'
    '@deepseek-ai/dsh-tool-fs' = Join-Path $dshRoot 'packages/fs/tool-fs'
    '@deepseek-ai/dsh-tool-fs-search' = Join-Path $dshRoot 'packages/fs/tool-fs-search'
    '@deepseek-ai/dsh-tool-pwsh' = Join-Path $dshRoot 'packages/shell/tool-pwsh'
    '@deepseek-ai/dsh-subprocess' = Join-Path $dshRoot 'packages/subprocess/subprocess'
    # Test-only concrete providers; production continues to use the Host's existing providers.
    '@deepseek-ai/dsh-fs-local' = Join-Path $dshRoot 'packages/fs/fs-local'
    '@deepseek-ai/dsh-subprocess-local' = Join-Path $dshRoot 'packages/subprocess/subprocess-local'
    '@deepseek-ai/dsh-pwsh-sandbox' = Join-Path $dshRoot 'packages/shell/pwsh-sandbox'
    '@deepseek-ai/dsh-agent-loop' = Join-Path $dshRoot 'packages/core/agent-loop'
    '@deepseek-ai/dsh-agent-loop-testkit' = Join-Path $dshRoot 'packages/test-support/agent-loop-testkit'
    '@deepseek-ai/dsh-session-persistence-jsonl' = Join-Path $dshRoot 'packages/session/session-persistence-jsonl'
    '@deepseek-ai/dsh-llm' = Join-Path $dshRoot 'packages/llm/llm'
    '@deepseek-ai/dsh-scope' = Join-Path $dshRoot 'packages/core/scope'
    'zod' = Join-Path $dshRoot 'packages/storage/storage-domain/node_modules/zod'
    'typescript' = Join-Path $dshRoot 'node_modules/typescript'
    'tsdown' = Join-Path $dshRoot 'node_modules/tsdown'
    '@types/node' = Join-Path $dshRoot 'node_modules/@types/node'
    '@types/react' = Join-Path $dshRoot 'packages/client/ui-conversation/node_modules/@types/react'
    '@types/react-dom' = Join-Path $dshRoot 'packages/client/ui-primitives/node_modules/@types/react-dom'
    'react' = Join-Path $dshRoot 'packages/client/ui-conversation/node_modules/react'
    'react-dom' = Join-Path $dshRoot 'packages/client/ui-primitives/node_modules/react-dom'
    '@local/workflow-agent-signal-lab' = $labRoot
}

# Complete read-only preflight before the first link is created. A partial
# source build or an unrelated existing dependency must not leave half a plan.
$plannedLinks = @()
foreach ($entry in $links.GetEnumerator()) {
    $target = (Resolve-Path -LiteralPath $entry.Value).Path
    $link = Join-Path $labRoot ('node_modules/' + $entry.Key)
    $metadata = Get-Content -Raw -LiteralPath (Join-Path $target 'package.json') | ConvertFrom-Json
    if ($metadata.name -ne $entry.Key) { throw "Source package identity mismatch: $($entry.Key)" }
    $expected = $labManifest.peerDependencies.($entry.Key)
    if (-not $expected) { $expected = $labManifest.devDependencies.($entry.Key) }
    if (-not $expected) { $expected = $labManifest.dependencies.($entry.Key) }
    if ($entry.Key.StartsWith('@deepseek-ai/') -and $metadata.version -ne $expected) {
        throw "Source package version mismatch: $($entry.Key); expected $expected"
    }
    if (Test-Path -LiteralPath $link) {
        # Never replace a user's installed dependency or a different link.
        $existing = Get-Item -LiteralPath $link
        if ($existing.LinkType -ne 'Junction' -or $existing.Target -ne $target) {
            throw "Existing dependency must be checked manually: $link"
        }
        $plannedLinks += [pscustomobject]@{ Link = $link; Target = $target; Exists = $true }
    } else {
        $plannedLinks += [pscustomobject]@{ Link = $link; Target = $target; Exists = $false }
    }
}
if ($CheckOnly) {
    Write-Output ('Checked ' + $plannedLinks.Count + ' development dependencies; no links were created or changed.')
    return
}
foreach ($plan in $plannedLinks) {
    if ($plan.Exists) { continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $plan.Link) -Force | Out-Null
    New-Item -ItemType Junction -Path $plan.Link -Target $plan.Target | Out-Null
}
Write-Output ('Linked ' + $links.Count + ' development dependencies; DSH source was not modified.')
