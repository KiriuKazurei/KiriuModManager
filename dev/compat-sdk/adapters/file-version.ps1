param([Parameter(Mandatory=$true)][string]$TargetPath)
$ErrorActionPreference = 'Stop'
$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($TargetPath)
@{ fileVersion = [string]$version.FileVersion; productVersion = [string]$version.ProductVersion } | ConvertTo-Json -Compress
