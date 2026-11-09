<#
.SYNOPSIS
    One-click installer for dsh-delegate (Windows).

.DESCRIPTION
    Installs the MCP server + launcher + skill + agent instructions, and wires
    the `dsh` MCP server into Claude Desktop, Claude Code and Codex where found.

.EXAMPLE
    pwsh -File install.ps1

.EXAMPLE
    pwsh -File install.ps1 -DryRun

.EXAMPLE
    pwsh -File install.ps1 -Targets claude-desktop,codex -CopyCredentials
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$CopyCredentials,
    [string]$Targets = 'claude-desktop,claude-code,codex'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw '需要 Node.js 18 或更高版本：https://nodejs.org/'
}

$args = @((Join-Path $here 'bin/dsh-delegate.js'), 'install', "--targets=$Targets")
if ($DryRun) { $args += '--dry-run' }
if ($CopyCredentials) { $args += '--copy-credentials' }

& $node.Source @args
exit $LASTEXITCODE
