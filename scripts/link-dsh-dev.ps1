param([Parameter(Mandatory = $true)][string]$DshSourceRoot)

$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
$dshRoot = (Resolve-Path -LiteralPath $DshSourceRoot).Path
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
    '@deepseek-ai/dsh-agent-presets' = Join-Path $dshRoot 'packages/preset/agent-presets'
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

foreach ($entry in $links.GetEnumerator()) {
    $target = (Resolve-Path -LiteralPath $entry.Value).Path
    $link = Join-Path $labRoot ('node_modules/' + $entry.Key)
    if (Test-Path -LiteralPath $link) {
        # Never replace a user's installed dependency or a different link.
        $existing = Get-Item -LiteralPath $link
        if ($existing.LinkType -ne 'Junction' -or $existing.Target -ne $target) {
            throw "Existing dependency must be checked manually: $link"
        }
        continue
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force | Out-Null
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}
Write-Output ('Linked ' + $links.Count + ' development dependencies; DSH source was not modified.')
