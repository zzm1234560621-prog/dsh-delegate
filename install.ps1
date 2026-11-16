<#
.SYNOPSIS
    One-click installer for dsh-delegate (Windows).

.DESCRIPTION
    Installs the MCP server + launcher + skill + agent instructions, and wires
    the `dsh` MCP server into Claude Desktop, Claude Code and Codex where found.

    Accepts PowerShell-style switches (-DryRun) and the same GNU-style flags as
    install.sh (--dry-run, --targets=...), which are passed through unchanged.
    Double-clicked (install.cmd from Explorer), it waits for Enter at the end so
    the result stays readable, unless DSH_DELEGATE_NO_PAUSE is set (the one-file
    dsh-delegate-install.bat sets it and does the waiting itself).

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

function Test-LaunchedFromExplorer {
    # explorer -> install.ps1, or explorer -> install.cmd -> install.ps1
    try {
        $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)"
        if (-not $parent) { return $false }
        if ($parent.Name -eq 'explorer.exe') { return $true }
        if ($parent.Name -ne 'cmd.exe') { return $false }
        $grand = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)"
        return [bool]($grand -and $grand.Name -eq 'explorer.exe')
    } catch {
        return $false
    }
}

function Exit-Installer([int]$Code) {
    if (-not $env:DSH_DELEGATE_NO_PAUSE -and (Test-LaunchedFromExplorer)) {
        Read-Host 'Done. Press Enter to close this window' | Out-Null
    }
    exit $Code
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'dsh-delegate needs Node.js 18 or newer: https://nodejs.org/' -ForegroundColor Red
    Exit-Installer 1
}

$cliArgs = @((Join-Path $PSScriptRoot 'bin/dsh-delegate.js'), 'install')
if ($Targets) { $cliArgs += "--targets=$($Targets -join ',')" }
if ($DryRun) { $cliArgs += '--dry-run' }
if ($CopyCredentials) { $cliArgs += '--copy-credentials' }
if ($Autostart) { $cliArgs += '--autostart' }
if ($Rest) { $cliArgs += $Rest }

& $node.Source @cliArgs
Exit-Installer $LASTEXITCODE
