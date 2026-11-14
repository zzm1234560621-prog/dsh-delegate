<#
.SYNOPSIS
    One-click installer for dsh-delegate (Windows).

.DESCRIPTION
    Installs the MCP server + launcher + skill + agent instructions, and wires
    the `dsh` MCP server into Claude Desktop, Claude Code and Codex where found.

    Accepts PowerShell-style switches (-DryRun) and the same GNU-style flags as
    install.sh (--dry-run, --targets=...), which are passed through unchanged.

.EXAMPLE
    .\install.ps1 -DryRun

.EXAMPLE
    .\install.ps1 --targets=claude-code --copy-credentials

.EXAMPLE
    .\install.ps1 -Targets claude-desktop,codex -CopyCredentials
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$CopyCredentials,
    [switch]$Autostart,
    [string[]]$Targets,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'dsh-delegate needs Node.js 18 or newer: https://nodejs.org/'
}

$cliArgs = @((Join-Path $PSScriptRoot 'bin/dsh-delegate.js'), 'install')
if ($Targets) { $cliArgs += "--targets=$($Targets -join ',')" }
if ($DryRun) { $cliArgs += '--dry-run' }
if ($CopyCredentials) { $cliArgs += '--copy-credentials' }
if ($Autostart) { $cliArgs += '--autostart' }
if ($Rest) { $cliArgs += $Rest }

& $node.Source @cliArgs
exit $LASTEXITCODE
